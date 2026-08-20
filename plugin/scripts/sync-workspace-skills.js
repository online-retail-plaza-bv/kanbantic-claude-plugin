#!/usr/bin/env node
'use strict';

//
// sync-workspace-skills — KBT-F265 / KBT-PR209 / KBT-SR310 / KBT-BD083
//                       — KBT-B250 / KBT-SR320 / KBT-BD086 (v2.5.1 scope-narrow)
//
// Materializes Kanbantic workspace Toolkit items (Skill + Subagent only)
// as on-disk `.claude/` mirror files, with a `.kanbantic-sync.json` manifest
// for drift detection and idempotency.
//
// Per KBT-TRUL014 the Toolkit is the source-of-truth; the on-disk files are
// derived mirrors that Claude Code's loader actually reads. This script
// keeps the two aligned without manual copy-paste.
//
// `Command` toolkit-items are intentionally NOT materialized (per KBT-BD086):
// they are reference-only shell-snippets, not invocable slash-commands. An
// agent that needs the snippet content calls
// `mcp__kanbantic__list_toolkit_items(category: "Command")` directly.
//
// This module exports `runSync` as a pure function over input data (list of
// toolkit items + target directory) so the test harness can drive it
// deterministically without any MCP-proxy round-trip. The companion SKILL.md
// is what actually invokes `list_toolkit_items` via the MCP plugin and then
// shells out to this script.
//
// Filesystem footprint per KBT-BD083 + KBT-BD086:
//   - <root>/.claude/commands/<slug>.md   (Skill category only)
//   - <root>/.claude/agents/<slug>.md     (Subagent category only)
//   - <root>/.kanbantic-sync.json         (manifest)
//   - <root>/.gitignore                   (append-only, when needed)
//
// Exit codes (CLI mode):
//   0 — sync completed (NEW/UPDATE/UNCHANGED/DELETED summary printed).
//   1 — drift refused (local-edit detected without --force) OR slug-collision.
//   2 — infrastructure (no git repo / unreadable input / fs error) OR a
//       rejected input (unrecognised category / incomplete item list).
//

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the slug for a toolkit-item title.
 *
 * - Take the prefix before the first em-dash (U+2014), if any.
 * - Strip a leading "/".
 * - Lowercase, replace non-[a-z0-9] runs with "-", trim leading/trailing "-".
 *
 * Returns "" for input that cannot be slugified (callers reject empty slugs).
 */
function slugify(title) {
  if (typeof title !== 'string') return '';
  const dashIdx = title.indexOf('—'); // em-dash
  let head = dashIdx >= 0 ? title.slice(0, dashIdx) : title;
  head = head.trim();
  if (head.startsWith('/')) head = head.slice(1);
  head = head.toLowerCase();
  // Replace any run of chars that are not [a-z0-9] with "-".
  head = head.replace(/[^a-z0-9]+/g, '-');
  // Trim leading/trailing dashes.
  head = head.replace(/^-+|-+$/g, '');
  return head;
}

/**
 * Toolkit-item categories, keyed by every input shape a caller can realistically
 * hand us:
 *
 *   - the enum **integer** — what `GET /api/app/toolkit-item` returns;
 *   - the enum **name** — what the MCP `list_toolkit_items` tool returns, in any
 *     casing.
 *
 * KBT-B491: this mirrors what KBT-B531 did for `model`, and for the same reason.
 * Normalising in the renderer rather than at the call-site is deliberate: there
 * is no single caller — every workstation that drives the sync brings its own
 * fetch layer, and each one would otherwise have to rebuild this mapping from
 * scratch. Doing it once, here, protects the callers that exist and the ones
 * still to be written. Before this, raw REST output matched no category at all:
 * every item was skipped and — with a manifest present — the entire mirror set
 * was then reported as deleted.
 *
 * The integer values follow the enum's declaration order as documented on
 * `list_toolkit_items` (ClaudeMd, Skill, Command, Pattern, Gotcha, Rule,
 * Subagent, Custom). Only `1 = Skill` and `6 = Subagent` are field-verified
 * (KBT-B491 cross-validated 12 Subagents against the MCP output), and only
 * those two change behaviour — every other category resolves to "no on-disk
 * target" regardless of which name it carries. The remaining entries exist so a
 * legitimate non-materializable item is *recognised* and skipped quietly rather
 * than tripping the unrecognised-category abort below.
 *
 * `RepoContext` has no integer here on purpose: it is named in this file's
 * original category list but not in the MCP tool's documented enum, so its
 * ordinal is unknown. Keeping the string alias means that if it does exist, an
 * MCP-shaped item carrying it never aborts a sync.
 */
const CATEGORY_ALIASES = {
  0: 'ClaudeMd',
  1: 'Skill',
  2: 'Command',
  3: 'Pattern',
  4: 'Gotcha',
  5: 'Rule',
  6: 'Subagent',
  7: 'Custom',
  claudemd: 'ClaudeMd',
  skill: 'Skill',
  command: 'Command',
  pattern: 'Pattern',
  gotcha: 'Gotcha',
  rule: 'Rule',
  subagent: 'Subagent',
  custom: 'Custom',
  repocontext: 'RepoContext',
};

/**
 * Normalise a toolkit item's category to its canonical enum name.
 *
 * Returns `null` for anything not in CATEGORY_ALIASES — including a missing or
 * empty category. Callers MUST treat that null as an input error rather than as
 * "skip this one": silently skipping unrecognised categories is precisely the
 * failure mode KBT-B491 describes, because the skipped items then look
 * deactivated and their mirrors get deleted.
 *
 * Note the `== null` guard rather than a truthiness test. ClaudeMd is enum `0`,
 * which is falsy in JavaScript — the same trap that cost Opus its model line in
 * KBT-B531. It changes no behaviour here (ClaudeMd has no on-disk target either
 * way), but getting it wrong would turn a recognised category into a hard abort.
 */
function normalizeCategory(raw) {
  if (raw == null || raw === '') return null;
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  return CATEGORY_ALIASES[key] ?? null;
}

