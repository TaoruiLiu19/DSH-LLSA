import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Store } from '../src/app/store.ts';
import { CollabBridge } from '../src/app/collab-bridge.ts';
import { mainTools } from '../src/app/tools/main.ts';
import { readResource } from '../src/app/resources.ts';
import { Engine, key } from '../src/core/index.ts';

function fixture(t, { source = 'local', channelSource = source, outputFormat = 'json' } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'llsa-local-output-'));
  const path = join(scratch, 'state.sqlite');
  let store, bridge, tools, context, queued = 0;
  const channel = { source: channelSource, thread: 'job', address: { requestId: 'job' } };
  const at = '2026-11-18T01:00:00Z';
  const trigger = { id: 'request', source, threads: [{ source, id: 'job' }], actor: { source, id: 'owner' },
    human: true, at, channel, text: 'Deliver the requested result', meta: { outputFormat } };
  const ticket = { id: 'job', title: 'Local task', decisionId: 'decision', mandate: { strength: 'explicit', scope: 'job' },
    assignments: [{ id: 'a', state: 'running' }], channels: [channel], inputs: [], undelivered: [],
    origin: { triggerId: trigger.id, triggerIds: [trigger.id] }, createdAt: at, updatedAt: at };
  const failure = { enqueue: false, drain: false };
  function open() {
    store = new Store(path);
    const ctx = context = new Context();
    const engine = { acceptReadyReport() {}, note() {}, reply(value) {
      if (failure.enqueue) throw new Error('queue interrupted');
      const id = 'reply-' + ++queued;
      store.receipts.add({ id, channel, text: value.text, ticketId: ticket.id, kind: 'reply' });
      return { id, status: 'pending' };
    } };
    bridge = new CollabBridge(ctx, { store, engine, sessions: { relay() {} }, masterId: 'main' });
    bridge.registerLifecycle({ bindWorker() {}, beforeReady() {} });
    tools = mainTools({ context: ctx, store, engine, collabBridge: bridge, sessions: {}, resources: {},
      quietly: run => run(), requestPass() {}, async sendReplies() {
        if (failure.drain) throw new Error('sender interrupted');
        for (const reply of store.receipts.waiting()) store.receipts.settle(reply, 'sent');
      } }, {});
  }
  function close() { bridge.close(); store.close(); }
  open();
  store.triggers.save(trigger);
  store.tickets.save(ticket);
  t.after(() => { close(); rmSync(scratch, { recursive: true, force: true }); });
  return { failure, report: summary => bridge.recordReport(ticket, { state: 'ready', summary }).id,
    textOf: id => store.receipts.get(id)?.text,
    correct: () => store.triggers.save({ ...trigger, text: 'Updated instructions' }),
    reviewed: () => bridge.assertReviewed(ticket.id), count: () => queued, restart() { close(); open(); },
    read(resource, offset = 0, limit, owner = 'job') { return readResource({ store, context, masterId: 'main' }, resource, offset, limit, owner); },
    call(name, args) { const tool = tools.find(entry => entry.name === 'orchestrator_' + name); return tool.execute(tool.schema.parse(args)); } };
}

test('acceptance rolls back on enqueue failure and replays the original result after an interrupted drain and restart', async t => {
  const f = fixture(t);
  const report = f.report('{"id":"007"}');
  const args = { report_id: report, accepted: true, reason: 'Checked the exact identifier', use_report:true };
  f.failure.enqueue = true;
  await assert.rejects(f.call('collab_review', args), /queue interrupted/);
  assert.throws(f.reviewed, /Review and accept/);
  f.failure.enqueue = false;
  f.failure.drain = true;
  await assert.rejects(f.call('collab_review', args), /sender interrupted/);
  assert.doesNotThrow(f.reviewed);
  f.restart();
  f.failure.drain = false;
  const replay = await f.call('collab_review', { ...args, reason: 'A reworded reason' });
  assert.equal(replay.review.reason, args.reason);
  assert.equal(replay.status, 'sent');
  assert.equal(replay.replyId, 'reply-1');
  assert.equal(replay.reused, true);
  const edited = await f.call('collab_finish', { report_id:report, accepted:true, reason:args.reason, text: '{"different":1}' });
  assert.equal(edited.replyId, replay.replyId);
  const generic = await f.call('reply', { purpose: 'result', ticket_id: 'job', text: '{"third":true}' });
  assert.equal(generic.replyId, replay.replyId);
  await assert.rejects(f.call('reply', { purpose: 'result', trigger_id: 'request', text: '{}' }), /ticket_id/);
  assert.equal(f.count(), 1);
});

