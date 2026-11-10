/** Versioned compact communication. This is encoding, not secrecy or encryption. */
import { createHash } from 'node:crypto';
import { encodingInstructionDigest, normalizeQualityEvidence, assessEncodingQuality, TASK_TYPES } from './encoding-policy.js';
export { encodingInstructionDigest, normalizeQualityEvidence } from './encoding-policy.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 100000;
const TABLE_INSTRUCTIONS = '表结构 v1：c 是字段名有序列表，r 的每行按 c 顺序给值；每行代表一个对象，null、空字符串、0 和数组顺序保持原义。';
const RLE_INSTRUCTIONS = 'RLE v1: d is a dictionary array of complete original JSON values. Each r entry is [count,index], meaning count consecutive copies of d[index] (zero-based). Concatenate runs in order. Every copy counts; preserve all types, string leading zeros, negations, nulls and order.';

export function codecInstructions(codec, definition) {
  if (codec === 'table') return TABLE_INSTRUCTIONS;
  if (codec === 'rle') return RLE_INSTRUCTIONS;
  if (codec === 'aliases' && definition) return `字段协议 ${definition.id}@${definition.version}：${JSON.stringify(definition.aliases)} 表示原字段→短字段，只用于顶层对象或对象行，其余字段与值原样保留。`;
  if (codec === 'json') return '';
  fail('UNKNOWN_PROTOCOL', 'Cannot render unknown codec instructions');
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function own(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Reject values whose JSON serialization would silently alter semantics. */
function jsonCopy(value) {
  const seen = new Set();
  let nodes = 0;
  function walk(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('JSON_LIMIT', 'JSON nesting or item limit exceeded');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)
        || (Number.isInteger(item) && !Number.isSafeInteger(item))) {
        fail('INVALID_JSON_VALUE', 'Numbers must be finite, not negative zero, and safe when integral; use strings for exact large numbers');
      }
      return item;
    }
    if (typeof item !== 'object' || (!record(item) && !Array.isArray(item))) {
      fail('INVALID_JSON_VALUE', 'Only plain JSON objects, arrays and primitive JSON values are supported');
    }
    if (seen.has(item)) fail('INVALID_JSON_VALUE', 'Cyclic JSON is not supported');
    if (Object.getOwnPropertySymbols(item).length) fail('INVALID_JSON_VALUE', 'Symbol properties are not JSON');
    seen.add(item);
    const out = Array.isArray(item) ? [] : {};
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item)) {
      if (item.length > MAX_NODES || Object.keys(item).length !== item.length) fail('INVALID_JSON_VALUE', 'Sparse arrays or array properties are not supported');
      if (Object.keys(descriptors).some(key => key !== 'length'
        && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length || !descriptors[key].enumerable))) {
        fail('INVALID_JSON_VALUE', 'Additional or hidden array properties are not JSON');
      }
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) fail('INVALID_JSON_VALUE', 'Accessors are not JSON');
        out.push(walk(descriptor.value, depth + 1));
      }
    } else {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !('value' in descriptor)) fail('INVALID_JSON_VALUE', 'Accessors or hidden properties are not JSON');
        own(out, key, walk(descriptor.value, depth + 1));
      }
    }
    seen.delete(item);
    return out;
  }
  const result = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES) fail('JSON_LIMIT', 'JSON exceeds 2 MiB; use an artifact reference');
  return result;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function frozenCopy(value) { return freeze(jsonCopy(value)); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** Decimal identity, without materializing powers of ten or unbounded BigInts. */
function decimalParts(text) {
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  const fraction = match[3] ?? '';
  const digits = `${match[2]}${fraction}`.replace(/^0+/, '');
  let end = digits.length;
  while (end > 0 && digits[end - 1] === '0') end--;
  const significant = digits.slice(0, end);
  const rawExponent = match[4] ?? '0';
  const magnitude = rawExponent.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  return {
    coefficient: significant ? `${match[1]}${significant}` : '0',
    scale: BigInt(fraction.length - (digits.length - significant.length)),
    exponent: magnitude === '0' ? '0' : `${rawExponent.startsWith('-') ? '-' : ''}${magnitude}`,
  };
}

/** Preserve decimal value relative to Number's canonical spelling (0.1 is allowed). */
function parseExactDecimalNumber(token) {
  const parsed = Number(token);
  if (!Number.isFinite(parsed) || Object.is(parsed, -0)
    || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) {
    fail('INVALID_JSON_VALUE', 'Numbers must be finite, not negative zero, and safe when integral; use strings for exact large numbers');
  }
  const source = decimalParts(token);
  if (source.coefficient === '0') return parsed;
  const canonical = decimalParts(parsed.toString());
  // Canonical coefficients are short. Compare lengths before BigInt conversion so
  // adversarially long mantissas and exponents remain bounded string operations.
  const sameCoefficient = source.coefficient.length === canonical.coefficient.length
    && BigInt(source.coefficient) === BigInt(canonical.coefficient);
  const expectedExponent = BigInt(canonical.exponent) - canonical.scale + source.scale;
  if (!sameCoefficient || source.exponent !== expectedExponent.toString()) {
    fail('INVALID_JSON_VALUE', 'JSON number changes decimal value during parsing; use a string for exact decimal values');
  }
  return parsed;
}

/** Parse JSON while rejecting duplicate members (JSON.parse alone accepts them). */
function strictParse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('JSON_LIMIT', 'Invalid or oversized JSON text');
  let index = 0;
  let nodes = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(text[index] ?? '\0')) index++; };
  function string() {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index++] === '"') {
        try { return JSON.parse(text.slice(start, index)); }
        catch { fail('INVALID_JSON', 'Invalid JSON string'); }
      }
    }
    fail('INVALID_JSON', 'Unterminated string');
  }
  function value(depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('JSON_LIMIT', 'JSON nesting or item limit exceeded');
    space();
    const ch = text[index];
    if (ch === '"') return string();
    if (ch === '{') {
      index++; space();
      const out = {}; const keys = new Set();
      if (text[index] === '}') { index++; return out; }
      for (;;) {
        space();
        if (text[index] !== '"') fail('INVALID_JSON', 'Expected object member');
        const key = string();
        if (keys.has(key)) fail('DUPLICATE_KEY', `Duplicate JSON member: ${key}`);
        keys.add(key); space();
        if (text[index++] !== ':') fail('INVALID_JSON', 'Expected colon');
        own(out, key, value(depth + 1)); space();
        const sep = text[index++];
        if (sep === '}') return out;
        if (sep !== ',') fail('INVALID_JSON', 'Expected comma or object end');
      }
    }
    if (ch === '[') {
      index++; space(); const out = [];
      if (text[index] === ']') { index++; return out; }
      for (;;) {
        out.push(value(depth + 1)); space(); const sep = text[index++];
        if (sep === ']') return out;
        if (sep !== ',') fail('INVALID_JSON', 'Expected comma or array end');
      }
    }
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, index)) { index += word.length; return result; }
    }
    const token = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!token) fail('INVALID_JSON', 'Expected JSON value');
    index += token[0].length;
    return parseExactDecimalNumber(token[0]);
  }
  const result = value(0); space();
  if (index !== text.length) fail('INVALID_JSON', 'Trailing JSON content');
  return jsonCopy(result);
}

