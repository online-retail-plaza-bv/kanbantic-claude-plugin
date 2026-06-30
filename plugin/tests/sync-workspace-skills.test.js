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
