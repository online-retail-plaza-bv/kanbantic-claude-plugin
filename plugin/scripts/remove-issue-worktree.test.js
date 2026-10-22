'use strict';

//
// remove-issue-worktree.test.js — KBT-F745 / KBT-SR653 §Plugin / KBT-TC4222
//
// Exercises plugin/scripts/remove-issue-worktree.js against a throw-away git
// repository with real worktrees. The script is the review-lane counterpart of
// the daemon's HygieneService (KBT-RL277 §8): after the merge the review-skill
// removes the issue's worktree itself instead of leaving it for the nightly
// run. Four behaviours are pinned here:
//
//   1. a worktree on the merged branch is removed and pruned (`git worktree
//      list` no longer carries it);
//   2. run from INSIDE that worktree the script refuses with reason
//      `cwd-inside-worktree` and touches nothing — `git worktree remove` from
//      within the worktree fails and leaves an orphan directory (KBT-GTCH142);
//   3. (Windows only) junctions under `node_modules` are detached BEFORE the
//      removal, so `--force` cannot empty the junction's target (KBT-GTCH187);
//   4. an unknown branch yields `no-worktree`, still exit 0 (fail-open).
//
// Zero deps — node:test + a real `git` on PATH.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, 'remove-issue-worktree.js');
const IS_WIN = process.platform === 'win32';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

// Canonical form for path comparison: real path (expands Windows 8.3 names such
// as ADMIN1~1), forward slashes, case-folded on Windows, no trailing slash.
function norm(p) {
  let real = p;
  try { real = fs.realpathSync.native(p); } catch { /* gone — compare as given */ }
  let s = path.resolve(real).replace(/\\/g, '/').replace(/\/+$/, '');
  if (IS_WIN) s = s.toLowerCase();
  return s;
}

// Detach reparse points / symlinks before rmSync so a leftover junction can
// never make the cleanup walk into (and delete) a directory outside the temp
// root. Mirrors what the script under test must do, but independently.
function detachLinks(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      try { fs.rmdirSync(full); } catch { try { fs.unlinkSync(full); } catch { /* ignore */ } }
      continue;
    }
    if (st.isDirectory()) detachLinks(full);
  }
}

