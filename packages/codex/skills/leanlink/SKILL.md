---
name: leanlink
description: Coordinate Codex subagents with versioned work records, concise result handoffs, and exact step retrieval. Use when a delegated task needs durable results, acceptance records, or follow-up on a specific earlier step.
---

# LeanLink

Use the LeanLink MCP tools for the work that needs a durable record. Delegate work with Codex's native agent tools. Give each child the same workspace and run identifiers, current input version, distinct step name, and its own objective and acceptance criteria.

Use an isolated fork (`fork_turns: "none"` where available) when that brief and a few references contain everything the child needs. Inherit the conversation when the task depends on prior decisions that cannot be represented reliably in the brief.

- Register the input with `leanlink_submit`. Create with `expectedVersion: 0`, or submit a revision against the current version. Reuse a mutation's `opId` only to retry the same write. Pass the resulting reference with the assignment.
- Save a completed branch with `leanlink_checkpoint`, `kind: "result"`, and the input version it used. Keep the parent handoff to the reference, decision-relevant facts, and any uncertainty. Save intermediate evidence separately when it matters for later review.
- Verify the result before recording `leanlink_review`. Revisions need a result for the new input version. Use `leanlink_lookup` for step history and `leanlink_read` with the exact returned reference when evidence is missing or a user asks to see an earlier result. Continue from `nextStart` only when more of that exact record is needed.

Use the same workspace and run across turns. Prefer direct execution for small serial checks, where creating a delegated record adds work without useful reuse. Keep leading zeros, units, negations, and acceptance conditions exact.
