'use strict';

//
// sync-workspace-skills.test.js — KBT-F265 / KBT-TC1933..1939
//
// Drives `plugin/scripts/sync-workspace-skills.js` end-to-end via its pure
// `runSync` export. Every test uses a fresh tmp-dir so cases don't leak.
//
// Coverage:
//   KBT-TC1933 — fresh-repo sync writes one file per active item with slug + frontmatter
//   KBT-TC1934 — second sync (no toolkit changes) is a no-op
//   KBT-TC1935 — toolkit content change triggers update
//   KBT-TC1936 — slug collision aborts with structured error, no writes
//   KBT-TC1937 — isActive:false removes pre-existing mirror
//   KBT-TC1938 — local edit refuses overwrite; --force overrides
//   KBT-TC1939 — .gitignore updated with the three mirror-paths
//
// Plus a slugify unit test (positive matrix) and a description-derivation test.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'sync-workspace-skills.js');
const sync = require(SCRIPT);

const FIXED_NOW = '2026-05-13T08:00:00.000Z';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f265-'));
  // Mark as a "git repo" by dropping a `.git` placeholder dir so the CLI
  // mode's isGitRoot() check passes. The pure runSync() doesn't enforce this
  // but the CLI test does.
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readFileOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

function readManifest(rootDir) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, '.kanbantic-sync.json'), 'utf8'));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function item(overrides) {
  // Sensible defaults for a Skill item.
  return Object.assign({
    id: '00000000-0000-0000-0000-000000000000',
    code: 'KBT-SKIL999',
    category: 'Skill',
    title: '/sample-tool — A sample skill (KBT-test)',
    content: 'Sample body line.\n\nMore content.\n',
    isActive: true,
  }, overrides);
}

// ---------------------------------------------------------------------------
// Pure-helper tests (slugify, description, render)
// ---------------------------------------------------------------------------

test('slugify: covers the canonical examples from KBT-PR209', () => {
  assert.equal(sync.slugify('/test-e2e-local — Lokale E2E Test Omgeving'), 'test-e2e-local');
  assert.equal(sync.slugify('Documentation Specialist'), 'documentation-specialist');
  assert.equal(sync.slugify('/local-dev-sandbox — Lokale Dev/Debug Sandbox (KBT-F233)'), 'local-dev-sandbox');
  assert.equal(sync.slugify('/kanbantic-versioning — Versioning Policy'), 'kanbantic-versioning');
  assert.equal(sync.slugify('  /Foo   Bar  '), 'foo-bar');
});

test('slugify: returns empty for unslugifiable input', () => {
  assert.equal(sync.slugify(''), '');
  assert.equal(sync.slugify('---'), '');
  assert.equal(sync.slugify('!!! ???'), '');
});

test('deriveDescription: picks first non-heading line, skips fences', () => {
  const it = item({ content: '# Heading\n\n```bash\nfoo\n```\n\nFirst meaningful line of body.\n' });
  const desc = sync.deriveDescription(it);
  assert.equal(desc, 'First meaningful line of body.');
});

test('deriveDescription: falls back to title-after-em-dash', () => {
  const it = item({ content: '\n\n# only-a-heading\n' });
  const desc = sync.deriveDescription(it);
  assert.equal(desc, 'A sample skill (KBT-test)');
});

test('renderFile: emits frontmatter with description and source', () => {
  const body = sync.renderFile(item({ content: 'one-liner\n' }));
  assert.match(body, /^---\n/);
  assert.match(body, /\ndescription: "[^"]+"\n/);
  assert.match(body, /\nsource: "KBT-SKIL999"\n/);
  assert.match(body, /\n---\n\none-liner\n$/);
});

// ---------------------------------------------------------------------------
// KBT-F437 — model frontmatter + model-aware drift hash
// ---------------------------------------------------------------------------

test('KBT-F437: Subagent item with model:"Opus" renders a `model: opus` frontmatter line', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Subagent', title: 'Opus Specialist', content: 'Opus body.\n', code: 'KBT-SAGN701', model: 'Opus' }),
    ];
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    const agnFile = readFileOrNull(path.join(root, '.claude/agents/opus-specialist.md'));
    assert.ok(agnFile, '.claude/agents/opus-specialist.md must exist');
    assert.match(agnFile, /\nmodel: opus\n/);
    // The model line sits after the source line, before the closing delimiter.
    assert.match(agnFile, /\nsource: "KBT-SAGN701"\nmodel: opus\n---\n/);
  } finally {
    cleanup(root);
  }
});

test('KBT-F437: renderFile accepts the MCP `Model` field casing too', () => {
  const body = sync.renderFile(item({ category: 'Subagent', title: 'Sonnet Specialist', content: 'x\n', code: 'KBT-SAGN702', Model: 'Sonnet' }));
  assert.match(body, /\nmodel: sonnet\n/);
});

test('KBT-F437: item without a model produces NO model frontmatter line', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Subagent', title: 'Plain Specialist', content: 'Plain body.\n', code: 'KBT-SAGN703' }),
    ];
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    const agnFile = readFileOrNull(path.join(root, '.claude/agents/plain-specialist.md'));
    assert.ok(agnFile);
    assert.doesNotMatch(agnFile, /\nmodel:/);
  } finally {
    cleanup(root);
  }
});

test('KBT-F437: a model-only change yields an `update` op (not `unchanged`)', () => {
  const v1 = item({ category: 'Subagent', title: 'Drift Specialist', content: 'Same body.\n', code: 'KBT-SAGN704' });
  // First plan from a fresh manifest → create.
  const first = sync.buildPlan({
    items: [v1], prevManifest: null, diskHashes: {}, options: {},
  });
  const created = first.plan.find(p => p.slug === 'drift-specialist');
  assert.ok(created);
  assert.equal(created.op, 'create');

  // Simulate the manifest + disk after that create.
  const prevManifest = {
    version: 1, workspace: 'kanbantic', lastSyncedAt: FIXED_NOW,
    items: [{
      slug: created.slug, category: created.category,
      sourceId: created.sourceId, sourceCode: created.sourceCode,
      sourceHash: created.sourceHash, targetPath: created.targetPath,
      targetHash: created.targetHash, syncedAt: FIXED_NOW,
    }],
  };
  const diskHashes = { [created.targetPath]: created.targetHash };

  // Same content, but now a model is set → must be an UPDATE.
  const v2 = Object.assign({}, v1, { model: 'Opus' });
  const second = sync.buildPlan({
    items: [v2], prevManifest, diskHashes, options: {},
  });
  const step = second.plan.find(p => p.slug === 'drift-specialist');
  assert.ok(step);
  assert.equal(step.op, 'update', `expected update on model-only change, got ${step.op}`);
  assert.notEqual(step.sourceHash, created.sourceHash);
});

// ---------------------------------------------------------------------------
// KBT-B531 / KBT-TC3403 (Unit) — model normalisation accepts every input shape
//
// The REST API serialises the model enum as an integer (0/1/2) where MCP
// returns the name ("Sonnet"). Before this fix renderFile assumed the caller
// had already produced an alias, which failed in two independent ways: enum 0
// (Opus) is falsy and dropped the line entirely, and a numeric value rendered
// verbatim as `model: 1`. Each case gets its own assertion so a regression
// points at which of the two defects came back.
// ---------------------------------------------------------------------------

