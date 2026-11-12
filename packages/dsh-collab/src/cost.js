/** Price snapshots are supplied by the host, not inferred from a model name or cached token count. */
export function estimateCallCost(usage, price) {
  if (!price?.id || !price.currency || !price.provider || !price.model || !price.source)
    throw new Error('A scoped, attributed price snapshot is required');
  const fields = { cachedInputTokens: 'cacheHit', uncachedInputTokens: 'cacheMiss', cacheWriteTokens: 'cacheWrite', outputTokens: 'output' };
  for (const rate of Object.values(fields)) {
    if (!Number.isFinite(price.perMillion?.[rate]) || price.perMillion[rate] < 0)
      throw new Error(`Missing or invalid price: ${rate}`);
  }
  const missing = Object.keys(fields).filter(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0);
  const scopeMatches = usage.provider === price.provider && usage.model === price.model;
  if (!scopeMatches) return { status: 'unpriced', amount: null, knownAmount: null, currency: price.currency, priceId: price.id, missing, reason: 'model_or_provider_mismatch' };
  if (Number.isSafeInteger(usage.inputTokens) && missing.every(key => key === 'outputTokens') &&
      usage.inputTokens !== usage.cachedInputTokens + usage.uncachedInputTokens + usage.cacheWriteTokens)
    throw new Error('Input usage components do not sum to inputTokens');
  const components = Object.fromEntries(Object.entries(fields).map(([field, rate]) =>
    [field, missing.includes(field) ? null : usage[field] * price.perMillion[rate] / 1e6]));
  const knownAmount = Object.values(components).reduce((sum, value) => sum + (value ?? 0), 0);
  return { status: missing.length ? 'partial' : 'estimated', amount: missing.length ? null : knownAmount,
    knownAmount, components, currency: price.currency, priceId: price.id, missing };
}

/** A missing call stays visible; estimates never replace provider-reported account charges. */
export function summarizeCosts(calls, price) {
  const estimates = calls.map(call => ({ callId: call.callId, ...estimateCallCost(call, price) }));
  const unknownCalls = estimates.filter(call => call.status !== 'estimated').length;
  const knownAmount = estimates.reduce((sum, call) => sum + (call.knownAmount ?? 0), 0);
  const reportedByCurrency = {};
  for (const call of calls) if (Number.isFinite(call.cost) && call.cost >= 0 && call.currency && call.currency !== 'unspecified')
    reportedByCurrency[call.currency] = (reportedByCurrency[call.currency] ?? 0) + call.cost;
  return { priceId: price.id, currency: price.currency, amount: unknownCalls ? null : knownAmount,
    knownAmount, unknownCalls, reportedByCurrency, estimates, measurement: 'usage_based_estimate_not_bill' };
}
