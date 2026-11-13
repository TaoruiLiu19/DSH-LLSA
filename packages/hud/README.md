# @dsh-llsa/hud

A read-only HUD for DSH: the agent's live activity as one glanceable field.

- **centre** — the conclusion: `待命`, one line of what it is doing, or
  `SUCCESS` / `FAIL`;
- **outer ring** — the materials being used (Python / 表格 / 数据 / 文档 / 网页 /
  邮件 / 终端 / 其它), each lit by a real `tool.start` event;
- **inner ring** — sub-agents (`AGENT`), drawn only when a run has more than one
  agent;
- **focus mode** — sending a command opens the field over the conversation;
  completion stays until you leave; a capsule in the message area brings it back.

The plugin writes nothing: no tool, no session event, no agent behaviour, no
orchestration state. It reads a snapshot and draws.

## Install

The package ships a Host half (`src/index.js`) and a browser half
(`client.js`), wired by `cordis.patch.yml` and `dsh.client` — the same shape as
any other DSH bundle:

```bash
# from the repository root
npm test --prefix packages/hud
# or install the directory as a bundle:
#   plugin_manager → install_bundle → <repo>/packages/hud
```

A clean DSH that installs only this bundle shows core tool activity: the Host
half folds DSH's durable session events into the contract snapshot, so no
orchestrator is required (§5.2, §5.3).

## What it renders

| host state | colour | ring | text |
|---|---|---|---|
| `running` | `#4c9aff` | breathing | 执行中 / 读取中 / 校验中 / 整理中 |
| `waiting-human` | `#f2b544` | **no** breathing, pinned | 等你确认 |
| `done` | `#2fd18a` | steady, then fades | SUCCESS / 完成 |
| `failed` | `#ff5f6d` | flashes once, then fades | FAIL / 未完成 |
| `idle` | — | not drawn | 待命 |

Colour is never the only signal: every node keeps its word and its ring shape
(the waiting node stops breathing), and the centre always says what state the
run is in.

**Stage (§4.5).** Both side panels expanded: the scrim covers the conversation
column only, with a 14 px radius, and the HUD is `min(w,h) × 0.90`. Either panel
collapsed: the scrim covers the window, square, and the HUD is `min(w,h) × 0.97`.
The change is a 260 ms transition, never a jump. The composer, the top tabs and
the side panels are never blurred, so you can always type.

**Ask.** A pending question keeps the field, and needs no hole in the scrim: the
ask surface renders *below* the message area (over the composer), so the plain
scrim already leaves it sharp and clickable while the conversation behind it stays
blurred. A field the user dismissed stays dismissed; a question never reopens it
behind the user's back. (The task document's §4.6 closed the field on a question;
that rule is reversed here at the product owner's request.)

What counts as "still asking" is decided by the session **log**, not by the tool's
return value: the host documents that an answer arrives as a user message, and that
message is what closes the question. A timed-out wait returns
`{ pending: true }` and stays open — the field keeps 等你确认, including after the
turn ends. Every snapshot re-derives this, so a dropped resolution event is
repaired rather than leaving the yellow light stuck.

**Stalled (§2.1).** `stalled` is stamped by whoever produced the snapshot; the
field only reports it — a dashed halo on the seat and a `停顿中` sub-line. The
client never derives it from silence.

**Agents and labels.** The snapshot is the whole truth about who is in the run: an
agent missing from it leaves the view, so a retired worker cannot hold the field in
`running`. Every label — root, worker, child — goes through the same sanitiser and
the same 12-code-point cap; a child's raw assignment title or filesystem path never
reaches the wire.

**Late start.** Installing, restarting or hot-reloading the plugin mid-run adopts
the current turn from the first tool call it sees, so the field appears
immediately instead of waiting for the next command.

**No carrier yet.** The route registration waits for `webServer`: a restart can
activate this row before the web carrier exists, and asking once would leave the
page with no route for the whole session. Registration retries with backoff until
the service appears, and the effect removes both routes on dispose. If the snapshot route cannot
be reached at all, a small `HUD 未连接` pill says so instead of leaving the same
blank screen as "nothing is happening".

## Configuration

The plugin exports a `Config` schema, so its options appear as a form in the
**plugin panel** (Plugin Manager → this plugin). That is the native home for a
plugin's own settings: it travels with the plugin, survives upgrades, and does not
depend on the host's settings implementation.