/** Bounded raw JSON parsing that rejects duplicate keys and decimal precision loss. */
export const parseExactJson = strictParse;

function exactKeys(value, keys) {
  if (!record(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_PACKET', 'Packet has missing or unknown fields');
}

function validIdentifier(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,95}$/.test(value)) fail('INVALID_PROTOCOL', `Invalid ${name}`);
}

/** Immutable definitions; lifecycle state lives separately from the dictionary. */
export class ProtocolRegistry {
  #entries = new Map();
  constructor({ definitions = [] } = {}) {
    if (!Array.isArray(definitions)) fail('INVALID_PROTOCOL', 'Definitions must be an array');
    for (const definition of jsonCopy(definitions)) {
      if (!record(definition)) fail('INVALID_PROTOCOL', 'Each definition must be an object');
      this.draft({ id: definition.id, version: definition.version, aliases: definition.aliases });
      if (definition.digest !== undefined && this.get(definition.id, definition.version).digest !== definition.digest) {
        fail('PROTOCOL_DIGEST_MISMATCH', 'Imported dictionary digest mismatch');
      }
      if (definition.status === 'published' || definition.status === 'retired') {
        this.publish(definition.id, definition.version, definition.evaluation);
        if (definition.status === 'retired') this.retire(definition.id, definition.version);
      } else if (definition.status !== undefined && definition.status !== 'draft') fail('INVALID_PROTOCOL', 'Invalid lifecycle state');
    }
  }
  #key(id, version) {
    validIdentifier(id, 'protocol id');
    if (!Number.isSafeInteger(version) || version < 1) fail('INVALID_PROTOCOL', 'Version must be a positive safe integer');
    return `${id}\0${version}`;
  }
  draft(definition) {
    const { id, version, aliases } = jsonCopy(definition);
    exactKeys(definition, ['id', 'version', 'aliases']);
    validIdentifier(id, 'protocol id');
    if (!Number.isSafeInteger(version) || version < 1) fail('INVALID_PROTOCOL', 'Version must be a positive safe integer');
    if (!record(aliases) || !Object.keys(aliases).length || Object.keys(aliases).length > 128) fail('INVALID_PROTOCOL', 'Expected 1–128 top-level aliases');
    const targets = new Set();
    for (const [original, short] of Object.entries(aliases)) {
      if (!original || original.length > 256 || typeof short !== 'string' || !short || short.length > 64) fail('INVALID_PROTOCOL', 'Invalid alias');
      if (targets.has(short)) fail('AMBIGUOUS_PROTOCOL', 'Two fields cannot share one alias');
      if (Object.hasOwn(aliases, short) && short !== original) fail('AMBIGUOUS_PROTOCOL', 'Alias cannot also name another canonical field');
      targets.add(short);
    }
    const key = this.#key(id, version);
    if (this.#entries.has(key)) fail('IMMUTABLE_VERSION', 'A protocol version cannot be replaced');
    const schema = frozenCopy({ id, version, aliases });
    this.#entries.set(key, { schema, digest: digest(schema), status: 'draft', evaluation: null });
    return this.get(id, version);
  }
  publish(id, version, evaluation) {
    const entry = this.#entries.get(this.#key(id, version));
    if (!entry) fail('UNKNOWN_PROTOCOL', 'Unknown protocol version');
    if (entry.status !== 'draft') fail('IMMUTABLE_VERSION', 'Only draft versions may be published');
    const checked = jsonCopy(evaluation);
    if (!record(checked) || checked.passed !== true || typeof checked.evidenceId !== 'string' || !checked.evidenceId.trim()
      || !Array.isArray(checked.modelProfiles) || !checked.modelProfiles.length
      || checked.modelProfiles.some(p => typeof p !== 'string' || !p.trim())
      || new Set(checked.modelProfiles).size !== checked.modelProfiles.length) {
      fail('EVALUATION_REQUIRED', 'Publishing requires passed evaluation evidenceId and explicit modelProfiles');
    }
    entry.evaluation = frozenCopy(checked);
    entry.status = 'published';
    return this.get(id, version);
  }
  retire(id, version) {
    const entry = this.#entries.get(this.#key(id, version));
    if (!entry) fail('UNKNOWN_PROTOCOL', 'Unknown protocol version');
    if (entry.status === 'draft') fail('INVALID_PROTOCOL', 'Draft versions cannot be retired');
    entry.status = 'retired';
    return this.get(id, version);
  }
  get(id, version) {
    const entry = this.#entries.get(this.#key(id, version));
    if (!entry) fail('UNKNOWN_PROTOCOL', `Unknown protocol ${id}@${version}`);
    return frozenCopy({ ...entry.schema, digest: entry.digest, status: entry.status, evaluation: entry.evaluation });
  }
  available(modelProfile) {
    return this.exportVersions().filter(d => d.status === 'published' && d.evaluation.modelProfiles.includes(modelProfile));
  }
  exportVersions() {
    return freeze([...this.#entries.values()].map(entry => this.get(entry.schema.id, entry.schema.version)));
  }
}

function aliasesApply(payload, aliases, reverse = false) {
  const forward = new Map(Object.entries(aliases));
  const back = new Map([...forward].map(([key, alias]) => [alias, key]));
  const mapping = reverse ? back : forward;
  function row(item) {
    if (!record(item)) fail('INELIGIBLE_FORMAT', 'Alias encoding supports an object or an array of objects');
    const out = {};
    for (const [key, value] of Object.entries(item)) {
      if ((!reverse && back.has(key) && !forward.has(key)) || (reverse && forward.has(key) && !back.has(key))) {
        fail('AMBIGUOUS_PAYLOAD', 'An unaliased field conflicts with a protocol name');
      }
      const target = mapping.get(key) ?? key;
      if (Object.hasOwn(out, target)) fail('AMBIGUOUS_PAYLOAD', 'Aliased keys collide');
      own(out, target, value);
    }
    return out;
  }
  return Array.isArray(payload) ? payload.map(row) : row(payload);
}

function tableOf(payload) {
  if (!Array.isArray(payload) || payload.length < 2 || !payload.every(record)) fail('INELIGIBLE_FORMAT', 'Table requires at least two object rows');
  const columns = Object.keys(payload[0]);
  if (!columns.length || payload.some(row => Object.keys(row).length !== columns.length || columns.some(c => !Object.hasOwn(row, c)))) {
    fail('INELIGIBLE_FORMAT', 'All rows must have exactly the same keys');
  }
  return { columns, rows: payload.map(row => columns.map(c => row[c])) };
}

function rleOf(payload) {
  if (!Array.isArray(payload) || payload.length < 2) fail('INELIGIBLE_FORMAT', 'RLE requires at least two array entries');
  const dictionary = [], runs = [], indices = new Map();
  for (const value of payload) {
    const serialized = JSON.stringify(value);
    let index = indices.get(serialized);
    if (index === undefined) { index = dictionary.length; indices.set(serialized, index); dictionary.push(value); }
    if (runs.at(-1)?.[1] === index) runs.at(-1)[0]++;
    else runs.push([1, index]);
  }
  return { codec: 'rle', version: 1, dictionary, runs };
}

function expandRle(packet) {
  exactKeys(packet, ['codec', 'version', 'dictionary', 'runs']);
  if (packet.version !== 1) fail('UNKNOWN_PROTOCOL', 'Unknown RLE wire version');
  if (!Array.isArray(packet.dictionary) || !Array.isArray(packet.runs)) fail('INVALID_PACKET', 'RLE dictionary and runs must be arrays');
  const costs = packet.dictionary.map(value => {
    let nodes = 0;
    const visit = item => { nodes++; if (item && typeof item === 'object') Object.values(item).forEach(visit); };
    visit(value);
    return { nodes, bytes: Buffer.byteLength(JSON.stringify(value), 'utf8') };
  });
  let count = 0, nodes = 1, bytes = 2;
  for (const run of packet.runs) {
    if (!Array.isArray(run) || run.length !== 2 || !Number.isSafeInteger(run[0]) || run[0] <= 0
      || !Number.isSafeInteger(run[1]) || run[1] < 0 || run[1] >= packet.dictionary.length) fail('INVALID_PACKET', 'Invalid RLE count or dictionary index');
    const cost = costs[run[1]];
    // Check multiplication bounds before allocating or materializing expanded JSON.
    if (run[0] > MAX_NODES - count || run[0] > Math.floor((MAX_NODES - nodes) / cost.nodes)
      || run[0] > Math.floor((MAX_BYTES - bytes + (count === 0 ? 1 : 0)) / (cost.bytes + 1))) fail('JSON_LIMIT', 'RLE expanded size exceeds the JSON limit');
    bytes += run[0] * (cost.bytes + 1) - (count === 0 ? 1 : 0);
    count += run[0]; nodes += run[0] * cost.nodes;
  }
  const out = [];
  for (const [count, index] of packet.runs) for (let i = 0; i < count; i++) out.push(packet.dictionary[index]);
  return jsonCopy(out);
}

/** Explicit evaluation surface only: no evidence is created and no selection is implied. */
export function encodeRleCandidate(payload) {
  const original = jsonCopy(payload);
  const packet = rleOf(original);
  if (!equivalent(decodePacket(packet), original)) fail('ROUNDTRIP_FAILED', 'RLE failed to restore original values');
  const text = JSON.stringify({ d: packet.dictionary, r: packet.runs });
  const instructions = codecInstructions('rle');
  return frozenCopy({ packet, text, instructions, instructionsDigest: encodingInstructionDigest(instructions), modelInput: `${instructions}\n${text}` });
}

/** Decode only a host packet, not raw model-facing text lacking envelope metadata. */
export function decodePacket(packetOrJSON, { registry = new ProtocolRegistry() } = {}) {
  const packet = typeof packetOrJSON === 'string' ? strictParse(packetOrJSON) : jsonCopy(packetOrJSON);
  if (!record(packet)) fail('INVALID_PACKET', 'Packet must be an object');
  if(packet.codec==='envelope'){
    exactKeys(packet,['codec','version','bodyField','envelope','body']);
    if(packet.version!==1||!record(packet.envelope)||typeof packet.bodyField!=='string'||Object.hasOwn(packet.envelope,packet.bodyField)||!['json','table','rle','aliases'].includes(packet.body?.codec))fail('INVALID_PACKET','Invalid encoded envelope');
    return {...packet.envelope,[packet.bodyField]:decodePacket(packet.body,{registry})};
  }
  if (packet.codec === 'json') {
    exactKeys(packet, ['codec', 'version', 'data']);
    if (packet.version !== 1) fail('UNKNOWN_PROTOCOL', 'Unknown JSON wire version');
    return jsonCopy(packet.data);
  }
  if (packet.codec === 'table') {
    exactKeys(packet, ['codec', 'version', 'columns', 'rows']);
    if (packet.version !== 1) fail('UNKNOWN_PROTOCOL', 'Unknown table wire version');
    if (!Array.isArray(packet.columns) || !packet.columns.length || packet.columns.some(c => typeof c !== 'string')
      || new Set(packet.columns).size !== packet.columns.length || !Array.isArray(packet.rows)) fail('INVALID_PACKET', 'Invalid table columns or rows');
    return packet.rows.map(row => {
      if (!Array.isArray(row) || row.length !== packet.columns.length) fail('INVALID_PACKET', 'Table row width mismatch');
      const out = {};
      packet.columns.forEach((column, index) => own(out, column, row[index]));
      return out;
    });
  }
  if (packet.codec === 'rle') return expandRle(packet);
  if (packet.codec === 'aliases') {
    exactKeys(packet, ['codec', 'version', 'protocol', 'digest', 'data']);
    const definition = registry.get(packet.protocol, packet.version);
    if (definition.status === 'draft') fail('UNPUBLISHED_PROTOCOL', 'Draft dictionaries cannot decode production packets');
    if (packet.digest !== definition.digest) fail('PROTOCOL_DIGEST_MISMATCH', 'Protocol digest mismatch');
    return aliasesApply(packet.data, definition.aliases, true);
  }
  fail('UNKNOWN_PROTOCOL', `Unknown codec: ${String(packet.codec)}`);
}

/** Measures full model-facing instructions+text, never just payload bytes. */
export function selectEncoding(payload, options = {}) {
  if(options.bodyField!==undefined){
    const original=jsonCopy(payload),field=options.bodyField;
    if(!record(original)||typeof field!=='string'||!Object.hasOwn(original,field))fail('INVALID_OPTIONS','bodyField must name an existing object member');
    const {bodyField,...baseOptions}=options;
    const baseline=selectEncoding(original,{...baseOptions,allowTable:false,allowAliases:false,allowRle:false});
    const prefix='Wire format only, not an output instruction: envelope contains the original outer fields. Decode body by the following codec rules into an array. The STRING VALUE of bodyField names the missing field in the original object: original = {...envelope, [bodyField]: decodedArray}. For example bodyField="result" means original.result is that array, not envelope alone. Then perform the user task on original and return ALL fields requested by the task; do not return only envelope metadata. Use the restored array for indexing and length.';
    const body=selectEncoding(original[field],{...baseOptions,instructionPrefix:prefix});
    if(body.codec==='json')return {...baseline,metrics:{...baseline.metrics,bodyRouting:{field,candidates:body.metrics.candidates,rejected:body.metrics.rejected,selected:'json'}}};
    const envelope={...original};delete envelope[field];
    const packet={codec:'envelope',version:1,bodyField:field,envelope,body:body.packet};
    const text=JSON.stringify({envelope,bodyField:field,body:JSON.parse(body.text)}),modelInput=body.instructions+'\n'+text;
    const count=options.countTokens??(text=>Math.ceil(Buffer.byteLength(text,'utf8')/4));
    const tokens=count(modelInput),savings=baseline.metrics.baselineTokens-tokens;
    if(savings<Math.max(1,options.minSavingsTokens??1)||savings/baseline.metrics.baselineTokens<(options.minSavingsRatio??0))return {...baseline,metrics:{...baseline.metrics,bodyRouting:{field,selected:'json',reason:'ENVELOPE_OVERHEAD'}}};
    let restored;
    try{restored=decodePacket(packet,{registry:options.registry});}catch(error){if(error.code==='JSON_LIMIT')return {...baseline,metrics:{...baseline.metrics,bodyRouting:{field,selected:'json',reason:'ENVELOPE_SIZE_LIMIT'}}};throw error;}
    if(!equivalent(restored,original))fail('ROUNDTRIP_FAILED','Envelope failed to restore message');
    return frozenCopy({...body,packet,text,modelInput,metrics:{...body.metrics,baselineTokens:baseline.metrics.baselineTokens,selectedTokens:tokens,payloadTokens:count(text),savingsTokens:savings,savingsRatio:savings/baseline.metrics.baselineTokens,bodyRouting:{field,selected:body.codec}}});
  }
  const {
    registry = new ProtocolRegistry(), modelProfile = null,
    countTokens = text => Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
    counterName = options.countTokens ? 'injected-local-counter' : 'utf8-bytes/4 heuristic',
    allowTable = true, allowAliases = true, allowRle = true, minSavingsTokens = 1, minSavingsRatio = 0,
    taskType = 'generic', qualityEvidence = [], minEvidenceSamples = 5, testOnlyAllowSyntheticEvidence = false,
  } = options;
  if (typeof countTokens !== 'function' || typeof counterName !== 'string' || !counterName.trim()
    || !Number.isFinite(minSavingsTokens) || minSavingsTokens < 0
    || !Number.isFinite(minSavingsRatio) || minSavingsRatio < 0 || minSavingsRatio > 1
    || !TASK_TYPES.includes(taskType) || ![allowTable, allowAliases, allowRle, testOnlyAllowSyntheticEvidence].every(value => typeof value === 'boolean')
    || !Number.isSafeInteger(minEvidenceSamples) || minEvidenceSamples < 5) fail('INVALID_OPTIONS', 'Invalid counter, task, policy or savings thresholds');
  const evidence = normalizeQualityEvidence(qualityEvidence);
  const original = jsonCopy(payload);
  const candidates = [];
  const rejected = [];
  const count = text => {
    const n = countTokens(text);
    if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_COUNTER', 'countTokens must synchronously return a nonnegative safe integer');
    return n;
  };
  function add(packet, text, instructions, evaluation = 'not_evaluated') {
    if(instructions&&options.instructionPrefix)instructions=options.instructionPrefix+'\n'+instructions;
    let restored;
    try { restored = decodePacket(packet, { registry }); }
    catch (error) {
      if (error.code !== 'JSON_LIMIT' || packet.codec === 'json') throw error;
      rejected.push({ codec: packet.codec, version: packet.version, reason: 'CANDIDATE_SIZE_LIMIT' });
      return;
    }
    // Semantic field equality permits object member order differences, but not array order differences.
    if (!equivalent(restored, original)) fail('ROUNDTRIP_FAILED', 'Candidate does not restore selected projection');
    const modelInput = instructions ? `${instructions}\n${text}` : text;
    const instructionsDigest = encodingInstructionDigest(instructions);
    const quality = packet.codec === 'json' ? { eligible: true, reason: 'PLAIN_JSON_BASELINE', evidenceId: null, evidenceSource: null }
      : assessEncodingQuality({ codec: packet.codec, version: packet.version, modelProfile, taskType, instructionsDigest, protocolDigest: packet.digest },
        { qualityEvidence: evidence, minEvidenceSamples, testOnlyAllowSyntheticEvidence });
    if (!quality.eligible) rejected.push({ codec: packet.codec, version: packet.version, reason: quality.reason, evidenceId: quality.evidenceId });
    candidates.push({ packet, text, instructions, instructionsDigest, modelInput, codec: packet.codec, version: packet.version,
      tokens: count(modelInput), payloadTokens: count(text), instructionTokens: count(instructions), evaluation, quality });
  }
  add({ codec: 'json', version: 1, data: original }, JSON.stringify(original), '', 'plain_json_baseline');
  if (allowTable) {
    try {
      const { columns, rows } = tableOf(original);
      add({ codec: 'table', version: 1, columns, rows }, JSON.stringify({ c: columns, r: rows }), TABLE_INSTRUCTIONS);
    } catch (error) {
      if (error.code !== 'INELIGIBLE_FORMAT') throw error;
      rejected.push({ codec: 'table', reason: error.code });
    }
  }
  if (allowRle) {
    try {
      const packet = rleOf(original);
      add(packet, JSON.stringify({ d: packet.dictionary, r: packet.runs }), codecInstructions('rle'));
    } catch (error) {
      if (error.code !== 'INELIGIBLE_FORMAT') throw error;
      rejected.push({ codec: 'rle', reason: error.code });
    }
  }
  if (allowAliases) {
    for (const definition of registry.available(modelProfile)) {
      try {
        const data = aliasesApply(original, definition.aliases);
        const instructions = codecInstructions('aliases', definition);
        add({ codec: 'aliases', version: definition.version, protocol: definition.id, digest: definition.digest, data },
          JSON.stringify(data), instructions, definition.evaluation.evidenceId);
      } catch (error) {
        if (!['INELIGIBLE_FORMAT', 'AMBIGUOUS_PAYLOAD'].includes(error.code)) throw error;
        rejected.push({ codec: 'aliases', protocol: definition.id, version: definition.version, reason: error.code });
      }
    }
  }
  const baseline = candidates[0];
  let selected = baseline;
  for (const candidate of candidates.slice(1)) {
    const savings = baseline.tokens - candidate.tokens;
    const ratio = baseline.tokens ? savings / baseline.tokens : 0;
    if (candidate.quality.eligible && candidate.tokens < selected.tokens && savings >= minSavingsTokens && ratio >= minSavingsRatio) selected = candidate;
  }
  return frozenCopy({ packet: selected.packet, text: selected.text, instructions: selected.instructions,
    modelInput: selected.modelInput, codec: selected.codec, version: selected.version,
    metrics: {
      counterName, measurement: 'local_estimate_not_provider_usage', baselineTokens: baseline.tokens,
      selectedTokens: selected.tokens, payloadTokens: selected.payloadTokens, instructionTokens: selected.instructionTokens,
      savingsTokens: baseline.tokens - selected.tokens,
      savingsRatio: baseline.tokens ? (baseline.tokens - selected.tokens) / baseline.tokens : 0,
      modelProfile, taskType, comprehensionEvidence: selected.quality.evidenceId ?? selected.evaluation,
      evidenceMatched: selected.codec !== 'json' && selected.quality.eligible, quality: selected.quality,
      instructionsDigest: selected.instructionsDigest, minEvidenceSamples,
      testOnlyAllowSyntheticEvidence, cacheUsage: 'not_measured',
      candidates: candidates.map(c => ({ codec: c.codec, version: c.version, tokens: c.tokens,
        payloadTokens: c.payloadTokens, instructionTokens: c.instructionTokens, instructionsDigest: c.instructionsDigest, quality: c.quality })), rejected,
    } });
}

function equivalent(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equivalent(x, b[i]));
  if (record(a) && record(b)) return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && equivalent(a[key], b[key]));
  return false;
}

