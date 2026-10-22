'use strict';

//
// disk-space.test.js — KBT-F754 / KBT-TC4231
//
// The measurement half of the disk cleanup. The one property that matters is
// in `analyzeWorktrees`: a worktree is `safeToRemove` ONLY when it is an agent
// worktree, clean, fully on the remote and unlocked. Everything else must come
// back `false` with a reason. A false positive here is a deleted day of work;
// the fixture therefore builds all three shapes side by side in one real git
// repository and asserts the verdict on each.
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'disk-space.js');
const d = require(SCRIPT);

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(root) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

/**
 * One repo, four worktrees:
 *   .claude/worktrees/clean     — agent worktree, clean, HEAD on origin/main   → safe
 *   .claude/worktrees/dirty     — agent worktree with an untracked file        → unsafe
 *   .claude/worktrees/unpushed  — agent worktree with a local-only commit      → unsafe
 *   ../plain                    — clean, but not under .claude/worktrees       → unsafe
 */
function fixtureRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f754-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  initRepo(root);
  const wtRoot = path.join(root, '.claude', 'worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });

  git(root, 'worktree', 'add', '-q', '-b', 'wt/clean', path.join(wtRoot, 'clean'));

  git(root, 'worktree', 'add', '-q', '-b', 'wt/dirty', path.join(wtRoot, 'dirty'));
  fs.writeFileSync(path.join(wtRoot, 'dirty', 'scratch.txt'), 'not committed\n');

  git(root, 'worktree', 'add', '-q', '-b', 'wt/unpushed', path.join(wtRoot, 'unpushed'));
  fs.writeFileSync(path.join(wtRoot, 'unpushed', 'work.txt'), 'committed locally\n');
  git(path.join(wtRoot, 'unpushed'), 'add', '-A');
  git(path.join(wtRoot, 'unpushed'), 'commit', '-q', '-m', 'local only');

  git(root, 'worktree', 'add', '-q', '-b', 'wt/plain', path.join(base, 'plain'));

  return { base, root, wtRoot };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── freeSpace ───────────────────────────────────────────────────────────────

test('freeSpace reports a positive free/total for the cwd volume', () => {
  const v = d.freeSpace(process.cwd());
  assert.ok(v, 'statfs must be available on the supported Node versions');
  assert.ok(v.totalBytes > 0);
  assert.ok(v.freeBytes >= 0 && v.freeBytes <= v.totalBytes);
  assert.equal(v.usedBytes, v.totalBytes - v.freeBytes);
  assert.ok(v.path.length > 0);
});

test('freeSpace returns null for a path that does not exist instead of throwing', () => {
  assert.equal(d.freeSpace(path.join(os.tmpdir(), `no-such-${Date.now()}`)), null);
});

// ─── dirSize ─────────────────────────────────────────────────────────────────

test('dirSize sums files recursively and never follows a symlink or junction', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f754-size-'));
  try {
    const target = path.join(base, 'target');
    fs.mkdirSync(path.join(target, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(target, 'a.bin'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(target, 'deep', 'b.bin'), Buffer.alloc(500));

    const dir = path.join(base, 'dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'c.bin'), Buffer.alloc(10));
    let linked = true;
    try {
      // 'junction' works without privileges on Windows; elsewhere it is a plain symlink.
      fs.symlinkSync(target, path.join(dir, 'link'), 'junction');
    } catch {
      linked = false;
    }

    assert.deepEqual(
      { bytes: d.dirSize(target).bytes, files: d.dirSize(target).files },
      { bytes: 1500, files: 2 });
    const m = d.dirSize(dir);
    assert.equal(m.bytes, 10, linked
      ? 'the junction into target must not be counted — following it is how a shared node_modules gets wiped'
      : 'plain directory size');
    assert.equal(m.files, 1);
    assert.equal(m.truncated, false);
  } finally {
    cleanup(base);
  }
});

test('dirSize marks the result truncated past maxEntries instead of walking forever', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f754-trunc-'));
  try {
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(base, `f${i}`), 'x');
    const m = d.dirSize(base, { maxEntries: 5 });
    assert.equal(m.truncated, true);
    assert.ok(m.files <= 5);
  } finally {
    cleanup(base);
  }
});

// ─── cachePaths ──────────────────────────────────────────────────────────────

test('cachePaths: win32 resolves LOCALAPPDATA-based caches and the Docker VHDX', () => {
  const list = d.cachePaths({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    home: 'C:\\Users\\u',
    tmpdir: 'C:\\Users\\u\\AppData\\Local\\Temp',
  });
  const byKey = Object.fromEntries(list.map((c) => [c.key, c]));
  assert.match(byKey.npm.path, /npm-cache$/);
  assert.match(byKey['nuget-packages'].path, /[\\/]\.nuget[\\/]packages$/);
  assert.match(byKey['nuget-http'].path, /NuGet[\\/]v3-cache$/);
  assert.match(byKey.playwright.path, /ms-playwright$/);
  assert.match(byKey['docker-vhdx'].path, /docker_data\.vhdx$/);
  assert.equal(byKey['docker-vhdx'].kind, 'file');
  assert.equal(byKey.temp.path, 'C:\\Users\\u\\AppData\\Local\\Temp');
});

test('cachePaths: linux uses ~/.npm and XDG cache, and has no Docker Desktop disk', () => {
  const list = d.cachePaths({ platform: 'linux', env: {}, home: '/home/u', tmpdir: '/tmp' });
  const byKey = Object.fromEntries(list.map((c) => [c.key, c]));
  assert.equal(byKey.npm.path, path.join('/home/u', '.npm'));
  assert.equal(byKey.playwright.path, path.join('/home/u', '.cache', 'ms-playwright'));
  assert.equal(byKey.pip.path, path.join('/home/u', '.cache', 'pip'));
  assert.ok(!('docker-vhdx' in byKey) && !('docker-raw' in byKey));
});

test('cachePaths: darwin uses Library/Caches and the Docker.raw data disk', () => {
  const list = d.cachePaths({ platform: 'darwin', env: {}, home: '/Users/u', tmpdir: '/tmp' });
  const byKey = Object.fromEntries(list.map((c) => [c.key, c]));
  assert.equal(byKey.playwright.path, path.join('/Users/u', 'Library', 'Caches', 'ms-playwright'));
  assert.match(byKey['docker-raw'].path, /Docker\.raw$/);
});

test('cachePaths: explicit env overrides win over platform defaults', () => {
  const list = d.cachePaths({
    platform: 'linux',
    env: { NUGET_PACKAGES: '/mnt/nuget', PLAYWRIGHT_BROWSERS_PATH: '/mnt/pw', npm_config_cache: '/mnt/npm' },
    home: '/home/u',
    tmpdir: '/tmp',
  });
  const byKey = Object.fromEntries(list.map((c) => [c.key, c]));
  assert.equal(byKey['nuget-packages'].path, '/mnt/nuget');
  assert.equal(byKey.playwright.path, '/mnt/pw');
  assert.equal(byKey.npm.path, '/mnt/npm');
});

test('measureCache reports exists=false with null size for an absent path', () => {
  const m = d.measureCache({ key: 'x', label: 'x', path: path.join(os.tmpdir(), `absent-${Date.now()}`), kind: 'dir' });
  assert.equal(m.exists, false);
  assert.equal(m.bytes, null);
});

// ─── measureTemp ─────────────────────────────────────────────────────────────

test('measureTemp lists only entries older than the age, and always skips the Claude scratchpad', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f754-temp-'));
  try {
    const now = Date.now();
    const old = new Date(now - 5 * 86400000);
    fs.mkdirSync(path.join(tmp, 'old-installer'));
    fs.writeFileSync(path.join(tmp, 'old-installer', 'setup.exe'), Buffer.alloc(2048));
    fs.utimesSync(path.join(tmp, 'old-installer'), old, old);
    fs.writeFileSync(path.join(tmp, 'fresh.log'), 'today');
    fs.mkdirSync(path.join(tmp, 'claude'));
    fs.writeFileSync(path.join(tmp, 'claude', 'scratch.txt'), 'in use');
    fs.utimesSync(path.join(tmp, 'claude'), old, old);

    const t = d.measureTemp(tmp, { ageDays: 2, now });
    assert.equal(t.exists, true);
    assert.deepEqual(t.staleEntries.map((e) => e.name), ['old-installer']);
    assert.equal(t.staleEntries[0].bytes, 2048);
    assert.equal(t.staleBytes, 2048);
    assert.deepEqual(t.skipped, ['claude'],
      'the running session scratchpad is in use even when its mtime is old');
    assert.ok(t.bytes >= 2048 + 5);
  } finally {
    cleanup(tmp);
  }
});

