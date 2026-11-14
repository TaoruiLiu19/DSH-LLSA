import { z } from 'zod';
import { readTaskReuseCsvInput } from './task-reuse-csv.js';

const column = z.string().min(1).max(128);
const source = {
  path: z.string().min(1).max(1024).optional(),
  inputRef: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
};
const steps = z.array(z.object({
  op: z.enum(['filter_eq', 'dedupe', 'group_count']),
  column: column.optional(),
  value: z.string().max(4096).optional(),
  key: column.optional(),
  keep: z.enum(['last_row', 'latest_timestamp']).optional(),
  time_column: column.optional(),
}).strict()).min(1).max(8);
export const csvWorkflowSchema = z.object({
  mode: z.enum(['run', 'batch', 'delegate']).default('run'),
  allowStep: z.boolean().optional(),
  ...source,
  sources: z.array(z.object({ label: z.string().min(1).max(64), ...source }).strict()).min(2).max(4).optional(),
  steps: steps.optional(),
  objective: z.string().min(1).max(2000).optional(),
  dependsOn: z.array(z.string()).max(16).optional(),
  retryOf: z.string().optional(),
}).strict();

export const csvWorkflowToolDefinition = {
  name: 'collab_csv_workflow',
  description: 'Execute confirmed CSV rules. Supply objective and path or inputRef for run; use batch with 2–4 labelled sources for the same steps. Use column and value for filter_eq, key and keep for dedupe (add time_column for latest_timestamp), and column for final group_count. Use delegate to bind one CSV to a child; set allowStep=true only for a child that transforms it.',
  parameters: z.toJSONSchema(csvWorkflowSchema),
};

export const csvChildWorkflowSchema = z.object({
  inputRef: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  steps,
}).strict();

export const csvChildWorkflowToolDefinition = {
  name: csvWorkflowToolDefinition.name,
  description: 'Run explicit CSV steps on your assigned inputRef. Use column and value for filter_eq, key and keep for dedupe (add time_column for latest_timestamp), and column for a final group_count. Continue with the normal task submission after execution.',
  parameters: z.toJSONSchema(csvChildWorkflowSchema),
};

export function createCsvWorkflowHandler({ manager, csvWorkspace }) {
  const store = manager.store;
  const bindCsvSources = async (agent, binding, sources, signal) => {
    if (sources.some(source => Boolean(source.path) === Boolean(source.inputRef))) {
      throw new Error("Each CSV source needs exactly one workspace path or run-owned artifact reference.");
    }
    const version = manager.nativeInputs.current(binding.runId)?.version;
    const inputs = [];
    for (const { label, path, inputRef } of sources) {
      signal?.throwIfAborted();
      if (path) {
        inputs.push({ label, bytes: await readTaskReuseCsvInput(csvWorkspace, path) });
      } else {
        if (!manager.readArtifact(binding.runId, inputRef).mediaType.startsWith("text/csv")) {
          throw new Error("Choose a CSV artifact owned by this run.");
        }
        inputs.push({ label, inputRef });
      }
    }
    signal?.throwIfAborted();
    if (manager.binding(agent.id)?.runId !== binding.runId ||
      manager.nativeInputs.current(binding.runId)?.version !== version ||
      !manager.isCsvWorkflowEnabled(binding.runId)) throw new Error("The task or its CSV policy changed during import.");
    return inputs.map(({ label, bytes, inputRef }) => {
      if (!bytes) return { label, inputRef };
      const artifact = store.putArtifact(bytes, { mediaType: "text/csv" });
      store.appendEvent({ runId: binding.runId, stepId: "csv-input", kind: "csv_workflow_input",
        payload: { artifactRef: artifact.id, provenance: "host_csv_workflow" } });
      return { label, inputRef: artifact.id };
    });
  };

  return async (agent, { mode = "run", allowStep, path, inputRef, sources, steps, objective, dependsOn, retryOf }, { signal } = {}) => {
    signal?.throwIfAborted();
    const binding = manager.binding(agent.id);
    if (!manager.isCsvWorkflowEnabled(binding?.runId)) {
      throw Object.assign(new Error("Local CSV processing is off for this run. Use the ordinary task tools."), { code: "CSV_WORKFLOW_DISABLED" });
    }
    if (!manager.isToolAvailable(agent.id, "collab_csv_workflow")) throw new Error("CSV processing is unavailable in this task phase.");
    if ((mode !== "delegate") !== Boolean(steps) || (mode !== "delegate" && allowStep !== undefined)) {
      throw new Error("Supply steps in run or batch mode. Delegate mode binds the CSV and can grant a child transformation.");
    }
    if (binding.parentId) {
      if (mode !== "run" || !inputRef || path || sources || objective || dependsOn || retryOf) throw new Error("A child can only transform an assigned CSV inputRef.");
      return manager.runCsvStep(agent.id, { inputRef, steps }, { signal });
    }
    if (!objective) throw new Error("Provide the task objective.");
    if (mode === "batch") {
      if (!sources || path || inputRef) throw new Error("Batch mode needs 2–4 labelled CSV sources.");
      const bound = await bindCsvSources(agent, binding, sources, signal);
      const work = await manager.delegateCsvBatch(agent, { objective, dependsOn, retryOf, sources: bound, steps }, { signal });
      if (!work.result?.outputs) return work;
      const outputs = work.result.outputs.map(({ label, outputArtifactRef, input_rows, output_rows }) => ({
        label, outputArtifactRef, input_rows, output_rows,
      }));
      return { ...work, result: { outputs, modelCalls: work.result.modelCalls } };
    }
    if (sources) throw new Error("Use batch mode for labelled CSV sources.");
    const [{ inputRef: source }] = await bindCsvSources(agent, binding, [{ path, inputRef }], signal);
    const work = { objective, dependsOn, retryOf, inputRefs: [source] };
    if (mode === "delegate") return manager.delegate(agent, { ...work, csvStepAllowed: allowStep === true });
    return manager.delegate(agent, { ...work, csvWorkflow: { inputRef: source, steps } }, { signal });
  };
}
