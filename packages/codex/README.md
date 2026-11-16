# LeanLink for Codex

[English](README.en.md)

在 Codex 中使用 LeanLink 记录多 Agent 的分支结果，留存原文并按步骤回查。独立 HUD 显示 Codex 的父子 Agent、工具活动与待确认状态。

## 安装

需要 Node.js 24.11+ 和支持本地插件及生命周期 Hook 的 Codex。让 `node` 和 `codex` 在终端中可用。在仓库根目录运行以下命令。

```sh
node scripts/build-codex-marketplace.mjs
codex plugin marketplace add ./artifacts/codex-marketplace
codex plugin add leanlink-codex@dsh-llsa-codex
```

也可以从 Codex 桌面端的插件目录选择 **DSH-LLSA Codex** 来源，安装 **LeanLink for Codex**。开启新会话，从 `$` 技能菜单选择 **leanlink-codex:leanlink**。

### 打开 HUD

```sh
node artifacts/codex-marketplace/plugins/leanlink-codex/hud/serve.mjs
```

打开终端打印的本机地址。首次使用时，在 Codex 的 **Review hooks** 或 **Settings → Hooks** 审核并信任此插件的 Hook。命令行使用 `/hooks`。信任后，在新会话中开始任务即可看到活动。HUD 是独立页面。浏览器支持文档画中画时，可以将它置顶。

### 试一个多 Agent 任务

在 Codex 输入以下请求。

> 使用两个子 Agent，各自检查一个独立模块。先保存本轮输入，对每个分支记录简短结论和原始证据引用。对照证据验收后汇总。最后展示其中一个分支的历史引用。

用 `leanlink_lookup` 找到历史步骤，按引用调用 `leanlink_read` 可取得当时保存的原文。后续纠正会产生新输入版本，旧记录仍可回查。若 Codex 只提供共享会话 ID，HUD 会把子 Agent 挂到会话根节点。这个版本的 HUD 暂无 token 和费用指标。

## 本机数据

默认保存在 `~/.leanlink-codex/`。如需更换目录，在构建市场以及启动 Codex 和 HUD 时设置同一个绝对目录 `CODEX_LEANLINK_HOME`。LeanLink 仅归档明确交给工具的内容，HUD 只记录状态元数据。工具回传更短的引用和摘要，实际用量和费用需要同任务对照。

从源码运行测试可使用 `npm --prefix packages/codex test`。
有本机 Codex 时，可以运行 `node scripts/smoke-codex-plugin.mjs --native-hud`，用隔离配置验证真实 MCP 安装、历史回查和父子 Agent 的实际 Hook。生成响应来自本地模拟端点。
