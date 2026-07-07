# Release Notes — v2.13.0 (KBT-F470 / KBT-SR517)

Completes **app-scoped Version-CRUD over all surfaces** on the plugin side of
Feature KBT-F470. The MCP `delete_version` tool and the app-scoped `create_version`
(PR #242) are now exposed as first-class slash-commands, and the curated
`known-mcp-tools.json` snapshot is re-synced to the live registry.

## New command — `/kanbantic-version-create`

`plugin/commands/kanbantic-version-create.md` — a thin, **non-destructive**
wrapper around the app-scoped `create_version` MCP tool (PR #242:
`workspaceId` + `applicationId` + `name` + optional `description`).

- Positional args: `<application-slug> <version-name> [description]`.
- Resolves the owning **Application** by slug (falls back to name) via
  `list_applications`, then calls `create_version` app-scoped.
- **No confirmation prompt** — creating a brand-new Version modifies/deletes
  nothing existing. Modeled after the existing read wrappers
  (`kanbantic-version-status.md`).

## New command — `/kanbantic-version-delete`

`plugin/commands/kanbantic-version-delete.md` — a wrapper around the new
`delete_version` MCP tool, following the **mutating-confirm pattern** of
`kanbantic-version-freeze.md`.

- Resolves the version-code → shows `code`, `name`, `status` **and the concrete
  associated-issue count** (via `list_issues(VersionId)`).
- **⚠ Cascade warning (KBT-BD158):** the explicit `yes`-gated confirmation
  names the cascade — deleting a Version permanently deletes **every Issue whose
  `VersionId` is this Version** before deleting the Version itself
  (`VersionAppService.DeleteAsync`). This is destructive and non-recoverable.
- **Abort path** makes no MCP call; **proceed path** calls
  `mcp__kanbantic__delete_version` only on explicit affirmative.

## known-mcp-tools.json — re-synced

`delete_version` is **added** to the curated `tools` array (the app-scoped
`create_version` and `freeze_version` were already present). The 4 deprecated
release-concept tools (`create_release`, `list_releases`, `update_release`,
`get_release_notes`) remain **excluded** — `known-mcp-tools.test.js` asserts
their absence. `generatedAt`/`source` updated; the curated-subset note preserved.

## Version bump + lockstep (KBT-F454)

`plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and the
root `package.json` are all bumped **2.12.0 → 2.13.0** in lockstep
(`check-version-sync.js`).

## Verification

- `node plugin/scripts/lint-skills.js` — green.
- `node plugin/scripts/check-bundle-tool-drift.js` — green.
- `node plugin/scripts/check-version-sync.js` — green (both manifests at 2.13.0).
- `npm test` — green (the pre-existing `git-credential-helper.test.js`
  env-failure is unrelated).

### Target

- Version: v2.13.0
- Issue: KBT-F470 · Spec KBT-SR517 · Boundary KBT-BD158
