import { createHash } from 'node:crypto';

/**
 * Conditional reads of already archived evidence. The caller must complete its
 * normal authorized read first; a tag never grants access or skips validation.
 * No history, shared cache, tool policy, or original result is modified here.
 */
export function projectEvidenceRead(result, { runId, args, countTokens }) {
  if (!result || typeof countTokens !== 'function' ||
      !(typeof result.text === 'string' || Array.isArray(result.matches)) ||
      !Number.isSafeInteger(result.bytes) || result.bytes < 512 ||
      (typeof result.text === 'string' && !result.text.trim())) return result;
  // An optional context optimization must never turn a successful evidence
  // read into an error when estimation or protocol construction is unavailable.
  try { return conditionalRead(result, runId, args, countTokens); }
  catch { return result; }
}

function conditionalRead(result, runId, args, countTokens) {
  const tokens = value => {
    const count = countTokens(JSON.stringify(value));
    if (!Number.isFinite(count) || count < 0) throw new Error('Invalid token estimate');
    return count;
  };
  const originalTokens = tokens(result);
  if (originalTokens < 256) return result;
  const { ifNoneMatch, ...request } = args;
  const selector = [args.ref, args.start ?? 0, args.bytes ?? 8000, args.contains ?? null, args.mode ?? 'auto'];
  const etag = `ev1:${createHash('sha256').update(JSON.stringify([runId, selector, result])).digest('hex')}`;
  const full = { ...result, etag };
  const { text: _text, matches: _matches, ...metadata } = result;
  const unchanged = { ...metadata, bytes: 0, omittedBytes: result.bytes, etag, notModified: true,
    recovery: 'Omit ifNoneMatch to read the original result.' };

  // Pay for the initial tag and the next request's condition as well as its
  // response. Do not add protocol overhead to short or highly token-efficient
  // outputs. This is a local tokenizer estimate, never a billing claim.
  const saving = 2 * originalTokens + tokens(request)
    - tokens(full) - tokens({ ...request, ifNoneMatch: etag }) - tokens(unchanged);
  if (saving < 128) return result;
  return ifNoneMatch === etag ? unchanged : full;
}