/**
 * Decide the on-disk target path for a toolkit item of the given category.
 *
 * - Skill     → .claude/commands/<slug>.md
 * - Subagent  → .claude/agents/<slug>.md
 *
 * Accepts either input shape for `category` (enum name or enum integer) via
 * normalizeCategory — see KBT-B491.
 *
 * Returns null for an unknown or non-materializable category.
 *
 * Command toolkit-items intentionally do NOT materialize to disk: they are
 * reference-only snippets (single shell-command + one-line note), not
 * invocable slash-commands. Materializing them under .claude/commands/ would
 * make Claude Code's command-loader expose them as `/foo`-style commands,
 * which is semantically wrong and pollutes the slash-command namespace.
 * See KBT-B250 + KBT-BD086 for the full rationale.
 *
 * The PRIMARY filter for non-materializable categories lives in buildPlan
 * (which skips them before slug-validation, so a Command item with a bad
 * title can never produce an EMPTY_SLUG error). This function's null-return
 * branch is defense-in-depth — if buildPlan's filter is ever bypassed by a
 * caller, targetPathFor still refuses to assign Command items a target path.
 */
function targetPathFor(category, slug) {
  const canonical = normalizeCategory(category);
  if (canonical === 'Skill') {
    return path.posix.join('.claude', 'commands', `${slug}.md`);
  }
  if (canonical === 'Subagent') {
    return path.posix.join('.claude', 'agents', `${slug}.md`);
  }
  return null;
}

/**
 * Extract a one-line description for the frontmatter from a toolkit item.
 *
 * Strategy: take the first non-empty line of `content` that isn't a Markdown
 * heading (`#` etc.) or a fenced-code-block marker. Truncate at ~250 chars.
 * Falls back to the (em-dash-trimmed) title if no body text is usable.
 */
function deriveDescription(item) {
  const lines = (item && item.content ? String(item.content) : '').split(/\r?\n/);
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; continue; } // toggle fence
    if (inFence) continue;                     // skip body of code blocks
    if (!line) continue;
    if (line.startsWith('#')) continue;        // heading
    if (line.startsWith('---')) continue;      // existing frontmatter delimiter
    // KBT-B495: a `name: <slug>` line at the top of the content is an author
    // trying to declare the subagent's name in the body (the frontmatter is
    // generated around it, so it never worked). Skipping it keeps that attempt
    // out of the description — before this, the very first line of ADM-SKIL003
    // rendered as `description: "name: adminhub-ui-ux"`. Deliberately narrow:
    // the key `name:` followed by a bare slug and nothing else, so a real
    // sentence ("Name: John Doe, the owner") is still a valid description.
    if (/^name:\s*[a-z0-9][a-z0-9-]*$/i.test(line)) continue;
    return truncate(line, 250);
  }
  // Fallback: title minus em-dash prefix or whole title.
  const title = (item && item.title ? String(item.title) : '').trim();
  const dashIdx = title.indexOf('—');
  const head = dashIdx >= 0 ? title.slice(dashIdx + 1).trim() : title;
  return truncate(head || title, 250);
}

function truncate(s, max) {
  if (s.length <= max) return s;
  // Try to break at the last whitespace before max.
  const sliced = s.slice(0, max);
  const cut = sliced.lastIndexOf(' ');
  return (cut > 40 ? sliced.slice(0, cut) : sliced).trimEnd();
}

/**
 * Compute SHA-256 hex over a UTF-8 string.
 */
function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Collapse every line-ending convention to LF.
 *
 * KBT-B543: drift-detection used to hash raw bytes. This script writes LF, but
 * git rewrites those same files to CRLF on checkout whenever `core.autocrlf` is
 * true — the default Git-for-Windows install. The stored `targetHash` (computed
 * over the LF body we wrote) then never matched the bytes read back, so every
 * mirror reported as "locally edited" after any git operation. A measured run
 * showed 17 of 26 entries differing in line endings alone and 0 differing in
 * content.
 *
 * That mattered far beyond the noise: the local-edit warning is the only brake
 * between a sync and overwriting work that is not in the Toolkit yet. Firing it
 * falsely on every Windows run trains the operator to reach for `--force`, and
 * in KBT-B525 one of seventeen dismissed "false positives" was real —
 * `kanbantic-deploy.md` lost 345 lines of runbook inside that noise.
 *
 * Applied to BOTH sides of every comparison, the hash becomes a content
 * comparison instead of a byte comparison and a warning again means what it
 * says. Deliberately narrow: ONLY line terminators are touched. Indentation,
 * trailing spaces and blank lines all still count as content, so a genuinely
 * hand-edited file keeps warning — that is the property KBT-B543's DoD 2 asks
 * to be demonstrated, and KBT-TC3512 covers it with a file that is CRLF-
 * converted and edited at the same time.
 *
 * The lone-CR branch covers classic-Mac endings; they are line terminators by
 * the same argument, and leaving them out would make the normalisation
 * incomplete rather than conservative.
 */
