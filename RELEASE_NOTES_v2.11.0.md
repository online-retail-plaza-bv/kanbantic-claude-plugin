# Release Notes — v2.11.0

**Epic KBT-E087 — Agent-orchestratie & modelbeleid** (Initiative KBT-INI041). Minor bump (new features, no breaking changes). This release pairs with a companion Kanbantic API change for KBT-F437.

## Features

### KBT-F436 — `/kanbantic-orchestrate` sequencer skill
A new, parameterized orchestration skill (`{workspace, initiative, repos}`). It is a **top-of-funnel sequencer**, explicitly **not** a lane-skill: it decides *which* issues in an initiative are actionable, *in what order*, and drives each one through the existing lane-skills (triage → prepare → execute → review) with explicit hand-offs. It owns sequencing only and does not re-implement claim / per-phase push / merge — those stay in `kanbantic-issue-execute` / `kanbantic-issue-review`. Overridable per workspace via a Toolkit Skill item of slug `kanbantic-orchestrate` (the workspace override is *intended* to shadow the plugin baseline; this Claude Code command-resolution order is documented as assumed-and-to-be-verified). Ships with `plugin/commands/orchestrate.md`.

### KBT-F438 — `launch-orchestrator` script (scripted fallback)
`plugin/scripts/launch-orchestrator.ps1` (Windows-primary) and `.sh` (POSIX). Resolves `KANBANTIC_API_KEY` (env → `HKCU\Environment` fallback on Windows), launches Claude Code with `--dangerously-load-development-channels server:kanbantic`, and invokes `/kanbantic-orchestrate` with the given workspace/initiative. Fail-fast: exit 2 on missing params, exit 3 on missing key — **without spawning**. The API key is never printed. **Boundary:** the full Workstation-Daemon `SpawnCommand` / Agent-Sessions integration is intentionally deferred until v0.14.0 matures (KBT-BD151).

### KBT-F447 — context-aware lane-skill gates
The worktree/repo HARD-GATEs in `kanbantic-issue-prepare` / `-execute` / `-review` are now context-aware: skipped (with a logged opt-out) in no-repo or MCP-only contexts such as Cowork / the desktop app, via a pure `plugin/scripts/gate-context.js` helper (`shouldEnforceWorktreeGate({ hasGitRepo, touchesFilesystem })`). **Real code-in-repo work keeps the strict gate** — the relaxation applies only to the no-repo/MCP-only path, defended by an explicit `<CRITICAL>` block in execute/review (KBT-BD155, parallel-agent safety per KBT-TRUL004).

### KBT-F437 (sync side) — `model:` frontmatter
`plugin/scripts/sync-workspace-skills.js` now emits a `model: <opus|sonnet|haiku>` frontmatter line for Subagent items that carry the new `Model` field (no line when unset), and folds the model into its drift hash so a model-only change is detected as an `update`. Companion Kanbantic API change: a nullable `SubagentModel` field on Toolkit Subagent items, honored at spawn.

## Tests
All new code ships with deterministic, side-effect-free tests (`gate-context.test.js`, `launch-orchestrator.test.js`, extended `sync-workspace-skills.test.js`). Full plugin suite green; `lint-skills` passes.

## Review
Reviewed by two independent reviewers (per repo). Verdict APPROVE, no Critical issues. Two should-fix items were addressed (orchestrate frontmatter wording; RL140 precedence marked as assumed). One follow-up noted on the API side (MCP `UpdateToolkitItem` clears `Model` when omitted — mirrors existing `CustomCategoryName` behavior).
