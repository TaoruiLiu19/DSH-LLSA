import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_STEPS = 8;
const TIMEOUT_MS = 15_000;
const WORKSPACE_PREFIX = 'csv-work-';
const REQUIRED_CHECKS = ['steps_verified', 'csv_round_trip', 'input_unchanged'];
const RESULT_REF = /^csv-output\/[a-f0-9]{64}\.csv$/u;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function pathParts(path) {
  if (typeof path !== 'string' || !/\.csv$/iu.test(path) || /[<>:"|?*\x00-\x1f]/u.test(path)) {
    throw failure('CSV_INVALID_PATH', 'Choose a workspace-relative CSV file.');
  }
  const parts = path.split(/[\\/]/u).filter(part => part !== '.');
  if (!parts.length || parts.some(part => !part || /[ .]$/u.test(part) || RESERVED_NAME.test(part))) {
    throw failure('CSV_INVALID_PATH', 'CSV paths must stay within the configured workspace.');
  }
  return parts;
}

/** Read a single bounded CSV snapshot from the user-selected workspace. */
export async function readTaskReuseCsvInput(workspace, relativePath) {
  const parts = pathParts(relativePath);
  let file;
  try {
    const root = await realpath(workspace);
    let path = root;
    let before;
    for (const part of parts) {
      path = join(path, part);
      before = await lstat(path);
      if (before.isSymbolicLink()) {
        throw failure('CSV_INVALID_PATH', 'CSV paths cannot contain symbolic links or junctions.');
      }
    }
    if (!before.isFile() || relative(path, await realpath(path)) !== '') {
      throw failure('CSV_INVALID_PATH', 'Choose a regular CSV file within the configured workspace.');
    }

    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        relative(path, await realpath(path)) !== '') {
      throw failure('CSV_INPUT_CHANGED', 'The selected CSV changed while opening it.');
    }
    if (opened.size > MAX_CSV_BYTES) {
      throw failure('CSV_INPUT_TOO_LARGE', 'Task Reuse accepts CSV files up to 16 MiB.');
    }

    const data = Buffer.alloc(opened.size + 1);
    let bytes = 0;
    while (bytes < data.length) {
      const { bytesRead } = await file.read(data, bytes, data.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs || !current.isFile() || current.dev !== opened.dev ||
        current.ino !== opened.ino || relative(path, await realpath(path)) !== '') {
      throw failure('CSV_INPUT_CHANGED', 'The selected CSV changed while reading it.');
    }
    return data.subarray(0, bytes);
  } catch (error) {
    if (error.code?.startsWith('CSV_')) throw error;
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
      throw failure('CSV_INPUT_NOT_FOUND', 'The selected CSV file was not found in the workspace.');
    }
    throw failure('CSV_INPUT_UNAVAILABLE', 'The selected CSV file could not be read.');
  } finally {
    await file?.close();
  }
}

function request(steps) {
  const line = JSON.stringify({ steps });
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
    throw failure('CSV_INVALID_STEPS', 'CSV workflow arguments exceed the tool message limit.');
  }
  return line;
}