function normalizeEol(s) {
  if (s == null) return '';
  return String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * SHA-256 over content, ignoring line-ending convention (KBT-B543).
 *
 * Every hash that participates in drift-detection goes through here, so the two
 * sides of a comparison can never disagree about normalisation — which is how
 * the original defect arose: `renderFile` normalised the body it wrote while
 * `hashDisk` hashed the bytes it read.
 */
function hashContent(s) {
  return sha256(normalizeEol(s));
}

/**
 * Model aliases Claude Code's loader accepts, keyed by every input shape a
 * caller can realistically hand us:
 *
 *   - the enum **integer** — what `GET /api/app/toolkit-item` returns (0/1/2);
 *   - the enum **name** — what the MCP `list_toolkit_items` tool returns
 *     ("Opus"/"Sonnet"/"Haiku"), in any casing.
 *
 * KBT-B531: normalising here rather than at the call-site is deliberate. There
 * is no single caller — every workstation that drives the sync brings its own
 * fetch layer, and each one would otherwise have to rebuild this mapping from
 * scratch. Doing it once, in the renderer, protects the callers that exist and
 * the ones still to be written.
 */
const MODEL_ALIASES = {
  0: 'opus',
  1: 'sonnet',
  2: 'haiku',
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

/**
 * Normalise a toolkit item's model preference to a valid Claude Code alias.
 *
 * Returns `''` for "no preference" and for any value not in MODEL_ALIASES.
 * Emitting nothing is the safer failure mode: a missing `model:` line makes the
 * loader fall back to the session model, whereas an unrecognised value is a
 * frontmatter parse error.
 *
 * Note the `== null` guard rather than a truthiness test — Opus is enum `0`,
 * which is falsy in JavaScript. That single detail is what made every Opus
 * subagent silently lose its model line (KBT-B531).
 */
function normalizeModel(raw) {
  if (raw == null || raw === '') return '';
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  return MODEL_ALIASES[key] ?? '';
}

/**
 * Render the on-disk file body for a toolkit item.
 *
 * Adds a YAML frontmatter block:
 *
 *   ---
 *   name: <slug>              (Subagent items only — KBT-B495)
 *   description: "<one line>"
 *   source: "<KBT-XXXNNN>"
 *   ---
 *
 * Followed by the raw toolkit-item content. The `source` field is purely
 * informational (lets a human see which toolkit item produced this file)
 * but is NOT used by Claude Code's loader.
 *
 * KBT-B495: `name` is what Claude Code's loader uses to register a SUBAGENT —
 * it does NOT derive a subagent's name from the filename. Without this line the
 * mirror under .claude/agents/ is written correctly but loads as nothing, and
 * calling it fails with `Agent type '<slug>' not found.`. Skills/commands DO
 * take their name from the filename, which is why the .claude/commands/ mirror
 * always worked and only the agents mirror was silently dead. Commands get no
 * `name:` line — it is unused there and only pollutes the frontmatter.
 *
 * The value is the same slug that determines the file path, so name and
 * filename agree by construction and the existing slug-collision check in
 * buildPlan doubles as an agent-name uniqueness check. `item.slug` is set by
 * buildPlan; the slugify() fallback keeps direct renderFile() calls (unit
 * tests, future callers) on the same value.
 *
 * Note: description is double-quoted; any `"` or `\` inside is escaped.
 */
function renderFile(item) {
  const description = deriveDescription(item) || 'Toolkit item';
  const escDesc = description.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const source = item.code || item.sourceCode || '';
  const sourceLine = source ? `source: "${source}"\n` : '';
  // KBT-B495: subagent identity — see the block comment above.
  const slug = item.slug || slugify(item.title || '');
  const nameLine = item.category === 'Subagent' && slug ? `name: ${slug}\n` : '';
  // KBT-F437: emit a `model:` frontmatter line when the toolkit item carries a
  // model preference. KBT-B531: the value is normalised via normalizeModel,
  // which accepts both the enum name (MCP) and the enum integer (REST), and
  // treats Opus's `0` as a real value instead of as "absent". An unrecognised
  // value yields no line — see the normalizeModel doc-comment for why.
  // MCP `ListToolkitItems` may surface the field as either `model` or `Model`;
  // `??` keeps a legitimate `0` from falling through to the other casing.
  const model = normalizeModel(item.model ?? item.Model);
  const modelLine = model ? `model: ${model}\n` : '';
  // KBT-B543: normalizeEol also folds lone CRs, which the old inline
  // `.replace(/\r\n/g, '\n')` left behind.
  const body = normalizeEol(item.content || '');
  // Ensure exactly one trailing newline.
  const trimmed = body.endsWith('\n') ? body : body + '\n';
  return `---\n${nameLine}description: "${escDesc}"\n${sourceLine}${modelLine}---\n\n${trimmed}`;
}

/**
 * Build the in-memory plan from inputs + previous manifest.
 *
 * Returns an object:
 *   {
 *     plan: [{ op, slug, category, sourceId, sourceCode, sourceHash,
 *              targetPath, body, prevTargetHash, reason }],
 *     collisions: [{ slug, items: [{code, title, category}] }],
 *     localEdits: [{ slug, targetPath, expectedHash, actualHash }],
 *     unknownCategories: [{ code, title, category, type }],
 *     missingFromInput: [{ slug, category, sourceCode, targetPath }],
 *   }
 *
 * `op` is one of: 'create', 'update', 'unchanged', 'delete', 'restore',
 * 'skip-local-edit', 'force-overwrite', 'force-delete'.
 *
 * `unknownCategories` and `missingFromInput` are the two input-validation
 * rejections (KBT-B491 / KBT-B489). When either is non-empty the returned plan
 * is deliberately EMPTY: runSync turns them into a SyncError, so the caller
 * aborts before applyPlan touches a single file — the same shape the existing
 * slug-collision check already uses.
 *
 * Pure function over `{ items, prevManifest, diskHashes, options }`.
 */
function buildPlan({ items, prevManifest, diskHashes, options }) {
  const force = !!(options && options.force);
  const prune = !!(options && options.prune);
  const prevEntries = prevManifest && Array.isArray(prevManifest.items) ? prevManifest.items : [];

  // -------- 0. Category validation on ACTIVE items (KBT-B491) --------------
  // Runs before everything else: if we cannot tell what an item IS, no other
  // conclusion drawn from the list can be trusted either. An unrecognised
  // category used to be indistinguishable from "not a mirror category", so raw
  // REST output (integer enums) skipped every item and then deleted every
  // mirror. Note this checks ACTIVE items only — a deactivated item is on its
  // way out regardless of how its category is spelled.
  //
  // KBT-TC3308: a partially recognised list aborts just as hard as a fully
  // unrecognised one. Since normalizeCategory now accepts both the enum name
  // and the enum integer, a list mixing the two shapes is fully recognised and
  // syncs normally — "mixed" only aborts when something is left over that we
  // genuinely cannot place.
  const unknownCategories = [];
  for (const item of items) {
    if (!item || item.isActive === false) continue;
    if (normalizeCategory(item.category) !== null) continue;
    unknownCategories.push({
      code: item.code || '<no-code>',
      title: item.title || '',
      category: item.category,
      type: item.category === null ? 'null' : typeof item.category,
    });
  }
  if (unknownCategories.length > 0) {
    return { plan: [], collisions: [], localEdits: [], unknownCategories, missingFromInput: [] };
  }

  // -------- 1. Slug computation + collision check on ACTIVE items ----------
  const slugged = [];
  const bySlug = new Map();
  for (const item of items) {
    if (!item || item.isActive === false) continue;
    // KBT-B250: skip categories that don't materialize to disk (e.g. Command —
    // reference-only snippets per KBT-BD086, plus ClaudeMd/Pattern/Gotcha/Rule/
    // Custom which have no on-disk target). This filter runs BEFORE
    // slug-validation so a non-materializable item with an empty-slug title
    // cannot produce a spurious EMPTY_SLUG error.
    // KBT-B491: compare against the NORMALISED category so an integer-shaped
    // `category` routes the same as its enum name.
    const category = normalizeCategory(item.category);
    if (category !== 'Skill' && category !== 'Subagent') continue;
    const slug = slugify(item.title || '');
    if (!slug) {
      throw new SyncError(
        'EMPTY_SLUG',
        `Toolkit item ${item.code || '<no-code>'} title "${item.title}" produced an empty slug. Rename the toolkit item or set isActive: false.`
      );
    }
    const target = targetPathFor(category, slug);
    if (!target) continue; // ignore unrelated categories (defense-in-depth — buildPlan filter above is primary)
    const entry = {
      // KBT-B491: the CANONICAL category travels onward, so renderFile's
      // `category === 'Subagent'` check and the manifest both see the enum name
      // whichever shape the caller supplied.
      slug, category,
      sourceId: item.id || '',
      sourceCode: item.code || '',
      title: item.title || '',
      content: item.content || '',
      // KBT-F437: carry the model preference so renderFile can emit a `model:`
      // frontmatter line. MCP may surface it as `model` or `Model`.
      // KBT-B531: normalise here too, not only in renderFile. The plan layer
      // sits between the caller and the renderer, so an `||` chain at this
      // point flattens Opus's enum `0` to `''` before renderFile ever sees it —
      // which is exactly why the unit tests on renderFile passed while the
      // files on disk were still missing their model line. Normalising here
      // also means `entry.model` is the alias the source-hash below folds in,
      // so re-serialising the same model in a different shape (enum `1` vs
      // "Sonnet") no longer registers as a spurious UPDATE.
      model: normalizeModel(item.model ?? item.Model),
      targetPath: target,
    };
    slugged.push(entry);
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(entry);
  }
  const collisions = [];
  for (const [slug, group] of bySlug.entries()) {
    if (group.length > 1) {
      collisions.push({
        slug,
        items: group.map(g => ({ code: g.sourceCode, title: g.title, category: g.category })),
      });
    }
  }
  if (collisions.length > 0) {
    return { plan: [], collisions, localEdits: [], unknownCategories: [], missingFromInput: [] };
  }

  // -------- 1b. Completeness guard on the input list (KBT-B489) ------------
  // Step 3 below turns every manifest entry whose slug is absent from the input
  // into a `delete`. That is correct for an item the user deactivated, and
  // catastrophic for an item the caller merely forgot to fetch — and the two are
  // indistinguishable once you only look at the ACTIVE items. The input is
  // assembled by an agent from separate `list_toolkit_items` calls that honour
  // `maxResults`, so a short list is a routine accident, not an exotic one: a
  // real near-miss returned 200 of 224 items and would have deleted two live
  // subagent mirrors, reported as a plain `deleted=2`.
  //
  // The distinction we can make is this: a deactivation still SHOWS UP in the
  // input (carrying `isActive: false`), whereas an item that was never fetched
  // is absent entirely. So a manifest entry is accounted for when the input
  // mentions it at all — by slug, by source id, or by source code, active or
  // not. Matching on id/code as well as slug keeps a renamed toolkit item (new
  // title ⇒ new slug) from reading as a disappearance.
  //
  // `--prune` bypasses this, because an item HARD-deleted from the Toolkit is
  // genuinely absent from every future input and its mirror must still be able
  // to go away.
  //
  // KBT-B654 — this used to hang off `--force`, which the SessionStart hook
  // passes on every run to overwrite local edits. One partial fetch (17 Skills,
  // 0 Subagents, no error) was then enough to delete all nine Subagent mirrors
  // and strip them from the manifest. Overwriting a local edit and accepting an
  // incomplete input are different authorities; only the first belongs to a
  // hook that runs unattended.
  const missingFromInput = [];
  if (!prune && prevEntries.length > 0) {
    const inputSlugs = new Set();
    const inputIds = new Set();
    const inputCodes = new Set();
    for (const item of items) {
      if (!item) continue;
      const s = slugify(item.title || '');
      if (s) inputSlugs.add(s);
      if (item.id) inputIds.add(String(item.id));
      if (item.code) inputCodes.add(String(item.code));
    }
    for (const prev of prevEntries) {
      if (inputSlugs.has(prev.slug)) continue;
      if (prev.sourceId && inputIds.has(String(prev.sourceId))) continue;
      if (prev.sourceCode && inputCodes.has(String(prev.sourceCode))) continue;
      missingFromInput.push({
        slug: prev.slug,
        category: prev.category,
        sourceCode: prev.sourceCode || '',
        targetPath: prev.targetPath,
      });
    }
  }
  if (missingFromInput.length > 0) {
    return { plan: [], collisions: [], localEdits: [], unknownCategories: [], missingFromInput };
  }

  // -------- 2. Build plan entries for each active item ---------------------
  const prevByEntrySlug = new Map(prevEntries.map(e => [e.slug, e]));
  const plan = [];
  const localEdits = [];
  const seenSlugs = new Set();

  for (const entry of slugged) {
    seenSlugs.add(entry.slug);
    const body = renderFile(entry);
    // KBT-B543: hashContent on both sides — this one is already LF (renderFile
    // normalises), but routing it through the same helper as hashDisk is what
    // guarantees the two can never drift apart again.
    const newTargetHash = hashContent(body);
    // KBT-F437: fold the model into the source-hash so a model-only change
    // (same content, different model) registers as an UPDATE, not UNCHANGED.
    // KBT-B543: normalise the Toolkit content too. The issue calls this out
    // explicitly — without it the problem just moves to the source side, where
    // the same item delivered with CRLF instead of LF would fake an UPDATE.
    //
    // Note the shape is unchanged from before (one hash over
    // `content + ' ' + model`), only wrapped in the normaliser. That is
    // deliberate: for the LF content this script has always produced,
    // normalizeEol is the identity, so every sourceHash already in a manifest
    // stays valid and upgrading does not churn every entry into a spurious
    // UPDATE on the first run.
    const newSourceHash = hashContent(entry.content + ' ' + (entry.model || ''));
    const prev = prevByEntrySlug.get(entry.slug);
    const onDisk = diskHashes[entry.targetPath];

    if (!prev) {
      // NEW (no previous record)
      if (onDisk !== undefined && onDisk !== newTargetHash) {
        // File exists on disk but no manifest entry — could be a pre-existing
        // user file. Treat as a local edit unless --force.
        if (!force) {
          localEdits.push({
            slug: entry.slug,
            targetPath: entry.targetPath,
            expectedHash: '(no previous manifest entry)',
            actualHash: onDisk,
          });
          plan.push({ op: 'skip-local-edit', ...entry, body, sourceHash: newSourceHash, targetHash: newTargetHash, reason: 'pre-existing on-disk file with no manifest entry' });
          continue;
        }
        plan.push({ op: 'force-overwrite', ...entry, body, sourceHash: newSourceHash, targetHash: newTargetHash });
        continue;
      }
      plan.push({ op: 'create', ...entry, body, sourceHash: newSourceHash, targetHash: newTargetHash });
      continue;
    }

    // prev exists
    if (onDisk === undefined) {
      // Manifest knew about this file but it is gone — RESTORE.
      plan.push({ op: 'restore', ...entry, body, sourceHash: newSourceHash, targetHash: newTargetHash });
      continue;
    }
    if (onDisk !== prev.targetHash) {
      // Local edit since last sync.
      if (!force) {
        localEdits.push({
          slug: entry.slug,
          targetPath: entry.targetPath,
          expectedHash: prev.targetHash,
          actualHash: onDisk,
        });
        plan.push({ op: 'skip-local-edit', ...entry, body, sourceHash: newSourceHash, targetHash: newTargetHash, reason: 'on-disk hash differs from manifest targetHash' });
        continue;
      }
      plan.push({ op: 'force-overwrite', ...entry, body, sourceHash: newSourceHash, targetHash: newTargetHash });
      continue;
    }
    // on-disk hash matches manifest targetHash.
    if (prev.sourceHash === newSourceHash && prev.targetHash === newTargetHash) {
      plan.push({ op: 'unchanged', ...entry, body, sourceHash: newSourceHash, targetHash: newTargetHash, prevTargetHash: prev.targetHash });
      continue;
    }
    plan.push({ op: 'update', ...entry, body, sourceHash: newSourceHash, targetHash: newTargetHash, prevTargetHash: prev.targetHash });
  }

  // -------- 3. Handle deletions (manifest entries no longer active) --------
  for (const prev of prevEntries) {
    if (seenSlugs.has(prev.slug)) continue;
    const onDisk = diskHashes[prev.targetPath];
    if (onDisk === undefined) {
      // File already gone — record clean delete (manifest cleanup only).
      plan.push({
        op: 'delete', slug: prev.slug, category: prev.category,
        sourceId: prev.sourceId, sourceCode: prev.sourceCode,
        targetPath: prev.targetPath, sourceHash: prev.sourceHash || '',
        targetHash: prev.targetHash || '',
      });
      continue;
    }
    if (onDisk !== prev.targetHash) {
      if (!force) {
        localEdits.push({
          slug: prev.slug,
          targetPath: prev.targetPath,
          expectedHash: prev.targetHash,
          actualHash: onDisk,
        });
        plan.push({
          op: 'skip-local-edit', slug: prev.slug, category: prev.category,
          sourceId: prev.sourceId, sourceCode: prev.sourceCode,
          targetPath: prev.targetPath, sourceHash: prev.sourceHash || '',
          targetHash: prev.targetHash || '',
          reason: 'item deactivated but on-disk file has local edits',
        });
        continue;
      }
      plan.push({
        op: 'force-delete', slug: prev.slug, category: prev.category,
        sourceId: prev.sourceId, sourceCode: prev.sourceCode,
        targetPath: prev.targetPath, sourceHash: prev.sourceHash || '',
        targetHash: prev.targetHash || '',
      });
      continue;
    }
    plan.push({
      op: 'delete', slug: prev.slug, category: prev.category,
      sourceId: prev.sourceId, sourceCode: prev.sourceCode,
      targetPath: prev.targetPath, sourceHash: prev.sourceHash || '',
      targetHash: prev.targetHash || '',
    });
  }

  return { plan, collisions: [], localEdits, unknownCategories: [], missingFromInput: [] };
}

/**
 * Custom error class so callers (and tests) can introspect structured fields.
 */
class SyncError extends Error {
  constructor(kind, message, data) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
    this.data = data || {};
  }
}

/**
 * Read existing manifest from disk, or return an empty one.
 */
function readManifest(rootDir) {
  const file = path.join(rootDir, '.kanbantic-sync.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new SyncError('MANIFEST_UNREADABLE', `Cannot read ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new SyncError('MANIFEST_MALFORMED', `Manifest at ${file} is not valid JSON: ${e.message}`);
  }
}

/**
 * Hash every file currently in the two target directories.
 */
function hashDisk(rootDir) {
  const out = {};
  for (const sub of ['.claude/commands', '.claude/agents']) {
    const dir = path.join(rootDir, sub);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw new SyncError('DISK_UNREADABLE', `Cannot read ${dir}: ${e.message}`);
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith('.md')) continue;
      const rel = path.posix.join(sub, ent.name);
      const abs = path.join(rootDir, sub, ent.name);
      const buf = fs.readFileSync(abs, 'utf8');
      // KBT-B543: hash the CONTENT, not the bytes. Git's autocrlf filter
      // rewrites these files to CRLF on checkout; without this the on-disk hash
      // never matches the LF-based targetHash we wrote, and every mirror
      // reports as a local edit.
      out[rel] = hashContent(buf);
    }
  }
  return out;
}

