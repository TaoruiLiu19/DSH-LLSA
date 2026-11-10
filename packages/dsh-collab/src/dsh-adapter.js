import { freezeMessage } from '@deepseek-ai/dsh-llm';

export function createDshBackend(ctx, manager, { childPreset = 'standard' } = {}) {
  const history = new WeakMap();
  async function seen(agent) {
    if (history.has(agent.session)) return history.get(agent.session);
    await ctx.sessionPersistence.flush();
    const ids = new Set();
    const handle = await ctx.sessionPersistence.open(agent.id, 'read');
    try {
      for (let offset = 0;;) {
        const { events } = await handle.read(offset, 512);
        if (!events.length) break;
        for (const e of events) if (e.type === 'user/message') ids.add(e.data.id);
        offset += events.length;
      }
    } finally { await handle[Symbol.asyncDispose](); }
    history.set(agent.session, ids); return ids;
  }
  return {
    getAgent: id => ctx.agents.get(id),
    modelProfile: id => {
      try {
        const agent = ctx.agents.get(id);
        // New Harness persists live model switches outside initial agent.options.
        // A present but unresolved/broken model API must never reuse stale evidence.
        const selection = typeof agent?.model?.current === 'function'
          ? agent.model.current() : agent?.model?.current === undefined ? agent?.options : null;
        return typeof selection?.provider === 'string' && selection.provider.trim()
          && typeof selection?.model === 'string' && selection.model.trim()
          ? `${selection.provider}/${selection.model}` : 'unverified';
      } catch { return 'unverified'; }
    },
    async start({ parent, childId, prompt, label, maxOutputTokens }) {
      const subagents = parent.ctx.get('subagents') ?? ctx.subagents;
      return subagents.startActivation({ provider: 'spawn', label, childId,
        request: { parent, prompt: [{ type: 'text', text: prompt }], agentPreset: childPreset, maxDepth: 1, agentOptions: { maxTokens: maxOutputTokens } },
        signal: new AbortController().signal, delivery: 'caller' });
    },
    async deliver({ recipientId, senderId, runId, messageId, text }) {
      manager.authorize(recipientId, runId);
      const agent = ctx.agents.get(recipientId);
      if (!agent) throw new Error('Target is not resident; restore its managed context before delivery');
      const ids = await seen(agent);
      if (ctx.agents.get(recipientId) !== agent) throw new Error('Target activation changed');
      manager.authorize(recipientId, runId);
      const id = `dsh-collab:${messageId}`;
      const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(m => m.id === id);
      if (!ids.has(id) && !pending) {
        // Trusted host relay: does not impersonate a human or a native peer message.
        const message = freezeMessage({ id, role: 'user', content: [{ type: 'text', text }],
          source: { kind: 'dsh-collab', form: 'relay', runId, senderId, logicalMessageId: messageId } });
        agent.steer(message);
      }
      await ctx.sessionPersistence.flush();
      return { inboxId: id, duplicate: ids.has(id) || pending, source: 'dsh-collab' };
    },
    observeMessage(session, event) {
      if (event.type === 'user/message') history.get(session)?.add(event.data.id);
    },
  };
}

/** DSH TokenUsage inputTokens is UNCACHED, not aggregate prompt input. */
export function normalizeDshUsage(usage) {
  const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : null;
  const uncached = count(usage?.inputTokens), read = count(usage?.cacheReadTokens), write = count(usage?.cacheWriteTokens);
  const total = [uncached, read, write].every(value => value !== null) ? uncached + read + write : null;
  return { inputTokens: count(total), outputTokens: count(usage?.outputTokens),
    cachedInputTokens: read, cacheWriteTokens: write, uncachedInputTokens: uncached,
    reasoningTokens: count(usage?.reasoningTokens), ...(usage ? { rawUsage: usage } : {}) };
}
