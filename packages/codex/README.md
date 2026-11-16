# LeanLink for Codex

[English](README.en.md)

在 Codex 中使用 **LeanLink** 记录多 Agent 的分支结果、验收和原始证据。打开 **协作 HUD**，在对话旁查看父子 Agent、工具活动与待确认状态。

## 安装

需要 Node.js 24.11+ 和支持本地插件及生命周期 Hook 的 Codex。确认终端可以运行 `node` 和 `codex`。下载 DSH-LLSA 仓库源码后，在仓库根目录构建并注册本机插件市场。

```sh
node scripts/build-codex-marketplace.mjs
codex plugin marketplace add ./artifacts/codex-marketplace
codex plugin add leanlink-codex@dsh-llsa-codex
```

注册市场后，也可以在 Codex 桌面端的插件目录选择 **DSH-LLSA Codex**，安装 **LeanLink for Codex**。要使用归档工具，在新会话的 `$` 技能菜单中选择 **leanlink-codex:leanlink**。

## 在 Codex 中打开 HUD

1. 在 Codex 输入框旁的 **Review hooks** 或 **Settings → Hooks** 中，审核并信任本插件的 Hook。使用 CLI 时打开 `/hooks`。更新 Hook 后按 Codex 的提示重新审核。 [Codex Hook 官方文档](https://learn.chatgpt.com/docs/hooks#plugin-bundled-hooks)
2. 在仓库根目录启动 HUD。保持终端运行，复制它打印的 `http://127.0.0.1:端口/` 地址。

   ```sh
   node artifacts/codex-marketplace/plugins/leanlink-codex/hud/serve.mjs
   ```

3. 在 Windows 的 Codex 桌面端按 `Ctrl+T` 打开内置浏览器，粘贴该地址并回车。选择 **Enter split view**，或按 `Ctrl+Shift+B` 循环切换至分屏，让 HUD 与对话并排显示。macOS 对应 `Cmd+T` 和 `Cmd+Shift+B`。 [桌面浏览器官方文档](https://learn.chatgpt.com/docs/browser#arrange-tabs-and-chat)
4. 在新会话中启动任务，回到 HUD 的「会话」菜单选择对应的记录。也可以在本机独立浏览器打开同一个地址。独立浏览器支持文档画中画时，可以点「置顶画布」。

## 试一个多 Agent 任务

在 Codex 输入以下请求。

> 使用两个子 Agent，各自检查一个独立模块。先保存本轮输入，对每个分支记录简短结论和原始证据引用。对照证据验收后汇总。最后展示其中一个分支的历史引用。

用 `leanlink_lookup` 找到历史步骤，按引用调用 `leanlink_read` 可取得当时保存的原文。后续纠正会产生新输入版本，旧记录仍可回查。

## 权限与本机数据

- HUD 读取本机 Hook 留下的会话关系、状态、工具名和时间。正文、工具参数和工具结果留在原会话，LeanLink 仅归档明确交给工具的内容。
- HUD 只在 `127.0.0.1` 提供只读页面。审批在 Codex 中完成，提示状态取决于宿主发出的 Hook。「停顿」表示运行中一段时间未收到新活动。若宿主只提供共享会话 ID，HUD 将子 Agent 归在会话根节点。Token 与费用请以宿主用量为准。
- 默认数据目录为 `~/.leanlink-codex/`。如需更换，在构建市场、启动 Codex 和启动 HUD 时设置同一个绝对目录 `CODEX_LEANLINK_HOME`。HUD 没有记录时，先检查插件已启用、Hook 已受信任，再开启新会话运行一个任务。

## 本地验证

运行 `npm --prefix packages/codex test` 执行离线测试。安装本机 Codex CLI 后，运行 `node scripts/smoke-codex-plugin.mjs --native-hud`，可在隔离配置下验证 MCP 安装、历史回查和原生父子 Agent Hook，生成响应来自本机模拟端点。Windows 的 Codex 内置浏览器已用该类活动记录验证显示。