function makeRepo(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f745-wt-')));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'f745@example.invalid'], repo);
  git(['config', 'user.name', 'KBT-F745 test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'f745\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  t.after(() => {
    detachLinks(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, repo };
}

function addWorktree(repo, branch, name) {
  const wt = path.join(repo, '.claude', 'worktrees', name);
  git(['worktree', 'add', '-q', '-b', branch, wt], repo);
  return wt;
}

function worktreePaths(repo) {
  return git(['worktree', 'list', '--porcelain'], repo)
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => norm(l.slice('worktree '.length)));
}

function runScript(args, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch { /* asserted by callers */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// ── 1. happy path: merged branch's worktree is removed and pruned ─────────────

test('removes the worktree of the given branch from the main checkout and prunes it', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/X', 'X');
  assert.ok(worktreePaths(repo).includes(norm(wt)), 'precondition: worktree registered');

  const r = runScript(['--branch', 'feature/X'], repo);

  assert.equal(r.code, 0, `exit 0 expected; stderr: ${r.stderr}`);
  assert.ok(r.json, `stdout must be one JSON object; got: ${r.stdout}`);
  assert.equal(r.json.removed, true, JSON.stringify(r.json));
  assert.equal(norm(r.json.path), norm(wt));
  assert.equal(fs.existsSync(wt), false, 'worktree directory is gone');
  assert.ok(!worktreePaths(repo).includes(norm(wt)), 'git worktree list no longer carries it');
  // The local branch is NOT the script's business — the review-skill deletes it.
  const branches = git(['branch', '--list', 'feature/X'], repo);
  assert.match(branches, /feature\/X/, 'local branch survives (git branch -d is the skill\'s job)');
});

test('--path works as an alternative selector (case-insensitive on Windows)', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/P', 'P');
  const given = IS_WIN ? wt.toUpperCase() : wt;

  const r = runScript(['--path', given], repo);

  assert.equal(r.code, 0);
  assert.equal(r.json && r.json.removed, true, r.stdout);
  assert.equal(fs.existsSync(wt), false);
});

// ── 2. KBT-GTCH142: never from inside the worktree ───────────────────────────

test('refuses with cwd-inside-worktree when run from inside the worktree and removes nothing', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/Y', 'Y');
  const sub = path.join(wt, 'src');
  fs.mkdirSync(sub);

  for (const cwd of [wt, sub]) {
    const r = runScript(['--branch', 'feature/Y'], cwd);
    assert.equal(r.code, 0, `fail-open: exit 0 even when refusing; stderr: ${r.stderr}`);
    assert.ok(r.json, r.stdout);
    assert.equal(r.json.removed, false);
    assert.equal(r.json.reason, 'cwd-inside-worktree');
    assert.equal(norm(r.json.path), norm(wt));
    assert.match(r.stderr, /cwd-inside-worktree|binnen de worktree|inside the worktree/i, 'warning on stderr');
  }
  assert.equal(fs.existsSync(path.join(wt, 'README.md')), true, 'nothing removed');
  assert.ok(worktreePaths(repo).includes(norm(wt)), 'worktree still registered');
});

// ── 3. KBT-GTCH187: junctions under node_modules are detached first (Windows) ─

test('detaches node_modules junctions before removal; the junction target stays intact (Windows)', (t) => {
  if (!IS_WIN) {
    t.skip('junction semantics are Windows-only (KBT-GTCH187)');
    return;
  }
  const { root, repo } = makeRepo(t);

  // Shared target OUTSIDE the worktree — the thing `--force` must never empty.
  const shared = path.join(root, 'shared-node-modules');
  fs.mkdirSync(path.join(shared, 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'left-pad', 'index.js'), 'module.exports = 1;\n');
  const sharedPkg = path.join(root, 'shared-pkg');
  fs.mkdirSync(sharedPkg);
  fs.writeFileSync(path.join(sharedPkg, 'index.js'), 'module.exports = 2;\n');

  // Worktree A: node_modules ITSELF is a junction (the KBT-GTCH187 shape).
  const wtA = addWorktree(repo, 'feature/J1', 'J1');
  fs.symlinkSync(shared, path.join(wtA, 'node_modules'), 'junction');
  // Worktree B: node_modules is a real dir with a junction child, one level down.
  const wtB = addWorktree(repo, 'feature/J2', 'J2');
  fs.mkdirSync(path.join(wtB, 'sub', 'node_modules'), { recursive: true });
  fs.symlinkSync(sharedPkg, path.join(wtB, 'sub', 'node_modules', 'shared-pkg'), 'junction');

  assert.ok(fs.lstatSync(path.join(wtA, 'node_modules')).isSymbolicLink(), 'precondition: junction A');
  assert.ok(fs.lstatSync(path.join(wtB, 'sub', 'node_modules', 'shared-pkg')).isSymbolicLink(), 'precondition: junction B');

  const rA = runScript(['--branch', 'feature/J1'], repo);
  assert.equal(rA.code, 0, rA.stderr);
  assert.equal(rA.json && rA.json.removed, true, rA.stdout);
  assert.equal(fs.existsSync(wtA), false, 'worktree A gone');
  assert.equal(fs.existsSync(path.join(shared, 'left-pad', 'index.js')), true, 'junction target A intact');

  const rB = runScript(['--branch', 'feature/J2'], repo);
  assert.equal(rB.code, 0, rB.stderr);
  assert.equal(rB.json && rB.json.removed, true, rB.stdout);
  assert.equal(fs.existsSync(wtB), false, 'worktree B gone');
  assert.equal(fs.existsSync(path.join(sharedPkg, 'index.js')), true, 'junction target B intact');

  const left = worktreePaths(repo);
  assert.ok(!left.includes(norm(wtA)) && !left.includes(norm(wtB)), 'both pruned from git worktree list');
});

// ── 4. unknown branch → no-worktree, still exit 0 ────────────────────────────

test('unknown branch yields no-worktree with exit 0', (t) => {
  const { repo } = makeRepo(t);
  addWorktree(repo, 'feature/Z', 'Z');

  const r = runScript(['--branch', 'feature/does-not-exist'], repo);

  assert.equal(r.code, 0);
  assert.ok(r.json, r.stdout);
  assert.equal(r.json.removed, false);
  assert.equal(r.json.reason, 'no-worktree');
  assert.equal(worktreePaths(repo).length, 2, 'nothing else was touched');
});

test('refuses to remove the main checkout itself', (t) => {
  const { repo } = makeRepo(t);

  const r = runScript(['--branch', 'main'], repo);

  assert.equal(r.code, 0);
  assert.ok(r.json, r.stdout);
  assert.equal(r.json.removed, false);
  assert.equal(r.json.reason, 'main-worktree');
  assert.equal(fs.existsSync(path.join(repo, 'README.md')), true);
});

test('missing selector or non-git cwd is reported as a reason, not as a crash', (t) => {
  const { root, repo } = makeRepo(t);

  const noArgs = runScript([], repo);
  assert.equal(noArgs.code, 0);
  assert.equal(noArgs.json && noArgs.json.removed, false, noArgs.stdout);
  assert.equal(noArgs.json.reason, 'usage');

  const notGit = path.join(root, 'plain');
  fs.mkdirSync(notGit);
  const r = runScript(['--branch', 'feature/X'], notGit);
  assert.equal(r.code, 0);
  assert.equal(r.json && r.json.removed, false, r.stdout);
  assert.equal(r.json.reason, 'not-a-git-repo');
});

// ── 5. KBT-T5233 (Axon 09 finding I10): never destroy uncommitted work ────────
//
// `git worktree remove --force` used to run unconditionally, so uncommitted
// changes, untracked files and ignored files such as `.env` were wiped. The
// script now (a) refuses with `dirty` when `git status --porcelain --ignored`
// reports anything (reproducible build output such as node_modules excepted),
// (b) refuses with `in-use` when the worktree is locked or a live process holds
// a directory inside it, and (c) runs a PLAIN `git worktree remove`. The
// operator-only `--force` flag restores the old behaviour; the review-skill
// never passes it.

function assertRefused(r, reason, wt, repo) {
  assert.equal(r.code, 0, `fail-open: exit 0 even when refusing; stderr: ${r.stderr}`);
  assert.ok(r.json, r.stdout);
  assert.equal(r.json.removed, false, r.stdout);
  assert.equal(r.json.reason, reason, r.stdout);
  assert.equal(norm(r.json.path), norm(wt));
  assert.equal(fs.existsSync(path.join(wt, 'README.md')), true, 'nothing removed');
  assert.ok(worktreePaths(repo).includes(norm(wt)), 'worktree still registered');
}

test('dirty: a modified tracked file refuses with reason dirty and lists the path', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/D1', 'D1');
  fs.writeFileSync(path.join(wt, 'README.md'), 'uncommitted work\n');

  const r = runScript(['--branch', 'feature/D1'], repo);

  assertRefused(r, 'dirty', wt, repo);
  assert.ok(Array.isArray(r.json.paths), 'paths array in JSON');
  assert.ok(r.json.paths.some((p) => /README\.md$/.test(p)), JSON.stringify(r.json.paths));
  assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), 'uncommitted work\n', 'work survives');
  assert.match(r.stderr, /dirty/i);
});

