import { TOOL_DESCRIPTIONS } from "./text-assets.js";
import { historyScope } from "./superagent-history.js";
import { Service } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { z } from "zod";
import { getEncoding } from "js-tiktoken";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CollaborationStore } from "./store.js";
import { CollaborationManager, SECTION_DELEGATION_LIMITS } from "./manager.js";
import { publishSchema } from "./publish-schema.js";
import { createDshBackend, normalizeDshUsage } from "./dsh-adapter.js";
import { registerHttp } from "./http.js";
import { StreamUsageLifecycle } from "./stream-lifecycle.js";
import { requestAccountingContext, requestTokenAdmission, withSharedCoordinatorAccounting } from "./accounting.js";
import { loadRegistry } from "./load-registry.js";
import { projectBridgeReport } from "./bridge-projection.js";
import { computationSchema } from "./computation-schema.js";
import { loadEncodingEvidence } from "./load-encoding-policy.js";
import { TASK_TYPES } from "./encoding-policy.js";
import { ToolEventIndex } from "./tool-event-index.js";
import { LocalWorkspace } from "./local-workspace.js";
import { connectSuperagent } from "./superagent-integration.js";
import { InputDelivery } from "./input-delivery.js";
import { concludeSubmitted } from "./turn-completion.js";
import { readTaskEvidence } from "./evidence-page.js";
import { statusView } from "./status-view.js";
import { projectEvidenceRead } from "./evidence-reuse.js";
import { issuedObservationRun, readToolObservation } from "./tool-observation.js";
import { syncHostQuestions, installBlockingAttention } from './hud-host.js';
import { createTaskReuseCsvExecutor } from './task-reuse-csv.js';
import { csvWorkflowSchema, csvWorkflowToolDefinition, csvChildWorkflowSchema, csvChildWorkflowToolDefinition, createCsvWorkflowHandler } from './csv-workflow-tool.js';

export const name = "dsh-collab";
export const inject = [
  "agents",
  "tools",
  "systemPrompt",
  "llm",
  "sessionPersistence",
  "subagents",
  "webServer",
  "connection",
  "sessionProjections",
  "userQuestions",
];
export const Config = Schema.object({
  stateDir: Schema.string().default("./.dsh-collab"),
  maxActiveChildren: Schema.natural().min(1).max(8).default(2),
  maxRunTokens: Schema.natural().min(1000).default(200000),
  maxOutputTokens: Schema.natural().min(128).default(4096),
  childPreset: Schema.string().default("standard"),
  bridgeProjection: Schema.boolean().default(true),
  explicitEvidenceRefs: Schema.boolean().default(false),
  groupSectionResults: Schema.boolean().default(false),
  allowPaidManagedChildren: Schema.boolean().default(false),
  localChildModel: Schema.union([
    Schema.object({
      baseURL: Schema.string().required(),
      model: Schema.string().required(),
      apiKey: Schema.string(),
    }),
    Schema.const(null),
  ]).default(null),
  protocolFile: Schema.string().default(""),
  encodingEvidenceFile: Schema.string().default(""),
  moneyPolicyFile: Schema.string().default(""),
  csvWorkspace: Schema.string().default(""),
  csvEngine: Schema.string().default(""),
  csvPython: Schema.string().default("python"),
  csvDefaultEnabled: Schema.boolean().default(false),
  webCollaboration: Schema.boolean().default(false),
  minEvidenceSamples: Schema.natural().min(5).default(5),
});

class CollabService extends Service {
  constructor(ctx, manager) {
    super(ctx, "collab");
    this.manager = manager;
  }
}
const objectOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};
const jsonValue = z.json();

