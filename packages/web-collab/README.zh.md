# DSH-LLSA 网页协作

**提交之前多一个人看一眼——但不用把仓库交给任何网页。**

[English](README.md) · [提交记录](https://github.com/TaoruiLiu19/DSH-LLSA/commits/main/packages/web-collab)

[![npm](https://img.shields.io/npm/v/@dsh-llsa/web-collab.svg)](https://www.npmjs.com/package/@dsh-llsa/web-collab)
[![downloads](https://img.shields.io/npm/dm/@dsh-llsa/web-collab.svg)](https://www.npmjs.com/package/@dsh-llsa/web-collab)
[![license](https://img.shields.io/npm/l/@dsh-llsa/web-collab.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@dsh-llsa/web-collab.svg)](package.json)
[![tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)](#开发)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-none-brightgreen.svg)](package.json)

一个**按需开启**的 DeepSeek Harness 插件：它提供一个面板，你把任务资料和初审建议贴进去，Agent 可以就某个具体疑点去问一次网页对话。**核验原始资料与交付结果的职责仍由 Harness Agent 承担**——网页回复是待核验的意见，不是可信任的结果。

默认关闭；只在本机回环的 Web 服务上挂载；你不贴，它就不发。

## 三种使用形态

| 形态 | 行为 |
|---|---|
| **单 Agent** | 粘贴文本或 UTF-8 附件，填入初审建议；Harness 发起**一次**生成请求来核对并交付 |
| **多智能体** | 粘贴任务资料，初审建议可留空，由子 Agent 自行判断要不要核对疑点。每次子任务尝试**最多咨询一次**，问题上限 **1024 UTF-8 字节**。短回复随工具结果返回，完整 Markdown 留在本机协作记录供查阅 |
| **公开聊天网页** | 手动复制回填。子 Agent 的提问需保留 Markdown 第一行的咨询编号。配置 Open WebUI 后可从其官方接口自动获取回复 |

## 开启方式

组合包内置的网页协作**默认关闭**。启动 DSH-LLSA 时带上：

```sh
DSH_LLSA_WEB_COLLAB=1
```

先打开终端的 Harness 认证链接，再进入同一地址的 **`/web-collab`**。选择任务并勾选 **网页协作** 才会真正发起咨询。清除该变量（或设为 `0`）后重启，即可关闭。

要让 Open WebUI 自动取回回复，在**启动前**设置：

```sh
DSH_WEB_COLLAB_OPEN_WEBUI_URL=…
DSH_WEB_COLLAB_OPEN_WEBUI_MODEL=…
DSH_WEB_COLLAB_OPEN_WEBUI_KEY=…
```

非本机实例必须使用 HTTPS。

## 什么会离开这台机器

- **只有你贴进去的内容。** 面板不读你的仓库，插件也不采样你的会话。
- **每个请求先过 Harness 的连接栅栏。** `ctx.connection.requestRejection()` 应用 Host/Origin 准入并要求已认证的活动 Peer，所以不发 `Origin` 的页面、以及本机进程，都会在任何插件代码运行之前被拒绝。`apply()` 同时拒绝挂载在非回环 host 上。
- **请求是 JSON、有上限、不缓存。** 强制 `Content-Type: application/json`，请求体上限 128 KiB，响应带 `no-store` 与严格 CSP，面板由 `frame-ancestors 'none'` 约束。
- **费用算在被咨询方的账上。** Open WebUI 所接模型的费用由其服务方另计；整单是否更省，取决于这次咨询能否替代其他模型请求——本插件不承诺任何降幅。

## 单独安装到 Harness

需要 **Node.js 24.11+**、DeepSeek Harness **`0.2.2-rc.1`**，以及供 `dsh plugin` 使用的 pnpm。

从仓库根目录运行：

```sh
npm pack ./packages/web-collab
dsh plugin --profile web add ./dsh-llsa-web-collab-0.2.0.tgz
dsh web --host 127.0.0.1 --port 3095 --no-open
```

发布之后也可以直接用包名：

```sh
dsh plugin --profile web add @dsh-llsa/web-collab
```

单独安装由 Harness 的 `web` 配置管理。若同时使用 DSH-LLSA 组合包内置的那份，请先移除其中之一，避免两份插件同时加载。

## 开发

```sh
npm --prefix ./packages/web-collab install   # 拉取两个 peer 依赖
npm --prefix ./packages/web-collab test      # 19 条测试
```

peer 依赖是 `@deepseek-ai/cordis@4.1.0` 与 `@deepseek-ai/dsh-llm@0.2.2-rc.1`，由 Harness 提供，所以本包自身**没有运行时依赖**。

| 路径 | 职责 |
|---|---|
| `src/index.js` | 服务、`/web-collab` 路由、请求体上限与响应头 |
| `src/panel.*` | 面板 UI：任务、建议、咨询记录 |
| `src/single-agent.js` | 单 Agent 作业生命周期与那一次生成请求 |
| `src/child-consultations.js` | 每次尝试的子 Agent 咨询与上限 |
| `src/browser-advisor.js` | 手动往返与 Open WebUI 客户端 |
| `src/native-handoff.js` | 把证据交给原生工单 |
| `src/task-evidence.js` | 证据校验与大小限制 |

## 许可

[MIT](LICENSE)。
