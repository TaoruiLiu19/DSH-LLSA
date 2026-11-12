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
  const manager=new CollaborationManager({store,backend,...options});
  const root={id:'root'};const binding=manager.bindRoot(root.id,{runId:'r1',ticketId:'t1',assignmentId:'a1'});
  t.after(async()=>{
    await manager.close();await tick();await tick();store.close();
    const rel=relative(resolve(tempRoot),resolve(stateDir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    rmSync(stateDir,{recursive:true,force:true});
  });
  return {store,backend,manager,root,binding,stateDir};
}
const result={execution_status:'completed',outcome:'failed',facts:{passed:18,failed:1,exit_code:1},summary:'到期边界测试失败，尚未验证修复。',constraints:['不得部署'],evidence_refs:[]};

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
  assert.throws(()=>lifecycle.beforeReady(ticket),/Accept all/);
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
  assert.equal(work.state,'running');assert.equal(backend.started.length,1);assert.match(backend.started[0].prompt,/not encrypted text/);
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
  assert.throws(()=>manager.accept(w.childId,{workItemId:w.workItemId,accepted:true,reason:'self accept'}),{code:'INVALID_STATE'});
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
  const rebind=manager.bindRoot(root.id,{runId:'r2',ticketId:'t1',assignmentId:'a2'});
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

test('a root Session reused by a new Run is not blocked by its old final submission',t=>{
  const {manager,root,store}=fixture(t);
  manager.publish(root.id,{stepId:'final-old',result:{summary:'旧派工完成'},final:true});
  manager.bindRoot(root.id,{runId:'r2',ticketId:'t1',assignmentId:'a2'});
  assert.equal(manager.canUseTool(root.id,'read_file'),undefined);
  assert.equal(manager.publish(root.id,{stepId:'final-new',result:{summary:'新派工完成'},final:true}).runId,'r2');
  assert.equal(store.inspectStep('r1','final-old').event.payload.result.summary,'旧派工完成');
});
