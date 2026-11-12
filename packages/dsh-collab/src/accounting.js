/** Derived accounting only: request/usage IDs are joined, never counted twice. */
export function summarizeAccounting(requests, usage, events) {
  const calls = new Map(requests.map(row => [row.callId, { ...row, usageStatus: 'missing' }]));
  for (const row of usage) calls.set(row.callId, { ...calls.get(row.callId), ...row });
  const rows = [...calls.values()];
  const counts = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'cacheWriteTokens'];
  const complete = row => counts.every(key => Number.isSafeInteger(row[key]) && row[key] >= 0);
  const aggregate = list => {
    const knownTokens = Object.fromEntries(counts.map(key => [key, list.reduce((n, row) => n + (row[key] ?? 0), 0)]));
    const measured = list.filter(complete);
    const measuredInput = measured.reduce((n, row) => n + row.inputTokens, 0);
    const reportedCosts = {};
    for (const row of list) if (Number.isFinite(row.cost) && row.cost >= 0 && row.currency && row.currency !== 'unspecified')
      reportedCosts[row.currency] = (reportedCosts[row.currency] ?? 0) + row.cost;
    return { calls: list.length, completeUsageCalls: measured.length, unknownUsageCalls: list.length - measured.length,
      usageCoverage: list.length ? measured.length / list.length : null,
      knownTokens, cacheHitRateOnCompleteCalls: measuredInput ? measured.reduce((n, row) => n + row.cachedInputTokens, 0) / measuredInput : null,
      reportedCosts, unreportedCostCalls: list.filter(row => !Number.isFinite(row.cost) || !row.currency || row.currency === 'unspecified').length };
  };
  const group = key => {
    const groups = new Map();
    for (const row of rows) { const value = row[key] ?? 'unknown'; if (!groups.has(value)) groups.set(value, []); groups.get(value).push(row); }
    return [...groups].map(([id, list]) => ({ id, ...aggregate(list) }));
  };
  // Count immutable attempt events rather than mutable work-item snapshots.
  const planned = [...new Map(events.filter(e => e.kind === 'work_planned').map(e => [JSON.stringify([e.stepId, e.attemptId]), e])).values()];
  const seen = new Set(), reasons = {}, retries = [];
  for (const event of planned) {
    if (seen.has(event.stepId) || event.payload?.retryOfAttemptId) {
      retries.push(event);
      const reason = event.payload?.retryReason ?? 'unknown'; reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    seen.add(event.stepId);
  }
  const invalidations = new Set(events.filter(e => e.kind === 'input_invalidated').map(e => JSON.stringify([e.stepId, e.attemptId]))).size;
  return { scope: 'managed_recorded_calls_only', ...aggregate(rows),
    byAgent: group('agentId'), byWorkItem: group('workItemId'), byAttempt: group('attemptId'), byPurpose: group('purpose'),
    rework: { initialAssignments: seen.size, attempts: planned.length, retries: retries.length,
      retriesPerInitialAssignment: seen.size ? retries.length / seen.size : null, reasons, invalidatedAttempts: invalidations,
      note: 'Input invalidation and retry may describe the same attempt; do not add them. Unknown causes are not model errors.' } };
}