test('KBT-TC3403: enum 0 (Opus) renders `model: opus` — the falsy value that used to vanish', () => {
  const body = sync.renderFile(item({ category: 'Subagent', title: 'Zero Specialist', content: 'x\n', code: 'KBT-SAGN710', model: 0 }));
  assert.match(body, /\nmodel: opus\n/, 'enum 0 must survive: `||` treated it as absent');
});

test('KBT-TC3403: enum 1 renders `model: sonnet`', () => {
  const body = sync.renderFile(item({ category: 'Subagent', title: 'One Specialist', content: 'x\n', code: 'KBT-SAGN711', model: 1 }));
  assert.match(body, /\nmodel: sonnet\n/);
});

test('KBT-TC3403: enum 2 renders `model: haiku`', () => {
  const body = sync.renderFile(item({ category: 'Subagent', title: 'Two Specialist', content: 'x\n', code: 'KBT-SAGN712', model: 2 }));
  assert.match(body, /\nmodel: haiku\n/);
});

test('KBT-TC3403: the MCP enum-name form is accepted and lowercased', () => {
  const body = sync.renderFile(item({ category: 'Subagent', title: 'Name Specialist', content: 'x\n', code: 'KBT-SAGN713', model: 'Sonnet' }));
  assert.match(body, /\nmodel: sonnet\n/);
});

test('KBT-TC3403: an already-normalised alias passes through unchanged (idempotent)', () => {
  const body = sync.renderFile(item({ category: 'Subagent', title: 'Idem Specialist', content: 'x\n', code: 'KBT-SAGN714', model: 'sonnet' }));
  assert.match(body, /\nmodel: sonnet\n/);
});

test('KBT-TC3403: null and an absent field both yield NO model line', () => {
  const withNull = sync.renderFile(item({ category: 'Subagent', title: 'Null Specialist', content: 'x\n', code: 'KBT-SAGN715', model: null }));
  const withNone = sync.renderFile(item({ category: 'Subagent', title: 'None Specialist', content: 'x\n', code: 'KBT-SAGN716' }));
  assert.doesNotMatch(withNull, /\nmodel:/);
  assert.doesNotMatch(withNone, /\nmodel:/);
});

test('KBT-TC3403: an unknown value yields NO model line rather than an invalid alias', () => {
  const body = sync.renderFile(item({ category: 'Subagent', title: 'Unknown Specialist', content: 'x\n', code: 'KBT-SAGN717', model: 99 }));
  assert.doesNotMatch(body, /\nmodel:/, 'better no line than a value the loader cannot parse');
});

test('KBT-TC3403: no input shape can ever put a bare number in the frontmatter', () => {
  // The property that defines the bug, independent of which integers the enum
  // happens to use today. If the enum is ever renumbered this assertion still
  // holds while the per-value ones above would need updating.
  for (const model of [0, 1, 2, 99, '0', '1', 'Opus', 'sonnet', 'HAIKU', null, undefined, '']) {
    const body = sync.renderFile(item({ category: 'Subagent', title: 'Sweep Specialist', content: 'x\n', code: 'KBT-SAGN718', model }));
    assert.doesNotMatch(body, /\nmodel: \d+\n/, `numeric alias leaked for input ${JSON.stringify(model)}`);
  }
});

test('KBT-TC3403: normalizeModel is exported and total over its input domain', () => {
  assert.equal(sync.normalizeModel(0), 'opus');
  assert.equal(sync.normalizeModel(1), 'sonnet');
  assert.equal(sync.normalizeModel(2), 'haiku');
  assert.equal(sync.normalizeModel('  Opus  '), 'opus');
  assert.equal(sync.normalizeModel(null), '');
  assert.equal(sync.normalizeModel(undefined), '');
  assert.equal(sync.normalizeModel(''), '');
  assert.equal(sync.normalizeModel('fable'), '');
});

// ---------------------------------------------------------------------------
// KBT-B531 / KBT-TC3405 (Integration) — the whole script path, not just render
//
// renderFile is covered above in isolation. This asserts on the bytes that end
// up on disk, because the plan layer sits between the two and the bug was only
// ever visible in the written files.
// ---------------------------------------------------------------------------

test('KBT-TC3405: a full sync with numeric enums writes valid aliases to disk', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Subagent', title: 'Rest Opus', content: 'a\n', code: 'KBT-SAGN720', model: 0 }),
      item({ category: 'Subagent', title: 'Rest Sonnet', content: 'b\n', code: 'KBT-SAGN721', model: 1 }),
      item({ category: 'Subagent', title: 'Rest Haiku', content: 'c\n', code: 'KBT-SAGN722', model: 2 }),
      item({ category: 'Subagent', title: 'Rest Plain', content: 'd\n', code: 'KBT-SAGN723' }),
    ];
    const summary = sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    assert.equal(summary.warnings, 0, 'a clean fixture must not produce warnings');

    const read = (slug) => readFileOrNull(path.join(root, '.claude/agents', `${slug}.md`));

    // The Opus item is the one that regressed: the plan layer must not filter
    // the falsy enum out on its way to disk either.
    assert.match(read('rest-opus'), /\nmodel: opus\n/);
    assert.match(read('rest-sonnet'), /\nmodel: sonnet\n/);
    assert.match(read('rest-haiku'), /\nmodel: haiku\n/);
    assert.doesNotMatch(read('rest-plain'), /\nmodel:/);

    for (const slug of ['rest-opus', 'rest-sonnet', 'rest-haiku', 'rest-plain']) {
      assert.doesNotMatch(read(slug), /\nmodel: \d+\n/, `${slug} carries a numeric alias`);
    }

    // Re-running over the same input must be a no-op: normalisation is stable,
    // so identical input keeps producing identical bytes.
    const again = sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    assert.equal(again.created, 0);
    assert.equal(again.updated, 0);
    assert.equal(again.unchanged, 4);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-TC1933 — fresh-repo sync writes one file per active item
// ---------------------------------------------------------------------------

test('KBT-TC1933: fresh sync materializes Skill + Subagent items with frontmatter + manifest', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill', title: '/foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101' }),
      item({ category: 'Subagent', title: 'Bar Specialist', content: 'Bar body.\n', code: 'KBT-SAGN201' }),
    ];
    const summary = sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    // Files exist at the expected paths.
    const cmdFile = readFileOrNull(path.join(root, '.claude/commands/foo.md'));
    const agnFile = readFileOrNull(path.join(root, '.claude/agents/bar-specialist.md'));
    assert.ok(cmdFile, '.claude/commands/foo.md must exist');
    assert.ok(agnFile, '.claude/agents/bar-specialist.md must exist');

    // Frontmatter present.
    assert.match(cmdFile, /^---\n/);
    assert.match(cmdFile, /\ndescription: "Foo body\."\n/);
    assert.match(cmdFile, /\nsource: "KBT-SKIL101"\n/);
    assert.match(agnFile, /^---\n/);
    assert.match(agnFile, /\nsource: "KBT-SAGN201"\n/);

    // Manifest present + well-formed.
    const manifest = readManifest(root);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.workspace, 'kanbantic');
    assert.equal(manifest.lastSyncedAt, FIXED_NOW);
    assert.equal(manifest.items.length, 2);
    for (const e of manifest.items) {
      assert.ok(e.slug);
      assert.ok(e.sourceHash);
      assert.ok(e.targetHash);
      assert.ok(e.targetPath);
    }

    // Summary counts.
    assert.equal(summary.created, 2);
    assert.equal(summary.updated, 0);
    assert.equal(summary.unchanged, 0);
    assert.equal(summary.deleted, 0);
    assert.equal(summary.warnings, 0);
    assert.equal(summary.forced, 0);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-TC1934 — idempotency: second sync without changes is a no-op
