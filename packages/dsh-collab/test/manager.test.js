import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { CollaborationStore } from '../src/store.js';
import { CollaborationManager } from '../src/manager.js';
import { createHash } from 'node:crypto';
import { NativeInputs } from '../src/native-inputs.js';
import { connectSuperagent } from '../src/superagent-integration.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};}
function fakeBackend(){
  const active=new Map(),started=[],deliveries=[];
  return {
    active,started,deliveries,
    getAgent(id){return {id};},modelProfile(){return 'test-unverified';},
    async start(input){
      const d=deferred();const handle={result:d.promise,disposeCount:0,async dispose(){this.disposeCount++;d.resolve({stopReason:'aborted',output:[]});}};
      active.set(input.childId,{...d,handle});started.push(input);return handle;
    },
    async deliver(input){deliveries.push(input);return {messageId:input.messageId,accepted:true};},
    async complete(childId,result={stopReason:'completed',output:[{type:'text',text:'已提交'}]}){
      active.get(childId).resolve(result);await tick();await tick();
    },
  };
}
function fixture(t,options={}){
  const tempRoot=fileURLToPath(new URL('../.test-state/',import.meta.url));mkdirSync(tempRoot,{recursive:true});
  const stateDir=mkdtempSync(join(tempRoot,'manager-'));
  const store=new CollaborationStore({stateDir}),backend=fakeBackend();
  const manager=new CollaborationManager({store,backend,allowPaidManagedChildren:true,...options});
  const root={id:'root'};const binding=manager.bindRoot(root.id,{runId:'r1',ticketId:'t1',assignmentId:'a1'});
  t.after(async()=>{
    await manager.close();await tick();await tick();store.close();
    const rel=relative(resolve(tempRoot),resolve(stateDir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    rmSync(stateDir,{recursive:true,force:true});
  });
  return {store,backend,manager,root,binding,stateDir};
}
const result={execution_status:'completed',outcome:'failed',facts:{passed:18,failed:1,exit_code:1},summary:'到期边界测试失败，尚未验证修复。',constraints:['不得部署'],evidence_refs:[]};

test('native workers cannot close their task with an archival final; children retain final completion', async t => {
  const { manager, root, backend, store } = fixture(t);
  const child = await manager.delegate(root, { objective: 'Review the result' });
  manager.publish(child.childId, { stepId: 'child-final', result, final: true });
  assert.match(manager.canUseTool(child.childId, 'orchestrator_report'), /finish the turn/);
  await backend.complete(child.childId);

  const before = store.highWater('r1');
  assert.throws(() => manager.publish(root.id, { stepId: 'archive', result, final: true }), error => {
    assert.equal(error.code, 'NATIVE_REPORT_REQUIRED');
    assert.match(error.message, /final=false/);
    assert.match(error.message, /rerun failed checks/);
    assert.match(error.message, /orchestrator_report/);
    return true;
  });
  assert.equal(store.highWater('r1'), before, 'a rejected final must not create any publication event');
  assert.equal(manager.finalEvents.has(root.id), false);
  const checkpoint = manager.publish(root.id, { stepId: 'archive', result, final: false });
  assert.equal(store.getEvent(checkpoint.eventId).kind, 'step_result');
  assert.equal(manager.canUseTool(root.id, 'hud_check'), undefined);
  assert.equal(manager.canUseTool(root.id, 'orchestrator_report'), undefined);
  assert.equal(manager.canUseTool(root.id, 'write_file'), undefined);
});

test('legacy native archival finals remain inspectable after restart without locking repair and recheck', async t => {
  const { manager, root, backend, store } = fixture(t);
  const artifact = store.putArtifact(JSON.stringify(result), { mediaType: 'application/json' });
  // A real old-store shape: do not use the new public API to fabricate legacy behavior.
  const legacy = store.appendEvent({ runId: 'r1', stepId: 'legacy-final', attemptId: 'root', kind: 'final_result',
    payload: { actorId: root.id, result, artifactRef: artifact.id, final: true, provenance: 'agent_claim' } });
  manager.recordToolResult(root.id, 'hud_check', { passed: false, error: 'Screenshot mismatch; repair required.' }, 'failed-check');
  const recovered = new CollaborationManager({ store, backend, allowPaidManagedChildren: true });
  try {
    assert.equal(recovered.finalEvents.get(root.id).id, legacy.id, 'old history is recovered, not erased');
    for (const tool of ['read_file', 'write_file', 'edit_file', 'apply_patch', 'hud_check', 'orchestrator_report']) {
      assert.equal(recovered.canUseTool(root.id, tool), undefined, `legacy archive must not block ${tool}`);
    }
    const checkpoint = recovered.publish(root.id, { stepId: 'repair-check', result: { passed: true }, final: false });
    assert.equal(store.getEvent(checkpoint.eventId).kind, 'step_result');
    assert.throws(() => recovered.publish(root.id, { result: { passed: true }, final: true }), { code: 'NATIVE_REPORT_REQUIRED' });
    assert.deepEqual(recovered.inspect('r1', 'legacy-final', { eventId: legacy.id }).event.payload.result, result);
    assert.deepEqual(store.getEvent(legacy.id), legacy, 'failed-era final is immutable');
    const writer = await recovered.delegate(root, { objective: 'Repair with an exclusive writer', role: 'implementer' });
    assert.match(recovered.canUseTool(root.id, 'write_file'), /managed writer owns/,
      'legacy recovery does not bypass the independent writer lock');
    await backend.complete(writer.childId);
    assert.equal(recovered.canUseTool(root.id, 'write_file'), undefined);
  } finally { await recovered.close(); }
});

test('checkpoint-only guidance follows native ticket binding and excludes shared coordinator and managed child', async t => {
  const { manager, root, backend } = fixture(t);
  assert.equal(manager.isNativeTicketRoot(root.id), true);
  assert.match(manager.compactGuidance(root.id), /final=false only/);
  assert.match(manager.compactGuidance(root.id), /orchestrator_report/);
  assert.doesNotMatch(manager.compactGuidance(root.id), /Use collab_publish for public steps and final results/);
  const child = await manager.delegate(root, { objective: 'Child final stays authoritative for its managed work item' });
  assert.equal(manager.isNativeTicketRoot(child.childId), false);
  assert.match(manager.compactGuidance(child.childId), /final results/);
  manager.publish(child.childId, { result, final: true }); await backend.complete(child.childId);
  manager.bindRoot(root.id, { runId: 'standalone' });
  assert.equal(manager.isNativeTicketRoot(root.id), false);
  assert.match(manager.compactGuidance(root.id), /final results/);
  manager.bindRoot(root.id, { runId: 'super-master-root', ticketId: 'legacy-coordinator', assignmentId: 'coordinator' });
  assert.equal(manager.isNativeTicketRoot(root.id), false);
  manager.publish(root.id, { result, final: true });
  assert.match(manager.canUseTool(root.id, 'write_file'), /finish the turn/);
  assert.equal(manager.canUseTool(root.id, 'orchestrator_report'), undefined, 'retain preexisting shared coordinator semantics');
});

test('deterministic section children bind verified results without dispatching a model', async t => {
  const { backend, manager, root, store } = fixture(t, { allowPaidManagedChildren: false, groupSectionResults: true });
  const input = manager.syncNativeInput('r1', inputSnapshot(JSON.stringify({ sources: [{ id: 'ledger',
    text: 'Find the signed records.\n## West\nid|approval|change\n007|signed|-15\n042|draft|0\n\n## East\n| id | approval | change |\n| --- | --- | --- |\n| 009 | signed | 12 |\n' }] })));
  const lookup = { filters: [{ field: 'approval', equals: 'signed' }],
    fields: [{ field: 'id', type: 'text' }, { field: 'change', as: 'cents', type: 'integer' }], sectionField: 'section' };
  const args = { input: input.handle, sections: ['s1', 's2'], objective: 'Find signed records.', lookup };
  const batch = await manager.delegateSections(root, args);
  assert.equal(backend.started.length, 0);
  assert.equal(backend.deliveries.length, 1);
  assert.equal(batch.workItems.length, 2);
  assert.ok(batch.workItems.every(item => item.state === 'submitted' && item.executionKind === 'host-section-lookup' && item.modelCalls === 0));
  const items = store.getWorkItems('r1');
  const finals = items.map(item => store.getEvent(item.resultEventId));
  assert.deepEqual(finals.map(event => event.payload.result), [
    { section: 'West', id: '007', cents: -15 }, { section: 'East', id: '009', cents: 12 },
  ]);
  for (const event of finals) {
    const receipt = store.getEvent(event.payload.verification.receiptId);
    assert.equal(receipt.payload.modelCalls, 0);
    assert.equal(receipt.payload.toolVersion, 'section-pipe-lookup-1');
  }
  const [notice] = store.eventsByKind('r1', 'agent_message');
  const wire = backend.deliveries[0].text;
  const full = manager.select(notice.payload.result).modelInput;
  for (const event of finals) {
    assert.ok(wire.includes(event.payload.verification.receiptId));
    assert.ok(!wire.includes(event.payload.verification.contractHash));
    assert.equal(notice.payload.result.results.find(row => row.eventId === event.id).verification.contractHash,
      event.payload.verification.contractHash, 'Full verification remains accessible from the delivery and final events');
  }
  assert.ok(Buffer.byteLength(wire) < Buffer.byteLength(full));
  const short = ['s1', 's2'].map(section => ({ section, accepted: true, reason: 'Matched the bound ledger rule.' }));
  const review = reviews => manager.acceptSections(root.id, { batchId: batch.batchId, reviews });
  assert.throws(() => review([short[0], { ...short[1], section: 's3' }]), { code: 'STALE_RESULT' });
  assert.throws(() => review([short[0], { workItemId: items[0].id, eventId: finals[0].id, accepted: true, reason: 'Duplicate' }]), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => review([{ ...short[0], eventId: finals[1].id }]), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => review([short[0], { ...short[1], workItemId: items[0].id, eventId: finals[1].id }]), { code: 'INVALID_ARGUMENT' });
  assert.equal(store.eventsByKind('r1', 'result_assessment').length, 0);
  const matched = [{ ...short[0], workItemId: items[0].id, eventId: finals[0].id }, short[1]];
  assert.deepEqual(review(matched).assessments.map(row => [row.section, row.state]), [['s1', 'succeeded'], ['s2', 'succeeded']]);
  const accepted = manager.acceptSections(root.id, { batchId: batch.batchId,
    reviews: items.map(item => ({ workItemId: item.id, eventId: item.resultEventId, accepted: true, reason: 'Matched the bound ledger rule.' })) });
  assert.equal(accepted.assessments.length, 2);
  assert.equal(store.eventsByKind('r1', 'result_assessment').length, 2, 'Replay with full IDs reuses the pinned assessments');
  assert.deepEqual(items.map(({ id }) => manager.computationReview('r1', id).source.inputVersion), [input.version, input.version]);
  assert.deepEqual((await manager.delegateSections(root, args)).workItems.map(item => item.workItemId), batch.workItems.map(item => item.workItemId));
  assert.equal(backend.deliveries.length, 1);
  assert.equal(store.usageSummary('r1').calls, 0);
  store.saveWorkItem({ ...store.getWorkItems('r1')[1], resultEventId: finals[0].id });
  assert.throws(() => review(short), { code: 'STALE_RESULT' }, 'An old delivery cannot silently bind a different final');
});

test('unsupported typed sections and disappeared free model routes never start a paid child by default', async t => {
  const { backend, manager, root, store } = fixture(t, { allowPaidManagedChildren: false });
  const input = manager.syncNativeInput('r1', inputSnapshot(JSON.stringify({ sources: [{ id: 'ledger',
    text: 'Audit.\n## West\nid|approval\n007|signed\n\n## East\nid|approval\n009|signed\n012|signed\n' }] })));
  const args = { input: input.handle, sections: ['s1', 's2'], objective: 'Find signed records.' };
  assert.equal(manager.isToolAvailable(root.id, 'collab_delegate_task'), false);
  assert.equal(manager.isToolAvailable(root.id, 'collab_delegate_sections'), true);
  assert.equal(manager.isToolAvailable(root.id, 'collab_delegate'), true, 'Bound local computations remain available');
  assert.doesNotMatch(manager.nativeInputs.hint('r1'), /collab_delegate_task/);
  await assert.rejects(manager.delegateSections(root, { ...args, lookup: {
    filters: [{ field: 'approval', equals: 'signed' }], fields: [{ field: 'id', type: 'text' }],
  } }), { code: 'SECTION_LOOKUP_NOT_UNIQUE' });
  await assert.rejects(manager.delegateSections(root, args), { code: 'FREE_CHILD_UNAVAILABLE' });
  await assert.rejects(manager.delegate(root, { objective: 'Review independently.' }), { code: 'FREE_CHILD_UNAVAILABLE' });
  assert.equal(store.eventsByKind('r1', 'work_planned').length, 0);
  backend.canStartFree = () => true;
  assert.equal(manager.isToolAvailable(root.id, 'collab_delegate_task'), true);
  manager.pause('r1', true);
  const held = await manager.delegate(root, { objective: 'Review independently.' });
  assert.equal(held.state, 'ready');
  backend.canStartFree = () => false;
  assert.equal(manager.isToolAvailable(root.id, 'collab_delegate_task'), false);
  manager.pause('r1', false);
  await tick(); await tick();
  assert.equal(backend.started.length, 0);
  assert.equal(store.getWorkItems('r1')[0].state, 'failed');
  assert.equal(store.getWorkItems('r1')[0].executionKind, 'free-local-model');
  backend.canStartFree = () => true;
  await manager.delegate(root, { objective: 'Review independently.', retryOf: held.workItemId });
  assert.equal(backend.started.length, 1);
  assert.equal(backend.started[0].paid, false);
  const job = store.getWorkItems('r1')[0];
  manager.publish(job.childId, { result: { completed: true }, final: true });
  await backend.complete(job.childId);
});

test('only a verified free child skips monetary reservation and still consumes the token budget', async t => {
  const moneyPolicy = { id: 'fixture-period', currency: 'USD', maxCost: 0.01, maxRunCost: 0.01, maxBranchCost: 0.01,
    prices: [{ id: 'priced', provider: 'paid-fixture', model: 'paid', currency: 'USD', source: 'test',
      perMillion: { cacheHit: 1, cacheMiss: 1, cacheWrite: 1, output: 1 } }] };
  const { backend, manager, root, store } = fixture(t, { allowPaidManagedChildren: false, moneyPolicy, maxRunTokens: 1000 });
  backend.canStartFree = () => true;
  backend.isFreeRoute = (provider, model) => provider === 'loopback' && model === 'local-fixture';
  const child = await manager.delegate(root, { objective: 'Read assigned evidence.' });
  const price = { provider: 'loopback', model: 'local-fixture', estimatedInputTokens: 80, maxOutputTokens: 20 };
  manager.reserveCall(child.childId, 'free-child-call', 100, price);
  assert.equal(store.eventsByKind('r1', 'money_reserved').length, 0);
  assert.equal(manager.describeRun('r1').moneyBudget.knownCost, 0);
  assert.throws(() => manager.reserveCall(root.id, 'unpriced-root-call', 100, price), { code: 'MONEY_PRICE_MISSING' });
  manager.pause('r1', false);
  assert.throws(() => manager.reserveCall(child.childId, 'too-large-free-call', 901, price), { code: 'TOKEN_BUDGET' });
  await backend.complete(child.childId);
});

test('money admission persists across recovery and operator resume cannot reset spending', async t => {
  const moneyPolicy={id:'period',currency:'USD',maxCost:.0006,maxRunCost:.0006,maxBranchCost:.0006,reserveMultiplier:1,
    prices:[{id:'fixture',currency:'USD',provider:'fixture',model:'m',source:'test-only',perMillion:{cacheHit:1,cacheMiss:2,cacheWrite:2,output:4}}]};
  const {manager,store,root}=fixture(t,{moneyPolicy});
  const context={provider:'fixture',model:'m',estimatedInputTokens:100,maxOutputTokens:50};
  manager.reserveCall(root.id,'a',150,context);
  assert.throws(()=>manager.reserveCall(root.id,'b',150,context),{code:'MONEY_BUDGET'});
  assert.equal(manager.describeRun('r1').run.paused,true);
  manager.pause('r1',false);
  assert.throws(()=>manager.reserveCall(root.id,'b',150,context),{code:'MONEY_BUDGET'});
  const reopened=new CollaborationManager({store,moneyPolicy});
  assert.equal(reopened.describeRun('r1').moneyBudget.unsettledCalls,1);
  reopened.pause('r1',false);
  assert.throws(()=>reopened.reserveCall(root.id,'c',150,context),{code:'MONEY_BUDGET'});
  store.recordUsage({callId:'a',runId:'r1',provider:'fixture',model:'m',inputTokens:100,cachedInputTokens:100,uncachedInputTokens:0,cacheWriteTokens:0,outputTokens:0});
  reopened.pause('r1',false);
  assert.equal(reopened.reserveCall(root.id,'d',150,context).runId,'r1');
  await reopened.close();
});

function inputSnapshot(text) { return { text, version: createHash('sha256').update(text).digest('hex') }; }

const webTaskInput = (text, enabled = true) => inputSnapshot(JSON.stringify({
  origin: { triggerId: 'origin' },
  sources: [{ id: 'origin', source: 'local', text, meta: enabled ? { webConsultationEnabled: true } : {} }],
}));

test('web consultation requires launch and task opt-in and archives one bounded reply per attempt', async t => {
  const { manager, root, store } = fixture(t, { webCollaboration: true });
  const requests = [];
  const markdown = '建'.repeat(260);
  manager.attachWebAdvisor({ async ask(request) {
    requests.push(request);
    return { consultationId: 'mock-1', markdown, provider: 'manual' };
  } });
  manager.syncNativeInput('r1', webTaskInput('Check one rule', false));
  const off = await manager.delegate(root, { objective: 'Verify locally' });
  assert.equal(manager.isToolAvailable(off.childId, 'collab_consult_web'), false);
  assert.equal((await manager.consultWeb(off.childId, 'Check one rule')).status, 'unavailable');

  const oldVersion = manager.syncNativeInput('r1', webTaskInput('Check one rule')).version;
  const on = await manager.delegate(root, { objective: 'Check the rule' });
  assert.equal(manager.isToolAvailable(root.id, 'collab_consult_web'), false);
  assert.equal(manager.isToolAvailable(on.childId, 'collab_consult_web'), true);
  await assert.rejects(manager.consultWeb(on.childId, '问'.repeat(342)), { code: 'INVALID_WEB_QUESTION' });
  const reply = await manager.consultWeb(on.childId, 'Check just this rule');
  assert.equal(reply.status, 'ready');
  assert.equal(reply.provenance, 'unverified_web_advice');
  assert.equal(reply.nextStart, 768);
  assert.equal(Buffer.byteLength(reply.markdownPreview), 768);
  assert.equal(requests[0].question, 'Check just this rule');
  assert.equal(requests[0].inputVersion, oldVersion);
  assert.equal(manager.readArtifact('r1', reply.artifactRef, {}, on.childId).data.toString(), markdown);
  assert.throws(() => manager.readArtifact('r1', reply.artifactRef, {}, off.childId), { code: 'FORBIDDEN' });
  assert.equal(store.eventsByKind('r1', 'web_consultation_received').length, 1);
  assert.equal((await manager.consultWeb(on.childId, 'Ask again')).status, 'unavailable');
  assert.equal(requests.length, 1);

  const disabled = new CollaborationManager({ store });
  disabled.attachWebAdvisor({ ask() { throw new Error('disabled advisor called'); } });
  assert.equal(disabled.isToolAvailable(on.childId, 'collab_consult_web'), false);
  await disabled.close();
});

test('native input changes abort outstanding web consultation and prevent late replies', async t => {
  const { manager, root, store } = fixture(t, { webCollaboration: true });
  const late = deferred();
  let request;
  manager.attachWebAdvisor({ ask(input) { request = input; return late.promise; } });
  manager.syncNativeInput('r1', webTaskInput('First version'));
  const child = await manager.delegate(root, { objective: 'Verify one item' });
  const pending = manager.consultWeb(child.childId, 'Check the original rule');
  assert.ok(request.isCurrent());
  manager.syncNativeInput('r1', webTaskInput('Corrected version'));
  assert.equal(request.signal.aborted, true);
  assert.equal(request.isCurrent(), false);
  late.resolve({ consultationId: 'late', markdown: 'Old advice', provider: 'manual' });
  assert.deepEqual(await pending, { status: 'unavailable', code: 'CHILD_CONSULTATION_CANCELLED' });
  assert.equal(store.eventsByKind('r1', 'web_consultation_received').length, 0);
});

test('native worker can accept a submitted prerequisite while its dependant is queued', async t => {
  const {manager,root,backend}=fixture(t);let lifecycle;
  const ticket={id:'t1',title:'dependency',assignments:[{id:'a1'}]};
  const bridge={compatibility(){return {apiVersion:2};},snapshot(){return {masterSessionId:'main',tickets:[{ticket,workerSessionId:root.id,assignmentId:'a1'}]};},registerLifecycle(value){lifecycle=value;return ()=>{};}};
  const connection=connectSuperagent(manager,bridge);t.after(()=>connection.dispose());lifecycle.bindWorker(ticket,root.id);
  lifecycle.bindWorker(ticket,root.id);
  assert.equal(manager.store.eventsByKind('super-t1-a1','agent_relation').length,1);
  assert.equal(manager.binding(root.id).parentId,null,'visual topology must not change execution authority');
  const first=await manager.delegate(root,{objective:'produce prerequisite'});
  const second=await manager.delegate(root,{objective:'check accepted prerequisite',dependsOn:[first.workItemId]});
  manager.publish(first.childId,{result:{value:7},final:true});await backend.complete(first.childId);
  await assert.rejects(manager.delegate(root,{objective:'premature dependent review',dependsOn:[first.workItemId]}),{code:'DEPENDENCY_ASSESSMENT_REQUIRED'});
  assert.equal(backend.started.length,1);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1000);
  try{await assert.doesNotReject(connection.beforeRequest(root.id,controller.signal));}finally{clearTimeout(timer);}
  assert.equal(backend.started.length,1,'opening parent request must not bypass acceptance');
  manager.accept(root.id,{workItemId:first.workItemId,accepted:true,reason:'checked source'});
  await tick();await tick();assert.ok(backend.started.some(x=>x.childId===second.childId));
});

test('source tables remain exact, scoped and version-bound while host computation avoids copied rows', async t => {
  const {manager,root,store,backend}=fixture(t);
  const rows=Array.from({length:80},(_,i)=>({id:`00${i}`,amount:i,enabled:i%2===0}));
  const raw=JSON.stringify(rows),source='Compute only enabled rows.\n'+raw+'\nDo not deploy.';
  const snapshot=manager.syncNativeInput('r1',inputSnapshot(JSON.stringify({sources:[{id:'s1',text:source}]})));
  assert.equal(snapshot.tables.length,1);
  const table=snapshot.tables[0];
  assert.equal(manager.readArtifact('r1',table.artifactRef).data.toString(),raw);
  assert.equal(Buffer.from(source).subarray(table.startByte,table.endByte).toString(),raw);
  assert.throws(()=>manager.readArtifact('other-run',table.artifactRef));
  const computation={version:'1',inputRef:table.artifactRef,rowsPath:[],filter:[{field:'enabled',op:'eq',value:true}],operations:[{op:'count',as:'count',unit:'rows'},{op:'sum',field:'amount',as:'sum',unit:'integer'}],precision:'safe_integer',nullPolicy:'reject',deduplicate:false};
  const work=await manager.delegate(root,{objective:'Count and sum enabled rows, preserve original source.',inputRefs:[table.artifactRef],computation});
  const receipt=manager.completeComputation(work.childId,{stepId:'final',checkpointStepId:'checkpoint'});assert.ok(receipt);
  const checkpoint=store.eventsByKind('r1','step_result').find(e=>e.stepId==='checkpoint');
  assert.deepEqual(checkpoint.payload.result,{count:40,sum:1560});
  assert.equal(checkpoint.payload.verification.status,'passed');
  const final=store.getEvent(receipt.eventId);
  assert.ok(final.parents.includes(checkpoint.id));
  assert.deepEqual(final.payload.result,checkpoint.payload.result);
  await backend.complete(work.childId);
  const item=store.getWorkItems('r1').find(x=>x.id===work.workItemId);
  assert.equal(item.state,'submitted');
  assert.equal(item.inputVersion,snapshot.version);
  assert.equal(manager.computationReview('r1',work.workItemId),null,'a host receipt does not replace parent acceptance');
  manager.accept(root.id,{workItemId:work.workItemId,accepted:true,reason:'checked filter and source'});
  const proof=manager.computationReview('r1',work.workItemId);
  assert.deepEqual(proof.result,{count:40,sum:1560});
  assert.equal(proof.source.inputVersion,snapshot.version);
  assert.deepEqual(proof.contract.filter,computation.filter);
  const acceptedItem=store.getWorkItems('r1').find(x=>x.id===work.workItemId);
  store.saveWorkItem({...acceptedItem,computation:{...acceptedItem.computation,filter:[]}});
  assert.throws(()=>manager.computationReview('r1',work.workItemId),/immutable computation contract/);
  store.saveWorkItem(acceptedItem);
  manager.syncNativeInput('r1',inputSnapshot(JSON.stringify({sources:[{id:'s1',text:'Replacement input; no table remains.'}]})));
  assert.equal(manager.computationReview('r1',work.workItemId),null,'stale verification must not appear as current proof');
  assert.throws(()=>manager.nativeInputs.resolve('r1',table.artifactRef,{currentOnly:true}),/Stale/);
  assert.equal(manager.readArtifact('r1',table.artifactRef).data.toString(),raw);
});

test('whole-task shorthand binds full current input while narrow delegations remain explicit', async t => {
  const { manager, root, store, backend } = fixture(t);
  assert.equal(manager.isToolAvailable(root.id,'collab_delegate_task'),false);
  await assert.rejects(manager.delegate(root,{wholeTask:true}),/requires a current native/);
  await assert.rejects(manager.delegate(root,{}),/Objective required/);
  const input=manager.syncNativeInput('r1',inputSnapshot('all sources, corrections and constraints'));
  assert.equal(manager.isToolAvailable(root.id,'collab_delegate_task'),true);
  await assert.rejects(manager.delegate(root,{wholeTask:true,objective:'ambiguous'}),/not both/);
  const work=await manager.delegate(root,{wholeTask:true,role:'implementer'});
  assert.equal(manager.isToolAvailable(work.childId,'collab_delegate_task'),false);
  const item=store.getWorkItems('r1').find(x=>x.id===work.workItemId);
  assert.deepEqual(item.inputRefs,[input.artifactRef]);assert.equal(item.inputVersion,input.version);
  assert.match(backend.started[0].prompt,/later corrections and constraints/);
  assert.match(backend.started[0].prompt,/exact requested output format/);
  manager.publish(work.childId,{result:{done:true},final:true});await backend.complete(work.childId);
  assert.equal(store.getWorkItems('r1')[0].state,'submitted');
});

test('assigned source sections stay isolated in the prompt, evidence access and step history', async t => {
  const { manager, root, store, backend } = fixture(t);
  const west = '## 西区\r\n数量 -7，编号 007\r\n~~~txt\r\n## 这是代码内容\r\n~~~\r\n';
  const east = '## 东区\r\n另一份材料，编号 009\r\n';
  const source = '通用规则：保留前导零\r\n' + west + east;
  const snapshot = manager.syncNativeInput('r1', inputSnapshot(JSON.stringify({ sources: [{ id: 'request', text: source }] })));
  assert.deepEqual(snapshot.sections.map(section => section.title), ['西区', '东区']);
  const [first, second] = snapshot.sections;
  const exactBytes = Buffer.from(source).subarray(first.startByte, first.endByte);
  assert.equal(exactBytes.toString(), west);
  assert.match(manager.nativeInputs.hint('r1'), /Source sections/);
  await assert.rejects(manager.delegate(root, { objective: 'read all', evidenceScope: 'assigned', inputRefs: [snapshot.handle] }), /individual source artifacts/);

  const one = await manager.delegate(root, { objective: 'Check West, preserve leading zeros', evidenceScope: 'assigned', inputRefs: [first.artifactRef] });
  const two = await manager.delegate(root, { objective: 'Check East, preserve leading zeros', evidenceScope: 'assigned', inputRefs: [second.artifactRef] });
  assert.ok(backend.started[0].prompt.includes(JSON.stringify(west)));
  assert.ok(!backend.started[0].prompt.includes(second.artifactRef));
  assert.ok(!backend.started[0].prompt.includes(snapshot.handle));
  assert.deepEqual(manager.readArtifact('r1', first.artifactRef, {}, one.childId).data, exactBytes);
  assert.throws(() => manager.readArtifact('r1', second.artifactRef, {}, one.childId), { code: 'FORBIDDEN' });
  assert.throws(() => manager.readArtifact('r1', snapshot.handle, {}, one.childId), { code: 'FORBIDDEN' });
  await assert.rejects(manager.send(root.id, { targetId: two.childId, result: { extra: west } }), { code: 'FORBIDDEN' });
  assert.equal(manager.isToolAvailable(two.childId, 'collab_send'), false);
  assert.match(manager.canUseTool(two.childId, 'read'), /assigned evidence/);
  const event = manager.publish(one.childId, { stepId: 'regional-result', result: { id: '007' }, final: true });
  assert.equal(manager.inspect('r1', 'regional-result', { eventId: event.eventId }, two.childId).status, 'not_found');
  await backend.complete(one.childId);
  assert.deepEqual(manager.inspect('r1', 'regional-result', { eventId: event.eventId }, root.id).event.payload.result, { id: '007' });
  assert.ok(store.eventsByKind('r1', 'agent_message').some(entry => entry.payload.recipient === root.id));

  manager.syncNativeInput('r1', inputSnapshot(JSON.stringify({ sources: [{ id: 'updated', text: source.replace('007', '008') }] })));
  await assert.rejects(manager.delegate(root, { objective: 'Use the outdated West', evidenceScope: 'assigned', inputRefs: [first.artifactRef] }), /Stale input version/);
  assert.equal(manager.readArtifact('r1', first.artifactRef).data.toString(), west);
});

test('independent section results notify once and keep each exact assessment replayable', async t => {
  const { manager, store, root, backend } = fixture(t, { groupSectionResults: true, maxActiveChildren: 2 });
  const source = 'Choose the ID in every section.\n## West\nID 007\n## East\nID 009\n## North\nID 012\n## South\nID 024';
  const input = manager.syncNativeInput('r1', webTaskInput(source, false));
  const args = { input: input.handle, sections: ['s1', 's2', 's3', 's4'], objective: 'Read the assigned ID.' };
  const { batchId, workItems, waiting } = await manager.delegateSections(root, args);
  assert.ok(batchId && waiting);
  assert.equal(manager.isAwaitingSectionBatch(root.id, 'r1'), true);
  assert.equal(manager.isAwaitingSectionBatch(root.id, 'stale-assignment'), false);
  assert.throws(() => manager.acceptSections(root.id, { batchId, reviews: [
    { section: 's1', accepted: true, reason: 'Unseen result' }] }), { code: 'STALE_RESULT' });
  const deliver = backend.deliver;
  backend.deliver = input => {
    assert.equal(store.getMessage(input.messageId).status, 'queued');
    assert.equal(manager.isAwaitingSectionBatch(root.id, 'r1'), true, 'The worker is still waiting during the commit-to-inbox window');
    return deliver(input);
  };
  assert.equal(backend.started.length, 2);
  assert.equal((await manager.delegateSections(root, args)).batchId, undefined, 'No second seal for reused attempts');
  assert.equal(store.eventsByKind('r1', 'section_batch_planned').length, 1);
  const ids = ['007', '009', '012', '024'];
  const published = [];
  for (const [index, planned] of workItems.entries()) {
    const started = store.getWorkItems('r1').find(item => item.id === planned.workItemId);
    assert.equal(manager.isToolAvailable(started.childId, 'collab_accept_sections'), false);
    published.push(manager.publish(started.childId, { stepId: `id-${index}`, result: { id: ids[index] }, final: true }).eventId);
    await backend.complete(started.childId);
    assert.equal(backend.deliveries.length, index === workItems.length - 1 ? 1 : 0);
  }
  assert.equal(backend.started.length, 4);
  const [notification] = store.eventsByKind('r1', 'agent_message');
  assert.deepEqual(notification.parents, [batchId, ...published]);
  assert.deepEqual(notification.payload.result.results.map(row => row.result.id), ids);
  assert.ok(backend.deliveries[0].text.includes('section_batch_results'));
  assert.equal(manager.isAwaitingSectionBatch(root.id, 'r1'), true, 'Hold until the reply has entered a model request');
  store.markDelivery(`${batchId}-results`, 'included_in_request');
  assert.equal(manager.isAwaitingSectionBatch(root.id, 'r1'), false);
  const reviews = workItems.map(({ workItemId }, index) => ({
    workItemId, eventId: published[index], accepted: index !== 1, reason: 'Compared the reported ID with the assigned section.',
  }));
  assert.throws(() => manager.acceptSections(root.id, { batchId, reviews: [
    ...reviews.slice(0, -1), { ...reviews.at(-1), eventId: published[0] },
  ] }), { code: 'STALE_RESULT' });
  assert.equal(store.eventsByKind('r1', 'result_assessment').length, 0, 'Validate all assessments before persisting the first');
  const accepted = manager.acceptSections(root.id, { batchId, reviews }).assessments;
  assert.deepEqual(accepted.map(review => review.state), ['succeeded', 'rejected', 'succeeded', 'succeeded']);
  const replay = manager.acceptSections(root.id, { batchId, reviews }).assessments;
  assert.deepEqual(replay.map(review => review.eventId), accepted.map(review => review.eventId));
  assert.equal(store.eventsByKind('r1', 'result_assessment').length, 4);
  assert.equal(await manager.resumeSectionResults(root.id), false);
  assert.equal(backend.deliveries.length, 1, 'Recovery does not duplicate the persisted batch reply');
  manager.syncNativeInput('r1', webTaskInput(source.replace('007', '008'), false));
  assert.throws(() => manager.acceptSections(root.id, { batchId, reviews }), { code: 'STALE_INPUT' });
});

test('grouped section results fall back early for failure or human attention', async t => {
  const { manager, store, root, backend } = fixture(t, { groupSectionResults: true, maxActiveChildren: 2 });
  const source = 'Read each independent ID.\n## West\nID 007\n## East\nID 009\n## North\nID 012';
  const input = manager.syncNativeInput('r1', webTaskInput(source, false));
  const { batchId } = await manager.delegateSections(root, { input: input.handle, sections: ['s1', 's2', 's3'], objective: 'Find the ID.' });
  const [first, second] = backend.started;
  manager.publish(first.childId, { stepId: 'id', result: { id: '007' }, final: true });
  await backend.complete(first.childId);
  assert.equal(backend.deliveries.length, 0);
  manager.hud.accept('r1', { kind: 'attention.raised', agentId: root.id, attentionId: 'approval:check', at: new Date().toISOString() });
  assert.equal(manager.isAwaitingSectionBatch(root.id, 'r1'), false);
  assert.equal(await manager.resumeSectionResults(root.id), true, 'A parent with a human reply may proceed while children remain active');
  assert.equal(backend.deliveries.length, 1, 'Release the already settled result for an interrupted batch');
  manager.hud.accept('r1', { kind: 'attention.resolved', agentId: root.id, attentionId: 'approval:check', at: new Date().toISOString() });
  await backend.complete(second.childId, { stopReason: 'error', output: [] });
  assert.equal(manager.isAwaitingSectionBatch(root.id, 'r1'), false);
  assert.equal(backend.deliveries.length, 2, 'Surface the failure before the last child finishes');
  const third = backend.started[2];
  manager.publish(third.childId, { stepId: 'id', result: { id: '012' }, final: true });
  await backend.complete(third.childId);
  assert.equal(backend.deliveries.length, 3);
  assert.equal(store.getMessage(`${batchId}-results`), null, 'A degraded batch stays in individual delivery mode');
});

test('batch delegation saves each exact section, delivers results, and reuses identical requests', async t => {
  const { manager, root, store, backend } = fixture(t, { maxActiveChildren: 1 });
  const west = '## 西区\r\n编号 007\r\n';
  const east = '## 东区\r\n编号 009\r\n';
  const source = '通用规则\r\n' + west + east;
  const input = manager.syncNativeInput('r1', inputSnapshot(JSON.stringify({ sources: [{ id: 'request', text: source }] })));
  const selectionRule = 'Preserve leading zeros. Copy the matching identifier exactly as it appears in the original section, keep the distinct source and version, and use an empty result if the documented conditions are not met.';
  const args = { input: input.handle, sections: ['s1', '东区', '西区'], objective: 'Find the ID', rules: [selectionRule] };
  assert.equal(manager.isToolAvailable(root.id, 'collab_delegate_sections'), true);

  await assert.rejects(manager.delegateSections(root, { ...args, rules: ['x'.repeat(241)] }), { code: 'INVALID_ARGUMENT' });
  assert.equal(store.eventsByKind('r1', 'work_planned').length, 0);
  const initial = await manager.delegateSections(root, args);
  assert.deepEqual(initial.workItems.map(item => [item.section, item.state]), [['s1', 'running'], ['s2', 'ready']]);
  const planned = store.eventsByKind('r1', 'work_planned');
  assert.equal(planned.length, 2);
  assert.ok(planned[1].runSeq < store.eventsByKind('r1', 'delegation_input')[0].runSeq);
  for (const [index, event] of planned.entries()) {
    const { title, artifactRef, startByte, endByte } = input.sections[index];
    assert.equal(event.payload.inputVersion, input.version);
    assert.equal(event.payload.evidenceScope, 'assigned');
    assert.deepEqual(event.payload.inputRefs, [artifactRef]);
    assert.deepEqual(event.payload.sectionDispatch, { selector: `s${index + 1}`, title, sourceId: 'request', startByte, endByte });
  }
  const [first, second] = planned.map(event => event.payload);
  assert.equal(manager.isToolAvailable(first.childId, 'collab_delegate_sections'), false);
  assert.ok(backend.started[0].prompt.includes(JSON.stringify(west)));
  assert.match(backend.started[0].prompt, /Preserve leading zeros/);
  assert.ok(!backend.started[0].prompt.includes(second.inputRefs[0]));
  assert.throws(() => manager.readArtifact('r1', input.handle, {}, first.childId), { code: 'FORBIDDEN' });

  const duplicate = await manager.delegateSections(root, { ...args, sections: ['s2', 's1'] });
  assert.deepEqual(duplicate.workItems.map(item => [item.workItemId, item.reused]), [[second.id, true], [first.id, true]]);
  assert.equal(backend.started.length, 1);
  const result = manager.publish(first.childId, { stepId: 'first-section', result: { id: '007' }, final: true });
  await backend.complete(first.childId);
  assert.equal(backend.started.length, 2);
  assert.deepEqual(manager.inspect('r1', 'first-section', { eventId: result.eventId }, root.id).event.payload.result, { id: '007' });
  assert.ok(backend.deliveries.some(delivery => delivery.recipientId === root.id));

  await assert.rejects(manager.delegateSections(root, { ...args, retries: [{ section: 's2', workItemId: first.id }] }), { code: 'INVALID_SECTION' });
  assert.equal(backend.started.length, 2);
  const corrected = manager.syncNativeInput('r1', inputSnapshot(JSON.stringify({ sources: [{ id: 'request', text: '保留前导零\r\n' + east + west.replace('007', '008') }] })));
  const revised = { ...args, input: corrected.handle, sections: ['s2', 's1'], retries: [
    { section: 's2', workItemId: first.id }, { section: 's1', workItemId: second.id },
  ] };
  await assert.rejects(manager.delegateSections(root, { ...revised, retries: [revised.retries[0], { section: 's1', workItemId: first.id }] }), { code: 'INVALID_ARGUMENT' });
  assert.equal(backend.started.length, 2);
  const replacements = await manager.delegateSections(root, revised);
  assert.deepEqual(replacements.workItems.map(item => item.workItemId), [first.id, second.id]);
  assert.equal(backend.started.length, 3);
  const retryEvents = store.eventsByKind('r1', 'work_planned').slice(2);
  assert.deepEqual(retryEvents.map(event => event.payload.retryOfAttemptId), [first.attemptId, second.attemptId]);
  assert.ok(retryEvents.every(event => event.payload.retryReason === 'input_changed'));
  const replay = await manager.delegateSections(root, revised);
  assert.ok(replay.workItems.every(item => item.reused));
  assert.equal(store.eventsByKind('r1', 'work_planned').length, 4);
  assert.equal(backend.started.length, 3);
  assert.deepEqual(manager.inspect('r1', 'first-section', { eventId: result.eventId }, root.id).event.payload.result, { id: '007' });
});

test('batch delegation rejects stale or ambiguous selectors before any child starts', async t => {
  const { manager, root, store, backend } = fixture(t);
  const sections = text => inputSnapshot(JSON.stringify({ sources: [{ id: 'request', text }] }));
  const first = manager.syncNativeInput('r1', sections('Rules\n## Same\nFirst\n## Same\nSecond\n'));
  const args = { input: first.handle, sections: ['s1', 'Same'], objective: 'Read both', rules: [] };
  await assert.rejects(manager.delegateSections(root, args), { code: 'INVALID_SECTION' });
  await assert.rejects(manager.delegateSections(root, { ...args, sections: ['s1', 's3'] }), { code: 'INVALID_SECTION' });
  await assert.rejects(manager.delegateSections(root, { ...args, sections: ['s1'], rules: ['a', 'b', 'c', 'd', 'e'] }), { code: 'INVALID_ARGUMENT' });
  manager.syncNativeInput('r1', sections('New rules\n## Same\nFirst\n## Same\nSecond\n'));
  await assert.rejects(manager.delegateSections(root, { ...args, sections: ['s1', 's2'] }), { code: 'STALE_INPUT' });
  assert.equal(store.getWorkItems('r1').length, 0);
  assert.equal(backend.started.length, 0);
});

test('repeated native delegation and assessment reuse recorded work without launching duplicate children', async t => {
  const { manager, root, store, backend } = fixture(t);
  manager.syncNativeInput('r1', inputSnapshot('Find record 007.'));
  const request = { wholeTask: true, role: 'reviewer' };
  const [work, duplicate] = await Promise.all([manager.delegate(root, request), manager.delegate(root, request)]);
  assert.equal(duplicate.workItemId, work.workItemId);
  assert.equal(duplicate.reused, true);
  assert.equal(backend.started.length, 1);
  assert.equal(store.eventsByKind('r1', 'work_planned').length, 1);

  await backend.complete(work.childId);
  const failed = await manager.delegate(root, request);
  assert.equal(failed.workItemId, work.workItemId);
  assert.equal(failed.state, 'failed', 'an ordinary reply is not a structured whole-task result');
  assert.match(failed.nextAction, /retryOf/);
  assert.equal(backend.started.length, 1);
  const retry = await manager.delegate(root, { ...request, retryOf: work.workItemId });
  assert.equal(retry.workItemId, work.workItemId);
  assert.notEqual(retry.childId, work.childId);
  const result = manager.publish(retry.childId, { result: { id: '007' }, final: true });
  await backend.complete(retry.childId);
  const submitted = await manager.delegate(root, request);
  assert.equal(submitted.eventId, result.eventId);
  assert.throws(() => manager.acceptedWholeTaskResult(root.id, retry.workItemId), { code: 'RESULT_NOT_READY' });
  const decision = { workItemId: retry.workItemId, accepted: true, reason: 'Verified exact string from source' };
  const accepted = manager.accept(root.id, decision);
  assert.match(accepted.nextAction, /orchestrator_report/);
  assert.deepEqual(manager.acceptedWholeTaskResult(root.id, retry.workItemId), { id: '007' });
  assert.throws(() => manager.acceptedWholeTaskResult(retry.childId, retry.workItemId), { code: 'FORBIDDEN' });
  assert.equal(manager.accept(root.id, decision).eventId, accepted.eventId);
  assert.throws(() => manager.accept(root.id, { ...decision, accepted: false }), /is succeeded/);
  assert.equal(store.eventsByKind('r1', 'result_assessment').length, 1);

  const first = await manager.delegate(root, { objective: 'Check the units in the source', role: 'reviewer' });
  const repeated = await manager.delegate(root, { objective: 'Check the units in the source', role: 'reviewer' });
  assert.equal(repeated.workItemId, first.workItemId);
  const distinct = await manager.delegate(root, { objective: 'Check whether the record is current', role: 'reviewer' });
  assert.notEqual(distinct.workItemId, first.workItemId);
  manager.publish(first.childId, { result: { id: '007' }, final: true });
  await backend.complete(first.childId);
  manager.accept(root.id, { workItemId: first.workItemId, accepted: true, reason: 'Checked the units only' });
  assert.throws(() => manager.acceptedWholeTaskResult(root.id, first.workItemId), { code: 'RESULT_NOT_READY' });
  manager.syncNativeInput('r1', inputSnapshot('Find record 008 instead.'));
  assert.throws(() => manager.acceptedWholeTaskResult(root.id, retry.workItemId), { code: 'RESULT_NOT_READY' });
});

test('an unused failed supplemental review can be discarded without weakening required work', async t => {
  const { manager, root, backend, store } = fixture(t);
  const ticket = { id: 't1', title: 'fixture', assignments: [{ id: 'a1' }] };
  let lifecycle;
  const bridge = {
    compatibility: () => ({ apiVersion: 3 }),
    snapshot: () => ({ masterSessionId: 'main', tickets: [{ ticket, workerSessionId: root.id, assignmentId: 'a1' }] }),
    inputSnapshot: () => inputSnapshot('Input at the current version'),
    registerLifecycle(value) { lifecycle = value; return () => {}; },
  };
  const connection = connectSuperagent(manager, bridge);
  t.after(() => connection.dispose());
  const { runId } = lifecycle.bindWorker(ticket, root.id);
  const whole = await manager.delegate(root, { wholeTask: true });
  manager.publish(whole.childId, { result: { id: '007' }, final: true });
  await backend.complete(whole.childId);
  const discard = workItemId => manager.accept(root.id, { workItemId, accepted: false, discard: true, reason: 'Supplemental review was unused' });
  assert.throws(() => discard(whole.workItemId), { code: 'CANNOT_DISCARD_WORK' });
  manager.accept(root.id, { workItemId: whole.workItemId, accepted: true, reason: 'Checked against the source' });
  const review = await manager.delegate(root, { objective: 'Try a second check', role: 'reviewer' });
  assert.throws(() => discard(review.workItemId), { code: 'CANNOT_DISCARD_WORK' });
  await backend.complete(review.childId, { stopReason: 'error', output: [], diagnostic: 'model limit' });
  assert.throws(() => lifecycle.beforeReady(ticket), /"state":"failed"/);
  assert.throws(() => manager.accept(root.id, { workItemId: review.workItemId, accepted: false, reason: 'failed' }), /is failed/);
  const discarded = discard(review.workItemId);
  assert.equal(discarded.discarded, true);
  assert.equal(discard(review.workItemId).eventId, discarded.eventId);
  assert.equal(store.getEvent(discarded.eventId).payload.previousState, 'failed');
  assert.equal(lifecycle.reviewState(ticket).items.find(item => item.id === review.workItemId).discarded, true);
  assert.doesNotThrow(() => lifecycle.beforeReady(ticket));

  const required = await manager.delegate(root, { objective: 'Review the scope', role: 'reviewer' });
  await manager.delegate(root, { objective: 'Use that review', dependsOn: [required.workItemId] });
  await backend.complete(required.childId, { stopReason: 'error', output: [] });
  assert.throws(() => discard(required.workItemId), { code: 'CANNOT_DISCARD_WORK' });
  assert.throws(() => lifecycle.beforeReady(ticket), /Resolve the listed child work/);
});

test('native ready gate instructs retryOf for invalidated work and opens only after the new parent assessment', async t => {
  const { manager, root, backend } = fixture(t);
  let text='v1', lifecycle;
  const ticket={id:'t1',title:'fixture',assignments:[{id:'a1'}]};
  const bridge={compatibility(){return {apiVersion:3};},snapshot(){return {masterSessionId:'main',tickets:[{ticket,workerSessionId:root.id,assignmentId:'a1'}]};},inputSnapshot(){return inputSnapshot(text);},registerLifecycle(value){lifecycle=value;return ()=>{};}};
  const connection=connectSuperagent(manager,bridge);t.after(()=>connection.dispose());
  lifecycle.bindWorker(ticket,root.id);
  const work=await manager.delegate(root,{objective:'verify current task'});
  text='v2';connection.assertSession(root.id);
  assert.throws(()=>lifecycle.beforeReady(ticket),/Retry each listed work item.*retryOf/);
  await tick();await tick();
  const retry=await manager.delegate(root,{objective:'verify corrected task',retryOf:work.workItemId});
  manager.publish(retry.childId,{result:{version:2},final:true});await backend.complete(retry.childId);
  assert.throws(()=>lifecycle.beforeReady(ticket),/Resolve the listed child work.*"state":"submitted"/);
  manager.accept(root.id,{workItemId:retry.workItemId,accepted:true,reason:'compared with v2'});
  assert.doesNotThrow(()=>lifecycle.beforeReady(ticket));
});

test('native input handles survive reopening, reject wrong scope and preserve historical bytes', async t => {
  const { manager, store, stateDir } = fixture(t);
  const first = manager.syncNativeInput('r1', inputSnapshot('complete input 001 不得部署'));
  assert.equal(manager.readArtifact('r1', first.handle).data.toString(), 'complete input 001 不得部署');
  assert.equal(manager.syncNativeInput('r1', inputSnapshot('complete input 001 不得部署')).handle, first.handle);
  const reopened = new CollaborationStore({ stateDir });
  try { assert.deepEqual(new NativeInputs(reopened).current('r1'), first); } finally { reopened.close(); }
  const second = manager.syncNativeInput('r1', inputSnapshot('complete input 002 用户更正'));
  assert.notEqual(first.handle, second.handle);
  assert.equal(manager.readArtifact('r1', first.handle).data.toString(), 'complete input 001 不得部署');
  assert.throws(() => manager.nativeInputs.resolve('r1', first.handle, { currentOnly: true }), /Stale/);
  manager.bindRoot('other', { runId: 'r2' });
  assert.throws(() => manager.readArtifact('r2', first.handle), /Unknown input handle/);
  manager.publish('other', { result: { guessedArtifact: first.artifactRef, nested: { artifactRef: first.artifactRef } } });
  assert.throws(() => manager.readArtifact('r2', first.artifactRef), /not referenced by this run/);
  assert.throws(() => manager.readArtifact('r1', 'trigger/one'), /native resource paths/);
  assert.throws(() => manager.readArtifact('r1', 'input:invented'), /Unknown input/);
  assert.equal(store.eventsByKind('r1', 'input_snapshot').length, 2);
});

test('new inputs invalidate accepted and running children; retries bind current input and late output cannot overwrite', async t => {
  const { manager, store, root, backend } = fixture(t);
  const first = manager.syncNativeInput('r1', inputSnapshot('v1'));
  const done = await manager.delegate(root, { objective: 'verify', inputRefs: [first.handle] });
  manager.publish(done.childId, { result: { version: 1 }, final: true }); await backend.complete(done.childId);
  manager.accept(root.id, { workItemId: done.workItemId, accepted: true, reason: 'checked v1' });
  const running = await manager.delegate(root, { objective: 'still working' });
  const second = manager.syncNativeInput('r1', inputSnapshot('v2'));
  assert.throws(() => manager.accept(root.id, { workItemId: done.workItemId, accepted: true, reason: 'reuse' }), /earlier task input.*collab_delegate with retryOf=/);
  assert.ok(manager.nativeInputs.hint('r1').includes(JSON.stringify({ retryOf: done.workItemId })));
  assert.throws(() => manager.publish(running.childId, { result: {}, final: true }), /Task inputs changed/);
  await tick(); await tick();
  const retry = await manager.delegate(root, { objective: 'verify latest', retryOf: done.workItemId });
  const accounting = manager.describeRun('r1').accounting;
  assert.equal(accounting.rework.retries, 1);
  assert.equal(accounting.rework.reasons.input_changed, 1);
  assert.equal(store.getWorkItems('r1').find(x => x.id === done.workItemId).inputVersion, second.version);
  assert.ok(store.getWorkItems('r1').find(x => x.id === done.workItemId).inputRefs.includes(second.artifactRef));
  assert.throws(() => manager.publish(done.childId, { result: {}, final: true }), /Old activation/);
  manager.publish(retry.childId, { result: { version: 2 }, final: true }); await backend.complete(retry.childId);
  manager.accept(root.id, { workItemId: retry.workItemId, accepted: true, reason: 'checked v2' });
  assert.equal(store.getWorkItems('r1').find(x => x.id === retry.workItemId).state, 'succeeded');
  assert.equal(store.getWorkItems('r1').find(x => x.id === running.workItemId).state, 'rejected');
  assert.equal(store.eventsByKind('r1', 'result_assessment').length, 2);
  assert.equal(store.eventsByKind('r1', 'activation_settled').find(x => x.attemptId === running.attemptId).payload.stale, true);
});

test('explicit evidence relay supplies the unchanged original artifact and still requires parent assessment',async t=>{
 const {manager,root,backend,store}=fixture(t,{explicitEvidenceRefs:true});
 const work=await manager.delegate(root,{objective:'review source',workItemId:'refs'});
 const published=manager.publish(work.childId,{stepId:'result',result,final:true});await backend.complete(work.childId);
 const delivered=store.listEvents('r1').find(e=>e.kind==='agent_message').payload.result;
 assert.deepEqual(delivered.evidenceRefs,[published.artifactRef]);assert.deepEqual(delivered.result,result);
 assert.equal(delivered.stepId,'result');assert.equal(delivered.attemptId,work.attemptId);
 const history=manager.inspect('r1',delivered.stepId,{eventId:delivered.eventId,attemptId:delivered.attemptId});
 assert.equal(history.status,'ok');assert.deepEqual(history.event.payload.result,result);
 manager.publish(root.id,{stepId:'parent-review',result:{reviewed:true},parents:[delivered.eventId]});
 assert.deepEqual(JSON.parse(manager.readArtifact('r1',delivered.evidenceRefs[0]).data.toString()),result);
 assert.equal(store.getWorkItems('r1')[0].state,'submitted');
 assert.throws(()=>manager.accept(root.id,{workItemId:work.workItemId,accepted:true,reason:'bad id',evidenceRefs:[published.eventId]}));
 assert.equal(store.getWorkItems('r1')[0].state,'submitted');
 assert.equal(manager.accept(root.id,{workItemId:work.workItemId,accepted:false,reason:'reject incorrect outcome',evidenceRefs:delivered.evidenceRefs}).state,'rejected');
});

test('explicit fallback evidence refers to raw settlement without claiming a verified result',async t=>{
 const {manager,root,backend,store}=fixture(t,{explicitEvidenceRefs:true});
 const work=await manager.delegate(root,{objective:'review source'});await backend.complete(work.childId);
 const delivered=store.listEvents('r1').find(e=>e.kind==='agent_message').payload.result;
 assert.equal(delivered.result.outcome,'inconclusive');
 assert.equal(delivered.evidenceRefs[0],delivered.result.raw_ref);
 assert.equal(manager.inspect('r1',delivered.stepId,{eventId:delivered.eventId,attemptId:delivered.attemptId}).event.kind,'activation_settled');
 assert.equal(JSON.parse(manager.readArtifact('r1',delivered.evidenceRefs[0]).data.toString()).stopReason,'completed');
 assert.equal(store.getWorkItems('r1')[0].state,'submitted');
});

test('delegate publishes one structured final and settles with one compact parent delivery',async t=>{
  const {manager,root,backend,store}=fixture(t);
  const work=await manager.delegate(root,{objective:'复现到期边界',role:'tester',workItemId:'test-boundary'});
  assert.equal(work.state,'running');assert.equal(backend.started.length,1);assert.match(backend.started[0].prompt,/Publish the complete assigned result once/);
  const published=manager.publish(work.childId,{stepId:'s7',result,final:true});
  assert.equal(published.submitted,true);
  assert.throws(()=>manager.publish(work.childId,{stepId:'s7',result,final:true}),{code:'ALREADY_SUBMITTED'});
  await backend.complete(work.childId);
  assert.equal(store.getWorkItems('r1')[0].state,'submitted');
  assert.equal(backend.deliveries.length,1);assert.equal(backend.deliveries[0].recipientId,root.id);
  assert.equal(store.listOutbox({states:['inbox_persisted']}).length,1);
  assert.equal(store.listEvents('r1').filter(e=>e.kind==='final_result').length,1);
  assert.equal(manager.lastError,undefined);
  await manager.settle(work.childId,{stopReason:'completed',output:[{type:'text',text:'重复回调'}]});
  assert.equal(backend.deliveries.length,1,'duplicate completion must not deliver twice');
  assert.equal(store.listEvents('r1').filter(e=>e.kind==='activation_settled').length,1);
});

test('completed child stays submitted until coordinator records acceptance',async t=>{
  const {manager,root,backend,store}=fixture(t);const w=await manager.delegate(root,{objective:'研究',workItemId:'research'});
  manager.publish(w.childId,{result:{outcome:'passed',summary:'资料整理完成'},final:true});await backend.complete(w.childId);
  assert.equal(store.getWorkItems('r1')[0].state,'submitted');
  assert.throws(()=>manager.accept(w.childId,{workItemId:w.workItemId,accepted:true,reason:'self accept'}),{code:'FORBIDDEN'});
  assert.equal(manager.accept(root.id,{workItemId:w.workItemId,accepted:true,reason:'已核对原始证据'}).state,'succeeded');
  assert.equal(store.getWorkItems('r1')[0].state,'succeeded');
});

test('dependency waits for explicit successful acceptance, not merely completion',async t=>{
  const {manager,root,backend,store}=fixture(t);
  const first=await manager.delegate(root,{objective:'收集证据',workItemId:'first'});
  const next=await manager.delegate(root,{objective:'审查证据',role:'reviewer',workItemId:'next',dependsOn:['first']});
  assert.equal(next.state,'ready');assert.equal(backend.started.length,1);
  manager.publish(first.childId,{result:{summary:'ready'},final:true});await backend.complete(first.childId);
  assert.equal(backend.started.length,1);
  manager.accept(root.id,{workItemId:'first',accepted:true,reason:'evidence verified'});await tick();
  assert.equal(backend.started.length,2);assert.equal(store.getWorkItems('r1').find(w=>w.id==='next').state,'running');
});

test('single-writer dispatch serializes implementer/tester while allowing read role',async t=>{
  const {manager,root,backend}=fixture(t,{maxActiveChildren:3});
  const writer=await manager.delegate(root,{objective:'实现',role:'implementer',workItemId:'write'});
  const tester=await manager.delegate(root,{objective:'测试',role:'tester',workItemId:'test'});
  const reader=await manager.delegate(root,{objective:'研究',role:'researcher',workItemId:'read'});
  assert.equal(writer.state,'running');assert.equal(tester.state,'ready');assert.equal(reader.state,'running');assert.equal(backend.started.length,2);
  assert.equal(manager.canUseTool(writer.childId,'write_file'),undefined);
  assert.match(manager.canUseTool(root.id,'write_file'),/writer/);
  assert.match(manager.canUseTool(reader.childId,'pwsh'),/only reads/);
  await backend.complete(writer.childId);assert.equal(backend.started.length,3);
});

test('cross-run communication and evidence reads reject before delivery',async t=>{
  const {manager,root,backend,store}=fixture(t);
  manager.bindRoot('other',{runId:'r2',ticketId:'t2',assignmentId:'a2'});
  await assert.rejects(manager.send(root.id,{targetId:'other',result:{summary:'x'}}),{code:'FORBIDDEN'});
  const e=manager.publish(root.id,{stepId:'s',result:{secret:'only r1'}});
  assert.throws(()=>manager.readArtifact('r2',e.artifactRef),{code:'FORBIDDEN'});
  assert.equal(backend.deliveries.length,0);assert.ok(store.listEvents('r2').every(e=>e.kind==='hud_frame'&&e.payload.input.kind==='agent.register'));
});

test('historical query returns recorded old outcome and does not invoke agents',async t=>{
  const {manager,root,backend}=fixture(t);
  const old=manager.publish(root.id,{stepId:'s7',result});
  manager.publish(root.id,{stepId:'s7',result:{...result,outcome:'passed',summary:'后续修复已通过'}});
  const snapshot=manager.inspect('r1','s7',{eventId:old.eventId});
  assert.equal(snapshot.event.payload.result.outcome,'failed');
  assert.equal(typeof snapshot.chinese,'string');assert.ok(snapshot.chinese.includes('18'));
  assert.equal(backend.started.length,0);assert.equal(backend.deliveries.length,0);
  assert.equal(manager.inspect('r1','missing').status,'not_found');
});

test('old attempt cannot publish into or settle a replacement work attempt',async t=>{
  const {manager,root,backend,store}=fixture(t);
  const old=await manager.delegate(root,{objective:'旧尝试',workItemId:'w1'});
  const item=store.getWorkItems('r1')[0];store.saveWorkItem({...item,attemptId:'new-attempt',epoch:2,state:'ready'});
  assert.throws(()=>manager.publish(old.childId,{stepId:'w1',result,final:true}),{code:'STALE_ATTEMPT'});
  await backend.complete(old.childId);
  const current=store.getWorkItems('r1')[0];assert.equal(current.attemptId,'new-attempt');assert.equal(current.state,'ready');
  assert.equal(store.listEvents('r1').filter(e=>e.kind==='activation_settled')[0].payload.stale,true);
  assert.equal(backend.deliveries.length,0);
});

test('new Assignment may rebind reused root Session; prior child is archived stale',async t=>{
  const {manager,root,backend,store}=fixture(t);
  const old=await manager.delegate(root,{objective:'旧派工',workItemId:'old'});
  const rebind=manager.bindRoot(root.id,{runId:'r2',ticketId:'t1',assignmentId:'a2',assignmentTitle:'修复边界',threadTitle:'其它标题'});
  assert.equal(manager.hud.snapshot('r2').agents[0].label,'修复边界');
  manager.bindRoot(root.id,{runId:'r2',assignmentTitle:'不能随轮次变化'});
  assert.equal(manager.hud.snapshot('r2').agents[0].label,'修复边界');
  assert.equal(rebind.runId,'r2');assert.equal(manager.binding(root.id).runId,'r2');
  await backend.complete(old.childId);
  assert.equal(backend.deliveries.length,0);
  assert.equal(store.listEvents('r1').filter(e=>e.kind==='activation_settled')[0].payload.stale,true);
  assert.ok(store.listEvents('r2').every(e=>e.kind==='hud_frame'&&e.payload.input.kind==='agent.register'));
});

test('parallel admission reservations cannot each spend same remaining budget',async t=>{
  const {manager,root,store}=fixture(t,{maxRunTokens:1000});
  const child=await manager.delegate(root,{objective:'worker'});
  manager.reserveCall(root.id,'call-root',600);
  assert.throws(()=>manager.reserveCall(child.childId,'call-child',500),{code:'TOKEN_BUDGET'});
  store.recordUsage({callId:'call-root',runId:'r1',inputTokens:100,outputTokens:0});
  manager.releaseCall('call-root');manager.pause('r1',false);
  assert.equal(manager.reserveCall(child.childId,'call-child',500).runId,'r1');
  assert.throws(()=>manager.reserveCall(root.id,'negative',-1));
  assert.throws(()=>manager.reserveCall(root.id,'nan',NaN));
  assert.throws(()=>manager.reserveCall(root.id,'call-child',1));
});

test('pause holds new dispatch without disposing a running activation',async t=>{
  const {manager,root,backend,store}=fixture(t);
  const running=await manager.delegate(root,{objective:'running',workItemId:'running'});
  const pause=manager.pause('r1',true);assert.equal(pause.runningOperationsNotFrozen,true);
  const queued=await manager.delegate(root,{objective:'queued',workItemId:'queued'});
  assert.equal(queued.state,'ready');assert.equal(backend.started.length,1);
  assert.equal(backend.active.get(running.childId).handle.disposeCount,0);
  assert.equal(manager.reserveCall(running.childId,'in-flight-continuation',1).runId,'r1');manager.releaseCall('in-flight-continuation');
  manager.publish(running.childId,{result:{summary:'仍可完成'},final:true});await backend.complete(running.childId);
  assert.equal(store.getWorkItems('r1').find(w=>w.id==='running').state,'submitted');assert.equal(backend.started.length,1);
  manager.pause('r1',false);await tick();assert.equal(backend.started.length,2);
});

test('new manager marks prior active work unknown and preserves history',async t=>{
  const {manager,root,store}=fixture(t);
  const work=await manager.delegate(root,{objective:'模拟进程中断',workItemId:'recover'});
  const oldCount=store.listEvents('r1').length;
  const recovered=new CollaborationManager({store});
  assert.equal(store.getWorkItems('r1')[0].state,'unknown');
  assert.equal(store.listEvents('r1').length,oldCount+1);
  assert.equal(store.listEvents('r1').at(-1).kind,'recovery_required');
  assert.equal(recovered.binding(work.childId).runId,'r1');await recovered.close();
});

test('usage view labels unknown calls and does not assert verified savings',t=>{
  const {manager,store}=fixture(t);
  store.recordUsage({callId:'known',runId:'r1',inputTokens:100,outputTokens:10,cachedInputTokens:40});
  store.recordUsage({callId:'unknown',runId:'r1'});
  const usage=manager.describeRun('r1').usage;
  assert.equal(usage.totalTokens,110);assert.equal(usage.unknownCalls,1);assert.equal(usage.complete,false);
  assert.equal(manager.status().capabilities.realModelSavingsVerified,false);
});

test('nested delegation and self-dependencies fail',async t=>{
  const {manager,root}=fixture(t);
  const child=await manager.delegate(root,{objective:'child'});
  await assert.rejects(manager.delegate({id:child.childId},{objective:'grandchild'}),{code:'DEPTH_LIMIT'});
  await assert.rejects(manager.delegate(root,{objective:'cycle',workItemId:'cycle',dependsOn:['cycle']}),{code:'DEPENDENCY_CYCLE'});
});

function seedPaddingEvents(store,runId,count){
  // Bulk fixture insertion uses one SQLite transaction, avoiding 1000 artificial fsync calls.
  const first=store.highWater(runId)+1;
  const insert=store.db.prepare('INSERT INTO events(id,run_id,run_seq,step_id,attempt_id,data) VALUES (?,?,?,?,?,?)');
  store.db.exec('BEGIN IMMEDIATE');
  try{
    for(let i=0;i<count;i++){
      const event={id:`padding-${runId}-${i}`,eventId:`padding-${runId}-${i}`,runId,runSeq:first+i,stepId:'padding',attemptId:'root',kind:'fixture_padding',payload:{n:i},parents:[],inputRefs:[],createdAt:'2026-11-08T00:00:00Z',committedAt:'2026-11-08T00:00:00Z'};
      insert.run(event.id,runId,event.runSeq,event.stepId,event.attemptId,JSON.stringify(event));
    }
    store.db.exec('COMMIT');
  }catch(error){store.db.exec('ROLLBACK');throw error;}
}

test('events after page 1000 remain visible to recovery, artifact scope and settlement dedup',async t=>{
  const {manager,root,store,backend}=fixture(t);
  const work=await manager.delegate(root,{objective:'跨页任务',workItemId:'long-run'});
  seedPaddingEvents(store,'r1',1005);
  const final=manager.publish(work.childId,{stepId:'late-step',result,final:true});await backend.complete(work.childId);
  manager.pause('r1',true,'late-pause');
  assert.equal(manager.describeRun('r1').events.length,store.highWater('r1'));
  assert.deepEqual(JSON.parse(manager.readArtifact('r1',final.artifactRef).data.toString()),result);
  assert.equal(manager.inspect('r1','late-step',{eventId:final.eventId}).event.payload.result.outcome,'failed');
  const recovered=new CollaborationManager({store,backend});
  assert.equal(recovered.held.has('r1'),true,'hold after first page is restored');
  const before=backend.deliveries.length;
  assert.equal((await recovered.settle(work.childId,{stopReason:'completed',output:[]})).duplicate,true);
  assert.equal(backend.deliveries.length,before);
  assert.throws(()=>recovered.publish(work.childId,{result,final:true}),{code:'ALREADY_SUBMITTED'});
  await recovered.close();
});

test('artifact read clamps oversized requested end but retains invalid-start validation',t=>{
  const {manager,root}=fixture(t);
  const saved=manager.publish(root.id,{stepId:'small',result:{text:'短原文'}});
  const full=manager.readArtifact('r1',saved.artifactRef).data;
  assert.deepEqual(manager.readArtifact('r1',saved.artifactRef,{start:0,end:8000}).data,full);
  assert.throws(()=>manager.readArtifact('r1',saved.artifactRef,{start:full.length+1,end:8000}),{code:'INVALID_RANGE'});
});

test('close waits for pending settlement delivery before releasing its caller',async t=>{
  const {manager,root,backend,store}=fixture(t);
  const delivery=deferred();backend.deliver=async input=>{backend.deliveries.push(input);return delivery.promise;};
  const work=await manager.delegate(root,{objective:'等待回传'});manager.publish(work.childId,{result,final:true});
  backend.active.get(work.childId).resolve({stopReason:'completed',output:[]});await tick();
  let finished=false;const closed=manager.close().then(value=>{finished=true;return value;});await tick();
  assert.equal(finished,false);assert.equal(store.listOutbox().length,1);
  delivery.resolve({accepted:true});assert.equal((await closed).drained,true);
  assert.equal(store.listOutbox({states:['inbox_persisted']}).length,1);
});

test('close deadline marks unconfirmed work unknown and late results do not write',async t=>{
  const {manager,root,backend,store}=fixture(t,{closeTimeoutMs:25});
  const work=await manager.delegate(root,{objective:'无法及时中断'});
  backend.active.get(work.childId).handle.dispose=async()=>{}; // Broken/slow backend does not settle result.
  assert.equal((await manager.close()).unknown,true);
  assert.equal(store.getWorkItems('r1')[0].state,'unknown');
  const high=store.highWater('r1');
  backend.active.get(work.childId).resolve({stopReason:'completed',output:[]});await tick();
  assert.equal(store.highWater('r1'),high);assert.equal(backend.deliveries.length,0);
});

test('recovery retains unknown request budgets and partial usage releases only known portion',async t=>{
  const {store,root}=fixture(t,{maxRunTokens:1000});
  store.recordRequest({callId:'partial',runId:'r1',estimate:600,items:[]});
  store.recordUsage({callId:'partial',runId:'r1',inputTokens:200});
  store.recordRequest({callId:'no-response',runId:'r1',estimate:200,items:[]});
  const recovered=new CollaborationManager({store,maxRunTokens:1000});
  assert.equal(recovered.reservations.get('partial').tokens,400);
  assert.equal(recovered.reservations.get('no-response').tokens,200);
  assert.throws(()=>recovered.reserveCall(root.id,'new-call',201),{code:'TOKEN_BUDGET'});
  recovered.releaseCall('partial');assert.equal(recovered.reservations.get('partial').tokens,400);
  store.recordUsage({callId:'partial',runId:'r1',inputTokens:200,outputTokens:100});
  recovered.releaseCall('partial');assert.equal(recovered.reservations.has('partial'),false,'unknown monetary cost does not block settled token reservation');
  assert.equal(recovered.reserveCall(root.id,'new-call',500).runId,'r1');
  await recovered.close();
});

test('a standalone root Session reused by a new Run is not blocked by its old final submission',t=>{
  const {manager,root,store}=fixture(t);
  manager.bindRoot(root.id,{runId:'standalone-old'});
  manager.publish(root.id,{stepId:'final-old',result:{summary:'旧派工完成'},final:true});
  assert.match(manager.canUseTool(root.id,'write_file'),/finish the turn/);
  assert.throws(()=>manager.publish(root.id,{result,final:true}),{code:'ALREADY_SUBMITTED'});
  manager.bindRoot(root.id,{runId:'r2'});
  assert.equal(manager.canUseTool(root.id,'read_file'),undefined);
  assert.equal(manager.publish(root.id,{stepId:'final-new',result:{summary:'新派工完成'},final:true}).runId,'r2');
  assert.equal(store.inspectStep('standalone-old','final-old').event.payload.result.summary,'旧派工完成');
});
