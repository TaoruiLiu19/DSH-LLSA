/** Keeps a ledger write boundary around streams that can outlive plugin disposal. */
export class StreamUsageLifecycle {
  constructor({ recordUsage, releaseCall, normalizeUsage }) {
    this.recordUsage = recordUsage;
    this.releaseCall = releaseCall;
    this.normalizeUsage = normalizeUsage;
    this.active = new Map();
    this.closing = false;
    this.closePromise = null;
  }

  begin(metadata) {
    if (this.closing) return null;
    if (this.active.has(metadata.callId)) throw new Error('Stream call already tracked');
    this.recordUsage({ ...metadata, finish: null, usageStatus: 'pending', ...this.normalizeUsage(null) });
    let resolveDone;
    const entry = { metadata, usage: null, finishReason: null, sealed: false, done: new Promise(resolve => { resolveDone = resolve; }) };
    const seal = incomplete => {
      if (entry.sealed) return false;
      entry.sealed = true;
      try {
        this.recordUsage({ ...metadata,
          finish: incomplete ? 'plugin_unloaded' : entry.finishReason,
          usageStatus: incomplete ? 'unknown_stream_incomplete' : entry.usage ? 'reported' : 'unknown',
          ...(incomplete && entry.usage ? { partialUsageObserved: true } : {}),
          ...this.normalizeUsage(incomplete ? null : entry.usage) });
        if (!incomplete && entry.usage) this.releaseCall(metadata.callId);
      } finally {
        this.active.delete(metadata.callId);
        resolveDone();
      }
      return true;
    };
    entry.seal = seal;
    this.active.set(metadata.callId, entry);
    return {
      observe: chunk => {
        if (entry.sealed) return;
        if (chunk.type === 'usage') entry.usage = chunk.usage;
        if (chunk.type === 'finish') entry.finishReason = chunk.reason.kind;
      },
      finish: () => seal(false),
    };
  }

  close({ timeoutMs = 5000 } = {}) {
    if (this.closePromise) return this.closePromise;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid stream drain timeout');
    this.closing = true;
    this.closePromise = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.all([...this.active.values()].map(entry => entry.done)),
          new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
      const errors = [];
      for (const entry of [...this.active.values()]) {
        try { entry.seal(true); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Could not seal stream usage before disposal');
    })();
    return this.closePromise;
  }
}
