# Kanbantic Claude Code Plugin — v2.5.1

**Released:** 2026-05-13 · **Issue:** [KBT-B250](https://kanbantic.com/issues/KBT-B250) · **Spec:** KBT-SR320 · **Boundary:** KBT-BD086

## Summary

PATCH-release that narrows the scope of `/kanbantic-sync-workspace-skills` materialization to `Skill` + `Subagent` categories only. In v2.5.0 the sync-script also materialized `Command`-category toolkit-items to `.claude/commands/<slug>.md` — where Claude Code's command-loader picks them up as invocable slash-commands (`/solution-bouwen`, `/backend-api-starten`, etc.), polluting the slash-command namespace with reference-only shell-snippets that were never designed as workflow skills.

v2.5.1 closes that gap: `Command`-toolkit-items stay Toolkit-only, accessible via `mcp__kanbantic__list_toolkit_items(workspaceId, category: "Command")` for agents that need the snippet.

## What this fixes

### Behavior change — `Command` items skipped silently

Before (v2.5.0):
```
/kanbantic-sync-workspace-skills in a workspace with KBT-CMND001-007
  → creates .claude/commands/backend-api-starten.md
  → creates .claude/commands/solution-bouwen.md
  → ... etc
  → Claude Code reload picks them up as /backend-api-starten, /solution-bouwen, ...
```

After (v2.5.1):
```
/kanbantic-sync-workspace-skills in the same workspace
  → KBT-CMND001-007 silently skipped
  → summary.created counts only Skill + Subagent items
  → manifest contains no Command entries
  → Claude Code slash-command namespace stays clean
```

### Root-cause fix

`plugin/scripts/sync-workspace-skills.js`:

1. **`buildPlan` early-filter** (lines ~172-194): added `if (item.category !== 'Skill' && item.category !== 'Subagent') continue;` immediately after the `isActive`-check, BEFORE slug-validation. This means a Command-item with a title that normalizes to an empty slug (theoretically possible) can never trigger an `EMPTY_SLUG` `SyncError` — the category-filter runs first.

2. **`targetPathFor` cleanup**: removed `|| category === 'Command'` from the Skill branch. The function is now single-source: `Skill → .claude/commands/`, `Subagent → .claude/agents/`, everything else → null. This is defense-in-depth — if a future caller bypasses the `buildPlan` filter, `targetPathFor` still refuses to assign Command items a target path.

3. **JSDoc updates** on both functions explaining the rationale and pointing at KBT-B250 + KBT-BD086.

### SKILL.md update

`plugin/skills/kanbantic-sync-workspace-skills/SKILL.md`:

- "Filesystem footprint" table no longer claims `.claude/commands/` mirrors `Command`; explicit paragraph that Commands stay Toolkit-only.
- "Slug convention" scoped to `Skill` + `Subagent` items.
- Step 2 (Pull toolkit items): IMPORTANT-block notes that pulling Commands is fine — the script silently skips them.
- References section: KBT-B250, KBT-SR320, KBT-BD086, KBT-US557, KBT-TC1967-1969 added.

## What this does NOT do

- **No new flag.** There is no `--include-commands` opt-in. The boundary is permanent per KBT-BD086 — to make a Command-item invocable, promote it to `Skill`-category in the Toolkit.
- **No new target-dir** like `.claude/snippets/`. Commands stay in the Toolkit; an agent that needs the snippet inline calls `list_toolkit_items` directly.

## What this DOES on the first v2.5.1 sync (auto-cleanup of v2.5.0 leftovers)

When `/kanbantic-sync-workspace-skills` runs after upgrading from v2.5.0, the existing manifest entries for `Command`-category items end up in the "no longer active" branch of `buildPlan`'s deletion-loop (because Command items are filtered out before `seenSlugs` is built). The standard drift-detection then takes over:

| State of the v2.5.0 mirror-file | What v2.5.1 does on first sync |
|---|---|
| File matches manifest hash (untouched) | **Auto-deleted** — file + manifest entry removed; counted in `summary.deleted`. |
| File hash differs from manifest (locally edited) | **SKIP-LOCAL-EDIT warning** — file preserved, manifest entry preserved, counted in `summary.warnings`. Re-run with `--force` to discard the local edits. |
| File already absent | Manifest entry silently cleaned up; counted in `summary.deleted`. |

So operators on v2.5.0 do not need any explicit cleanup step — the next sync after upgrading materializes only Skill+Subagent (per the new filter) and cleans the Command leftovers as part of its normal manifest-reconciliation pass.

## Files changed

### Modified
- `plugin/scripts/sync-workspace-skills.js` — `buildPlan` category-filter + `targetPathFor` cleanup + JSDoc updates (+24 / -5 lines).
- `plugin/skills/kanbantic-sync-workspace-skills/SKILL.md` — Filesystem footprint, Slug convention, Step 2 IMPORTANT-block, References.
- `plugin/.claude-plugin/plugin.json` — version `2.5.0 → 2.5.1`, description extended.

### New
- `plugin/tests/sync-workspace-skills.test.js` — three new tests appended (KBT-TC1967 Unit, KBT-TC1968 Unit, KBT-TC1969 Integration / CLI). +94 lines.
- `RELEASE_NOTES_v2.5.1.md` (this file).

### Not changed
- Proxy (`plugin/proxy/kanbantic-mcp-proxy.js`) — untouched.
- Other SKILL.md files — untouched.
- `lint-skills.js` and its snapshot — untouched.
- `package.json` — no script changes; `npm test` still runs the same way.

## Verifying locally

```bash
cd C:/GitHub/kanbantic-claude-plugin
npm test
```

Expected on Windows 11 / Node 24+:
```
ℹ tests 47
ℹ pass 45
ℹ fail 0
ℹ skipped 2  (pre-existing Windows SIGTERM/SIGINT skips per KBT-PATN020)
```

The 3 new tests in this release:
```
✔ KBT-TC1967: buildPlan skips Command-category items — no plan entry, no manifest entry, no on-disk file
✔ KBT-TC1968: Command-item with empty-slug title does NOT throw EMPTY_SLUG (category-filter runs before slug-validation)
✔ KBT-TC1969 (CLI): mixed Skill+Command+Subagent input materializes only Skill+Subagent files; exit 0; no EMPTY_SLUG for bad-slug Command
```

End-to-end after install:
```
/kanbantic-sync-workspace-skills
# expect: created=N updated=0 unchanged=M deleted=0 warnings=W forced=0
# where N+M = active Skill+Subagent items (no Commands)
```

## How to install

```bash
claude plugin install kanbantic-claude-plugin
```

Re-install picks up the v2.5.1 tag automatically. Existing `/kanbantic-sync-workspace-skills` behavior is unchanged for Skill+Subagent items; only Command-handling changes.

## Migration for operators on v2.5.0

If you ran `/kanbantic-sync-workspace-skills` against the Kanbantic-monorepo on v2.5.0 and ended up with seven `.claude/commands/{backend-api-starten,frontend-dev-server-starten,solution-bouwen,database-bijwerken,ef-migratie-toevoegen,e2e-tests-uitvoeren,abp-pro-license-pre-flight-check-powershell}.md` files (Command-mirrors), upgrade to v2.5.1 and run the skill once. Expected result:

```
sync-workspace-skills: created=N updated=M unchanged=K deleted=7 warnings=0 forced=0
```

The 7 Command-mirror files (and the 7 corresponding `.kanbantic-sync.json` entries) are auto-deleted because their slugs no longer appear in the active-items input (Command-items are filtered upstream). No manual cleanup needed.

**Exception:** if you manually edited any of those mirror files after v2.5.0 wrote them, the on-disk hash will not match the manifest entry's `targetHash` — v2.5.1 then emits a `SKIP-LOCAL-EDIT` warning for that file and leaves it untouched. Either back-port the change into the actual Toolkit content (preferred, per KBT-TRUL014 — but a Command-item is the wrong place since it stays Toolkit-only) or re-run with `--force` to discard the local edit and delete the file.

If you'd rather do a clean reset, deleting `.kanbantic-sync.json` and the seven Command-mirror files manually and then running v2.5.1 sync from a clean slate is also fine — both paths converge on the same end-state.

## References

- **KBT-B250** — this bug.
- **KBT-SR320** — SystemRequirement: `buildPlan` filters on category before slug-validation.
- **KBT-BD086** — Boundary: Command toolkit-items stay Toolkit-only.
- **KBT-US557** — User story driving this fix.
- **KBT-TC1967 / 1968 / 1969** — regression tests.
- **KBT-TRUL014** — Toolkit source-of-truth rule (motivates the whole feature).
- **KBT-TRUL013** — Local E2E + No-UI exception (verification-stack rationale).
- Sister releases: v2.5.0 (KBT-F265 — original feature), v2.4.2 (KBT-B192 — SKILL.md invariants + lint).
