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
  assert.ok(delivery.hasCurrent(session, 'r', 'v1'));
  delivery.observe(session, { type: 'user/message', data: {
    id: 'native-input:r:fake', source: { kind: 'user', form: 'input-reference' } } });
  assert.equal(delivery.hasCurrent(session, 'r', 'fake'), false);
  assert.equal(await delivery.admit(agent, original, binding, inputs), original);
  const nextSeries = { ...original, startsRequestSeries: true };
  assert.equal(await delivery.admit(agent, nextSeries, binding, inputs), nextSeries);
  const reopened = new InputDelivery(persistence);
  assert.equal(await reopened.admit({ id: 'worker', session: {} }, original, binding, inputs), original);
  delivery.observe(session, { type: 'compaction/end' });
  assert.equal(delivery.hasCurrent(session, 'r', 'v1'), false);
  assert.equal((await delivery.admit(agent, original, binding, inputs)).messages.length, 2);
  assert.equal(await delivery.admit(agent, { kind: 'reject' }, binding, inputs).then(x => x.kind), 'reject');
  assert.equal(await delivery.admit(agent, original, { ...binding, parentId: 'parent' }, inputs), original);
});

test('a correction during receipt recovery cannot attach a current hint to a stale version', async () => {
  const blocked = Promise.withResolvers();
  let version = 'v1';
  const persistence = { flush: () => blocked.promise, async open() {
    return { async read() { return { events: [] }; }, async [Symbol.asyncDispose]() {} };
  } };
  const delivery = new InputDelivery(persistence);
  const agent = { id: 'worker', session: {} };
  const decision = { kind: 'enter', messages: [] };
  const binding = { runId: 'r' };
  const inputs = { current: () => version && { version }, hint: () => 'Current input ' + version };
  const pending = delivery.admit(agent, decision, binding, inputs);
  version = 'v2';
  blocked.resolve();
  const result = await pending;
  assert.equal(result.messages.length, 1);
  const [message] = result.messages;
  assert.equal(message.id, 'native-input:r:v2');
  assert.equal(message.content[0].text, 'Current input v2');
  delivery.observe(agent.session, { type: 'user/message', data: message });
  assert.equal(delivery.hasCurrent(agent.session, 'r', 'v1'), false);
  assert.equal(await delivery.admit(agent, decision, binding, inputs), decision);
});

test('an input retired during receipt recovery creates no marker; absent input stays on the fast path', async () => {
  const blocked = Promise.withResolvers();
  let current = { version: 'v1' }, flushes = 0;
  const delivery = new InputDelivery({
    flush() { flushes++; return blocked.promise; },
    async open() { return { async read() { return { events: [] }; }, async [Symbol.asyncDispose]() {} }; },
  });
  const decision = { kind: 'enter', messages: [] };
  const binding = { runId: 'r' };
  const inputs = { current: () => current, hint() { throw Error('No input hint should be generated'); } };
  const pending = delivery.admit({ id: 'worker', session: {} }, decision, binding, inputs);
  current = undefined;
  blocked.resolve();
  assert.equal(await pending, decision);
  assert.equal(await delivery.admit({ id: 'new-worker', session: {} }, decision, binding, inputs), decision);
  assert.equal(flushes, 1);
});

const referenceEvent = (version, seq) => ({ type: 'user/message', seq, data: {
  id: 'native-input:r:' + version, source: { kind: 'dsh-collab', form: 'input-reference' },
} });

test('concurrent admissions wait for the same fully restored receipt history', async () => {
  const reading = Promise.withResolvers(), unblock = Promise.withResolvers();
  let flushes = 0, opens = 0;
  const delivery = new InputDelivery({
    async flush() { flushes++; },
    async open() {
      opens++;
      return {
        async read(offset) {
          if (offset) return { events: [] };
          reading.resolve();
          await unblock.promise;
          return { events: [referenceEvent('v1', 1)] };
        },
        async [Symbol.asyncDispose]() {},
      };
    },
  });
  const agent = { id: 'worker', session: {} }, binding = { runId: 'r' };
  const decision = { kind: 'enter', messages: [] };
  const inputs = { current: () => ({ version: 'v1' }), hint: () => 'must not be injected again' };
  const first = delivery.admit(agent, decision, binding, inputs);
  const second = delivery.admit(agent, decision, binding, inputs);
  await reading.promise;
  const third = delivery.admit(agent, decision, binding, inputs);
  assert.equal(delivery.hasCurrent(agent.session, 'r', 'v1'), false);
  unblock.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [decision, decision, decision]);
  assert.equal(delivery.hasCurrent(agent.session, 'r', 'v1'), true);
  assert.deepEqual([flushes, opens], [1, 1]);
});

test('a failed persistence open does not leave an empty cached receipt set', async () => {
  let opens = 0;
  const delivery = new InputDelivery({
    async flush() {},
    async open() {
      if (++opens === 1) throw Error('temporary open failure');
      return {
        async read(offset) { return { events: offset ? [] : [referenceEvent('v1', 1)] }; },
        async [Symbol.asyncDispose]() {},
      };
    },
  });
  const agent = { id: 'worker', session: {} }, binding = { runId: 'r' };
  const decision = { kind: 'enter', messages: [] };
  const inputs = { current: () => ({ version: 'v1' }), hint: () => 'must not be injected again' };
  await assert.rejects(delivery.admit(agent, decision, binding, inputs), /temporary open failure/);
  assert.equal(await delivery.admit(agent, decision, binding, inputs), decision);
  assert.equal(opens, 2);
});

test('live compaction wins over stale history but is not replayed if already included in the durable scan', async () => {
  for (const includeLive in [false, true]) {
    const reading = Promise.withResolvers(), unblock = Promise.withResolvers();
    const compact = { type: 'compaction/end', seq: 2 }, later = referenceEvent('v2', 3);
    const delivery = new InputDelivery({
      async flush() {},
      async open() { return {
        async read(offset) {
          if (offset) return { events: [] };
          reading.resolve();
          await unblock.promise;
          return { events: includeLive ? [referenceEvent('v1', 1), compact, later] : [referenceEvent('v1', 1)] };
        },
        async [Symbol.asyncDispose]() {},
      }; },
    });
    const agent = { id: 'worker', session: {} };
    const recovered = delivery.seen(agent);
    await reading.promise;
    delivery.observe(agent.session, compact);
    if (!includeLive) delivery.observe(agent.session, later);
    unblock.resolve();
    assert.deepEqual([...await recovered], ['native-input:r:v2']);
    assert.equal(delivery.hasCurrent(agent.session, 'r', 'v1'), false);
    assert.equal(delivery.hasCurrent(agent.session, 'r', 'v2'), true);
  }
});
