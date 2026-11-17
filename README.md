<p align="center">
  <img src="assets/product-poster.png" alt="DSH-LLSA：多 Agent 分工、LeanLink 回传和证据回查" width="100%">
</p>

<h1 align="center">DSH-LLSA</h1>
<p align="center">简体中文 · <a href="README.en.md">English</a></p>
<p align="center">在本机分派多 Agent 工单，验收分支结果，并沿引用回查原始证据。</p>

<p align="center">
  <a href="https://github.com/TaoruiLiu19/DSH-LLSA/actions/workflows/ci.yml"><img src="https://github.com/TaoruiLiu19/DSH-LLSA/actions/workflows/ci.yml/badge.svg?branch=main" alt="构建与测试"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-80cbc4" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Node.js-24.11%2B-89b4fa" alt="Node.js 24.11+">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> · <a href="#第一次协作">第一次协作</a> · <a href="#可选能力">可选能力</a> · <a href="#用量与费用">用量与费用</a> · <a href="#开发与验证">开发与验证</a>
</p>

DSH-LLSA 面向用 AI 做材料核对、代码复查和数据整理的人。主 Agent 负责分派与验收，Worker 专注执行，LeanLink 回传结果与证据引用。收到用户更正后，工单会使用新的输入版本，旧结果仍可回查。

## 选择你的入口

