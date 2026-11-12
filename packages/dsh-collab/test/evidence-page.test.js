import test from 'node:test';
import assert from 'node:assert/strict';
import { readEvidencePage } from '../src/evidence-page.js';

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
