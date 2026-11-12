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

test('a question raises and resolves attention with the tool pair', () => {
  const collector = createCollector();
  collector.observeEvent('s', { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  collector.observeEvent('s', { type: 'tool/call', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { callId: 'ask1', name: 'ask_user_question' } });
  const asked = collector.snapshotFor('s');
  assertSnapshotShape(asked);
  assert.equal(asked.agents[0].state, 'waiting-human');
  const raised = asked.events.find(event => event.kind === 'attention.raised');
  assert.ok(raised !== undefined);
  assert.equal(raised.tool, null);

  collector.observeEvent('s', { type: 'tool/result', seq: 3, time: Date.parse('2026-11-12T03:20:02Z'), data: { message: { toolCallId: 'ask1' } } });
  const answered = collector.snapshotFor('s');
  assert.equal(answered.agents[0].state, 'running');
  assert.ok(answered.events.some(event => event.kind === 'attention.resolved'));
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

test('§5.6: no tool output is parsed to learn a pending state', () => {
  for (const [name, text] of Object.entries(sources)) {
    assert.ok(!/JSON\.parse/.test(text), `${name} parses JSON`);
    assert.ok(!/toolResult\.(content|output|text)/.test(text), `${name} reads tool output`);
  }
  // The only body read is the user's own message text, for the centre line.
  const callSites = sources['source.js'].split('\n').filter(line => /textOfMessage\(data\)/.test(line));
  assert.equal(callSites.length, 1, 'textOfMessage runs on the user message only');
  assert.match(sources['source.js'], /case 'user\/message'/);
  // Pending is decided by the call/result identity of the question tool.
  assert.match(sources['source.js'], /name === 'ask_user_question'/);
});