| 你用什么 | 可以做什么 | 从哪里开始 |
| --- | --- | --- |
| **DeepSeek Harness** | 提交工单、组织子 Agent、检查结果、翻看协作记录和模型用量 | [安装组合包](#快速开始) |
| **Harness HUD** | 在 Harness 对话里看工具活动、子 Agent 状态和待确认事件 | [HUD 安装指南](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/packages/hud/README.zh.md) |
| **Codex** | 用 LeanLink 归档分支结果，通过内置浏览器分屏查看协作 HUD | [Codex 安装与分屏](#codex-分屏-hud) |
| **WorkBuddy** | 本机浏览器 HUD 开发预览 | [预览状态与启动限制](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/packages/hud-workbuddy/README.md) |

**主分支更新（2026-11-17）**

- **网页协作**源码版本为 `0.2.2`。页面、静态资源和 API 都先经过 Harness 的连接校验。启用后，用终端打印的链接完成认证，并保持 Harness 标签页打开。[变更记录](https://github.com/TaoruiLiu19/DSH-LLSA/commit/5b1cd2b38b8fae146c0546f1a2c6c9085b2aecd0)
- **WorkBuddy HUD** 新增本机网页、Hook 转发脚本和维护入口。当前检出缺少 `lib/adapter.js` 和 `lib/tool-map.js`，启动和独立测试会报模块缺失。补齐适配器后才能按指南配置 WorkBuddy。[WorkBuddy 源码说明](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/packages/hud-workbuddy/README.md)

## 快速开始

需要 **Node.js 24.11+、npm 11+**。首次安装依赖需要联网。使用 Git 下载，或从 GitHub 的 **Code → Download ZIP** 下载源码，在解压目录从 `npm ci` 开始执行。

```sh
git clone https://github.com/TaoruiLiu19/DSH-LLSA.git
cd DSH-LLSA
npm ci
npm run build
npm start
```

先打开终端打印的 Harness 认证链接。默认监听 `127.0.0.1:3095`。使用同一地址打开以下页面，保留启动终端。

| 页面 | 用途 |
| --- | --- |
| `/orchestrator/local` | 提交任务，查看工单进度和最终回复 |
| `/collab` | 运行本机精确计算，或查看协作树、工作项、证据和用量 |
| `/web-collab` | 启用网页协作后，提交初审建议或回填咨询回复 |

<details>
<summary><strong>使用 CI 构建包，跳过源码构建</strong></summary>

登录 GitHub，在 [构建记录](https://github.com/TaoruiLiu19/DSH-LLSA/actions/workflows/ci.yml?query=branch%3Amain) 中选择 `main` 的成功运行。从 **Artifacts** 下载 Windows 或 Ubuntu 的归档，解开外层 ZIP 后，按同目录的 `SHA256SUMS` 核对 `dsh-llsa-0.4.2.tgz`。

```sh
tar -xzf dsh-llsa-0.4.2.tgz
cd package
npm ci
npm start
```

保留归档中的 `vendor/`、`package.json` 和 `package-lock.json`，安装脚本会使用锁定依赖。Windows 可用 `Get-FileHash .\dsh-llsa-0.4.2.tgz -Algorithm SHA256` 核对文件，Ubuntu 可用 `sha256sum dsh-llsa-0.4.2.tgz`。Codex 和独立 HUD 的安装说明见上面的入口表。

</details>

### 不用模型 API，先跑一个例子

在 `/collab` 找到 **本机精确计算**。点击 **填入示例 → 预览规则和结果**，可以看到两条匹配记录的金额合计 **171**。点击 **确认规则并保存结果**，查看本机保存的规则、结果和执行记录。这个示例不需要模型配置，也不发出模型调用。

## 第一次协作

在 Harness 的模型设置中配置自己的模型 API，再到 `/orchestrator/local`。勾选 **最终回复必须为纯 JSON**，粘贴下面的工单并点击 **提交给 Super-agent**。

```text
请委派一个子 Agent 核对资料，并在主 Agent 验收后交付。
原始编号是字符串 "007"。测试尚未执行，修复尚未验证，当前禁止部署。
只返回一个 JSON 对象，字段为 id、test_status、fix_verified、deploy_allowed。
保留编号前导零。test_status 用 "not_run"，后两个字段用布尔值。
```

```json
{
  "id": "007",
  "test_status": "not_run",
  "fix_verified": false,
  "deploy_allowed": false
}
```

在 `/collab` 选中工单，沿协作树查看分派、结果回传和验收记录。点开保存的证据，核对 `"007"` 和两个 `false`。如果用户追加或修正资料，继续在同一工单里更新，按当前输入版本重验受影响的结果。

**接到真实任务时**，写清要核对哪些来源、哪些项可以独立分派、最后怎样算通过。简单问题可以直接问模型。材料多、分支独立、需要逐项验收时，工单能把分工和证据保存在一起。

## 可选能力

### HUD 专注视图

<p align="center">
  <img src="assets/hud-harness-example.png" alt="Harness HUD 示例，展示 Agent 的工具活动" width="42%">
  <img src="assets/hud-codex-example.png" alt="Codex HUD 演示会话，右侧为父子 Agent 树，下方为事件记录" width="54%">
</p>

**左图**为 Harness HUD，独立安装 `@dsh-llsa/hud` 后在对话里打开。**右图**为 Codex HUD 的演示会话，显示父子关系、工具活动和事件记录。HUD 只读，主 Agent 是否通过验收仍看工单结果。[Harness HUD 指南](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/packages/hud/README.zh.md)

### Codex 分屏 HUD

从**仓库源码根目录**构建并注册 **LeanLink for Codex**。需要本机 `codex` 命令和支持本地插件的 Codex 版本。

```sh
node scripts/build-codex-marketplace.mjs
codex plugin marketplace add ./artifacts/codex-marketplace
codex plugin add leanlink-codex@dsh-llsa-codex
node artifacts/codex-marketplace/plugins/leanlink-codex/hud/serve.mjs
```

在 Codex 审核并信任插件的 Hook。Windows 按 `Ctrl+T` 打开内置浏览器并粘贴终端打印的地址，再用 `Ctrl+Shift+B` 切换到分屏。开一个新会话，在 `$` 技能菜单选择 **leanlink-codex:leanlink**，然后委派任务。分支结果可用引用取回原文，HUD 会显示 Codex 提供的活动信息。[完整安装、权限和回查说明](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/packages/codex/README.md)

### 本机 CSV 工单

需要 **Python 3.10+**。在源码根目录构建完成后，或在构建包的 `package/` 中安装完成后，指定随附的样例目录。

```powershell
$env:DSH_LLSA_CSV_WORKSPACE = (Resolve-Path '.\examples\csv-workflow').Path
npm start
```

```sh
DSH_LLSA_CSV_WORKSPACE="$PWD/examples/csv-workflow" DSH_LLSA_CSV_PYTHON=python3 npm start
```

在 `/collab` 选中工单，开启 **本机 CSV**。要给新工单从首次规划起启用，启动前设置 `DSH_LLSA_CSV_DEFAULT_ON=1`。试着让主 Agent 对 `workflow.csv` 和 `workflow-next.csv` 提交同一批工作，筛选「已报名」，按邮箱保留报名时间最新的一行，再按地区计数。第一批预期 **北区 1、南区 2**，第二批预期 **东区 2、南区 1**。

筛选、去重和计数由本机执行器完成，模型负责规划、解读和验收。每批 2–4 份输入，单份最多 16 MiB，合计最多 32 MiB。通过验收后，下游按引用读取产物。工单关闭该选项后，排队中的本机 CSV 工作项会取消，已运行的步骤可继续完成并验收。[规则复用与字段映射](https://github.com/TaoruiLiu19/DSH-LLSA/tree/main/task-reuse#readme)

### 网页协作

默认关闭。停止正在运行的实例，在源码根目录或解压的 `package/` 选择对应系统的启动方式。

```powershell
$env:DSH_LLSA_WEB_COLLAB = '1'
npm start
```

```sh
DSH_LLSA_WEB_COLLAB=1 npm start
```

先打开 Harness 认证链接，再访问 `/web-collab`，在当前任务勾选 **网页协作**。手动模式可以复制问题到 ChatGPT、DeepSeek 等网页，再按咨询编号回填。配置 Open WebUI 后，已启用的任务也可以通过其 API 收取回复。网页模型提供初审或核对意见，Harness 的 Agent 负责核对资料和交付。网页端与 Harness 分开计量，Open WebUI 上游如有收费，会另行计入。[手动与 Open WebUI 配置](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/packages/web-collab/README.zh.md)

## 用量与费用

LeanLink 给分支发送可用的输入引用和验收要求，给主 Agent 回传紧凑结果和证据。长资料可分页读取，原文和历史版本在已保存记录里可查。工单的 `input:` 引用按执行批次授权，回查时从对应工单进入。主 Agent 完成验收前，分支结束只说明该轮执行已结束。

在 `/collab` 查看协作树、分支用量、缓存命中与未命中、输出、重试和缺失用量。点击连接查看已记录的派发和回传。费用滑块用于推演费率、缓存和压缩情景。实际费用要看供应商回执，也应把失败、返工和外部咨询纳入同题对照。

<details>
<summary><strong>为调用配置金额预算</strong></summary>

复制 [金额策略示例](examples/money-policy.example.json)，填写实际供应商、模型、币种和每百万 token 的费率。启动前设置 `DSH_LLSA_MONEY_POLICY` 指向配置文件的绝对路径。`maxCost` 用于一个预算周期，`maxRunCost` 用于单工单，`maxBranchCost` 用于工作项及其重试。保持相同的 `id` 可续用已有预算记录。

调用前会根据估算用量和输出额度预留费用。超限或价格缺失时，系统暂停新的受管调用，已发出的调用可能继续。未知用量持续占用预留。更改额度后重启并人工恢复；旧记录沿用当时费率。预算面板显示本机估算和预留，最终金额请以供应商账单为准。

</details>

## 使用帮助

| 问题 | 从哪里查 |
| --- | --- |
| 无法打开本机页面或显示鉴权失败 | 从终端重新打开本次启动的 Harness 认证链接。端口冲突时用 `npm start -- 3096`。 |
| 模型返回 401、429 或无法调用 | 检查 Harness 模型配置、账户额度和限流。 |
| CSV 工单找不到样例 | 确认 Python 3.10+、工单开关和 `DSH_LLSA_CSV_WORKSPACE`。输入路径以该目录为基准。 |
| Codex HUD 没有会话 | 确认服务已启动、Hook 已受信任，再开启新会话运行任务。 |
| 如何备份 | 用 `Ctrl+C` 停止服务后复制启动目录下的 `.dsh-llsa/`。可用 `DSH_LLSA_STATE` 指定其他路径。Harness 凭据由宿主单独管理。 |

提交问题时附上操作系统、Node/npm 版本、启动方式和脱敏报错。保管好模型密钥、Harness 认证链接和本地数据库。

## 开发与验证

| 组件 | 源码版本与职责 |
| --- | --- |
| 组合包、启动器、Super-agent、Collab | `0.4.2`。本机启动、工单编排、LeanLink 交接和记录 |
| DeepSeek Harness | 锁定 `0.2.2-rc.1` |
| Web Collab | `0.2.2`。可选网页咨询 |
| Harness HUD | `0.4.5` 源码，单独安装 |
| Codex / WorkBuddy HUD | Codex 由源码注册本机市场，WorkBuddy 的源码入口处于预览检查状态 |

```sh
npm run check
npm run typecheck
npm test
npm run check --prefix packages/hud
npm run pack:release
npm run verify:rebuild
npm run verify:kit
```

CI 在 Windows 和 Ubuntu 上验证构建、隔离安装和包的 SHA-256。可另用 `node scripts/smoke-codex-plugin.mjs --native-hud` 在本机验证 Codex 的 MCP 安装、原文回查和原生父子 Agent Hook。它使用本地模拟端点。

<details>
<summary><strong>HUD v1 只读快照与兼容契约</strong></summary>

编排层已预留多智能体工作状态投影，不依赖 HUD 包，也不实现浮窗布局或动画。

- 读取现有 `GET /collab/api/runs/:runId?view=hud`，获得符合 [HUD v1 Schema](contracts/hud-v1.schema.json) 的脱敏快照；不新增端点。
- 原有完整任务快照保留兼容字段，新增 `hud`，以及与其一致的顶层 `v`、`seq`、`now`。浮窗应使用 `view=hud`，不要读取原始 `events` 或自行推导状态。
- `agents` 提供稳定 ID、父子关系、工单、五态、状态起始时间、静默标记和最小活动事件。`label` 是最多 12 个 Unicode 字符的短名：任务标题优先，其次会话标题；移除路径、URL、邮箱、纯数字 ID、代码与换行，过滤后为空则使用角色或“智能体”。原生 Assignment 无独立标题字段，适配器取关联任务的 `execution.name` / `ticket.title`；托管子任务使用分配时的 objective。每次 assignment 的短名持久化固定，变更经带 `label` 的 `agent.register` 发布。父节点可能属于另一个工单快照，不能据此猜测其活动状态。
- `seq` 在每个 run 内单调递增，重启不清零；客户端按 `(runId, seq)` 维护游标，跨 run 不可比较。轮询时间与 `stalled` 变化不会增加序号。`stalledAfterMs` 默认为 20000；只有 `running` 可以静默。`stalled` 由服务端计算，客户端只展示服务端值，不自行判断失败或静默。
- `tool` 保留原生工具 ID。快照按可见工具活动选择 `aliasVersion`。普通活动用 1，CSV 工具用 2，涉及 `collab_consult_web` 时用 3。HUD 快照的 `v` 仍为 1。旧映射保留，自定义名称或第三方工具可落“其它”。[别名表 v1](contracts/tool-aliases-v1.json) · [v2](contracts/tool-aliases-v2.json) · [v3](contracts/tool-aliases-v3.json)
- `events` 是最近 256 条最小事件，`eventsFromSeq` 给出窗口起点。若客户端游标落后于窗口，直接采用最新状态并跳过丢失的动画，不回放猜测事件。事件的 `seq`、`agentId` 用于寻址；`state.changed` 额外提供 `from/to/reason`。
- turn 正常结束的 `done` 只表示本轮结束，不代表工单验收通过。取消或输入作废为 `idle`；进程重启后未闭合 turn 清理为 `idle`。缺失的工具/turn 结束以 `synthetic: true` 和原因显式补齐，绝不冒充成功。工具 id 不含参数、路径、命令或输出。
- 实际状态接入 `turn/start/end`、`tool/call/result`、审批对象与用户问题回复。等待确认不会因工具等待超时自动消失；收到用户回复后按是否有打开的 turn 恢复。历史上尚未接入的活动不补造。

浮窗开发可以直接读取五份回放夹具中的 `frames`：
[正常一轮](contracts/fixtures/hud-normal.json)、[输入作废](contracts/fixtures/hud-invalidated.json)、[重启清理](contracts/fixtures/hud-restarted.json)、[审批与提问等待／恢复](contracts/fixtures/hud-attention.json)、[20 秒静默边界](contracts/fixtures/hud-stalled.json)，另有 [短名边界用例](contracts/fixtures/hud-labels.json)。无需导入 manager/store 或投影实现。`steps` 的状态、序号与边界期望独立编写；同一事件序列必须生成相同 `frames`。`node scripts/update-hud-fixtures.mjs` 只刷新 frames，不修改期望值。

待确认由宿主 `userQuestions` 结构化视图、阻塞请求生命周期和 `approval/asked` / `approval/decided` 驱动，HUD 不解析工具返回文本。统一使用既有 `attention.raised`、`attention.resolved`；只有状态实际改变才发 `state.changed`。多个对象须全部处理后才恢复：有打开的 turn 则 running，否则 idle；取消清空集合并回到 idle，迟到的旧对象不会重新点亮。

兼容约定：本次保持 `v: 1`。加字段、kind 或状态属于约定的非破坏性扩展；既有字段语义保持不变。未来破坏性变更必须在同一个 PR 更新 schema、投影、夹具与回放测试；v1 继续默认，v2 由客户端显式选择，两个版本短期并存。只有可视化端明确确认迁移完成后才可弃用 v1。本版尚未发布 v2。独立安装、单智能体降级和视觉材料映射由 HUD 实现方负责。

</details>

终止服务后备份全部状态目录再升级。升级 Harness 时应同时检查锁定依赖、输入版本、验收和停止恢复，验证旧数据能继续读取。默认本机入口使用回环地址。外部集成启用后可使用本机凭据，`DSH_SUPERAGENT_BLOCKED_COMMANDS` 只提供命令限制建议。

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [DeepSeek Super-agent 研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype/commit/8c32a9dc5d72c033816c6a8110b37f40cf94fba4) 的独立扩展。 [MIT 许可](LICENSE) · [上游署名](NOTICE) · [Changelog](CHANGELOG.md)
