import test from 'node:test';
import assert from 'node:assert/strict';
import {extractTables,restoreTables} from '../src/input-tables.js';
import {executeComputation} from '../src/computation.js';
test('lossless table slicing retains instructions, unicode, order, types and provenance',()=>{
 const text='前置指令🧪：禁止发布\n[{"id":"001","x":-2},{"id":"002","x":0}]\n后续更正：只筛选第一个，不要擅自求和。';
 const p=extractTables(text,{minBytes:1});assert.equal(p.tables.length,1);assert.equal(restoreTables(p),text);
 const t=p.tables[0];assert.equal(Buffer.from(text).subarray(t.startByte,t.endByte).toString(),t.raw);assert.deepEqual(t.preview,[{id:'001',x:-2},{id:'002',x:0}]);
 p.tables[0].raw='[]';assert.throws(()=>restoreTables(p),/Corrupted/);
});
test('ambiguous duplicate keys and lossy numeric parsing remain original text',()=>{
 for(const text of ['[{"x":1,"x":2}]','[{"x":9007199254740993}]','not a table [1,2,3]']){
  const p=extractTables(text,{minBytes:1});assert.equal(p.tables.length,0);assert.equal(restoreTables(p),text);
 }
});
test('valid exact source can feed existing deterministic contract without model copying rows',()=>{
 const p=extractTables('要求：统计ok=true行。[{"ok":true,"v":5},{"ok":false,"v":9},{"ok":true,"v":-2}]',{minBytes:1});
 const t=p.tables[0],contract={version:'1',inputRef:t.id,rowsPath:[],filter:[{field:'ok',op:'eq',value:true}],operations:[{op:'count',as:'count',unit:'rows'},{op:'sum',field:'v',as:'sum',unit:'integer'}],precision:'safe_integer',nullPolicy:'reject',deduplicate:false};
 const r=executeComputation(contract,t.raw);assert.deepEqual(r.result,{count:2,sum:3});
});
