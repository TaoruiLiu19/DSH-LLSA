import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/app/store.ts';
import { CollabBridge } from '../src/app/collab-bridge.ts';
import { mainTools } from '../src/app/tools/main.ts';
import { executorTools } from '../src/app/tools/executor.ts';

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

test('ready relay includes the section review packet pinned to the report input version', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'llsa-section-review-'));
  const store = new Store(join(scratch, 'state.sqlite'));
  const source = { id: 'source', source: 'local', threads: [{ source: 'local', id: 'fixture' }],
    actor: { source: 'local', id: 'owner' }, human: true, at: '2026-11-11T00:00:00Z',
    text: 'Use exact IDs.\n## First\nSource row\n', meta: { outputFormat: 'json' } };
  const ticket = { id: 'ticket', title: 'Section review', mandate: { strength: 'explicit' },
    assignments: [{ id: 'assignment', state: 'running' }], inputs: [], undelivered: [],
    origin: { triggerId: source.id, triggerIds: [source.id] } };
  const bridge = new CollabBridge(new Context(), { store, masterId: 'master', sessions: { relay() {} },
    engine: { acceptReadyReport() {} } });
  t.after(() => { bridge.close(); store.close(); rmSync(scratch, { recursive: true, force: true }); });
  store.triggers.save(source);
  store.tickets.save(ticket);
  const expected = { preamble: 'Use exact IDs.\n',
    sections: [{ title: 'First', inputRef: 'sha256:sample', resultEventId: 'result' }] };
  const inputVersion = bridge.inputSnapshot(ticket.id).version;
  const versions = [];
  bridge.registerLifecycle({ bindWorker() {}, beforeReady() {}, sectionReview(current, version) {
    assert.equal(current.id, ticket.id);
    versions.push(version);
    return version === inputVersion ? expected : undefined;
  } });
  const relay = { id: 'relay', text: '{"state":"ready","summary":"{}"}' };
  assert.equal(bridge.recordReport(ticket, { state: 'progress', summary: 'Working' }).reviewContext, undefined);
  const ready = bridge.recordReport(ticket, { state: 'ready', summary: '{}' }, relay);
  assert.deepEqual(JSON.parse(ready.deliveredRelay.text).review_context.sectionReview, expected);
  assert.match(JSON.parse(ready.deliveredRelay.text).review_context.verificationScope, /independently compare/);
  assert.deepEqual(bridge.readReport(ready.id).reviewContext.sectionReview, expected);
  store.triggers.save({ ...source, text: 'Corrected instruction' });
  assert.throws(() => bridge.reviewReport(ready.id, true, 'old'), /predates current task inputs/);
  assert.equal(bridge.recordReport(ticket, { state: 'ready', summary: '{}' }, relay).reviewContext.sectionReview, undefined);
  assert.equal(versions.length, 2);
  assert.notEqual(versions[0], versions[1]);
});

test('local report review delivers only accepted JSON and preserves evidence across a correction', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'llsa-local-review-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const ctx = new Context();
  const at = '2026-11-11T00:00:00Z';
  const trigger = { id: 'source', source: 'local', threads: [{ source: 'local', id: 'fixture' }],
    actor: { source: 'local', id: 'owner' }, human: true, at, text: 'Compute result', meta: { outputFormat: 'json' } };
  const ticket = { id: 'local', title: 'Report fixture', decisionId: 'decision', mandate: { strength: 'explicit', scope: 'compute' },
    channels: [], assignments: [{ id: 'first', state: 'running' }], inputs: [], undelivered: [],
    origin: { triggerId: trigger.id, triggerIds: [trigger.id] }, createdAt: at, updatedAt: at };
  const notices = [];
  const delivered = [];
  let passes = 0;
  const engine = {
    acceptReadyReport() {},
    note(id, text, reviewOf) {
      notices.push({ id, text, reviewOf });
      const live = store.tickets.get(id);
      live.inputs.push({ id: 'review-feedback', kind: 'note', at, text, reviewOf });
      store.tickets.save(live);
    },
    reply(value) { delivered.push(value); return { id: 'reply' }; },
  };
  const bridge = new CollabBridge(ctx, { store, masterId: 'main', sessions: { relay() {} }, engine });
  bridge.registerLifecycle({ bindWorker() {}, beforeReady() {}, reviewState: () => ({ items: [] }) });
  t.after(() => { bridge.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.triggers.save(trigger);
  store.tickets.save(ticket);
  const tool = mainTools({
    collabBridge: bridge, engine, context: ctx, store, resources: {},
    requestPass() { passes++; }, sendReplies: async () => {}, quietly: run => run(),
  }, {}).find(tool => tool.name === 'orchestrator_collab_finish');
  const finish = args => tool.execute(tool.schema.parse(args));
  const report = bridge.recordReport(ticket, { state: 'ready', summary: '{"value":1}' });
  assert.equal(report.reviewContext.sources[0].read_tool, 'orchestrator_read');
  await finish({ report_id: report.id, accepted: false, reason: 'Recount one item', text: '{"draft":2}' });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reviewOf, report.id);
  assert.match(notices[0].text, /Recount one item/);
  assert.deepEqual(delivered, []);
  assert.doesNotMatch(bridge.inputSnapshot(ticket.id).text, /Recount one item/);
  assert.equal(bridge.inputSnapshot(ticket.id).version, report.reviewContext.inputVersion);

  const current = store.tickets.get(ticket.id);
  const unchanged = bridge.recordReport(current, { state: 'ready', summary: '{ "value": 1 }' });
  const suppressed = await finish({ report_id: unchanged.id, accepted: false, reason: 'Count the missing item now' });
  assert.equal(suppressed.review.status, 'unchanged_result');
  assert.equal(suppressed.review.previousReportId, report.id);
  assert.equal(notices.length, 1);
  assert.equal(passes, 1);
  assert.deepEqual(delivered, []);
  assert.throws(() => bridge.assertReviewed(ticket.id), /Review and accept/);

  const revised = bridge.recordReport(current, { state: 'ready', summary: '{"value":2}' });
  await finish({ report_id: revised.id, accepted: false, reason: 'Check the source count' });
  assert.equal(notices.length, 2);
  const reviewed = bridge.recordReport(current, { state: 'ready', summary: '{"value":2}' });
  await finish({ report_id: reviewed.id, accepted: true, use_report:true, reason: 'Recount verified' });
  assert.deepEqual(delivered, [{ purpose: 'result', ticketId: ticket.id, text: '{"value":2}' }]);

  // A real new instruction still invalidates the evidence version and blocks use of a stale report.
  current.inputs.push({ id: 'user-update', kind: 'note', text: 'Change the target', at });
  store.tickets.save(current);
  assert.notEqual(bridge.inputSnapshot(ticket.id).version, reviewed.reviewContext.inputVersion);
  assert.throws(() => bridge.assertReviewed(ticket.id), /latest ready report/);
});


