import { freezeMessage } from '@deepseek-ai/dsh-llm';

const clearsReceipts = event => ['compaction/end', 'compaction/prune', 'session/end-seed'].includes(event.type);
const inputReceipt = event => event.type === 'user/message' && event.data.source?.kind === 'dsh-collab' &&
  event.data.source.form === 'input-reference';
function applyReceipt(ids, event) {
  if (clearsReceipts(event)) ids.clear();
  else if (inputReceipt(event)) ids.add(event.data.id);
}

/** Admit context through the logged pre-step API, once per input version and request series. */
export class InputDelivery {
  constructor(persistence) { this.persistence = persistence; this.receipts = new WeakMap(); }
  observe(session, event) {
    const state = this.receipts.get(session);
    if (!state || (!clearsReceipts(event) && !inputReceipt(event))) return;
    if (state.ready) applyReceipt(state.ids, event);
    else state.events.push(event);
  }
  hasCurrent(session, runId, version) {
    const state = this.receipts.get(session);
    return state?.ready === true && state.ids.has(`native-input:${runId}:${version}`);
  }
  async seen(agent) {
    const session = agent.session;
    const cached = this.receipts.get(session);
    if (cached) return cached.loading;
    const state = { ids: new Set(), events: [], ready: false, loading: undefined };
    this.receipts.set(session, state);
    state.loading = Promise.resolve().then(() => this.restore(agent, state)).catch(error => {
      if (this.receipts.get(session) === state) this.receipts.delete(session);
      throw error;
    });
    return state.loading;
  }
  async restore(agent, state) {
    await this.persistence.flush();
    const handle = await this.persistence.open(agent.id, 'read');
    let lastSeq = -Infinity;
    try {
      for (let offset = 0;;) {
        const { events } = await handle.read(offset, 512); if (!events.length) break;
        for (const event of events) {
          applyReceipt(state.ids, event);
          if (Number.isSafeInteger(event.seq)) lastSeq = Math.max(lastSeq, event.seq);
        }
        offset += events.length;
      }
    } finally { await handle[Symbol.asyncDispose](); }
    // Preserve the live order after the durable prefix. Events already scanned
    // must not replay across a later compaction or an input re-admission.
    for (const event of state.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq > lastSeq) applyReceipt(state.ids, event);
    }
    state.events.length = 0;
    state.ready = true;
    return state.ids;
  }
  async admit(agent, decision, binding, inputs) {
    if (decision.kind !== 'enter' || !binding || binding.parentId || !inputs.current(binding.runId)) return decision;
    const seen = await this.seen(agent);
    // Restoring the receipt history can overlap a correction. Bind the ID and hint to the same current input.
    const current = inputs.current(binding.runId); if (!current) return decision;
    const id = `native-input:${binding.runId}:${current.version}`;
    if (seen.has(id) || decision.messages.some(m => m.id === id)) return decision;
    return { ...decision, messages: [...decision.messages, freezeMessage({ id, role: 'user',
      content: [{ type: 'text', text: inputs.hint(binding.runId) }],
      source: { kind: 'dsh-collab', form: 'input-reference' } })] };
  }
}
