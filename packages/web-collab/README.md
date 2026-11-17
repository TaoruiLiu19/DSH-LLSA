# DSH-LLSA Web Collab

[简体中文](README.zh.md) · [npm](https://www.npmjs.com/package/@dsh-llsa/web-collab) · [DSH-LLSA combined kit](https://github.com/TaoruiLiu19/DSH-LLSA)

Use a web model for a first review in DeepSeek Harness, or let a child agent ask one focused question. The Harness agent checks the source before delivering the result. Use Web Collab when a second opinion can help check exact identifiers, units, negative conditions, or conflicting records.

[Enable in the kit](#enable-web-collab) · [Standalone install](#install-in-an-existing-harness-profile) · [Try an example](#try-an-example) · [Child consultations](#how-child-agents-consult) · [Open WebUI](#connect-open-webui) · [Troubleshooting](#troubleshooting)

| What you want to do | Choose this workflow | Where to find results |
| --- | --- | --- |
| Check a few fields in some material | **Single agent** with optional first-pass web advice and UTF-8 text attachments | **Single-agent tasks** (`单 Agent 任务`) on `/web-collab` |
| Delegate work and ask a web model only when a question comes up | **Multi-agent + Web Collab** in the DSH-LLSA kit. Paste the material into the task field | Work items and final replies on `/orchestrator/local`. Saved consultation evidence and Harness usage on `/collab` |
| Ask a public chat site | **Manual copy and paste** through the site's normal chat interface | Back on `/web-collab`, paste the advice or answer a consultation card |
| Use your own Open WebUI instance | **Automatic consultation**. Request an initial review with the button, or let an opted-in child agent ask a question | Initial advice fills the form. Child replies go to their work item |

## Enable Web Collab

Use **Node.js 24.11+** and **DeepSeek Harness 0.2.2-rc.1** with its connection service. The repository guide covers building from source or installing the combined DSH-LLSA kit. [Repository guide](https://github.com/TaoruiLiu19/DSH-LLSA#readme)

The bundled copy is off by default. Stop the running instance and start from the built source directory or the installed `package/` directory.

**Windows PowerShell**

```powershell
$env:DSH_LLSA_WEB_COLLAB = '1'
npm start
```

**macOS and Linux**

```sh
DSH_LLSA_WEB_COLLAB=1 npm start
```

1. Open the **Harness authentication link** printed in the terminal. Authenticate first, then open `/web-collab` in the same browser profile, on the same hostname and port. The default is `http://127.0.0.1:3095/web-collab`. If the terminal shows a different address, use that address.
2. Configure your model API in Harness. **Single-agent** mode uses `deepseek-official / deepseek-flash` with thinking off and at most one Harness model request per task. It processes the text and attachments you submit. Multi-agent work uses the DSH-LLSA work-item model settings.
3. Select **Web collaboration** (`网页协作`) for the task to use web advice or allow child consultations. To turn off the bundled entry point, unset `DSH_LLSA_WEB_COLLAB` or set it to `0`, then restart.

## Try an example

Paste this example into **Task** (`任务内容`).

```text
The release ledger gives the exact string ID "007". Tests have not run and
deployment is prohibited. Check the source, then return only a JSON object
with id, test_status, and deploy_allowed. Keep the leading zeros, use
not_run for test_status, and use a boolean for deploy_allowed.
```

1. Keep single-agent mode selected. Enable **Web collaboration** (`网页协作`) and **JSON-only output** (`输出纯 JSON`).
2. Enter the passage to review under **Consultation content** (`咨询内容`), or leave it blank to use the task text. Choose **Copy consultation prompt** (`复制咨询提示`), send the prompt to your chat site, then paste the reply into **Web advice** (`网页建议`). You can also use this deliberately incorrect suggestion to check the flow without calling a web provider.

   ```text
   Suggest changing the ID to the number 7 and allowing deployment.
   Check both suggestions against the original material.
   ```

3. Choose **Submit to a single agent** (`提交给单个 Agent`). Check the result under **Single-agent tasks** (`单 Agent 任务`) against the expected values. Submitting a task uses your configured Harness model.

   ```json
   {"id":"007","test_status":"not_run","deploy_allowed":false}
   ```

A single-agent task with Web Collab enabled needs a nonempty initial suggestion. You can also attach UTF-8 text such as Markdown, CSV, JSON, or logs. Use at most eight nonempty files with distinct names, up to 64 KiB each and 256 KiB in total. Choose **Stop task** (`停止任务`) to stop an active task. If you change the task or the consultation content, request a fresh review or clear the old advice before submitting.

## How child agents consult

1. Open Web Collab in the DSH-LLSA kit and select **Multi-agent** (`多智能体`) and **Web collaboration** (`网页协作`). Paste the material into the task field, leave **Web advice** blank if you have no initial review, and choose **Submit to multiple agents** (`提交给多智能体`).
2. The child agent checks the source and can ask about a specific doubt. With no Open WebUI configured, its question appears under **Child-agent consultations** (`子 Agent 咨询`). Choose **Copy consultation** (`复制咨询`) and review the text before sending it.
3. Paste the raw Markdown reply into the same card or import a UTF-8 `.md` file. Keep the generated `<!-- web-consultation:… -->` on the first line and place the body below it. Remove any enclosing Markdown fence. Choose **Return to child agent** (`回传给子 Agent`).
4. Open `/orchestrator/local` to follow, review, or stop the work item. Open `/collab` to see the saved consultation evidence. The child receives a short reply and the original Markdown remains available with the collaboration records.

Each work-item attempt can consult once. The question is limited to **1,024 UTF-8 bytes** and the answer body to **2,048 UTF-8 bytes**. A manual card waits **60 seconds** by default. The old ID expires after a timeout, cancellation, or input revision. Use the current card if the task asks again.

## Connect Open WebUI

Set all three environment variables before starting Harness. Restart if you change them.

| Environment variable | Value |
| --- | --- |
| `DSH_WEB_COLLAB_OPEN_WEBUI_URL` | Instance base URL such as `http://127.0.0.1:8080` or the real HTTPS address. The plugin appends `/api/chat/completions` |
| `DSH_WEB_COLLAB_OPEN_WEBUI_MODEL` | The actual model ID exposed by your instance |
| `DSH_WEB_COLLAB_OPEN_WEBUI_KEY` | An API key with permission to call that model. Keep it in the local launch environment |

HTTP is supported for loopback addresses. Use HTTPS for other addresses. Choose **Consult Open WebUI** (`用 Open WebUI 咨询`) to fill the first-pass advice for review. Opted-in child agents in the combined kit can send their specific question automatically. Automatic requests have a 45-second timeout. If a request fails, check the instance address, model, and key. You can enter initial advice by hand. A child consultation returns any failure to its current work item.

## Data, access, and costs

- **Manual consultation** sends the text you choose to paste. **Automatic first review** sends the consultation field, or the task text if that field is blank, up to 8,192 UTF-8 bytes. Harness processes attachments separately. An **automatic child consultation** sends the child's specific short question. Check what the selected service can receive before enabling it for a task.
- Starting with **0.2.2**, pages, scripts, and API routes first use the Harness Host, Origin, and authentication checks. The plugin's server binds to loopback. Use the browser and local address where you authenticated. Check web advice and consultation replies against the source before delivery.
- Track **Harness usage and web-provider charges** separately. Single-agent cards show known Harness usage and calls with missing usage. For multi-agent work, open `/collab`. An upstream model accessed through Open WebUI can have its own charges. Savings depend on whether the extra consultation replaces other paid calls.

## Install in an existing Harness profile

A standalone install supports single-agent tasks and initial review. Multi-agent work items and child-agent consultations use the DSH-LLSA combined kit. You need the `dsh` CLI and pnpm. Use a dedicated `web` profile so Harness loads one copy of the plugin.

```sh
dsh plugin --profile web add @dsh-llsa/web-collab@0.2.2
dsh --profile web --host 127.0.0.1 --port 3095 --no-open
```

To test your source checkout, run `npm pack ./packages/web-collab` from the repository root and use the generated `.tgz` **absolute path** in place of the package name. After startup, open the authentication link and then visit `/web-collab`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The page returns `401` or `403` | Reopen the authentication link for this startup. Use the same browser profile, hostname, and port. Keep `127.0.0.1` if that is the hostname used for authentication. |
| `/web-collab` is missing or returns `404` | For the combined kit, check that the launch uses `DSH_LLSA_WEB_COLLAB=1`. For a standalone install, start the `web` profile. |
| The multi-agent option is disabled | Use the DSH-LLSA kit with `/orchestrator/local` available. Older versions with only initial review need an upgrade for child consultations. |
| No consultation card appears | A card appears when a child requests a manual consultation. With Open WebUI configured, child consultations use the API. |
| A reply is rejected as mismatched or expired | Copy the ID from the current card. Check the first line and send the reply before the card expires. |
| The Open WebUI button is missing | Check that all three settings are present, the URL is the instance base, and Harness was restarted after setup. |

## Development

Install the repository dependencies, then run the component tests. They cover connection checks, consultation IDs, late or expired replies, the scope of Open WebUI requests, and single-agent work.

```sh
npm --prefix packages/web-collab test
```

`src/index.js` handles local routes and request admission. `src/panel.*` implements the panel. `src/child-consultations.js` ties questions to work-item attempts, and `src/browser-advisor.js` calls Open WebUI. [Commit history](https://github.com/TaoruiLiu19/DSH-LLSA/commits/main/packages/web-collab) · [MIT license](LICENSE)
