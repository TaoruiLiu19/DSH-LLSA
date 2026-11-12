import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollaborationStore } from '../src/store.js';

function fixture(t) {
  const tempRoot=fileURLToPath(new URL('../.test-state/',import.meta.url));mkdirSync(tempRoot,{recursive:true});
  const stateDir=mkdtempSync(join(tempRoot,'store-'));
  const store=new CollaborationStore({stateDir});
  t.after(()=>{store.close();const rel=relative(resolve(tempRoot),resolve(stateDir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(stateDir,{recursive:true,force:true});});
  store.createRun({id:'r1',ticketId:'t1',assignmentId:'a1'});
  return {store,stateDir};
}
const event=(overrides={})=>({runId:'r1',stepId:'s1',attemptId:'try1',kind:'test_result',payload:{executionStatus:'completed',outcome:'failed',passed:18,failed:1,summary:'尚未通过；不得部署',exact:'0.10'},...overrides});

test('usage backfill retains immutable attribution and rejects reassignment', t => {
  const {store}=fixture(t);
  store.recordUsage({runId:'r1',callId:'c',provider:'fixture',model:'m',agentId:'child',workItemId:'w',attemptId:'try1',purpose:'compaction'});
  store.recordUsage({runId:'r1',callId:'c',inputTokens:5,outputTokens:2});
  const row=store.usageSummary('r1').usage[0];
  assert.equal(row.workItemId,'w');assert.equal(row.purpose,'compaction');assert.equal(row.model,'m');
  assert.throws(()=>store.recordUsage({runId:'r1',callId:'c',workItemId:'other'}),{code:'USAGE_CONFLICT'});
  assert.throws(()=>store.recordUsage({runId:'r1',callId:'c',model:'other'}),{code:'USAGE_CONFLICT'});
});

test('cost projection includes requests missing usage and retains branch estimates', t => {
  const {store}=fixture(t);
  const metadata={runId:'r1',provider:'fixture',model:'m',workItemId:'w'};
  store.recordRequest({...metadata,callId:'a'});store.recordRequest({...metadata,callId:'b'});
  store.recordUsage({...metadata,callId:'a',inputTokens:100,cachedInputTokens:80,uncachedInputTokens:20,cacheWriteTokens:0,outputTokens:5});
  const price={id:'test',provider:'fixture',model:'m',currency:'USD',source:'fixture',perMillion:{cacheHit:1,cacheMiss:2,cacheWrite:2,output:3}};
  const report=store.costSummary('r1',price);
  assert.equal(report.estimates.length,2);assert.equal(report.unknownCalls,1);assert.equal(report.amount,null);
  assert.equal(report.byWorkItem[0].workItemId,'w');assert.equal(report.byWorkItem[0].amount,null);
  assert.ok(Math.abs(report.knownAmount-0.000135)<1e-12);
});

test('history survives restart, preserves failed snapshot after later success',t=>{
  const {store,stateDir}=fixture(t);
  const failed=store.appendEvent(event({id:'e1'}));
  store.appendEvent(event({id:'e2',parents:['e1'],payload:{outcome:'passed',passed:19,failed:0}}));
  store.close();
  const reopened=new CollaborationStore({stateDir});
  const old=reopened.inspectStep('r1','s1',{asOfSeq:failed.runSeq});
  assert.equal(old.event.payload.outcome,'failed');
  assert.equal(old.event.payload.exact,'0.10');
  assert.match(old.event.payload.summary,/不得部署/);
  assert.equal(reopened.inspectStep('r1','s1').event.payload.outcome,'passed');
  reopened.close();
});

test('multiple attempts require explicit disambiguation',t=>{
  const {store}=fixture(t);store.appendEvent(event());store.appendEvent(event({attemptId:'try2'}));
  const q=store.inspectStep('r1','s1');assert.equal(q.status,'ambiguous');assert.deepEqual(q.attempts,['try1','try2']);
  assert.equal(store.inspectStep('r1','s1',{attemptId:'try1'}).events.length,1);
});

test('event snapshot selects historical attempt and excludes future events',t=>{
  const {store}=fixture(t);const a=store.appendEvent(event({id:'old'}));store.appendEvent(event({attemptId:'new'}));
  assert.equal(store.inspectStep('r1','s1',{eventId:'old'}).asOfSeq,a.runSeq);
  assert.equal(store.inspectStep('r1','s1',{eventId:'old',asOfSeq:0}).status,'not_found');
});

test('run-bound causal DAG rejects missing and cross-run parents',t=>{
  const {store}=fixture(t);store.createRun({id:'r2',ticketId:'t2',assignmentId:'a2'});
  store.appendEvent(event({id:'parent'}));
  assert.throws(()=>store.appendEvent(event({parents:['missing']})),{code:'INVALID_PARENT'});
  assert.throws(()=>store.appendEvent(event({runId:'r2',parents:['parent']})),{code:'INVALID_PARENT'});
  const left=store.appendEvent(event({id:'left',parents:['parent']}));
  const right=store.appendEvent(event({id:'right',parents:['parent']}));
  assert.deepEqual(left.parents,right.parents);assert.equal(right.runSeq,left.runSeq+1);
});

test('events are immutable and duplicate ids fail without consuming sequence',t=>{
  const {store}=fixture(t);store.appendEvent(event({id:'fixed'}));
  assert.throws(()=>store.appendEvent(event({id:'fixed'})),{code:'DUPLICATE_EVENT'});
  assert.throws(()=>store.db.prepare('UPDATE events SET data=? WHERE id=?').run('{}','fixed'),/immutable/);
  assert.throws(()=>store.db.prepare('DELETE FROM events WHERE id=?').run('fixed'),/immutable/);
  assert.equal(store.highWater('r1'),1);
});

test('artifacts preserve exact bytes including unicode and permit validated ranges',t=>{
  const {store}=fixture(t);const bytes=Buffer.from('原文\r\n\t0.10 否定：未通过\0');
  const ref=store.putArtifact(bytes,{mediaType:'text/plain'});
  assert.deepEqual(store.readArtifact(ref),bytes);assert.equal(store.putArtifact(bytes).id,ref.id);
  assert.deepEqual(store.readArtifact(ref,{start:1,end:5}),bytes.subarray(1,5));
  assert.throws(()=>store.readArtifact(ref,{start:5,end:2}),{code:'INVALID_RANGE'});
  assert.throws(()=>store.readArtifact('../../secret'),{code:'INVALID_ARTIFACT_REF'});
});

test('artifact corruption is detected and never replaced by fabricated text',t=>{
  const {store}=fixture(t);const ref=store.putArtifact('original');
  writeFileSync(join(store.artifactDir,ref.sha256),'tampered');
  assert.throws(()=>store.readArtifact(ref),{code:'ARTIFACT_INTEGRITY'});
  assert.throws(()=>store.putArtifact('original'),{code:'ARTIFACT_INTEGRITY'});
});

test('protocol versions remain frozen across publication of another version',t=>{
  const {store}=fixture(t);store.registerProtocol({id:'test',version:1,fields:['passed','failed']});
  store.registerProtocol({id:'test',version:2,fields:['failed','passed']});
  assert.deepEqual(store.loadProtocol('test',1).fields,['passed','failed']);
  assert.throws(()=>store.registerProtocol({id:'test',version:1,fields:['changed']}),{code:'IMMUTABLE_PROTOCOL'});
  assert.equal(store.loadProtocol('test','missing'),null);
});

test('event plus message commit rolls back if message is invalid',t=>{
  const {store}=fixture(t);
  assert.throws(()=>store.commitMessage({event:event({id:'rolled-back'}),message:{sender:'a',recipient:''}}),{code:'INVALID_ARGUMENT'});
  assert.equal(store.getEvent('rolled-back'),null);assert.equal(store.highWater('r1'),0);
  const result=store.commitMessage({event:event({id:'kept'}),message:{id:'m1',sender:'a',recipient:'b',projection:{x:1}}});
  assert.equal(result.message.eventId,result.event.id);assert.equal(store.listOutbox('r1').length,1);
});

test('same delivery retries are idempotent and content changes reject',t=>{
  const {store}=fixture(t);store.appendEvent(event({id:'e1'}));
  const m={id:'m1',runId:'r1',eventId:'e1',sender:'a',recipient:'b',projection:{v:1}};
  assert.equal(store.enqueueMessage(m).id,store.enqueueMessage(m).id);
  assert.throws(()=>store.enqueueMessage({...m,projection:{v:2}}),{code:'ID_CONFLICT'});
  assert.equal(store.listOutbox().length,1);
});

test('rejected unknown protocol can be resent as next revision without false dedup',t=>{
  const {store}=fixture(t);store.appendEvent(event({id:'e1'}));
  const base={runId:'r1',eventId:'e1',logicalMessageId:'logical',sender:'a',recipient:'b'};
  const m1=store.enqueueMessage({...base,projection:{v:'unknown'}});
  store.markDelivery(m1.id,'rejected',{error:'UNKNOWN_PROTOCOL'});
  const m2=store.enqueueMessage({...base,deliveryRevision:2,projection:{v:'json',result:'failed'}});
  assert.notEqual(m1.id,m2.id);assert.equal(m2.logicalMessageId,m1.logicalMessageId);
  store.markDelivery(m2.id,'included_in_request',{requestId:'call1',incrementAttempt:true});
  assert.equal(store.getMessage(m2.id).transportAttempt,1);
  assert.throws(()=>store.enqueueMessage({...base,deliveryRevision:3}),{code:'INVALID_REVISION'});
  assert.throws(()=>store.markDelivery(m2.id,'queued'),{code:'INVALID_TRANSITION'});
});

test('outbox replays pending deliveries after restart',t=>{
  const {store,stateDir}=fixture(t);store.commitMessage({event:event({id:'e1'}),message:{id:'m1',sender:'a',recipient:'b'}});store.close();
  const reopened=new CollaborationStore({stateDir});assert.equal(reopened.listOutbox()[0].id,'m1');reopened.close();
});

test('immutable request snapshots represent many projections and repeated reuse',t=>{
  const {store}=fixture(t);
  store.recordRequest({callId:'c1',runId:'r1',items:[{projectionId:'p1'},{projectionId:'p2'}]});
  store.recordRequest({callId:'c2',runId:'r1',items:[{projectionId:'p1'}]});
  assert.equal(store.listRequests('r1')[1].items[0].projectionId,'p1');
  assert.throws(()=>store.recordRequest({callId:'c1',runId:'r1',items:[]}),{code:'IMMUTABLE_REQUEST'});
});

test('usage includes all calls and preserves unknown usage rather than treating it as zero',t=>{
  const {store}=fixture(t);
  store.recordUsage({callId:'parent',runId:'r1',inputTokens:100,outputTokens:20,cachedInputTokens:80,cost:1,currency:'USD'});
  store.recordUsage({callId:'child',runId:'r1',inputTokens:50,outputTokens:10,cachedInputTokens:0,cost:2,currency:'USD'});
  store.recordUsage({callId:'failed-no-usage',runId:'r1'});
  const s=store.usageSummary('r1');assert.equal(s.totalTokens,180);assert.equal(s.cachedInputTokens,80);assert.equal(s.unknownCalls,1);assert.equal(s.complete,false);assert.equal(s.costByCurrency.USD,3);
  store.recordUsage({callId:'failed-no-usage',runId:'r1',inputTokens:3,outputTokens:1});
  assert.equal(store.usageSummary('r1').totalTokens,184);assert.equal(store.usageSummary('r1').complete,true);
});

test('provider request ids deduplicate callbacks without double counting',t=>{
  const {store}=fixture(t);const u={runId:'r1',provider:'deepseek',providerRequestId:'p1',inputTokens:100,outputTokens:10};
  store.recordUsage({...u,callId:'c1'});store.recordUsage({...u,callId:'c2'});
  assert.equal(store.usageSummary('r1').calls,1);
  assert.throws(()=>store.recordUsage({...u,callId:'c3',inputTokens:101}),{code:'USAGE_CONFLICT'});
  assert.throws(()=>store.recordUsage({...u,callId:'c4',cachedInputTokens:101}),{code:'INVALID_USAGE'});
});

test('management projections are scoped to run even when ids are reused',t=>{
  const {store}=fixture(t);store.createRun({id:'r2',ticketId:'t1',assignmentId:'a2'});
  store.saveAgent({id:'worker',runId:'r1',status:'idle'});store.saveAgent({id:'worker',runId:'r2',status:'active'});
  store.saveWorkItem({id:'test',runId:'r1',status:'failed'});store.saveWorkItem({id:'test',runId:'r2',status:'planned'});
  assert.equal(store.getAgents('r1')[0].status,'idle');assert.equal(store.getWorkItems('r2')[0].status,'planned');
});

test('source event copy, receipt and cursor commit together',t=>{
  const {store}=fixture(t);
  const input={source:'bridge',sourceEventId:'src1',cursor:'1',event:event({id:'copy1'})};
  assert.equal(store.importSourceEvent(input).duplicate,false);assert.equal(store.sourceCursor('bridge'),'1');
  assert.equal(store.importSourceEvent(input).duplicate,true);assert.equal(store.highWater('r1'),1);
  assert.throws(()=>store.importSourceEvent({source:'bridge',sourceEventId:'src2',cursor:'2',event:event({parents:['unknown']})}),{code:'INVALID_PARENT'});
  assert.equal(store.sourceCursor('bridge'),'1');
});

test('rejects non-JSON event values instead of silently corrupting fields',t=>{
  const {store}=fixture(t);
  for(const payload of [{x:undefined},{x:NaN},{x:1n},new Date(),[,,]]) assert.throws(()=>store.appendEvent(event({payload})),{code:'INVALID_JSON'});
  assert.equal(store.highWater('r1'),0);
});
