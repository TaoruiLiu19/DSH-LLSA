import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { startHudServer } from '../hud/serve.mjs';
import { agentForest } from '../hud/web/tree.mjs';

const at = '2026-11-17T07:23:00.000Z';
const agent = (id, parentId, state = 'running') => ({ id, parentId, role: parentId ? 'worker' : 'coordinator',
  label: id, ticketId: null, state, since: at, stalled: false, lastEvent: null });

test('agent tree uses recorded parent IDs, including children that arrive first', () => {
  const roots = agentForest([agent('c', 'b'), agent('orphan', 'missing'), agent('a', null), agent('b', 'a')]);
  assert.deepEqual(roots.map(node => [node.agent.id, node.parentKnown]), [['orphan', false], ['a', true]]);
  assert.equal(roots[1].children[0].agent.id, 'b');
  assert.equal(roots[1].children[0].children[0].agent.id, 'c');
});

test('malformed ancestry remains visible with an unknown link', () => {
  const [self, cyclic] = agentForest([agent('self', 'self'), agent('a', 'b'), agent('b', 'a'), agent('c', 'b')]);
  assert.equal(self.parentKnown, false);
  assert.deepEqual(self.children, []);
  assert.equal(cyclic.parentKnown, false);
  assert.equal(cyclic.agent.id, 'a');
  assert.equal(cyclic.children[0].agent.id, 'b');
  assert.equal(cyclic.children[0].children[0].agent.id, 'c');
});

test('HUD serves two read-only endpoints and only its shared browser assets', async t => {
  const list = [ { runId: 'root', label: 'Codex', lastActivityAt: at } ];
  const snapshot = { v: 1, aliasVersion: 1, seq: 1, now: at, agents: [agent('root', null, 'waiting-human')],
    events: [{ seq: 1, agentId: 'root', kind: 'attention.raised', at, tool: 'exec_command' }],
    eventsFromSeq: 1, stalledAfterMs: 20000 };
  const seen = [];
  const { server, url } = await startHudServer({ data: {
    listRuns: async () => list,
    getSnapshot: async id => { seen.push(id); return id === 'root' ? snapshot : null; },
  } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /LeanLink HUD/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  for (const name of ['app.mjs', 'tree.mjs', 'hud.css', 'shared/render.js', 'shared/model.js', 'shared/materials.js']) {
    const asset = await fetch(url + name);
    assert.equal(asset.status, 200, name);
    assert.ok((await asset.text()).length > 0, name);
  }
  assert.deepEqual(await (await fetch(url + 'api/runs')).json(), { runs: list });
  assert.deepEqual(await (await fetch(url + 'api/snapshot?runId=root')).json(), snapshot);
  const head = await fetch(url + 'api/snapshot?runId=root', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(url + 'api/snapshot?runId=unknown')).status, 404);
  assert.equal((await fetch(url + 'api/snapshot?runId=..%2fcollector.mjs')).status, 400);
  assert.equal((await fetch(url + 'api/snapshot?runId=root&runId=unknown')).status, 400);
  assert.equal((await fetch(url + 'api/snapshot?runId=root', { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + 'api/runs', { headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(url + 'api/runs', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    request(url + 'api/runs', { headers: { host: 'other.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(url + 'collector.mjs')).status, 404);
  assert.equal((await fetch(url + 'shared/source.js')).status, 404);
  assert.deepEqual(seen, ['root', 'root', 'unknown']);
});