// ---------------------------------------------------------------------------

test('KBT-TC1934: second sync without toolkit changes is a no-op', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill', title: '/foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101' }),
      item({ category: 'Subagent', title: 'Bar Specialist', content: 'Bar body.\n', code: 'KBT-SAGN201' }),
    ];

    // First sync.
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    // Snapshot file contents + manifest item entries.
    const beforeCmd = fs.readFileSync(path.join(root, '.claude/commands/foo.md'), 'utf8');
    const beforeAgn = fs.readFileSync(path.join(root, '.claude/agents/bar-specialist.md'), 'utf8');
    const beforeManifest = readManifest(root);

    // Second sync (identical input).
    const summary2 = sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: '2026-05-13T09:00:00.000Z' });

    // Files must be byte-identical.
    assert.equal(fs.readFileSync(path.join(root, '.claude/commands/foo.md'), 'utf8'), beforeCmd);
    assert.equal(fs.readFileSync(path.join(root, '.claude/agents/bar-specialist.md'), 'utf8'), beforeAgn);

    // Manifest item hashes unchanged (lastSyncedAt may update).
    const afterManifest = readManifest(root);
    assert.equal(afterManifest.items.length, beforeManifest.items.length);
    for (const e of afterManifest.items) {
      const prev = beforeManifest.items.find(p => p.slug === e.slug);
      assert.equal(e.sourceHash, prev.sourceHash, `sourceHash for ${e.slug} should be unchanged`);
      assert.equal(e.targetHash, prev.targetHash, `targetHash for ${e.slug} should be unchanged`);
    }

    // Summary.
    assert.equal(summary2.created, 0);
    assert.equal(summary2.updated, 0);
    assert.equal(summary2.unchanged, 2);
    assert.equal(summary2.deleted, 0);
    assert.equal(summary2.warnings, 0);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-TC1935 — toolkit content change → update
// ---------------------------------------------------------------------------

test('KBT-TC1935: toolkit content change triggers an update on next sync', () => {
  const root = mkTmpRoot();
  try {
    const v1 = item({ category: 'Skill', title: '/foo — Foo helper', content: 'v1 body.\n', code: 'KBT-SKIL101' });
    sync.runSync({ rootDir: root, items: [v1], workspace: 'kanbantic', now: FIXED_NOW });
    const beforeManifest = readManifest(root);
    const beforeEntry = beforeManifest.items.find(e => e.slug === 'foo');
    assert.ok(beforeEntry);

    const v2 = Object.assign({}, v1, { content: 'v2 body — radically different.\n' });
    const summary = sync.runSync({ rootDir: root, items: [v2], workspace: 'kanbantic', now: FIXED_NOW });

    const afterFile = fs.readFileSync(path.join(root, '.claude/commands/foo.md'), 'utf8');
    assert.match(afterFile, /v2 body/);

    const afterManifest = readManifest(root);
    const afterEntry = afterManifest.items.find(e => e.slug === 'foo');
    assert.ok(afterEntry);
    assert.notEqual(afterEntry.sourceHash, beforeEntry.sourceHash);
    assert.notEqual(afterEntry.targetHash, beforeEntry.targetHash);

    assert.equal(summary.created, 0);
    assert.equal(summary.updated, 1);
    assert.equal(summary.unchanged, 0);
    assert.equal(summary.deleted, 0);
    assert.equal(summary.warnings, 0);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-TC1936 — slug collision: structured error, no writes
// ---------------------------------------------------------------------------

test('KBT-TC1936: slug collision between two active items aborts with structured error', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill', title: '/foo — first', content: 'A\n', code: 'KBT-SKIL101' }),
      item({ category: 'Skill', title: '/foo — second', content: 'B\n', code: 'KBT-SKIL102' }),
    ];
    let caught = null;
    try {
      sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected runSync to throw on slug collision');
    assert.equal(caught.name, 'SyncError');
    assert.equal(caught.kind, 'SLUG_COLLISION');
    assert.match(caught.message, /KBT-SKIL101/);
    assert.match(caught.message, /KBT-SKIL102/);
    assert.match(caught.message, /slug "foo"/);

    // No file or manifest was written.
    assert.equal(readFileOrNull(path.join(root, '.claude/commands/foo.md')), null);
    assert.equal(readFileOrNull(path.join(root, '.kanbantic-sync.json')), null);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC1936 (CLI): exit code 1 on slug collision', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill', title: '/foo — first', content: 'A\n', code: 'KBT-SKIL101' }),
      item({ category: 'Skill', title: '/foo — second', content: 'B\n', code: 'KBT-SKIL102' }),
    ];
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--workspace', 'kanbantic'], {
      input: JSON.stringify(items),
      encoding: 'utf8',
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stderr, /SLUG_COLLISION/);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-TC1937 — isActive:false removes pre-existing mirror
// ---------------------------------------------------------------------------

