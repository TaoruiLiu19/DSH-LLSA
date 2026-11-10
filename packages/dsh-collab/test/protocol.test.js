import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExactJson } from '../src/protocol.js';

test('exact JSON rejects duplicate members instead of silently overwriting evidence', () => {
  assert.throws(() => parseExactJson('{"a":1,"a":2}'), { code: 'DUPLICATE_KEY' });
});

test('exact JSON rejects integers beyond Number safe precision', () => {
  assert.throws(() => parseExactJson('{"n":9007199254740993}'), { code: 'INVALID_JSON_VALUE' });
});

test('exact JSON rejects numeric overflow', () => {
  assert.throws(() => parseExactJson('{"n":1e400}'), { code: 'INVALID_JSON_VALUE' });
});

test('exact JSON rejects trailing content after the value', () => {
  assert.throws(() => parseExactJson('{"a":1} x'), { code: 'INVALID_JSON' });
});

test('exact JSON keeps __proto__ as an own data member without prototype pollution', () => {
  const value = parseExactJson('{"__proto__":{"polluted":true}}');
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(value.__proto__, { polluted: true });
  assert.equal({}.polluted, undefined);
});

test('exact JSON preserves a valid mixed object and array', () => {
  assert.deepEqual(parseExactJson('{"a":1,"b":[true,null,"x"]}'), { a: 1, b: [true, null, 'x'] });
});

test('exact JSON rejects decimal rounding but accepts canonical decimal values', () => {
  assert.throws(() => parseExactJson('0.10000000000000001'), { code: 'INVALID_JSON_VALUE' });
  assert.equal(parseExactJson('0.1'), 0.1);
  assert.equal(parseExactJson('1.2300e2'), 123);
});

test('exact JSON bounds nesting before materializing deeply nested input', () => {
  assert.throws(() => parseExactJson('['.repeat(66) + '0' + ']'.repeat(66)), { code: 'JSON_LIMIT' });
});
