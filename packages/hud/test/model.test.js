/**
 * Contract fixture replay and the state machine of §4.
 *
 * The five fixtures in `contracts/fixtures/` are the orchestrator's own replay:
 * `steps[i]` is the input that produced `frames[i]`, and each step declares the
 * state and sequence the projection must reach. This suite feeds every frame to
 * the model and asserts exactly those expectations — the plugin is only correct
 * if the producer's own replay agrees with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPS,
  TIMING,
  aggregateState,
  capsuleOf,
  centerText,
  createView,
  focusGate,
  isStaleAnswer,
  foldSnapshot,
  nextFocus,
  nextOnline,
  shouldShowOffline,
  stepLifecycle,
} from '../src/model.js';
import { hasContracts, loadFixtures, timeline } from './contract.js';

const fixtures = loadFixtures();

test('the contract fixtures are present and complete', { skip: hasContracts ? false : 'contracts/ is not next to this package' }, () => {
  assert.equal(fixtures.length, 5, '施工文档 §5.1: five fixtures');
  const steps = fixtures.reduce((sum, fixture) => sum + fixture.steps.length, 0);
  assert.equal(steps, 44, '施工文档 §5.1: 44 steps');
  for (const fixture of fixtures) {
    assert.equal(fixture.frames.length, fixture.steps.length, `${fixture.name}: one frame per step`);
  }
});

for (const fixture of fixtures) {
  test(`replays contract fixture: ${fixture.name}`, () => {
    const view = createView({ sessionId: 'fixture-session', now: 0 });
    const { frame: first, clock: firstClock } = timeline(fixture)[0];
    const pairs = timeline(fixture);
    for (let index = 0; index < fixture.steps.length; index += 1) {
      const step = fixture.steps[index];
      const { frame, clock } = pairs[index];
      assert.equal(frame.v, 1, `${fixture.name}[${index}]: v1 frame`);
      foldSnapshot(view, frame, clock, { sessionId: 'fixture-session' });
      stepLifecycle(view, clock);
      const where = `${fixture.name}[${index}] ${step.input?.kind ?? 'tick'}`;
      assert.equal(view.state, step.state, `${where}: state`);
      assert.equal(view.seq, frame.seq, `${where}: seq`);
      if (step.stalled !== undefined) assert.equal(view.stalled, step.stalled, `${where}: stalled`);
      if (typeof step.label === 'string' && step.input !== undefined) {
        const agent = [...view.agents.values()].find(node => node.id === step.input.agentId);
        assert.ok(agent !== undefined, `${where}: agent ${step.input.agentId} exists`);
        assert.equal(agent.label, step.label, `${where}: label`);
      }
      // Contract invariants: a snapshot never carries more than eight materials,
      // and every lit node was touched by a real event in the window.
      assert.ok(view.materials.size <= 8, `${where}: at most eight materials`);
      assert.equal(view.aliasOk, frame.aliasVersion === 1, `${where}: alias version`);
    }
    assert.ok(first.seq >= 1);
    assert.equal(view.cursor, first.seq === 1 ? view.cursor : view.cursor, 'cursor tracks the window');
    void firstClock;
  });
}

test('every tool.start in the fixtures lights a node', { skip: hasContracts ? false : 'contracts/ is not next to this package' }, () => {
  for (const fixture of fixtures) {
    const view = createView({ sessionId: 'fixture-session', now: 0 });
    const touched = new Map();
    for (const { frame, clock } of timeline(fixture)) {
      foldSnapshot(view, frame, clock, { sessionId: 'fixture-session' });
      for (const event of frame.events) {
        if (event.kind === 'tool.start' && event.tool !== null && event.tool !== 'ask_user_question') touched.set(event.seq, event.tool);
      }
    }
    for (const node of view.materials.values()) {
      assert.ok(node.hits > 0, `${fixture.name}: material ${node.id} was lit by a real event`);
    }
    void touched;
  }
});

/* ---- the state machine, with snapshots written in the contract vocabulary --------------- */

function snapshot(overrides = {}) {
  return {
    v: 1,
    aliasVersion: 1,
    seq: 1,
    now: '2026-11-12T03:20:11Z',
    stalledAfterMs: 20000,
    eventsFromSeq: 1,
    agents: [],
    events: [],
    ...overrides,
  };
}

function agent(id, state, extra = {}) {
  return {
    id,
    label: id,
    role: extra.role ?? 'worker',
    parentId: extra.parentId ?? 'root',
    ticketId: null,
    state,
    since: '2026-11-12T03:20:00Z',
    stalled: false,
    lastEvent: null,
  };
}

