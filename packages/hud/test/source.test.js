/**
 * The data source: DSH session events folded into a hud-v1 snapshot, plus the
 * pass-through for an orchestrator that already speaks the contract.
 *
 * Two acceptance criteria are enforced here as source scans rather than prose:
 * §5.5 (the *client* never turns silence into a state) and §5.6 (no tool-output
 * parsing decides a pending state).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_WINDOW,
  STALLED_AFTER_MS,
  createCollector,
  fetchHudSnapshot,
  normalizeHudSnapshot,
  safeTool,
  textOfMessage,
} from '../src/source.js';

const AGENT_KEYS = ['id', 'label', 'role', 'parentId', 'ticketId', 'state', 'since', 'stalled', 'lastEvent'];
const EVENT_REQUIRED = ['seq', 'agentId', 'kind', 'at', 'tool'];
const EVENT_OPTIONAL = ['from', 'to', 'reason', 'synthetic', 'label'];

function assertSnapshotShape(snapshot) {
  assert.deepEqual(Object.keys(snapshot).sort(), ['agents', 'aliasVersion', 'events', 'eventsFromSeq', 'now', 'seq', 'stalledAfterMs', 'v']);
  assert.equal(snapshot.v, 1);
  assert.equal(snapshot.stalledAfterMs, STALLED_AFTER_MS);
  for (const agent of snapshot.agents) {
    assert.deepEqual(Object.keys(agent).sort(), [...AGENT_KEYS].sort(), 'agent shape');
    assert.ok(['idle', 'running', 'waiting-human', 'done', 'failed'].includes(agent.state));
    assert.ok(Array.from(agent.label).length <= 12, 'agent label is capped');
  }
  for (const event of snapshot.events) {
    for (const key of EVENT_REQUIRED) assert.ok(Object.hasOwn(event, key), `event.${key}`);
    for (const key of Object.keys(event)) assert.ok([...EVENT_REQUIRED, ...EVENT_OPTIONAL].includes(key), `event key ${key}`);
    assert.ok(event.tool === null || /^[A-Za-z0-9_.:-]{1,128}$/.test(event.tool), 'tool format');
  }
}

function userMessage(text) {
  return { type: 'user/message', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { role: 'user', content: [{ type: 'text', text }] } };
}

test('file argument hints retain start and end sequence numbers without exposing paths', () => {
  const collector = createCollector();
  collector.observeEvent('s', {type: 'tool/call', time: Date.now(), data: {
    name: 'read', callId: 'file', arguments: JSON.stringify({path: '/private/project/main.ts'})
  }});
  collector.observeEvent('s', {type: 'tool/result', time: Date.now(), data: {message: {toolCallId: 'file'}}});
  const snapshot = collector.snapshotFor('s');
  const tools = snapshot.events.filter(event => event.kind.startsWith('tool.'));
  assert.equal(tools.length, 2);
  for (const event of tools) assert.equal(collector.materialsOf('s')[event.seq], 'code');
  assert.doesNotMatch(JSON.stringify({snapshot, materials: collector.materialsOf('s')}), /private|main.ts/);
});

test('an interrupted execution cannot remain declared in the next turn', () => {
  const collector = createCollector();
  const at = Date.now();
  collector.observeEvent('s', {type: 'turn/start', time: at, data: {turn: 1}});
  collector.observeEvent('s', {type: 'tool/call', time: at, data: {name: 'bash', callId: 'shell', arguments: JSON.stringify({command: 'python task.py'})}});
  assert.equal(collector.execOf('s'), 'python');
  collector.observeEvent('s', {type: 'turn/end', time: at, data: {turn: 1, reason: {kind: 'aborted'}}});
  assert.equal(collector.execOf('s'), null);
  collector.observeEvent('s', {type: 'turn/start', time: at + 1, data: {turn: 2}});
  assert.equal(collector.execOf('s'), null);
});

test('a plain turn becomes a schema-valid snapshot', () => {
  const collector = createCollector();
  collector.observeEvent('s1', userMessage('核对报价单'));
  collector.observeEvent('s1', { type: 'turn/start', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { turn: 1 } });
  collector.observeStatus('s1', 'running');
  collector.observeEvent('s1', { type: 'tool/call', seq: 3, time: Date.parse('2026-11-12T03:20:02Z'), data: { callId: 'c1', name: 'read' } });
  collector.observeEvent('s1', { type: 'tool/result', seq: 4, time: Date.parse('2026-11-12T03:20:03Z'), data: { message: { toolCallId: 'c1' } } });

  const snapshot = collector.snapshotFor('s1', { now: Date.parse('2026-11-12T03:20:04Z') });
  assertSnapshotShape(snapshot);
  assert.deepEqual(snapshot.events.map(event => event.kind), ['turn.start', 'state.changed', 'tool.start', 'tool.end']);
  assert.equal(snapshot.events[0].tool, null, 'a turn event carries no tool');
  assert.equal(snapshot.events[2].tool, 'read');
  assert.equal(snapshot.events[3].tool, 'read');
  assert.equal(snapshot.events[0].seq, 1);
  assert.equal(snapshot.events.at(-1).seq, 4, 'one increasing counter per run');
  assert.equal(snapshot.eventsFromSeq, 1);
  assert.equal(snapshot.agents[0].state, 'running');
  assert.equal(snapshot.agents[0].role, 'root');
  assert.equal(snapshot.agents[0].label, '核对报价单');
  assert.equal(collector.taskTextOf('s1'), '核对报价单');
});

test('a completed turn lands on done, an errored one on failed', () => {
  const ok = createCollector();
  ok.observeEvent('a', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  ok.observeEvent('a', { type: 'turn/end', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(ok.snapshotFor('a').agents[0].state, 'done');

  const bad = createCollector();
  bad.observeEvent('b', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  bad.observeEvent('b', { type: 'turn/end', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } });
  const snapshot = bad.snapshotFor('b');
  assert.equal(snapshot.agents[0].state, 'failed');
  assert.equal(snapshot.events.at(-1).reason, 'turn_ended');
});

test('an aborted turn is a cancellation: interrupted tools and idle', () => {
  const collector = createCollector();
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  collector.observeEvent('s', { type: 'tool/call', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { callId: 'c', name: 'bash' } });
  collector.observeEvent('s', { type: 'turn/end', seq: 3, time: Date.parse('2026-11-12T03:20:02Z'), data: { turn: 1, reason: { kind: 'aborted' } } });
  const snapshot = collector.snapshotFor('s');
  assertSnapshotShape(snapshot);
  assert.equal(snapshot.agents[0].state, 'idle');
  const interrupted = snapshot.events.find(event => event.kind === 'tool.end' && event.tool === 'bash');
  assert.ok(interrupted !== undefined);
  assert.equal(interrupted.synthetic, true);
  assert.equal(interrupted.reason, 'interrupted');
});

test('a question raises attention, and a user message resolves it', () => {
  const collector = createCollector();
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  collector.observeEvent('s', { type: 'tool/call', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { callId: 'ask1', name: 'ask_user_question' } });
  const asked = collector.snapshotFor('s');
  assertSnapshotShape(asked);
  assert.equal(asked.agents[0].state, 'waiting-human');
  const raised = asked.events.find(event => event.kind === 'attention.raised');
  assert.ok(raised !== undefined);
  assert.equal(raised.tool, null);

  // The answer is steered in as a user message: that is what closes the question.
  collector.observeEvent('s', { type: 'user/message', seq: 3, time: Date.parse('2026-11-12T03:20:02Z'), data: { message: { content: [{ type: 'text', text: '用方案 A' }] } } });
  const answered = collector.snapshotFor('s');
  assert.equal(answered.agents[0].state, 'running');
  assert.ok(answered.events.some(event => event.kind === 'attention.resolved'));
});

test('a pending result is not an answer: the result alone keeps the question open', () => {
  // `askTimed` resolves with `{ pending: true }` when the wait times out and the
  // Client never claimed the card. The question is still answerable, so the tool
  // return must not clear the yellow light. The turn boundary does, because a
  // finished turn is not blocked on anybody — see the assertion at the end.
  const collector = createCollector();
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  collector.observeEvent('s', { type: 'tool/call', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { callId: 'ask1', name: 'ask_user_question' } });
  collector.observeEvent('s', { type: 'tool/result', seq: 3, time: Date.parse('2026-11-12T03:20:30Z'), data: { message: { toolCallId: 'ask1', content: [{ type: 'text', text: '{"pending":true}' }] } } });
  const afterResult = collector.snapshotFor('s');
  assert.equal(afterResult.agents[0].state, 'waiting-human', 'a timed-out wait is still a question');
  assert.equal(afterResult.events.filter(event => event.kind === 'attention.raised').length, 1);
  assert.equal(afterResult.events.some(event => event.kind === 'attention.resolved'), false);

  collector.observeEvent('s', { type: 'turn/end', seq: 4, time: Date.parse('2026-11-12T03:20:31Z'), data: { reason: { kind: 'completed' } } });
  const afterTurn = collector.snapshotFor('s');
  assertSnapshotShape(afterTurn);
  assert.equal(afterTurn.agents[0].state, 'done', 'a finished turn is not blocked on the human');
});

test('an answer that only reaches the log is picked up without a reload', () => {
  // Observed in the wild: the question turned the field amber, the person
  // answered, the agent carried on — and no `user/message` ever reached the
  // event stream, so the light stayed amber until the page was reloaded (a
  // reload reconciles once). Reconciliation therefore also runs while a
  // question is open, not only when an event happened to mark the state dirty.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '开始' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'ask1', name: 'ask_user_question' }] },
  ];
  const session = { deriveMessages: () => messages.map(message => ({ ...message })) };
  const collector = createCollector();
  const t0 = Date.parse('2026-11-12T03:20:00Z');
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: t0, data: { turn: 1 } }, session);
  collector.observeEvent('s', { type: 'tool/call', seq: 2, time: t0 + 1000, data: { callId: 'ask1', name: 'ask_user_question' } }, session);
  assert.equal(collector.snapshotFor('s', { now: t0 + 2000 }).agents[0].state, 'waiting-human');

  // The answer lands in the log, but nothing is delivered to the collector.
  messages.push({ role: 'user', content: [{ type: 'text', text: '用方案 A' }] });
  const settled = collector.snapshotFor('s', { now: t0 + 4000 });
  assert.equal(settled.agents[0].state, 'running', 'the log closes the question on its own');
  assert.ok(settled.events.some(event => event.kind === 'attention.resolved'));
});

test('a missed resolution is repaired from the session log', () => {
  // The event window dropped the user message that answered the question; the
  // log still knows the answer came after the ask, so `waiting` must disappear.
  const answeredSession = {
    deriveMessages: () => ([
      { role: 'user', content: [{ type: 'text', text: '开始' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'ask1', name: 'ask_user_question' }] },
      { role: 'user', content: [{ type: 'text', text: '用方案 A' }] },
    ]),
  };
  const collector = createCollector();
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } }, answeredSession);
  collector.observeEvent('s', { type: 'tool/call', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { callId: 'ask1', name: 'ask_user_question' } }, answeredSession);
  const repaired = collector.snapshotFor('s');
  assert.equal(repaired.agents[0].state, 'running', 'the log says the question was answered');

  // The mirror case: the raising event was missed, but the log still has an
  // unanswered ask, so the field must show the question.
  const openSession = {
    deriveMessages: () => ([
      { role: 'user', content: [{ type: 'text', text: '开始' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'ask2', name: 'ask_user_question' }] },
    ]),
  };
  const other = createCollector();
  other.observeEvent('s', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:21:00Z'), data: { turn: 1 } }, openSession);
  const raised = other.snapshotFor('s');
  assertSnapshotShape(raised);
  assert.equal(raised.agents[0].state, 'waiting-human', 'the log says a question is open');
});

test('a log in an unknown shape never clears a real question', () => {
  // If the projection does not expose tool-call blocks this build recognises, the
  // reconciler must stay silent: "no ask found" must not be read as "answered".
  const opaque = { deriveMessages: () => ([{ role: 'user', content: [{ type: 'text', text: '开始' }] }]) };
  const collector = createCollector();
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } }, opaque);
  collector.observeEvent('s', { type: 'tool/call', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { callId: 'ask1', name: 'ask_user_question' } }, opaque);
  const snapshot = collector.snapshotFor('s');
  assert.equal(snapshot.agents[0].state, 'waiting-human', 'an unreadable log keeps the event-derived answer');
});

test('child labels are sanitised and capped like every other label', () => {
  const collector = createCollector();
  const long = 'E:\\work\\projects\\very\\deep\\path\\that\\goes\\on\\and\\on\\assignment.md';
  collector.noteChildren('s', [{ id: 's/child', label: long }]);
  const snapshot = collector.snapshotFor('s', { children: [{ id: 's/child', label: long }] });
  assertSnapshotShape(snapshot);
  const child = snapshot.agents.find(agent => agent.id === 's/child');
  assert.ok(child !== undefined);
  assert.equal([...child.label].length <= 12, true, `label is capped: ${child.label}`);
  assert.equal(child.label.includes('\\'), false, 'no path survives the sanitiser');
});

test('a tool call that arrives without an open turn adopts the turn', () => {
  // The Host half was activated after `turn.start` (install, restart, HMR), so
  // the first thing it sees is a tool call. It must show the run instead of
  // staying blank until the next command.
  const collector = createCollector();
  const at = Date.parse('2026-11-12T03:20:00Z');
  collector.observeEvent('s', { type: 'tool/call', seq: 1, time: at, data: { callId: 'c', name: 'read' } });
  const snapshot = collector.snapshotFor('s');
  assertSnapshotShape(snapshot);
  assert.deepEqual(snapshot.events.map(event => event.kind), ['turn.start', 'state.changed', 'tool.start']);
  assert.equal(snapshot.agents[0].state, 'running');
  assert.equal(snapshot.events.at(-1).tool, 'read');

  collector.observeEvent('s', { type: 'turn/end', seq: 2, time: at + 1000, data: { reason: { kind: 'completed' } } });
  assert.equal(collector.snapshotFor('s').agents[0].state, 'done', 'the adopted turn closes normally');
});

test('published children join the run as worker agents', () => {
  const collector = createCollector();
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  collector.observeEvent('child-1', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:01Z'), data: { turn: 1 } });
  const snapshot = collector.snapshotFor('s', { children: [{ id: 'child-1', label: '核对' }, { id: 'child-2' }] });
  assertSnapshotShape(snapshot);
  const children = snapshot.agents.filter(agent => agent.parentId === 's');
  assert.equal(children.length, 2);
  assert.equal(children[0].label, '核对');
  assert.equal(children[0].state, 'running', 'the child’s own session says running');
  assert.equal(children[1].state, 'running');
  assert.equal(children[1].label, 'worker', 'a missing label falls back to the role');
});

test('the event window keeps the newest events and moves its start', () => {
  const collector = createCollector();
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  for (let index = 0; index < EVENT_WINDOW + 40; index += 1) {
    collector.observeEvent('s', { type: 'tool/call', seq: index + 2, time: Date.parse('2026-11-12T03:20:01Z') + index, data: { callId: `c${index}`, name: 'read' } });
  }
  const snapshot = collector.snapshotFor('s');
  assert.equal(snapshot.events.length, EVENT_WINDOW);
  assert.ok(snapshot.eventsFromSeq > 1);
  assert.equal(snapshot.eventsFromSeq, snapshot.events[0].seq);
});

test('stalled is producer-owned: a running agent goes stale after the threshold', () => {
  const collector = createCollector();
  const start = Date.parse('2026-11-12T03:20:00Z');
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: start, data: { turn: 1 } });
  assert.equal(collector.snapshotFor('s', { now: start + 19_000 }).agents[0].stalled, false);
  assert.equal(collector.snapshotFor('s', { now: start + 21_000 }).agents[0].stalled, true, 'the producer owns the judgement');
  collector.observeEvent('s', { type: 'turn/end', seq: 2, time: start + 22_000, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(collector.snapshotFor('s', { now: start + 120_000 }).agents[0].stalled, false, 'only a running agent can be stalled');
});

test('the collector is bounded by session count', () => {
  const collector = createCollector({ maxSessions: 2 });
  const at = Date.parse('2026-11-12T03:20:00Z');
  collector.observeEvent('a', { type: 'turn/start', seq: 1, time: at, data: { turn: 1 } });
  collector.observeEvent('b', { type: 'turn/start', seq: 1, time: at + 1, data: { turn: 1 } });
  collector.observeEvent('c', { type: 'turn/start', seq: 1, time: at + 2, data: { turn: 1 } });
  assert.equal(collector.sessions.size, 2);
});

test('an unknown session still answers with a valid snapshot', () => {
  const collector = createCollector();
  const snapshot = collector.snapshotFor('never-seen');
  assertSnapshotShape(snapshot);
  assert.deepEqual(snapshot.events, []);
  assert.equal(snapshot.eventsFromSeq, 0);
  assert.equal(snapshot.agents[0].state, 'idle');
});

test('a hud-v1 payload passes through untouched', () => {
  const raw = { v: 1, aliasVersion: 1, seq: 3, now: '2026-11-12T03:20:11Z', stalledAfterMs: 20000, eventsFromSeq: 1, agents: [], events: [] };
  const snapshot = normalizeHudSnapshot(raw, 's1');
  assert.ok(snapshot !== undefined);
  assert.equal(snapshot, raw, 'the frozen contract is not rewritten');
  assert.ok(normalizeHudSnapshot({ snapshot: raw }, 's2') !== undefined);
});

test('a malformed hud payload falls back instead of rendering nothing', () => {
  assert.equal(normalizeHudSnapshot(null, 's'), undefined);
  assert.equal(normalizeHudSnapshot({ v: 2, agents: [], events: [] }, 's'), undefined);
  assert.equal(normalizeHudSnapshot({ v: 1, agents: [] }, 's'), undefined, 'events are required');
  assert.equal(normalizeHudSnapshot({ v: 1, agents: [], events: 'x' }, 's'), undefined);
  assert.equal(normalizeHudSnapshot({ v: 1, agents: [], events: [] }, 's'), undefined, 'seq and aliasVersion are required');
});

test('the orchestrator endpoint is tried without ever blocking the field', async () => {
  const ok = await fetchHudSnapshot('http://x/collab/api/runs/{session}/hud', 'a b', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ v: 1, aliasVersion: 1, seq: 0, eventsFromSeq: 0, agents: [], events: [] }) }),
  });
  assert.ok(ok !== undefined);

  let seen = '';
  await fetchHudSnapshot('http://x/{session}', 'a b', {
    fetchImpl: async url => {
      seen = url;
      return { ok: true, json: async () => ({ v: 1, aliasVersion: 1, seq: 0, eventsFromSeq: 0, agents: [], events: [] }) };
    },
  });
  assert.equal(seen, 'http://x/a%20b', 'the session id is encoded into the template');

  assert.equal(await fetchHudSnapshot('http://x/{session}', 's', { fetchImpl: async () => { throw new Error('offline'); } }), undefined);
  assert.equal(await fetchHudSnapshot('http://x/{session}', 's', { fetchImpl: async () => ({ ok: false }) }), undefined);
  assert.equal(await fetchHudSnapshot('', 's', { fetchImpl: async () => ({ ok: true }) }), undefined);
});

test('tool ids are sanitised to the contract pattern, message text is capped', () => {
  assert.equal(safeTool('read'), 'read');
  assert.equal(safeTool('bad tool'), null);
  assert.equal(safeTool(''), null);
  assert.equal(safeTool(null), null);
  assert.equal(textOfMessage({ content: [{ type: 'text', text: '  核对\n 报价单  ' }] }), '核对 报价单');
  assert.equal(textOfMessage({ content: [{ type: 'image' }] }), '');
  assert.equal(textOfMessage(null), '');
  assert.ok(textOfMessage({ content: [{ type: 'text', text: 'x'.repeat(1000) }] }).length <= 240);
});

/* ---- the two acceptance scans of §5.5 and §5.6 ------------------------------------------ */

