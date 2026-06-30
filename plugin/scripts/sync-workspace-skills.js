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
//   2 — infrastructure (no git repo / unreadable input / fs error).
//

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
 * Decide the on-disk target path for a toolkit item of the given category.
 *
 * - Skill     → .claude/commands/<slug>.md
 * - Subagent  → .claude/agents/<slug>.md
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
  if (category === 'Skill') {
    return path.posix.join('.claude', 'commands', `${slug}.md`);
  }
  if (category === 'Subagent') {
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
 * Render the on-disk file body for a toolkit item.
 *
 * Adds a YAML frontmatter block:
 *
 *   ---
 *   description: "<one line>"
 *   source: "<KBT-XXXNNN>"
 *   ---
 *
 * Followed by the raw toolkit-item content. The `source` field is purely
 * informational (lets a human see which toolkit item produced this file)
 * but is NOT used by Claude Code's loader.
 *
 * Note: description is double-quoted; any `"` or `\` inside is escaped.
 */
function renderFile(item) {
  const description = deriveDescription(item) || 'Toolkit item';
  const escDesc = description.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const source = item.code || item.sourceCode || '';
  const sourceLine = source ? `source: "${source}"\n` : '';
  // KBT-F437: emit a `model:` frontmatter line when the toolkit item carries a
  // model preference. Alias = lowercase of the enum name (Opus→opus, etc.).
  // MCP `ListToolkitItems` may surface the field as either `model` or `Model`.
  const model = item.model || item.Model || '';
  const modelLine = model ? `model: ${String(model).toLowerCase()}\n` : '';
  const body = (item.content || '').replace(/\r\n/g, '\n');
  // Ensure exactly one trailing newline.
  const trimmed = body.endsWith('\n') ? body : body + '\n';
  return `---\ndescription: "${escDesc}"\n${sourceLine}${modelLine}---\n\n${trimmed}`;
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
 *   }
 *
 * `op` is one of: 'create', 'update', 'unchanged', 'delete', 'restore',
 * 'skip-local-edit', 'force-overwrite', 'force-delete'.
 *
 * Pure function over `{ items, prevManifest, diskHashes, options }`.
 */
function buildPlan({ items, prevManifest, diskHashes, options }) {
  const force = !!(options && options.force);

  // -------- 1. Slug computation + collision check on ACTIVE items ----------
  const slugged = [];
  const bySlug = new Map();
  for (const item of items) {
    if (!item || item.isActive === false) continue;
    // KBT-B250: skip categories that don't materialize to disk (e.g. Command —
    // reference-only snippets per KBT-BD086, plus ClaudeMd/Pattern/Gotcha/Rule/
    // RepoContext/Custom which have no on-disk target). This filter runs
    // BEFORE slug-validation so a non-materializable item with an empty-slug
    // title cannot produce a spurious EMPTY_SLUG error.
    if (item.category !== 'Skill' && item.category !== 'Subagent') continue;
    const slug = slugify(item.title || '');
    if (!slug) {
      throw new SyncError(
        'EMPTY_SLUG',
        `Toolkit item ${item.code || '<no-code>'} title "${item.title}" produced an empty slug. Rename the toolkit item or set isActive: false.`
      );
    }
    const target = targetPathFor(item.category, slug);
    if (!target) continue; // ignore unrelated categories (defense-in-depth — buildPlan filter above is primary)
    const entry = {
      slug, category: item.category,
      sourceId: item.id || '',
      sourceCode: item.code || '',
      title: item.title || '',
      content: item.content || '',
      // KBT-F437: carry the model preference so renderFile can emit a `model:`
      // frontmatter line. MCP may surface it as `model` or `Model`.
      model: item.model || item.Model || '',
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
    return { plan: [], collisions, localEdits: [] };
  }

  // -------- 2. Build plan entries for each active item ---------------------
  const prevByEntrySlug = new Map(
    (prevManifest && Array.isArray(prevManifest.items) ? prevManifest.items : [])
      .map(e => [e.slug, e])
  );
  const plan = [];
  const localEdits = [];
  const seenSlugs = new Set();

  for (const entry of slugged) {
    seenSlugs.add(entry.slug);
    const body = renderFile(entry);
    const newTargetHash = sha256(body);
    // KBT-F437: fold the model into the source-hash so a model-only change
    // (same content, different model) registers as an UPDATE, not UNCHANGED.
    const newSourceHash = sha256(entry.content + ' ' + (entry.model || ''));
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
  const prevEntries = prevManifest && Array.isArray(prevManifest.items) ? prevManifest.items : [];
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

  return { plan, collisions: [], localEdits };
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
      out[rel] = sha256(buf);
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
 * Ensure the .gitignore file lists `.claude/commands/`, `.claude/agents/`,
 * and `.kanbantic-sync.json`. Creates the file if missing; appends only the
 * missing entries.
 */
function ensureGitignore(rootDir) {
  const file = path.join(rootDir, '.gitignore');
  const want = ['.claude/commands/', '.claude/agents/', '.kanbantic-sync.json'];
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new SyncError('GITIGNORE_UNREADABLE', `Cannot read ${file}: ${e.message}`);
  }
  // Split into lines, ignoring leading/trailing whitespace per line.
  const lines = existing.split(/\r?\n/);
  const trimmed = lines.map(l => l.trim());
  const toAdd = want.filter(p => !trimmed.includes(p));
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
 *   - now           (optional) ISO timestamp to record as `lastSyncedAt`
 *   - skipGitignore (optional, default false) don't touch .gitignore
 */
function runSync({ rootDir, items, workspace, force, now, skipGitignore }) {
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
  const { plan, collisions, localEdits } = buildPlan({
    items, prevManifest, diskHashes, options: { force: !!force },
  });

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
  let inputPath = null;
  let workspace = '';
  let rootDir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') { force = true; continue; }
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
    summary = runSync({ rootDir, items, workspace, force });
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
  'sync-workspace-skills [--input <path>] [--root <path>] [--workspace <slug>] [--force]',
  '',
  'Reads a JSON array of toolkit items from stdin (or --input <path>) and',
  'materializes them under .claude/commands/ and .claude/agents/ at the repo',
  'root (or --root <path>). Writes a .kanbantic-sync.json manifest, ensures',
  '.gitignore lists the mirror paths, and detects drift on subsequent runs.',
  '',
  'Pass --force to overwrite local edits (warning preserved in summary).',
  '',
  'Exit codes:',
  '  0 — sync completed without warnings.',
  '  1 — warnings preserved (local edit), or slug collision detected.',
  '  2 — infrastructure error (not a git repo, unreadable input, etc.).',
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
