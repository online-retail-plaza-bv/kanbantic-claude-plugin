# Release Notes — v2.12.0 (KBT-E066 / KBT-F320)

Completes the **version-aware plugin track** (Epic KBT-E066): F318 (version-aware
skills), F319 (Version slash-commands) and F320 (registry-sync / lint / hooks /
self-release). This is the **meta-release** — the plugin is the first Application
published end-to-end through the new Version-flow.

## known-mcp-tools.json — synced to the LIVE registry

The proxy is transparent (KBT-B200), so the bundled snapshot must mirror the live
MCP registry. After the F10 release→Version rename:

- **Removed (4 legacy release-tools):** `create_release`, `list_releases`,
  `update_release`, `get_release_notes`.
- **Added (12 live Version-flow tools):** `create_version`, `list_versions`,
  `update_version`, `freeze_version`, `mark_version_released`,
  `preview_next_version`, `get_version_notes`, `app_version_at_date`,
  `issue_version_lookup`, `version_audit_timeline`, `evaluate_rollout_readiness`,
  `record_rollout_decision`.
- The stale names from the F320 description that never shipped as MCP tools
  (`assess_version_readiness`, `archive_version`, `add_affects_version`,
  `get_application_version_at_date`, `get_version_timeline`,
  `get_issue_deployment_info`, `get_roadmap_data`, `search_deployment_history`,
  `remove_affects_version`) are deliberately **absent**.

## lint-skills.js — Invariant 5 (version-awareness)

A new invariant fails CI when any lane-skill SKILL.md carries a stale
release-domain token: `releaseId`, `release_id`, the capital-cased whole word
`Release`, or any removed release-tool name. A line may opt out with the
`lint-skills-allow-release` marker (e.g. a documented GitHub Release in prose).
Lowercase `release` in prose does not hard-fail (TC2360 design-choice).

## Two new zero-dependency hooks

- **PreToolUse `pre-tool-use-locked-version-blocker.js`** — intercepts
  `claim_issue`, resolves the issue's delivered-in Version via
  `issue_version_lookup`, and **blocks** the claim when the Version is
  locked-on-deploy (`lifecycleStatus` ≥ `StagingDeployed`, KBT-F458) with the
  message `Locked Version <name> (status <status>); klaim niet toegestaan na
  lock-on-deploy`. Fail-open on any infrastructure error (no API key, network,
  unparseable response) so a malfunction never wedges a session.
- **Stop `stop-version-summary.js`** — prints a one-line Version summary at
  session-Stop from the proxy-maintained session-file
  (`~/.claude-kanbantic-session.json` → `versionContext`):
  `Version <name> voor <application> — <n> issues, status <status>, %done <n>%`.
  Sessions with no Version context print nothing.

Both are registered in `plugin/hooks/hooks.json` (`PreToolUse` matcher
`mcp__.*__claim_issue`; `Stop`).

## Version bump + lockstep (KBT-F454)

`plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and the
root `package.json` are all bumped to **2.12.0** in lockstep. (The previously
planned v2.6.0 had already shipped; the self-release target is re-pointed to the
next MINOR per KBT-BD157.)

## Self-release (KBT-TC2368, meta-contract)

The plugin is the first Application driven through the new Version-flow: a
Version `v2.12.0` runs Planned → … → prod-deploy, after which the F6-handler
auto-creates the GitHub Release `v2.12.0` in
`Online-Retail-Plaza-BV/kanbantic-claude-plugin`. The GitHub-Release step is the
downstream manual/E2E meta-test that runs after prod-deploy.

## Test coverage

- `plugin/tests/known-mcp-tools.test.js` — 12 added / 4 removed / stale-absent (TC2359).
- `plugin/tests/lint-skills.test.js` — Invariant-5 positive + negative cases (TC2360).
- `plugin/tests/locked-version-blocker.test.js` — block (StagingDeployed/Released),
  allow (InProgress / non-claim), fail-open, + pure-helper units (TC2362).
- `plugin/tests/stop-version-summary.test.js` — exact summary line + silent variants (TC2365).

`node plugin/scripts/lint-skills.js` and `node plugin/scripts/check-bundle-tool-drift.js`
are green; full `npm test` passes (the pre-existing `git-credential-helper.test.js`
env-failure is unrelated).

### Target

- Version: v2.12.0
- Issue: KBT-F320 (Epic KBT-E066)
