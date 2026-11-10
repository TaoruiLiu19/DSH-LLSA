import { createHash } from 'node:crypto';
import { parseExactJson } from './protocol.js';

export const COMPUTATION_VERSION = 'safe-table-1';
export const COMPUTATION_VERSION_V2 = 'safe-table-2';
export const COMPUTATION_VERSION_V3 = 'safe-table-3';
/** Version 1 receipts remain verifiable with the original algorithm identity. */
export function computationVersion(contract) {
  if (contract?.version === '1') return COMPUTATION_VERSION;
  if (contract?.version === '2') return COMPUTATION_VERSION_V2;
  if (contract?.version === '3') return COMPUTATION_VERSION_V3;
  fail('INVALID_CONTRACT', 'Unsupported computation contract version');
}
export const VERIFICATION_SCOPE = 'Only the named result fields match this bound contract and immutable input; input authenticity, contract semantics and other claims are not verified.';
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0));
const jsonScalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
const text = value => typeof value === 'string' && value.length > 0;
const fieldName = value => text(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const keys = (value, required, label) => {
  if (!object(value) || Object.keys(value).some(key => !required.includes(key)) || required.some(key => !own(value, key))) fail('INVALID_CONTRACT', `${label} requires exactly: ${required.join(', ')}`);
};

/** Canonical JSON. Decimal metadata can be copied; arithmetic remains integer-only. */
export function canonicalJson(value) {
  if (jsonScalar(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail('INVALID_JSON_VALUE', 'Sparse or decorated arrays are unsupported');
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  fail('INVALID_JSON_VALUE', 'Only finite JSON numbers, safe when integral, without negative zero are supported');
}
export const canonicalHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

function validateClause(clause) {
  keys(clause, ['field', 'op', 'value'], 'filter clause');
  if (!fieldName(clause.field) || !['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(clause.op) || !scalar(clause.value)) fail('INVALID_CONTRACT', 'Unsupported filter field, operator, or scalar');
  if (!['eq', 'ne'].includes(clause.op) && !(typeof clause.value === 'number' && Number.isSafeInteger(clause.value))) fail('INVALID_CONTRACT', 'Ordered comparisons require safe integer values');
}
function validateFilter(filter) {
  if (!Array.isArray(filter) || filter.length > 64) fail('INVALID_CONTRACT', 'filter must be an explicit AND list with at most 64 clauses');
  for (const clause of filter) validateClause(clause);
}
function validateFields(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 64 || !fields.every(fieldName) || new Set(fields).size !== fields.length) fail('INVALID_CONTRACT', 'Projection requires 1 to 64 unique safe literal fields');
}

export function normalizeContract(contract) {
  keys(contract, ['version', 'inputRef', 'rowsPath', 'filter', 'operations', 'precision', 'nullPolicy', 'deduplicate'], 'computation');
  if (!['1', '2', '3'].includes(contract.version) || contract.precision !== 'safe_integer' || !['reject', 'skip'].includes(contract.nullPolicy) || contract.deduplicate !== false) fail('INVALID_CONTRACT', 'Versions 1, 2 and 3 require safe_integer precision, explicit reject/skip null policy, and deduplicate:false');
  if (typeof contract.inputRef !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(contract.inputRef)) fail('INVALID_CONTRACT', 'inputRef must be an immutable artifact digest');
  if (!Array.isArray(contract.rowsPath) || contract.rowsPath.length > 32 || !contract.rowsPath.every(fieldName)) fail('INVALID_CONTRACT', 'rowsPath must contain at most 32 safe literal object keys');
  validateFilter(contract.filter);
  if (!Array.isArray(contract.operations) || !contract.operations.length || contract.operations.length > 64) fail('INVALID_CONTRACT', 'Between 1 and 64 named operations are required');
  const aliases = new Set();
  for (const operation of contract.operations) {
    let required = operation?.op === 'sum' ? ['op', 'field', 'as', 'unit'] : operation?.op === 'count' ? ['op', 'as', 'unit'] : operation?.op === 'select' ? ['op', 'fields', 'as', 'unit'] : null;
    if (contract.version !== '1') {
      if (contract.version === '3' && operation?.op === 'at') required = ['op', 'index', 'as', 'unit'];
      if (operation?.op === 'pluck') required = ['op', 'field', 'as', 'unit'];
      if (['argmin', 'argmax'].includes(operation?.op)) required = ['op', 'field', 'fields', 'tie', 'empty', 'as', 'unit'];
      if (operation?.op === 'every') required = ['op', 'predicate', 'empty', 'as', 'unit'];
      if (required) required.push('filter');
    }
    if (!required) fail('INVALID_CONTRACT', 'Unsupported operation for this contract version');
    keys(operation, required, 'operation');
    if (!text(operation.as) || ['__proto__', 'prototype', 'constructor'].includes(operation.as) || aliases.has(operation.as) || !text(operation.unit)) fail('INVALID_CONTRACT', 'Operations require unique safe aliases and explicit units (labels only; no conversion)');
    aliases.add(operation.as);
    if (['sum', 'pluck', 'argmin', 'argmax'].includes(operation.op) && !fieldName(operation.field)) fail('INVALID_CONTRACT', 'Operation requires a safe literal field');
    if (['select', 'argmin', 'argmax'].includes(operation.op)) validateFields(operation.fields);
    if (contract.version !== '1') validateFilter(operation.filter);
    if (operation.op === 'at' && (!Number.isSafeInteger(operation.index) || operation.index < 0 || Object.is(operation.index, -0))) fail('INVALID_CONTRACT', 'at requires a non-negative safe integer zero-based index');
    if (['argmin', 'argmax'].includes(operation.op)
      && (operation.tie !== 'first' || operation.empty !== 'null' || !operation.fields.includes(operation.field))) fail('INVALID_CONTRACT', 'Extrema require tie:first, empty:null, and projection containing the numeric comparison field');
    if (operation.op === 'every') {
      validateClause(operation.predicate);
      if (operation.empty !== 'true') fail('INVALID_CONTRACT', 'every requires explicit empty:true (vacuous truth)');
    }
  }
  // Round-trip also rejects unsupported JSON values anywhere in the contract.
  return JSON.parse(canonicalJson(contract));
}

/** Strict parser rejects lexemes that Number would change, duplicate keys, and oversized/deep input. */
function parseInput(raw) {
  const source = Buffer.isBuffer(raw) ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : raw;
  if (typeof source !== 'string') fail('INVALID_INPUT', 'Input must be JSON bytes or text');
  let value;
  try { value = parseExactJson(source); }
  catch (error) { fail(error.code === 'INVALID_JSON_VALUE' ? 'UNSUPPORTED_NUMBER' : 'INVALID_INPUT', error.message); }
  canonicalJson(value);
  return value;
}

function field(row, name) {
  if (!own(row, name)) fail('MISSING_FIELD', `Missing field: ${name}`);
  return row[name];
}
function matches(row, clause) {
  const actual = field(row, clause.field);
  if (!scalar(actual)) fail('INVALID_FIELD_TYPE', `Filter requires a scalar: ${clause.field}`);
  // No string/number coercion; a mismatch is an input error, not a silent dropped row.
  if (actual !== null && clause.value !== null && typeof actual !== typeof clause.value) fail('INVALID_FIELD_TYPE', `Filter type differs: ${clause.field}`);
  if (clause.op === 'eq') return actual === clause.value;
  if (clause.op === 'ne') return actual !== clause.value;
  if (typeof actual !== 'number') fail('INVALID_FIELD_TYPE', `Ordered filter requires an integer: ${clause.field}`);
  if (clause.op === 'lt') return actual < clause.value;
  if (clause.op === 'lte') return actual <= clause.value;
  if (clause.op === 'gt') return actual > clause.value;
  return actual >= clause.value;
}

// Do not short-circuit validation: malformed later clauses/rows must still fail.
const filterRows = (rows, clauses) => rows.filter(row => clauses.map(clause => matches(row, clause)).every(Boolean));
const project = (row, fields) => Object.fromEntries(fields.map(name => [name, field(row, name)]));

function exactSum(rows, operation, nullPolicy) {
  let sum = 0n;
  for (const row of rows) {
    const value = field(row, operation.field);
    if (value === null && nullPolicy === 'skip') continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('INVALID_FIELD_TYPE', `sum requires safe integers: ${operation.field}`);
    sum += BigInt(value);
  }
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) fail('UNSAFE_RESULT', 'Exact sum exceeds the supported safe integer output range');
  return Number(sum);
}

function extremum(rows, operation, nullPolicy) {
  let chosen = null, chosenValue;
  for (const row of rows) {
    const value = field(row, operation.field);
    if (value === null && nullPolicy === 'skip') continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('INVALID_FIELD_TYPE', `Extremum requires safe integers: ${operation.field}`);
    // Validate requested fields on every eligible row, not only the winner.
    const projection = project(row, operation.fields);
    if (chosen === null || (operation.op === 'argmin' ? value < chosenValue : value > chosenValue)) {
      chosen = projection; chosenValue = value;
    }
  }
  return chosen;
}

export function executeComputation(contractInput, inputBytes) {
  const contract = normalizeContract(contractInput);
  let rows = parseInput(inputBytes);
  for (const key of contract.rowsPath) {
    if (!object(rows) || !own(rows, key)) fail('INVALID_INPUT', `rowsPath not found: ${key}`);
    rows = rows[key];
  }
  if (!Array.isArray(rows) || !rows.every(object)) fail('INVALID_INPUT', 'Selected input must be an array of JSON objects');
  // Check every clause for every row, even when a prior clause does not match.
  const selected = filterRows(rows, contract.filter);
  const result = {};
  const operationRows = {};
  for (const operation of contract.operations) {
    const operationInput = contract.version !== '1' ? filterRows(selected, operation.filter) : selected;
    operationRows[operation.as] = operationInput.length;
    if (operation.op === 'count') result[operation.as] = operationInput.length;
    else if (operation.op === 'at') {
      if (operation.index >= operationInput.length) fail('INDEX_OUT_OF_RANGE', 'at index exceeds the filtered array bounds');
      result[operation.as] = operationInput[operation.index];
    }
    else if (operation.op === 'select') result[operation.as] = operationInput.map(row => project(row, operation.fields));
    else if (operation.op === 'pluck') result[operation.as] = operationInput.map(row => field(row, operation.field));
    else if (operation.op === 'every') result[operation.as] = operationInput.map(row => matches(row, operation.predicate)).every(Boolean);
    else if (operation.op === 'argmin' || operation.op === 'argmax') result[operation.as] = extremum(operationInput, operation, contract.nullPolicy);
    else result[operation.as] = exactSum(operationInput, operation, contract.nullPolicy);
  }
  return { result, inputRows: rows.length, selectedRows: selected.length,
    ...(contract.version !== '1' ? { operationRows } : {}),
    contractHash: canonicalHash(contract), toolVersion: computationVersion(contract) };
}

export function resultMismatches(claim, expected) {
  if (!object(claim)) return [{ field: '*', reason: 'result must be a JSON object', expected }];
  const mismatches = [];
  for (const [key, value] of Object.entries(expected)) {
    let equal = false;
    try { equal = own(claim, key) && canonicalJson(claim[key]) === canonicalJson(value); } catch { /* Record invalid values as a mismatch. */ }
    if (!equal) mismatches.push({ field: key, expected: value, ...(own(claim, key) ? { claimed: claim[key] } : { missing: true }) });
  }
  return mismatches;
}
