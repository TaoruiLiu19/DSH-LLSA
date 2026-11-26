# DSH-LLSA for DeepSeek Harness

[简体中文](README.zh.md) · [Releases](https://github.com/TaoruiLiu19/DSH-LLSA/releases) · [Standalone kit](https://github.com/TaoruiLiu19/DSH-LLSA#readme)

Run local multi-agent work orders inside your existing Harness Web installation. Super-agent assigns and reviews the work. LeanLink delivers compact handoffs and keeps the original messages, evidence, and model usage available to inspect.

## Install in a dedicated Web profile

Use **DeepSeek Harness CLI 0.2.2-rc.1**, **Node.js 24.11+**, and **pnpm** on your PATH. Download the `dsh-llsa-harness-bundle-<version>.tgz` asset from [GitHub Releases](https://github.com/TaoruiLiu19/DSH-LLSA/releases).

Create the profile once. If `llsa` already exists, pick a new name for all three commands. The first command replaces a profile of the same name.

```sh
dsh --profile llsa --from-default-profile web --dump-config
dsh plugin --profile llsa add "<absolute path to dsh-llsa-harness-bundle tarball>"
dsh --profile llsa --host 127.0.0.1 --port 3095 --no-open
```

1. Open the authentication link from the terminal. Use the same browser and address for the rest of the steps.
2. Configure the official DeepSeek API in Harness model settings. The fresh profile uses DeepSeek Flash for work orders. Submitting work orders uses your configured model account.
3. Open `http://127.0.0.1:3095/orchestrator/local` to submit a task using material you paste there. To check that the original text is preserved, try giving the agent an ID of `"007"` and ask it to return a JSON object with the ID as a string.
4. Open `http://127.0.0.1:3095/collab` to inspect the work, source material, and model usage.

The bundle supports text replies and file delivery. Select **File delivery** on the local task page to upload UTF-8 source files or editable drafts, then use the task card to download the reviewed result. If an execution reaches its budget, the same card lets you download saved drafts or start a new assignment in the existing workspace. The Web Collab and HUD packages have separate install guides in the repository.

## Stop or remove

Stop Harness with **Ctrl+C**. To end the browser session, clear site data for the Harness address. To remove the bundle, stop Harness and run `dsh plugin --profile llsa remove @dsh-llsa/harness-bundle`. Its local history resides in the `dsh-llsa` directory of the profile. Keep a copy of that directory if you need the records.

[MIT license](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/LICENSE) · [Upstream notices](https://github.com/TaoruiLiu19/DSH-LLSA/blob/main/NOTICE)