export async function apply(ctx, rawConfig = {}) {
  const config = {
    stateDir: "./.dsh-collab",
    maxActiveChildren: 2,
    maxRunTokens: 200000,
    maxOutputTokens: 4096,
    childPreset: "standard",
    bridgeProjection: true,
    allowPaidManagedChildren: false,
    encodingEvidenceFile: "",
    minEvidenceSamples: 5,
    ...rawConfig,
  };
  const store = new CollaborationStore({ stateDir: resolve(config.stateDir) });
  const encoding = getEncoding("o200k_base");
  const countTokens = (text) => encoding.encode(text).length;
  let registry, qualityEvidence, moneyPolicy;
  try {
    registry = loadRegistry(
      store,
      config.protocolFile ? resolve(config.protocolFile) : null,
    );
    qualityEvidence = loadEncodingEvidence(
      config.encodingEvidenceFile ? resolve(config.encodingEvidenceFile) : null,
    );
    moneyPolicy = config.moneyPolicyFile ? JSON.parse(readFileSync(resolve(config.moneyPolicyFile), 'utf8')) : null;
  } catch (error) {
    store.close();
    throw error;
  }
  let manager;
  const csvWorkspace = config.csvWorkspace ? resolve(config.csvWorkspace) : null;
  const csvExecutor = csvWorkspace && config.csvEngine ? createTaskReuseCsvExecutor({
    enginePath: resolve(config.csvEngine), python: config.csvPython ?? "python", scratchDir: resolve(config.stateDir, "csv-work"),
  }) : undefined;
  try { manager = new CollaborationManager({
    store,
    registry,
    countTokens,
    counterName: "o200k_base estimate; not DeepSeek billing",
    maxActiveChildren: config.maxActiveChildren,
    maxRunTokens: config.maxRunTokens,
    maxOutputTokens: config.maxOutputTokens,
    qualityEvidence,
    minEvidenceSamples: config.minEvidenceSamples,
    explicitEvidenceRefs: config.explicitEvidenceRefs ?? false,
    groupSectionResults: config.groupSectionResults ?? false,
    allowPaidManagedChildren: config.allowPaidManagedChildren === true,
    moneyPolicy,
    csvExecutor,
    csvDefaultEnabled: config.csvDefaultEnabled,
    webCollaboration: config.webCollaboration,
  }); } catch (error) { store.close(); throw error; }
  let backend;
  try { backend = createDshBackend(ctx, manager, config); }
  catch (error) { store.close(); throw error; }
  manager.backend = backend;
  const localWorkspace = new LocalWorkspace({ manager, ctx });
  manager.localWorkspace = localWorkspace;
  new CollabService(ctx, manager);
  const registrations = new Map();
  let closed = false,
    storeClosed = false,
    superagentIntegration;
  const toolIndex = new ToolEventIndex();
  const advisoryCalls = new WeakMap();
  const markAdvisoryCall = (session, callId) => {
    if (!callId) return;
    let calls = advisoryCalls.get(session);
    if (!calls) advisoryCalls.set(session, calls = new Set());
    calls.add(callId);
  };
  const streams = new StreamUsageLifecycle({
    recordUsage: (row) => store.recordUsage(row),
    releaseCall: (id) => manager.releaseCall(id),
    normalizeUsage: normalizeDshUsage,
  });

  const ensureRun = (agent) => {
    const threadTitle=ctx.sessionProjections.snapshot(agent.session,['title']).values.title;
    const child = manager.binding(agent.id);
    if (child?.parentId) return child;
    const bridge = manager.bridge;
    if (bridge) {
      const snapshot = bridge.snapshot();
      if (snapshot.masterSessionId === agent.id) {
        if (superagentIntegration?.bindCoordinator)
          return superagentIntegration.bindCoordinator(agent.id) ?? manager.bindRoot(agent.id, { threadTitle });
        return manager.bindRoot(agent.id, {
          runId: `super-master-${agent.id}`,
          title: "Superagent orchestrator",
        });
      }
      const row = snapshot.tickets.find((x) => x.workerSessionId === agent.id);
      if (row?.assignmentId)
        return manager.bindRoot(agent.id, {
          runId: `super-${row.ticket.id}-${row.assignmentId}`,
          ticketId: row.ticket.id,
          assignmentId: row.assignmentId,
          title: row.ticket.title,
          assignmentTitle: row.ticket.execution?.name || row.ticket.title,
          threadTitle,
          ...bridge.displayTitles?.(row.ticket.id),
        });
    }
    return manager.bindRoot(agent.id,{threadTitle});
  };
  const runCsvWorkflow = csvExecutor && createCsvWorkflowHandler({ manager, csvWorkspace });
  const install = (agent) => {
    if (registrations.has(agent) || closed) return;
    const disposers = [];
    if (manager.hasAssignedEvidence(agent.id)) agent.ctx.tools.restrict({ allow: [] });
    const register = (toolName, description, schema, execute) =>
      disposers.push(
        agent.ctx.tools.register(
          {
            name: toolName,
            description,
            parameters: z.toJSONSchema(schema),
            output: objectOutput,
            execute: async (args, exec) => {
              if (closed) throw new Error("Collaboration plugin is closing");
              if (exec.agent && exec.agent !== agent)
                throw new Error("Agent binding mismatch");
              ensureRun(agent);
              return execute(schema.parse(args), exec);
            },
          },
          {
            when: () => !closed && manager.isToolAvailable(agent.id, toolName),
          },
        ),
      );
    register(
      "collab_status",
      TOOL_DESCRIPTIONS.collab_status,
      z.object({
        ticketId: z.string().min(1).max(100).optional()
          .describe("Request the status of this specific authorized native ticket."),
        ifRevision: z.string().regex(/^[a-f0-9]{24}$/u).optional()
          .describe("Use a revision returned for the same scope only if you have the prior status. A matching revision can return unchanged. Omit this to read usage and full status."),
      }).strict(),
      (args) => statusView(manager, agent.id, ensureRun(agent).runId, args),
    );
    register(
      "collab_delegate",
      TOOL_DESCRIPTIONS.collab_delegate,
      z
        .object({
          objective: z.string().min(1).max(20000),
          taskType: z
            .enum(TASK_TYPES)
            .optional()
            .describe(
              "Encoding task class only; never evidence of correctness.",
            ),
          role: z
            .enum(["researcher", "reviewer", "implementer", "tester"])
            .default("researcher"),
          dependsOn: z.array(z.string()).default([]).describe('These work items must be parent-accepted before this child starts. A reviewer needed to decide acceptance must instead read result inputRefs without that acceptance dependency.'),
          acceptance: z.array(z.string()).default([]),
          inputRefs: z.array(z.string()).default([]),
          evidenceScope: z.enum(['run', 'assigned']).optional()
            .describe('Use assigned for independent branches. Give each child only the explicit source artifact refs it needs and include the shared task rules in its objective.'),
          workItemId: z.string().optional(),
          retryOf: z.string().optional(),
          computation: computationSchema.optional(),
          completionMode: z.enum(["host", "model-copy"]).optional(),
        })
        .strict(),
      (args) => manager.delegate(agent, args),
    );
    const sectionLimits = SECTION_DELEGATION_LIMITS;
    register(
      "collab_delegate_sections",
      "Apply a shared objective to independent Markdown sections. For exact structured row selection, provide a lookup so the host computes each result without a model. Otherwise use the configured local child model. Paid children require explicit host opt-in. Supply the current input handle and section IDs instead of pasting evidence.",
      z.object({
        input: z.string().regex(/^input:[a-f0-9]{16,64}$/u).describe("Current complete input handle from the section list."),
        sections: z.array(z.string().min(1).max(sectionLimits.selector)).min(1).max(sectionLimits.sections)
          .describe("Section IDs from the current list, such as s1 and s2, or unique exact titles."),
        objective: z.string().min(1).max(sectionLimits.objective)
          .describe(`One shared task for every section, up to ${sectionLimits.objective} characters.`),
        rules: z.array(z.string().min(1).max(sectionLimits.rule)).max(sectionLimits.rules).default([])
          .describe(`Up to ${sectionLimits.rules} shared requirements, each at most ${sectionLimits.rule} characters. Include exact match conditions or output fields once.`),
        lookup: z.object({
          filters: z.array(z.object({
            field: z.string().min(1).max(96),
            equals: z.string().max(256),
          }).strict()).min(1).max(12).describe("Exact cell equality conditions, applied together."),
          fields: z.array(z.object({
            field: z.string().min(1).max(96),
            as: z.string().min(1).max(96).optional(),
            type: z.enum(["text", "integer"]),
          }).strict()).min(1).max(24).describe("Result columns; use text for identifiers with leading zeros."),
          sectionField: z.string().min(1).max(96).optional().describe("Result key for the exact section title when requested."),
        }).strict().optional().describe("Select exactly one matching row in every section from tables sharing a header. Provide only when the user's rule fits this operation."),
        retries: z.array(z.object({
          section: z.string().min(1).max(sectionLimits.selector),
          workItemId: z.string().min(1).max(100),
        }).strict()).max(sectionLimits.sections).optional()
          .describe("For failed or outdated section work, pair each affected current section with its old work item ID."),
      }).strict(),
      async (args, execution) => {
        const result = await manager.delegateSections(agent, args, { signal: execution.signal });
        if (result.waiting === true) execution.concludeTurn?.();
        return result;
      },
    );
    const childCsv = Boolean(manager.binding(agent.id)?.parentId);
    if (csvExecutor) register(
      "collab_csv_workflow",
      childCsv ? csvChildWorkflowToolDefinition.description : csvWorkflowToolDefinition.description,
      childCsv ? csvChildWorkflowSchema : csvWorkflowSchema,
      (args, execution) => runCsvWorkflow(agent, args, execution),
    );
    register(
      "collab_delegate_task",
      "Delegate execution or independent verification of the current versioned task once. Choose reviewer for checking, implementer for changes, researcher for analysis. The host delivers the result automatically. Inspect and assess it, then report your verified result. Use retryOf only after failure or updated inputs, and collab_delegate only for a genuinely distinct subtask.",
      z.object({
        role: z.enum(["researcher", "reviewer", "implementer", "tester"]).default("researcher"),
        retryOf: z.string().optional(),
      }).strict(),
      (args) => manager.delegate(agent, { ...args, wholeTask: true }),
    );
    register(
      "collab_compute",
      TOOL_DESCRIPTIONS.collab_compute,
      z.object({}).strict(),
      () => manager.compute(agent.id, {}),
    );
    register(
      "collab_complete_computation",
      TOOL_DESCRIPTIONS.collab_complete_computation,
      z.object({ stepId: z.string().min(1).optional(), checkpointStepId: z.string().min(1).optional() }).strict(),
      (args, execution) => concludeSubmitted(manager.completeComputation(agent.id, args), true, execution, !!manager.binding(agent.id)?.parentId),
    );
    register(
      "collab_publish",
      TOOL_DESCRIPTIONS.collab_publish +
        (config.explicitEvidenceRefs
          ? " parents contains existing eventId values only, never stepId, workItemId or artifact refs; omit if no causal event is needed."
          : ""),
      publishSchema,
      (args, execution) => concludeSubmitted(manager.publish(agent.id, args), args.final, execution, !!manager.binding(agent.id)?.parentId),
    );
    register(
      "collab_send",
      TOOL_DESCRIPTIONS.collab_send,
      z
        .object({
          targetId: z.string(),
          result: jsonValue,
          stepId: z.string().optional(),
          taskType: z.enum(TASK_TYPES).default("generic"),
        })
        .strict(),
      (args) => manager.send(agent.id, args),
    );
    register(
      "collab_history",
      TOOL_DESCRIPTIONS.collab_history +
        (config.explicitEvidenceRefs
          ? " For a delivered child result use its stepId, attemptId and eventId. workItemId is not a stepId. Read history for missing detail or an explicit historical verification request. When the user requires a history-tool check, inspect the returned saved record before acceptance even if the delivered result is available."
          : ""),
      z
        .object({
          stepId: z.string().optional(),
          ticketId: z.string().optional(),
          assignmentId: z.string().optional(),
          attemptId: z.string().optional(),
          eventId: z.string().optional(),
          asOfSeq: z.number().int().nonnegative().optional(),
        })
        .strict()
        .refine(
          (x) => !!x.stepId || !!x.eventId,
          "stepId or eventId is required",
        ),
      (args) => {
        ensureRun(agent);
        const { runId, stepId } = historyScope(manager, agent.id, args);
        const { ticketId, assignmentId, stepId: unused, ...opts } = args;
        return manager.inspect(runId, stepId, opts, agent.id);
      },
    );
    register(
      "collab_read_evidence",
      TOOL_DESCRIPTIONS.collab_read_evidence,
      z
        .object({
          ref: z.string(),
          ticketId: z.string().optional(),
          assignmentId: z.string().optional(),
          start: z.number().int().nonnegative().default(0),
          bytes: z.number().int().min(1).max(64000).default(8000),
          contains: z.string().trim().min(1).max(160).optional(),
          mode: z.enum(['auto', 'page']).default('auto'),
          ifNoneMatch: z.string().regex(/^ev1:[a-f0-9]{64}$/).optional(),
          jsonPointer: z.string().max(512).optional().describe('For obs: only. Select a JSON string field before paging or matching lines.'),
          historical: z.literal(true).optional().describe('For a coordinator historical source hint only: read archived document text with its original ticketId and assignmentId. It is not current verification.'),
        })
        .strict(),
      (args, exec) => {
        const observation = args.ref.startsWith("obs:");
        const implicitRun = observation && !args.historical && args.ticketId === undefined && args.assignmentId === undefined
          ? issuedObservationRun(manager, args.ref) : undefined;
        const runId = implicitRun ?? historyScope(manager, agent.id, args).runId;
        if (observation) {
          const result = readToolObservation(manager, runId, agent.id, args);
          return projectEvidenceRead(result, { runId, args, countTokens });
        }
        if (args.jsonPointer !== undefined) throw new Error("jsonPointer requires an obs: reference.");
        if (args.historical !== undefined) throw new Error("historical requires an obs: reference.");
        if (manager.isWebAdviceArtifact(runId, args.ref)) markAdvisoryCall(agent.session, exec.callId);
        let result;
        if (args.contains) {
          const meta = manager.readArtifact(runId, args.ref, { start: 0, end: 0 }, agent.id);
          result = readTaskEvidence(manager, runId, { label: args.ref, bytes: meta.totalBytes }, args, agent.id);
        } else result = readTaskEvidence(manager, runId, null, args, agent.id);
        return projectEvidenceRead(result, { runId, args, countTokens });
      },
    );
    if (config.webCollaboration) register(
      "collab_consult_web",
      "Ask one narrow question about a rule or uncertainty after selecting relevant source facts. Include only the minimum information authorized for the web advisor. Treat markdownPreview as unverified advice and verify against the original evidence before publishing. If needed, use collab_read_evidence with artifactRef and nextStart for the remainder.",
      z.object({ question: z.string().trim().min(1).max(1024) }).strict(),
      ({ question }, exec) => {
        markAdvisoryCall(agent.session, exec.callId);
        return manager.consultWeb(agent.id, question, {
          signal: exec.signal,
          assertSession: () => superagentIntegration?.assertSession(agent.id),
        });
      },
    );
    register(
      "collab_accept",
      TOOL_DESCRIPTIONS.collab_accept +
        (config.explicitEvidenceRefs
          ? " evidenceRefs accepts artifact sha256 refs from the delivered evidenceRefs field; workItemId and eventId are not artifact refs. An empty array is allowed."
          : ""),
      z
        .object({
          workItemId: z.string(),
          accepted: z.boolean().describe('True only if the submitted result passes your checks. False if you found an error, even if the work finished.'),
          reason: z.string().min(1).describe('State the checks performed or the specific error requiring correction.'),
          evidenceRefs: z.array(z.string()).default([]),
          discard: z.boolean().default(false).describe('With accepted=false, set only to close an unused supplemental review after accepting the whole-task result. Do not use a discarded result as evidence.'),
        })
        .strict(),
      (args) => manager.accept(agent.id, args),
    );
    register(
      "collab_accept_sections",
      "Review each result from a delivered batch. Use its batchId and short section names (s1, s2) or each result's workItemId and eventId. Give each decision a reason.",
      z.object({
        batchId: z.string().min(1).max(100),
        reviews: z.array(z.object({
          section: z.string().max(sectionLimits.selector).regex(/^s[1-9]\d*$/u).optional(),
          workItemId: z.string().min(1).max(100).optional(),
          eventId: z.string().min(1).max(100).optional(),
          accepted: z.boolean(),
          reason: z.string().trim().min(1).max(400),
        }).strict()).min(1).max(SECTION_DELEGATION_LIMITS.sections),
      }).strict(),
      (args) => manager.acceptSections(agent.id, args),
    );
    register(
      "collab_project_log",
      TOOL_DESCRIPTIONS.collab_project_log,
      z
        .object({
          stepId: z.string(),
          text: z.string().max(1000000),
          maxEntries: z.number().int().min(2).max(500).default(80),
        })
        .strict(),
      (args) => manager.prepareLog(agent.id, args),
    );
    disposers.push(
      agent.ctx.systemPrompt.section({
        name: "dsh-collab",
        order: 9998,
        interpolate: false,
        text: () => {
          if (manager.binding(agent.id)?.parentId) return '';
          const instructions = [];
          if (manager.isToolAvailable(agent.id, 'collab_delegate_task')) {
            instructions.push('Use collab_delegate_task once when a complete native task needs independent verification.');
          }
          if (manager.isToolAvailable(agent.id, 'collab_delegate')) {
            instructions.push('For independent branches, use only the needed source refs with evidenceScope=assigned. Wait for delivery and assess results before delegating again.');
          }
          if (manager.isToolAvailable(agent.id, 'collab_publish')) instructions.push(manager.compactGuidance(agent.id));
          return instructions.join(' ');
        },
      }),
    );
    disposers.push(
      agent.ctx.tools.guard((execution) =>
        manager.canUseTool(agent.id, execution.name),
      ),
    );
    disposers.push(
      agent.ctx.tools.guard(() => {
        try {
          superagentIntegration?.assertSession(agent.id);
        } catch (error) {
          return error.message;
        }
      }),
    );
    registrations.set(agent, disposers);
  };
  ctx.on("agent/created", ({ agent }) => {
    ensureRun(agent);
    install(agent);
    localWorkspace.configureAgent(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    const binding=manager.binding(agent.id);
    if(binding) {
      const state=manager.hud.load(binding.runId).agents[agent.id];
      if(state?.turn != null || state?.attention.length) manager.hud.accept(binding.runId,{kind:'agent.cancel',agentId:agent.id,at:new Date().toISOString(),reason:'disposed'});
    }
    registrations.delete(agent);
  });
  ctx.on("agent/error", ({ agent, error }) => {
    localWorkspace.onAgentError(agent, error);
  });
  const inputDelivery = new InputDelivery(ctx.sessionPersistence);
  ctx.on("agent/pre-step", async ({ agent }, next) => {
    if (manager.bridge) ensureRun(agent);
    superagentIntegration?.assertSession?.(agent.id);
    const decision = await next();
    superagentIntegration?.assertSession?.(agent.id);
    return inputDelivery.admit(agent, decision, manager.binding(agent.id), manager.nativeInputs);
  });
  ctx.on("agent/request", async ({ agent, signal }, next) => {
    if (manager.bridge) ensureRun(agent);
    await superagentIntegration?.beforeRequest?.(agent.id, signal);
    await localWorkspace.beforeRequest(agent);
    return next();
  });
  // AgentRegistry is iterable via list() in the pinned runtime.
  for (const agent of ctx.agents.list?.() ?? []) { ensureRun(agent); install(agent); }
  installBlockingAttention(ctx,manager,()=>storeClosed);

  ctx.on("session/event", (session, event) => {
    if (storeClosed) return;
    inputDelivery.observe(session, event);
    backend.observeMessage(session, event);
    const binding = manager.binding(session.id);
    manager.observeCoordinatorTurn(session.id, event);
    const inputVersion = event.type === "tool/call" && binding && !binding.parentId && manager.nativeInputs.current(binding.runId)?.version;
    toolIndex.observe(session, event, inputVersion && inputDelivery.hasCurrent(session, binding.runId, inputVersion)
      ? { runId: binding.runId, inputVersion } : undefined);
    if (!binding) return;
    manager.hud.observe(binding,event);
    syncHostQuestions(ctx,manager.hud,binding,session,Number.isFinite(event.time)?new Date(event.time).toISOString():undefined,event);
    if (event.type === "tool/result") {
      const result = event.data?.message ?? event.data;
      const identity = toolIndex.resolve(session, event);
      if (identity.name === "collab_consult_web" ||
          advisoryCalls.get(session)?.has(result?.toolCallId ?? identity.callId)) return;
      manager.recordToolResult(
        session.id,
        identity.name,
        result,
        identity.callId ?? `unresolved-event-${event.seq}`,
        identity,
      );
    }
  });
  ctx.on("llm/stream", (options, next) => {
    const child = options.sessionId && manager.binding(options.sessionId);
    if (child?.parentId) {
      const item = store.getWorkItems(child.runId).find(work =>
        work.id === child.workItemId && work.attemptId === child.attemptId);
      const hostOnly = item?.executionKind === "host-section-lookup" || Boolean(item?.csvWorkflow);
      const requiresLocal = item?.executionKind === "free-local-model" || config.allowPaidManagedChildren !== true;
      if (!item || hostOnly || (requiresLocal && !backend.isFreeRoute(options.provider, options.model))) {
        throw Object.assign(new Error("This managed work item cannot use the selected model. Use its configured local execution path or an explicitly approved paid plan."), {
          code: "PAID_CHILD_MODEL_DISABLED",
        });
      }
    }
    localWorkspace.admit(options);
    return (async function* () {
      if (closed) {
        yield* next();
        return;
      }
      const agent = options.sessionId
        ? ctx.agents.get(options.sessionId)
        : null;
      const binding = agent
        ? ensureRun(agent)
        : manager.binding(options.sessionId);
      if (!binding) {
        yield* next();
        return;
      }
      const callId = `call-${randomUUID()}`;
      const run = store.getRun(binding.runId);
      const masterId = manager.bridge?.snapshot().masterSessionId;
      const accountingContext = requestAccountingContext(options, binding, run, config.maxOutputTokens, masterId);
      const tokenAdmission = requestTokenAdmission(options, agent?.session, binding, run, masterId,
        session => manager.coordinatorBoundaries.get(session.id) ?? ctx.agents.turnBoundaryOf?.(session), store);
      const attribution = {
        ...accountingContext,
        tokenAdmission,
        agentId: options.sessionId, attemptId: binding.attemptId ?? "root",
        workItemId: binding.workItemId ?? "root", parentAgentId: binding.parentId ?? null,
        role: binding.role ?? "unknown", provider: options.provider, model: options.model,
        purpose: options.purpose ?? "agent",
      };
      // Capture only host-visible public input, excluding hidden/private reasoning blocks.
      const manifest = JSON.parse(
        JSON.stringify({
          provider: options.provider,
          model: options.model,
          system: options.system ?? null,
          messages: options.messages.map((m) => ({
            ...m,
            content: Array.isArray(m.content)
              ? m.content.filter((b) => b.type !== "reasoning")
              : m.content,
          })),
          tools: options.tools ?? [],
          purpose: options.purpose ?? "agent",
          requestLimits: accountingContext.requestLimits,
        }),
      );
      // Accounting metadata is not sent to the model and must not inflate its input estimate.
      const { requestLimits: _limits, ...estimatedManifest } = manifest;
      const estimatedInputTokens = countTokens(JSON.stringify(estimatedManifest));
      const reservationMaxOutputTokens = accountingContext.requestLimits.reservationMaxOutputTokens;
      const estimate = estimatedInputTokens + reservationMaxOutputTokens;
      const calls = agent && advisoryCalls.get(agent.session);
      let redactedAdvisory = false;
      if (calls?.size) for (const message of manifest.messages) {
        if (message.role === "tool" && calls.has(message.toolCallId)) {
          message.content = [{ type: "text", text: "Web advice is stored with its consultation record." }];
          redactedAdvisory = true;
        }
        if (message.role === "assistant" && Array.isArray(message.content)) for (const block of message.content) {
          if (block.type === "tool-call" && calls.has(block.id)) {
            block.arguments = "{}";
            redactedAdvisory = true;
          }
        }
      }
      const artifact = store.putArtifact(JSON.stringify(manifest), {
        mediaType: "application/json",
      });
      manager.reserveCall(options.sessionId, callId, estimate, {
        provider: options.provider, model: options.model,
        estimatedInputTokens,
        maxOutputTokens: reservationMaxOutputTokens,
      }, tokenAdmission);
      let stream;
      try {
        store.recordRequest({
          ...attribution,
          callId,
          runId: binding.runId,
          agentId: options.sessionId,
          attemptId: binding.attemptId ?? "root",
          artifactRef: artifact.id,
          estimate,
          counter: manager.counterName,
          observableScope: redactedAdvisory ? "host-visible-request-minus-reasoning-and-web-advice" : "host-visible-request-minus-reasoning",
        });
        store.appendEvent({
          runId: binding.runId,
          stepId: binding.workItemId ?? "model-calls",
          attemptId: binding.attemptId ?? "root",
          kind: "model_request",
          payload: {
            callId,
            actorId: options.sessionId,
            artifactRef: artifact.id,
          },
        });
        for (const m of options.messages)
          if (m.id?.startsWith("dsh-collab:")) {
            const id = m.id.slice("dsh-collab:".length);
            const message = store.getMessage(id);
            if (message && message.status !== "included_in_request")
              store.markDelivery(id, "included_in_request", { callId });
          }
        stream = streams.begin({
          ...attribution,
          callId,
          runId: binding.runId,
          agentId: options.sessionId,
          attemptId: binding.attemptId ?? "root",
          provider: options.provider,
          model: options.model,
          purpose: options.purpose ?? "agent",
          measurement:
            options.provider === "collab-test"
              ? "synthetic_fixture"
              : "provider_reported",
        });
        if (!stream) throw new Error("Collaboration plugin is draining");
      } catch (error) {
        // next() has not run. Keep retries and monetary reconciliation tied to this call only.
        try { manager.cancelBeforeDispatch(callId, attribution); }
        catch (auditError) { manager.lastError = String(auditError); }
        throw error;
      }
      try {
        for await (const chunk of next()) {
          stream.observe(chunk);
          yield chunk;
        }
      } finally {
        stream.finish();
      }
    })();
  });

  const webScope = config.webCollaboration ? ctx.inject(["webChildConsultations"], (scope) => {
    manager.attachWebAdvisor(scope.webChildConsultations);
    scope.effect(() => () => manager.attachWebAdvisor(null));
  }) : null;
  const bridgeScope = ctx.inject(["orchestratorCollabBridge"], (scope) => {
    const bridge = scope.orchestratorCollabBridge;
    manager.attachBridge(bridge);
    const cleanups = [];
    const integration = connectSuperagent(manager, bridge);
    superagentIntegration = integration;
    cleanups.push(() => {
      integration.dispose();
      if (superagentIntegration === integration)
        superagentIntegration = undefined;
    });
    if (config.bridgeProjection)
      cleanups.push(
        bridge.registerProjection((input) =>
          projectBridgeReport(input, manager),
        ),
      );
    const sync = () => {
      if (closed) return;
      try {
        integration.sync();
        const afterSeq = Number(store.sourceCursor("superagent-reports") ?? 0);
        const batch = bridge.readEvents({ afterSeq, limit: 200 });
        for (const event of batch.events) {
          const runId = `super-${event.ticketId}-${event.assignmentId ?? "unassigned"}`;
          if (!store.getRun(runId))
            store.createRun({
              id: runId,
              source: "superagent",
              ticketId: event.ticketId,
              assignmentId: event.assignmentId ?? "unassigned",
              title: "Superagent报告",
              rootSessionId: event.sessionId,
            });
          store.importSourceEvent({
            source: "superagent-reports",
            sourceEventId: event.id,
            cursor: String(event.seq),
            event: {
              id: `source-${event.id}`,
              runId,
              stepId: event.id,
              attemptId: event.assignmentId ?? "unassigned",
              kind: "superagent_report",
              payload: event,
            },
          });
          bridge.acknowledge("dsh-collab", event.seq);
        }
      } catch (error) {
        manager.lastError = `Bridge sync: ${error.message}`;
      }
    };
    sync();
    const timer = setInterval(sync, 1000);
    timer.unref();
    scope.effect(() => () => {
      clearInterval(timer);
      for (const cleanup of cleanups) cleanup();
      manager.attachBridge(null);
    });
  });
  const disposeHttp = registerHttp(ctx, withSharedCoordinatorAccounting(manager, store));
  ctx.effect(() => async () => {
    closed = true;
    disposeHttp();
    await localWorkspace.close();
    await webScope?.dispose();
    await bridgeScope.dispose();
    for (const list of registrations.values())
      for (const dispose of list.reverse()) dispose();
    registrations.clear();
    try {
      await manager.close();
    } finally {
      try {
        await streams.close({ timeoutMs: 5000 });
      } finally {
        storeClosed = true;
        store.close();
      }
    }
  });
  ctx.logger.info(
    "dsh-collab ready: /collab (compact communication, immutable history)",
  );
}
