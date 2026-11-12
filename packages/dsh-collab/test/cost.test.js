import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCallCost, summarizeCosts } from '../src/cost.js';
const price={id:'fixture-price',currency:'USD',provider:'fixture',model:'fixture',source:'test-only',perMillion:{cacheHit:.003,cacheMiss:.15,cacheWrite:.15,output:.6}};
const call=(hit,miss,out)=>({callId:'one',provider:'fixture',model:'fixture',inputTokens:hit+miss,cachedInputTokens:hit,uncachedInputTokens:miss,cacheWriteTokens:0,outputTokens:out});
test('observed lower token count can still have higher cost; all categories are priced once',()=>{
  const before=estimateCallCost(call(1332736,86650,13984),price);
  const after=estimateCallCost(call(1215232,117612,24391),price);
  assert.ok(Math.abs(before.amount-.025386108)<1e-12);
  assert.ok(Math.abs(after.amount-.035922096)<1e-12);
  assert.ok(after.amount>before.amount);
});
test('unknown usage and model mismatch cannot become a zero or complete bill',()=>{
  const usage={...call(10,20,30),outputTokens:null,cost:2,currency:'CNY'};
  const summary=summarizeCosts([usage],price);
  assert.equal(summary.amount,null);assert.equal(summary.unknownCalls,1);
  assert.deepEqual(summary.reportedByCurrency,{CNY:2});
  assert.equal(estimateCallCost({...usage,model:'other'},price).status,'unpriced');
  assert.throws(()=>estimateCallCost({...call(10,20,30),inputTokens:20},price),/do not sum/);
  assert.throws(()=>estimateCallCost(usage,{...price,perMillion:{output:1}}),/price/);
});
