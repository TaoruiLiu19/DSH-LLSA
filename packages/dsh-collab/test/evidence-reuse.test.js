import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { CollaborationStore } from '../src/store.js';
import { CollaborationManager } from '../src/manager.js';
import { readTaskEvidence } from '../src/evidence-page.js';
import { projectEvidenceRead } from '../src/evidence-reuse.js';

const encoding = getEncoding('o200k_base');
const countTokens = text => encoding.encode(text).length;
const tokens = value => countTokens(JSON.stringify(value));
const text = Array.from({ length: 130 }, (_, i) =>
  `step=${i} 中文🙂 status=review-required value=${i * 7} preserve negations; do not deploy without review.`).join('\r\n');

function fixture(t) {
  const scratch = mkdtempDisposableSync(join(tmpdir(), 'llsa-evidence-reuse-'));
  const store = new CollaborationStore({ stateDir: scratch.path });
  const manager = new CollaborationManager({ store });
  manager.bindRoot('worker', { runId: 'r1' });
  t.after(async () => { await manager.close(); store.close(); scratch.remove(); });
  const { artifactRef } = manager.prepareLog('worker', { stepId: 'log', text });
  const args = { ref: artifactRef, start: 0, bytes: 8000, mode: 'auto' };
  const read = (request = args, runId = 'r1', sessionId = 'worker') => {
    const attachment = request.contains ? { label: request.ref, bytes: Buffer.byteLength(text) } : null;
    const result = readTaskEvidence(manager, runId, attachment, request, sessionId);
    return projectEvidenceRead(result, { runId, args: request, countTokens });
  };
  return { store, manager, args, read, scratch };
}

test('an explicit conditional read saves net estimated tokens and keeps the full immutable original recoverable', t => {
  const { store, args, read } = fixture(t);
  const raw = readTaskEvidence({ readArtifact: () => ({ data: Buffer.from(text).subarray(0, 8003),
    totalBytes: Buffer.byteLength(text), mediaType: 'text/plain; charset=utf-8' }) }, 'r1', null, args, 'worker');
  const original = structuredClone(raw);
  const first = read();
  assert.match(first.etag, /^ev1:[a-f0-9]{64}$/);
  const conditionalRequest = { ...args, ifNoneMatch: first.etag };
  const unchanged = read(conditionalRequest);
  assert.equal(unchanged.notModified, true);
  assert.equal(unchanged.bytes, 0);
  assert.equal(unchanged.omittedBytes, first.bytes);
  assert.equal(unchanged.nextStart, first.nextStart);
  assert.equal(unchanged.totalBytes, first.totalBytes);
  assert.equal(unchanged.text, undefined);
  assert.match(unchanged.recovery, /Omit ifNoneMatch/);
  assert.deepEqual(read(), first, 'Omitting the condition always restores the complete page');
  assert.equal(store.readArtifact(args.ref).toString('utf8'), text);
  assert.deepEqual(raw, original, 'Projection does not mutate the read result');

  const baseline = 2 * (tokens(args) + tokens(raw));
  const conditional = tokens(args) + tokens(first) + tokens(conditionalRequest) + tokens(unchanged);
  assert.ok(baseline - conditional >= 128);
  t.diagnostic(`Two-read tool arguments+results estimate: ${baseline} -> ${conditional} o200k_base tokens; excludes system/tool schemas and is not provider billing.`);
});

test('conditions cannot bypass run authorization or archive integrity checks', t => {
  const { manager, store, args, read, scratch } = fixture(t);
  const first = read();
  manager.bindRoot('other', { runId: 'r2' });
  const conditionalRequest = { ...args, ifNoneMatch: first.etag };
  assert.throws(() => read(conditionalRequest, 'r2', 'other'), { code: 'FORBIDDEN' });
  const artifact = store.getArtifact(args.ref);
  writeFileSync(join(scratch.path, 'artifacts', artifact.sha256), 'corrupted bytes');
  assert.throws(() => read(conditionalRequest), { code: 'ARTIFACT_INTEGRITY' });
});

