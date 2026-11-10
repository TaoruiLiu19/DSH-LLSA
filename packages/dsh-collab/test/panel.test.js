import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { PANEL_HTML, PANEL_SCRIPT, TOOL_DESCRIPTIONS } from '../src/text-assets.js';

test('assembled panel includes styles and a parsable external browser script', () => {
  assert.doesNotMatch(PANEL_HTML, /PANEL_STYLES/);
  assert.match(PANEL_HTML, /<style>[\s\S]*:root/);
  assert.match(PANEL_HTML, /src="\/collab\/panel.js"/);
  assert.doesNotThrow(() => new Script(PANEL_SCRIPT));
  assert.doesNotMatch(PANEL_SCRIPT, /innerHTML|insertAdjacentHTML|document\.write/);
  for (const id of ['start-task', 'inspect', 'read-artifact', 'pause', 'resume']) {
    assert.ok(PANEL_HTML.includes(`id="${id}"`), `Missing UI target: ${id}`);
  }
});

test('tool prompt assets retain their constraints and render as single paragraphs', () => {
  assert.equal(Object.keys(TOOL_DESCRIPTIONS).length, 10);
  for (const text of Object.values(TOOL_DESCRIPTIONS)) {
    assert.ok(text.length > 40);
    assert.doesNotMatch(text, /[\r\n]/);
  }
  assert.match(TOOL_DESCRIPTIONS.collab_delegate, /results require collab_accept/);
  assert.match(TOOL_DESCRIPTIONS.collab_send, /otherwise it sends JSON/);
  assert.match(TOOL_DESCRIPTIONS.collab_complete_computation, /No result values or rule overrides/);
});