// ─── worktrees ───────────────────────────────────────────────────────────────

test('parseWorktreePorcelain reads path, HEAD, branch, locked and prunable', () => {
  const text = [
    'worktree /r',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree /r/.claude/worktrees/x',
    'HEAD bbbb',
    'branch refs/heads/feature/x',
    'locked agent pid 123',
    '',
    'worktree /r/.claude/worktrees/gone',
    'HEAD cccc',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  const rows = d.parseWorktreePorcelain(text);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].branch, 'feature/x');
  assert.equal(rows[1].locked, true);
  assert.equal(rows[1].lockReason, 'agent pid 123');
  assert.equal(rows[2].detached, true);
  assert.equal(rows[2].prunable, true);
});

test('isAgentWorktree recognises the .claude/worktrees segment only', () => {
  assert.equal(d.isAgentWorktree(path.join('r', '.claude', 'worktrees', 'x')), true);
  assert.equal(d.isAgentWorktree(path.join('r', 'worktrees', 'x')), false);
  assert.equal(d.isAgentWorktree(path.join('r', '.claude', 'x')), false);
});

test('analyzeWorktrees: only the clean, pushed, agent worktree is safeToRemove', () => {
  const fx = fixtureRepo();
  try {
    const rows = d.analyzeWorktrees(fx.root, { sizes: false });
    assert.ok(Array.isArray(rows));
    const byName = Object.fromEntries(rows.map((w) => [path.basename(w.path), w]));
    assert.deepEqual(Object.keys(byName).sort(), ['clean', 'dirty', 'plain', 'unpushed'],
      'the main checkout must never appear as a candidate');

    assert.equal(byName.clean.safeToRemove, true, JSON.stringify(byName.clean.reasons));
    assert.equal(byName.clean.dirty, 0);
    assert.equal(byName.clean.unpushed, 0);
    assert.equal(byName.clean.comparedTo, 'origin/main');

    assert.equal(byName.dirty.safeToRemove, false);
    assert.equal(byName.dirty.dirty, 1);
    assert.match(byName.dirty.reasons.join(' '), /niet-gecommitte/);

    assert.equal(byName.unpushed.safeToRemove, false);
    assert.equal(byName.unpushed.unpushed, 1);
    assert.match(byName.unpushed.reasons.join(' '), /niet op de remote/);

    assert.equal(byName.plain.safeToRemove, false);
    assert.match(byName.plain.reasons.join(' '), /geen agent-worktree/);
  } finally {
    cleanup(fx.base);
  }
});