test('the centre is a state word, never the task name', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    agents: [{ ...agent('worker', 'running', { role: 'worker', parentId: 'root' }), label: '核对代码' }],
    events: [{ seq: 1, agentId: 'worker', kind: 'state.changed', at: '2026-11-12T03:20:11Z', tool: null, from: 'idle', to: 'running', reason: 'turn_started' }],
  }), 0, { sessionId: 's' });
  assert.equal(view.state, 'running');
  // §5.4: the label is still stored, but the field stopped repeating the task.
  assert.equal(centerText(view).main, '思考中');
  assert.equal(centerText(view).sub, '');
});

test('a bare role name never becomes the task line', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    agents: [agent('worker', 'running', { role: 'worker' })],
    events: [{ seq: 1, agentId: 'worker', kind: 'state.changed', at: '2026-11-12T03:20:11Z', tool: null, from: 'idle', to: 'running', reason: 'turn_started' }],
  }), 0, { sessionId: 's' });
  assert.equal(centerText(view).main, '思考中', 'a placeholder word is better than a role name');
});

test('a delegation from the root lights no seat of its own', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    seq: 3,
    agents: [agent('root', 'running', { role: 'root', parentId: null }), agent('w1', 'running')],
    events: [
      { seq: 1, agentId: 'root', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'root', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'subagent' },
      { seq: 3, agentId: 'root', kind: 'state.changed', at: '2026-11-12T03:20:02Z', tool: null, from: 'idle', to: 'running', reason: 'turn_started' },
    ],
  }), 0, { sessionId: 's' });
  assert.equal(view.materials.size, 0, 'a delegation is not a material');
  assert.equal(view.agents.size, 2, 'the root and the child seat');
});

test('a question is not a material and outranks activity', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    seq: 3,
    agents: [agent('worker', 'waiting-human')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'worker', kind: 'attention.raised', at: '2026-11-12T03:20:01Z', tool: null },
      { seq: 3, agentId: 'worker', kind: 'state.changed', at: '2026-11-12T03:20:01Z', tool: null, from: 'running', to: 'waiting-human', reason: 'confirmation_pending' },
    ],
  }), 0, { sessionId: 's' });
  assert.equal(view.materials.size, 0, 'an ask draws nothing on the ring');
  assert.equal(view.state, 'waiting-human');
  assert.equal(view.pending, true);
  assert.equal(centerText(view).main, '等你确认');
});

test('a failure says what survived, without naming a step', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    seq: 6,
    agents: [agent('worker', 'failed')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'read' },
      { seq: 3, agentId: 'worker', kind: 'tool.end', at: '2026-11-12T03:20:02Z', tool: 'read' },
      { seq: 4, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:03Z', tool: 'bash' },
      { seq: 5, agentId: 'worker', kind: 'state.changed', at: '2026-11-12T03:20:04Z', tool: null, from: 'running', to: 'failed', reason: 'turn_ended' },
      { seq: 6, agentId: 'worker', kind: 'turn.end', at: '2026-11-12T03:20:04Z', tool: null, reason: 'failed' },
    ],
  }), 0, { sessionId: 's' });
  const center = centerText(view);
  assert.equal(center.main, '失败', '§5.3: the run says 失败, the material says 完成');
  assert.equal(center.sub, '前面的结果已保留', 'no step is named: material failure is not observable');
  assert.ok(view.materials.get('doc').state === 'done');
});

test('an interrupted close is an end, not a red ring', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    seq: 4,
    agents: [agent('worker', 'idle')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'bash' },
      { seq: 3, agentId: 'worker', kind: 'tool.end', at: '2026-11-12T03:20:02Z', tool: 'bash', reason: 'interrupted', synthetic: true },
      { seq: 4, agentId: 'worker', kind: 'state.changed', at: '2026-11-12T03:20:02Z', tool: null, from: 'running', to: 'idle', reason: 'cancelled' },
    ],
  }), 0, { sessionId: 's' });
  assert.equal(view.materials.get('shell').state, 'done');
  assert.equal(view.state, 'idle');
  assert.equal(centerText(view).main, '待命');
});

test('an event-window hole syncs state without animating', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    seq: 900,
    eventsFromSeq: 900,
    agents: [agent('worker', 'running')],
    events: [{ seq: 900, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:05Z', tool: 'read' }],
  }), 0, { sessionId: 's' });
  assert.equal(view.gap, true);
  assert.equal(view.pulses.length, 0, '§2.1: skip the animation');
  assert.equal(view.materials.get('doc').state, 'running', 'but the state still lands');
});

