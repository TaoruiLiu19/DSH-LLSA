# HUD for WorkBuddy（本地网页版）

把 DSH 版 HUD 搬到 WorkBuddy 的**本地网页形态**：hook → 本地服务 → 浏览器窗口。只读、零运行时依赖、不打包成插件。

> **当前源码状态 · Source preview**
>
> 干净检出缺少 `lib/adapter.js` 和 `lib/tool-map.js`。启动服务和运行适配器测试都会失败。补齐文件后，请先在仓库根目录运行 `npm --prefix packages/hud-workbuddy run check`，通过后再继续下面的本机配置。
>
> A clean checkout is missing `lib/adapter.js` and `lib/tool-map.js`. The service and adapter tests need these files. Once restored, run `npm --prefix packages/hud-workbuddy run check` before configuring hooks.

## 它是什么

"单核双壳"里的 WorkBuddy 壳，只保留网页这一层：

- `core/` —— 从 `../hud/src` 同步来的共享内核（model / materials / labels / render），1826 行，零 DOM 依赖。
- `lib/` —— WorkBuddy 专属适配：hook JSON → hud-v1 事件、工具名归一化。
- `bin/hud-service.mjs` —— 本地只读服务，接收事件、提供快照和网页。
- `bin/hook-emit.mjs` —— hook 转发脚本，stdin JSON → 本地服务，失败静默退出 0。
- `view/` —— canvas 视图页面（不依赖 React，不用 DSH 的 overlay 插槽）。

DSH 原包 `packages/hud` 保持原样，继续在 DSH 里工作。本包不进任何插件市场。

## 本地使用

### 1. 启动服务

```bash
node packages/hud-workbuddy/bin/hud-service.mjs
```

服务只监听 `127.0.0.1:4317`，可用环境变量 `HUD_PORT` 改端口。

### 2. 打开网页

```
http://127.0.0.1:4317/view?session=<session_id>
```

浏览器打开即可，可拖到副屏。页面每 240ms 拉一次快照；顶部输入框可切换 session。

### 3. 配置 hook（一次性）

把下面内容合并进 `~/.workbuddy/settings.json` 的 `hooks` 字段（路径按本机实际位置改）：

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "PermissionDenied": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "Elicitation": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "ElicitationResult": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node \"E:/DSH-LLSA/DSH-LLSA/packages/hud-workbuddy/bin/hook-emit.mjs\"" }] }]
  }
}
```

改完下一次工具调用即生效，无需重启。hook 功能处于 Beta；`type: http` 的请求体契约未文档化，所以用 `command` 转发脚本，失败一律静默退出 0，不阻塞工具调用。

## 事件映射

| hud-v1 | WorkBuddy hook |
|---|---|
| `turn.start` | `UserPromptSubmit`；`PreToolUse` 在装晚时补发 |
| `tool.start` / `tool.end` | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` |
| `attention.raised` / `resolved` | `PermissionRequest` / `PermissionDenied`、`Elicitation` / `ElicitationResult` |
| `state.changed` | 上述事件附带的状态迁移、`SubagentStart` / `SubagentStop`、`Stop` / `StopFailure` |
| `agent.register` | `SessionStart`、子 Agent 启动 |
| `stalled` | 由服务按 `lastActivity` + 20s 阈值 stamps，客户端不重算 |

`Notification` 不单独产生 attention 信号，避免和 `PermissionRequest` 重复计数。

工具名在 `lib/tool-map.js` 里归一化：`WebFetch` → `web_fetch`、`Bash` → `bash`、`PowerShell` → `pwsh`、`Agent` → `subagent`。未知工具落"其它"，不猜。

## 维护约定（重要）

这套设计的目标是**改一处**：

| 你要改的东西 | 改哪里 |
|---|---|
| 材料分类、配色、文案、动效、fold 逻辑、生命周期 | `../hud/src`，然后 `npm run sync` |
| hook 事件映射、工具名映射、端口、网页布局 | 本包的 `lib/`、`bin/`、`view/` |
| DSH 专属行为 | `../hud/src/index.js`、`focus.js`、`client-entry.js`（本包不碰） |

`core/` 是**生成物，不要手改**。它带 `.manifest.json` 里的 sha256 指纹，`npm run check` 会拒绝被改过或没同步的副本。双包版本号要一起升。

```bash
npm run sync    # 从 ../hud 重新生成 core/
npm run check   # 同步校验 + 适配器测试
npm run test    # 只跑测试
```

## 已知限制

- WorkBuddy 没有前端 UI 插槽，HUD 只能是独立网页，不能像 DSH 那样覆盖并模糊对话区。
- 只跟随窗口里选中的那一个 session，没有多会话角标。
- Windows 进程树回收会杀掉从 Bash 启动的服务进程，需要 WMI 或让浏览器常驻。
- 不解析工具返回值、不把静默当状态——这是从 DSH 内核继承的约束。
- 本包不发布到任何市场，也不需要插件装载器。
