---
name: kanbantic-sync-workspace-skills
description: "Materialize the active Kanbantic workspace's Toolkit Skill and Subagent items as on-disk .claude/commands/*.md and .claude/agents/*.md files, with a .kanbantic-sync.json manifest for drift detection. Idempotent — re-run is a no-op when nothing changed. Refuses to overwrite locally-edited mirror files unless --force is passed. Per KBT-TRUL014 the Toolkit is the source-of-truth; this skill is the canonical mechanism for keeping the on-disk mirrors aligned (KBT-F265 + KBT-B250). Command toolkit-items are reference-only snippets per KBT-BD086 and stay Toolkit-only (no disk mirror)."
---

# Kanbantic Sync Workspace Skills

## Overview

This skill keeps your repo's on-disk `.claude/commands/*.md` and `.claude/agents/*.md` files in sync with the workspace Toolkit categories `Skill` and `Subagent`. Per **KBT-TRUL014** the Toolkit is the source-of-truth; the on-disk files are derived mirrors that Claude Code's loader actually reads. `Command` toolkit-items are intentionally NOT materialized (per **KBT-BD086** — they are reference-only snippets, not invocable slash-commands).

**Principle:** Toolkit → manifest-aware diff → on-disk files. Drift is detected via SHA-256 hashes recorded in `.kanbantic-sync.json` at the repo root.

**Announce at start:** "I'm using the kanbantic-sync-workspace-skills skill to materialize the workspace Toolkit's Skill and Subagent items as local .claude/ files."

## Scope

This skill is **not** a lane-verwerker — it does not transition any Kanbantic issue. It is a maintenance utility that you run:

- After a new Skill or Subagent toolkit item is added or updated.
- When cloning a fresh repo for the first time.
- Whenever the `kanbantic-issue-execute` Step 0 detects the workspace has Toolkit-Skill changes since the last sync (future automation hook).

The skill does NOT:

- Touch source code outside `.claude/`.
- Read or modify repository credentials.
- Cross-call any other Kanbantic skill.

## Filesystem footprint (per KBT-BD083)

The skill writes only to:

| Path | Purpose |
|---|---|
| `.claude/commands/<slug>.md` | Mirror for Toolkit category `Skill` |
| `.claude/agents/<slug>.md`   | Mirror for Toolkit category `Subagent` |
| `.kanbantic-sync.json`       | Manifest with source/target SHA-256 hashes |
| `.gitignore`                 | Appends the three patterns above when missing |

`Command` toolkit-items are **NOT** materialized to disk — per **KBT-BD086** they are reference-only snippets (single shell-command + one-line uitleg), not invocable slash-commands. To read a Command's content, an agent calls `mcp__kanbantic__list_toolkit_items(workspaceId, category: "Command")` directly. Materializing them under `.claude/commands/` would make Claude Code's command-loader expose them as `/foo`-style commands, which is semantically wrong and pollutes the slash-command namespace (the regression that motivated KBT-B250).

## Slug convention (per KBT-PR209)

For each Toolkit item **of category `Skill` or `Subagent`** the slug is computed from its `title`:

1. Take the prefix before the first em-dash `—` (U+2014); if there is no em-dash, use the whole title.
2. Strip a leading `/` if present.
3. Lowercase + replace any run of non-`[a-z0-9]` chars with `-`; trim leading/trailing `-`.

Examples:

| Title | Slug | Path |
|---|---|---|
| `/test-e2e-local — Lokale E2E Test Omgeving` | `test-e2e-local` | `.claude/commands/test-e2e-local.md` |
| `Documentation Specialist` | `documentation-specialist` | `.claude/agents/documentation-specialist.md` |
| `/local-dev-sandbox — Lokale Dev/Debug Sandbox (KBT-F233)` | `local-dev-sandbox` | `.claude/commands/local-dev-sandbox.md` |

If two active items resolve to the same slug, the skill aborts BEFORE any write with a structured error listing both offending source codes.

## Generated frontmatter (per KBT-B495)

Every mirror file gets a YAML frontmatter block, then the toolkit item's content verbatim:

| Field | Written for | Value |
|---|---|---|
| `name` | **`Subagent` only** | The slug — identical to the filename without `.md`. |
| `description` | both | First usable line of the item's content (headings, fenced code and a leading `name:` line are skipped), else the title after the em-dash. Truncated at ~250 chars. |
| `source` | both | The toolkit item code (e.g. `KBT-SAGN009`). Informational only. |
| `model` | items carrying a Model | Lowercased alias (`opus` / `sonnet` / `haiku`), per KBT-F437. |

**Why `name` is mandatory for subagents.** Claude Code registers a subagent under its frontmatter `name:` value and does **not** fall back to the filename. A `.claude/agents/*.md` file without that field is written correctly and loads as nothing — calling it fails with `Agent type '<slug>' not found.`. Skills/commands take their name from the filename, which is why the `.claude/commands/` mirror always worked while the agents mirror was silently dead until KBT-B495. Commands deliberately get **no** `name:` line.

Because `name` is the same slug that determines the file path, the existing slug-collision check doubles as an agent-name uniqueness check: two subagents can never claim the same name.

