import { createHash } from 'node:crypto';

const attentionStates = new Set(['submitted', 'failed', 'rejected', 'cancelled', 'unknown']);

function versioned(view, previous, actionRequired, scope) {
  const revision = createHash('sha256').update(JSON.stringify([scope, view])).digest('hex').slice(0, 24);
  if (previous === revision && !actionRequired) return { unchanged: true, revision };
  return { ...view, revision };
}

/** A caller can reuse the same snapshot only while its work state and input are unchanged. */
export function statusView(manager, sessionId, runId, { ticketId, ifRevision } = {}) {
  const { store } = manager;
  const native = manager.bridge?.snapshot(ticketId);
  if (native?.masterSessionId === sessionId) {
    const tickets = native.tickets.filter(row => ticketId === undefined || row.ticket.id === ticketId).map(row => ({
      ticketId: row.ticket.id,
      assignmentId: row.assignmentId,
      ended: row.ticket.ended ?? null,
      ...(row.ticket.attention ? { attention: true } : {}),
      workItems: row.assignmentId
        ? store.getWorkItems(`super-${row.ticket.id}-${row.assignmentId}`)
          .map(w => ({ id: w.id, state: w.state, ...(w.staleInput ? { staleInput: true } : {}) }))
        : [],
    }));
    const needsAction = tickets.some(ticket => ticket.attention ||
      ticket.workItems.some(work => work.staleInput || attentionStates.has(work.state)));
    return versioned({ tickets, scope: 'native_ticket_assignments',
      note: 'Acceptance states reflect recorded coordinator assessments.' }, ifRevision, needsAction, [sessionId, ticketId]);
  }
  const run = store.getRun(runId);
  if (ticketId !== undefined && run?.ticketId !== ticketId) throw new Error('This session cannot view that ticket.');
  const items = store.getWorkItems(runId);
  const requiredAssessments = items.filter(w => w.parentId === sessionId && w.state === 'submitted').map(w => {
    const { workItemId, eventId, evidenceRefs, nextAction } = manager.workStatus(w);
    return { workItemId, eventId, evidenceRefs, action: nextAction };
  });
  const workItems = items.map(w => ({
    id: w.id, state: w.state, dependsOn: w.dependsOn ?? [],
    ...(w.discarded ? { discarded: true } : {}),
    ...(w.staleInput ? { staleInput: true } : {}),
  }));
  const agents = store.getAgents(runId).map(a => ({ id: a.id, role: a.role, state: a.state }));
  const needsAction = requiredAssessments.length > 0 ||
    workItems.some(w => !w.discarded && (w.staleInput || attentionStates.has(w.state)));
  const status = versioned({ runId, agents, workItems, requiredAssessments, history: 'Use collab_history for a specific step.' },
    ifRevision, needsAction, [sessionId, runId, manager.nativeInputs.current(runId)?.version]);
  if ('unchanged' in status) return status;
  const { calls, totalTokens, unknownCalls } = store.usageSummary(runId);
  return { ...status, usage: { calls, totalTokens, unknownCalls } };
}
