import { canonicalHash } from './computation.js';

export const SECTION_LOOKUP_VERSION = 'section-pipe-lookup-1';
const MAX_SECTION_BYTES = 96 * 1024;
const MAX_ROWS = 2000;
const MAX_RESULT_BYTES = 4096;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function fieldName(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 96 && name.trim() === name &&
    name.isWellFormed() && !/[\p{Cc}|\\]/u.test(name) && !forbiddenKeys.has(name);
}

function keys(value, required, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

/** The caller supplies an explicit operation and source-field mapping, never executable code. */
export function normalizeSectionLookup(lookup) {
  if (!keys(lookup, ['filters', 'fields'], ['sectionField']) || !Array.isArray(lookup.filters) ||
      lookup.filters.length < 1 || lookup.filters.length > 12 ||
      !Array.isArray(lookup.fields) || lookup.fields.length < 1 || lookup.fields.length > 24 ||
      (lookup.sectionField !== undefined && !fieldName(lookup.sectionField))) {
    fail('INVALID_SECTION_LOOKUP', 'Provide up to 12 exact filters, 24 typed output fields, and an optional heading output field.');
  }
  const filters = lookup.filters.map(filter => {
    if (!keys(filter, ['field', 'equals']) || !fieldName(filter.field) || typeof filter.equals !== 'string' ||
        filter.equals.length > 256 || !filter.equals.isWellFormed() || /[\r\n]/u.test(filter.equals)) {
      fail('INVALID_SECTION_LOOKUP', 'Filters require an exact column name and text value.');
    }
    return { field: filter.field, equals: filter.equals };
  });
  if (new Set(filters.map(filter => filter.field)).size !== filters.length) {
    fail('INVALID_SECTION_LOOKUP', 'Use one exact match criterion per column.');
  }
  const fields = lookup.fields.map(field => {
    if (!keys(field, ['field', 'type'], ['as']) || !fieldName(field.field) ||
        (field.as !== undefined && !fieldName(field.as)) || !['text', 'integer'].includes(field.type)) {
      fail('INVALID_SECTION_LOOKUP', 'Each output field requires a column name and type text or integer.');
    }
    return { field: field.field, as: field.as ?? field.field, type: field.type };
  });
  const names = fields.map(field => field.as);
  if (lookup.sectionField !== undefined) names.push(lookup.sectionField);
  if (new Set(names).size !== names.length) fail('INVALID_SECTION_LOOKUP', 'Output field names must be distinct.');
  return { filters, fields, ...(lookup.sectionField !== undefined ? { sectionField: lookup.sectionField } : {}) };
}

function readPipeTable(raw, assignedTitle) {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_SECTION_BYTES) fail('UNSUPPORTED_SECTION_TABLE', 'Section exceeds the local table size limit.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    fail('UNSUPPORTED_SECTION_TABLE', 'Section must be exact UTF-8 text.');
  }
  const [heading, ...body] = text.trimEnd().split(/\r\n|\r|\n/u);
  const title = /^ {0,3}##[ \t]+(.+?)\s*$/u.exec(heading)?.[1].replace(/[ \t]+#+$/u, '').trim();
  if (title !== assignedTitle) fail('UNSUPPORTED_SECTION_TABLE', 'Assigned heading could not be read without ambiguity.');
  while (body[0]?.trim() === '') body.shift();
  if (body.length < 2 || body.length > MAX_ROWS + 2) fail('UNSUPPORTED_SECTION_TABLE', 'Section must contain one bounded pipe table.');
  const header = body[0].trim();
  const leading = header.startsWith('|');
  const trailing = header.endsWith('|');
  function split(line) {
    line = line.trim();
    if (line.startsWith('|') !== leading || line.endsWith('|') !== trailing || /\\\|/u.test(line)) {
      fail('UNSUPPORTED_SECTION_TABLE', 'Pipe delimiters are inconsistent or escaped.');
    }
    const joined = line.slice(leading ? 1 : 0, trailing ? -1 : undefined);
    if (!joined.includes('|')) fail('UNSUPPORTED_SECTION_TABLE', 'Every table row must contain at least two columns.');
    return joined.split('|').map(value => value.trim());
  }
  const columns = split(header);
  if (columns.length > 64 || !columns.every(fieldName) || new Set(columns).size !== columns.length) {
    fail('UNSUPPORTED_SECTION_TABLE', 'Table columns must have distinct, supported names.');
  }
  const rows = body.slice(1).map(split);
  if (rows.some(row => row.length !== columns.length)) fail('UNSUPPORTED_SECTION_TABLE', 'Table rows must have the same width as the header.');
  if (rows[0]?.every(value => /^:?-{3,}:?$/u.test(value))) rows.shift();
  if (!rows.length || rows.length > MAX_ROWS) fail('UNSUPPORTED_SECTION_TABLE', 'No bounded set of data rows follows the header.');
  return { columns, rows };
}

/** Match exactly one row and project the requested fields. The bound source remains independently readable. */
export function executeSectionLookup(contract, raw) {
  const { columns, rows } = readPipeTable(raw, contract.title);
  const column = field => {
    const index = columns.indexOf(field);
    if (index < 0) fail('INVALID_SECTION_LOOKUP', `Column is absent: ${field}`);
    return index;
  };
  const filters = contract.lookup.filters.map(filter => [column(filter.field), filter.equals]);
  const fields = contract.lookup.fields.map(field => ({ ...field, index: column(field.field) }));
  const matched = rows.filter(row => filters.every(([index, value]) => row[index] === value));
  if (matched.length !== 1) fail('SECTION_LOOKUP_NOT_UNIQUE', `An exact lookup requires one matching row; found ${matched.length}.`);
  const entries = contract.lookup.sectionField ? [[contract.lookup.sectionField, contract.title]] : [];
  for (const { index, as, type } of fields) {
    const value = matched[0][index];
    if (type === 'text') {
      entries.push([as, value]);
      continue;
    }
    if (!/^(?:0|-?[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
      fail('INVALID_SECTION_FIELD_TYPE', `Selected field is not an exact safe integer: ${as}`);
    }
    entries.push([as, Number(value)]);
  }
  const result = Object.fromEntries(entries);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
    fail('SECTION_LOOKUP_RESULT_TOO_LARGE', 'Reduce the selected output fields to a bounded result.');
  }
  return { result, toolVersion: SECTION_LOOKUP_VERSION, contractHash: canonicalHash(contract), inputRef: contract.inputRef, modelCalls: 0 };
}
