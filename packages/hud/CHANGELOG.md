# Changelog

## 0.4.3

- **等你确认 no longer outlives the question.** Two things could leave the field
  amber for good: the answer is a record in the session log that the live event
  stream does not always deliver, and reconciliation only ran when an event had
  marked the state dirty — so the single pass that follows the ask never saw the
  answer, and nothing ever re-read the log. Reconciliation now also runs while a
  question is open (capped to a few passes per second; the loop stops by itself
  once the set is empty), and a finished turn clears attention, because a
  finished turn is not blocked on anybody.
- **A long approval prompt no longer turns the blur full-screen.** The stage was
  promoted to the whole window whenever the measured column was shorter than
  240 px — which is exactly what a tall approval panel produces when it compresses
  the message area. The promotion now keys on the column being flush with an edge
  (side panels collapsed), and a composer pushed past the message area keeps the
  column's own bottom as the floor instead of collapsing the measurement.

## 0.4.2

Documentation only: 0.4.1 went out before the install section was updated, so the
published package page still described installing from a source directory. The
README now offers `@dsh-llsa/hud` as the primary path and keeps the source
directory for development.

## 0.4.1

- **The field follows the host's theme.** It was drawn for a dark window only: on a
  light one the dark scrim turned the conversation to grey mush and the white ink
  vanished. The palette is now chosen from the surface the field actually sits on —
  walk up from the `conversation.session` slot to the first ancestor that paints,
  take its relative luminance, and treat anything brighter than 0.5 as light. No
  theme API is consulted, because the shell may follow the OS, a profile setting or
  a per-session override; a missing surface falls back to `prefers-color-scheme`,
  then to dark.
- The light palette inverts the scrim (pale instead of black), darkens the ink and
  deepens every accent so it still carries contrast on white (`#4c9aff` is 2.6:1 on
  white, the light blue is 4.6:1). Glows shrink to 32% and thin lines gain 35% alpha:
  a glow smears on white and a hairline disappears.
- The capsule, the hint and the offline pill switch with the same class, so the
  whole layer changes together and a theme switch repaints on the next frame.
- First public release: published to npm as `@dsh-llsa/hud`. The tarball ships
  `docs/` so the README figures resolve from the package page.
- The README now shows the field in both themes and a runtime diagram (an
  explorable HTML with its source specification under docs/).

Tests: 117 (was 113).

## 0.4.0

A design pass over the field: the ring stops re-flowing, and the centre stops
repeating the command.

- **Seats are fixed.** Every material owns one angle on an eight-slot ladder
  (12:00 终端, 1:30 代码, 4:30 检索, 6:00 其它, 7:30 网页, 10:30 文档; 3:00 and 9:00
  left open). The ring used to space nodes by how many were visible, so a
  material jumped — up to 180° — whenever a sibling appeared or faded: 13–19
  jumps per six-call run, and none now.
- **Six materials.** `mail` had no tool mapping at all and is gone; `data` becomes
  `search`/检索; `todo_write`, goals and schedules draw nothing (the centre says
  计划中 for their duration), because bookkeeping is not a material.
- **The code seat.** `run_code` lands there, and so does a `read`/`write`/`edit` of
  a source file. The Host half derives `meta.materials` from the call's path
  (27 extensions) and `meta.exec` from a shell command's first word; the client
  then promotes the seat — with its language label — only after the execution has
  lasted 400 ms, so a one-line probe never flashes. Neither hint forwards the
  raw arguments.
- **One pre-set link.** 终端 and 代码 are joined by a 45° arc that lights only
  inside a declared execution window (0 → 0.16 in 120 ms, gone 400 ms after the
  call) and never because two nodes happen to be visible. Its ends are trimmed by
  6.7° so the arc cannot run into a node's centre.
- **The centre is a state word.** 执行中 / 计划中 / 思考中 / 停顿中 / 等你确认 /
  成功 / 失败 / 待命 at one 26px size, with the object on the second line
  (「执行中 / Python」). The task name, its 26-character cap and the two-line wrap
  are gone: the command almost never fit, and echoing it badly was worse than not
  echoing it.
- **Two vocabularies, by scope.** 成功/失败 describe the run (centre and capsule);
  完成 describes one material. A finished node turns green again, stops breathing
  and ripples once, so "running" and "done" differ in motion as well as in hue.
- **A halo holds the middle.** A 0.06-alpha radial whisper, driven by how alive the
  run is plus the hottest material, so 思考中 and 计划中 are not a word floating in
  an empty ring.

Merge validation fixes: return the emitted activity event so path-based material
hints can bind both tool sequence numbers; clear declared execution when an open
tool is interrupted, so the next turn cannot inherit a stale language indicator.

Tests: 113 (was 106), including real file-call arguments and cancellation recovery.

## 0.3.2

- **The route now waits for the web carrier.** `apply` read `ctx.get('webServer')`
  once, so a start that activated the plugin row before the carrier left the page
  with no route for the whole session — the `HUD 未连接` pill that never cleared
  after a restart. Registration retries (200 ms, backing off to 2 s) until the
  service appears, and the effect removes both routes on dispose. The wait timer is
  unref'd so a profile without a carrier never holds the Host process open.