/**
 * Apply a plan to disk: write/delete files, update manifest, ensure .gitignore.
 *
 * Returns a summary `{ created, updated, unchanged, deleted, warnings, forced, entries, warningsList }`.
 */
function applyPlan({ rootDir, plan, localEdits, prevManifest, workspace, options }) {
  const force = !!(options && options.force);
  let created = 0, updated = 0, unchanged = 0, deleted = 0, forced = 0;
  const warningsList = [];

  // Build new manifest entries.
  const entries = [];
  const now = (options && options.now) || new Date().toISOString();

  // Index previous manifest entries by slug so we can preserve `syncedAt` when
  // nothing actually changed.
  const prevBySlug = new Map(
    (prevManifest && Array.isArray(prevManifest.items) ? prevManifest.items : [])
      .map(e => [e.slug, e])
  );

  for (const step of plan) {
    switch (step.op) {
      case 'create':
      case 'restore':
      case 'force-overwrite':
      case 'update': {
        writeFileSafe(path.join(rootDir, step.targetPath), step.body);
        if (step.op === 'create' || step.op === 'restore') created++;
        else if (step.op === 'force-overwrite') { forced++; updated++; }
        else updated++;
        entries.push(manifestEntry(step, now));
        break;
      }
      case 'unchanged': {
        unchanged++;
        const prev = prevBySlug.get(step.slug);
        // Preserve original `syncedAt` so idempotent re-runs don't gratuitously
        // bump timestamps — the manifest-file `lastSyncedAt` already records
        // the run-time.
        entries.push(manifestEntry(step, prev ? (prev.syncedAt || now) : now));
        break;
      }
      case 'delete':
      case 'force-delete': {
        const abs = path.join(rootDir, step.targetPath);
        try {
          fs.unlinkSync(abs);
          deleted++;
          if (step.op === 'force-delete') forced++;
        } catch (e) {
          if (e.code !== 'ENOENT') throw new SyncError('DELETE_FAILED', `Cannot remove ${abs}: ${e.message}`);
          deleted++;
        }
        // Manifest entry removed (do NOT push into `entries`).
        break;
      }
      case 'skip-local-edit': {
        warningsList.push({
          slug: step.slug,
          targetPath: step.targetPath,
          reason: step.reason || 'local edit detected',
        });
        // Preserve the previous manifest entry unchanged so we don't lose
        // track of the source-of-truth mapping while warning the user.
        const prev = prevBySlug.get(step.slug);
        if (prev) entries.push(prev);
        break;
      }
      default:
        throw new SyncError('UNKNOWN_OP', `Unknown plan op: ${step.op}`);
    }
  }

  // Write manifest.
  const manifest = {
    version: 1,
    workspace: workspace || (prevManifest && prevManifest.workspace) || '',
    lastSyncedAt: now,
    items: entries.sort((a, b) => a.slug.localeCompare(b.slug)),
  };
  writeFileSafe(path.join(rootDir, '.kanbantic-sync.json'),
    JSON.stringify(manifest, null, 2) + '\n');

  // Update .gitignore.
  ensureGitignore(rootDir);

  return {
    created, updated, unchanged, deleted, forced,
    warnings: warningsList.length,
    warningsList,
    localEdits,
    manifest,
    forceUsed: force,
  };
}

