const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_STEPS = 8;
const artifactId = /^sha256:[a-f0-9]{64}$/u;
const csvMediaType = /^text\/csv(?:\s*;|$)/iu;
const operations = new Set(['filter_eq', 'dedupe', 'group_count']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function record(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function sourceFailure(error, sourceLabel) {
  return Object.assign(new Error(error instanceof Error ? error.message : 'CSV source failed.', { cause: error }), {
    code: error?.code,
    ruleCode: error?.ruleCode,
    step: error?.step,
    sourceLabel,
  });
}

/** Validate and copy the batch contract before scheduling. The executor validates step semantics. */
export function validateCsvBatch(sources, steps) {
  if (!Array.isArray(sources) || sources.length < 2 || sources.length > 4) {
    fail('INVALID_CSV_BATCH', 'Supply between two and four CSV sources.');
  }
  const labels = new Set();
  const boundSources = Array.from(sources, source => {
    if (!record(source) || Object.keys(source).length !== 2 || typeof source.inputRef !== 'string' ||
        !artifactId.test(source.inputRef) || typeof source.label !== 'string' || !source.label.isWellFormed() ||
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(source.label)) {
      fail('INVALID_CSV_BATCH', 'Each source needs a label and an immutable CSV inputRef.');
    }
    const label = source.label.trim().normalize('NFC');
    if (!label || [...label].length > 64 || labels.has(label)) {
      fail('INVALID_CSV_BATCH', 'Source labels must be distinct and contain one to 64 characters.');
    }
    labels.add(label);
    return { label, inputRef: source.inputRef };
  });

  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) {
    fail('INVALID_CSV_BATCH', 'Supply between one and eight CSV steps.');
  }
  const boundSteps = Array.from(steps, step => {
    if (!record(step) || !operations.has(step.op) || Object.values(step).some(value =>
      value !== null && (typeof value !== 'string' || !value.isWellFormed()))) {
      fail('INVALID_CSV_BATCH', 'CSV steps must be supported operations with plain string arguments.');
    }
    return { ...step };
  });
  return { sources: boundSources, steps: boundSteps };
}

function checkReceipt(output, receipt, steps) {
  const isCount = value => Number.isSafeInteger(value) && value >= 0;
  if (!Buffer.isBuffer(output) || !isCount(receipt?.input_rows) || !isCount(receipt.output_rows) ||
      !Array.isArray(receipt.steps) || receipt.steps.length !== steps.length ||
      !Array.isArray(receipt.checks) || !receipt.checks.every(check => typeof check === 'string')) {
    fail('CSV_INVALID_RECEIPT', 'The CSV executor did not return a complete batch receipt.');
  }
  let rows = receipt.input_rows;
  const counts = receipt.steps.map((step, index) => {
    if (step?.op !== steps[index].op || step.input_rows !== rows || !isCount(step.output_rows) || step.output_rows > rows) {
      fail('CSV_INVALID_RECEIPT', 'The CSV executor returned inconsistent step counts.');
    }
    rows = step.output_rows;
    return { op: step.op, input_rows: step.input_rows, output_rows: step.output_rows };
  });
  if (rows !== receipt.output_rows) fail('CSV_INVALID_RECEIPT', 'The CSV executor returned inconsistent output counts.');
  return { input_rows: receipt.input_rows, output_rows: rows, steps: counts, checks: [...receipt.checks] };
}

/** Execute once per unique artifact. Return results only after every source has passed. */
export async function runCsvBatch({ sources, steps, readArtifact, csvExecutor, assertCurrent, signal }) {
  const contract = validateCsvBatch(sources, steps);
  const checkCurrent = () => {
    assertCurrent();
    signal?.throwIfAborted();
  };
  const inputs = new Map();
  let inputBytes = 0;
  for (const { inputRef, label } of contract.sources) {
    if (inputs.has(inputRef)) continue;
    checkCurrent();
    try {
      const { data, mediaType } = await readArtifact(inputRef);
      if (!Buffer.isBuffer(data) || !csvMediaType.test(mediaType) || data.length > MAX_FILE_BYTES) {
        fail('INVALID_CSV_BATCH', 'Each source must be an assigned CSV of at most 16 MiB.');
      }
      inputBytes += data.length;
      if (inputBytes > MAX_BATCH_BYTES) fail('CSV_BATCH_INPUT_TOO_LARGE', 'Batch inputs exceed 32 MiB.');
      inputs.set(inputRef, { data, label });
    } catch (error) {
      throw sourceFailure(error, label);
    }
  }

  const results = new Map();
  let outputBytes = 0;
  for (const [inputRef, { data, label }] of inputs) {
    checkCurrent();
    try {
      const { output, receipt } = await csvExecutor({ input: data, steps: contract.steps.map(step => ({ ...step })), signal });
      const verified = checkReceipt(output, receipt, contract.steps);
      outputBytes += output.length;
      if (output.length > MAX_FILE_BYTES || outputBytes > MAX_BATCH_BYTES) {
        fail('CSV_BATCH_OUTPUT_TOO_LARGE', 'Batch outputs exceed the CSV size limit.');
      }
      results.set(inputRef, { output, receipt: verified });
    } catch (error) {
      throw sourceFailure(error, label);
    }
  }
  checkCurrent();
  return contract.sources.map(source => ({ ...source, ...results.get(source.inputRef) }));
}
