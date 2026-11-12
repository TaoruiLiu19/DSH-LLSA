import test from 'node:test';
import assert from 'node:assert/strict';
import { InputDelivery } from '../src/input-delivery.js';

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
  const reopened = new InputDelivery(persistence);
  assert.equal(await reopened.admit({ id: 'worker', session: {} }, original, binding, inputs), original);
  delivery.observe(session, { type: 'compaction/end' });
  assert.equal((await delivery.admit(agent, original, binding, inputs)).messages.length, 2);
  assert.equal(await delivery.admit(agent, { kind: 'reject' }, binding, inputs).then(x => x.kind), 'reject');
  assert.equal(await delivery.admit(agent, original, { ...binding, parentId: 'parent' }, inputs), original);
});
