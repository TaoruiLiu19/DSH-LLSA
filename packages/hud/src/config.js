/**
 * The plugin's own configuration schema.
 *
 * DSH renders a plugin's `Config` as a form in the plugin panel, so this is the
 * native place for our options: it lives with the plugin, survives upgrades, and
 * never touches the host's own settings implementation.
 *
 * `@deepseek-ai/schemastery` is a module of the *profile*, not of this package
 * (the package declares no dependencies), so it is resolved through a ladder:
 *
 *   1. from this module — a packed install lives inside the profile's store;
 *   2. from `DSH_PROFILE_DIR` — a linked/checkout install resolves to its real
 *      path outside the profile, where the profile's modules are still reachable.
 *
 * A missing schema only means "no settings form"; it never fails the plugin.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** @returns the schemastery module or null when it cannot be resolved. */
function loadSchema() {
  const bases = [];
  bases.push(import.meta.url);
  const profileDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR : '';
  if (profileDir !== '') bases.push(join(profileDir, 'package.json'));
  for (const base of bases) {
    try {
      const require = createRequire(base);
      const resolved = require('@deepseek-ai/schemastery');
      const schema = resolved === null || resolved === undefined ? null : (resolved.default ?? resolved);
      if (typeof schema?.object === 'function') return schema;
    } catch {
      // try the next base
    }
  }
  return null;
}

const Schema = loadSchema();

/**
 * Focus mode: the field covers the conversation while a task runs. On by default;
 * turning it off keeps the plugin installed but silent.
 */
export const Config = Schema === null ? undefined : Schema.object({
  focusMode: Schema.boolean().default(true).description('专注模式：任务运行时模糊对话区并显示圆环 HUD'),
  hudEndpoint: Schema.string().default('').description('可选：外部快照端点模板，留空则使用核心事件'),
  hudTimeoutMs: Schema.number().default(900).description('外部端点超时（毫秒）'),
  maxSessions: Schema.number().default(32).description('最多同时跟踪多少个会话'),
  childrenRefreshMs: Schema.number().default(1200).description('子智能体列表的复用时长（毫秒）'),
});
