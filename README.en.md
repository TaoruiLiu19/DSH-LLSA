# DSH-LLSA

[中文](README.md) · English · [Build and Test](https://github.com/TaoruiLiu19/DSH-LLSA/actions/workflows/ci.yml) · [Changelog](CHANGELOG.md)

DSH-LLSA is a local workspace for multi-agent tasks on DeepSeek Harness. The main agent delegates work, checks the results, and delivers the final answer. LeanLink exchanges compact structured results and keeps the underlying evidence available for review.

The combined kit is for one user on a local machine. It includes the launcher, Super-agent, the collaboration workspace with a local CSV executor, and optional web collaboration. You supply the model API configuration in Harness. Start with tasks that have clear inputs and acceptance criteria, such as field extraction, document comparison, or applying a known rule to several CSV files.

[Codex split-view HUD](#codex-split-view-hud)

## Install and start

Use **Node.js 24.11+** and **npm 11+**. The first dependency installation requires an internet connection. Local CSV workflows also require **Python 3.10+**.

### Build from source

```sh
git clone https://github.com/TaoruiLiu19/DSH-LLSA.git
cd DSH-LLSA
npm ci
npm run build
npm start
```

You can also download the source from **Code → Download ZIP** on GitHub. Extract it, open the directory containing `package.json`, and start with `npm ci`. Keep npm's installation scripts enabled so the component dependencies are installed.

### Start from a GitHub Release

Download `dsh-llsa-0.4.2.tgz` and `SHA256SUMS` from [GitHub Releases](https://github.com/TaoruiLiu19/DSH-LLSA/releases). Check the SHA-256 with `Get-FileHash .\dsh-llsa-0.4.2.tgz -Algorithm SHA256` in PowerShell or `sha256sum dsh-llsa-0.4.2.tgz` on Ubuntu, then extract and start the kit.

```sh
tar -xzf dsh-llsa-0.4.2.tgz
cd package
npm ci
npm start
```

Keep the `vendor/` directory with all four component archives. `npm ci` installs runtime dependencies from the included lockfile. The kit contains the built launcher and plugins, so it skips the source build.

If you already run Harness Web, download `dsh-llsa-harness-bundle-0.4.2.tgz` from the same Release and use `dsh plugin add` in a dedicated Web profile. [Plugin installation guide](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/packages/harness-bundle/README.md)

### Open the workspace

1. Open the Harness authentication link printed in the terminal. The default host and port are `127.0.0.1:3095`.
2. Configure your model and API credentials in the native Harness model settings.
3. Open `/orchestrator/local` on the same address to submit a task. Open `/collab` to view work items, results, evidence, and model usage.

If port 3095 is busy, use `npm start -- 3096` and open the new authentication link. The launcher is designed for loopback access. Report failures with your OS, Node/npm versions, and redacted error output.

## Try a task

In the task page, submit this prompt with the final JSON option selected:

```text
Ask one child agent to check the facts, then review its result before replying.
The ID is the exact string "007". No tests have run, the fix is unverified,
and deployment is not allowed.
Return only a JSON object with id, test_status, fix_verified, and deploy_allowed.
Use "not_run" for test_status and booleans for the last two fields.
```

```json
{
  "id": "007",
  "test_status": "not_run",
  "fix_verified": false,
  "deploy_allowed": false
}
```

In `/collab`, open the result and the review record. Valid JSON, a finished task, and a correct answer are separate checks.

## Run a local CSV workflow

Set `DSH_LLSA_CSV_WORKSPACE` to a directory with CSV inputs. The example below works from either the source root after building or the extracted `package/` directory after installing:

```powershell
$env:DSH_LLSA_CSV_WORKSPACE = (Resolve-Path '.\examples\csv-workflow').Path
npm start
```

```sh
DSH_LLSA_CSV_WORKSPACE="$PWD/examples/csv-workflow" DSH_LLSA_CSV_PYTHON=python3 npm start
```

Local CSV is disabled by default for each new run. Select the run in `/collab` and enable **Local CSV** (`本机 CSV`). To enable it before the first planning request for new runs, set `DSH_LLSA_CSV_DEFAULT_ON=1` before starting the app. Use paths relative to the configured workspace, such as `workflow.csv`.

Try asking the coordinator to apply the same steps to `workflow.csv` and `workflow-next.csv` as one batch. Filter `状态` (status) to `已报名` (registered), keep the latest row per `邮箱` (email) using `报名时间` (registration time), and count by `地区` (region). The first file should return `北区` (North) 1 and `南区` (South) 2. The second should return `东区` (East) 2 and `南区` 1. Review the receipts and output references before comparing the batches.

The executor can run known filters, deduplication, and group counts locally. A batch accepts two to four CSV files, up to 16 MiB each and 32 MiB combined. The coordinator reviews the produced artifacts and can give an authorized child access to the CSV assigned to that work item. Model planning, analysis, and review still use tokens. For saved workflows, column mappings, and MCP access, see the separately maintained plugin. [Task Reuse guide](https://github.com/TaoruiLiu19/DSH-LLSA/tree/main/task-reuse#readme)

## Use web collaboration

**Disabled by default.** A web model can offer an initial review or check a specific question. Harness agents verify the source material and deliver the result. Build from source or install a CI kit that includes web collaboration. Stop the running instance, open the source root or extracted `package/` directory, and start with the feature enabled.

```powershell
$env:DSH_LLSA_WEB_COLLAB = '1'
npm start
```

```sh
DSH_LLSA_WEB_COLLAB=1 npm start
```

Open the Harness authentication link printed in the terminal, then open `/web-collab` on the same address. Select **Web collaboration** (`网页协作`) for the task. For **Multi-agent** (`多智能体`), paste the source material into the task field. LLSA delegates and reviews the work item, and a child agent can consult the web model about its assigned evidence. The single-agent mode also accepts attachments. Open `/orchestrator/local` for multi-agent task progress and replies, or `/collab` for collaboration records and Harness model usage.

- **Manual consultation** works with chat sites such as ChatGPT and DeepSeek. Copy the consultation prompt, send it on the site, and paste the reply back. For a child agent's request, keep the consultation ID in the reply or import the corresponding Markdown file.
- **Automatic consultation** works with Open WebUI. Before starting DSH-LLSA, set `DSH_WEB_COLLAB_OPEN_WEBUI_URL` to the instance address, `DSH_WEB_COLLAB_OPEN_WEBUI_MODEL` to the model ID, and `DSH_WEB_COLLAB_OPEN_WEBUI_KEY` to the API key. Use HTTPS for non-local instances and keep the key in the local launch environment. Select **Consult Open WebUI** (`用 Open WebUI 咨询`) for an initial review. An opted-in child agent can also receive an automatic reply. [Open WebUI API](https://docs.openwebui.com/reference/api-endpoints/#chat-completions)

Each consultation sends the content you provide or an excerpt relevant to the child's assigned check. Check that you can share it with the selected service. Treat replies as advice for the Harness agent to verify. Track web and Harness usage separately. Total cost depends on how much other model work the consultation replaces. The model behind Open WebUI may charge separately, outside the local Harness budget.

To disable the feature, unset `DSH_LLSA_WEB_COLLAB` or set it to `0`, then restart DSH-LLSA.
If you previously installed Web Collab through `dsh plugin`, remove that standalone installation from the same Harness profile before using the bundled version.

## LeanLink, HUD, and model usage

LeanLink keeps structured exchanges compact and stores original evidence by reference. A worker can read the input in pages, and changes to source material require review against the new input version. The parent agent still checks the result before accepting it.

The optional `@dsh-llsa/hud` is a read-only overlay for Harness sessions. It shows agent activity, tools, and requests for your attention. Install it separately through the Harness plugin manager. The HUD has its own package and release cycle on npm. The repository currently contains HUD source `0.4.5`, including support for the CSV tool's alias table. [HUD installation guide](https://github.com/TaoruiLiu19/DSH-LLSA/tree/main/packages/hud#readme) · [HUD on npm](https://www.npmjs.com/package/@dsh-llsa/hud)

HUD snapshots keep schema version 1 and select the alias table for the tools they show. Ordinary tool activity uses `aliasVersion: 1`, CSV activity uses version 2, and activity involving `collab_consult_web` uses version 3. Native tool IDs stay the same. [Alias table v1](contracts/tool-aliases-v1.json) · [v2](contracts/tool-aliases-v2.json) · [v3](contracts/tool-aliases-v3.json)

Use `/collab` for model usage. It separates provider-reported usage, estimates, and missing data. The cost controls in the collaboration graph are for comparing scenarios. Real savings depend on the task, model, cached input, output length, and retries.

### Codex split-view HUD

Install the separate **LeanLink for Codex** plugin from the repository source to archive subagent results and evidence references. Start the local HUD. In Codex desktop on Windows, press `Ctrl+T`, paste the address printed in the terminal, and use `Ctrl+Shift+B` to cycle to split view. The same address opens in a regular browser on your machine. Once you review and trust the plugin's hooks, the HUD shows agent relationships, work states, and requests for attention reported by Codex. [Codex installation and permissions](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/packages/codex/README.en.md)

### Set an optional cost budget

Copy `examples/money-policy.example.json` to `my-money-policy.json`. Set the currency and supply the actual provider, model, and per-million-token rates for each model in use. Then point the launcher at the file:

```powershell
$env:DSH_LLSA_MONEY_POLICY = (Resolve-Path '.\my-money-policy.json').Path
npm start
```

```sh
DSH_LLSA_MONEY_POLICY="$PWD/my-money-policy.json" npm start
```

`maxCost` applies to the budget period identified by `id`, `maxRunCost` applies to one run, and `maxBranchCost` applies to a work item and its retries. The app reserves estimated spend before each managed model request and refuses new requests if there is insufficient budget or a model has no price entry. The budget combines estimated cost and outstanding reservations. Check the provider's billing page for actual charges.

## Compatibility and validation

| Component | Version in this repository |
| --- | --- |
| Combined kit and `@dsh-llsa/launcher` | `0.4.2` |
| `@dsh-llsa/collab` and `@dsh-llsa/superagent` | `0.4.2` |
| `@dsh-llsa/web-collab` (disabled by default) | `0.2.2` |
| DeepSeek Harness | `0.2.2-rc.1` |
| Optional `@dsh-llsa/hud` source | `0.4.5` |

The combined kit uses the locked Harness dependency set. Use `npm ci` to restore it. Treat a Harness upgrade as a compatibility change and update the launcher checks, pinned dependencies, and lockfiles together. Validate the new build, collaboration bridge, and independent install kit before making the upgraded kit available.

The kit uses an adapted version of the DeepSeek Super-agent research prototype at upstream commit `8c32a9d`. The work-item flow relies on that adaptation for versioned inputs, acceptance, and stop and resume controls. Check those interfaces and recovery from existing state when updating the upstream snapshot. [Pinned upstream commit](https://github.com/deepseek-ai/dsh-superagent-prototype/commit/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)

The default state directory is `.dsh-llsa/` relative to the launch directory. Set `DSH_LLSA_STATE` to choose another location. Stop the application and back up the entire state directory before upgrading so the database and its referenced artifacts are backed up together. Harness manages model settings and credentials separately.

From a source checkout, after `npm ci` and with Python available, run:

```sh
npm run check
npm run typecheck
npm test
npm run check --prefix packages/hud
npm run pack:release
npm run verify:rebuild
npm run verify:kit
```

CI runs these checks on Windows and Ubuntu. It compares the resulting archive checksums across platforms. Kit verification installs in an empty directory, runs the included CSV engine on a sample, and checks Harness startup and the per-run CSV switch. These checks run without model tasks.

DSH-LLSA is an independent extension based on DeepSeek Harness and the DeepSeek Super-agent prototype. [MIT License](LICENSE) · [Upstream notices](NOTICE)