test('dirty: an untracked file refuses with reason dirty', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/D2', 'D2');
  fs.writeFileSync(path.join(wt, 'notes.txt'), 'scratch\n');

  const r = runScript(['--branch', 'feature/D2'], repo);

  assertRefused(r, 'dirty', wt, repo);
  assert.ok(r.json.paths.some((p) => /notes\.txt$/.test(p)), JSON.stringify(r.json.paths));
  assert.equal(fs.existsSync(path.join(wt, 'notes.txt')), true, 'untracked file survives');
});

test('dirty: an IGNORED .env refuses with reason dirty (ignored files are work too)', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/D3', 'D3');
  fs.writeFileSync(path.join(wt, '.gitignore'), '.env\nnode_modules/\n');
  git(['add', '.gitignore'], wt);
  git(['commit', '-q', '-m', 'ignore'], wt);
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
  assert.equal(git(['status', '--porcelain'], wt).trim(), '', 'precondition: plain status is clean');

  const r = runScript(['--branch', 'feature/D3'], repo);

  assertRefused(r, 'dirty', wt, repo);
  assert.ok(r.json.paths.some((p) => /\.env$/.test(p)), JSON.stringify(r.json.paths));
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SECRET=1\n', '.env survives');
});

test('dirty: paths are capped at 10 with the full count alongside', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/D4', 'D4');
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(wt, `u${String(i).padStart(2, '0')}.txt`), 'x\n');

  const r = runScript(['--branch', 'feature/D4'], repo);

  assertRefused(r, 'dirty', wt, repo);
  assert.equal(r.json.paths.length, 10);
  assert.equal(r.json.pathCount, 12);
});

