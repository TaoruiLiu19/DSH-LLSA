import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeInputs } from '../src/native-inputs.js';
import { CollaborationStore } from '../src/store.js';
import { connectSuperagent } from '../src/superagent-integration.js';
import { historyScope } from '../src/superagent-history.js';

const preamble = '逐章按业务约束核对。\r\n' +
  'Review the assigned section and preserve the exact input. '.repeat(12) +
  '\r\nPreserve IDs as strings and return only {"results":[{"id":"007"}]}.\r\n\r\n';
const sections = '## 西区\r\nPRIVATE_WEST\r\n~~~txt\r\n## Not a section\r\n~~~\r\n' +
  '## 东区\r\nPRIVATE_EAST\r\n';

function source(text = preamble + sections) {
  return { id: 'request', source: 'local', human: true, addressed: 'direct', text };
}

function snapshot(overrides = {}) {
  const text = JSON.stringify({
    schema: 1, origin: { triggerId: 'request', triggerIds: ['request'] },
    inputs: [], sources: [source()], ...overrides,
  });
  return { text, version: createHash('sha256').update(text).digest('hex') };
}

function fixture(t, runId = 'run') {
  const scratch = mkdtempDisposableSync(join(tmpdir(), 'llsa-section-brief-'));
  const store = new CollaborationStore({ stateDir: scratch.path });
  t.after(() => { store.close(); scratch.remove(); });
  store.createRun({ id: runId, ticketId: 'ticket', assignmentId: 'assignment', title: 'Section brief', rootSessionId: 'worker' });
  return { store, inputs: new NativeInputs(store) };
}

test('worker hint carries original rules and output contract without section data', t => {
  const { store, inputs } = fixture(t);
  assert.ok(preamble.length > 600);
  const registered = inputs.register('run', snapshot());
  const brief = registered.sectionPreamble;
  assert.ok(brief);
  assert.equal(brief.sourceId, 'request');
  assert.equal(brief.startByte, 0);
  assert.equal(brief.endByte, Buffer.byteLength(preamble));
  assert.equal(store.readArtifact(brief.artifactRef).toString('utf8'), preamble);
  assert.ok(store.eventsByKind('run', 'input_snapshot')[0].inputRefs.includes(brief.artifactRef));
  assert.deepEqual(registered.sections.map(section => section.title), ['西区', '东区']);
  const hint = inputs.hint('run');
  assert.ok(hint.includes(`Original task preamble (verbatim; current input): ${JSON.stringify(preamble)}`));
  assert.match(hint, /"id":"s1","title":"西区"/);
  assert.match(hint, /"id":"s2","title":"东区"/);
  assert.doesNotMatch(hint, /PRIVATE_WEST|PRIVATE_EAST/);
  assert.equal(JSON.parse(store.readArtifact(inputs.resolve('run', registered.handle))).sources[0].text, preamble + sections);
});

test('only the unambiguous sole local origin exposes a bounded preamble', t => {
  const { inputs } = fixture(t);
  const variants = [
    { sources: [{ ...source(), addressed: 'indirect' }] },
    { sources: [{ ...source(), source: 'external' }] },
    { sources: [source(), { ...source('additional rule'), id: 'another' }] },
    { inputs: [{ kind: 'note', text: 'Change the matching rule' }] },
    { sources: [source('过'.repeat(700) + '\r\n' + sections)] },
    { sources: [source(preamble + sections + '## 空章节\r\n')] },
    { sources: [source(preamble + sections + '# 章节后的要求\r\n不同规则')] },
    { sources: [source(preamble + '## 西区\r\nOnly one section')] },
  ];
  for (const variant of variants) {
    const registered = inputs.register('run', snapshot(variant));
    assert.equal(registered.sectionPreamble, undefined);
    assert.doesNotMatch(inputs.hint('run'), /Original task preamble/);
    assert.equal(inputs.resolve('run', registered.handle), registered.artifactRef);
  }
});

test('a correction omits the old preamble while preserving exact historical content', t => {
  const { store, inputs } = fixture(t);
  const old = inputs.register('run', snapshot());
  inputs.register('run', snapshot({ inputs: [{ kind: 'note', text: 'Use the later evidence' }] }));
  assert.doesNotMatch(inputs.hint('run'), /Original task preamble/);
  const ref = old.sectionPreamble.artifactRef;
  assert.throws(() => inputs.resolve('run', ref, { currentOnly: true }), /Stale input version/);
  assert.equal(store.readArtifact(inputs.resolve('run', ref)).toString('utf8'), preamble);
});

test('coordinator receives exact preamble and source-ordered references only for current accepted sections', t => {
  const runId = 'super-ticket-assignment';
  const { store, inputs } = fixture(t, runId);
  const ticket = { id: 'ticket', assignments: [{ id: 'assignment' }] };
  let lifecycle;
  const bridge = {
    compatibility: () => ({ apiVersion: 3 }),
    snapshot: () => ({ masterSessionId: 'master', tickets: [{ ticket, assignmentId: 'assignment' }] }),
    registerLifecycle(hooks) { lifecycle = hooks; return () => {}; },
  };
  const manager = { store, bridge, nativeInputs: inputs, toolPolicies: new Map(),
    setToolPolicy() {}, bindRoot() {}, binding: () => ({ runId: 'super-master-master' }) };
  t.after(connectSuperagent(manager, bridge).dispose);

  const current = inputs.register(runId, snapshot());
  const review = version => lifecycle.sectionReview(ticket, version ?? current.version);
  assert.equal(review(), undefined);
  const items = [1, 0].map(index => {
    const section = current.sections[index];
    const item = { id: `item-${index}`, childId: `child-${index}`, attemptId: `attempt-${index}`, parentId: 'worker',
      runId, inputVersion: current.version, inputRefs: [section.artifactRef], evidenceScope: 'assigned',
      sectionDispatch: { ...section, selector: `s${index + 1}` }, state: 'succeeded' };
    const final = store.appendEvent({ runId, stepId: `result-${index}`, attemptId: item.attemptId, kind: 'final_result',
      payload: { actorId: item.childId, result: { value: index } } });
    const assessment = store.appendEvent({ runId, stepId: item.id, kind: 'result_assessment',
      payload: { actorId: item.parentId, accepted: true, resultEventId: final.id } });
    return store.saveWorkItem({ ...item, resultEventId: final.id, verificationEventId: assessment.id });
  });
  const packet = review();
  assert.deepEqual(packet, { preamble, sections: [
    { title: '西区', inputRef: current.sections[0].artifactRef, resultEventId: items[1].resultEventId },
    { title: '东区', inputRef: current.sections[1].artifactRef, resultEventId: items[0].resultEventId },
  ] });
  assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_WEST|PRIVATE_EAST/);
  const byTicket = historyScope(manager, 'master', { ticketId: ticket.id, assignmentId: 'assignment' });
  assert.match(store.readArtifact(packet.sections[0].inputRef).toString('utf8'), /PRIVATE_WEST/);
  assert.equal(byTicket.runId, runId);
  assert.deepEqual(historyScope(manager, 'master', { eventId: packet.sections[0].resultEventId }),
    { runId, stepId: 'result-0' });
  assert.equal(review('stale-claimed-input'), undefined);
  store.saveWorkItem({ ...items[0], state: 'submitted' });
  assert.equal(review(), undefined);
  store.saveWorkItem(items[0]);
  const updated = inputs.register(runId, snapshot({ inputs: [{ kind: 'note', text: 'New constraint' }] }));
  assert.equal(review(updated.version), undefined);
  assert.equal(review(), undefined);
});