/** A lossy model view; retain the original artifact independently before using it. */
export function projectInput(input, { kind = 'raw', artifactRef, maxEntries = 100, maxLineChars = 2000 } = {}) {
  if (kind === 'raw') return frozenCopy({ payload: jsonCopy(input), lossy: false, sourceRef: artifactRef ?? null, omitted: false });
  if (kind !== 'log' || typeof input !== 'string') fail('INVALID_PROJECTION', 'Log projection requires text');
  if (typeof artifactRef !== 'string' || !artifactRef.trim()) fail('ARTIFACT_REQUIRED', 'A persisted original artifact reference is required');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 2 || maxEntries > 10000
    || !Number.isSafeInteger(maxLineChars) || maxLineChars < 1 || maxLineChars > 100000) fail('INVALID_PROJECTION', 'Invalid projection bounds');
  if (Buffer.byteLength(input, 'utf8') > 32 * 1024 * 1024) fail('JSON_LIMIT', 'Log exceeds projection input limit');
  const lines = input.split(/\r\n|\n|\r/);
  const groups = [];
  for (let index = 0; index < lines.length; index++) {
    const prev = groups.at(-1);
    if (prev && prev.original === lines[index]) { prev.count++; prev.lineEnd = index + 1; }
    else groups.push({ original: lines[index], count: 1, lineStart: index + 1, lineEnd: index + 1 });
  }
  const chosen = groups.length <= maxEntries ? groups : [...groups.slice(0, Math.ceil(maxEntries / 2)), ...groups.slice(-Math.floor(maxEntries / 2))];
  const entries = chosen.map(({ original, ...position }) => ({ ...position, text: original.slice(0, maxLineChars), truncated: original.length > maxLineChars }));
  const retainedLineCount = entries.reduce((n, e) => n + e.count, 0);
  const omitted = groups.length > maxEntries || entries.some(e => e.truncated);
  return frozenCopy({ payload: { kind: 'log_view', artifact_ref: artifactRef, originalLineCount: lines.length,
    retainedLineCount, omittedLineCount: lines.length - retainedLineCount, originalGroupCount: groups.length, entries },
    lossy: true, omitted, sourceRef: artifactRef,
    notice: '仅为任务视图；连续重复行保留次数及位置，原始换行与省略内容请读取原始产物。' });
}