function manifestEntry(step, syncedAt) {
  return {
    slug: step.slug,
    category: step.category,
    sourceId: step.sourceId || '',
    sourceCode: step.sourceCode || '',
    sourceHash: step.sourceHash,
    targetPath: step.targetPath,
    targetHash: step.targetHash,
    syncedAt,
  };
}

function writeFileSafe(absPath, body) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, body, 'utf8');
}

/**
 * The patterns this script keeps ignored, each with a representative path used
 * to ask git whether the pattern's subject is ALREADY covered (KBT-B540).
 *
 * The probe filenames need not exist — `git check-ignore` answers from the
 * ignore rules alone, purely on the path string.
 */
const GITIGNORE_PATTERNS = [
  { pattern: '.claude/commands/', probe: '.claude/commands/kanbantic-probe.md' },
  { pattern: '.claude/agents/', probe: '.claude/agents/kanbantic-probe.md' },
  { pattern: '.kanbantic-sync.json', probe: '.kanbantic-sync.json' },
];

/**
 * Ask git whether `probePath` is already ignored inside `rootDir`.
 *
 * Returns true (ignored), false (not ignored), or null when git could not
 * answer — no git on PATH, or `rootDir` is not a real working tree. Callers
 * must treat null as "no opinion" and fall back to the literal check.
 *
 * `--no-index` is deliberate: the question is whether the ignore RULES cover
 * this path, not whether the path happens to be tracked today. Without it a
 * tracked `.kanbantic-sync.json` would report as "not ignored" and we would
 * append a pattern that cannot untrack it anyway.
 */
