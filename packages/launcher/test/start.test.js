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
test('web collaboration is mounted only on opt-in', () => {
  const disabled = makePatch('/tmp/state', '/plugin.js', '/superagent.js')[0].insert;
  assert.equal(disabled.some(({ id }) => id === 'llsa-web-collab'), false);
  assert.equal(disabled.find(({ id }) => id === 'llsa-superagent').config.webCollaboration, undefined);
  const enabled = makePatch('/tmp/state', '/plugin.js', '/superagent.js', '', undefined, 'C:\\app\\web-collab\\index.js')[0].insert;
  assert.equal(enabled.find(({ id }) => id === 'llsa-superagent').config.webCollaboration, true);
  assert.equal(enabled.find(({ id }) => id === 'llsa-web-collab').name, 'C:/app/web-collab/index.js');
});
