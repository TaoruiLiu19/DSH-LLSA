# HUD for WorkBuddy

把 DSH 版 HUD 搬到 WorkBuddy 的宿主壳。**只读、零运行时依赖、不覆盖对话区**。

## 它是什么

"单核双壳"里的 WorkBuddy 壳：

- `core/` —— 从 `../hud/src` 同步来的共享内核（model / materials / labels / render），1826 行，零 DOM 依赖。
- `lib/` —— WorkBuddy 专属适配：hook JSON → hud-v1 事件、工具名归一化。
- `hooks/hooks.json` —— 把 15 类 hook 事件转给本地服务。
- `bin/` —— 本地服务与 hook 转发脚本。
- `view/` —— 独立窗口的 canvas 视图（不依赖 React，不用 DSH 的 overlay 插槽）。

DSH 原包 `packages/hud` 保持原样，继续在 DSH 里工作。

## 本地使用

```bash
# 开发期用 --plugin-dir 直接加载，不需要发布
codebuddy --plugin-dir ./packages/hud-workbuddy

# 启动服务
node packages/hud-workbuddy/bin/hud-service.mjs

# 浏览器打开伴随窗口
# http://127.0.0.1:4317/view?session=<session_id>
```

插件启用后 hook 自动注册；改了文件运行 `/reload-plugins`。

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
| hook 事件映射、工具名映射、端口、窗口布局 | 本包的 `lib/`、`bin/`、`view/` |
| DSH 专属行为 | `../hud/src/index.js`、`focus.js`、`client-entry.js`（本包不碰） |

`core/` 是**生成物，不要手改**。它带 `.manifest.json` 里的 sha256 指纹，`npm run check` 会拒绝被改过或没同步的副本。双包版本号要一起升。

```bash
npm run sync    # 从 ../hud 重新生成 core/
npm run check   # 同步校验 + 适配器测试
npm run test    # 只跑测试
```

## 已知限制

- WorkBuddy 没有前端 UI 插槽，HUD 只能是独立窗口，不能像 DSH 那样覆盖并模糊对话区。
- Hook 功能处于 Beta；`type: http` 的请求体契约未文档化，所以这里用 `command` 转发脚本而不是裸 http hook。字段做了兼容解析，未来 SDK 稳定后可切到 http 以省掉每次的进程启动。
- 只跟随窗口里选中的那一个 session，没有多会话角标。
- Windows 进程树回收会杀掉从 Bash 启动的窗口/服务进程，需要 WMI 或常驻浏览器。
- 不解析工具返回值、不把静默当状态——这是从 DSH 内核继承的约束。

## 本地分发（未上传）

本包**没有发布到任何市场**。开发期用 `codebuddy --plugin-dir` 加载。将来要分发时，建一个带 `.codebuddy-plugin/marketplace.json` 的仓库指向本目录，用户执行：

```
/plugin marketplace add <owner>/<repo>
/plugin install hud-workbuddy@<marketplace>
```
