# DSH-LLSA

面向 DeepSeek Harness 的本机任务插件，提供任务提交、状态查看和结果查询。当前发布版本为 0.4.0。

## 环境

- Node.js 24.9 或以上。
- 可用的 DeepSeek 官方 API 配置；模型费用由使用者承担。
- 本构建使用 DeepSeek Harness 0.2.2-rc.1。

## 安装与启动

将构建包解压到独立目录，进入其中的 package 目录，执行：

```powershell
npm install --omit=dev
npm start
```

先打开终端输出的 Harness 认证链接，在原生模型设置中配置自己的 API。不要将密钥写入本仓库。之后访问同一地址的 /orchestrator/local 提交任务；/collab 可查看任务记录。默认监听 127.0.0.1:3095。指定其他端口：

```powershell
npm start -- 3096
```

在终端按 Ctrl+C 停止。任务数据默认保存在当前目录下的 .dsh-llsa；可通过 DSH_LLSA_STATE 环境变量指定独立位置。更新或备份前先正常停止服务。

## 使用范围

当前为实验性单机版本，处理用户提交的内容，不用于自动操作外部仓库或发布部署。结果需要使用者核对，不保证所有任务的正确率、token 降幅或费用下降。

端口占用时请更换端口；API 连接失败时检查模型配置与额度。浏览器应先通过 Harness 的本机认证，再打开任务页面。

本发行包含运行构建和必要许可证。上游组件：[DeepSeek Super-agent](https://github.com/deepseek-ai/dsh-superagent-prototype)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