test('an alias version this build does not ship degrades labels only', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    aliasVersion: 99,
    seq: 2,
    agents: [agent('worker', 'running')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'read' },
    ],
  }), 0, { sessionId: 's' });
  assert.equal(view.aliasOk, false);
  assert.equal(view.materials.get('other').label, '其它');
  assert.equal(view.state, 'running', 'the state still shows');
});

test('a v2 orchestrator snapshot displays a native CSV workflow in the document seat', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    aliasVersion: 2,
    seq: 2,
    agents: [agent('worker', 'running')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'collab_csv_workflow' },
    ],
  }), 0, { sessionId: 's' });
  assert.equal(view.aliasOk, true);
  assert.equal(view.materials.get('doc').label, '文档');
  assert.equal(view.materials.has('other'), false);
});

test('stalled is copied, never computed by the client', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({ agents: [{ ...agent('worker', 'running'), stalled: true }] }), 0, { sessionId: 's' });
  assert.equal(view.stalled, true);
  for (let tick = 0; tick < 120000; tick += 1000) stepLifecycle(view, tick);
  assert.equal(view.stalled, true, 'silence never changes the flag');
  foldSnapshot(view, snapshot({ agents: [agent('worker', 'running')] }), 121000, { sessionId: 's' });
  assert.equal(view.stalled, false);
});

