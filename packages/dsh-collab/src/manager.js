import { randomUUID, createHash } from 'node:crypto';
import { ProtocolRegistry, selectEncoding, decodePacket, renderChinese, projectInput } from './protocol.js';
import { VERIFICATION_SCOPE, normalizeContract, canonicalHash, executeComputation, resultMismatches } from './computation.js';
import { normalizeQualityEvidence, MIN_EVIDENCE_SAMPLES, TASK_TYPES } from './encoding-policy.js';

const uid = prefix => `${prefix}-${randomUUID()}`;
const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
const copy = value => JSON.parse(JSON.stringify(value));
const ACTIVE = new Set(['starting', 'running', 'stopping']);
const WRITERS = new Set(['implementer', 'tester']);
export const COMPACT_GUIDANCE = 'Use collab_publish for public steps and final results. Preserve numbers, negations, errors, constraints and evidence. Use collab_send for managed communication. Send concise structured facts, not encrypted text. Query collab_history for a prior step. After final submission, finish with a short acknowledgement. Published facts are claims unless backed by tool evidence.';

/** Host orchestration; backend owns actual DSH handles. No model reasoning is fabricated. */
export class CollaborationManager {
  constructor({ store, registry = new ProtocolRegistry(), countTokens, counterName = 'heuristic', backend = null, maxActiveChildren = 2, maxRunTokens = 200000, maxOutputTokens = 4096, closeTimeoutMs = 10000, qualityEvidence = [], minEvidenceSamples = MIN_EVIDENCE_SAMPLES, explicitEvidenceRefs = false } = {}) {
    if (typeof explicitEvidenceRefs !== 'boolean') fail('INVALID_ARGUMENT','explicitEvidenceRefs must be boolean');
    this.explicitEvidenceRefs = explicitEvidenceRefs;
    this.store = store; this.registry = registry; this.countTokens = countTokens; this.counterName = counterName;
    this.backend = backend; this.maxActiveChildren = maxActiveChildren; this.maxRunTokens = maxRunTokens; this.maxOutputTokens = maxOutputTokens;
    this.qualityEvidence = normalizeQualityEvidence(qualityEvidence);
    if (!Number.isSafeInteger(minEvidenceSamples) || minEvidenceSamples < MIN_EVIDENCE_SAMPLES) fail('INVALID_ARGUMENT', 'Encoding evidence requires at least five samples');
    this.minEvidenceSamples = minEvidenceSamples;
    this.bindings = new Map(); this.handles = new Map(); this.pending = new Map(); this.finalEvents = new Map(); this.held = new Set(); this.reservations = new Map(); this.bridge = null; this.closing = false;
    this.toolPolicies = new Map();
    this.runLimits = new Map();
    this.starting = new Set(); this.settlements = new Map(); this.delivering = new Set(); this.closed = false; this.closePromise = null;
    if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1) fail('INVALID_ARGUMENT', 'closeTimeoutMs must be a positive safe integer');
    this.closeTimeoutMs = closeTimeoutMs;
    for (const run of store.listRuns()) {
      for (const agent of store.getAgents(run.id)) this.bindings.set(agent.id, agent);
      for (const event of this.#events(run.id)) {
        if (event.kind === 'run_limits') this.runLimits.set(run.id, event.payload);
        if (event.kind === 'dispatch_hold') event.payload.paused ? this.held.add(run.id) : this.held.delete(run.id);
        if (event.kind === 'final_result' && event.payload.actorId) this.finalEvents.set(event.payload.actorId, event);
      }
      const calls = new Map(store.usageSummary(run.id).usage.map(call => [call.callId, call]));
      for (const request of store.listRequests(run.id)) {
        const usage = calls.get(request.callId);
        if (usage?.inputTokens != null && usage?.outputTokens != null) continue;
        const estimate = request.estimate;
        if (Number.isSafeInteger(estimate) && estimate >= 0) {
          const known = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
          this.reservations.set(request.callId, { runId:run.id, estimate, tokens:Math.max(0,estimate-known), recovered:true });
        } else this.held.add(run.id); // No bound for an unaccounted historical request: do not silently grant more work.
      }
      for (const item of store.getWorkItems(run.id)) if (ACTIVE.has(item.state)) {
        store.saveWorkItem({ ...item, state: 'unknown', recovery: 'Previous process ended; inspect actual DSH and tool state before retry.' });
        store.appendEvent({ runId: run.id, stepId: item.id, attemptId: item.attemptId, kind: 'recovery_required', payload: { state: 'unknown', previousState: item.state } });
      }
    }
  }
  status() {
    return { name: 'dsh-collab', version: '0.4.0', purpose: '紧凑通信与可追溯协作，不是保密加密', dshVersion: '0.2.2-rc.1 (integration target)', counter: this.counterName,
      mode: this.backend ? 'managed_tools' : 'local', bridge: this.bridge?.compatibility() ?? null,
      capabilities: { persistentHistory: true, adaptiveEncoding: true, qualityGatedEncoding: true, deterministicChinese: true, managedDelegation: !!this.backend, hostComputation: true, directHostCompletion: true, computationVersions: ['1','2'], receiptBoundAcceptance: true, computationVerificationScope: 'bound_contract_fields_only', realModelSavingsVerified: false, automaticLanguageLearning: false },
      encodingPolicy: { minimumSamples: this.minEvidenceSamples, configuredEvidence: this.qualityEvidence.length, defaultFallback: 'json' },
      limitations: ['自由文本保留原文；中文字段由模板展开', '词典需要评测后发布，不会在线猜测新语义', this.bridge?.compatibility().capabilities?.domainEvents ? '已记录原生领域事件、报告与验收；不记录隐藏思维链' : '旧版桥接仅捕获已接入的报告通道'] };
  }
  listRuns() { return this.store.listRuns().map(r => ({ ...r, paused: this.held.has(r.id), usage: this.store.usageSummary(r.id) })); }
  *#events(runId) {
    // Freeze one committed watermark across all pages; a partial first page is never the whole run.
    const asOfSeq = this.store.highWater(runId); let afterSeq = 0;
    while (afterSeq < asOfSeq) {
      const page = this.store.listEvents(runId, { asOfSeq, afterSeq, limit:1000 });
      if (!page.length) break;
      for (const event of page) yield event;
      const next = page.at(-1).runSeq;
      if (next <= afterSeq) fail('INVALID_EVENT_CURSOR', 'Event pagination did not advance');
      afterSeq = next;
    }
  }
  describeRun(id) {
    const run = this.store.getRun(id); if (!run) fail('NOT_FOUND', 'Run not found');
    return { run: { ...run, paused: this.held.has(id) }, agents: this.store.getAgents(id), workItems: this.store.getWorkItems(id), events: [...this.#events(id)], usage: this.store.usageSummary(id) };
  }
  bindRoot(sessionId, details = {}) {
    const prior = this.bindings.get(sessionId);
    if (prior && (!details.runId || prior.runId === details.runId)) return prior;
    if (prior?.parentId) fail('FORBIDDEN', 'A child cannot be rebound as a root');
    const id = details.runId ?? `run-${sessionId}`;
    if (!this.store.getRun(id)) this.store.createRun({ id, ticketId: details.ticketId ?? `local-${sessionId}`, assignmentId: details.assignmentId ?? 'local', title: details.title ?? 'DSH 协作会话', source: details.ticketId ? 'superagent' : 'dsh', rootSessionId: sessionId });
    const agent = this.store.saveAgent({ id: sessionId, runId: id, parentId: null, role: 'coordinator', state: 'active', managed: true });
    this.bindings.set(sessionId, agent); return agent;
  }
  binding(sessionId) { return this.bindings.get(sessionId); }
  setRunLimits(runId, limits) {
    if (!this.store.getRun(runId) || !limits || Object.keys(limits).some(key => !['maxOutputTokens','maxRunTokens'].includes(key))
      || !Number.isSafeInteger(limits.maxOutputTokens) || limits.maxOutputTokens < 1 || limits.maxOutputTokens > this.maxOutputTokens
      || !Number.isSafeInteger(limits.maxRunTokens) || limits.maxRunTokens < 1 || limits.maxRunTokens > this.maxRunTokens) fail('INVALID_ARGUMENT','Invalid per-run limits');
    const prior=this.runLimits.get(runId);
    if (prior) fail('IMMUTABLE_LIMITS','Per-run limits are fixed when the task is created');
    const saved=copy(limits);this.store.appendEvent({runId,stepId:'local-task',kind:'run_limits',payload:saved});this.runLimits.set(runId,saved);
  }
  setToolPolicy(sessionId, allowedNames) {
    // Host API only: no model-facing tool can change declaration policy.
    if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(allowedNames)
      || allowedNames.some(name => typeof name !== 'string' || !/^collab_[a-z_]+$/.test(name))
      || new Set(allowedNames).size !== allowedNames.length) fail('INVALID_ARGUMENT', 'Expected a session ID and unique collaboration tool names');
    this.toolPolicies.set(sessionId, new Set(allowedNames));
  }
  isToolAvailable(sessionId, toolName) {
    const policy = this.toolPolicies.get(sessionId);
    if (policy && !policy.has(toolName)) return false;
    const binding = this.bindings.get(sessionId);
    const item = binding?.workItemId ? this.store.getWorkItems(binding.runId).find(work => work.id === binding.workItemId) : null;
    if (binding?.parentId && item?.computation) {
      if (item.attemptId !== binding.attemptId || !ACTIVE.has(item.state) || this.finalEvents.has(sessionId)) return false;
      return (item.completionMode === 'model-copy' ? ['collab_compute','collab_publish'] : ['collab_complete_computation']).includes(toolName);
    }
    if (['collab_compute','collab_complete_computation'].includes(toolName)) return false;
    if (binding?.parentId && ['collab_delegate','collab_accept'].includes(toolName)) return false;
    return true;
  }
  authorize(sessionId, runId) { const b = this.bindings.get(sessionId); if (!b || b.runId !== runId) fail('FORBIDDEN', 'Agent is not bound to this run'); return b; }
  #saveAgent(agent) { this.store.saveAgent(agent); this.bindings.set(agent.id, agent); return agent; }
  #item(runId, id) { const item = this.store.getWorkItems(runId).find(x => x.id === id); if (!item) fail('NOT_FOUND', 'Unknown work item'); return item; }
  #current(binding) { if (!binding.workItemId) return null; const item = this.#item(binding.runId, binding.workItemId); if (item.attemptId !== binding.attemptId) fail('STALE_ATTEMPT', 'Old activation cannot update the current attempt'); return item; }
  #event(binding, stepId, kind, payload, parents = []) {
    this.#current(binding);
    return this.store.appendEvent({ runId: binding.runId, stepId, attemptId: binding.attemptId ?? 'root', kind, payload: { ...copy(payload), actorId: binding.id }, parents });
  }
  select(payload, modelProfile = 'unverified', taskType = 'generic') {
    if (!TASK_TYPES.includes(taskType)) fail('INVALID_ARGUMENT', 'Unknown encoding task type');
    return selectEncoding(payload, { registry: this.registry, countTokens: this.countTokens, counterName: this.counterName, modelProfile,
      taskType, ...(payload && !Array.isArray(payload)&&Array.isArray(payload.result)?{bodyField:'result'}:{}),qualityEvidence: this.qualityEvidence, minEvidenceSamples: this.minEvidenceSamples });
  }
  publish(sessionId, { stepId, result, final = false, parents = [], receiptId }) {
    const binding = this.bindings.get(sessionId); if (!binding) fail('FORBIDDEN', 'No managed run');
    const item = this.#current(binding);
    const existingFinal = this.finalEvents.get(sessionId);
    if (final && existingFinal?.runId === binding.runId && existingFinal.attemptId === (binding.attemptId ?? 'root')) fail('ALREADY_SUBMITTED', 'Final result already submitted');
    const artifact = this.store.putArtifact(JSON.stringify(result), { mediaType: 'application/json' });
    let verification;
    if (item?.computation) {
      try {
        const receipt = this.#validatedReceipt(binding, item, receiptId);
        const mismatches = resultMismatches(result, receipt.result);
        if (mismatches.length) {
          const error = new Error('Claim differs from required host-computed fields'); error.code = 'RESULT_MISMATCH'; error.mismatches = mismatches; throw error;
        }
        verification = { status: 'passed', receiptId, contractHash: receipt.contractHash, resultArtifactRef: artifact.id, verifiedFields: Object.keys(receipt.result), scope: VERIFICATION_SCOPE };
      } catch (error) {
        const event = this.#event(binding, stepId || item.id, 'validation_failed', { result, artifactRef: artifact.id, provenance: 'agent_claim', requestedFinal: final, receiptId: receiptId ?? null, error: { code: error.code ?? 'VALIDATION_ERROR', message: error.message, mismatches: error.mismatches ?? [] } }, parents);
        return { eventId: event.id, stepId: event.stepId, runId: binding.runId, artifactRef: artifact.id, submitted: false, validation: 'failed', error: event.payload.error };
      }
    }
    const event = this.#event(binding, stepId || item?.id || 'root-result', final ? 'final_result' : 'step_result', { result, artifactRef: artifact.id, provenance: verification ? 'host_verified_fields' : 'agent_claim', final, ...(verification ? { verification } : {}) }, parents);
    if (final) this.finalEvents.set(sessionId, event);
    return { eventId: event.id, stepId: event.stepId, runId: binding.runId, artifactRef: artifact.id, submitted: true, ...(verification ? { verification } : {}) };
  }
  #boundContract(item) {
    // The append-only task definition is authoritative; work-item rows are mutable projections.
    const planned = [...this.#events(item.runId)].find(event => event.kind === 'work_planned' && event.stepId === item.id && event.attemptId === item.attemptId);
    if (!planned?.payload.computation || canonicalHash(planned.payload.computation) !== item.contractHash || canonicalHash(item.computation) !== item.contractHash) fail('INVALID_CONTRACT', 'Current task does not match its immutable computation contract');
    return normalizeContract(planned.payload.computation);
  }
  #runComputation(item) {
    const contract = this.#boundContract(item);
    const meta = this.store.getArtifact(contract.inputRef);
    if (meta.bytes > 2 * 1024 * 1024) fail('INPUT_TOO_LARGE', 'Computation input exceeds 2 MiB');
    const { data } = this.readArtifact(item.runId, contract.inputRef);
    return { ...executeComputation(contract, data), inputRef: contract.inputRef };
  }
  compute(sessionId, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length) fail('INVALID_ARGUMENT', 'collab_compute accepts no plan overrides; the task contract is already bound');
    const binding = this.bindings.get(sessionId); if (!binding) fail('FORBIDDEN', 'No managed run');
    const item = this.#current(binding);
    if (!item?.computation) fail('NO_COMPUTATION_CONTRACT', 'No computation contract was bound to this work item');
    if (!ACTIVE.has(item.state)) fail('INVALID_STATE', 'Compute is only available during the current activation');
    if (this.finalEvents.has(sessionId)) fail('ALREADY_SUBMITTED', 'Final result already submitted');
    const computed = this.#runComputation(item);
    const receipt = { ...computed, runId: binding.runId, workItemId: item.id, attemptId: item.attemptId, actorId: sessionId, resultHash: canonicalHash(computed.result), provenance: 'host_computation', verificationScope: VERIFICATION_SCOPE };
    const receiptArtifact = this.store.putArtifact(JSON.stringify(receipt), { mediaType: 'application/json' });
    const event = this.#event(binding, item.id, 'computation_receipt', { ...receipt, artifactRef: receiptArtifact.id });
    return { receiptId: event.id, result: computed.result, contractHash: computed.contractHash, inputRef: computed.inputRef, verificationScope: VERIFICATION_SCOPE };
  }
  completeComputation(sessionId, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => key !== 'stepId')
      || (Object.hasOwn(options, 'stepId') && (typeof options.stepId !== 'string' || !options.stepId.trim()))) {
      fail('INVALID_ARGUMENT', 'Only an optional nonempty stepId is accepted; computed values and contracts cannot be supplied');
    }
    // Keep both the receipt and final event. The model never copies or edits the result.
    const receipt = this.compute(sessionId, {});
    const published = this.publish(sessionId, { stepId: options.stepId, result: receipt.result, receiptId: receipt.receiptId, final: true });
    if (!published.submitted) fail('COMPUTATION_PUBLICATION_FAILED', 'Host result did not pass its bound receipt validation');
    return { submitted: true, eventId: published.eventId, artifactRef: published.artifactRef,
      receiptId: receipt.receiptId, verifiedFields: published.verification.verifiedFields,
      verificationScope: VERIFICATION_SCOPE };
  }
  #validatedReceipt(binding, item, receiptId) {
    if (typeof receiptId !== 'string' || !receiptId) fail('RECEIPT_REQUIRED', 'A host computation receipt is required');
    const event = this.store.getEvent(receiptId), receipt = event?.payload;
    if (!event || event.kind !== 'computation_receipt' || event.runId !== binding.runId || event.stepId !== item.id || event.attemptId !== item.attemptId || receipt?.actorId !== binding.id || receipt.runId !== binding.runId || receipt.workItemId !== item.id || receipt.attemptId !== item.attemptId || receipt.provenance !== 'host_computation') fail('INVALID_RECEIPT', 'Receipt must be host-issued for this run, work item, attempt, and actor');
    const computed = this.#runComputation(item);
    if (receipt.toolVersion !== computed.toolVersion || receipt.inputRef !== computed.inputRef || receipt.contractHash !== computed.contractHash || receipt.resultHash !== canonicalHash(computed.result) || canonicalHash(receipt.result) !== receipt.resultHash) fail('INVALID_RECEIPT', 'Receipt does not match the bound input, rule, or exact result');
    // Also verify persisted receipt bytes: a digest identifies bytes, never semantic correctness.
    const { artifactRef, ...persisted } = receipt;
    if (this.store.readArtifact(artifactRef).toString('utf8') !== JSON.stringify(persisted)) fail('INVALID_RECEIPT', 'Receipt artifact differs from its immutable host event');
    return receipt;
  }
  #validatedFinal(item) {
    const binding = this.bindings.get(item.childId), final = this.store.getEvent(item.resultEventId);
    if (!binding || binding.attemptId !== item.attemptId || !final || final.kind !== 'final_result' || final.runId !== item.runId || final.attemptId !== item.attemptId || final.payload.actorId !== item.childId || this.finalEvents.get(item.childId)?.id !== final.id) fail('VALIDATION_REQUIRED', 'Acceptance requires the current child final result');
    const verification = final.payload.verification;
    if (verification?.status !== 'passed' || final.payload.provenance !== 'host_verified_fields' || verification.resultArtifactRef !== final.payload.artifactRef) fail('VALIDATION_REQUIRED', 'Final result has no bound host validation');
    const receipt = this.#validatedReceipt(binding, item, verification.receiptId);
    if (verification.contractHash !== receipt.contractHash || canonicalHash(verification.verifiedFields) !== canonicalHash(Object.keys(receipt.result)) || resultMismatches(final.payload.result, receipt.result).length || this.store.readArtifact(final.payload.artifactRef).toString('utf8') !== JSON.stringify(final.payload.result)) fail('VALIDATION_REQUIRED', 'Final result differs from its host validation');
    return verification;
  }
  recordToolResult(sessionId, toolName, result, toolCallId, identity = null) {
    const binding = this.bindings.get(sessionId); if (!binding) return;
    const artifact = this.store.putArtifact(JSON.stringify(result), { mediaType: 'application/json' });
    return this.store.appendEvent({ runId: binding.runId, stepId: binding.workItemId ?? `tool-${toolCallId}`, attemptId: binding.attemptId ?? 'root', kind: 'tool_observation', payload: { actorId: sessionId, toolName, toolCallId, artifactRef: artifact.id, provenance: 'host_tool_result', ...(identity ? { toolIdentity: identity } : {}) } });
  }
  inspect(runId, stepId, opts = {}) {
    const view = this.store.inspectStep(runId, stepId, opts);
    if (view.event) {
      const payload = view.event.payload;
      view.chinese = renderChinese(payload.result ?? payload);
      if (view.event.kind === 'validation_failed') {
        view.verification = { status: 'failed', error: payload.error, scope: VERIFICATION_SCOPE };
        view.chinese = `验证失败；以下为保留的原始声明。${view.chinese}`;
      } else if (payload.verification) {
        view.verification = payload.verification;
        view.chinese = `仅按绑定规则核对字段：${(payload.verification.verifiedFields ?? []).join('、')}；未验证输入真实性、规则语义或其他声明。${view.chinese}`;
      }
      view.explanationSource = 'deterministic_fields_and_original_text';
      view.generatedAt = new Date().toISOString();
    }
    return view;
  }
  readArtifact(runId, ref, options = {}) {
    // A reference must actually occur in an immutable event of this run.
    const includes = v => typeof v === 'string' ? v === ref : Array.isArray(v) ? v.some(includes) : v && typeof v === 'object' ? Object.values(v).some(includes) : false;
    let referenced = false;
    for (const event of this.#events(runId)) if (includes(event.payload) || includes(event.inputRefs)) { referenced = true; break; }
    if (!referenced) fail('FORBIDDEN', 'Artifact is not referenced by this run');
    const meta = this.store.getArtifact(ref); if (!meta) fail('NOT_FOUND', 'Artifact not found');
    const range = { ...options };
    if (range.end !== undefined && Number.isSafeInteger(range.end)) range.end = Math.min(range.end, meta.bytes);
    return { data: this.store.readArtifact(ref, range), mediaType: meta.mediaType ?? 'application/octet-stream' };
  }
  prepareLog(sessionId, { stepId, text, maxEntries = 80 }) {
    const b = this.bindings.get(sessionId); if (!b) fail('FORBIDDEN', 'No managed run');
    const raw = this.store.putArtifact(text, { mediaType: 'text/plain; charset=utf-8' });
    const projection = projectInput(text, { kind: 'log', artifactRef: raw.id, maxEntries });
    const event = this.#event(b, stepId ?? uid('log'), 'log_projection', { artifactRef: raw.id, projection });
    return { eventId: event.id, projection, artifactRef: raw.id };
  }
  async send(sessionId, args) { return this.#send(sessionId, args); }
  async #send(sessionId, { targetId, result, stepId, messageId = uid('msg'), taskType = 'generic' }, hostDelivery = false) {
    const sender = this.bindings.get(sessionId); if (!sender) fail('FORBIDDEN', 'No managed run');
    const recipient = this.authorize(targetId, sender.runId); const item = this.#current(sender); this.#current(recipient);
    const projection = item?.computation && !hostDelivery ? { claim: result, provenance: 'agent_claim', verification: { status: 'unverified', scope: VERIFICATION_SCOPE } } : result;
    // Contract-bound results always use the exact-computation route, irrespective of a model's task label.
    const selected = this.select(projection, this.backend?.modelProfile?.(targetId) ?? 'unverified', item?.computation ? 'exact-computation' : taskType);
    const artifact = this.store.putArtifact(JSON.stringify(result), { mediaType: 'application/json' });
    const committed = this.store.commitMessage({ event: { runId: sender.runId, stepId: stepId ?? uid('message'), attemptId: sender.attemptId ?? 'root', kind: 'agent_message', payload: { sender: sessionId, recipient: targetId, result, artifactRef: artifact.id, provenance: hostDelivery ? 'host_delivery' : 'agent_claim', selected: { packet: selected.packet, instructions: selected.instructions, metrics: selected.metrics } } },
      message: { id: messageId, logicalMessageId: messageId, sender: sessionId, recipient: targetId, projection: { text: selected.modelInput ?? `${selected.instructions}\n${selected.text}`, packet: selected.packet }, deliveryRevision: 1 } });
    await this.deliver(committed.message);
    return { messageId, eventId: committed.event.id, status: this.store.getMessage(messageId).status, codec: selected.codec, metrics: selected.metrics };
  }
  async deliver(message) {
    if (this.closed) return { unknown:true, note:'Manager closed before delivery' };
    if (!this.backend) return { queued: true };
    if (message.status === 'inbox_persisted' || message.status === 'included_in_request') return { duplicate: true };
    const binding = this.authorize(message.recipient, message.runId); this.#current(binding);
    this.delivering.add(message.id);
    try {
      const receipt = await this.backend.deliver({ recipientId: message.recipient, senderId: message.sender, runId: message.runId, messageId: message.id, text: message.projection.text });
      if (this.closed) return { unknown:true, note:'Delivery settled after shutdown deadline' };
      this.store.markDelivery(message.id, 'inbox_persisted', { receipt }); return receipt;
    } catch (e) {
      if (!this.closed) this.store.markDelivery(message.id, 'unknown', { error: String(e.message), note: 'Check persisted DSH inbox before retrying' }); throw e;
    } finally { this.delivering.delete(message.id); }
  }
  async flushOutbox(runId) {
    const results = [];
    for (const m of this.store.listOutbox({ runId, states: ['queued', 'unknown'] })) {
      if (!this.backend?.getAgent?.(m.recipient)) continue;
      try { results.push(await this.deliver(m)); } catch (e) { results.push({ messageId: m.id, error: e.message }); }
    }
    return results;
  }
  async delegate(parent, { objective, role = 'researcher', dependsOn = [], acceptance = [], inputRefs = [], workItemId, retryOf, computation, completionMode, taskType, maxOutputTokens = this.maxOutputTokens }) {
    if (this.closing) fail('CLOSING', 'Plugin is draining');
    const b = this.bindings.get(parent.id) ?? this.bindRoot(parent.id);
    maxOutputTokens=Math.min(maxOutputTokens,this.runLimits.get(b.runId)?.maxOutputTokens??this.maxOutputTokens);
    if (b.parentId) fail('DEPTH_LIMIT', 'MVP delegation is owned by the root coordinator');
    if (!this.backend) fail('UNAVAILABLE', 'DSH backend is not connected');
    if (!['researcher', 'reviewer', 'implementer', 'tester'].includes(role)) fail('INVALID_ROLE', 'Unsupported role');
    if (typeof objective !== 'string' || !objective.trim()) fail('INVALID_ARGUMENT', 'Objective required');
    const old = retryOf ? this.#item(b.runId, retryOf) : null;
    taskType=taskType??old?.taskType??'generic';
    if(!TASK_TYPES.includes(taskType))fail('INVALID_ARGUMENT','Unknown encoding task type');
    const mode = completionMode ?? old?.completionMode ?? 'host';
    if (!['host', 'model-copy'].includes(mode)) fail('INVALID_ARGUMENT', 'completionMode must be host or model-copy');
    if (old && !['failed', 'cancelled', 'unknown', 'rejected'].includes(old.state)) fail('INVALID_STATE', 'Only a failed/interrupted work item can be retried');
    const id = old?.id ?? workItemId ?? uid('work');
    if (!old && this.store.getWorkItems(b.runId).some(x => x.id === id)) fail('DUPLICATE_WORK', 'Work item already exists');
    for (const dep of dependsOn) { if (dep === id) fail('DEPENDENCY_CYCLE', 'Task cannot depend on itself'); this.#item(b.runId, dep); }
    for (const ref of inputRefs) this.readArtifact(b.runId, ref);
    const contract = computation === undefined ? (old?.computation ? normalizeContract(old.computation) : null) : normalizeContract(computation);
    if (contract && !inputRefs.includes(contract.inputRef)) fail('INVALID_CONTRACT', 'Computation inputRef must be an authorized task inputRef');
    const attemptId = uid('try'); const childId = uid('collab');
    const item = { id, runId: b.runId, objective, role, dependsOn, acceptance, inputRefs, taskType,attemptId, childId, parentId: parent.id, state: 'ready', maxOutputTokens, epoch: (old?.epoch ?? 0) + 1, ...(contract ? { computation: contract, contractHash: canonicalHash(contract), completionMode: mode } : {}) };
    this.store.saveWorkItem(item);
    this.store.appendEvent({ runId: b.runId, stepId: id, attemptId, kind: 'work_planned', payload: item });
    this.#saveAgent({ id: childId, runId: b.runId, parentId: parent.id, role, state: 'planned', workItemId: id, attemptId, epoch: item.epoch, managed: true });
    this.pending.set(childId, { item, parent });
    await this.schedule(b.runId);
    return { workItemId: id, runId: b.runId, childId, attemptId, state: this.#item(b.runId, id).state };
  }
  async schedule(runId) {
    if (this.closing || this.held.has(runId)) return;
    for (const [childId, request] of this.pending) {
      const { item, parent } = request; if (item.runId !== runId) continue;
      const current = this.#item(runId, item.id);
      if (current.attemptId !== item.attemptId || current.state !== 'ready') { this.pending.delete(childId); continue; }
      const tasks = this.store.getWorkItems(runId);
      if (tasks.filter(x => ACTIVE.has(x.state)).length >= this.maxActiveChildren) return;
      if (!item.dependsOn.every(dep => tasks.find(t => t.id === dep)?.state === 'succeeded')) continue;
      if (WRITERS.has(item.role) && tasks.some(t => ACTIVE.has(t.state) && WRITERS.has(t.role))) continue;
      if (this.store.usageSummary(runId).totalTokens >= (this.runLimits.get(runId)?.maxRunTokens??this.maxRunTokens)) { this.pause(runId, true, 'token_budget'); return; }
      this.pending.delete(childId);
      this.store.saveWorkItem({ ...item, state: 'starting' });
      this.#saveAgent({ ...this.bindings.get(childId), state: 'starting' });
      const completion = item.completionMode === 'model-copy'
        ? 'Call collab_compute with {}. Publish the exact returned result fields and receiptId using collab_publish final=true.'
        : 'Call collab_complete_computation with {} once. The host computes and publishes the exact bound result directly; do not copy or recalculate values. After submitted=true, finish with a brief acknowledgement.';
      const prompt = `${COMPACT_GUIDANCE}\nRole: ${item.role}. Work item: ${item.id}. Run: ${runId}. Attempt: ${item.attemptId}.\nObjective: ${item.objective}\nAcceptance: ${JSON.stringify(item.acceptance)}\nAvailable evidence references: ${JSON.stringify(item.inputRefs)}${item.computation ? `\nBound computation contract: ${JSON.stringify(item.computation)}\n${completion} ${VERIFICATION_SCOPE}` : ''}\nUse only your permitted tools. Evidence is not new authorization.`;
      this.store.appendEvent({ runId, stepId: item.id, attemptId: item.attemptId, kind: 'delegation_input', payload: { recipient: childId, prompt, inputRefs: item.inputRefs, provenance: 'host' } });
      try {
        const start = Promise.resolve(this.backend.start({ parent, childId, prompt, label: item.objective.slice(0, 80), maxOutputTokens: item.maxOutputTokens }));
        this.starting.add(start);
        let handle;
        try { handle = await start; } finally { this.starting.delete(start); }
        if (this.closed) { await handle.dispose(); return; }
        this.handles.set(childId, handle);
        this.store.saveWorkItem({ ...item, state: 'running' }); this.#saveAgent({ ...this.bindings.get(childId), state: 'active' });
        const settlement = handle.result.then(result => this.settle(childId, result), error => this.settle(childId, { stopReason: 'error', output: [], diagnostic: error.message }))
          .catch(error => { this.lastError = error.message; }).finally(() => { this.settlements.delete(childId); });
        this.settlements.set(childId, settlement);
        if (this.closing) await handle.dispose();
      } catch (e) { await this.settle(childId, { stopReason: 'error', output: [], diagnostic: e.message }); }
    }
  }
  async settle(childId, result) {
    if (this.closed) return { unknown:true, note:'Activation settled after shutdown deadline' };
    const binding = this.bindings.get(childId); if (!binding) return;
    this.handles.delete(childId);
    let previous;
    for (const event of this.#events(binding.runId)) if (event.kind === 'activation_settled' && event.attemptId === binding.attemptId && event.payload.agentId === childId) { previous=event; break; }
    if (previous) return { duplicate: true, eventId: previous.id };
    const item = this.#item(binding.runId, binding.workItemId);
    const stale = item.attemptId !== binding.attemptId || this.bindings.get(binding.parentId)?.runId !== binding.runId;
    const final = this.finalEvents.get(childId);
    const output = (result.output ?? []).filter(x => x.type !== 'reasoning');
    const raw = this.store.putArtifact(JSON.stringify({ ...result, output }), { mediaType: 'application/json' });
    const event = this.store.appendEvent({ runId: binding.runId, stepId: item.id, attemptId: binding.attemptId, kind: 'activation_settled', payload: { agentId: childId, stopReason: result.stopReason, finalEventId: final?.id ?? null, artifactRef: raw.id, stale, diagnostic: result.diagnostic ?? null } });
    this.#saveAgent({ ...binding, state: 'settled' });
    if (stale) return;
    const state = result.stopReason === 'completed' ? 'submitted' : result.stopReason === 'aborted' ? 'cancelled' : 'failed';
    this.store.saveWorkItem({ ...item, state, resultEventId: final?.id ?? event.id, settlementEventId: event.id });
    const publicResult = final?.payload.result ?? { execution_status: result.stopReason, outcome: 'inconclusive', summary: item.computation ? 'No host-validated final result was submitted.' : output.filter(x => x.type === 'text').map(x => x.text).join('\n').slice(0, 1200), raw_ref: raw.id, note: 'No structured final result; full output archived.' };
    if (this.backend?.getAgent?.(binding.parentId)) {
      try { await this.#send(childId, { targetId: binding.parentId, stepId: `${item.id}:delivery`, taskType:item.taskType??'generic',result: { workItemId: item.id, state, eventId: final?.id ?? event.id, ...(this.explicitEvidenceRefs ? {stepId:(final??event).stepId,attemptId:(final??event).attemptId,evidenceRefs:[final?.payload.artifactRef ?? raw.id]} : {}), result: publicResult, ...(item.computation ? { verification: final?.payload.verification ?? { status: 'missing', scope: VERIFICATION_SCOPE } } : {}) } }, true); }
      catch (e) { this.lastError = e.message; }
    }
    await this.schedule(binding.runId);
  }
  accept(parentId, { workItemId, accepted, reason, evidenceRefs = [] }) {
    const b = this.bindings.get(parentId); if (!b) fail('FORBIDDEN', 'No managed run');
    const item = this.#item(b.runId, workItemId);
    if (item.parentId !== parentId || item.state !== 'submitted') fail('INVALID_STATE', 'Only the owning coordinator can assess a submitted result');
    if (typeof accepted !== 'boolean') fail('INVALID_ARGUMENT', 'accepted must be a boolean');
    for (const ref of evidenceRefs) this.readArtifact(b.runId, ref);
    if (typeof reason !== 'string' || !reason.trim()) fail('INVALID_ARGUMENT', 'Recorded acceptance reason required');
    const verification = accepted && item.computation ? this.#validatedFinal(item) : null;
    const event = this.#event(b, workItemId, 'result_assessment', { accepted, reason, evidenceRefs, resultEventId: item.resultEventId, provenance: 'coordinator_assessment', ...(verification ? { verification } : {}) }, [item.resultEventId]);
    this.store.saveWorkItem({ ...item, state: accepted ? 'succeeded' : 'rejected', verificationEventId: event.id });
    this.schedule(b.runId).catch(e => { this.lastError = e.message; });
    return { eventId: event.id, state: accepted ? 'succeeded' : 'rejected' };
  }
  pause(runId, paused, reason = 'operator') {
    if (!this.store.getRun(runId)) fail('NOT_FOUND', 'Run not found');
    paused ? this.held.add(runId) : this.held.delete(runId);
    this.store.appendEvent({ runId, stepId: 'dispatch', kind: 'dispatch_hold', payload: { paused, reason, runningOperationsNotFrozen: true } });
    if (!paused) this.schedule(runId).catch(e => { this.lastError = e.message; });
    return { runId, paused, runningOperationsNotFrozen: true };
  }
  async interrupt(runId, agentId) {
    const binding = this.authorize(agentId, runId); if (!binding.parentId) fail('INVALID_ARGUMENT', 'Interrupt a managed child, not the root');
    const handle = this.handles.get(agentId); if (!handle) fail('UNAVAILABLE', 'Activation handle is unavailable; inspect its recorded state');
    const item = this.#current(binding); this.store.saveWorkItem({ ...item, state: 'stopping' });
    this.store.appendEvent({ runId, stepId: item.id, attemptId: item.attemptId, kind: 'interrupt_requested', payload: { agentId } });
    await handle.dispose(); return { interrupted: true, agentId };
  }
  canUseTool(sessionId, toolName) {
    const b = this.bindings.get(sessionId); if (!b) return;
    if (toolName.startsWith('collab_') && !this.isToolAvailable(sessionId,toolName)) return 'This tool is not available for the current task phase and host policy.';
    const final = this.finalEvents.get(sessionId);
    if (final?.runId === b.runId && final.attemptId === (b.attemptId ?? 'root') && !toolName.startsWith('collab_')) return 'Final result already submitted; finish the turn.';
    if (['subagent', 'send_message'].includes(toolName)) return 'Use collab_delegate/collab_send so results are recorded and compacted.';
    const writes = /^(bash|pwsh|write|edit|apply_patch|str_replace|shell|exec)/.test(toolName);
    if (!writes) return;
    if (b.parentId && !WRITERS.has(b.role)) return 'This research/review role only reads evidence; delegate execution to an implementer or tester.';
    const writer = this.store.getWorkItems(b.runId).find(t => ACTIVE.has(t.state) && WRITERS.has(t.role));
    if (writer && writer.childId !== sessionId) return 'A managed writer owns this workspace; wait for it to settle.';
  }
  reserveCall(sessionId, callId, estimate) {
    const b = this.bindings.get(sessionId); if (!b) return null;
    if (!Number.isSafeInteger(estimate) || estimate < 0) fail('INVALID_ARGUMENT', 'Token reservation must be a nonnegative safe integer');
    if (typeof callId !== 'string' || !callId) fail('INVALID_ARGUMENT', 'callId required');
    const old = this.reservations.get(callId);
    if (old) { if (old.runId !== b.runId || (old.estimate??old.tokens) !== estimate) fail('RESERVATION_CONFLICT', 'callId already reserved with different data'); return b; }
    const usage = this.store.usageSummary(b.runId);
    const pending = [...this.reservations.values()].filter(x => x.runId === b.runId).reduce((n,x) => n+x.tokens,0);
    if (usage.totalTokens + pending + estimate > (this.runLimits.get(b.runId)?.maxRunTokens??this.maxRunTokens)) { this.pause(b.runId,true,'token_budget'); fail('TOKEN_BUDGET', 'Run token admission budget exceeded'); }
    this.reservations.set(callId,{runId:b.runId,estimate,tokens:estimate}); return b;
  }
  releaseCall(callId) {
    const reservation = this.reservations.get(callId); if (!reservation) return;
    const usage = this.store.usageSummary(reservation.runId).usage.find(call => call.callId === callId);
    if (usage?.inputTokens != null && usage?.outputTokens != null) { this.reservations.delete(callId); return; }
    const known = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    this.reservations.set(callId, { ...reservation, tokens:Math.max(0,(reservation.estimate??reservation.tokens)-known) });
  }
  protocols() { return this.registry.exportVersions(); }
  attachBridge(bridge) { this.bridge = bridge; }
  async operatorControl(command) {
    if (!this.bridge) fail('UNAVAILABLE', 'Superagent bridge not connected');
    const run = this.store.getRun(command.runId); if (!run) fail('NOT_FOUND', 'Run not found');
    return this.bridge.operatorControl({ commandId: command.commandId ?? uid('command'), kind: command.action ?? command.kind, ticketId: run.ticketId, reason: command.reason }, {kind:'operator',id:'local-collab-panel'});
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.pending.clear();
    this.closePromise = (async () => {
      let timer;
      const drain = (async () => {
        while (this.starting.size) await Promise.allSettled([...this.starting]);
        await Promise.allSettled([...this.handles.values()].map(h => h.dispose()));
        while (this.settlements.size) await Promise.allSettled([...this.settlements.values()]);
        return true;
      })();
      const drained = await Promise.race([drain, new Promise(resolve => { timer=setTimeout(()=>resolve(false),this.closeTimeoutMs); })]);
      clearTimeout(timer);
      if (!drained) {
        this.lastError = 'Shutdown deadline reached; unconfirmed activations require recovery.';
        for (const run of this.store.listRuns()) for (const item of this.store.getWorkItems(run.id)) if (ACTIVE.has(item.state)) {
          this.store.saveWorkItem({ ...item,state:'unknown',recovery:'Shutdown deadline; verify DSH and external state before retry.' });
          this.store.appendEvent({runId:run.id,stepId:item.id,attemptId:item.attemptId,kind:'shutdown_unconfirmed',payload:{state:'unknown',previousState:item.state}});
        }
        for (const id of this.delivering) {
          const message=this.store.getMessage(id);
          if (message && ['queued','unknown'].includes(message.status)) this.store.markDelivery(id,'unknown',{note:'Shutdown before delivery receipt; inspect DSH inbox before retry'});
        }
      }
      this.closed = true; this.handles.clear();
      return { drained, unknown:!drained };
    })();
    return this.closePromise;
  }
}
