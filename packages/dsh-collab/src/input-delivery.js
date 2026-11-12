import { freezeMessage } from '@deepseek-ai/dsh-llm';

/** Admit context through the logged pre-step API, once per input version and request series. */
export class InputDelivery {
  constructor(persistence) { this.persistence = persistence; this.receipts = new WeakMap(); }
  observe(session, event) {
    const ids = this.receipts.get(session); if (!ids) return;
    if (['compaction/end', 'compaction/prune', 'session/end-seed'].includes(event.type)) ids.clear();
    if (event.type === 'user/message' && event.data.source?.form === 'input-reference') ids.add(event.data.id);
  }
  async seen(agent) {
    if (this.receipts.has(agent.session)) return this.receipts.get(agent.session);
    await this.persistence.flush();
    const ids = new Set(); this.receipts.set(agent.session, ids);
    const handle = await this.persistence.open(agent.id, 'read');
    try {
      for (let offset = 0;;) {
        const { events } = await handle.read(offset, 512); if (!events.length) break;
        for (const event of events) this.observe(agent.session, event);
        offset += events.length;
      }
    } catch (error) { this.receipts.delete(agent.session); throw error; }
    finally { await handle[Symbol.asyncDispose](); }
    return ids;
  }
  async admit(agent, decision, binding, inputs) {
    if (decision.kind !== 'enter' || !binding || binding.parentId) return decision;
    const current = inputs.current(binding.runId); if (!current) return decision;
    const id = `native-input:${binding.runId}:${current.version}`;
    const seen = await this.seen(agent);
    if (seen.has(id) || decision.messages.some(m => m.id === id)) return decision;
    return { ...decision, messages: [...decision.messages, freezeMessage({ id, role: 'user',
      content: [{ type: 'text', text: inputs.hint(binding.runId) }],
      source: { kind: 'dsh-collab', form: 'input-reference' } })] };
  }
}
