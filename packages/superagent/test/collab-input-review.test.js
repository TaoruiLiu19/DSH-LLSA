import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/app/store.ts';
import { CollabBridge } from '../src/app/collab-bridge.ts';

test('native report review tracks full source content; delivery markers do not invalidate accepted reports', t => {
  const dir=mkdtempSync(join(tmpdir(),'llsa-input-review-')),store=new Store(join(dir,'state.sqlite'));
  const source={id:'source',source:'local',threads:[{source:'local',id:'test'}],actor:{source:'local',id:'owner'},human:true,at:'2026-11-11T00:00:00Z',text:'v1 allowed=false',meta:{outputFormat:'json'}};
  const ticket={id:'ticket',title:'fixture',decisionId:'decision',mandate:{strength:'explicit',scope:'test'},channels:[],assignments:[{id:'first',state:'running'}],inputs:[{id:'input',kind:'trigger',triggerId:'source',at:source.at}],undelivered:[],origin:{triggerId:'source',triggerIds:['source']},createdAt:source.at,updatedAt:source.at};
  store.triggers.save(source);store.tickets.save(ticket);
  const accepted=[];const ctx=new Context(),bridge=new CollabBridge(ctx,{store,masterId:'main',sessions:{relay(){}},engine:{acceptReadyReport(...args){accepted.push(args);},note(){},stopTicket(){},retryTicket(){}}});
  bridge.registerLifecycle({bindWorker(){},beforeReady(){},reviewState(){return {items:[]};}});
  assert.equal(bridge.displayTitles(ticket.id).assignmentTitle,'fixture');
  t.after(()=>{bridge.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const report=bridge.recordReport(ticket,{state:'ready',summary:'{"allowed":false}'});
  ticket.inputs[0].readAt='2026-11-11T01:00:00Z';store.tickets.save(ticket);
  bridge.reviewReport(report.id,true,'checked original');assert.equal(accepted.length,1);assert.doesNotThrow(()=>bridge.assertReviewed(ticket.id));
  // Source ID and input ID are unchanged, but semantics differ.
  store.triggers.save({...source,text:'v2 changed requirement'});
  assert.throws(()=>bridge.assertReviewed(ticket.id),/latest ready report/);
  const updated=bridge.recordReport(ticket,{state:'ready',summary:'{"allowed":false}'});
  store.triggers.save({...source,text:'v3 user correction'});
  assert.throws(()=>bridge.reviewReport(updated.id,true,'outdated'),/predates current task inputs/);
  assert.throws(()=>bridge.inputSnapshot(ticket.id,'previous-assignment'),/stale/);
});