test('ready report can reuse an accepted whole-task JSON result without bypassing either review gate', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'llsa-accepted-report-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const ctx = new Context();
  const at = '2026-11-11T00:00:00Z';
  const source = { id: 'source', source: 'local', threads: [{ source: 'local', id: 'fixture' }],
    actor: { source: 'local', id: 'owner' }, human: true, at, text: 'Return JSON', meta: { outputFormat: 'json' } };
  const ticket = { id: 'local', title: 'Report fixture', decisionId: 'decision', mandate: { strength: 'explicit', scope: 'report' },
    channels: [], assignments: [{ id: 'assignment', state: 'running' }], inputs: [], undelivered: [],
    origin: { triggerId: source.id, triggerIds: [source.id] }, createdAt: at, updatedAt: at };
  const result = { id: '007', totals: [2, 5] };
  const reports = [];
  const relays = [];
  const sessions = { relay: (id, text) => relays.push({ id, text }) };
  const engine = { report: (id, report) => { reports.push(report); return store.tickets.get(id); } };
  const bridge = new CollabBridge(ctx, { store, masterId: 'main', sessions, engine });
  assert.equal(bridge.compatibility().capabilities.acceptedTaskResult, false);
  let ready = false;
  bridge.registerLifecycle({
    bindWorker() {},
    beforeReady() { if (!ready) throw new Error('Other work still pending'); },
    acceptedTaskResult(current, workItemId, owner) {
      assert.equal(current.id, ticket.id);
      assert.equal(owner, 'worker-local');
      if (workItemId !== 'accepted-whole-result') throw new Error('Work result is not accepted');
      return result;
    },
  });
  assert.equal(bridge.compatibility().capabilities.acceptedTaskResult, true);
  t.after(() => { bridge.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.triggers.save(source);
  store.tickets.save(ticket);
  const report = executorTools({
    collabBridge: bridge, engine, store, sessions, resources: {}, github: { deployment: { github: {} } },
  }, ticket).find(tool => tool.name === 'orchestrator_report');
  const byReference = { state: 'ready', work_item_id: 'accepted-whole-result' };
  assert.equal(report.schema.safeParse({ ...byReference, summary: 'Replacement' }).success, false);
  assert.equal(report.schema.safeParse({ ...byReference, state: 'progress' }).success, false);
  assert.equal(report.schema.safeParse({ ...byReference, human_action: 'Approve?' }).success, false);
  const run = args => report.execute(report.schema.parse(args));
  await assert.rejects(run(byReference), /Other work still pending/);
  ready = true;
  await assert.rejects(run({ ...byReference, work_item_id: 'unexpected' }), /not accepted/);
  assert.deepEqual(reports, []);
  await run(byReference);
  assert.deepEqual(reports, [{ state: 'ready', summary: '{"id":"007","totals":[2,5]}' }]);
  assert.equal(JSON.parse(relays[0].text).summary, JSON.stringify(result));
  assert.throws(() => bridge.assertReviewed(ticket.id), /Review and accept/);
  store.triggers.save({ ...source, meta: { outputFormat: 'text' } });
  await assert.rejects(run(byReference), /requires a ready report summary/);
});
