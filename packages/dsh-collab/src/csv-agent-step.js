import { canonicalHash } from './computation.js';

const artifactId = /^sha256:[a-f0-9]{64}$/u;
const csvMediaType = /^text\/csv(?:\s*;|$)/iu;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Run a bounded transformation on an artifact already assigned to this child. */
export async function runAgentCsvStep({ binding, item, inputRef, steps, csvExecutor, readArtifact, assertCurrent, store, signal }) {
  const { id: actorId, runId, workItemId, attemptId } = binding;
  if (!binding.parentId || !workItemId || item?.id !== workItemId || item.childId !== actorId ||
      item.runId !== runId || item.attemptId !== attemptId) {
    fail('FORBIDDEN', 'CSV execution requires the owning child and current work item.');
  }
  if (typeof inputRef !== 'string' || !artifactId.test(inputRef) || !item.inputRefs?.includes(inputRef)) {
    fail('FORBIDDEN', 'Choose a CSV artifact explicitly assigned to this work item.');
  }
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8) {
    fail('INVALID_CSV_WORKFLOW', 'Supply between one and eight CSV workflow steps.');
  }

  assertCurrent();
  signal?.throwIfAborted();
  const boundSteps = structuredClone(steps);
  const contractHash = canonicalHash({ inputRef, steps: boundSteps });
  const { data, mediaType } = readArtifact(runId, inputRef);
  if (!csvMediaType.test(mediaType) || !Buffer.isBuffer(data)) {
    fail('INVALID_CSV_WORKFLOW', 'The assigned artifact must be a CSV file.');
  }
  const { output, receipt } = await csvExecutor({ input: data, steps: boundSteps, signal });
  assertCurrent();
  signal?.throwIfAborted();
  const { input_rows, output_rows, steps: counts, checks } = receipt ?? {};
  if (!Buffer.isBuffer(output) || !Number.isSafeInteger(input_rows) || !Number.isSafeInteger(output_rows) ||
      !Array.isArray(counts) || !Array.isArray(checks)) {
    fail('CSV_INVALID_RECEIPT', 'The CSV executor did not return a complete receipt.');
  }

  const artifact = store.putArtifact(output, { mediaType: 'text/csv' });
  const result = { inputRef, outputArtifactRef: artifact.id, input_rows, output_rows, steps: counts, checks, modelCalls: 0 };
  const event = store.appendEvent({ runId, stepId: workItemId, attemptId, kind: 'csv_workflow_receipt',
    payload: { actorId, provenance: 'host_csv_workflow', inputRef, contractHash, artifactRef: artifact.id, result } });
  return { eventId: event.id, ...result };
}