test('issued results expose only exact sent replies, with stable paging after revision and restart', async t => {
  const f = fixture(t);
  const draft = f.report('{"draft":"007"}');
  const finalText = '{ "value": "编号 007", "certainty": null }';
  const args = {report_id: draft, accepted: true, reason: 'Corrected the draft from evidence', text: finalText};
  f.failure.drain = true;
  await assert.rejects(f.call('collab_finish', args), /sender interrupted/);
  assert.deepEqual(await f.read('ticket/job/issued'), {items: [], next_offset: null});
  await assert.rejects(f.read('ticket/job/issued/reply-1'), /Unknown issued result/);
  f.failure.drain = false;
  const first = await f.call('collab_finish', args);
  f.correct();
  const second = await f.call('collab_finish', {...args, report_id: f.report('{"value":"new"}'), text: '{"value":"new"}'});
  f.restart();
  const page = await f.read('ticket/job/issued', 0, 1);
  assert.equal(page.items[0].id, first.replyId);
  assert.equal(page.next_offset, 1);
  assert.equal((await f.read('ticket/job/issued', page.next_offset, 1)).items[0].id, second.replyId);
  const a = await f.read(page.items[0].read, 0, 9);
  const b = await f.read(page.items[0].read, a.next_offset);
  assert.equal(a.text + b.text, finalText);
  await assert.rejects(f.read(page.items[0].read, 0, 20, 'another-ticket'), /does not belong/);
  await assert.rejects(f.read(`ticket/job/issued/${draft}`), /Unknown issued result/);
});

test('identical local revision results use distinct receipts and keep same-assignment replay idempotent', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'llsa-result-revision-'));
  const store = new Store(join(scratch, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(scratch, { recursive: true, force: true }); });
  const engine = new Engine({ repo: store, outbox: {
    status: id => store.replyStatus(id), send: message => store.receipts.add(message), withdraw() {},
  } });
  const text = 'Prepared the workspace files for review: index.html.';
  const at = '2026-11-18T01:00:00Z';
  for (const source of ['local', 'github']) {
    const id = source + '-revision';
    const channel = { source, thread: id, address: { requestId: id } };
    const ticket = { id, title: 'Same text, different work', origin: { triggerId: id, triggerIds: [id] },
      mandate: { strength: 'explicit', scope: 'work' }, assignments: [{ id: 'first', state: 'ended' }],
      channels: [channel], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
      ended: { at, outcome: 'completed', by: 'executor' } };
    const request = { purpose: 'result', ticketId: id, text };
    store.tickets.save(ticket);
    const first = engine.reply(request);
    assert.equal(first.id, key('reply', id, text));
    assert.deepEqual(engine.reply(request), { ...first, reused: true });
    store.receipts.settle(store.receipts.get(first.id), 'sent');

    ticket.assignments.push({ id: 'second', state: 'ended' });
    store.tickets.save(ticket);
    const second = engine.reply(request);
    if (source === 'local') {
      assert.notEqual(second.id, first.id);
      assert.equal(second.reused, false);
      assert.equal(store.receipts.get(second.id).text, text);
    } else assert.equal(second.id, first.id);
    assert.deepEqual(engine.reply(request), { ...second, reused: true });
    assert.equal(store.replyStatus(first.id), 'sent');
  }
});

