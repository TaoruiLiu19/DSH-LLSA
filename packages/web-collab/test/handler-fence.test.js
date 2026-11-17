/**
 * The route fence.
 *
 * The composition's `connection` service is the one place that applies the
 * Host/Origin fence and requires an authenticated live Peer. Every route asks it
 * first; a page that never sends `Origin`, or a local process, is only stopped
 * there — the plugin's own checks cannot stand in for it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { rejectionOf } from '../src/index.js';

test('a rejection from the composition fence is returned verbatim', () => {
  assert.equal(rejectionOf({ requestRejection: () => 403 }, {}), 403);
  assert.equal(rejectionOf({ requestRejection: () => 401 }, {}), 401);
});

test('an admitted request passes through', () => {
  assert.equal(rejectionOf({ requestRejection: () => undefined }, {}), undefined);
});

test('a missing fence or an odd return value never blocks, and never widens the range', () => {
  assert.equal(rejectionOf(undefined, {}), undefined);
  assert.equal(rejectionOf({}, {}), undefined);
  assert.equal(rejectionOf({ requestRejection: () => 0 }, {}), undefined);
  assert.equal(rejectionOf({ requestRejection: () => 302 }, {}), undefined);
  assert.equal(rejectionOf({ requestRejection: () => '403' }, {}), undefined);
  assert.equal(rejectionOf({ requestRejection: () => 500 }, {}), 500);
});

test('the fence sees the request it is judging', () => {
  let seen = null;
  rejectionOf({ requestRejection: request => { seen = request; return undefined; } }, { url: '/web-collab/api/advice' });
  assert.equal(seen.url, '/web-collab/api/advice');
});