function runEngine(python, engine, workspace, input, signal) {
  // The Python process needs the platform runtime environment and its own workspace.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:path|pathext|systemroot|windir|temp|tmp|tmpdir)$/iu.test(name)));
  return new Promise((accept, reject) => {
    const child = execFile(python, ['-E', '-S', '-B', engine], {
      cwd: workspace, env, windowsHide: true, timeout: TIMEOUT_MS,
      maxBuffer: MAX_MESSAGE_BYTES, encoding: 'utf8', signal,
    }, (error, stdout) => {
      if (!error) return accept(stdout);
      if (error.code === 'ABORT_ERR') return reject(failure('CSV_EXECUTOR_ABORTED', 'CSV execution was cancelled.'));
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return reject(failure('CSV_INVALID_RECEIPT', 'Task Reuse output exceeded the message limit.'));
      }
      if (error.killed) return reject(failure('CSV_EXECUTOR_TIMEOUT', 'Task Reuse exceeded its local execution deadline.'));
      if (error.code === 'ENOENT') {
        return reject(failure('CSV_EXECUTOR_UNAVAILABLE', 'Task Reuse requires a configured Python executable.'));
      }
      return reject(failure('CSV_EXECUTOR_FAILED', 'The local Task Reuse process failed.'));
    });
    // Startup/timeout failures are reported by execFile after the child closes.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function parseReceipt(stdout, steps) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw failure('CSV_INVALID_RECEIPT', 'Task Reuse returned malformed JSON.');
  }
  if (result?.status === 'error') {
    const ruleCode = result?.code;
    const step = result?.step;
    throw failure('CSV_EXECUTION_FAILED', 'Task Reuse rejected the CSV workflow.', {
      ...(typeof ruleCode === 'string' && /^[a-z_]{1,50}$/u.test(ruleCode) ? { ruleCode } : {}),
      ...(Number.isInteger(step) && step >= 1 && step <= steps.length ? { step } : {}),
    });
  }
  const validCount = count => Number.isSafeInteger(count) && count >= 0 && count <= 100_000;
  if (result?.status !== 'completed' || result.model_calls !== 0 || !RESULT_REF.test(result.output_ref) ||
      !validCount(result.input_rows) || !validCount(result.output_rows) ||
      !Array.isArray(result.steps) || result.steps.length !== steps.length ||
      !Array.isArray(result.checks) || !REQUIRED_CHECKS.every(check => result.checks.includes(check))) {
    throw failure('CSV_INVALID_RECEIPT', 'Task Reuse did not return a complete verified CSV receipt.');
  }
  let rows = result.input_rows;
  for (const [index, step] of result.steps.entries()) {
    if (!step || step.op !== steps[index]?.op || step.input_rows !== rows ||
        !validCount(step.output_rows) || step.output_rows > rows) {
      throw failure('CSV_INVALID_RECEIPT', 'Task Reuse returned inconsistent step counts.');
    }
    rows = step.output_rows;
  }
  if (rows !== result.output_rows) {
    throw failure('CSV_INVALID_RECEIPT', 'Task Reuse returned inconsistent result counts.');
  }
  return result;
}

/** Create a host executor that runs only Task Reuse's local CSV operations. */
export function createTaskReuseCsvExecutor({ enginePath, python = 'python', scratchDir }) {
  const engine = resolve(enginePath);
  const scratch = resolve(scratchDir);
  return async ({ input, steps, signal }) => {
    if (!Buffer.isBuffer(input) || input.length > MAX_CSV_BYTES) {
      throw failure('CSV_INVALID_INPUT', 'Task Reuse needs a bounded CSV snapshot.');
    }
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) {
      throw failure('CSV_INVALID_STEPS', 'Supply between one and eight CSV workflow steps.');
    }
    const messages = request(steps);
    await mkdir(scratch, { recursive: true });
    const root = await realpath(scratch);
    const workspace = await mkdtemp(join(root, WORKSPACE_PREFIX));
    try {
      await writeFile(join(workspace, 'input.csv'), input, { flag: 'wx' });
      const result = parseReceipt(await runEngine(python, engine, workspace, messages, signal), steps);
      const output = await readTaskReuseCsvInput(workspace, result.output_ref);
      if (result.output_ref !== `csv-output/${createHash('sha256').update(output).digest('hex')}.csv`) {
        throw failure('CSV_INVALID_RECEIPT', 'CSV output differs from the engine receipt.');
      }
      return { output, receipt: {
        input_rows: result.input_rows,
        output_rows: result.output_rows,
        steps: result.steps.map(({ op, input_rows, output_rows }) => ({ op, input_rows, output_rows })),
        checks: [...REQUIRED_CHECKS],
      } };
    } finally {
      if (dirname(workspace) === root && basename(workspace).startsWith(WORKSPACE_PREFIX) &&
          relative(workspace, await realpath(workspace)) === '') {
        await rm(workspace, { recursive: true, force: true, maxRetries: 2 });
      }
    }
  };
}
