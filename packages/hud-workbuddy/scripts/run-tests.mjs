/**
 * Single-process assertions. No child processes, no network, no DOM.
 * Run with: node scripts/run-tests.mjs
 */
import assert from 'node:assert/strict';
import { createAdapter, applyHook, snapshotFor, EVENT_WINDOW, STALLED_AFTER_MS } from '../lib/adapter.js';
import { normalizeTool } from '../lib/tool-map.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exit(1);
  }
};

const REQUIRED = ['v', 'aliasVersion', 'seq', 'now', 'agents', 'events', 'eventsFromSeq', 'stalledAfterMs'];
const AGENT_REQUIRED = ['id', 'label', 'role', 'parentId', 'ticketId', 'state', 'since', 'stalled', 'lastEvent'];
const EVENT_REQUIRED = ['seq', 'agentId', 'kind', 'at', 'tool'];

function assertContract(snapshot) {
  for (const key of REQUIRED) assert.ok(Object.hasOwn(snapshot, key), `missing ${key}`);
  assert.equal(snapshot.v, 1);
  assert.ok(Number.isInteger(snapshot.aliasVersion) && snapshot.aliasVersion >= 1);
  assert.ok(Number.isInteger(snapshot.seq) && snapshot.seq >= 0);
  assert.ok(Number.isFinite(Date.parse(snapshot.now)));
  assert.equal(snapshot.stalledAfterMs, STALLED_AFTER_MS);
  for (const event of snapshot.events) {
    for (const key of EVENT_REQUIRED) assert.ok(Object.hasOwn(event, key), `event missing ${key}`);
    assert.ok(Number.isInteger(event.seq) && event.seq >= 1);
    if (event.kind === 'state.changed') {
      assert.ok(Object.hasOwn(event, 'from') && Object.hasOwn(event, 'to') && Object.hasOwn(event, 'reason'));
    }
  }
  for (const agent of snapshot.agents) {
    for (const key of AGENT_REQUIRED) assert.ok(Object.hasOwn(agent, key), `agent missing ${key}`);
    assert.ok(agent.label.length <= 12, `label too long: ${agent.label}`);
    assert.ok(['idle', 'running', 'waiting-human', 'done', 'failed'].includes(agent.state));
  }
}

test('tool names map into the shared alias vocabulary', () => {
  assert.equal(normalizeTool('Bash'), 'bash');
  assert.equal(normalizeTool('PowerShell'), 'pwsh');
  assert.equal(normalizeTool('WebFetch'), 'web_fetch');
  assert.equal(normalizeTool('WebSearch'), 'web_search');
  assert.equal(normalizeTool('Read'), 'read');
  assert.equal(normalizeTool('Agent'), 'subagent');
  assert.equal(normalizeTool('mcp__foo__web_fetch'), 'web_fetch');
  assert.equal(normalizeTool('mcp__github__read_file'), null);
  assert.equal(normalizeTool('not_a_real_tool'), null);
  assert.equal(normalizeTool(null), null);
});

test('an empty session is still a valid snapshot', () => {
  const adapter = createAdapter();
  assertContract(adapter.snapshotFor('none'));
  assert.equal(adapter.snapshotFor('none').events.length, 0);
});

test('the hook lifecycle produces the expected event kinds', () => {
  const adapter = createAdapter();
  const feed = [
    ['SessionStart', { source: 'startup' }, ['agent.register']],
    ['UserPromptSubmit', { prompt: '测试 HUD' }, ['turn.start']],
    ['PreToolUse', { tool_name: 'WebFetch' }, ['tool.start']],
    ['PostToolUse', { tool_name: 'WebFetch' }, ['tool.end']],
    ['PermissionRequest', {}, ['attention.raised']],
    ['PermissionDenied', {}, ['attention.resolved']],
    ['Stop', {}, ['turn.end']],
  ];
  for (const [hook_event_name, extra, expected] of feed) {
    const result = adapter.ingest({ session_id: 's1', hook_event_name, ...extra });
    assert.deepEqual(result.applied, expected, hook_event_name);
  }
  const snapshot = adapter.snapshotFor('s1');
  assertContract(snapshot);
  assert.equal(snapshot.agents[0].state, 'done');
  assert.equal(snapshot.agents[0].lastEvent.kind, 'state.changed');
  assert.equal(adapter.taskTextOf('s1'), '测试 HUD');
  const transitions = snapshot.events.filter(e => e.kind === 'state.changed');
  assert.deepEqual(transitions.map(e => `${e.from}->${e.to}`), ['idle->running', 'running->waiting-human', 'waiting-human->running', 'running->done']);
});

test('tool.start carries a mapped tool, not the WorkBuddy name', () => {
  const adapter = createAdapter();
  adapter.ingest({ session_id: 's2', hook_event_name: 'PreToolUse', tool_name: 'PowerShell' });
  const start = adapter.snapshotFor('s2').events.find(e => e.kind === 'tool.start');
  assert.equal(start.tool, 'pwsh');
});

test('subagents become worker seats with a parent', () => {
  const adapter = createAdapter();
  adapter.ingest({ session_id: 's3', hook_event_name: 'SubagentStart', agent_id: 'a1', description: '核对材料' });
  const snapshot = adapter.snapshotFor('s3');
  assertContract(snapshot);
  const worker = snapshot.agents.find(a => a.role === 'worker');
  assert.ok(worker !== undefined);
  assert.equal(worker.parentId, 's3');
  assert.equal(worker.state, 'running');
  adapter.ingest({ session_id: 's3', hook_event_name: 'SubagentStop', agent_id: 'a1' });
  assert.equal(adapter.snapshotFor('s3').agents.find(a => a.role === 'worker').state, 'done');
});

test('stalled is stamped by the producer from lastActivity', () => {
  const adapter = createAdapter();
  const now = Date.now();
  adapter.ingest({ session_id: 's4', hook_event_name: 'UserPromptSubmit', prompt: 'x' }, { at: now });
  const fresh = adapter.snapshotFor('s4');
  assert.equal(fresh.agents[0].stalled, false);
  const stale = snapshotFor(
    { ...adapter.sessions.get('s4'), agents: new Map([...adapter.sessions.get('s4').agents].map(([k, a]) => [k, { ...a }])) },
    { at: now + STALLED_AFTER_MS + 1 },
  );
  assert.equal(stale.agents[0].stalled, true);
});

test('the event window is capped at 256', () => {
  const adapter = createAdapter();
  for (let i = 0; i < EVENT_WINDOW + 40; i += 1) {
    adapter.ingest({ session_id: 's5', hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  }
  const snapshot = adapter.snapshotFor('s5');
  assert.equal(snapshot.events.length, EVENT_WINDOW);
  assert.equal(snapshot.eventsFromSeq, snapshot.events[0].seq);
});

test('Notification does not double-count a permission prompt', () => {
  const session = {
    id: 's6', seq: 0, events: [], agents: new Map(), taskText: '', lastActivity: Date.now(),
  };
  assert.deepEqual(applyHook(session, { hook_event_name: 'Notification', matcher: 'permission_prompt' }), []);
});

test('events from different sessions never mix', () => {
  const adapter = createAdapter();
  adapter.ingest({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'A' });
  adapter.ingest({ session_id: 'b', hook_event_name: 'UserPromptSubmit', prompt: 'B' });
  assert.equal(adapter.snapshotFor('a').events.length, 2);
  assert.equal(adapter.snapshotFor('b').events.length, 2);
  assert.notEqual(adapter.snapshotFor('a').events[0].agentId, adapter.snapshotFor('b').events[0].agentId);
});

console.log(`tests ${passed} / pass ${passed} / fail 0`);