test('KBT-TC1937: isActive:false toolkit item removes pre-existing mirror', () => {
  const root = mkTmpRoot();
  try {
    const it = item({ category: 'Skill', title: '/foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101' });
    sync.runSync({ rootDir: root, items: [it], workspace: 'kanbantic', now: FIXED_NOW });
    assert.ok(readFileOrNull(path.join(root, '.claude/commands/foo.md')));

    const deactivated = Object.assign({}, it, { isActive: false });
    const summary = sync.runSync({ rootDir: root, items: [deactivated], workspace: 'kanbantic', now: FIXED_NOW });

    assert.equal(readFileOrNull(path.join(root, '.claude/commands/foo.md')), null);
    const manifest = readManifest(root);
    assert.equal(manifest.items.length, 0);

    assert.equal(summary.created, 0);
    assert.equal(summary.updated, 0);
    assert.equal(summary.unchanged, 0);
    assert.equal(summary.deleted, 1);
    assert.equal(summary.warnings, 0);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-TC1938 — local edit: default refuses, --force overrides
// ---------------------------------------------------------------------------

test('KBT-TC1938: local edit on a managed file is detected — default skips, --force overwrites', () => {
  const root = mkTmpRoot();
  try {
    const v1 = item({ category: 'Skill', title: '/foo — Foo helper', content: 'v1 body.\n', code: 'KBT-SKIL101' });
    sync.runSync({ rootDir: root, items: [v1], workspace: 'kanbantic', now: FIXED_NOW });

    // Simulate a hand-edit on disk.
    const filePath = path.join(root, '.claude/commands/foo.md');
    fs.appendFileSync(filePath, '\nUSER LOCAL EDIT.\n', 'utf8');
    const editedContent = fs.readFileSync(filePath, 'utf8');
    assert.match(editedContent, /USER LOCAL EDIT/);

    // Toolkit ALSO changed.
    const v2 = Object.assign({}, v1, { content: 'v2 body — radically different.\n' });

    // 1. Default sync — must NOT overwrite.
    const summary = sync.runSync({ rootDir: root, items: [v2], workspace: 'kanbantic', now: FIXED_NOW });
    assert.equal(fs.readFileSync(filePath, 'utf8'), editedContent,
      'default sync must not overwrite a locally-edited file');
    assert.equal(summary.warnings, 1);
    assert.equal(summary.updated, 0);
    assert.equal(summary.warningsList[0].targetPath, '.claude/commands/foo.md');

    // Manifest entry must NOT be silently updated under the skip case.
    const m1 = readManifest(root);
    const entry1 = m1.items.find(e => e.slug === 'foo');
    assert.ok(entry1);
    // The on-disk file's hash differs from manifest's targetHash by design now.
    assert.notEqual(entry1.targetHash, sha256(editedContent));

    // 2. --force sync — must overwrite.
    const summary2 = sync.runSync({ rootDir: root, items: [v2], workspace: 'kanbantic', now: FIXED_NOW, force: true });
    const after = fs.readFileSync(filePath, 'utf8');
    assert.match(after, /v2 body/);
    assert.doesNotMatch(after, /USER LOCAL EDIT/);
    assert.equal(summary2.updated, 1);
    assert.equal(summary2.forced, 1);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-TC1939 — .gitignore is updated with the three mirror-paths
// ---------------------------------------------------------------------------

test('KBT-TC1939: .gitignore is created/updated with the three mirror-paths', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill', title: '/foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101' }),
    ];
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(gi, /\.claude\/commands\//);
    assert.match(gi, /\.claude\/agents\//);
    assert.match(gi, /\.kanbantic-sync\.json/);

    // Re-run: no duplicate lines.
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    const gi2 = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const count = (s, needle) => s.split(needle).length - 1;
    assert.equal(count(gi2, '.claude/commands/'), 1);
    assert.equal(count(gi2, '.claude/agents/'), 1);
    assert.equal(count(gi2, '.kanbantic-sync.json'), 1);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC1939 (preserve): existing .gitignore entries are preserved, only missing ones appended', () => {
  const root = mkTmpRoot();
  try {
    fs.writeFileSync(path.join(root, '.gitignore'),
      'node_modules/\n.claude/commands/\n', 'utf8');
    const items = [
      item({ category: 'Skill', title: '/foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101' }),
    ];
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(gi, /^node_modules\/$/m);
    assert.match(gi, /^\.claude\/commands\/$/m);
    assert.match(gi, /^\.claude\/agents\/$/m);
    assert.match(gi, /^\.kanbantic-sync\.json$/m);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Extra: CLI mode happy-path + invariant 3-style smoke test
// ---------------------------------------------------------------------------

test('CLI: happy-path with stdin input writes mirrors and exits 0', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill', title: '/cli-foo — CLI foo', content: 'CLI body.\n', code: 'KBT-SKIL333' }),
    ];
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--workspace', 'kanbantic'], {
      input: JSON.stringify(items),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stdout: ${r.stdout}; stderr: ${r.stderr}`);
    assert.match(r.stdout, /created=1/);
    assert.ok(readFileOrNull(path.join(root, '.claude/commands/cli-foo.md')));
  } finally {
    cleanup(root);
  }
});

test('CLI: non-git dir exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f265-nogit-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--workspace', 'kanbantic'], {
      input: '[]',
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a git working tree/);
  } finally {
    cleanup(dir);
  }
});

test('CLI: malformed JSON input exits 2', () => {
  const root = mkTmpRoot();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--workspace', 'kanbantic'], {
      input: '{not json',
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not valid JSON/);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Combined scenario: full lifecycle of one item
// ---------------------------------------------------------------------------

test('full lifecycle: create → unchanged → update → deactivate', () => {
  const root = mkTmpRoot();
  try {
    let it = item({ category: 'Skill', title: '/life — lifecycle', content: 'v1\n', code: 'KBT-SKIL444' });
    let s = sync.runSync({ rootDir: root, items: [it], workspace: 'kanbantic', now: FIXED_NOW });
    assert.equal(s.created, 1);

    s = sync.runSync({ rootDir: root, items: [it], workspace: 'kanbantic', now: FIXED_NOW });
    assert.equal(s.unchanged, 1);

    it = Object.assign({}, it, { content: 'v2\n' });
    s = sync.runSync({ rootDir: root, items: [it], workspace: 'kanbantic', now: FIXED_NOW });
    assert.equal(s.updated, 1);

    it = Object.assign({}, it, { isActive: false });
    s = sync.runSync({ rootDir: root, items: [it], workspace: 'kanbantic', now: FIXED_NOW });
    assert.equal(s.deleted, 1);
    assert.equal(readFileOrNull(path.join(root, '.claude/commands/life.md')), null);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-B250 — Command-category is reference-only, not materialized to disk
// ---------------------------------------------------------------------------

test('KBT-TC1967: buildPlan skips Command-category items — no plan entry, no manifest entry, no on-disk file', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill',    title: '/sample-tool — A sample skill', code: 'KBT-SKIL999' }),
      item({ category: 'Command',  title: 'Solution Bouwen',               code: 'KBT-CMND999', content: 'dotnet build Kanbantic.sln\n' }),
      item({ category: 'Subagent', title: 'Test Specialist',               code: 'KBT-SAGN999' }),
    ];
    const s = sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    // Only Skill + Subagent counted toward created.
    assert.equal(s.created, 2, 'expected created=2 (Skill + Subagent), got ' + s.created);
    assert.equal(s.warnings, 0, 'expected warnings=0 (Command-skip is silent, not a warning)');
    assert.equal(s.forced, 0);

    // Manifest must not contain a Command entry.
    const manifest = readManifest(root);
    assert.equal(manifest.items.length, 2);
    const categories = manifest.items.map(i => i.category).sort();
    assert.deepEqual(categories, ['Skill', 'Subagent']);
    assert.equal(manifest.items.find(i => i.category === 'Command'), undefined);

    // Disk: Skill + Subagent file exist, Command file does NOT.
    assert.ok(fs.existsSync(path.join(root, '.claude/commands/sample-tool.md')));
    assert.ok(fs.existsSync(path.join(root, '.claude/agents/test-specialist.md')));
    assert.equal(fs.existsSync(path.join(root, '.claude/commands/solution-bouwen.md')), false,
      'Command-category item must not produce an on-disk file (KBT-BD086)');
  } finally {
    cleanup(root);
  }
});

test('KBT-TC1968: Command-item with empty-slug title does NOT throw EMPTY_SLUG (category-filter runs before slug-validation)', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill',   title: '/test-tool — A test', code: 'KBT-SKIL777' }),
      // Title that slugify() would normalize to "" — only Command, so must be silently skipped
      // without triggering EMPTY_SLUG.
      item({ category: 'Command', title: '...',                code: 'KBT-CMND777', content: 'noop\n' }),
    ];

    // The call must succeed — no exception thrown.
    let s;
    assert.doesNotThrow(
      () => { s = sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW }); },
      'Command with empty-slug-title must be filtered out before slug-validation — no EMPTY_SLUG'
    );

    assert.equal(s.created, 1, 'only the Skill should be created');
    assert.equal(s.warnings, 0);

    // Sanity: the bad-slug Command produced no manifest entry.
    const manifest = readManifest(root);
    assert.equal(manifest.items.length, 1);
    assert.equal(manifest.items[0].category, 'Skill');
  } finally {
    cleanup(root);
  }
});

test('KBT-TC1969 (CLI): mixed Skill+Command+Subagent input materializes only Skill+Subagent files; exit 0; no EMPTY_SLUG for bad-slug Command', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill',    title: '/sample — Sample skill',     code: 'KBT-SKIL888' }),
      item({ category: 'Command',  title: 'npm run build',              code: 'KBT-CMND888', content: 'npm run build\n' }),
      item({ category: 'Command',  title: '---',                        code: 'KBT-CMND889', content: 'bad-slug Command\n' }),
      item({ category: 'Subagent', title: 'Sample Agent',               code: 'KBT-SAGN888' }),
    ];
    const inputPath = path.join(root, 'items.json');
    fs.writeFileSync(inputPath, JSON.stringify(items), 'utf8');

    const r = spawnSync(process.execPath, [SCRIPT, '--input', inputPath, '--root', root, '--workspace', 'kanbantic'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stdout, /created=2 updated=0 unchanged=0 deleted=0 warnings=0 forced=0/);
    assert.equal(r.stderr.trim(), '', `expected empty stderr, got: ${r.stderr}`);

    // Disk: only Skill + Subagent materialized.
    assert.ok(fs.existsSync(path.join(root, '.claude/commands/sample.md')));
    assert.ok(fs.existsSync(path.join(root, '.claude/agents/sample-agent.md')));
    // Neither Command (one with valid slug, one with empty-slug-title) produced a file.
    assert.equal(fs.existsSync(path.join(root, '.claude/commands/npm-run-build.md')), false);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-B495 — `name:` frontmatter for Subagent mirrors
//
//   KBT-TC3320 (Unit)        — renderFile emits `name:` for Subagent, not for Skill;
//                              deriveDescription ignores a leading `name:` line.
//   KBT-TC3321 (Integration) — runSync writes name == basename, and a pre-fix
//                              mirror re-syncs as `update` (no --force needed).
//   KBT-TC3322 (E2E)         — CLI run over a realistic multi-subagent fixture
//                              yields files whose frontmatter name == basename.
//
// Why this matters: Claude Code registers a subagent under the frontmatter
// `name:` value and does NOT fall back to the filename. Without that line the
// mirror is written correctly and loads as nothing — `Agent type '<slug>' not
// found.` Commands are unaffected (their name IS the filename).
// ---------------------------------------------------------------------------

/** Parse the leading `---` frontmatter block into a flat key-value map. */
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

test('KBT-TC3320: renderFile emits `name: <slug>` for a Subagent item', () => {
  const body = sync.renderFile(item({
    category: 'Subagent', title: 'Bar Specialist', content: 'Bar body.\n', code: 'KBT-SAGN201',
  }));
  // `name` must be the FIRST frontmatter line so it reads as the identity.
  assert.match(body, /^---\nname: bar-specialist\n/);
  const fm = parseFrontmatter(body);
  assert.equal(fm.name, sync.slugify('Bar Specialist'),
    'the emitted name must equal the slug that determines the file path');
  assert.ok(fm.description, 'description must survive alongside name');
  assert.equal(fm.source, 'KBT-SAGN201');
});

test('KBT-TC3320: renderFile emits NO `name:` line for a Skill item', () => {
  const body = sync.renderFile(item({
    category: 'Skill', title: '/foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101',
  }));
  assert.doesNotMatch(body, /\nname:/);
  const fm = parseFrontmatter(body);
  assert.equal(fm.name, undefined);
  assert.equal(fm.description, 'Foo body.');
});

test('KBT-TC3320: renderFile prefers an explicit slug over re-slugifying the title', () => {
  // buildPlan hands renderFile an entry that already carries `slug`; the two
  // paths must agree so name and filename can never diverge.
  const body = sync.renderFile(item({
    category: 'Subagent', title: 'Bar Specialist', slug: 'bar-specialist',
    content: 'Bar body.\n', code: 'KBT-SAGN201',
  }));
  assert.match(body, /^---\nname: bar-specialist\n/);
});

test('KBT-TC3320: deriveDescription skips a leading `name:` line in the content', () => {
  // Real case: ADM-SKIL003 starts with `name: adminhub-ui-ux`, which used to
  // render as description: "name: adminhub-ui-ux".
  const it = item({ content: 'name: adminhub-ui-ux\n\nReviews UI changes against the design system.\n' });
  assert.equal(sync.deriveDescription(it), 'Reviews UI changes against the design system.');

  // A line that merely *contains* "name:" is untouched.
  const it2 = item({ content: 'The name: field is documented below.\n' });
  assert.equal(sync.deriveDescription(it2), 'The name: field is documented below.');

  // ...and so is a real sentence that happens to start with "Name:" — only a
  // bare slug value is treated as a stray frontmatter attempt.
  const it3 = item({ content: 'Name: John Doe, the owner of this workflow.\n' });
  assert.equal(sync.deriveDescription(it3), 'Name: John Doe, the owner of this workflow.');
});

test('KBT-TC3321: runSync writes an agent mirror whose `name` equals its filename', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Subagent', title: 'Wireframe Agent', content: 'Body.\n', code: 'KBT-SAGN009' }),
      item({ category: 'Skill', title: '/foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101' }),
    ];
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    const agentPath = path.join(root, '.claude/agents/wireframe-agent.md');
    const fm = parseFrontmatter(fs.readFileSync(agentPath, 'utf8'));
    assert.ok(fm, 'agent frontmatter must parse');
    assert.equal(fm.name, path.basename(agentPath, '.md'));

    // Commands keep their filename-derived identity — no name line.
    const cmd = parseFrontmatter(fs.readFileSync(path.join(root, '.claude/commands/foo.md'), 'utf8'));
    assert.equal(cmd.name, undefined);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3321: a pre-fix mirror re-syncs as `update` — no local-edit warning, no --force', () => {
  const root = mkTmpRoot();
  try {
    const it = item({ category: 'Subagent', title: 'Bar Specialist', content: 'Bar body.\n', code: 'KBT-SAGN201' });
    const targetPath = '.claude/agents/bar-specialist.md';

    // Reconstruct the exact pre-KBT-B495 render (frontmatter without `name:`)
    // plus a manifest whose targetHash matches it — i.e. a mirror that was last
    // synced by an older plugin version and never touched since.
    const legacyBody = '---\ndescription: "Bar body."\nsource: "KBT-SAGN201"\n---\n\nBar body.\n';
    const legacyPath = path.join(root, targetPath);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, legacyBody, 'utf8');
    fs.writeFileSync(path.join(root, '.kanbantic-sync.json'), JSON.stringify({
      version: 1, workspace: 'kanbantic', lastSyncedAt: FIXED_NOW,
      items: [{
        slug: 'bar-specialist', category: 'Subagent',
        sourceId: it.id, sourceCode: it.code,
        sourceHash: sha256(it.content + ' '),
        targetPath, targetHash: sha256(legacyBody), syncedAt: FIXED_NOW,
      }],
    }, null, 2) + '\n', 'utf8');

    const summary = sync.runSync({ rootDir: root, items: [it], workspace: 'kanbantic', now: FIXED_NOW });

    // The whole point: a clean upgrade, not a wall of warnings.
    assert.equal(summary.warnings, 0, 'an untouched legacy mirror must not be reported as a local edit');
    assert.equal(summary.updated, 1);
    assert.equal(summary.unchanged, 0);
    assert.equal(summary.forced, 0);
    assert.deepEqual(summary.localEdits, []);

    const fm = parseFrontmatter(fs.readFileSync(legacyPath, 'utf8'));
    assert.equal(fm.name, 'bar-specialist');
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3321: a genuinely hand-edited agent mirror still warns instead of being overwritten', () => {
  const root = mkTmpRoot();
  try {
    const it = item({ category: 'Subagent', title: 'Bar Specialist', content: 'Bar body.\n', code: 'KBT-SAGN201' });
    sync.runSync({ rootDir: root, items: [it], workspace: 'kanbantic', now: FIXED_NOW });

    const filePath = path.join(root, '.claude/agents/bar-specialist.md');
    fs.appendFileSync(filePath, '\nUSER LOCAL EDIT.\n', 'utf8');
    const edited = fs.readFileSync(filePath, 'utf8');

    const summary = sync.runSync({
      rootDir: root, items: [Object.assign({}, it, { content: 'New body.\n' })],
      workspace: 'kanbantic', now: FIXED_NOW,
    });
    assert.equal(summary.warnings, 1);
    assert.equal(fs.readFileSync(filePath, 'utf8'), edited);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3322 (CLI E2E): every generated agent file is loadable — name == basename', () => {
  const root = mkTmpRoot();
  try {
    // Fixture mirroring the real Kanbantic + admin-hub Toolkit Subagent titles:
    // em-dashes, parenthesised codes, and a Dutch title — the shapes that
    // actually pass through slugify() in production.
    const items = [
      item({ category: 'Subagent', title: 'Documentation Specialist', code: 'KBT-SAGN003', content: 'Audits documentation coverage.\n' }),
      item({ category: 'Subagent', title: 'Test Coverage Specialist', code: 'KBT-SAGN006', content: 'Audits test coverage.\n' }),
      item({ category: 'Subagent', title: 'Wireframe Agent', code: 'KBT-SAGN009', content: 'Handles wireframe filesets.\n', model: 'Sonnet' }),
      item({ category: 'Subagent', title: 'Frontend Ontwikkelingsagent — Angular/LeptonX (KBT-SAGN001)', code: 'KBT-SAGN001', content: 'Bouwt Angular-componenten.\n' }),
      item({ category: 'Subagent', title: 'UI-UX Specialist', code: 'ADM-SAGN001', content: 'name: adminhub-ui-ux\n\nReviews UI changes against the design system.\n' }),
      item({ category: 'Skill', title: '/local-dev-sandbox — Lokale Dev/Debug Sandbox (KBT-F233)', code: 'KBT-SKIL003', content: 'Boots the local sandbox.\n' }),
    ];
    const inputPath = path.join(root, 'items.json');
    fs.writeFileSync(inputPath, JSON.stringify(items), 'utf8');

    const r = spawnSync(process.execPath, [SCRIPT, '--input', inputPath, '--root', root, '--workspace', 'kanbantic'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, 'expected exit 0, got ' + r.status + '. stderr: ' + r.stderr);

    const agentsDir = path.join(root, '.claude/agents');
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    assert.equal(files.length, 5, 'all five Subagent items must materialize');

    for (const file of files) {
      const fm = parseFrontmatter(fs.readFileSync(path.join(agentsDir, file), 'utf8'));
      assert.ok(fm, file + ': frontmatter must parse');
      assert.equal(fm.name, path.basename(file, '.md'), file + ': name must equal the basename');
      assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, file + ': name must be a clean slug');
      assert.ok(fm.description && fm.description.length > 0, file + ': description must not be empty');
      assert.doesNotMatch(fm.description, /^name:/, file + ': description must not be the name line');
    }

    // The UI-UX case from the bug report: name from the slug, description from
    // the real first body line — not `name: adminhub-ui-ux`.
    const uiux = parseFrontmatter(fs.readFileSync(path.join(agentsDir, 'ui-ux-specialist.md'), 'utf8'));
    assert.equal(uiux.name, 'ui-ux-specialist');
    assert.equal(uiux.description, 'Reviews UI changes against the design system.');

    // Skill mirrors are unchanged by this fix.
    const skill = parseFrontmatter(fs.readFileSync(path.join(root, '.claude/commands/local-dev-sandbox.md'), 'utf8'));
    assert.equal(skill.name, undefined);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-B489 / KBT-B491 — input validation before any write
//
//   KBT-TC3304 (Integration) — an incomplete item list aborts before any write;
//                              a complete list still syncs; a genuine
//                              deactivation still deletes.
//   KBT-TC3308 (Integration) — integer-shaped `category` (raw REST output) is
//                              normalised; an unrecognised category aborts
//                              before any write.
// ---------------------------------------------------------------------------

// --- KBT-B491 / KBT-TC3308 -------------------------------------------------

test('KBT-TC3308: normalizeCategory accepts the enum name and the enum integer', () => {
  // Field-verified pair from the bug report: 1 = Skill, 6 = Subagent.
  assert.equal(sync.normalizeCategory(1), 'Skill');
  assert.equal(sync.normalizeCategory(6), 'Subagent');
  assert.equal(sync.normalizeCategory('Skill'), 'Skill');
  assert.equal(sync.normalizeCategory('subagent'), 'Subagent');
  assert.equal(sync.normalizeCategory('  SUBAGENT  '), 'Subagent');
  assert.equal(sync.normalizeCategory('Command'), 'Command');
  assert.equal(sync.normalizeCategory(2), 'Command');
  // ClaudeMd is enum 0 — falsy, and must NOT be mistaken for "absent"
  // (the KBT-B531 lesson, applied here as well).
  assert.equal(sync.normalizeCategory(0), 'ClaudeMd');

  // Anything we cannot place is null — never a silent skip.
  assert.equal(sync.normalizeCategory(99), null);
  assert.equal(sync.normalizeCategory('Nonsense'), null);
  assert.equal(sync.normalizeCategory(undefined), null);
  assert.equal(sync.normalizeCategory(null), null);
  assert.equal(sync.normalizeCategory(''), null);
});

test('KBT-TC3308: targetPathFor routes integer categories to the same paths as their names', () => {
  assert.equal(sync.targetPathFor(1, 'foo'), '.claude/commands/foo.md');
  assert.equal(sync.targetPathFor(6, 'bar'), '.claude/agents/bar.md');
  assert.equal(sync.targetPathFor('Skill', 'foo'), '.claude/commands/foo.md');
  assert.equal(sync.targetPathFor('Subagent', 'bar'), '.claude/agents/bar.md');
  // Non-materializable categories keep returning null in both shapes.
  assert.equal(sync.targetPathFor(2, 'baz'), null);
  assert.equal(sync.targetPathFor('Command', 'baz'), null);
  assert.equal(sync.targetPathFor(99, 'baz'), null);
});

test('KBT-TC3308: raw REST-shaped input (integer category + integer model) syncs normally', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 1, title: '/rest-foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101', id: 'id-101' }),
      item({ category: 6, title: 'Rest Specialist', content: 'Bar body.\n', code: 'KBT-SAGN201', id: 'id-201', model: 0 }),
      item({ category: 2, title: 'npm run build', content: 'npm run build\n', code: 'KBT-CMND301', id: 'id-301' }),
    ];
    const s = sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    assert.equal(s.created, 2, 'Skill(1) + Subagent(6) materialize; Command(2) is skipped');
    assert.equal(s.deleted, 0);

    assert.ok(readFileOrNull(path.join(root, '.claude/commands/rest-foo.md')));
    const agn = readFileOrNull(path.join(root, '.claude/agents/rest-specialist.md'));
    assert.ok(agn);
    // The canonical category travels onward, so the Subagent still gets `name:`
    // and its integer model still resolves (0 = Opus, per KBT-B531).
    assert.match(agn, /^---\nname: rest-specialist\n/);
    assert.match(agn, /\nmodel: opus\n/);

    // The manifest records canonical enum NAMES, never the integers.
    const manifest = readManifest(root);
    assert.deepEqual(manifest.items.map(i => i.category).sort(), ['Skill', 'Subagent']);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3308: a string-shaped and an integer-shaped run produce byte-identical output', () => {
  const rootA = mkTmpRoot();
  const rootB = mkTmpRoot();
  try {
    const asNames = [
      item({ category: 'Skill', title: '/twin — Twin', content: 'Body.\n', code: 'KBT-SKIL101', id: 'id-101' }),
      item({ category: 'Subagent', title: 'Twin Agent', content: 'Agent body.\n', code: 'KBT-SAGN201', id: 'id-201', model: 'Sonnet' }),
    ];
    const asIntegers = [
      item({ category: 1, title: '/twin — Twin', content: 'Body.\n', code: 'KBT-SKIL101', id: 'id-101' }),
      item({ category: 6, title: 'Twin Agent', content: 'Agent body.\n', code: 'KBT-SAGN201', id: 'id-201', model: 1 }),
    ];
    sync.runSync({ rootDir: rootA, items: asNames, workspace: 'kanbantic', now: FIXED_NOW });
    sync.runSync({ rootDir: rootB, items: asIntegers, workspace: 'kanbantic', now: FIXED_NOW });

    for (const rel of ['.claude/commands/twin.md', '.claude/agents/twin-agent.md', '.kanbantic-sync.json']) {
      assert.equal(
        fs.readFileSync(path.join(rootB, rel), 'utf8'),
        fs.readFileSync(path.join(rootA, rel), 'utf8'),
        rel + ' must not depend on which shape the caller used'
      );
    }
  } finally {
    cleanup(rootA);
    cleanup(rootB);
  }
});

test('KBT-TC3308: an unrecognised category on an active item aborts before any write', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill', title: '/foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101', id: 'id-101' }),
      item({ category: 42, title: 'Mystery Item', content: 'x\n', code: 'KBT-XXXX999', id: 'id-999' }),
    ];
    let caught = null;
    try {
      sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    } catch (e) { caught = e; }

    assert.ok(caught, 'expected runSync to throw on an unrecognised category');
    assert.equal(caught.name, 'SyncError');
    assert.equal(caught.kind, 'UNKNOWN_CATEGORY');
    // The message must show what actually arrived — that is what turns a
    // 30-minute debug session into a 30-second one.
    assert.match(caught.message, /KBT-XXXX999/);
    assert.match(caught.message, /42/);
    assert.equal(caught.data.unknownCategories.length, 1);

    // Nothing written — not even the item that WAS valid.
    assert.equal(readFileOrNull(path.join(root, '.claude/commands/foo.md')), null);
    assert.equal(readFileOrNull(path.join(root, '.kanbantic-sync.json')), null);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3308: a partially unrecognised list aborts and leaves an existing manifest byte-identical', () => {
  const root = mkTmpRoot();
  try {
    const good = [
      item({ category: 'Skill', title: '/foo — Foo helper', content: 'Foo body.\n', code: 'KBT-SKIL101', id: 'id-101' }),
      item({ category: 'Subagent', title: 'Bar Specialist', content: 'Bar body.\n', code: 'KBT-SAGN201', id: 'id-201' }),
    ];
    sync.runSync({ rootDir: root, items: good, workspace: 'kanbantic', now: FIXED_NOW });
    const manifestBefore = fs.readFileSync(path.join(root, '.kanbantic-sync.json'), 'utf8');
    const cmdBefore = fs.readFileSync(path.join(root, '.claude/commands/foo.md'), 'utf8');
    const agnBefore = fs.readFileSync(path.join(root, '.claude/agents/bar-specialist.md'), 'utf8');

    // Same two items, but one now carries a category we cannot place. This is
    // the scenario that used to wipe the WHOLE mirror set: unrecognised items
    // were skipped, so their manifest entries read as deletions.
    const mixed = [
      good[0],
      Object.assign({}, good[1], { category: 'Subagentt' }),
    ];
    assert.throws(
      () => sync.runSync({ rootDir: root, items: mixed, workspace: 'kanbantic', now: FIXED_NOW }),
      (e) => e.kind === 'UNKNOWN_CATEGORY'
    );

    assert.equal(fs.readFileSync(path.join(root, '.kanbantic-sync.json'), 'utf8'), manifestBefore,
      '.kanbantic-sync.json must be byte-identical after a rejected run');
    assert.equal(fs.readFileSync(path.join(root, '.claude/commands/foo.md'), 'utf8'), cmdBefore);
    assert.equal(fs.readFileSync(path.join(root, '.claude/agents/bar-specialist.md'), 'utf8'), agnBefore);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3308: a list mixing enum names and enum integers is fully recognised — it does NOT abort', () => {
  // The test case was written before the fix and read "mixed" as
  // "partially recognised". Now that both shapes normalise, a name/integer mix
  // is fully recognised, and only a genuinely unplaceable value aborts — which
  // the two tests above cover.
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 'Skill', title: '/named — Named', content: 'A\n', code: 'KBT-SKIL101', id: 'id-101' }),
      item({ category: 6, title: 'Numbered Agent', content: 'B\n', code: 'KBT-SAGN201', id: 'id-201' }),
    ];
    const s = sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    assert.equal(s.created, 2);
    assert.ok(readFileOrNull(path.join(root, '.claude/commands/named.md')));
    assert.ok(readFileOrNull(path.join(root, '.claude/agents/numbered-agent.md')));
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3308 (CLI): raw REST-shaped input exits 2 only when a category is unplaceable', () => {
  const root = mkTmpRoot();
  try {
    const items = [
      item({ category: 1, title: '/cli-rest — CLI rest', content: 'A\n', code: 'KBT-SKIL101', id: 'id-101' }),
      item({ category: 77, title: 'Bad Category', content: 'B\n', code: 'KBT-SAGN201', id: 'id-201' }),
    ];
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--workspace', 'kanbantic'], {
      input: JSON.stringify(items), encoding: 'utf8',
    });
    assert.equal(r.status, 2, 'expected exit 2, got ' + r.status + '; stderr: ' + r.stderr);
    assert.match(r.stderr, /UNKNOWN_CATEGORY/);
    assert.match(r.stderr, /KBT-SAGN201/);
    assert.equal(readFileOrNull(path.join(root, '.kanbantic-sync.json')), null);

    // Drop the bad item and the same integer shape sails through.
    const r2 = spawnSync(process.execPath, [SCRIPT, '--root', root, '--workspace', 'kanbantic'], {
      input: JSON.stringify([items[0]]), encoding: 'utf8',
    });
    assert.equal(r2.status, 0, 'expected exit 0, got ' + r2.status + '; stderr: ' + r2.stderr);
    assert.match(r2.stdout, /created=1/);
  } finally {
    cleanup(root);
  }
});

// --- KBT-B489 / KBT-TC3304 -------------------------------------------------

/** Three distinct active items — ids and codes unique so the guard can match on them. */
function trio() {
  return [
    item({ category: 'Skill', title: '/alpha — Alpha', content: 'Alpha body.\n', code: 'KBT-SKIL101', id: 'id-101' }),
    item({ category: 'Subagent', title: 'Beta Specialist', content: 'Beta body.\n', code: 'KBT-SAGN201', id: 'id-201' }),
    item({ category: 'Subagent', title: 'Gamma Specialist', content: 'Gamma body.\n', code: 'KBT-SAGN202', id: 'id-202' }),
  ];
}

/** Snapshot every mirror file + the manifest, as raw bytes. */
function snapshot(root) {
  const out = {};
  for (const rel of ['.claude/commands', '.claude/agents']) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      out[rel + '/' + f] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
  }
  out['.kanbantic-sync.json'] = readFileOrNull(path.join(root, '.kanbantic-sync.json'));
  return out;
}

