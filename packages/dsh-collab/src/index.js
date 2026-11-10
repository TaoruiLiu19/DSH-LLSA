import {historyScope} from './superagent-history.js';
import { Service } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { getEncoding } from 'js-tiktoken';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CollaborationStore } from './store.js';
import { CollaborationManager, COMPACT_GUIDANCE } from './manager.js';
import { createDshBackend, normalizeDshUsage } from './dsh-adapter.js';
import { registerHttp } from './http.js';
import { StreamUsageLifecycle } from './stream-lifecycle.js';
import { loadRegistry } from './load-registry.js';
import { projectBridgeReport } from './bridge-projection.js';
import { computationSchema } from './computation-schema.js';
import { loadEncodingEvidence } from './load-encoding-policy.js';
import { TASK_TYPES } from './encoding-policy.js';
import { ToolEventIndex } from './tool-event-index.js';
import { LocalWorkspace } from './local-workspace.js';
import { connectSuperagent } from './superagent-integration.js';

export const name = 'dsh-collab';
export const inject = ['agents', 'tools', 'systemPrompt', 'llm', 'sessionPersistence', 'subagents', 'webServer'];
export const Config = Schema.object({
  stateDir: Schema.string().default('./.dsh-collab'),
  maxActiveChildren: Schema.natural().min(1).max(8).default(2),
  maxRunTokens: Schema.natural().min(1000).default(200000),
  maxOutputTokens: Schema.natural().min(128).default(4096),
  childPreset: Schema.string().default('standard'),
  bridgeProjection: Schema.boolean().default(true),
  explicitEvidenceRefs: Schema.boolean().default(false),
  protocolFile: Schema.string().default(''),
  encodingEvidenceFile: Schema.string().default(''),
  minEvidenceSamples: Schema.natural().min(5).default(5),
});

class CollabService extends Service {
  constructor(ctx, manager) { super(ctx, 'collab'); this.manager = manager; }
}
const objectOutput = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const jsonValue = z.json();

