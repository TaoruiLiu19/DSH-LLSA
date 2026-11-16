# DSH-LLSA 网页协作

网页协作为任务提供初审建议或核对具体疑点。Harness Agent 保留核验原始资料与交付结果的职责。

## 在组合包中启用

网页协作默认关闭。安装依赖或从源码构建后，在启动 DSH-LLSA 的终端设置 `DSH_LLSA_WEB_COLLAB=1`。先打开终端的 Harness 认证链接，再进入同一地址的 `/web-collab`。选择任务并勾选 **网页协作** 才会使用咨询。清除该变量或改成 `0` 后重启，可关闭组合包内置的网页协作。

- 单 Agent 可接收粘贴的文本和 UTF-8 附件。填入初审建议后，Harness 发起一次生成请求来核对并交付。
- 多智能体模式使用粘贴的任务资料。可留空初审建议，由子 Agent 自行判断是否需要核对疑点。每次子任务尝试最多咨询一次，问题上限 1024 UTF-8 字节。短回复随工具结果返回，完整 Markdown 留在本机协作记录供查阅。
- 公开聊天网页使用手动复制和回填。子 Agent 咨询需保留 Markdown 第一行的咨询编号。配置 Open WebUI 可从其官方接口自动获取回复，启动前设置 `DSH_WEB_COLLAB_OPEN_WEBUI_URL`、`DSH_WEB_COLLAB_OPEN_WEBUI_MODEL` 和 `DSH_WEB_COLLAB_OPEN_WEBUI_KEY`。非本机实例使用 HTTPS。

只提交可分享给所选服务的内容。网页回复作为待核验的意见。Open WebUI 所接模型的费用由其服务方另计，整单用量取决于咨询能否替代其他模型请求。

## 单独安装到 Harness

需要 Node.js 24.11+、DeepSeek Harness `0.2.2-rc.1` 和供 `dsh plugin` 使用的 pnpm。从仓库根目录运行：

```sh
npm pack ./packages/web-collab
dsh plugin --profile web add ./dsh-llsa-web-collab-0.2.0.tgz
dsh web --host 127.0.0.1 --port 3095 --no-open
```

单独安装由 Harness 的 `web` 配置管理。使用组合包内置版本时，请先移除同一 Harness 配置中的独立安装，避免两份插件同时加载。

```sh
npm --prefix ./packages/web-collab test
```
