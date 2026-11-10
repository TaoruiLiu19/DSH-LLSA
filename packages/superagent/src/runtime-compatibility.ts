/** Refuse untested Harness versions before opening state or registering tools. */
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

export const SUPPORTED_HARNESS_VERSION = '0.2.2-rc.1'

/** Read the host's official boot package; Cordis Context.version is not a Harness version. */
export function assertHarnessCompatibility(version = getDshRuntimeVersion()): void {
  if (version !== SUPPORTED_HARNESS_VERSION) {
    throw new Error(`dsh-superagent requires DeepSeek Harness ${SUPPORTED_HARNESS_VERSION}; found ${version}. Install the supported Harness version before enabling this plugin.`)
  }
}
