---
name: hud
description: Start, inspect, or stop the WorkBuddy HUD companion window. Use when the user asks to see the HUD, watch agent activity, check why the HUD is blank, or change its session.
version: 0.1.0
display_name: HUD 活动视图
display_name_en: HUD activity view
description_zh: 启动 HUD 本地服务并打开伴随窗口，实时查看 WorkBuddy 会话的工具调用、材料与子 Agent 状态；也用于排查 HUD 空白。
description_en: Start the local HUD service and companion window to watch tool calls, materials and sub-agent state; also used to diagnose a blank HUD.
---

# HUD 活动视图

把 WorkBuddy 的 hook 事件画成一个只读的 canvas 场：中心是结论，外圈是材料，内圈是子 Agent。窗口是独立的，不会覆盖对话区。

## 启动

```bash
node "${CODEBUDDY_PLUGIN_ROOT}/bin/hud-service.mjs"
```

服务只监听 `127.0.0.1:4317`（可用环境变量 `HUD_PORT` 改端口）。启动后打开：

```
http://127.0.0.1:4317/view?session=<session_id>
```

`session_id` 与 hook 载荷里的 `session_id` 一致；留空时窗口显示 `default`。窗口顶部输入框可直接切换会话，不需要重启服务。

## 排查

- `/ping` 返回 `{"ok":true,...}` 说明服务活着。
- 窗口显示"未连接"：服务没启动，或端口被 `HUD_PORT` 改过而窗口地址没跟着改。
- 窗口显示"等待事件"：服务活着但该 session 还没有 hook 事件。先确认插件已启用、hooks 已加载（`/reload-plugins`），再触发一次工具调用。
- 所有材料都落在"其它"：该工具名不在共享别名表里。改 `lib/tool-map.js` 的映射，**不要改 `core/`**。

## Windows 进程树回收

从 Bash / 普通命令行启动的窗口进程会随调用结束被回收。需要长期停留时，用 WMI 让窗口脱离调用者进程树，或直接用浏览器打开上面的地址并保持浏览器常驻。服务进程同理。

## 约定

- `core/` 是生成物。功能改动一律改 `../hud/src`，然后运行 `npm run sync`。
- 改完运行 `npm run check`（同步校验 + 适配器测试）。
- hook 载荷仍是 Beta；`bin/hook-emit.mjs` 对字段做了兼容解析，失败一律静默退出 0，不会阻塞工具调用。
