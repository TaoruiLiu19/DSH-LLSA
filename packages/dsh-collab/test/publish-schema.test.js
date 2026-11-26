import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { publishSchema } from '../src/publish-schema.js';
import { TOOL_DESCRIPTIONS } from '../src/text-assets.js';

test('publication schema defaults to checkpoint and describes native formal-delivery boundary', () => {
  const parsed = publishSchema.parse({ stepId: 'test-evidence', result: { passed: false } });
  assert.equal(parsed.final, false);
  const schema = z.toJSONSchema(publishSchema);
  assert.equal(schema.properties.final.default, false);
  assert.match(schema.properties.final.description, /Native Superagent ticket workers must use false/);
  assert.match(schema.properties.final.description, /orchestrator_report/);
  assert.match(TOOL_DESCRIPTIONS.collab_publish, /Native Superagent ticket workers use final=false only/);
  assert.match(TOOL_DESCRIPTIONS.collab_publish, /fix the work and rerun/);
  assert.equal(publishSchema.parse({ stepId: 'child-final', result: {}, final: true }).final, true,
    'static registration still supports standalone and managed-child final; the host gate checks current scope');
});