test('a session switch resets the field', () => {
  const view = createView({ sessionId: 's1', now: 0 });
  foldSnapshot(view, snapshot({ seq: 2, agents: [agent('a', 'running')], events: [
    { seq: 1, agentId: 'a', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
    { seq: 2, agentId: 'a', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'read' },
  ] }), 0, { sessionId: 's1' });
  assert.equal(view.materials.size, 1);
  foldSnapshot(view, snapshot({ seq: 0, agents: [] }), 0, { sessionId: 's2' });
  assert.equal(view.sessionId, 's2');
  assert.equal(view.materials.size, 0);
  assert.equal(view.cursor, 0);
  assert.equal(view.taskId, null);
});

test('a fresh page is not "offline" just because the route is not up yet', () => {
  // A restart brings the page up before the Host half registers its route; the
  // first polls fail on a healthy install, so they must not raise the pill.
  const fresh = { online: null, attempts: 0, everOnline: false, since: 0 };
  const first = nextOnline(fresh, 'fail', 1000);
  assert.equal(first.online, null, 'still connecting');
  assert.equal(shouldShowOffline('s', first.online), false);
  const second = nextOnline(first, 'fail', 1320);
  assert.equal(second.online, null, 'still connecting after two tries');
  // Three failures but only 640ms: a slow boot still must not paint an outage.
  const third = nextOnline(second, 'fail', 1640);
  assert.equal(third.online, null, 'the minimum window has not elapsed');
  const later = nextOnline(third, 'fail', 3800);
  assert.equal(later.online, false, 'enough failures and enough time is a real outage');
  assert.equal(shouldShowOffline('s', later.online), true);
});

test('a connection that was already up reports a loss immediately', () => {
  const connected = nextOnline({ online: null, attempts: 0, everOnline: false, since: 0 }, 'ok');
  assert.equal(connected.online, true);
  assert.equal(shouldShowOffline('s', connected.online), false);
  const lost = nextOnline(connected, 'fail', 5000);
  assert.equal(lost.online, false, 'a page that was online knows what a failure means');
  assert.equal(lost.attempts, 1);
});

test('no session id means no pill at all', () => {
  assert.equal(shouldShowOffline(null, false), false);
});

test('a stale answer for another session is dropped', () => {
  assert.equal(isStaleAnswer('a', 'a', 'a'), false, 'the current session answers itself');
  assert.equal(isStaleAnswer('a', 'b', 'a'), true, 'the page already moved to b');
  assert.equal(isStaleAnswer('a', 'a', 'b'), true, 'the body names another session');
  assert.equal(isStaleAnswer('a', 'a', undefined), false, 'a body without meta still applies');
});

test('an agent the snapshot no longer declares leaves the view', () => {
  const view = createView({ sessionId: 's', now: 0 });
  const running = {
    seq: 2,
    now: '2026-11-12T03:20:02Z',
    agents: [
      { ...agent('root', 'running', { role: 'root' }), parentId: null },
      { ...agent('child', 'running', { role: 'worker', parentId: 'root' }) },
    ],
    events: [],
  };
  foldSnapshot(view, running, 0, { sessionId: 's' });
  assert.equal(view.agents.size, 2, 'both agents are in the run');
  assert.equal(aggregateState(view.agents), 'running');

  // The child finished and the projection dropped it: the field must not keep it.
  const retired = { ...running, seq: 3, agents: [{ ...agent('root', 'done', { role: 'root' }), parentId: null }] };
  foldSnapshot(view, retired, 0, { sessionId: 's' });
  assert.equal(view.agents.size, 1, 'the retired child is gone');
  assert.equal(view.agents.has('child'), false);
  assert.equal(aggregateState(view.agents), 'done', 'so the run can finish');
});

test('the field is gated by the setting and the session shortcut', () => {
  assert.equal(focusGate(true, false), true, 'setting on, no override');
  assert.equal(focusGate(undefined, false), true, 'an absent setting means on');
  assert.equal(focusGate(null, false), true);
  assert.equal(focusGate(false, false), false, 'the saved setting wins');
  assert.equal(focusGate(true, true), false, 'the shortcut silences without saving');
  assert.equal(focusGate(false, true), false);
});

test('a task first seen while it already waits for an answer still opens', () => {
  const base = { taskId: null, active: false, dismissedTaskId: null, state: 'idle' };
  const asked = { ...createView({ sessionId: 's', now: 0 }), taskId: 't1', state: 'waiting-human', pending: true };
  const focus = nextFocus(base, asked);
  assert.equal(focus.active, true, 'the question belongs to this task; the field must not go blank');
  assert.equal(focus.reason, 'new-task');
});

test('a question keeps the field, and answering it keeps it too', () => {
  const base = { taskId: null, active: false, dismissedTaskId: null, state: 'idle' };
  const running = { ...createView({ sessionId: 's', now: 0 }), taskId: 't1', state: 'running' };
  const asked = { ...running, state: 'waiting-human', pending: true };
  const answered = { ...running, state: 'running' };
  const done = { ...running, state: 'done' };

  const opened = nextFocus(base, running);
  assert.equal(opened.active, true);
  assert.equal(opened.reason, 'new-task');
  const duringAsk = nextFocus(opened, asked);
  assert.equal(duringAsk.active, true, 'the ask surface floats above the field; the field stays');
  assert.equal(duringAsk.reason, 'ask');
  const afterAnswer = nextFocus(duringAsk, answered);
  assert.equal(afterAnswer.active, true);
  const terminal = nextFocus(afterAnswer, done);
  assert.equal(terminal.active, true, '§4.4: completion never closes the field itself');
});

test('a question does not undo an explicit dismissal', () => {
  const view = { ...createView({ sessionId: 's', now: 0 }), taskId: 't1', state: 'waiting-human', pending: true };
  const dismissed = { taskId: 't1', active: false, dismissedTaskId: 't1', state: 'waiting-human' };
  const stay = nextFocus(dismissed, view);
  assert.equal(stay.active, false, 'the field was dismissed on purpose');
  assert.equal(stay.dismissedTaskId, 't1');
});

test('dismissal holds for one task only', () => {
  const view = { ...createView({ sessionId: 's', now: 0 }), taskId: 't1', state: 'running' };
  const dismissed = { taskId: 't1', active: false, dismissedTaskId: 't1', state: 'running' };
  assert.equal(nextFocus(dismissed, view).active, false);
  const renamed = nextFocus(dismissed, { ...view, taskId: 't2' });
  assert.equal(renamed.active, true);
  assert.equal(renamed.dismissedTaskId, null);
});

test('the capsule carries a colour and a word, never colour alone', () => {
  const view = { ...createView({ sessionId: 's', now: 0 }), taskId: 't1', state: 'waiting-human' };
  const capsule = capsuleOf(view);
  assert.equal(capsule.label, '等你确认');
  assert.equal(capsule.color, '#f2b544');
});

test('a waiting material stops breathing but stays lit', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({ seq: 2, agents: [agent('worker', 'waiting-human')], events: [
    { seq: 1, agentId: 'worker', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
    { seq: 2, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'read' },
  ] }), 0, { sessionId: 's' });
  view.materials.get('doc').state = 'waiting-human';
  for (let tick = 0; tick < 12000; tick += 16) stepLifecycle(view, tick);
  assert.ok(view.materials.get('doc').alpha > 0.99);
});

test('pulses are gated per node and capped', () => {
  const view = createView({ sessionId: 's', now: 0 });
  const events = [{ seq: 1, agentId: 'w', kind: 'turn.start', at: 0, tool: null }];
  for (let index = 0; index < CAPS.pulses + 20; index += 1) {
    events.push({ seq: index + 2, agentId: 'w', kind: 'tool.start', at: 100 + index * TIMING.pulseGapMs, tool: 'read' });
  }
  foldSnapshot(view, snapshot({ seq: events.length, agents: [agent('w', 'running')], events }), 20000, { sessionId: 's' });
  assert.ok(view.pulses.length <= CAPS.pulses);
  const before = view.pulses.length;
  foldSnapshot(view, snapshot({ seq: events.length + 1, agents: [agent('w', 'running')], events: [
    ...events,
    { seq: events.length + 1, agentId: 'w', kind: 'tool.start', at: 100 + (events.length - 1) * TIMING.pulseGapMs + 50, tool: 'read' },
  ] }), 20000, { sessionId: 's' });
  assert.equal(view.pulses.length - before <= 1, true, 'a 50ms repeat is gate-suppressed');
});

