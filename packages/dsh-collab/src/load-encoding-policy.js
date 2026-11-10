import { readFileSync, statSync } from 'node:fs';
import { parseExactJson } from './protocol.js';
import { normalizeQualityEvidence } from './encoding-policy.js';

/** Operator-owned file, never a model tool argument. Bad evidence cannot silently enable a codec. */
export function loadEncodingEvidence(path) {
  if (!path) return normalizeQualityEvidence([]);
  if (statSync(path).size > 1024 * 1024) {
    const error=new Error('Encoding evidence file exceeds 1 MiB');error.code='INVALID_QUALITY_EVIDENCE';throw error;
  }
  return normalizeQualityEvidence(parseExactJson(readFileSync(path,'utf8')));
}
