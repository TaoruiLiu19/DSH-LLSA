# Changelog

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
