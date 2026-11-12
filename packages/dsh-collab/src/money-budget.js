import { estimateCallCost } from './cost.js';

const SCALE = 1e9;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const units = amount => {
  const value = Math.ceil(amount * SCALE);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(value)) fail('INVALID_MONEY_POLICY', 'Invalid monetary amount');
  return value;
};
const copy = value => JSON.parse(JSON.stringify(value));

/** Host-owned policy. No model tool can change prices or reset its accounting period. */
export function validateMoneyPolicy(input) {
  const policy = copy(input);
  if (!policy?.id || typeof policy.id !== 'string' || !/^[A-Z]{3}$/.test(policy.currency ?? '') ||
      !Array.isArray(policy.prices) || !policy.prices.length) fail('INVALID_MONEY_POLICY', 'Policy needs id, currency and price snapshots');
  for (const key of ['maxCost', 'maxRunCost', 'maxBranchCost'])
    if (units(policy[key]) <= 0) fail('INVALID_MONEY_POLICY', `${key} must be positive`);
  policy.reserveMultiplier ??= 1.25;
  if (!Number.isFinite(policy.reserveMultiplier) || policy.reserveMultiplier < 1 || policy.reserveMultiplier > 10)
    fail('INVALID_MONEY_POLICY', 'reserveMultiplier must be between 1 and 10');
  const keys = new Set();
  for (const price of policy.prices) {
    if (price.currency !== policy.currency) fail('INVALID_MONEY_POLICY', 'Mixed currencies are not supported in one budget');
    estimateCallCost({}, price); // Reuse strict price validation, without fabricating usage.
    const key = JSON.stringify([price.provider, price.model]);
    if (keys.has(key)) fail('INVALID_MONEY_POLICY', 'Duplicate model price');
    keys.add(key);
  }
  return policy;
}

