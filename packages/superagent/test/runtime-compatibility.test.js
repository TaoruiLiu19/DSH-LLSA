import assert from 'node:assert/strict'
import test from 'node:test'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { assertHarnessCompatibility, SUPPORTED_HARNESS_VERSION } from '../src/runtime-compatibility.ts'

test('verifies the actual official Harness boot package', () => {
  assert.equal(getDshRuntimeVersion(), SUPPORTED_HARNESS_VERSION)
  assert.doesNotThrow(() => assertHarnessCompatibility())
})

test('refuses older, newer, non-matching prereleases and Cordis versions', () => {
  for (const version of ['0.2.1-alpha.2', '0.2.2-rc.2', '0.2.2', '0.3.0', '4.1.0', '']) {
    assert.throws(() => assertHarnessCompatibility(version), /requires DeepSeek Harness 0\.2\.2-rc\.1/)
  }
})