const EXECUTION = { starting: '启动中', in_progress: '进行中', running: '进行中', partial: '部分完成', completed: '已完成', done: '已完成', interrupted: '已中断', unknown: '未知' };
const OUTCOME = { passed: '通过', succeeded: '成功', failed: '失败', inconclusive: '未确定', not_applicable: '不适用', cancelled: '已取消', blocked: '受阻' };
const display = value => typeof value === 'string' ? value : JSON.stringify(value);

/** Deterministic labels only; it never invents a rationale or translates arbitrary prose. */
export function renderChinese(result) {
  const item = jsonCopy(result);
  if (Array.isArray(item)) return item.map((row, i) => `记录${i + 1}\n${renderChinese(row)}`).join('\n\n');
  if (!record(item)) return `原始结果：${display(item)}`;
  const lines = [];
  const used = new Set();
  function field(key, label, labels = null) {
    if (!Object.hasOwn(item, key)) return;
    used.add(key); const value = item[key];
    lines.push(`${label}：${labels && typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : display(value)}`);
  }
  field('step_id', '步骤'); field('event_id', '事件'); field('attempt_id', '执行尝试');
  field('kind', '记录类型'); field('execution_status', '执行状态', EXECUTION); field('outcome', '业务结果', OUTCOME);
  field('status', '记录状态', OUTCOME); field('exit_code', '退出码');
  for (const key of ['counts', 'facts']) {
    if (!Object.hasOwn(item, key)) continue;
    used.add(key);
    if (!record(item[key])) { lines.push(`${key}：${display(item[key])}`); continue; }
    const labels = { passed: '通过数', failed: '失败数', skipped: '跳过数', total: '总数', exit_code: '退出码' };
    for (const [name, value] of Object.entries(item[key])) lines.push(`${Object.hasOwn(labels, name) ? labels[name] : name}：${display(value)}`);
  }
  field('summary', '当时记录'); field('finding', '发现'); field('constraints', '约束');
  field('evidence_ref', '证据'); field('evidence_refs', '证据'); field('input_manifest_ref', '输入清单');
  for (const [key, value] of Object.entries(item)) if (!used.has(key)) lines.push(`${key}：${display(value)}`);
  return lines.join('\n') || '空对象：没有已记录字段。';
}
