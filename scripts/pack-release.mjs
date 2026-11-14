/** Rebuild the packages and assemble an install kit containing runtime files. */
import { mkdir, readFile, writeFile, copyFile, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { create as createTar } from 'tar';
import { readReleaseInfo } from './release-info.mjs';

const release = await readReleaseInfo();

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = join(repositoryRoot, 'artifacts');
const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH ?? 1794268800);

if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
  throw new Error('Invalid SOURCE_DATE_EPOCH');
}

const archiveModificationTime = new Date(sourceDateEpoch * 1000);
const npmExecutable = process.env.npm_execpath;

if (!npmExecutable) {
  throw new Error('Run npm run pack:release');
}

/** Run the npm instance that invoked this script, including on Windows. */
function runNpm(commandArguments, workingDirectory = repositoryRoot) {
  const result = spawnSync(process.execPath, [npmExecutable, ...commandArguments], {
    cwd: workingDirectory,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${commandArguments.join(' ')} failed`);
  }
}

/** Capture source provenance without changing the index, commits, or tags. */
function readGit(commandArguments) {
  const result = spawnSync('git', ['--no-optional-locks', ...commandArguments], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });

  // Source ZIPs may have neither Git nor repository metadata. Unknown provenance
  // is represented as null instead of preventing an otherwise reproducible build.
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

// Capture source state before building. Dirty-checkout artifacts must not be
// represented as an exact build of the HEAD commit.
// Do not attribute a ZIP unpacked inside some unrelated repository to its parent.
const hasRepository = readGit(['rev-parse', '--show-prefix']) === '';
const sourceCommit = hasRepository ? readGit(['rev-parse', 'HEAD']) : null;
const gitStatus = hasRepository ? readGit(['status', '--porcelain']) : null;
const workingTreeDirty = gitStatus === null ? null : gitStatus.length > 0;

runNpm(['run', 'build']);
await mkdir(outputDirectory, { recursive: true });

// A unique staging directory keeps files from an older build out of this release.
const stagingDirectory = join(outputDirectory, `.stage-${process.pid}-${Date.now()}`);
await mkdir(stagingDirectory, { recursive: true });

/** Create a stable archive: ordered files, fixed timestamps, and uniform modes. */
async function archive(packageDirectory, filename) {
  const files = [];

  async function collectFiles(relativeDirectory) {
    const entries = await readdir(join(packageDirectory, relativeDirectory), {
      withFileTypes: true,
    });
    entries.sort((first, second) => first.name.localeCompare(second.name, 'en'));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Unexpected release symlink');

      // Tar member paths use forward slashes regardless of the host OS.
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await collectFiles(relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  await collectFiles('package');
  await createTar({
    cwd: packageDirectory,
    file: join(outputDirectory, filename),
    gzip: { mtime: 0 },
    portable: true,
    mtime: archiveModificationTime,
    noMtime: false,
    noDirRecurse: true,
    onWriteEntry: entry => {
      entry.stat.mode = 0o644;
    },
  }, files);

  return filename;
}

const packages = [];
const packageLocations = [
  ['dsh-collab', 'collab'],
  ['superagent', 'superagent'],
  ['launcher', 'launcher'],
];

for (const [directoryName, label] of packageLocations) {
  const sourceDirectory = join(repositoryRoot, 'packages', directoryName);
  const manifest = JSON.parse(await readFile(join(sourceDirectory, 'package.json'), 'utf8'));
  const packageDirectory = join(stagingDirectory, label);
  const packageContents = join(packageDirectory, 'package');
  await mkdir(join(packageContents, 'lib'), { recursive: true });

  if (label === 'collab') {
    await copyFile(
      join(repositoryRoot, 'dist/collab.js'),
      join(packageContents, 'lib/index.js'),
    );
    await mkdir(join(packageContents, 'lib/csv-engine'), { recursive: true });
    for (const filename of ['csv_core.py', 'csv_pipeline.py', 'run_workflow.py']) {
      await copyFile(join(repositoryRoot, 'dist/csv-engine', filename), join(packageContents, 'lib/csv-engine', filename));
    }
    manifest.main = './lib/index.js';
    manifest.exports = { '.': './lib/index.js' };
    delete manifest.dsh;
  } else {
    await cp(join(sourceDirectory, 'lib'), join(packageContents, 'lib'), { recursive: true });
  }

  // Install packages carry runtime files and licenses, without development scripts.
  delete manifest.devDependencies;
  delete manifest.scripts;
  manifest.files = ['lib', 'LICENSE', 'NOTICE'];
  await writeFile(join(packageContents, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await copyFile(join(sourceDirectory, 'LICENSE'), join(packageContents, 'LICENSE'));
  await copyFile(join(sourceDirectory, 'NOTICE'), join(packageContents, 'NOTICE'));

  const filename = await archive(packageDirectory, `dsh-llsa-${label}-${manifest.version}.tgz`);
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(join(outputDirectory, filename)))
    .digest('base64')}`;
  packages.push({ name: manifest.name, filename, manifest, integrity });
}

const kitDirectory = join(stagingDirectory, 'kit/package');
await mkdir(join(kitDirectory, 'vendor'), { recursive: true });

for (const packageArtifact of packages) {
  await copyFile(
    join(outputDirectory, packageArtifact.filename),
    join(kitDirectory, 'vendor', packageArtifact.filename),
  );
}

const runtimeDependencies = release.manifest.dependencies;
const kitManifest = {
  name: 'dsh-llsa',
  version: release.version,
  private: true,
  type: 'module',
  license: 'MIT',
  engines: { node: '>=24.11.0', npm: '>=11' },
  scripts: { start: 'node node_modules/@dsh-llsa/launcher/lib/start.js' },
  dependencies: {
    ...runtimeDependencies,
    ...Object.fromEntries(packages.map(packageArtifact => [
      packageArtifact.name,
      `file:vendor/${packageArtifact.filename}`,
    ])),
  },
};

await writeFile(join(kitDirectory, 'package.json'), `${JSON.stringify(kitManifest, null, 2)}\n`);

for (const filename of ['LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md']) {
  await copyFile(join(repositoryRoot, filename), join(kitDirectory, filename));
}
await cp(join(repositoryRoot, 'assets'), join(kitDirectory, 'assets'), { recursive: true });
await mkdir(join(kitDirectory, 'examples'), { recursive: true });
await copyFile(join(repositoryRoot, 'examples/money-policy.example.json'), join(kitDirectory, 'examples/money-policy.example.json'));
await cp(join(repositoryRoot, 'examples/csv-workflow'), join(kitDirectory, 'examples/csv-workflow'), { recursive: true });
await cp(join(repositoryRoot, 'contracts'), join(kitDirectory, 'contracts'), { recursive: true });

/** Derive the install graph from the reviewed lockfile, without resolving ranges. */
function buildKitLock(sourceLock, manifest, packageArtifacts) {
  if (sourceLock.lockfileVersion !== 3 || !sourceLock.packages?.['']) {
    throw new Error('Release packaging requires a version 3 root package-lock.json');
  }

  const sourceRuntime = sourceLock.packages[''].dependencies ?? {};
  const localNames = new Set(packageArtifacts.map(artifact => artifact.name));
  const kitRuntime = Object.fromEntries(
    Object.entries(manifest.dependencies).filter(([name]) => !localNames.has(name)),
  );
  const sortedEntries = dependencies => Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b, 'en'));
  if (JSON.stringify(sortedEntries(sourceRuntime)) !== JSON.stringify(sortedEntries(kitRuntime))) {
    throw new Error('Root runtime dependencies differ from package-lock.json; update and review the source lock first');
  }

  const lockedPackages = {
    '': {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      dependencies: manifest.dependencies,
      engines: manifest.engines,
    },
  };

  // Keep production and optional platform trees, including their exact resolved
  // URLs and integrity hashes. Only development-only nodes are removed.
  for (const [packagePath, entry] of Object.entries(sourceLock.packages)) {
    if (packagePath !== '' && entry.dev !== true) {
      lockedPackages[packagePath] = { ...entry };
    }
  }

  for (const artifact of packageArtifacts) {
    const packagePath = `node_modules/${artifact.name}`;
    if (Object.hasOwn(lockedPackages, packagePath)) {
      throw new Error(`Source lock already contains release package ${artifact.name}`);
    }

    const entry = {
      version: artifact.manifest.version,
      resolved: `file:vendor/${artifact.filename}`,
      integrity: artifact.integrity,
    };
    // Use the same manifest that was written into this tarball. The development
    // scripts and devDependencies have already been removed from that manifest.
    for (const field of [
      'license', 'dependencies', 'optionalDependencies', 'peerDependencies',
      'peerDependenciesMeta', 'engines', 'bin', 'os', 'cpu', 'libc',
    ]) {
      if (Object.hasOwn(artifact.manifest, field)) entry[field] = artifact.manifest[field];
    }
    lockedPackages[packagePath] = entry;
  }

  // These three packages intentionally use exact direct and peer versions. A new
  // dependency must be added to the reviewed root graph, never resolved at pack time.
  for (const artifact of packageArtifacts) {
    const dependencies = {
      ...artifact.manifest.dependencies,
      ...artifact.manifest.optionalDependencies,
      ...artifact.manifest.peerDependencies,
    };
    for (const [name, version] of Object.entries(dependencies)) {
      const locked = lockedPackages[`node_modules/${name}`];
      const optional = Object.hasOwn(artifact.manifest.optionalDependencies ?? {}, name)
        || artifact.manifest.peerDependenciesMeta?.[name]?.optional === true;
      if (!locked && optional) continue;
      if (!locked || locked.version !== version) {
        throw new Error(`${artifact.name} requires ${name}@${version}; the reviewed runtime lock must contain that exact version`);
      }
    }
  }

  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: lockedPackages,
  };
}

