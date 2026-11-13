import test from 'node:test';
import assert from 'node:assert/strict';
import { InputDelivery } from '../src/input-delivery.js';

test('100 consecutive requests admit one hint per version, and restore only current input after compaction and restart', async () => {
  const events = [], session = {}, agent = {id: 'worker', session};
  const persistence = {async flush() {}, async open() {return {async read(offset) {return {events: events.slice(offset)};}, async [Symbol.asyncDispose]() {}};}};
  const delivery = new InputDelivery(persistence), binding = {runId: 'r'};
  let version = 'v1', admissions = 0;
  const inputs = {current: () => ({version}), hint: () => `Current input ${version}`};
  const decision = {kind: 'enter', messages: []};
  for (let i = 0; i < 100; i++) {
    if (i === 40) version = 'v2';
    if (i === 70) {const event = {type: 'compaction/end'}; events.push(event); delivery.observe(session, event);}
    const result = await delivery.admit(agent, decision, binding, inputs);
    for (const message of result.messages) {
      admissions++;
      assert.equal(message.content[0].text, `Current input ${version}`);
      const event = {type: 'user/message', data: message}; events.push(event); delivery.observe(session, event);
    }
  }
  assert.equal(admissions, 3);
  assert.equal(await new InputDelivery(persistence).admit({id: 'worker', session: {}}, decision, binding, inputs), decision);
});

test('input hint is durable context, not a changed system prompt; retries, restart and compaction are accounted for', async () => {
  const events = [], session = {}, agent = { id: 'worker', session };
  const persistence = { async flush() {}, async open() { return { async read(offset) { return { events: events.slice(offset) }; }, async [Symbol.asyncDispose]() {} }; } };
  const binding = { runId: 'r', parentId: null }, inputs = { current() { return { version: 'v1' }; }, hint() { return 'Use input:known'; } };
  const original = { kind: 'enter', messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'task' }] }] };
  const delivery = new InputDelivery(persistence), first = await delivery.admit(agent, original, binding, inputs);
  assert.equal(original.messages.length, 1); assert.equal(first.messages.length, 2);
  // Rejected preparation did not log admission: the hint must be offered again.
  assert.equal((await delivery.admit(agent, original, binding, inputs)).messages.length, 2);
  const event = { type: 'user/message', data: first.messages[1] }; events.push(event); delivery.observe(session, event);
  assert.equal(await delivery.admit(agent, original, binding, inputs), original);
  const nextSeries = { ...original, startsRequestSeries: true };
  assert.equal(await delivery.admit(agent, nextSeries, binding, inputs), nextSeries);
  const reopened = new InputDelivery(persistence);
  assert.equal(await reopened.admit({ id: 'worker', session: {} }, original, binding, inputs), original);
  delivery.observe(session, { type: 'compaction/end' });
  assert.equal((await delivery.admit(agent, original, binding, inputs)).messages.length, 2);
  assert.equal(await delivery.admit(agent, { kind: 'reject' }, binding, inputs).then(x => x.kind), 'reject');
  assert.equal(await delivery.admit(agent, original, { ...binding, parentId: 'parent' }, inputs), original);
});
