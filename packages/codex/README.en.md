# LeanLink for Codex

[中文](README.md)

Use LeanLink to archive Codex subagent results and retrieve the exact evidence for an earlier step. The separate HUD shows parent and child agents, tool activity, and requests for attention.

## Install

Use Node.js 24.11+ and a Codex client with local plugin and lifecycle hook support. Make Node and Codex available in the same terminal. Run these commands from the repository root.

```sh
node scripts/build-codex-marketplace.mjs
codex plugin marketplace add ./artifacts/codex-marketplace
codex plugin add leanlink-codex@dsh-llsa-codex
```

In Codex desktop, you can also open the plugin directory, select the **DSH-LLSA Codex** source, and install **LeanLink for Codex**. Start a new session and select **leanlink-codex:leanlink** from the `$` skill menu.

### Open the HUD

```sh
node artifacts/codex-marketplace/plugins/leanlink-codex/hud/serve.mjs
```

Open the local address printed in the terminal. In Codex, review and trust this plugin's hooks using **Review hooks** or **Settings → Hooks**. In the CLI, use `/hooks`. Start a task in a new session to see its activity. The HUD opens on a separate page. Browsers with Document Picture-in-Picture can float it above other windows.

### Try a delegated task

Paste this request into Codex.

> Ask two subagents to review independent modules. Record this input, each branch's concise findings and evidence reference, and the review decisions. Summarize the accepted results and include a historical reference for one branch.

Find earlier steps with `leanlink_lookup` and open the exact saved result with `leanlink_read`. Later corrections create new input versions, with earlier records still available. When Codex supplies only a shared session ID, the HUD groups child agents under the session root. Token and cost metrics are unavailable in this version.

## Local data

Data lives in `~/.leanlink-codex/` by default. To override it, use the same absolute `CODEX_LEANLINK_HOME` path when building the marketplace and starting Codex and the HUD. LeanLink archives content explicitly passed to its tools, and the HUD records status metadata. Compact references shorten handoffs. Measure usage and charges against matched tasks on your Codex configuration.

Run the source tests with `npm --prefix packages/codex test`.
With a local Codex CLI, run `node scripts/smoke-codex-plugin.mjs --native-hud` to verify installation, exact history, and native parent and child hooks in a fresh profile against a local fixture endpoint.