const sourceDir = new URL('../src/', import.meta.url);
const sources = Object.fromEntries(
  readdirSync(sourceDir)
    .filter(name => name.endsWith('.js'))
    .map(name => [name, readFileSync(new URL(name, sourceDir), 'utf8')]),
);
/** Files that run in the browser. The Host half stands in for the producer. */
const CLIENT_FILES = ['model.js', 'render.js', 'focus.js', 'client-entry.js'];

test('§5.5: the client never turns time into a state', () => {
  for (const name of CLIENT_FILES) {
    const text = sources[name];
    assert.ok(!/stalledAfterMs/.test(text), `${name} reads the stall threshold`);
    assert.ok(!/Date\.now\(\)\s*-\s*[\w.]+\.(lastAt|since|lastActivity)/.test(text), `${name} derives a state from elapsed wall time`);
    assert.ok(!/idleAfter|quietFor|silenceTimeout|idleTimeout\s*[=:]/.test(text), `${name} has a silence rule`);
    assert.ok(!/setTimeout\(\s*\(\)\s*=>\s*[^)]*state/.test(text), `${name} schedules a state change`);
  }
  // The model copies the per-agent flag and never computes it.
  assert.match(sources['model.js'], /node\.stalled = agent\.stalled === true/);
  assert.match(sources['model.js'], /view\.stalled = \[\.\.\.view\.agents\.values\(\)\]\.some\(node => node\.stalled === true\)/);
  // Elapsed time only drives fades and heat — never a state.
  for (const line of sources['model.js'].split('\n')) {
    if (!/now\s*-\s*[\w.]+/.test(line)) continue;
    assert.ok(!/\.state\s*=/.test(line), `elapsed time assigns a state: ${line.trim()}`);
  }
});

test('§5.6: tool output is never parsed; only the call input yields two enums', () => {
  // The wall stands where it matters: no result body is ever read.
  for (const [name, text] of Object.entries(sources)) {
    assert.ok(!/toolResult\.(content|output|text)/.test(text), `${name} reads tool output`);
  }
  // §7 allows exactly one exception: `argumentsOf` reads the *call's* input to
  // derive two closed enums (a language and a material). It never forwards the
  // text, and it is the only JSON.parse in the package.
  for (const [name, text] of Object.entries(sources)) {
    const parses = (text.match(/JSON\.parse/g) ?? []).length;
    assert.equal(parses, name === 'source.js' ? 1 : 0, `${name}: JSON.parse appears ${parses} time(s)`);
  }
  assert.match(sources['source.js'], /function argumentsOf\(data\)/);
  // The only body read is still the user's own message text.
  const callSites = sources['source.js'].split('\n').filter(line => /textOfMessage\(data\)/.test(line));
  assert.equal(callSites.length, 1, 'textOfMessage runs on the user message only');
  assert.match(sources['source.js'], /case 'user\/message'/);
  // Pending is decided by the call/result identity of the question tool.
  assert.match(sources['source.js'], /name === 'ask_user_question'/);
});
