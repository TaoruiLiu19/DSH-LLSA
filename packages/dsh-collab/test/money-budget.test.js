import test from 'node:test';
import assert from 'node:assert/strict';
import { MoneyBudget, validateMoneyPolicy } from '../src/money-budget.js';
export const price = {id:'fixture',provider:'fixture',model:'m',currency:'USD',source:'test-only',perMillion:{cacheHit:1,cacheMiss:2,cacheWrite:2,output:4}};
export const policy = {id:'test-period',currency:'USD',maxCost:.001,maxRunCost:.001,maxBranchCost:.001,reserveMultiplier:1,prices:[price]};
const request = {runId:'r',branchId:'w',callId:'a',provider:'fixture',model:'m',estimatedInputTokens:100,maxOutputTokens:50};
function fixture(overrides={}) {
  const events=[],usage=[];
  const store={listRuns:()=>[{id:'r'},{id:'other'}],eventsByKind:(id,kind)=>events.filter(e=>e.runId===id&&e.kind===kind),
    appendEvent:e=>events.push(e),usageSummary:id=>({usage:usage.filter(c=>c.runId===id)})};
  return {store,events,usage,budget:new MoneyBudget(store,{...policy,...overrides})};
}
test('parallel branches and runs share durable period admission; duplicate reservations are idempotent',()=>{
  const {store,budget,events}=fixture();
  budget.reserve(request);budget.reserve(request);
  budget.reserve({...request,runId:'other',branchId:'root',callId:'b'});
  assert.equal(events.filter(e=>e.kind==='money_reserved').length,2);
  assert.throws(()=>budget.reserve({...request,callId:'c'}),{code:'MONEY_BUDGET'});
  const resumed=new MoneyBudget(store,policy);
  assert.throws(()=>resumed.reserve({...request,callId:'d'}),{code:'MONEY_BUDGET'});
  assert.equal(resumed.snapshot('r').unsettledCalls,1);
  assert.equal(events.filter(e=>e.kind==='money_warning'&&e.payload.scope==='period').length,1);
  assert.throws(()=>budget.reserve({...request,maxOutputTokens:51}),{code:'MONEY_RESERVATION_CONFLICT'});
});
test('partial usage holds reservation; complete usage replaces it once at pinned prices',()=>{
  const {store,budget,usage}=fixture();budget.reserve(request);
  usage.push({runId:'r',callId:'a',provider:'fixture',model:'m',inputTokens:100,uncachedInputTokens:20,cachedInputTokens:80,cacheWriteTokens:0,outputTokens:null});
  assert.equal(budget.snapshot('r','w').scopes.branch.committed,.0004);
  usage[0].outputTokens=10;
  assert.equal(budget.snapshot('r','w').unsettledCalls,0);
  assert.ok(Math.abs(budget.snapshot('r','w').scopes.branch.committed-.00016)<1e-8);
  const changed=new MoneyBudget(store,{...policy,prices:[{...price,perMillion:{cacheHit:100,cacheMiss:200,cacheWrite:200,output:400}}]});
  assert.equal(changed.snapshot('r','w').scopes.branch.committed,budget.snapshot('r','w').scopes.branch.committed);
});
test('actual excess usage blocks subsequent calls and cannot be hidden by a new branch',()=>{
  const {budget,usage}=fixture();budget.reserve(request);
  usage.push({...request,inputTokens:0,uncachedInputTokens:0,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:500});
  assert.equal(budget.snapshot('r').scopes.period.remaining,0);
  assert.throws(()=>budget.reserve({...request,callId:'b',branchId:'another'}),{code:'MONEY_BUDGET'});
});
test('branch limit remains separate, unknown model is not free and currency changes fail closed',()=>{
  const {budget,store}=fixture({maxBranchCost:.0003});
  assert.throws(()=>budget.reserve(request),{code:'MONEY_BUDGET'});
  assert.equal(budget.snapshot('r').lastBlocked.scope,'branch');
  assert.throws(()=>budget.reserve({...request,model:'unpriced'}),{code:'MONEY_PRICE_MISSING'});
  const accepted=fixture();accepted.budget.reserve(request);
  assert.throws(()=>new MoneyBudget(accepted.store,{...policy,currency:'CNY',prices:[{...price,currency:'CNY'}]}),{code:'INVALID_MONEY_POLICY'});
  assert.equal(store.eventsByKind('r','money_reserved').length,0);
  assert.throws(()=>validateMoneyPolicy({...policy,maxCost:NaN}));
  assert.throws(()=>validateMoneyPolicy({...policy,prices:[price,price]}));
});