test('aggregate state prefers a question, then activity, then outcome', () => {
  const nodes = values => new Map(values.map(([id, state]) => [id, { id, state, role: 'worker', parentId: 'root' }]));
  assert.equal(aggregateState(nodes([])), 'idle');
  assert.equal(aggregateState(nodes([['a', 'running'], ['b', 'waiting-human']])), 'waiting-human');
  assert.equal(aggregateState(nodes([['a', 'done'], ['b', 'running']])), 'running');
  assert.equal(aggregateState(nodes([['a', 'done'], ['b', 'failed']])), 'failed');
  assert.equal(aggregateState(nodes([['a', 'done']])), 'done');
  assert.equal(aggregateState(nodes([['a', 'done'], ['b', 'idle']])), 'done');
});

test('bookkeeping says 计划中, and a material names the object', () => {
  const planning = createView({ sessionId: 's', now: 0 });
  foldSnapshot(planning, snapshot({
    seq: 2,
    agents: [agent('worker', 'running')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'todo_write' },
    ],
  }), 0, { sessionId: 's' });
  assert.equal(planning.materials.size, 0, '§2.2: bookkeeping draws nothing on the ring');
  assert.equal(centerText(planning).main, '计划中');
  assert.equal(centerText(planning).sub, '');

  const working = createView({ sessionId: 's', now: 0 });
  foldSnapshot(working, snapshot({
    seq: 2,
    agents: [agent('worker', 'running')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'grep' },
    ],
  }), 0, { sessionId: 's' });
  assert.equal(centerText(working).main, '执行中');
  assert.equal(centerText(working).sub, '检索', '§5.1: the second line is the object');
});

test('a file call is re-routed to the code seat by the producer hint', () => {
  const view = createView({ sessionId: 's', now: 0 });
  foldSnapshot(view, snapshot({
    seq: 2,
    agents: [agent('worker', 'running')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'worker', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'write' },
    ],
  }), 0, { sessionId: 's', materials: { 2: 'code' } });
  const code = view.materials.get('code');
  assert.ok(code !== undefined, 'the override wins over the alias default');
  assert.equal(code.verb, '编写中');
  assert.equal(view.materials.has('doc'), false);
});

test('a short execution never lights the code seat', () => {
  const view = createView({ sessionId: 's', now: 1000 });
  foldSnapshot(view, snapshot({
    seq: 2,
    agents: [agent('worker', 'running')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: 1000, tool: null },
      { seq: 2, agentId: 'worker', kind: 'tool.start', at: 1000, tool: 'pwsh' },
    ],
  }), 1000, { sessionId: 's', exec: 'python' });
  // 200ms later the call is already over: nothing was promoted, no arc.
  foldSnapshot(view, snapshot({
    seq: 3,
    agents: [agent('worker', 'running')],
    events: [
      { seq: 3, agentId: 'worker', kind: 'tool.end', at: 1200, tool: 'pwsh' },
    ],
  }), 1200, { sessionId: 's', exec: 'python' });
  stepLifecycle(view, 1300);
  assert.equal(view.materials.has('code'), false, '§6.4: under minExecMs nothing shows');
  assert.equal(view.links.length, 0);
});

test('a long execution promotes the code seat and draws one arc', () => {
  const view = createView({ sessionId: 's', now: 1000 });
  foldSnapshot(view, snapshot({
    seq: 2,
    agents: [agent('worker', 'running')],
    events: [
      { seq: 1, agentId: 'worker', kind: 'turn.start', at: 1000, tool: null },
      { seq: 2, agentId: 'worker', kind: 'tool.start', at: 1000, tool: 'pwsh' },
    ],
  }), 1000, { sessionId: 's', exec: 'python' });
  stepLifecycle(view, 1000 + TIMING.minExecMs + 16);
  const code = view.materials.get('code');
  assert.ok(code !== undefined, 'the code seat lit up');
  assert.equal(code.verb, '执行中');
  assert.equal(code.executing, true);
  assert.equal(view.links.length, 1, '§3: exactly one pre-set arc');
  // The centre names the subject, not the transport.
  assert.equal(centerText(view).sub, 'Python');
});
