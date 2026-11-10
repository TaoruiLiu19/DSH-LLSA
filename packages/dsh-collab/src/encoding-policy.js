/** Host-reviewed quality metadata. This gate never creates or publishes evidence. */
import { createHash } from 'node:crypto';

export const MIN_EVIDENCE_SAMPLES = 5;
export const TASK_TYPES = Object.freeze(['generic', 'record-lookup', 'repeated-log', 'exact-computation']);
const codecs = new Set(['table', 'rle', 'aliases']);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
const fail = message => { const error = new Error(message); error.code = 'INVALID_QUALITY_EVIDENCE'; throw error; };

export const encodingInstructionDigest = instructions => `sha256:${createHash('sha256').update(instructions, 'utf8').digest('hex')}`;

/** Copy/freeze a bounded metadata list; neither true flags nor sample count prove an experiment happened. */
export function normalizeQualityEvidence(list = []) {
  if (!Array.isArray(list) || list.length > 1000) fail('Expected at most 1000 host-reviewed evidence records');
  const identifiers = new Set();
  return Object.freeze(list.map(record => {
    const fields = ['evidenceId', 'source', 'modelProfile', 'taskType', 'codec', 'version', 'instructionsDigest', 'sampleCount', 'baselineCorrect', 'encodedCorrect'];
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(record))) fail('Evidence must be plain metadata');
    const descriptors = Object.getOwnPropertyDescriptors(record);
    if (descriptors.codec?.value === 'aliases') fields.push('protocolDigest');
    if (Object.getOwnPropertySymbols(record).length || Object.keys(descriptors).length !== fields.length
      || fields.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) fail('Evidence fields must match the explicit schema exactly');
    const row = Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
    if (!nonempty(row.evidenceId) || identifiers.has(row.evidenceId)
      || !['provider_reported', 'synthetic_fixture'].includes(row.source)
      || !nonempty(row.modelProfile) || !['record-lookup', 'repeated-log'].includes(row.taskType)
      || !codecs.has(row.codec) || !Number.isSafeInteger(row.version) || row.version < 1
      || !digest(row.instructionsDigest) || !Number.isSafeInteger(row.sampleCount) || row.sampleCount < 1
      || typeof row.baselineCorrect !== 'boolean' || typeof row.encodedCorrect !== 'boolean'
      || (row.codec === 'aliases' && !(typeof row.protocolDigest === 'string' && /^[a-f0-9]{64}$/u.test(row.protocolDigest)))) {
      fail('Invalid evidence identity, scope, counters, outcome or digest');
    }
    identifiers.add(row.evidenceId);
    return Object.freeze(row);
  }));
}

/** Any matching real failure vetoes positive entries; absence/unknown is not a pass. */
export function assessEncodingQuality(candidate, { qualityEvidence = [], minEvidenceSamples = MIN_EVIDENCE_SAMPLES, testOnlyAllowSyntheticEvidence = false } = {}) {
  if (!Number.isSafeInteger(minEvidenceSamples) || minEvidenceSamples < MIN_EVIDENCE_SAMPLES) fail(`Minimum evidence sample count cannot be below ${MIN_EVIDENCE_SAMPLES}`);
  if (typeof testOnlyAllowSyntheticEvidence !== 'boolean') fail('Synthetic test switch must be boolean');
  const result = (eligible, reason, evidence = null) => ({ eligible, reason, evidenceId: evidence?.evidenceId ?? null,
    evidenceSource: evidence?.source ?? null, sampleCount: evidence?.sampleCount ?? null, minimumSamples: minEvidenceSamples });
  if (!['record-lookup', 'repeated-log'].includes(candidate.taskType)) return result(false, candidate.taskType === 'exact-computation' ? 'HOST_COMPUTATION_REQUIRED' : 'TASK_NOT_EVALUATED');
  if (!nonempty(candidate.modelProfile) || candidate.modelProfile === 'unverified') return result(false, 'MODEL_NOT_EVALUATED');
  const matching = normalizeQualityEvidence(qualityEvidence).filter(row => row.modelProfile === candidate.modelProfile && row.taskType === candidate.taskType
    && row.codec === candidate.codec && row.version === candidate.version && row.instructionsDigest === candidate.instructionsDigest
    && (candidate.codec !== 'aliases' || row.protocolDigest === candidate.protocolDigest));
  const permitted = matching.filter(row => row.source === 'provider_reported' || testOnlyAllowSyntheticEvidence);
  const failed = permitted.find(row => row.baselineCorrect !== true || row.encodedCorrect !== true);
  if (failed) return result(false, 'QUALITY_FAILURE_RECORDED', failed);
  const passed = permitted.find(row => row.sampleCount >= minEvidenceSamples && row.baselineCorrect === true && row.encodedCorrect === true);
  if (passed) return result(true, 'QUALITY_EVIDENCE_MATCHED', passed);
  if (permitted.length) return result(false, 'INSUFFICIENT_SAMPLES', permitted[0]);
  return result(false, matching.length ? 'SYNTHETIC_EVIDENCE_NOT_PRODUCTION' : 'QUALITY_EVIDENCE_MISSING');
}