> **Upgrading from a plugin version before this fix.** No `--force` is needed. Drift detection compares the on-disk hash against the manifest's `targetHash`, not against a freshly rendered file — an untouched mirror still matches, so it is re-rendered as a normal **UPDATE**. Only mirrors you actually hand-edited keep warning, exactly as before. Note that the mirrors were unloadable, not wrong: after re-syncing, restart the Claude Code session so the loader picks the agents up.

## Checklist

1. **Determine workspace** — call `mcp__kanbantic__get_context` to identify the active workspace (or accept an explicit `--workspace <slug>` from the user).
2. **Pull toolkit items** — call `mcp__kanbantic__list_toolkit_items` three times: once each for categories `Skill`, `Command`, `Subagent`. Concatenate into one array.
3. **Pipe through sync script** — invoke `plugin/scripts/sync-workspace-skills.js` with the concatenated array on stdin.
4. **Report summary** — relay the script's `created / updated / unchanged / deleted / warnings / forced` counts back to the user.
5. **Resolve warnings** — if warnings > 0, surface the affected file paths and ask whether to re-run with `--force` or to back-port the local edits into the Toolkit item.

## Step 1: Determine workspace

```
MCP: mcp__kanbantic__get_context
```

The `workspaces` array in the response contains every workspace the agent has read access to. Pick the one whose slug matches the repo's identity (typically the `kanbantic` workspace for the Kanbantic monorepo, or the workspace named in `CLAUDE.md`'s ClaudeMd item). If multiple workspaces match, ask the user to disambiguate.

Record the chosen `workspace.slug` — you'll need it in Step 3.

## Step 2: Pull toolkit items

For each of the three categories `Skill`, `Command`, `Subagent` call:

```
MCP: mcp__kanbantic__list_toolkit_items(workspaceId: "<slug>", category: "<Skill|Command|Subagent>", maxResults: 200)
```

Concatenate the three result arrays into one flat list of items. Each item must contain at minimum `id`, `code`, `category`, `title`, `content`, and `isActive`.

<IMPORTANT>
**The list must be COMPLETE.** Every manifest entry not mentioned anywhere in the list used to be treated as a deletion, and its mirror was unlinked — reported as a plain `deleted=N`. Since **KBT-B489** the script refuses instead (exit 2), but that only turns silent damage into a visible stop; it is still on you to fetch everything:

- Make the three per-category calls. One unfiltered call is **not** equivalent — it shares a single `maxResults` budget across all categories and silently truncates. A real near-miss returned 200 of 224 items and would have removed two live subagent mirrors.
- Compare each response's `totalCount` against the number of items you actually received. If they differ, raise `maxResults` and call again.
- A deactivated item must stay **in** the list with `isActive: false`. That is how the script tells "the user retired this" apart from "you forgot to fetch it". Omitting it entirely aborts the run.

**Do not hand raw REST output through unchecked.** `GET /api/app/toolkit-item` returns `category` and `model` as integer enums, the MCP tool returns their names. The script accepts both shapes (`1` = Skill, `6` = Subagent — **KBT-B491**; `0`/`1`/`2` = Opus/Sonnet/Haiku — **KBT-B531**), but anything it cannot place aborts the run with exit 2 rather than being skipped. That abort is deliberate: skipping an unrecognised item makes it look deactivated, which is what wiped entire mirror sets before the fix.

Some MCP responses include extra fields (tags, createdAt, etc.) — the sync script ignores anything it doesn't recognise, so passing the full payload through is fine.

`Command`-items can also be passed through verbatim; the sync script silently skips them (per **KBT-B250** / **KBT-BD086**, they are reference-only and not materialized to disk). A future optimization could filter Command-category server-side before the pipe, but pulling all three categories keeps the orchestrator code symmetrical with the SKILL.md checklist.
</IMPORTANT>

## Step 3: Run the sync script

From the repo root (or worktree), pipe the concatenated array to the script:

**PowerShell (Windows):**

```powershell
$json = $items | ConvertTo-Json -Depth 10 -AsArray
$json | node $env:CLAUDE_PLUGIN_ROOT/scripts/sync-workspace-skills.js --workspace <slug>
```

**Bash (macOS/Linux):**

```bash
echo "$JSON" | node "$CLAUDE_PLUGIN_ROOT/scripts/sync-workspace-skills.js" --workspace <slug>
```

The script reads JSON from stdin, applies the diff, writes the manifest, and prints a single summary line:

```
sync-workspace-skills: created=2 updated=1 unchanged=6 deleted=0 warnings=0 forced=0
```

### Script flags

| Flag | Meaning |
|---|---|
| `--input <path>` | Read items from a file instead of stdin (handy for debugging). |
| `--root <path>`  | Run against an alternative repo root (defaults to cwd). |
| `--workspace <slug>` | Workspace slug to record in the manifest. |
| `--force`        | Overwrite locally-edited files (warning still reported). Also waives the completeness guard — see below. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Sync completed without warnings. |
| `1` | Local-edit warnings preserved (or slug collision) — re-run with `--force` after reviewing. |
| `2` | Infrastructure failure (not a git repo, malformed input, fs error), **or** a rejected input: `UNKNOWN_CATEGORY` (KBT-B491) / `INCOMPLETE_INPUT` (KBT-B489). |