test('a changed selection, content or run returns full content with a new tag', t => {
  const { args, read } = fixture(t);
  const first = read();
  const raw = { ...first }; delete raw.etag;
  for (const options of [
    { runId: 'r2', args },
    { runId: 'r1', args: { ...args, start: 1 } },
    { runId: 'r1', args: { ...args, bytes: 7999 } },
    { runId: 'r1', args: { ...args, contains: 'status' } },
    { runId: 'r1', args, result: { ...raw, text: `${raw.text}\nNew constraint` } },
  ]) {
    const result = projectEvidenceRead(options.result ?? raw, {
      runId: options.runId, args: { ...options.args, ifNoneMatch: first.etag }, countTokens,
    });
    assert.equal(result.notModified, undefined);
    assert.notEqual(result.etag, first.etag);
    assert.equal(result.text, (options.result ?? raw).text);
  }
});

test('paginated originals remain exact after conditional reads and Unicode boundaries survive', t => {
  const { args, read } = fixture(t);
  let start = 0, restored = '';
  do {
    const request = { ...args, start, bytes: 2500 };
    const page = read(request);
    if (page.etag) {
      const unchanged = read({ ...request, ifNoneMatch: page.etag });
      assert.equal(unchanged.notModified, true);
      assert.equal(unchanged.nextStart, page.nextStart);
    }
    const full = read(request);
    restored += full.text; start = full.nextStart;
  } while (start !== null);
  assert.equal(restored, text);
});

test('short and tokenizer-cheap results remain unmodified without tag overhead', () => {
  const args = { ref: 'ref', start: 0, bytes: 8000, mode: 'page' };
  for (const text of ['small exact result', ' '.repeat(8000)]) {
    const result = Object.freeze({ ref: 'ref', start: 0, bytes: Buffer.byteLength(text), totalBytes: Buffer.byteLength(text), nextStart: null, text });
    assert.equal(projectEvidenceRead(result, { runId: 'r', args, countTokens }), result);
  }
  const unsupported = { error: 'permission denied' };
  assert.equal(projectEvidenceRead(unsupported, { runId: 'r', args, countTokens }), unsupported);
});

test('unavailable, invalid or failed token estimates preserve the successful full result', () => {
  const args = { ref: 'ref', start: 0, bytes: 8000, mode: 'page' };
  const result = Object.freeze({ ref: 'ref', start: 0, bytes: Buffer.byteLength(text),
    totalBytes: Buffer.byteLength(text), nextStart: null, text });
  for (const estimate of [undefined, () => NaN, () => -1, () => { throw Error('counter unavailable'); }]) {
    assert.equal(projectEvidenceRead(result, { runId: 'r', args, countTokens: estimate }), result);
  }
});

test('matching-line reads preserve cursors and clipping metadata on an explicit full reread', () => {
  const line = 'x'.repeat(200) + 'KEY' + '中文🙂 test constraint '.repeat(50);
  const data = Buffer.from(Array.from({ length: 9 }, (_, i) => `${i} ${line}`).join('\r\n'));
  const manager = { readArtifact: () => ({ data }) };
  const args = { ref: 'ref', start: 0, bytes: 8000, mode: 'auto', contains: 'KEY' };
  const attachment = { label: 'source', bytes: data.length };
  const raw = readTaskEvidence(manager, 'r', attachment, args, 'worker');
  const first = projectEvidenceRead(raw, { runId: 'r', args, countTokens });
  const repeat = projectEvidenceRead(raw, { runId: 'r', args: { ...args, ifNoneMatch: first.etag }, countTokens });
  assert.equal(repeat.notModified, true);
  assert.equal(repeat.more, true);
  assert.equal(repeat.nextStart, raw.nextStart);
  assert.equal(repeat.matches, undefined);
  assert.ok(first.matches.every(match => match.clipped));
  assert.deepEqual(projectEvidenceRead(raw, { runId: 'r', args, countTokens }).matches, raw.matches);
});