test('ignored reproducible build output (node_modules) alone does not count as dirty', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/D5', 'D5');
  fs.writeFileSync(path.join(wt, '.gitignore'), 'node_modules/\n');
  git(['add', '.gitignore'], wt);
  git(['commit', '-q', '-m', 'ignore'], wt);
  fs.mkdirSync(path.join(wt, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');

  const r = runScript(['--branch', 'feature/D5'], repo);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json && r.json.removed, true, r.stdout);
  assert.equal(fs.existsSync(wt), false, 'worktree gone');
});

test('in-use: a locked worktree is refused with reason in-use', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/L1', 'L1');
  git(['worktree', 'lock', '--reason', 'agent still running', wt], repo);

  const r = runScript(['--branch', 'feature/L1'], repo);

  assertRefused(r, 'in-use', wt, repo);
  assert.match(r.stderr, /lock/i);
});

test('in-use: a live process whose cwd is inside the worktree is refused (Windows)', async (t) => {
  if (!IS_WIN) {
    t.skip('cwd-handle rename probe is Windows-only');
    return;
  }
  const { spawn } = require('node:child_process');
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/L2', 'L2');
  const sub = path.join(wt, 'src');
  fs.mkdirSync(sub);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: sub, stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* already gone */ } });
  await new Promise((res) => setTimeout(res, 400)); // let the child settle on its cwd

  const r = runScript(['--branch', 'feature/L2'], repo);

  assertRefused(r, 'in-use', wt, repo);
  assert.equal(fs.existsSync(wt), true, 'worktree directory still at its original name after the probe');
  assert.match(r.stderr, /in-use|process/i);

  child.kill();
  await new Promise((res) => setTimeout(res, 400));
  const again = runScript(['--branch', 'feature/L2'], repo);
  assert.equal(again.json && again.json.removed, true, `removed once the process is gone: ${again.stdout}`);
});

test('--force (operator-only) removes a dirty worktree the old way', (t) => {
  const { repo } = makeRepo(t);
  const wt = addWorktree(repo, 'feature/F1', 'F1');
  fs.writeFileSync(path.join(wt, 'README.md'), 'uncommitted work\n');
  fs.writeFileSync(path.join(wt, 'notes.txt'), 'scratch\n');

  const r = runScript(['--branch', 'feature/F1', '--force'], repo);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json && r.json.removed, true, r.stdout);
  assert.equal(r.json.forced, true, 'JSON flags that --force was used');
  assert.equal(fs.existsSync(wt), false, 'worktree gone');
  assert.ok(!worktreePaths(repo).includes(norm(wt)));
});