test('analyzeWorktrees: a worktree with no remote reference at all is NOT safe', () => {
  // "I cannot tell whether this is pushed" must read as "do not delete".
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f754-noremote-'));
  try {
    const root = path.join(base, 'repo');
    fs.mkdirSync(root);
    initRepo(root);
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
    const wt = path.join(root, '.claude', 'worktrees', 'orphan');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(root, 'worktree', 'add', '-q', '-b', 'wt/orphan', wt);
    const rows = d.analyzeWorktrees(root, { sizes: false });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unpushed, null);
    assert.equal(rows[0].safeToRemove, false);
    assert.match(rows[0].reasons.join(' '), /geen remote-referentie/);
  } finally {
    cleanup(base);
  }
});

test('analyzeWorktrees returns null outside a git repository', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f754-nogit-'));
  try {
    // Guard against a parent directory that happens to be a repo (e.g. tmp under a checkout).
    const r = spawnSync('git', ['-C', base, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (r.status === 0) return; // cannot assert in this environment
    assert.equal(d.analyzeWorktrees(base, { sizes: false }), null);
  } finally {
    cleanup(base);
  }
});

test('discoverRepos: a folder full of repositories expands to each repo', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f754-roots-'));
  try {
    for (const name of ['a', 'b']) {
      const r = path.join(base, name);
      fs.mkdirSync(r);
      initRepo(r);
    }
    fs.mkdirSync(path.join(base, 'not-a-repo'));
    const found = d.discoverRepos({ cwd: path.join(base, 'a'), repos: [base] });
    const names = found.map((p) => path.basename(p)).sort();
    assert.deepEqual(names, ['a', 'b']);
    const withSiblings = d.discoverRepos({ cwd: path.join(base, 'a'), siblings: true });
    assert.deepEqual(withSiblings.map((p) => path.basename(p)).sort(), ['a', 'b']);
  } finally {
    cleanup(base);
  }
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

test('parseArgs understands every documented flag and rejects unknown ones', () => {
  const o = d.parseArgs(['--json', '--siblings', '--no-sizes', '--repos', 'a,b', '--repos=c', '--temp-age-days', '5', '--path=/x']);
  assert.deepEqual(o, { json: true, path: '/x', repos: ['a', 'b', 'c'], siblings: true, sizes: false, tempAgeDays: 5, help: false });
  assert.throws(() => d.parseArgs(['--bogus']), /onbekend argument/);
  assert.throws(() => d.parseArgs(['--temp-age-days', 'x']), /getal/);
});

test('the CLI prints a JSON inventory with the four blocks and never deletes anything', () => {
  const fx = fixtureRepo();
  try {
    const before = fs.readdirSync(fx.wtRoot).sort();
    const r = spawnSync(process.execPath, [SCRIPT, '--json', '--no-sizes'], { cwd: fx.root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const inv = JSON.parse(r.stdout);
    for (const key of ['measuredAt', 'volume', 'repos', 'temp', 'caches', 'summary']) assert.ok(key in inv, key);
    assert.equal(inv.repos.length, 1);
    assert.equal(inv.summary.worktreesTotal, 4);
    assert.equal(inv.summary.worktreesSafe, 1);
    assert.equal(inv.sizesMeasured, false);
    assert.deepEqual(fs.readdirSync(fx.wtRoot).sort(), before, 'measuring must leave the tree untouched');

    const text = spawnSync(process.execPath, [SCRIPT, '--no-sizes'], { cwd: fx.root, encoding: 'utf8' });
    assert.equal(text.status, 0);
    assert.match(text.stdout, /# Schijfinventaris/);
    assert.match(text.stdout, /Post 1 — agent-worktrees/);
    assert.match(text.stdout, /\| \.claude[\\/]worktrees[\\/]clean \| wt\/clean \|[^\n]*\| ja \|/);
    assert.match(text.stdout, /\| \.claude[\\/]worktrees[\\/]dirty \| wt\/dirty \|[^\n]*\| NEE \|/);
  } finally {
    cleanup(fx.base);
  }
});