export async function apply(ctx, rawConfig = {}) {
  const config = { stateDir: './.dsh-collab', maxActiveChildren: 2, maxRunTokens: 200000, maxOutputTokens: 4096, childPreset: 'standard', bridgeProjection: true, encodingEvidenceFile:'', minEvidenceSamples:5, ...rawConfig };
  const store = new CollaborationStore({ stateDir: resolve(config.stateDir) });
  const encoding = getEncoding('o200k_base');
  const countTokens = text => encoding.encode(text).length;
  let registry, qualityEvidence;
  try { registry=loadRegistry(store,config.protocolFile?resolve(config.protocolFile):null);
    qualityEvidence=loadEncodingEvidence(config.encodingEvidenceFile?resolve(config.encodingEvidenceFile):null); }
  catch(error) {store.close();throw error;}
  const manager = new CollaborationManager({ store, registry, countTokens, counterName: 'o200k_base estimate; not DeepSeek billing', maxActiveChildren: config.maxActiveChildren, maxRunTokens: config.maxRunTokens, maxOutputTokens: config.maxOutputTokens, qualityEvidence, minEvidenceSamples:config.minEvidenceSamples, explicitEvidenceRefs:config.explicitEvidenceRefs??false });
  const backend = createDshBackend(ctx, manager, config); manager.backend = backend;
  const localWorkspace = new LocalWorkspace({manager,ctx});manager.localWorkspace=localWorkspace;
  new CollabService(ctx, manager);
  const registrations = new Map(); let closed = false, storeClosed = false, superagentIntegration;
  const toolIndex = new ToolEventIndex();
  const streams = new StreamUsageLifecycle({ recordUsage: row => store.recordUsage(row), releaseCall: id => manager.releaseCall(id), normalizeUsage: normalizeDshUsage });

  const ensureRun = agent => {
    const child = manager.binding(agent.id); if (child?.parentId) return child;
    const bridge = manager.bridge;
    if (bridge) {
      const snapshot=bridge.snapshot();
      if(snapshot.masterSessionId===agent.id)return manager.bindRoot(agent.id,{runId:`super-master-${agent.id}`,title:'Superagent orchestrator'});
      const row = snapshot.tickets.find(x => x.workerSessionId === agent.id);
      if (row?.assignmentId) return manager.bindRoot(agent.id, { runId: `super-${row.ticket.id}-${row.assignmentId}`, ticketId: row.ticket.id, assignmentId: row.assignmentId, title: row.ticket.title });
    }
    return manager.bindRoot(agent.id);
  };
  const install = agent => {
    if (registrations.has(agent) || closed) return;
    const disposers = [];
    const register = (toolName, description, schema, execute) => disposers.push(agent.ctx.tools.register({ name: toolName, description, parameters: z.toJSONSchema(schema), output: objectOutput,
      execute: async (args, exec) => {
        if (closed) throw new Error('Collaboration plugin is closing');
        if (exec.agent && exec.agent !== agent) throw new Error('Agent binding mismatch');
        ensureRun(agent); return execute(schema.parse(args), exec);
      } }, { when: () => !closed && manager.isToolAvailable(agent.id,toolName) }));
    register('collab_status', 'List compact agent and task states. Read individual history or evidence only when needed.', z.object({}).strict(), () => {
      const native=manager.bridge?.snapshot();
      if(native?.masterSessionId===agent.id)return {tickets:native.tickets.map(row=>({ticketId:row.ticket.id,assignmentId:row.assignmentId,ended:row.ticket.ended??null,
        workItems:row.assignmentId?store.getWorkItems(`super-${row.ticket.id}-${row.assignmentId}`).map(w=>({id:w.id,state:w.state})):[]})),scope:'native_ticket_assignments',note:'Acceptance states are coordinator assessments, not independent factual verification.'};
      const view=manager.describeRun(ensureRun(agent).runId);
      return {runId:view.run.id,agents:view.agents.map(a=>({id:a.id,role:a.role,state:a.state})),workItems:view.workItems.map(w=>({id:w.id,state:w.state,dependsOn:w.dependsOn??[]})),usage:{calls:view.usage.calls,totalTokens:view.usage.totalTokens,unknownCalls:view.usage.unknownCalls},history:'Use collab_history for a specific step.'};
    });
    register('collab_delegate', 'Start a scoped child; results require collab_accept. For exact calculations bind an immutable computation contract first. v2 supports per-operation filters, pluck, extrema and every. v3 adds at(index): zero-based complete row after global and operation filters, out-of-range fails; use empty filters for original positions and count. Default host completion computes and publishes in one call; model-copy is the legacy two-call path. Correct computation does not validate the chosen business rule.', z.object({ objective: z.string().min(1).max(20000), taskType:z.enum(TASK_TYPES).optional().describe('Encoding task class only; never evidence of correctness.'),role: z.enum(['researcher','reviewer','implementer','tester']).default('researcher'), dependsOn: z.array(z.string()).default([]), acceptance: z.array(z.string()).default([]), inputRefs: z.array(z.string()).default([]), workItemId: z.string().optional(), retryOf: z.string().optional(), computation:computationSchema.optional(), completionMode:z.enum(['host','model-copy']).optional() }).strict(), args => manager.delegate(agent, args));
    register('collab_compute', 'Execute the immutable computation contract already bound to your current task. Returns the host result and receiptId; copy required fields exactly and supply receiptId to collab_publish. No arbitrary expressions or new contract selection.', z.object({}).strict(), () => manager.compute(agent.id,{}));
    register('collab_complete_computation', 'Compute the already-bound task contract and publish its exact final result directly in the host. No result values or rule overrides are accepted. Returns saved result and receipt references. Once submitted=true, finish briefly; the parent receives the result automatically.', z.object({stepId:z.string().min(1).optional()}).strict(), args => manager.completeComputation(agent.id,args));
    register('collab_publish', 'Persist a public step or final result. For a computation task supply the collab_compute receiptId and its exact result fields; a mismatch is retained as a failed claim and is not submitted. Only contracted fields receive host verification. After final submission finish briefly.' + (config.explicitEvidenceRefs ? ' parents contains existing eventId values only, never stepId, workItemId or artifact refs; omit if no causal event is needed.' : ''), z.object({ stepId: z.string().min(1), result: jsonValue, final: z.boolean().default(false), parents: z.array(z.string()).default([]), receiptId:z.string().optional() }).strict(), args => manager.publish(agent.id,args));
    register('collab_send', 'Send structured facts within this managed run. Select taskType only for the intended use, never as quality evidence. The host requires matching model/task evaluation and net token savings; otherwise it sends JSON. Contract-bound computation results always use the exact route.', z.object({ targetId: z.string(), result: jsonValue, stepId: z.string().optional(), taskType:z.enum(TASK_TYPES).default('generic') }).strict(), args => manager.send(agent.id,args));
    register('collab_history', 'Read a saved historical step and its deterministic Chinese field rendering. Does not execute work or use future results.' + (config.explicitEvidenceRefs ? ' For a delivered child result use its stepId, attemptId and eventId. workItemId is not a stepId. Read history only for missing detail; the delivered result is already available for review.' : ''), z.object({ stepId: z.string().optional(), ticketId:z.string().optional(), assignmentId:z.string().optional(), attemptId: z.string().optional(), eventId: z.string().optional(), asOfSeq: z.number().int().nonnegative().optional() }).strict().refine(x=>!!x.stepId||!!x.eventId,'stepId or eventId is required'), args => { ensureRun(agent); const {runId,stepId}=historyScope(manager,agent.id,args);const {ticketId,assignmentId,stepId:unused,...opts}=args;return manager.inspect(runId,stepId,opts); });
    register('collab_read_evidence', 'Read a bounded immutable artifact. Native coordinators may specify ticketId and assignmentId; other sessions remain confined to their own run.', z.object({ ref: z.string(), ticketId:z.string().optional(),assignmentId:z.string().optional(),start: z.number().int().nonnegative().default(0), bytes: z.number().int().min(1).max(64000).default(8000) }).strict(), args => {
      const {data,mediaType}=manager.readArtifact(historyScope(manager,agent.id,args).runId,args.ref,{start:args.start,end:args.start+args.bytes}); return {ref:args.ref,start:args.start,bytes:data.length,mediaType,text:data.toString('utf8')};
    });
    register('collab_accept', 'Assess a child result against its acceptance criteria. Only the owning coordinator may accept; provide the recorded reason and evidence references.' + (config.explicitEvidenceRefs ? ' evidenceRefs accepts artifact sha256 refs from the delivered evidenceRefs field; workItemId and eventId are not artifact refs. An empty array is allowed.' : ''), z.object({ workItemId: z.string(), accepted: z.boolean(), reason: z.string().min(1), evidenceRefs: z.array(z.string()).default([]) }).strict(), args => manager.accept(agent.id,args));
    register('collab_project_log', 'Save a raw log and return a deterministic deduplicated view with counts and original reference.', z.object({ stepId: z.string(), text: z.string().max(1000000), maxEntries: z.number().int().min(2).max(500).default(80) }).strict(), args => manager.prepareLog(agent.id,args));
    disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-collab', order: 9998, interpolate: false, text: () => `For delegated tasks use collab_delegate, collab_send and collab_publish to preserve inspectable steps and compact messages. ${COMPACT_GUIDANCE}` }));
    disposers.push(agent.ctx.tools.guard(execution => manager.canUseTool(agent.id, execution.name)));
    disposers.push(agent.ctx.tools.guard(()=>{try{superagentIntegration?.assertSession(agent.id);}catch(error){return error.message;}}));
    registrations.set(agent,disposers);
  };
  ctx.on('agent/created', ({agent}) => { install(agent);localWorkspace.configureAgent(agent); });
  ctx.on('agent/disposed', ({agent}) => { registrations.delete(agent); });
  ctx.on('agent/error', ({agent,error}) => {localWorkspace.onAgentError(agent,error);});
  ctx.on('agent/request', async ({agent,signal},next) => {if(manager.bridge)ensureRun(agent);await superagentIntegration?.beforeRequest?.(agent.id,signal);await localWorkspace.beforeRequest(agent);return next();});
  // AgentRegistry is iterable via list() in the pinned runtime.
  for (const agent of (ctx.agents.list?.() ?? [])) install(agent);

  ctx.on('session/event', (session,event) => {
    if (storeClosed) return;
    backend.observeMessage(session,event);
    toolIndex.observe(session,event);
    const binding = manager.binding(session.id); if (!binding) return;
    if (event.type === 'tool/result') {
      const result = event.data?.message ?? event.data;
      const identity = toolIndex.resolve(session,event);
      manager.recordToolResult(session.id, identity.name, result, identity.callId ?? `unresolved-event-${event.seq}`, identity);
    }
  });
  ctx.on('llm/stream', (options,next) => {
    localWorkspace.admit(options);
    return (async function* () {
    if (closed) { yield* next(); return; }
    const agent=options.sessionId?ctx.agents.get(options.sessionId):null;
    const binding = agent?ensureRun(agent):manager.binding(options.sessionId); if (!binding) { yield* next(); return; }
    const callId = `call-${randomUUID()}`;
    // Capture only host-visible public input, excluding hidden/private reasoning blocks.
    const manifest = JSON.parse(JSON.stringify({ provider: options.provider, model: options.model, system: options.system ?? null,
      messages: options.messages.map(m => ({...m,content:Array.isArray(m.content)?m.content.filter(b=>b.type!=='reasoning'):m.content})), tools: options.tools ?? [], purpose: options.purpose ?? 'agent' }));
    const estimate = countTokens(JSON.stringify(manifest)) + (options.maxTokens ?? config.maxOutputTokens);
    manager.reserveCall(options.sessionId,callId,estimate);
    const artifact = store.putArtifact(JSON.stringify(manifest), { mediaType:'application/json' });
    store.recordRequest({ callId, runId:binding.runId, agentId:options.sessionId, attemptId:binding.attemptId??'root', artifactRef:artifact.id, estimate, counter:manager.counterName, observableScope:'host-visible-request-minus-reasoning' });
    store.appendEvent({runId:binding.runId,stepId:binding.workItemId??'model-calls',attemptId:binding.attemptId??'root',kind:'model_request',payload:{callId,actorId:options.sessionId,artifactRef:artifact.id}});
    for(const m of options.messages) if(m.id?.startsWith('dsh-collab:')) {
      const id=m.id.slice('dsh-collab:'.length); const message=store.getMessage(id);
      if(message&&message.status!=='included_in_request') store.markDelivery(id,'included_in_request',{callId});
    }
    const stream = streams.begin({callId,runId:binding.runId,agentId:options.sessionId,attemptId:binding.attemptId??'root',provider:options.provider,model:options.model,purpose:options.purpose??'agent',measurement:options.provider==='collab-test'?'synthetic_fixture':'provider_reported'});
    try { for await(const chunk of next()) { stream.observe(chunk); yield chunk; } }
    finally { stream.finish(); }
    })();
  });

  const bridgeScope = ctx.inject(['orchestratorCollabBridge'], scope => {
    const bridge=scope.orchestratorCollabBridge; manager.attachBridge(bridge);
    const cleanups=[];
    const integration=connectSuperagent(manager,bridge);superagentIntegration=integration;cleanups.push(()=>{integration.dispose();if(superagentIntegration===integration)superagentIntegration=undefined;});
    if(config.bridgeProjection) cleanups.push(bridge.registerProjection(input => projectBridgeReport(input,manager)));
    const sync = () => {
      if (closed) return;
      try {
        integration.sync();
        const afterSeq=Number(store.sourceCursor('superagent-reports')??0);
        const batch=bridge.readEvents({afterSeq,limit:200});
        for(const event of batch.events) {
          const runId=`super-${event.ticketId}-${event.assignmentId??'unassigned'}`;
          if(!store.getRun(runId)) store.createRun({id:runId,source:'superagent',ticketId:event.ticketId,assignmentId:event.assignmentId??'unassigned',title:'Superagent报告',rootSessionId:event.sessionId});
          store.importSourceEvent({source:'superagent-reports',sourceEventId:event.id,cursor:String(event.seq),event:{id:`source-${event.id}`,runId,stepId:event.id,attemptId:event.assignmentId??'unassigned',kind:'superagent_report',payload:event}});
          bridge.acknowledge('dsh-collab',event.seq);
        }
      } catch(error) { manager.lastError=`Bridge sync: ${error.message}`; }
    };
    sync(); const timer=setInterval(sync,1000); timer.unref();
    scope.effect(()=>()=>{clearInterval(timer);for(const cleanup of cleanups)cleanup();manager.attachBridge(null);});
  });
  const disposeHttp = registerHttp(ctx,manager);
  ctx.effect(()=>async()=>{
    closed=true;
    disposeHttp();
    await localWorkspace.close();
    await bridgeScope.dispose();
    for(const list of registrations.values())for(const dispose of list.reverse())dispose();
    registrations.clear();
    try { await manager.close(); }
    finally {
      try { await streams.close({timeoutMs:5000}); }
      finally { storeClosed=true;store.close(); }
    }
  });
  ctx.logger.info('dsh-collab ready: /collab (compact communication, immutable history)');
}

