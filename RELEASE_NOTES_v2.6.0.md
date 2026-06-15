# Kanbantic Claude Code Plugin — v2.6.0

**Released:** 2026-06-13 · **Issue:** [KBT-F341](https://kanbantic.com/issues/KBT-F341) · **Epic:** [KBT-E069](https://kanbantic.com/issues/KBT-E069)

## Summary

Adds a **readiness-gate override governance flag** to the stdio proxy. Every successful `update_issue_status` / `claim_issue` that carries an `overrideReason` now produces a greppable `[override-governance]` Comment on the affected issue, so a second party can confirm the override was appropriate. This is the *detective* half of a larger governance effort; the *preventive* server-side controls are tracked under Epic KBT-E069.

## Why this exists

`overrideReason` bypasses a failing readiness gate under **both Soft and Hard enforcement**, recorded server-side only as a passive Decision audit entry. A single agent can therefore push its own work past every gate.

This is not theoretical. In the AdminHub workspace, **all 17 issues of `ADM-INI004` (MollieVault) reached `Done` with no review-approval recorded, no test results recorded, and no merged-branch record** — the code was genuinely complete and squash-merged to `main`, but the Kanbantic bookkeeping was advanced via overrides at `claim_issue` (the initiative was still in Draft) and at `InDeployment → Done`. The same anti-pattern was already flagged for `ADM-INI002` in the v2.4.0 notes.

Per-workspace memory / CLAUDE.md / AI-Toolkit cannot fix this: agents run on many machines across many workspaces, but **always** through this plugin and the Kanbantic MCP server. The proxy is the one client-side choke-point that is central across every workspace — the right place for a *detective* control. (Authoritative *prevention* belongs in the backend `IssueReadinessService`; see KBT-E069.)

## What this adds

`plugin/proxy/kanbantic-mcp-proxy.js` — new `flagOverrideIfPresent()`:

- **Trigger:** a `tools/call` to `update_issue_status` or `claim_issue` whose arguments include a non-empty `overrideReason`, **and** whose response reports `success: true`.
- **Action:** posts a `Comment` discussion entry on the affected issue (resolved from the response `issueCode`, falling back to the request `issueId`) carrying the `[override-governance]` marker, the override reason, a separation-of-duties recommendation, and the opt-out hint. The marker makes every proxy-flagged override findable workspace-wide with a single search.
- **Transparent bridge preserved:** the override call is forwarded **verbatim** and its response is returned **unchanged**; the flag is a fire-and-forget side-effect issued *after* the response, fully wrapped in try/catch. A flag failure never affects the user-visible call.
- **No `workspaceId` coupling:** uses `add_discussion_entry` (issueId-only). `create_signal` was rejected because the proxy cannot cheaply resolve a workspace from an issue code; `add_finding` requires a specialist `runId`.
- **Opt-out:** set `KANBANTIC_SKIP_OVERRIDE_FLAG=1` (mirrors the existing `KANBANTIC_SKIP_GIT_SYNC` convention).

## Files changed

### New
- `plugin/tests/proxy-override-flag.test.js` — real-proxy spawn test: 1 positive (override → verbatim response + `[override-governance]` flag posted) + 1 negative (no override → no flag).
- `RELEASE_NOTES_v2.6.0.md` (this file).

### Modified
- `plugin/proxy/kanbantic-mcp-proxy.js` — `flagOverrideIfPresent()` + dispatch hook (fire-and-forget after responses are sent).
- `plugin/.claude-plugin/plugin.json` — `version` 2.5.1 → 2.6.0; `description` extended.

## Out of scope (tracked under KBT-E069)

The authoritative *preventive* controls live in the backend and are deferred to sibling Features:

- **KBT-F338** — make objective gates (All Tests Passed / Review Approved / Child Issues Done) non-overridable.
- **KBT-F339** — separation-of-duties: an override must come from a different identity than the worker.
- **KBT-F340** — make the `Branch Merged` gate squash-merge aware so legitimate merges stop *forcing* overrides.
- Upstream dependency **KBT-INI032 Epic D** (`GateEvaluationService`) for a gated `InDeployment → Done`.

A future follow-up may upgrade the proxy flag from a per-issue Comment to a workspace-level `Signal` once the proxy can resolve a workspace from an issue.

## Verification

```
npm test
```

Result on 2026-06-13 (Windows 11):

```
✔ proxy forwards approve_review via tools/list + tools/call (real-proxy spawn)
✔ override on update_issue_status → response verbatim + add_discussion_entry flag posted
✔ update_issue_status WITHOUT overrideReason → no flag posted
﹣ KBT-TC1865 — proxy graceful shutdown on SIGTERM (skipped — Windows host)
﹣ KBT-TC1866 — proxy graceful shutdown on SIGINT (skipped — Windows host)

ℹ tests 49 / pass 47 / fail 0 / skipped 2
```

The pre-existing `approve_review` real-proxy regression test stays green, proving the new side-effect did not change forwarding behaviour.

## References

- `KBT-F341` — this feature (detective control).
- `KBT-E069` — parent Epic (override escape hatch).
- `KBT-F338` / `KBT-F339` / `KBT-F340` — sibling server-side preventive controls.
- `KBT-RL053` — Review → InDeployment lane-rule (the ungated hop).
- `KBT-INI032` Epic D — deferred `GateEvaluationService` (upstream dependency).
- Source incident: AdminHub `ADM-INI004` (closed 2026-06-13 via documented overrides).