test('KBT-TC3304: an incomplete item list aborts before any write', () => {
  const root = mkTmpRoot();
  try {
    const items = trio();
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    const before = snapshot(root);
    assert.equal(Object.keys(before).length, 4, 'baseline: three mirrors + manifest');

    // Drop the two Subagents — exactly what a truncated list_toolkit_items page
    // looks like. Before the guard this reported a cheerful `deleted=2`.
    let caught = null;
    try {
      sync.runSync({ rootDir: root, items: [items[0]], workspace: 'kanbantic', now: FIXED_NOW });
    } catch (e) { caught = e; }

    assert.ok(caught, 'expected runSync to throw on an incomplete item list');
    assert.equal(caught.name, 'SyncError');
    assert.equal(caught.kind, 'INCOMPLETE_INPUT');
    // The message must name the slugs that went missing.
    assert.match(caught.message, /beta-specialist/);
    assert.match(caught.message, /gamma-specialist/);
    assert.equal(caught.data.missingFromInput.length, 2);

    // Not one byte moved.
    assert.deepEqual(snapshot(root), before);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3304: a complete list still syncs — deleted=0, every mirror intact', () => {
  const root = mkTmpRoot();
  try {
    const items = trio();
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    const s = sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    assert.equal(s.deleted, 0);
    assert.equal(s.unchanged, 3);
    assert.equal(s.warnings, 0);
    assert.ok(readFileOrNull(path.join(root, '.claude/commands/alpha.md')));
    assert.ok(readFileOrNull(path.join(root, '.claude/agents/beta-specialist.md')));
    assert.ok(readFileOrNull(path.join(root, '.claude/agents/gamma-specialist.md')));
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3304: a genuine deactivation still deletes — the guard blocks omission, not intent', () => {
  const root = mkTmpRoot();
  try {
    const items = trio();
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    // Gamma stays IN the list, flagged inactive. That is the signal the guard
    // looks for, and the whole reason it can tell the two cases apart.
    const withDeactivated = [items[0], items[1], Object.assign({}, items[2], { isActive: false })];
    const s = sync.runSync({ rootDir: root, items: withDeactivated, workspace: 'kanbantic', now: FIXED_NOW });

    assert.equal(s.deleted, 1);
    assert.equal(s.warnings, 0);
    assert.equal(readFileOrNull(path.join(root, '.claude/agents/gamma-specialist.md')), null);
    const manifest = readManifest(root);
    assert.equal(manifest.items.length, 2);
    assert.equal(manifest.items.find(e => e.slug === 'gamma-specialist'), undefined);
    // The other two survived.
    assert.ok(readFileOrNull(path.join(root, '.claude/commands/alpha.md')));
    assert.ok(readFileOrNull(path.join(root, '.claude/agents/beta-specialist.md')));
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3304: --force waives the guard, for items hard-deleted from the Toolkit', () => {
  const root = mkTmpRoot();
  try {
    const items = trio();
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    const s = sync.runSync({ rootDir: root, items: [items[0]], workspace: 'kanbantic', now: FIXED_NOW, force: true });
    assert.equal(s.deleted, 2);
    assert.equal(readFileOrNull(path.join(root, '.claude/agents/beta-specialist.md')), null);
    assert.ok(readFileOrNull(path.join(root, '.claude/commands/alpha.md')));
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3304: renaming a toolkit item is not mistaken for an omission', () => {
  const root = mkTmpRoot();
  try {
    const items = trio();
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });

    // Same id + code, new title => new slug. The old slug is absent from the
    // input, but the item plainly still exists, so this must not abort.
    const renamed = [
      items[0], items[1],
      Object.assign({}, items[2], { title: 'Delta Specialist' }),
    ];
    const s = sync.runSync({ rootDir: root, items: renamed, workspace: 'kanbantic', now: FIXED_NOW });

    assert.equal(s.created, 1, 'the new slug is materialized');
    assert.equal(s.deleted, 1, 'the old slug is retired');
    assert.ok(readFileOrNull(path.join(root, '.claude/agents/delta-specialist.md')));
    assert.equal(readFileOrNull(path.join(root, '.claude/agents/gamma-specialist.md')), null);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3304: an empty list against a populated manifest aborts instead of wiping everything', () => {
  const root = mkTmpRoot();
  try {
    sync.runSync({ rootDir: root, items: trio(), workspace: 'kanbantic', now: FIXED_NOW });
    const before = snapshot(root);

    assert.throws(
      () => sync.runSync({ rootDir: root, items: [], workspace: 'kanbantic', now: FIXED_NOW }),
      (e) => e.kind === 'INCOMPLETE_INPUT'
    );
    assert.deepEqual(snapshot(root), before);
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3304 (CLI): an incomplete list exits 2 and names the missing slugs', () => {
  const root = mkTmpRoot();
  try {
    const items = trio();
    sync.runSync({ rootDir: root, items, workspace: 'kanbantic', now: FIXED_NOW });
    const before = snapshot(root);

    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--workspace', 'kanbantic'], {
      input: JSON.stringify([items[0]]), encoding: 'utf8',
    });
    assert.equal(r.status, 2, 'expected exit 2, got ' + r.status + '; stdout: ' + r.stdout + '; stderr: ' + r.stderr);
    assert.match(r.stderr, /INCOMPLETE_INPUT/);
    assert.match(r.stderr, /beta-specialist/);
    assert.deepEqual(snapshot(root), before);

    // The complete list, over the CLI, is still a clean no-op.
    const r2 = spawnSync(process.execPath, [SCRIPT, '--root', root, '--workspace', 'kanbantic'], {
      input: JSON.stringify(items), encoding: 'utf8',
    });
    assert.equal(r2.status, 0, 'expected exit 0, got ' + r2.status + '; stderr: ' + r2.stderr);
    assert.match(r2.stdout, /deleted=0/);
  } finally {
    cleanup(root);
  }
});
