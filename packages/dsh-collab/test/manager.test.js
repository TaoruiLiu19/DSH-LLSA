import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { CollaborationStore } from '../src/store.js';
import { CollaborationManager } from '../src/manager.js';

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
  assert.equal(backend.deliveries.length,0);assert.equal(store.listEvents('r2').length,0);
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
  assert.equal(store.listEvents('r2').length,0);
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
