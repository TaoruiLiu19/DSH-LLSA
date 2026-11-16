# DSH web collaboration

**A second opinion before you commit — without giving a web chat your files.**

[中文](README.zh.md) · [Changelog](https://github.com/TaoruiLiu19/DSH-LLSA/commits/main/packages/web-collab)

[![npm](https://img.shields.io/npm/v/@dsh-llsa/web-collab.svg)](https://www.npmjs.com/package/@dsh-llsa/web-collab)
[![downloads](https://img.shields.io/npm/dm/@dsh-llsa/web-collab.svg)](https://www.npmjs.com/package/@dsh-llsa/web-collab)
[![license](https://img.shields.io/npm/l/@dsh-llsa/web-collab.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@dsh-llsa/web-collab.svg)](package.json)
[![tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)](#development)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-none-brightgreen.svg)](package.json)

An opt-in plugin for DeepSeek Harness: it opens a small panel where you paste task material and a first-pass review, and the agent may consult a web chat to check a specific doubt. **The agent keeps the job of verifying the source material and the deliverable** — a reply is an opinion to check, not a result to trust.

It is off until you turn it on, it only runs behind a loopback web server, and nothing is sent anywhere unless you paste it.

## What actually happens

| Shape | What it does |
|---|---|
| **Single agent** | Paste text or a UTF-8 attachment, add your first-pass advice, and the Harness makes one generation request to check it and deliver |
| **Multi-agent** | Paste the task material; a sub-agent may decide on its own to check a doubt. At most **one consultation per attempt**, question capped at **1024 UTF-8 bytes**. The short reply rides back with the tool result; the full Markdown stays in the local collaboration record |
| **Public chat page** | Manual copy and paste. A sub-agent's question keeps its consultation id on the first line of the Markdown. With Open WebUI configured, replies are fetched from its official API |

## Turning it on

The bundle ships it **disabled**. Start DSH-LLSA with the flag:

```sh
DSH_LLSA_WEB_COLLAB=1
```

Open the terminal's Harness auth link, then go to the same address at **`/web-collab`**. Pick a task, tick **网页协作**, and only then does a consultation happen. Clear the variable (or set it to `0`) and restart to turn the built-in copy off again.

To fetch replies from Open WebUI automatically, set these **before** starting:

```sh
DSH_WEB_COLLAB_OPEN_WEBUI_URL=…
DSH_WEB_COLLAB_OPEN_WEBUI_MODEL=…
DSH_WEB_COLLAB_OPEN_WEBUI_KEY=…
```

A non-loopback instance must use HTTPS.

## What leaves the machine

- **Only what you paste or attach.** The panel does not read your repository, and the plugin does not sample your session.
- **A loopback web server is required.** `apply()` refuses to mount on a non-loopback host.
- **Requests are JSON, capped, and cached by nobody.** `Content-Type: application/json` is enforced, bodies are limited to 128 KiB, responses carry `no-store` and a strict CSP, and the panel is framed by `frame-ancestors 'none'`.
- **Cost sits with the consulted provider.** An Open WebUI model bills its own service; whether the whole job gets cheaper depends on whether the advice replaces other model calls. This plugin does not claim a saving.

## Install into Harness

Requires **Node.js 24.11+**, DeepSeek Harness **`0.2.2-rc.1`**, and pnpm for `dsh plugin`.

From the repository root:

```sh
npm pack ./packages/web-collab
dsh plugin --profile web add ./dsh-llsa-web-collab-0.2.0.tgz
dsh web --host 127.0.0.1 --port 3095 --no-open
```

Once published, the package name works too:

```sh
dsh plugin --profile web add @dsh-llsa/web-collab
```

A standalone install is managed by Harness's `web` profile. If you also use the copy bundled with DSH-LLSA, remove one of them first — two copies load twice.

## Development

```sh
npm --prefix ./packages/web-collab install   # pulls the two peer dependencies
npm --prefix ./packages/web-collab test      # 19 tests
```

Peer dependencies are `@deepseek-ai/cordis@4.1.0` and `@deepseek-ai/dsh-llm@0.2.2-rc.1`; both are provided by a Harness install, so the package ships with no runtime dependencies of its own.

| Path | Responsibility |
|---|---|
| `src/index.js` | The service, the `/web-collab` routes, body limits and headers |
| `src/panel.*` | The panel UI: tasks, advice, consultation list |
| `src/single-agent.js` | Single-agent job lifecycle and its one generation request |
| `src/child-consultations.js` | Per-attempt child consultations and their caps |
| `src/browser-advisor.js` | Manual exchange and the Open WebUI client |
| `src/native-handoff.js` | Handing evidence to native tickets |
| `src/task-evidence.js` | Evidence validation and size limits |

## License

[MIT](LICENSE).