function gitIgnoresPath(rootDir, probePath) {
  let r;
  try {
    r = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', probePath], {
      cwd: rootDir,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (_) {
    return null;
  }
  if (!r || r.error) return null;
  if (r.status === 0) return true;   // ignored
  if (r.status === 1) return false;  // not ignored
  return null;                       // 128 (not a repo) or anything else
}

/**
 * Ensure `.claude/commands/`, `.claude/agents/` and `.kanbantic-sync.json` are
 * ignored. Creates the file if missing; appends only what is genuinely missing.
 *
 * KBT-B540: "missing" is a COVERAGE question, not a string-membership one. The
 * original check was `want.filter(p => !trimmed.includes(p))`, so a repo with a
 * blanket `.claude/` rule — which already ignores both mirror directories — did
 * not contain the literal strings and got the block appended again. `.gitignore`
 * is tracked, so every fresh clone that synced for the first time produced that
 * diff in whatever branch happened to be checked out.
 *
 * Delegating to `git check-ignore` uses git's own matching, which means blanket
 * rules, negations, nested `.gitignore` files and `.git/info/exclude` are all
 * handled for free — none of which a hand-rolled matcher would get right without
 * reimplementing gitignore semantics (ordering, negation, directory-only,
 * globstar).
 *
 * When git cannot answer we fall back to the original literal check, so the
 * behaviour outside a working tree is exactly what it was before.
 */
function ensureGitignore(rootDir) {
  const file = path.join(rootDir, '.gitignore');
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new SyncError('GITIGNORE_UNREADABLE', `Cannot read ${file}: ${e.message}`);
  }
  // Split into lines, ignoring leading/trailing whitespace per line.
  const lines = existing.split(/\r?\n/);
  const trimmed = lines.map(l => l.trim());
  const toAdd = [];
  for (const { pattern, probe } of GITIGNORE_PATTERNS) {
    // Literal hit first: cheap, and it guarantees we never duplicate a line we
    // can already see — whatever git thinks of it.
    if (trimmed.includes(pattern)) continue;
    // KBT-B540: not written literally, but possibly already covered.
    if (gitIgnoresPath(rootDir, probe) === true) continue;
    toAdd.push(pattern);
  }
  if (toAdd.length === 0) return;
  let next = existing;
  if (next.length > 0 && !next.endsWith('\n')) next += '\n';
  if (next.length > 0 && !next.endsWith('\n\n')) {
    // Add a separator comment when appending to a non-empty .gitignore.
    next += '\n# Kanbantic sync mirrors (KBT-F265)\n';
  } else {
    next += '# Kanbantic sync mirrors (KBT-F265)\n';
  }
  for (const p of toAdd) next += `${p}\n`;
  fs.writeFileSync(file, next, 'utf8');
}