/** Durable reservations survive unknown usage, crashes and operator resume. Amounts are estimates, not a billing cap. */
export class MoneyBudget {
  constructor(store, input) {
    this.store = store;
    this.policy = validateMoneyPolicy(input);
    this.reservations = new Map();
    this.warnings = new Set();
    this.lastBlocks = new Map();
    for (const run of store.listRuns()) {
      for (const event of store.eventsByKind(run.id, 'money_reserved')) {
        const row = event.payload;
        if (row.policyId !== this.policy.id) continue;
        if (row.currency !== this.policy.currency) fail('INVALID_MONEY_POLICY', 'An existing budget period cannot change currency');
        this.reservations.set(row.callId, row);
      }
      for (const event of store.eventsByKind(run.id, 'money_warning'))
        if (event.payload.policyId === this.policy.id) this.warnings.add(event.payload.key);
      const blocks = store.eventsByKind(run.id, 'money_blocked').filter(e => e.payload.policyId === this.policy.id);
      if (blocks.length) this.lastBlocks.set(run.id, blocks.at(-1).payload);
    }
  }
  #usage() {
    const result = new Map();
    for (const runId of new Set([...this.reservations.values()].map(row => row.runId)))
      for (const row of this.store.usageSummary(runId).usage) result.set(row.callId, row);
    return result;
  }
  snapshot(runId, branchId = 'root') {
    const usage = this.#usage();
    const totals = { period: 0, run: 0, branch: 0 };
    const branches = new Map();
    let unsettledCalls = 0, knownCost = 0;
    for (const row of this.reservations.values()) {
      const actual = usage.get(row.callId);
      const priced = actual ? estimateCallCost(actual, row.price) : null;
      const known = units(priced?.knownAmount ?? 0);
      const settled = priced?.status === 'estimated';
      // Partial data cannot free the unobserved portion of a reservation.
      const debit = settled ? known : Math.max(known, row.reservedUnits);
      totals.period += debit;
      if (row.runId === runId) {
        totals.run += debit; knownCost += known;
        branches.set(row.branchId, (branches.get(row.branchId) ?? 0) + debit);
        if (!settled) unsettledCalls++;
        if (row.branchId === branchId) totals.branch += debit;
      }
    }
    const limits = { period: units(this.policy.maxCost), run: units(this.policy.maxRunCost), branch: units(this.policy.maxBranchCost) };
    return { enabled: true, policyId: this.policy.id, currency: this.policy.currency, runId, branchId,
      measurement: 'usage_estimates_plus_unsettled_reservations_not_bill', unsettledCalls, knownCost: knownCost / SCALE,
      scopes: Object.fromEntries(Object.keys(totals).map(key => [key, { limit: limits[key] / SCALE, committed: totals[key] / SCALE, remaining: Math.max(0, limits[key] - totals[key]) / SCALE }])),
      branches: [...branches].map(([id, debit]) => ({branchId:id, committed:debit/SCALE, limit:limits.branch/SCALE, remaining:Math.max(0,limits.branch-debit)/SCALE})),
      lastBlocked: this.lastBlocks.get(runId) ?? null };
  }
  reserve({ runId, branchId = 'root', callId, provider, model, estimatedInputTokens, maxOutputTokens }) {
    const old = this.reservations.get(callId);
    if (old) {
      if (old.runId !== runId || old.branchId !== branchId || old.price.provider !== provider || old.price.model !== model ||
          old.estimatedInputTokens !== estimatedInputTokens || old.maxOutputTokens !== maxOutputTokens)
        fail('MONEY_RESERVATION_CONFLICT', 'Call reservation changed');
      return old;
    }
    const block = (code, scope) => {
      const payload = { policyId: this.policy.id, code, scope, branchId, currency: this.policy.currency };
      if (JSON.stringify(this.lastBlocks.get(runId)) !== JSON.stringify(payload))
        this.store.appendEvent({runId, stepId:branchId, kind:'money_blocked', payload});
      this.lastBlocks.set(runId, payload);
      fail(code, `Money budget blocked ${scope}; no new model request admitted. Review policy and usage before continuing.`);
    };
    const price = this.policy.prices.find(p => p.provider === provider && p.model === model);
    if (!price) return block('MONEY_PRICE_MISSING', 'unpriced_model');
    if (![estimatedInputTokens,maxOutputTokens].every(n => Number.isSafeInteger(n) && n >= 0))
      fail('INVALID_MONEY_ESTIMATE', 'Expected nonnegative token estimates');
    const inputRate = Math.max(price.perMillion.cacheHit, price.perMillion.cacheMiss, price.perMillion.cacheWrite);
    const reservedUnits = units((estimatedInputTokens * inputRate + maxOutputTokens * price.perMillion.output) / 1e6 * this.policy.reserveMultiplier);
    const before = this.snapshot(runId, branchId);
    for (const [key, scope] of Object.entries(before.scopes))
      if (Math.round(scope.committed * SCALE) + reservedUnits > Math.round(scope.limit * SCALE)) return block('MONEY_BUDGET', key);
    const row = { policyId:this.policy.id, currency:this.policy.currency, callId, runId, branchId, estimatedInputTokens, maxOutputTokens,
      reservedUnits, price:copy(price), reserveMultiplier:this.policy.reserveMultiplier };
    this.store.appendEvent({runId,stepId:branchId,kind:'money_reserved',payload:row});
    this.reservations.set(callId,row);
    for (const [scope, value] of Object.entries(before.scopes)) {
      const key = JSON.stringify([scope,scope === 'period' ? null : runId,scope === 'branch' ? branchId : null,value.limit]);
      if ((value.committed + reservedUnits / SCALE) / value.limit >= .8 && !this.warnings.has(key)) {
        this.store.appendEvent({runId,stepId:branchId,kind:'money_warning',payload:{policyId:this.policy.id,key,scope,threshold:.8}});
        this.warnings.add(key);
      }
    }
    return row;
  }
}