### Input rejections (KBT-B489 / KBT-B491)

Both rejections happen in the planning phase, so **nothing is written** — no file created, updated or deleted, and `.kanbantic-sync.json` stays byte-identical.

| Kind | Trigger | What to do |
|---|---|---|
| `UNKNOWN_CATEGORY` | An **active** item carries a `category` that is neither an enum name nor an enum integer. The message shows the offending codes and the raw value received. | Fix the fetch layer — you are probably feeding a shape neither the MCP tool nor the REST API produces. |
| `INCOMPLETE_INPUT` | A manifest entry is not mentioned anywhere in the list — not by slug, not by `id`, not by `code`. The message names the missing slugs. | Re-fetch with a higher `maxResults`, or add the item back with `isActive: false` if you meant to retire it. |

A renamed toolkit item does **not** trip the completeness guard: its `id` and `code` are unchanged, so the script recognises it, retires the old slug and materializes the new one in the same run.

`--force` waives the completeness guard, for the one legitimate case it cannot otherwise express: an item **hard-deleted** from the Toolkit is absent from every future list, so its mirror could never be cleaned up. Review the reported slugs before reaching for it — `--force` also overwrites local edits.

## Step 4: Report summary

Relay the script's summary line to the user. If `warnings > 0`, list the affected files (the script prints them on stderr-adjacent stdout lines) and ask whether to:

1. **Back-port the local edits to the Toolkit item** (preferred, per KBT-TRUL014).
2. **Re-run with `--force`** to overwrite the local file (discards the manual edits).
3. **Leave it** — the warning persists, but no on-disk state was changed.

## Step 5: Drift-detection algorithm (reference, per KBT-SR310)

For each active toolkit item the script computes:

- `sourceHash` — SHA-256 over the toolkit item's `content` field.
- `targetHash` — SHA-256 over the full rendered file (frontmatter + body).

Then per slug:

| Manifest entry | On-disk file | sourceHash match | Decision |
|---|---|---|---|
| absent | absent | — | **CREATE** |
| absent | present | — | **SKIP** (treat as pre-existing local file; `--force` overwrites) |
| present | absent | — | **RESTORE** |
| present, hash matches | present, hash matches | yes | **UNCHANGED** (no-op) |
| present, hash matches | present, hash matches | no | **UPDATE** |
| present, hash matches | present, hash differs | — | **SKIP-LOCAL-EDIT** (warn; `--force` overwrites) |

Before any of that, the input itself is validated (**KBT-B491** then **KBT-B489**): every active item's category must resolve, and every manifest entry must be mentioned somewhere in the list. Either check failing aborts the run before a single write, exactly as a slug collision does.

For each manifest entry whose slug is no longer in the active toolkit-items list (the item is present but `isActive: false`, or its title changed):

| On-disk file | hash matches manifest | Decision |
|---|---|---|
| absent | — | **DELETE** (manifest entry removed) |
| present | yes | **DELETE** (file + manifest entry removed) |
| present | no | **SKIP-LOCAL-EDIT** (warn; `--force` deletes) |

## When to skip this skill

- Repos that are NOT Kanbantic-managed (no workspace, no Toolkit items).
- Brand-new repo with zero `Skill`/`Command`/`Subagent` Toolkit items in the target workspace — the sync would produce an empty `.claude/`, which is fine but pointless.
- During a CI run where the on-disk mirror is irrelevant.

## References

- **KBT-TRUL014** — Toolkit is source-of-truth; `.claude/` files are derived mirrors. Rationale for this skill's existence.
- **KBT-F264** — Companion feature: `bootstrap_agent` also returns Skill/Command/Subagent arrays so agents can pull metadata without falling back to disk.
- **KBT-PR209 / KBT-SR310 / KBT-BD083** — Acceptance criteria, manifest schema, and filesystem boundary (original v2.5.0 scope).
- **KBT-B250 / KBT-SR320 / KBT-BD086** — Bug + system requirement + boundary that narrowed the materialization scope to `Skill` + `Subagent` only (v2.5.1). Command-items remain Toolkit-only.
- **KBT-US553** — Original user story driving this feature.
- **KBT-US557** — User story for the v2.5.1 scope-narrowing (no slash-command namespace pollution).
- **KBT-TC1933 / 1934 / 1935 / 1936 / 1937 / 1938 / 1939** — Test cases covering fresh-sync, idempotency, update, slug collision, isActive-false removal, local-edit warning, `.gitignore` management.
- **KBT-TC1967 / 1968 / 1969** — Regression tests for the Command-skip behavior (v2.5.1).
- **KBT-B489** — Completeness guard: an item list that does not account for every manifest entry aborts instead of deleting mirrors. Test case **KBT-TC3304**.
- **KBT-B491** — `category` is normalised from both the enum name (MCP) and the enum integer (REST); an unrecognised value aborts instead of being skipped. Test case **KBT-TC3308**. Follows the pattern **KBT-B531** established for `model`.
