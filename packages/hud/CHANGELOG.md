# Changelog

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
- Verification: the five contract fixtures (44 steps) replayed against the model,
  the 13 label cases, layout, focus, Host route, and a loader-shaped smoke test
  of the committed browser bundle.
