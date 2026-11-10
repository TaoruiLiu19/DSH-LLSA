import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket, parseExactJson } from '../src/protocol.js';

const decodeNumber = token => decodePacket(`{"codec":"json","version":1,"data":${token}}`);
const invalidNumber = error => error.code === 'INVALID_JSON_VALUE';

test('decimal and exponent spellings preserve their canonical decimal value', () => {
  const cases = [
    ['0.1', 0.1], ['-0.25', -0.25], ['-2.50e-1', -0.25],
    ['1.2300', 1.23], ['12300e-4', 1.23], ['0.0000010', 0.000001],
    ['1e-7', 1e-7], ['10e-8', 1e-7], ['5e-324', 5e-324],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['90071992547409910e-1', Number.MAX_SAFE_INTEGER],
    ['-9007199254740991', Number.MIN_SAFE_INTEGER],
    ['1E+000000', 1], ['0e99999999999999999999999', 0], ['0.000e-50', 0],
  ];
  for (const [lexeme, expected] of cases) assert.equal(decodeNumber(lexeme), expected, lexeme);
});

test('raw number lexemes cannot silently round, underflow or exceed safe integer range', () => {
  for (const lexeme of [
    '9007199254740991.1', '-9007199254740991.1',
    '90071992547409911e-1', '0.10000000000000001', '1.0000000000000001',
    '1.234567890123456789', '1e-400', '-1e-400', '4e-324',
    '9007199254740992', '9007199254740993', '9.007199254740992e15',
    '1e309', '1e99999999999999999999999', '-0', '-0.0', '-0e-2',
  ]) assert.throws(() => decodeNumber(lexeme), invalidNumber, lexeme);
});

test('precision validation applies to nested values and packet metadata', () => {
  assert.throws(() => decodePacket('{"codec":"json","version":1,"data":{"nested":[0.10000000000000001]}}'), invalidNumber);
  assert.throws(() => decodePacket('{"codec":"json","version":1.0000000000000001,"data":0}'), invalidNumber);
  assert.deepEqual(decodePacket('{"codec":"table","version":1,"columns":["x"],"rows":[[-0.25],[0.1]]}'), [{ x: -0.25 }, { x: 0.1 }]);
  assert.deepEqual(parseExactJson('[{"signed_delta":-0.25,"passed_count":1}]'), [{ signed_delta: -0.25, passed_count: 1 }]);
  assert.throws(() => parseExactJson('{"amount":9007199254740991.1}'), invalidNumber);
});

test('large equivalent spellings and leading exponent zeros are handled without giant powers', () => {
  assert.equal(decodeNumber(`1${'0'.repeat(10000)}e-10000`), 1);
  assert.equal(decodeNumber(`1e+${'0'.repeat(10000)}`), 1);
  assert.throws(() => decodeNumber(`0.${'0'.repeat(10000)}1`), invalidNumber);
  assert.throws(() => decodeNumber(`0.1${'0'.repeat(10000)}1`), invalidNumber);
});

test('exact numeric strings remain unchanged and invalid JSON syntax is still rejected', () => {
  const values = ['9007199254740991.1', '0.10000000000000001', '00012', '-0'];
  assert.deepEqual(decodePacket(JSON.stringify({ codec: 'json', version: 1, data: values })), values);
  for (const lexeme of ['01', '+1', '.1', '1.', '1e']) {
    assert.throws(() => decodeNumber(lexeme), error => error.code === 'INVALID_JSON');
  }
});
