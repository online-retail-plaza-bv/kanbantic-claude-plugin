# Release Notes — v2.18.0 (KBT-F488)

Re-syncs the curated `known-mcp-tools.json` snapshot to the live registry to
pick up the new **`add_wireframe_version_files`** MCP tool shipped by KBT-F487.

## Snapshot re-sync — `known-mcp-tools.json`

Adds **`add_wireframe_version_files`** (206 → **207** tools). The tool went live
on the production MCP server with the KBT-F487 backend deploy (v0.9.245); the
bundle snapshot is regenerated from the live `tools/list` so `check-bundle-tool-drift`
stays green. The 4 deprecated release-concept tools remain excluded per
`known-mcp-tools.test.js`.

## What the new tool does (Kanbantic repo, KBT-F487)

`add_wireframe_version_files(wireframeId, filesJson, entryPointPath?, changesSummary?, screenId?)`
lets an agent store a whole **multi-file wireframe fileset in a single MCP call**
as **one** immutable version — instead of one `add_wireframe_version` call per
file (each creating its own version number). The fileset is passed as a JSON-array
string in `filesJson` (matching the codebase's scalar-only MCP-param convention);
path-safety, content-type derivation and entry-point invariants stay server-side.

The tool is a thin MCP wrapper over the pre-existing `AddVersionWithFilesAsync`
backend (KBT-F469). Unit + integration + E2E coverage ran green (integration/E2E
against a Postgres testcontainer); merged via PR #274, deployed to staging +
production, and confirmed present in the live MCP registry.

## Version bump

Lockstep bump `2.17.0 → 2.18.0` across `plugin/.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, and `package.json`. Minor bump — additive
snapshot change, no behavior change to existing commands.

Follow-up to **KBT-F487**; split out because the plugin registry snapshot lives
in this repo and can only be resynced after the backend tool is live.
