import test from 'node:test';
import assert from 'node:assert/strict';
import { concludeSubmitted } from '../src/turn-completion.js';

test('only a successful child final ends a turn; errors and parent review remain actionable', () => {
  let ended = 0; const execution = { concludeTurn() { ended++; } };
  for (const [result, final, child] of [[{ submitted: false }, true, true], [{ submitted: true }, false, true], [{ submitted: true }, true, false]]) {
    assert.equal(concludeSubmitted(result, final, execution, child), result);
  }
  assert.equal(ended, 0);
  concludeSubmitted({ submitted: true }, true, execution, true);
  assert.equal(ended, 1);
});
