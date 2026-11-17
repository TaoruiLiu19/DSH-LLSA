# DSH-LLSA Harness 组合插件

[English](README.md) · [下载 Release](https://github.com/TaoruiLiu19/DSH-LLSA/releases) · [自带 Harness 的组合包](https://github.com/TaoruiLiu19/DSH-LLSA#readme)

在已有的 Harness Web 中运行本机多智能体工单。Super-agent 负责分派和验收，LeanLink 负责精简回传，保留可查的消息原文、证据和模型用量。

## 安装到专用 Web 配置

准备 **DeepSeek Harness CLI 0.2.2-rc.1**、**Node.js 24.11+**，并确保终端能找到 **pnpm**。从 [GitHub Releases](https://github.com/TaoruiLiu19/DSH-LLSA/releases) 下载 `dsh-llsa-harness-bundle-<版本>.tgz`。

第一条命令会创建配置并打印配置内容，只需运行一次。如果已有名为 `llsa` 的配置，请将三条命令中的 `llsa` 都换成一个新名字，避免替换已有配置。

```sh
dsh --profile llsa --from-default-profile web --dump-config
dsh plugin --profile llsa add "<dsh-llsa-harness-bundle 归档的绝对路径>"
dsh --profile llsa --host 127.0.0.1 --port 3095 --no-open
```

1. 打开终端打印的 Harness 认证链接，后续使用同一浏览器和地址。
2. 在 Harness 模型设置中配置 DeepSeek 官方 API。新配置中的工单默认使用 DeepSeek Flash，提交工单会调用你配置的模型账号。
3. 打开 `http://127.0.0.1:3095/orchestrator/local`，把资料和任务一起粘贴进去。首次可试「把编号 `"007"` 转成 JSON，字段为 id，保留字符串和前导零」。
4. 打开 `http://127.0.0.1:3095/collab`，查看工单记录、保存的原文和模型用量。

这个插件提供本机粘贴资料的工单流程。Web Collab 和 HUD 各有单独的安装指南。

## 停止或卸载

按 **Ctrl+C** 停止 Harness。清除 Harness 地址的浏览器站点数据可退出当前浏览器会话。卸载时先停止 Harness，再运行 `dsh plugin --profile llsa remove @dsh-llsa/harness-bundle`。协作记录存放在该配置的 `dsh-llsa` 目录，需要留存时可复制备份。

[MIT 许可证](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/LICENSE) · [上游版权说明](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/NOTICE)