- **"Not connected yet" is no longer "offline".** The connection is tri-state
  (`null` connecting / `true` / `false`). A fresh page needs three failed polls
  *and* 2.5 s of wall clock before the pill appears, and retries every 320 ms while
  connecting; a page that was already online still reports a loss immediately.

## 0.3.1

State fixes found in review. All five are covered by regression tests.

- **A timed-out question is not an answer.** `askTimed` resolves with
  `{ pending: true, callId }` when the wait expires; that used to clear the yellow
  light, and the turn end then showed SUCCESS. Attention now closes only on the
  record the host documents for it — the **user message** whose arrival answers the
  question — so a pending question keeps 等你确认 even after the turn ends, and the
  tool's own output is never inspected.
- **A missed resolution cannot pin the field.** Every snapshot re-derives the open
  question from the session log (`deriveMessages`), so a gap in the event window is
  repaired instead of leaving 等你确认 on a running agent. A projection this build
  cannot read reports "unknown" and leaves the event-derived set alone.
- **A late answer for another session is dropped.** The poller compares the
  session it asked about with the session the page shows (and with the body's own
  `meta.sessionId`) before folding, so switching A→B never paints A's run over B.
- **A retired child leaves the view.** Agents absent from the newest snapshot are
  removed, so a finished worker cannot hold the run in `running` forever.
- **Child labels are sanitised.** A child's label gets the same path/code stripping
  and 12-code-point cap as every other label instead of being passed through raw.

## 0.3.0

- The plugin exports a `Config` schema, so `focusMode` (and the existing tuning
  keys) appear as a form in the plugin panel. `focusMode` defaults to on: turning
  it off keeps the plugin installed but draws nothing.
- `Ctrl/Cmd+Shift+H` silences the field for the current page without saving; the
  saved setting is untouched.
- `meta.focusMode` carries the setting to the client, and `/api/ping` reports it,
  so the wire format stays inside the frozen contract.
- `@deepseek-ai/schemastery` is resolved through a ladder (`import.meta.url`, then
  `DSH_PROFILE_DIR`), because a linked checkout resolves outside the profile where
  that module is not reachable; a missing schema only means "no form".

## 0.2.0

- The field is measured from the column the host actually renders
  (`conversation.session`/`conversation.view`, walking up through
  `display: contents` slot hosts), so the scrim covers the message area instead
  of the whole window and the composer stays sharp.
- The stylesheet is owned by the overlay entry, so the return capsule keeps its
  frosting, its corner position and its pointer events after the field closes.
- Material nodes say how a call ended (`完成`/`未完成`) instead of freezing on
  `读取中`, and a bare role name is never used as the task line.
- A question keeps the field. The ask surface renders below the message area, so
  the scrim needs no hole: the conversation stays blurred while the question stays
  sharp and clickable, and answering it leaves no stray sharp rectangle.
- A task first seen while it already waits for an answer opens instead of going
  blank, and the task line is seeded from the session log when the plugin was
  activated mid-run.

## 0.1.0

First HUD package.

- Host half serves one read-only snapshot route per session
  (`/dsh-hud/api/state?session=…`) in `contracts/hud-v1.schema.json` shape,
  folding DSH's durable session events (`turn/start`, `turn/end`, `tool/call`,
  `tool/result`, `user/message`, `agent/status`, the published sub-agents) into
  the orchestrator's event vocabulary. An optional `hudEndpoint` that already
  speaks `hud-v1` is passed through untouched; absent, slow or malformed answers
  fall back to core events.
- Browser half registers the focus layer in `shell.overlay` and a session bridge
  in `conversation.input.dock`: canvas field (centre conclusion, material ring,
  sub-agent ring), 11 px blur scrim with 45% dim, both stage tiers of §4.5 with a
  260 ms transition, and the return capsule inside the message area.
- State vocabulary and lifecycle of §4: 160 ms material fade-in, 2.4 s hold,
  560 ms fade-out, 320 ms agent fade-out behind a 420 ms debounce, one pulse per
  node per 300 ms, waiting nodes pinned without breathing, a dashed halo for a
  producer-declared stall.
- Materials map from the published alias table (`contracts/tool-aliases-v1.json`,
  mirrored in `src/materials.js`); any unknown tool or alias version is 「其它」
  and never disappears.
- `src/labels.js` ports the orchestrator's 12-code-point display-label rule, so a
  degraded run names its agents exactly as the contract's 13 label cases say.
- `stalled` is read from `agents[].stalled` only; the client never derives a
  state from silence and never parses tool output. Both rules are enforced by
  source scans in the test suite.
- A tool call that arrives without an open turn (install, restart or hot reload
  mid-run) adopts the turn, so the field appears at once instead of staying blank
  until the next command. When the snapshot route is unreachable the overlay says
  `HUD 未连接` instead of rendering nothing.
- A pending question no longer drops the field: the ask surface floats above it,
  so the blur and the field stay while the dialog is open. A modal also softens
  the scrim (lighter dim, no pointer capture) so it can never swallow the dialog's
  clicks. Stale bundles and measurement mistakes are covered by a fake-shell test
  that walks `display: contents` slot hosts.
- Verification: the five contract fixtures (44 steps) replayed against the model,
  the 13 label cases, layout, focus, Host route, and a loader-shaped smoke test
  of the committed browser bundle.
