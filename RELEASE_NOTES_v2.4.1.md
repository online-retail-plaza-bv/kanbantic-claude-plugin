# Release Notes — kanbantic-claude-plugin v2.4.1

**Released:** 2026-05-11
**Reference:** [KBT-B200](https://kanbantic.com/issues/KBT-B200) — Plugin-bundle mist `approve_review` — agents kunnen Review→Done niet autonoom afronden.

## What this is

A regression-prevention patch addressing the failure mode reported in KBT-B200 (2026-05-02): an agent observed the `approve_review` MCP tool missing from the plugin's tool namespace and could not autonomously clear the `HasReviewApproval` readiness gate. Investigation in May 2026 confirmed:

- The plugin proxy (`plugin/proxy/kanbantic-mcp-proxy.js`) is a **transparent stdio→HTTP bridge** with no per-tool allowlist. `tools/list` is forwarded verbatim — whatever the live MCP server registers, the plugin exposes.
- The 2026-05-02 observation was a transient stale-cache / timing moment; the current bundle (v2.4.0+) already exposes `approve_review` (and every other server-registered tool).

What was still missing — and what v2.4.1 ships — is **a regression test that would catch a future drift between the plugin's exposed tools and the live MCP registry before it blocks another agent.**

## Changes

### Added

- **`plugin/tests/proxy-approve-review.test.js`** — real-proxy spawn test. Boots a local stub MCP backend, `child_process.spawn`'s the actual proxy script unmodified, exercises `initialize` + `tools/list` + `tools/call name=approve_review`, asserts the proxy forwards the call verbatim and returns the response verbatim, and asserts clean exit on stdin close. Zero external deps (Node `node:test` built-in runner).
- **`plugin/scripts/check-bundle-tool-drift.js`** — on-demand drift detector. Queries any MCP endpoint's `tools/list` and exits:
  - `0` when every MUST-HAVE tool (`approve_review`, `start_run_review`, `complete_run_review`) is present.
  - `1` when one or more MUST-HAVE tools are missing (drift).
  - `2` on infrastructure / auth failure (distinguishes "couldn't check" from "checked and drifted").
  Configurable via `KANBANTIC_MCP_URL` (default `https://kanbantic.com/mcp`) + `KANBANTIC_API_KEY`.
- **`plugin/tests/check-drift.test.js`** — positive + negative case tests for the drift detector.
- **`package.json`** (repo root) — zero runtime deps; only `scripts.test = "node --test plugin/tests/*.test.js"` and `scripts.check:drift`. Enables `npm test --prefix <repo>` for ad-hoc local validation.

### Changed

- **`plugin/.claude-plugin/plugin.json`** — version `2.4.0` → `2.4.1`; description updated to note the v2.4.1 addition.
- **`plugin/skills/kanbantic-issue-review/SKILL.md`** — Step 7.5 gains a "Fallback if `approve_review` is unavailable" paragraph documenting the drift-detector command and the escalation protocol (per KBT-B200's "Suggestie voor preventie"). No other skill-content changes.

### Not changed

- The proxy code itself is unmodified — it is already correct (transparent forwarding).
- No other SKILL.md files were edited.
- No new MCP tools, no protocol changes, no breaking changes.

## Verifying locally

```bash
cd C:/GitHub/kanbantic-claude-plugin
npm test
```

Expected output:
```
✔ drift-detector: positive case — all MUST-HAVE tools present
✔ drift-detector: negative case — approve_review missing → exit 1
✔ proxy forwards approve_review via tools/list + tools/call (real-proxy spawn)
ℹ tests 3 — pass 3, fail 0
```

For an ad-hoc drift check against a real backend:
```bash
KANBANTIC_API_KEY=... npm run check:drift
# OK: all MUST-HAVE tools present (3 required, N total exposed at https://kanbantic.com/mcp)
```

## References

- **KBT-B200** — bug filed 2026-05-02; resolved 2026-05-11.
- **KBT-SR298** — system requirement: plugin proxy transparently forwards `approve_review` (regression-prevention).
- **KBT-TC1855** — test case: real-proxy spawn forwards `approve_review`.
- **KBT-TC1856** — test case: drift detector flags missing `approve_review`.
- **KBT-F170 / KBT-PR191** — original introduction of `approve_review` (KBT-F156 / KBT-B175 follow-ups).
- **KBT-TRUL013** — Local E2E verification mandate (the plugin row of which mandates real-proxy spawn testing).
