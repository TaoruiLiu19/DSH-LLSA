# LeanLink for Codex

[中文](README.md)

Use **LeanLink** to archive Codex subagent results, review decisions, and the exact evidence for earlier steps. Open the **collaboration HUD** beside your chat to see parent and child agents, tool activity, and requests for attention.

## Install

Use Node.js 24.11+ and a Codex client with local plugin and lifecycle hook support. Confirm that `node` and `codex` are available in your terminal. Download the DSH-LLSA repository source, then build and register its local marketplace from the repository root.

```sh
node scripts/build-codex-marketplace.mjs
codex plugin marketplace add ./artifacts/codex-marketplace
codex plugin add leanlink-codex@dsh-llsa-codex
```

After registering the marketplace, you can also select **DSH-LLSA Codex** in the desktop plugin directory and install **LeanLink for Codex** there. To use the archive tools, open a new session and select **leanlink-codex:leanlink** from the `$` skill menu.

## Open the HUD in Codex

1. In the Codex composer, select **Review hooks**, or open **Settings → Hooks**, then review and trust this plugin's hooks. In the CLI, use `/hooks`. Follow Codex's prompts to review hook updates. [Official Codex hook guide](https://learn.chatgpt.com/docs/hooks#plugin-bundled-hooks)
2. Start the HUD from the repository root. Keep the terminal running and copy the `http://127.0.0.1:<port>/` address it prints.

   ```sh
   node artifacts/codex-marketplace/plugins/leanlink-codex/hud/serve.mjs
   ```

3. In Codex desktop on Windows, press `Ctrl+T` to open the built-in browser, paste that address, and press Enter. Select **Enter split view**, or use `Ctrl+Shift+B` to cycle to split view and show your chat and the HUD side by side. On macOS, use `Cmd+T` and `Cmd+Shift+B`. [Official desktop browser guide](https://learn.chatgpt.com/docs/browser#arrange-tabs-and-chat)
4. Start a task in a new session and choose its entry in the HUD's session menu. You can also open the same address in a standalone browser on the same machine. Choose **置顶画布** (Float canvas) if that browser supports Document Picture-in-Picture.

## Try a delegated task

Paste this request into Codex.

> Ask two subagents to review independent modules. Record this input, each branch's concise findings and evidence reference, and the review decisions. Summarize the accepted results and include a historical reference for one branch.

Find earlier steps with `leanlink_lookup` and open the exact saved result with `leanlink_read`. Later corrections create new input versions, with earlier records still available.

## Permissions and local data

- The HUD reads local hook metadata such as session relationships, states, tool names, and timestamps. Chat content, tool arguments, and results stay with the original session. LeanLink archives content explicitly passed to its tools.
- The read-only HUD listens on `127.0.0.1`. Handle approvals in Codex. Waiting states depend on the events supplied by Codex. A stall means that no new activity has been reported for a while during a run. When Codex reports only a shared session ID, the HUD shows child agents under the session root. Use the host's usage reports for tokens and costs.
- Data lives in `~/.leanlink-codex/` by default. To change it, set the same absolute `CODEX_LEANLINK_HOME` path when building the marketplace, launching Codex, and starting the HUD. If no sessions appear, check that the plugin is enabled and its hooks are trusted, then run a task in a new session.

## Local verification

Run the offline tests with `npm --prefix packages/codex test`. With a local Codex CLI, run `node scripts/smoke-codex-plugin.mjs --native-hud` to verify MCP installation, exact history, and native parent and child hooks in an isolated profile with responses from a local fixture endpoint. The Windows Codex built-in browser has been checked with activity recorded through these hooks.
