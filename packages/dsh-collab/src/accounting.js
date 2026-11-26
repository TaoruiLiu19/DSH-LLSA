/** Observe the prepared request without setting a provider limit or changing its model options. */
export function requestAccountingContext(options, binding, run, fallbackOutputTokens, coordinatorSessionId) {
  const supplied = options.maxTokens;
  const explicit = Number.isSafeInteger(supplied) && supplied > 0;
  const shared = (typeof coordinatorSessionId === 'string' && binding.id === coordinatorSessionId) || isSharedCoordinatorRun(run);
  const task = !shared && run?.source === 'superagent' && typeof run.ticketId === 'string';
  return {
    accountingScope: shared ? 'shared_coordinator' : task ? 'ticket_execution' : 'standalone',
    ticketId: task ? run.ticketId : null,
    assignmentId: task ? run.assignmentId ?? null : null,
    attributionBasis: 'host_run_binding',
    requestLimits: {
      requestedMaxOutputTokens: explicit ? supplied : null,
      observedStatus: supplied == null ? 'not_set' : explicit ? 'explicit' : 'invalid',
      observationBoundary: 'llm_stream_options',
      reservationMaxOutputTokens: supplied ?? fallbackOutputTokens,
      reservationSource: supplied == null ? 'configured_estimate' : 'request_option',
      providerEffectiveLimit: 'unknown',
    },
  };
}

/** Older coordinator runs were created with either source=dsh or source=superagent. */
export function isSharedCoordinatorRun(run) {
  return typeof run?.rootSessionId === 'string' && run.id === `super-master-${run.rootSessionId}`;
}

/** Use the host's session/step projection only for ordinary calls by the bound native master. */
export function requestTokenAdmission(options, session, binding, run, masterId, readBoundary, store) {
  const fallback = { scope: 'run' };
  if (!session || session.id !== options.sessionId || session.id !== masterId || binding.id !== masterId ||
      binding.parentId || !isSharedCoordinatorRun(run) || run.rootSessionId !== masterId ||
      (options.purpose != null && options.purpose !== 'agent')) return fallback;
  try {
    const boundary = readBoundary(session);
    const startSeq = boundary?.openTurnStartSeq, turn = boundary?.lastTurn;
    if (!Number.isSafeInteger(startSeq) || startSeq < 0 || !Number.isSafeInteger(turn) || turn < 0 ||
        boundary.lastStepBoundary?.kind !== 'start' || !Number.isSafeInteger(boundary.lastStepStartSeq) ||
        boundary.lastStepStartSeq <= startSeq || boundary.lastStepBoundary.seq !== boundary.lastStepStartSeq) return fallback;
    const anchor = store.coordinatorTurnStart(run.id, turn, startSeq);
    return anchor ? { scope: 'coordinator_turn', turn, startSeq } : fallback;
  } catch {
    // Missing host projections, interrupted turns and old stores keep cumulative run admission.
    return fallback;
  }
}

/** A read-only HTTP facade. Shared history is displayed separately, never charged to each ticket. */
export function withSharedCoordinatorAccounting(service, store) {
  return new Proxy(service, {
    get(target, property) {
      if (property === 'describeRun') return runId => {
        const snapshot = target.describeRun(runId);
        const runs = store.listRuns().filter(run => run.id !== runId && isSharedCoordinatorRun(run));
        const requests = runs.flatMap(run => store.listRequests(run.id));
        const usage = runs.flatMap(run => store.usageSummary(run.id).usage);
        return { ...snapshot, sharedCoordinatorAccounting: {
          ...summarizeAccounting(requests, usage, []),
          scope: 'other_shared_coordinator_runs_in_this_store',
          runIds: runs.map(run => run.id),
          excludedSelectedRunId: runId,
          allocation: 'unallocated',
          includedInSelectedRunTotals: false,
          period: 'retained_history',
          note: 'Shared coordinator history can serve multiple tickets. It is not this ticket\'s cost and must not be added to each ticket.',
        } };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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
  const explicitLimits = rows.filter(row => row.requestLimits?.observedStatus === 'explicit' &&
    Number.isSafeInteger(row.requestLimits.requestedMaxOutputTokens) && row.requestLimits.requestedMaxOutputTokens > 0);
  return { scope: 'managed_recorded_calls_only', ...aggregate(rows),
    byAgent: group('agentId'), byWorkItem: group('workItemId'), byAttempt: group('attemptId'), byPurpose: group('purpose'),
    byAccountingScope: group('accountingScope'),
    requestLimits: {
      explicitRequestLimitCalls: explicitLimits.length,
      unspecifiedRequestLimitCalls: rows.filter(row => row.requestLimits?.observedStatus === 'not_set').length,
      unobservedOrInvalidRequestLimitCalls: rows.length - explicitLimits.length - rows.filter(row => row.requestLimits?.observedStatus === 'not_set').length,
      knownOutputAboveRequestedLimitCalls: explicitLimits.filter(row => Number.isSafeInteger(row.outputTokens) &&
        row.outputTokens > row.requestLimits.requestedMaxOutputTokens).length,
      note: 'Observed request options only; a reservation fallback is not a provider cap. Provider-effective limits are not verified.',
    },
    rework: { initialAssignments: seen.size, attempts: planned.length, retries: retries.length,
      retriesPerInitialAssignment: seen.size ? retries.length / seen.size : null, reasons, invalidatedAttempts: invalidations,
      note: 'Input invalidation and retry may describe the same attempt; do not add them. Unknown causes are not model errors.' } };
}