// npm ci consumes these reviewed resolutions directly. Packing never consults
// registry packuments or depends on what metadata happens to be in an npm cache.
const sourceLock = JSON.parse(await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8'));
const kitLock = buildKitLock(sourceLock, kitManifest, packages);
await writeFile(join(kitDirectory, 'package-lock.json'), `${JSON.stringify(kitLock, null, 2)}\n`);

const kitFilename = await archive(join(stagingDirectory, 'kit'), release.kitFilename);
const artifactFilenames = [...packages.map(packageArtifact => packageArtifact.filename), kitFilename].sort();
const checksums = [];

for (const filename of artifactFilenames) {
  const digest = createHash('sha256')
    .update(await readFile(join(outputDirectory, filename)))
    .digest('hex');
  checksums.push(`${digest}  ${filename}`);
}

await writeFile(join(outputDirectory, 'SHA256SUMS'), `${checksums.join('\n')}\n`);

// This command prepares a review candidate; it does not create a Git release tag.
const releaseMetadata = {
  tag: null,
  plannedTag: release.plannedTag,
  status: 'review-candidate',
  sourceCommit,
  workingTreeDirty,
  sourceDateEpoch,
  artifacts: checksums,
};
await writeFile(
  join(outputDirectory, 'release.json'),
  `${JSON.stringify(releaseMetadata, null, 2)}\n`,
);
console.log(checksums.join('\n'));