test('a malformed JSON result and a prose task cannot be implicitly accepted and sent', async t => {
  for (const [format, pattern] of [['json', /complete JSON/], ['text', /final reply text/]]) {
    const f = fixture(t, { outputFormat: format });
    const args = { report_id: f.report('Progress report, details elsewhere'), accepted: true, reason: 'Checked' };
    await assert.rejects(f.call('collab_review', format === 'json' ? {...args,use_report:true} : args), pattern);
    assert.equal(f.count(), 0);
    assert.throws(f.reviewed, /Review and accept/);
    const reply = await f.call('collab_finish', { ...args, text: format === 'json' ? '{"fixed":true}' : 'The verified complete result' });
    assert.equal(reply.status, 'sent');
  }
});

test('acceptance with a repair comment cannot implicitly release the unchanged local JSON draft', async t => {
  const f = fixture(t);
  const args = { report_id: f.report('{"amount":2}'), accepted:true, reason:'Change the amount to 3 from the original source.' };
  for (const name of ['collab_finish','collab_review']) {
    await assert.rejects(f.call(name,args), /Supply final reply text/);
    assert.equal(f.count(),0);
    assert.throws(f.reviewed,/Review and accept/);
  }
  const final=await f.call('collab_finish',{...args,text:'{"amount":3}'});
  assert.equal(f.textOf(final.replyId),'{"amount":3}');
});

test('standalone acceptance preserves external review and explicit reply separation', async t => {
  for (const options of [{ source: 'github' }, { channelSource: 'github' }]) {
    const f = fixture(t, options);
    const args = { report_id: f.report('{"localField":true}'), accepted: true, reason: 'Reviewed' };
    await assert.rejects(f.call('collab_finish', { ...args, use_report: true }), /eligible for verbatim/);
    const review = await f.call('collab_review', args);
    assert.equal(review.reportId, args.report_id);
    assert.equal(review.replyId, undefined);
    assert.equal(f.count(), 0);
  }
});

test('explicit local verbatim delivery retains exact text and JSON and deduplicates replays', async t => {
  for (const [outputFormat, summary] of [
    ['text', '  编号 007 保留。\n\n- 仍待核对的金额为 −15 元。  \n'],
    ['json', ' { "id": "007", "total": -15 }\n'],
  ]) {
    const f = fixture(t, { outputFormat });
    const args = { report_id: f.report(summary), accepted: true, reason: 'Checked the whole report', use_report: true };
    assert.throws(() => f.call('collab_finish', { ...args, text: 'Different wording' }), /cannot be combined/);
    assert.throws(() => f.call('collab_finish', { ...args, accepted: false }), /requires acceptance/);
    if (outputFormat === 'text') {
      const { use_report, ...implicit } = args;
      await assert.rejects(f.call('collab_finish', implicit), /Supply final reply text/);
    }
    assert.equal(f.count(), 0);
    const result = await f.call('collab_finish', args);
    assert.equal(result.status, 'sent');
    assert.equal(f.textOf(result.replyId), summary);
    f.restart();
    const replay = await f.call('collab_finish', args);
    assert.equal(replay.replyId, result.replyId);
    assert.equal(replay.reused, true);
    assert.equal(f.count(), 1);
  }
});

test('verbatim delivery refuses corrected source and invalid JSON before queuing a reply', async t => {
  const f = fixture(t, { outputFormat: 'text' });
  const args = { report_id: f.report('Old result'), accepted: true, reason: 'Checked', use_report: true };
  f.correct();
  await assert.rejects(f.call('collab_finish', args), /predates current task inputs/);
  assert.equal(f.count(), 0);
  assert.throws(f.reviewed, /Review and accept/);
  const invalid = fixture(t);
  await assert.rejects(invalid.call('collab_finish', { ...args, report_id: invalid.report('{') }), /complete JSON/);
  assert.equal(invalid.count(), 0);
});
