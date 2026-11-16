import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getSnapshot, listRuns, recordHook } from './collector.mjs';
import { hookEvent, newRun, observe, snapshot } from './state.mjs';

const START = Date.parse('2026-11-16T08:00:00.000Z');
const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = fileURLToPath(new URL('./hooks.mjs', import.meta.url));

function fixture(t) {
  const root = fileURLToPath(new URL('../.test-state/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, 'telemetry-'));
  t.after(() => {
    const child = relative(root, home);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    rmSync(home, { recursive: true, force: true });
  });
  const write = (hook_event_name, fields = {}, offset = 0) => recordHook({
    session_id: 'main', turn_id: 'turn-1', hook_event_name, ...fields,
  }, { home, now: new Date(START + offset) });
  const entry = async session => (await listRuns({ home })).find(item => item.label === `Codex ${session.slice(-8)}`);
  const read = async (offset = 0, session = 'main') => {
    const run = await entry(session);
    return run ? getSnapshot(run.runId, { home, now: new Date(START + offset) }) : null;
  };
  return { home, write, read, entry };
}

const agent = (snapshot, id) => snapshot.agents.find(item => item.id === id);

test('empty reads do not create local telemetry, and native parent and nested child lifecycles are retained', async t => {
  const { home, write, read } = fixture(t);
  assert.deepEqual(await listRuns({ home }), []);
  assert.equal(await read(), null);
  assert.equal(existsSync(join(home, 'hud')), false);

  write('SessionStart');
  write('UserPromptSubmit');
  write('SubagentStart', { agent_id: 'explorer-id', agent_type: 'explorer' });
  write('SubagentStart', { session_id: 'explorer-id', agent_id: 'nested-id', agent_type: 'reviewer' }, 1000);
  write('PreToolUse', { session_id: 'nested-id', turn_id: 'child-turn', tool_name: 'apply_patch', tool_use_id: 'tool-1' }, 1000);
  let view = await read(20000);
  assert.equal(view.v, 1);
  assert.equal(view.stalledAfterMs, 20000);
  assert.deepEqual(view.agents.map(item => [item.id, item.parentId, item.label]), [
    ['main', null, 'Codex'], ['explorer-id', 'main', 'Explorer'], ['nested-id', 'explorer-id', 'Reviewer'],
  ]);
  assert.equal(agent(view, 'nested-id').stalled, false);
  view = await read(22000);
  assert.equal(agent(view, 'nested-id').stalled, true);
  assert.equal(agent(view, 'nested-id').lastEvent.tool, 'apply_patch');
  assert.equal(agent(view, 'main').lastEvent.tool, null);
  assert.deepEqual((await listRuns({ home })).map(item => item.label), ['Codex main']);

  write('PostToolUse', { session_id: 'nested-id', turn_id: 'child-turn', tool_name: 'apply_patch', tool_use_id: 'tool-1' }, 22000);
  write('SubagentStop', { session_id: 'explorer-id', agent_id: 'nested-id' }, 23000);
  write('Stop', {}, 24000);
  view = await read(45000);
  assert.equal(agent(view, 'main').state, 'done');
  assert.equal(agent(view, 'explorer-id').state, 'running', 'parent stop cannot prove child termination');
  assert.equal(agent(view, 'nested-id').state, 'done');
  assert.equal(agent(view, 'nested-id').stalled, false);
  assert.equal(view.events.at(-1).seq, view.seq);
  assert.equal(await read(45000, 'explorer-id'), null);
});

test('shared session hooks assign activity to the child and reopen it on an observed follow-up', async t => {
  const { write, read } = fixture(t);
  write('UserPromptSubmit');
  write('SubagentStart', { agent_id: 'child', turn_id: 'child-turn' });
  const tool = { agent_id: 'child', turn_id: 'child-turn', tool_name: 'Bash', tool_use_id: 'child-call' };
  assert.equal(write('PreToolUse', { ...tool, agent_id: 'unknown' }), false);
  write('PreToolUse', tool);
  write('PermissionRequest', tool);
  assert.equal(agent(await read(), 'child').state, 'waiting-human');
  assert.equal(agent(await read(), 'main').state, 'running');
  assert.equal(agent(await read(), 'main').lastEvent.tool, null);
  write('PostToolUse', tool);
  assert.equal(agent(await read(), 'child').state, 'running');
  write('SubagentStop', { agent_id: 'child', turn_id: 'child-turn' });
  assert.equal(agent(await read(), 'child').state, 'done');
  assert.equal(write('PreToolUse', tool), false);
  write('PreToolUse', { ...tool, turn_id: 'follow-up' });
  assert.equal(write('SubagentStop', { agent_id: 'child', turn_id: 'child-turn' }), false);
  assert.equal(agent(await read(), 'child').state, 'running');
  write('SubagentStop', { agent_id: 'child', turn_id: 'follow-up' });
  assert.equal(agent(await read(), 'child').state, 'done');
});

test('permissions pair conservatively with observed tools, clear at interruption, and ignore stale turn events', async t => {
  const { write, read } = fixture(t);
  write('UserPromptSubmit');
  const bash = { tool_name: 'Bash', tool_use_id: 'bash-call' };
  const patch = { tool_name: 'apply_patch', tool_use_id: 'patch-call' };
  write('PreToolUse', bash);
  write('PreToolUse', patch);
  assert.equal(write('PermissionRequest', { tool_name: 'Bash' }), true);
  assert.equal(write('PermissionRequest', { tool_name: 'Bash' }), false, 'same observed call raises once');
  write('PermissionRequest', { tool_name: 'apply_patch' });
  let view = await read(22000);
  assert.equal(agent(view, 'main').state, 'waiting-human');
  assert.equal(agent(view, 'main').stalled, false);
  assert.equal(view.events.filter(event => event.kind === 'attention.raised').length, 2);

  write('PostToolUse', bash, 24000);
  assert.equal(agent(await read(24000), 'main').state, 'waiting-human');
  assert.equal(write('PostToolUse', bash, 24500), false, 'a duplicate tool completion is ignored');
  write('PostToolUse', patch, 25000);
  assert.equal(agent(await read(25000), 'main').state, 'running');

  write('PermissionRequest', { tool_name: 'Bash' }, 26000);
  write('PostToolUse', { tool_name: 'Bash', tool_use_id: 'unrelated-call' }, 26500);
  assert.equal(agent(await read(26500), 'main').state, 'waiting-human', 'an unpaired approval is not resolved by tool name');
  write('Interrupt', {}, 27000);
  assert.equal(write('PostToolUse', bash, 28000), false);
  view = await read(28000);
  assert.equal(agent(view, 'main').state, 'idle');
  assert.equal(view.events.filter(event => event.kind === 'attention.resolved').length, 3);
  write('UserPromptSubmit', { turn_id: 'turn-2' }, 29000);
  assert.equal(write('Stop', {}, 30000), false);
  assert.equal(agent(await read(30000), 'main').state, 'running');
});

test('separate runs cannot claim one another’s children; missing tool coverage does not make up events', async t => {
  const { home, write, read } = fixture(t);
  assert.equal(write('PostToolUse', { tool_name: 'Bash', tool_use_id: 'unknown' }), false);
  assert.deepEqual(await listRuns({ home }), []);
  write('SessionStart');
  write('SubagentStart', { agent_id: 'child' });
  write('SessionStart', { session_id: 'other' });
  assert.equal(write('SubagentStop', { session_id: 'other', agent_id: 'child' }), false);
  assert.equal(write('PreToolUse', { tool_name: 'local\\file', tool_use_id: 'bad' }), false);
  assert.equal(agent(await read(), 'child').state, 'running');
  assert.deepEqual((await read(0, 'other')).agents.map(item => item.id), ['other']);
});

test('collector bounds event and run counts while keeping current state and monotonic cursors', async t => {
  const { home, write, read, entry } = fixture(t);
  const memory = newRun(), at = new Date(START).toISOString();
  const observeEvent = (hook_event_name, fields = {}) => observe(memory, hookEvent({ session_id: 'main', turn_id: 'turn-1', hook_event_name, ...fields }), at);
  observeEvent('UserPromptSubmit');
  for (let index = 0; index < 160; index++) {
    const tool = { tool_name: 'Bash', tool_use_id: `call-${index}` };
    observeEvent('PreToolUse', tool);
    observeEvent('PostToolUse', tool);
  }
  const view = snapshot(memory, new Date(START));
  assert.equal(view.events.length, 256);
  assert.equal(view.eventsFromSeq, view.seq - view.events.length + 1);
  assert.deepEqual(view.events.map(event => event.seq), Array.from({ length: 256 }, (_, index) => view.eventsFromSeq + index));
  assert.equal(agent(view, 'main').state, 'running');
  write('UserPromptSubmit');
  const old = await entry('main');
  for (let index = 0; index < 32; index++) write('SessionStart', { session_id: `other-${index}` }, 200 + index);
  const runs = await listRuns({ home });
  assert.equal(runs.length, 32);
  assert.equal(runs[0].label, 'Codex other-31');
  assert.equal(await read(), null);
  write('SessionStart', {}, 1000);
  assert.notEqual((await entry('main')).runId, old.runId);
  assert.equal(await getSnapshot(old.runId, { home }), null, 'a new generation does not reuse an expired cursor');
});

test('the native hook shell command is quiet and serializes only allowlisted metadata', async t => {
  const { home, read } = fixture(t);
  const config = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const windows = process.platform === 'win32';
  const env = { ...process.env, PLUGIN_ROOT: PLUGIN, CODEX_LEANLINK_HOME: home };
  const secret = 'SENSITIVE-SOURCE-DO-NOT-STORE';
  function hook(name, fields, powershell = false) {
    const { command, commandWindows } = config.hooks[name][0].hooks[0];
    const shell = windows ? (powershell ? 'powershell.exe' : 'cmd.exe') : '/bin/sh';
    const shellArgs = windows
      ? (powershell ? ['-NoProfile', '-Command', commandWindows] : ['/d', '/s', '/c', `"${commandWindows}"`])
      : ['-c', command];
    const result = spawnSync(shell, shellArgs, {
      env, input: JSON.stringify({ hook_event_name: name, session_id: 'main', turn_id: 'turn-1', ...fields }),
      encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: windows && !powershell, timeout: 8000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  hook('UserPromptSubmit', { prompt: secret, cwd: `/repo/${secret}`, transcript_path: `/missing/${secret}` });
  hook('SubagentStart', { agent_id: 'child', agent_type: secret });
  hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tool', tool_input: { command: secret } });
  hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tool', tool_response: secret });
  hook('SubagentStop', { agent_id: 'child', last_assistant_message: secret, agent_transcript_path: secret });
  hook('Stop', { last_assistant_message: secret });
  if (windows) {
    hook('SessionStart', { session_id: 'separate-powershell' }, true);
    assert.equal(agent(await read(0, 'separate-powershell'), 'separate-powershell').state, 'idle');
  }
  assert.equal(agent(await read(), 'child').state, 'done');
  assert.equal(agent(await read(), 'child').label, 'Agent 1');
  assert.equal(agent(await read(), 'main').state, 'done');
  const data = readFileSync(join(home, 'hud', 'activity.sqlite'));
  assert.equal(data.includes(secret), false);
});

test('concurrent hook processes retain every child in the same run', async t => {
  const { home, write, read } = fixture(t);
  write('UserPromptSubmit');
  const processes = Array.from({ length: 12 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', RUNNER], {
      env: { ...process.env, CODEX_LEANLINK_HOME: home }, windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 && output === '') resolve();
      else reject(new Error(`Hook process ${index} exited with ${code}: ${output}`));
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'main', agent_id: `parallel-${index}`, turn_id: 'turn-1' }));
  }));
  await Promise.all(processes);
  const view = await read();
  const children = view.agents.filter(item => item.parentId === 'main');
  assert.deepEqual(new Set(children.map(item => item.id)), new Set(Array.from({ length: 12 }, (_, index) => `parallel-${index}`)));
  assert.equal(view.events.at(-1).seq, view.seq);
});
