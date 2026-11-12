import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePort, makePatch } from '../src/start.ts';
test('default and explicit port', () => { assert.equal(parsePort(),3095); assert.equal(parsePort('3096'),3096); });
test('invalid ports fail before starting a service', () => {
  for(const value of ['0','1023','65536','3095x','3.5','-1']) assert.throws(()=>parsePort(value));
});
test('patch is local-only, requires managed lifecycle and carries no credential', () => {
  const patch=makePatch('/tmp/state','/plugin.js','/superagent.js');
  assert.equal(patch[0].insert.at(-1).config.localOnly,true);
  assert.equal(patch[0].insert.at(-1).config.requireCollaboration,true);
  assert.doesNotMatch(JSON.stringify(patch),/apiKey|password|Bearer/);
  assert.equal(patch[0].insert[0].config.moneyPolicyFile,'');
  assert.equal(makePatch('/tmp/state','/plugin.js','/superagent.js','/local/prices.json')[0].insert[0].config.moneyPolicyFile,'/local/prices.json');
});
