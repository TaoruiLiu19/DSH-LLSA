export const MAX_EVIDENCE_FILES = 8;
export const MAX_EVIDENCE_FILE_BYTES = 64 * 1024;
export const MAX_EVIDENCE_BYTES = 256 * 1024;
export const TASK_BODY_LIMIT = 2 * 1024 * 1024;

/** Keep evidence bodies exact and use stable, distinct labels within a task. */
export function validateEvidence(value) {
  if (value === undefined) return undefined;
  const invalid = () => { throw Object.assign(new Error('INVALID_EVIDENCE'), { status: 400, code: 'INVALID_EVIDENCE' }); };
  const oversized = () => { throw Object.assign(new Error('EVIDENCE_TOO_LARGE'), { status: 413, code: 'EVIDENCE_TOO_LARGE' }); };
  if (!Array.isArray(value) || !value.length || value.length > MAX_EVIDENCE_FILES) invalid();
  const encoder = new TextEncoder();
  const labels = new Set();
  let total = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 ||
      typeof item.label !== 'string' || typeof item.text !== 'string' || !item.text.isWellFormed() || !item.text.trim()) invalid();
    const label = item.label.trim();
    if (!label || !label.isWellFormed() || label.length > 120 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(label) || labels.has(label)) invalid();
    labels.add(label);
    const bytes = encoder.encode(item.text).length;
    total += bytes;
    if (bytes > MAX_EVIDENCE_FILE_BYTES || total > MAX_EVIDENCE_BYTES) oversized();
    return { label, text: item.text };
  });
}
