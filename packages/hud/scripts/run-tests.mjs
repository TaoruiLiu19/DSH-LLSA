/**
 * Spawn-free test entry.
 *
 * `node --test test/*.test.js` starts one child process per file, which a
 * locked-down shell can refuse (EPERM). Importing the files in one process runs
 * the same assertions through the same reporter, so the suite stays runnable in
 * a sandbox and in CI without a second code path.
 */
import { readdirSync } from 'node:fs';

const directory = new URL('../test/', import.meta.url);
for (const file of readdirSync(directory).filter(name => name.endsWith('.test.js')).sort()) {
  await import(new URL(file, directory).href);
}