| Key | Default | Meaning |
|---|---|---|
| `focusMode` | `true` | The field itself: while a task runs, the conversation is blurred and the ring HUD is shown. Turn it off to keep the plugin installed but silent — no scrim, no capsule, no hint. |
| `hudEndpoint` | `''` | Optional orchestrator endpoint that already speaks hud-v1. When it answers with a valid snapshot the plugin passes it through untouched; when it does not (absent, slow, malformed) the core-event source takes over. |
| `hudTimeoutMs` | `900` | Timeout for that endpoint before falling back. |
| `maxSessions` | `32` | How many sessions the collector keeps warm. |
| `childrenRefreshMs` | `1200` | How long a `listChildren` answer is reused. |

`{session}` in `hudEndpoint` is replaced with the URL-encoded session id.

`focusMode` is opt-out: an absent key means on, so a hand-written `config: {}`
behaves like a fresh install. Changing it restarts the plugin (it is an ordinary
field), so the picture can blink once.

**Session-only override.** `Ctrl/Cmd+Shift+H` silences the field for the current
page without touching the saved setting; press it again to bring the field back.
A dismissed field (Esc) stays dismissed, and a question never reopens it behind
your back.

## Contract

The input is `contracts/hud-v1.schema.json`: a snapshot of
`{v, aliasVersion, seq, now, stalledAfterMs, eventsFromSeq, agents[], events[]}`
with a 256-event window and the event vocabulary `agent.register`, `turn.start`,
`tool.start`, `tool.end`, `attention.raised`, `attention.resolved`,
`state.changed`, `turn.end`, `agent.cancel`, `agent.recovered`.

This package only consumes it, and degrades rather than guessing:

- **window hole** — `eventsFromSeq > cursor + 1` means events were dropped, so
  the field skips animation and only syncs state;
- **alias version mismatch** — every material degrades to 「其它」 while states,
  counts and the centre keep working;
- **`stalled`** — copied from `agents[].stalled`, never computed by the client;
- **`seq`** — per run. Sessions are tracked separately; a session switch resets
  the field, and seqs from different runs are never compared;
- **labels** — `agents[].label` is rendered as supplied. The degraded source
  names agents with the same rule the orchestrator uses
  (`packages/dsh-collab/src/hud-label.js`), ported to `src/labels.js` and checked
  against the contract's 13 label cases.

Mapping chain: native tool id → alias (`contracts/tool-aliases-v{version}.json`,
mirrored in `src/materials.js`) → material (ours). An unmapped tool is 「其它」,
never an invisible node.

## Verification

```bash
npm test --prefix packages/hud       # 82 assertions, no network, no browser
npm run check --prefix packages/hud  # the same plus a stale-bundle check
```

The suite replays the five contract fixtures (`hud-normal`, `hud-invalidated`,
`hud-restarted`, `hud-stalled`, `hud-attention` — 44 steps) against the model and
asserts each step's declared state, sequence and label; runs the 13 label cases;
pins the two layout tiers, focus transitions, pulse gating and fade timings; and
evaluates the committed `client.js` exactly as the module loader does.

The fixtures are read from `contracts/fixtures/` next to this package, so a
packaged copy without that directory skips the replay instead of inventing
expectations.

## Files

```
src/index.js       Host half: two read-only routes, the collectors, config
src/source.js      hud-v1 snapshot from core session events; orchestrator pass-through
src/model.js       pure fold (snapshot, previous view) → the view the canvas draws
src/materials.js   the eight materials, the alias table, state colours and words
src/labels.js      the shared 12-code-point display-label rule
src/render.js      stage geometry (both layout tiers) and the canvas field
src/focus.js       scrim, field, hint, return capsule, stage measurement
src/client-entry.js  store, polling, and the two slot registrations
client.js          the generated browser artifact (see below)
data/tool-aliases-v1.json  the published alias table, generated from materials.js
```

`client.js` is generated. The modules are plain ESM so `node --test` can import
them, while the browser artifact must be one classic script that registers a
factory through `window.__ModuleLoader__`. `scripts/build-client.mjs` bridges
the two with a deliberately small transform (drop `import`s, drop top-level
`export` prefixes, one shared closure, refuse anything else); a test fails
whenever the committed artifact differs from the sources. Run
`npm run build --prefix packages/hud` after editing `src/`.

## Limits

- One shape for the current session. Multi-session HUDs would need a per-session
  field and a corner badge; neither is shipped.
- Approvals (`approval/request`) are not a signal in the degraded source: only
  `ask_user_question`'s own call/result pair is read, because joining the
  approval waterfall to watch it would put this plugin in the path of the user's
  approvals. The orchestrator's own snapshot does include them.
- In degraded mode a child agent's own tool calls do not light materials: the
  child's session events are not merged into the run's window. Its state and
  label still appear on the inner ring.
- Stage anchors are the conversation column's slot hosts. If a host version moves
  them the field falls back to the whole window, which is still correct, just
  less tight.
- The plugin is read-only by construction; anything that would mutate the run is
  out of scope on purpose.