/**
 * Top-level entrypoint. Pure-ish: callers pass the toolkit items and we do
 * the rest. Returns the summary object.
 *
 * Options:
 *   - rootDir       (required) absolute path to the repo root / worktree
 *   - items         (required) array of toolkit-item objects as returned by
 *                              `list_toolkit_items` (Skill + Command + Subagent)
 *   - workspace     (optional) workspace slug to record in the manifest
 *   - force         (optional, default false) overwrite local edits
 *   - prune         (optional, default false) accept an input that does not
 *                              account for every manifest entry, and delete the
 *                              unaccounted-for mirrors (KBT-B654 keeps this
 *                              separate from `force` on purpose)
 *   - now           (optional) ISO timestamp to record as `lastSyncedAt`
 *   - skipGitignore (optional, default false) don't touch .gitignore
 */
function runSync({ rootDir, items, workspace, force, prune, now, skipGitignore }) {
  if (!rootDir || typeof rootDir !== 'string') {
    throw new SyncError('BAD_ARG', 'runSync requires rootDir (absolute path).');
  }
  if (!Array.isArray(items)) {
    throw new SyncError('BAD_ARG', 'runSync requires items (array of toolkit items).');
  }
  if (!fs.existsSync(rootDir)) {
    throw new SyncError('BAD_ROOT', `rootDir does not exist: ${rootDir}`);
  }

  const prevManifest = readManifest(rootDir);
  const diskHashes = hashDisk(rootDir);
  const { plan, collisions, localEdits, unknownCategories, missingFromInput } = buildPlan({
    items, prevManifest, diskHashes, options: { force: !!force, prune: !!prune },
  });

  // KBT-B491 — unrecognised category on an active item. Checked first: it is the
  // most likely CAUSE of a list that also looks incomplete, so reporting it
  // first points at the real problem instead of a symptom.
  if (unknownCategories && unknownCategories.length > 0) {
    const detail = unknownCategories.slice(0, 5).map(u =>
      `  ${u.code}: category ${JSON.stringify(u.category)} (${u.type}) — "${u.title}"`
    ).join('\n');
    const more = unknownCategories.length > 5
      ? `\n  ...and ${unknownCategories.length - 5} more.` : '';
    throw new SyncError(
      'UNKNOWN_CATEGORY',
      `${unknownCategories.length} active toolkit item(s) carry a category this script does not recognise. ` +
      `Nothing was written. Accepted shapes are the enum name ("Skill", "Subagent", ...) and the enum integer ` +
      `(1 = Skill, 6 = Subagent). Got:\n${detail}${more}`,
      { unknownCategories }
    );
  }

  // KBT-B489 — the input does not account for every manifest entry.
  if (missingFromInput && missingFromInput.length > 0) {
    const detail = missingFromInput.slice(0, 10).map(m =>
      `  ${m.slug} (${m.category}${m.sourceCode ? `, ${m.sourceCode}` : ''}) → ${m.targetPath}`
    ).join('\n');
    const more = missingFromInput.length > 10
      ? `\n  ...and ${missingFromInput.length - 10} more.` : '';
    throw new SyncError(
      'INCOMPLETE_INPUT',
      `${missingFromInput.length} manifest entr${missingFromInput.length === 1 ? 'y is' : 'ies are'} ` +
      `not mentioned anywhere in the supplied item list. Nothing was written. This usually means the list is ` +
      `truncated — check that every list_toolkit_items call returned all of totalCount, and that the Skill and ` +
      `Subagent categories were both fetched. A deactivated item must still be PRESENT in the list (with ` +
      `isActive: false) to be removed. Re-run with --prune if these items were genuinely deleted from the ` +
      `Toolkit — deliberately, and not from an unattended hook.\n${detail}${more}`,
      { missingFromInput }
    );
  }

  if (collisions.length > 0) {
    const detail = collisions.map(c => {
      const codes = c.items.map(i => `${i.code || '<no-code>'} (${i.category}, "${i.title}")`).join(' AND ');
      return `  slug "${c.slug}": ${codes}`;
    }).join('\n');
    throw new SyncError(
      'SLUG_COLLISION',
      `Two or more active toolkit items resolve to the same slug. Rename one or set isActive: false.\n${detail}`,
      { collisions }
    );
  }

  const summary = applyPlan({
    rootDir, plan, localEdits, prevManifest,
    workspace, options: { force: !!force, now, skipGitignore: !!skipGitignore },
  });

  // applyPlan already wrote .gitignore unconditionally. Honour skipGitignore
  // by rewriting it back if requested (mostly for tests).
  if (skipGitignore) {
    // No-op; we just don't enforce it post-hoc. The test harness can
    // pre-create a .gitignore it wants preserved.
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI mode
// ---------------------------------------------------------------------------

function cliMain(argv) {
  // Parse minimal CLI flags. The skill orchestrator typically pipes the
  // toolkit-items JSON via stdin to keep the contract simple, but we also
  // support reading from a file via --input <path>.
  const args = argv.slice(2);
  let force = false;
  let prune = false;
  let inputPath = null;
  let workspace = '';
  let rootDir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') { force = true; continue; }
    if (a === '--prune') { prune = true; continue; }
    if (a === '--input' && i + 1 < args.length) { inputPath = args[++i]; continue; }
    if (a === '--workspace' && i + 1 < args.length) { workspace = args[++i]; continue; }
    if (a === '--root' && i + 1 < args.length) { rootDir = args[++i]; continue; }
    if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    process.stderr.write(`sync-workspace-skills: unknown flag: ${a}\n`);
    process.exit(2);
  }

  // Verify rootDir is a git working tree.
  if (!isGitRoot(rootDir)) {
    process.stderr.write(
      `sync-workspace-skills: not a git working tree: ${rootDir}\n` +
      `Run this script from a repo root or pass --root <path>.\n`
    );
    process.exit(2);
  }

  let raw;
  try {
    raw = inputPath
      ? fs.readFileSync(inputPath, 'utf8')
      : fs.readFileSync(0, 'utf8'); // stdin
  } catch (e) {
    process.stderr.write(`sync-workspace-skills: cannot read input: ${e.message}\n`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`sync-workspace-skills: input is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }
  const items = Array.isArray(parsed) ? parsed
    : (Array.isArray(parsed.items) ? parsed.items : null);
  if (!items) {
    process.stderr.write(`sync-workspace-skills: expected an array of items (or {items: [...]})\n`);
    process.exit(2);
  }

  let summary;
  try {
    summary = runSync({ rootDir, items, workspace, force, prune });
  } catch (e) {
    if (e instanceof SyncError) {
      process.stderr.write(`sync-workspace-skills: ${e.kind}: ${e.message}\n`);
      process.exit(e.kind === 'SLUG_COLLISION' ? 1 : 2);
    }
    throw e;
  }

  // Print human-friendly summary.
  process.stdout.write(formatSummary(summary) + '\n');
  // Exit 1 if there were unforced local-edit warnings (so CI / scripts notice).
  process.exit(summary.warnings > 0 && !force ? 1 : 0);
}

function isGitRoot(dir) {
  // Accept either a regular .git dir OR a .git file (worktree pointer).
  let cur = path.resolve(dir);
  while (true) {
    const probe = path.join(cur, '.git');
    if (fs.existsSync(probe)) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function formatSummary(s) {
  const lines = [];
  lines.push(`sync-workspace-skills: created=${s.created} updated=${s.updated} unchanged=${s.unchanged} deleted=${s.deleted} warnings=${s.warnings} forced=${s.forced}`);
  if (s.warningsList && s.warningsList.length > 0) {
    lines.push('Warnings (local edits preserved — re-run with --force to overwrite):');
    for (const w of s.warningsList) {
      lines.push(`  - ${w.targetPath}: ${w.reason}`);
    }
  }
  return lines.join('\n');
}

const USAGE = [
  'sync-workspace-skills [--input <path>] [--root <path>] [--workspace <slug>] [--force] [--prune]',
  '',
  'Reads a JSON array of toolkit items from stdin (or --input <path>) and',
  'materializes them under .claude/commands/ and .claude/agents/ at the repo',
  'root (or --root <path>). Writes a .kanbantic-sync.json manifest, ensures',
  '.gitignore lists the mirror paths, and detects drift on subsequent runs.',
  '',
  'The item list must be COMPLETE: every entry in an existing manifest has to be',
  'mentioned in it. A deactivated item stays in the list with isActive: false —',
  'omitting it entirely is treated as a truncated fetch and aborts (KBT-B489).',
  '',
  '`category` is accepted as the enum name ("Skill", "Subagent") or as the enum',
  'integer (1 = Skill, 6 = Subagent); an unrecognised value aborts (KBT-B491).',
  '',
  'Pass --force to overwrite local edits (warning preserved in summary).',
  '',
  'Pass --prune to waive the completeness guard, for items hard-deleted from the',
  'Toolkit. This is a separate flag from --force on purpose (KBT-B654): the',
  'SessionStart hook passes --force unattended on every run, and one partial',
  'fetch was enough to delete every Subagent mirror while it did.',
  '',
  'Exit codes:',
  '  0 — sync completed without warnings.',
  '  1 — warnings preserved (local edit), or slug collision detected.',
  '  2 — infrastructure error (not a git repo, unreadable input, etc.), or a',
  '      rejected input (unrecognised category / incomplete item list).',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  slugify,
  targetPathFor,
  deriveDescription,
  sha256,
  normalizeEol,
  hashContent,
  normalizeModel,
  normalizeCategory,
  gitIgnoresPath,
  renderFile,
  buildPlan,
  applyPlan,
  readManifest,
  hashDisk,
  ensureGitignore,
  runSync,
  isGitRoot,
  formatSummary,
  SyncError,
};

if (require.main === module) {
  cliMain(process.argv);
}
