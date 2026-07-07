# Release Notes — v2.15.0 (KBT-F484 / KBT-E094)

## Sync `known-mcp-tools.json` with the new parent/child bundling tools

v2.15.0 re-syncs the plugin's curated MCP-tool snapshot with the live registry
after the **KBT-E094** ("MCP parent/child (Epic-bundling) sluitend maken") API
release (kanbantic API v0.9.226). The Epic makes the Epic ↔ Feature/Bug bundle
relationship a first-class, symmetric part of the MCP surface — including four
new tools that agents can now call to (re)parent existing issues, list an Epic's
children, and bulk-bundle in one transactional call.

### Changes

#### `plugin/scripts/known-mcp-tools.json`

**Added (4 new live tools, KBT-E094):**
- `bundle_issue` — bundle an existing Feature/Bug under an Epic (validated:
  parent must be an open Epic in the same workspace; children can't be Epics;
  no self-cycle). Idempotent + audited.
- `unbundle_issue` — remove an issue from its parent Epic (make it standalone).
- `bundle_issues_into_epic` — transactional bulk-bundle (all-or-nothing).
- `get_epic_children` — list the Features/Bugs bundled under an Epic.

**Curated out (drift fix, per the `regenerationCommand` + `known-mcp-tools.test.js`):**
- The 4 legacy release-concept tools (`create_release`, `list_releases`,
  `update_release`, `get_release_notes`) — they remain live but must not be in
  the snapshot (superseded by the Version-flow tools).
- Stale name `get_roadmap_data` (in the F320 stale-list).

Snapshot tool-count: 207 → 206. `generatedAt` / `source` updated. All three
`known-mcp-tools.test.js` assertions now pass (previously 2 failed on `main`
due to the un-curated legacy release-tools).

### Versioning

Lockstep bump to **2.15.0** across `.claude-plugin/marketplace.json`,
`plugin/.claude-plugin/plugin.json`, and `package.json`.

### Notes

The four bundling tools are directly callable MCP tools; no slash-command
wrappers are shipped in this release (the tools are self-describing and used
programmatically by the lane-skills). A thin `/kanbantic-bundle-issue` wrapper
remains an optional future addition.
