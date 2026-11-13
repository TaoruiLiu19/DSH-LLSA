import test from 'node:test';
import assert from 'node:assert/strict';
import { readEvidencePage, inspectAttachment, readTaskEvidence } from '../src/evidence-page.js';

test('parents read small sources directly and can page large originals without another agent', () => {
  for (const text of ['保留完整限制🙂', '不可遗漏的限制🙂\r\n'.repeat(500)]) {
    const data = Buffer.from(text), attachment = {bytes: data.length, label: 'source'};
    let reads = 0;
    const manager = {readArtifact(run, ref, {start = 0, end = data.length}, session) {
      assert.equal(run, 'r'); assert.equal(session, 'parent'); reads++;
      return {data: data.subarray(start, end), totalBytes: data.length};
    }};
    const args = {ref: 'ref', start: 0, bytes: 1000};
    const initial = readTaskEvidence(manager, 'r', attachment, args, 'parent', true);
    if (data.length <= 4096) { assert.equal(initial.text, text); assert.equal(reads, 1); }
    else { assert.equal(initial.bytes, 0); assert.equal(reads, 0); }
    let start = 0, restored = '';
    do {
      const page = readTaskEvidence(manager, 'r', attachment, {...args, start, mode: 'page'}, 'parent', true);
      restored += page.text; start = page.nextStart;
    } while (start !== null);
    assert.equal(restored, text);
    assert.throws(() => readTaskEvidence(manager, 'r', null, {...args, contains: 'ID'}, 'parent'), /attached file/);
  }
});

test('byte pagination preserves every Unicode character and advances to the exact next byte', () => {
  const original='A中文🙂0123不得部署', data=Buffer.from(original);
  const manager={readArtifact(_run,_ref,{start,end}){return {data:data.subarray(start,end),totalBytes:data.length,mediaType:'text/plain'};}};
  for(let pageSize=1;pageSize<12;pageSize++){
    let start=0,restored='';
    for(;;){const page=readEvidencePage(manager,'r','ref',start,pageSize);restored+=page.text;
      assert.ok(page.bytes<=pageSize+3);if(page.nextStart===null)break;
      assert.ok(page.nextStart>start);start=page.nextStart;
    }
    assert.equal(restored,original);
  }
  assert.throws(()=>readEvidencePage(manager,'r','ref',2,4),/UTF-8 page boundary/);
});

test('attachment lookup paginates repeated IDs without losing Unicode lines or rereading the first page', () => {
  const lines = ['说明🌐', ...Array.from({length: 11}, (_, i) => `ID-7 中文🙂 revision=${i}`)];
  const data = Buffer.from(lines.join('\r\n'));
  const attachment = {label: 'Revisions', bytes: data.length};
  const manager = {readArtifact: () => ({data})};
  const collected = [];
  let start = 0;
  for (;;) {
    const page = inspectAttachment(manager, 'r', attachment, 'ref', 'ID-7', 'worker', start);
    assert.ok(page.matches.length <= 4);
    collected.push(...page.matches);
    if (!page.more) { assert.equal(page.nextStart, null); break; }
    assert.ok(page.nextStart > start);
    start = page.nextStart;
  }
  assert.deepEqual(collected.map(m => m.text), lines.slice(1));
  assert.deepEqual(collected.map(m => m.line), Array.from({length: 11}, (_, i) => i + 2));
  assert.throws(() => inspectAttachment(manager, 'r', attachment, 'ref', 'ID-7', 'worker', -1), /cursor/);
});
