import { ID_PATTERN, MAX_PAGE_BYTES, MAX_TEXT_BYTES, REF_PATTERN, ToolError } from './store.mjs';

const id = { type: 'string', pattern: ID_PATTERN };
const ref = { type: 'string', pattern: REF_PATTERN };
const text = { type: 'string', maxLength: MAX_TEXT_BYTES };
const version = minimum => ({ type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER });
const choices = (...values) => ({ type: 'string', enum: values });

function tool(name, description, properties, optional = [], readOnlyHint = false) {
  const fields = { workspace: id, run: id, ...properties };
  return { name: `leanlink_${name}`, description,
    inputSchema: { type: 'object', additionalProperties: false, properties: fields,
      required: Object.keys(fields).filter(field => !optional.includes(field)) },
    annotations: { readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}

export const tools = [
  tool('submit', 'Save exact task input and return a version and reference. Use expectedVersion=0 for a new run. Reuse opId on retries.',
    {opId: id, expectedVersion: version(0), text}),
  tool('checkpoint', 'Save an exact step checkpoint or a result for review. Use its short reference to hand it off.',
    {opId: id, inputVersion: version(1), step: id, text,
      kind: {...choices('checkpoint', 'result'), default: 'checkpoint'}, summary: {type: 'string', maxLength: 160}}, ['kind', 'summary']),
  tool('review', 'Accept or reject an immutable result for the current input version. Read the result first if needed.',
    {opId: id, ref, decision: choices('accepted', 'rejected'), reason: {type: 'string', minLength: 1, maxLength: 320}}),
  tool('lookup', 'Find saved input, steps and decisions without loading their text. Keep throughSeq fixed when paging history.',
    {step: id, afterSeq: {...version(0), default: 0}, throughSeq: version(0),
      limit: {type: 'integer', minimum: 1, maximum: 50, default: 12}}, ['step', 'afterSeq', 'throughSeq', 'limit'], true),
  tool('read', 'Read exact saved text by reference. Use nextStart for consecutive UTF-8 byte ranges.',
    {ref, start: {...version(0), default: 0}, bytes: {type: 'integer', minimum: 1, maximum: MAX_PAGE_BYTES, default: 4096}}, ['start', 'bytes'], true),
];

const routes = new Map(tools.map(definition => [definition.name, definition]));
const invalid = message => new ToolError('INVALID_ARGUMENT', message);
export function findTool(name) { return routes.get(name); }

function validValue(value, schema) {
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  if (typeof value !== 'string' || !value.isWellFormed()) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (schema.maxLength !== undefined && Array.from(value).length > schema.maxLength) return false;
  return schema.minLength === undefined || value.length >= schema.minLength;
}

export function invoke(archive, definition, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw invalid('Tool arguments must be an object');
  const { properties, required } = definition.inputSchema;
  if (Object.keys(args).some(name => !Object.hasOwn(properties, name))) throw invalid('Unexpected tool argument');
  const normalized = {};
  for (const [name, schema] of Object.entries(properties)) {
    if (!Object.hasOwn(args, name)) {
      if (required.includes(name)) throw invalid(`Missing argument: ${name}`);
      if (Object.hasOwn(schema, 'default')) normalized[name] = schema.default;
      continue;
    }
    if (!validValue(args[name], schema)) throw invalid(`Invalid argument: ${name}`);
    normalized[name] = args[name];
  }
  if (normalized.text !== undefined && Buffer.byteLength(normalized.text) > MAX_TEXT_BYTES) {
    throw invalid(`Text exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
  }
  if (normalized.reason !== undefined && !normalized.reason.trim()) throw invalid('Reason cannot be blank');
  return archive[definition.name.slice('leanlink_'.length)](normalized);
}
