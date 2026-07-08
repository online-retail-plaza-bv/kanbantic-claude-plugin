# Release Notes — v2.20.0

**KBT-F490 — Wireframe-versie concurrency-guard: lineage + waarschuwing bij divergente save**

Interim step toward KBT-E096 (Git-backed wireframes): make concurrent wireframe-version
edits **visible** without introducing real branch/merge.

## What changed (plugin surface)

The three wireframe write-tools now accept **optional lineage parameters** and return a
**non-blocking `divergenceWarning`**:

| Tool | New optional params |
|---|---|
| `add_wireframe_version` | `baseVersionId` (GUID) or `baseVersionNumber` (int), `variantLabel` (≤60 chars) |
| `add_wireframe_version_files` | `baseVersionId` / `baseVersionNumber`, `variantLabel` |
| `update_wireframe_version` | `variantLabel` (the existing source `versionNumber` is recorded as the lineage base) |

When a base is supplied and a newer version already exists
(`latest.VersionNumber > base.VersionNumber`), the tool response carries a `divergenceWarning`
(base number, latest number + author, the new version number, and a human message). This is
**advisory-only (KBT-RL157)** — the version is always saved; the guard never blocks a write.
An invalid base (unknown id/number within the wireframe) is a **clear validation error**, not a
silent NULL-fallback (KBT-SR532).

## Registry (`known-mcp-tools.json`)

**Unchanged** — F490 adds parameters and a response field to **existing** tools; it adds no new
tool NAMES. The registry drift-check (`check-bundle-tool-drift.js` / `known-mcp-tools.test.js`)
tracks tool names, and the new params/field are surfaced **live** through the `tools/list`
proxy enrichment (KBT-RL134), so no snapshot resync was required (207 tools, all present).

## Lockstep version bump

`package.json`, `plugin/.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`
bumped `2.19.0 → 2.20.0`.

Companion Kanbantic API change: server-side lineage field (`BaseVersionId`) + `VariantLabel`,
additive EF migration, divergence detection, and the Angular authoring editor + version-tree
lineage badge — shipped together under KBT-F490.
