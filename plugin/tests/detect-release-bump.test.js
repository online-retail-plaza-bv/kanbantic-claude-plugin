'use strict';

//
// KBT-B545 — release-bump detector test.
//
// Drives plugin/scripts/detect-release-bump.js against synthetic git repositories,
// including the shape that actually matters: a --no-ff merge commit sitting on main,
// which is where `kanbantic-issue-review` Step 8.5 runs.
//
// The first version of this trigger lived as a bash snippet in the skill doc and
// compared against `git merge-base origin/main HEAD`. On a merge commit that has
// already been checked out on main, the merge-base IS HEAD, so it always answered
// "no release" — the entire safeguarding half of KBT-B545, permanently inert. Nothing
// caught it because prose is not executed. That is what this file is for.
//
// Zero deps — only node built-ins.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'plugin', 'scripts', 'detect-release-bump.js');
const { detectReleaseBump } = require(scriptPath);

const CARRIER = ['plugin', '.claude-plugin', 'plugin.json'];

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function writeVersion(root, version) {
  const dir = path.join(root, ...CARRIER.slice(0, -1));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(root, ...CARRIER),
    JSON.stringify({ name: 'kanbantic', version }, null, 2));
}

/** A repo with main at `mainVersion` and a merged feature branch at `branchVersion`. */
function repoWithMerge(mainVersion, branchVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b545-bump-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');

  writeVersion(root, mainVersion);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');

  git(root, 'checkout', '-q', '-b', 'feature');
  writeVersion(root, branchVersion);
  // Always change something else too, so the "version left alone" case still has a
  // commit to make — that is the whole point of that scenario.
  fs.writeFileSync(path.join(root, 'work.txt'), 'work\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'work');

  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '--no-ff', '-q', 'feature', '-m', 'Merge feature');
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('a --no-ff merge that bumped the version is detected as a release', () => {
  // The regression case. HEAD is the merge commit on main; the answer must come from
  // its first parent (pre-merge main), not from a merge-base against main itself.
  const root = repoWithMerge('2.36.0', '2.37.0');
  try {
    const r = detectReleaseBump(root);
    assert.deepEqual(r, { old: '2.36.0', new: '2.37.0', released: true });
  } finally {
    cleanup(root);
  }
});

test('a --no-ff merge that left the version alone is not a release', () => {
  const root = repoWithMerge('2.36.0', '2.36.0');
  try {
    const r = detectReleaseBump(root);
    assert.equal(r.released, false);
    assert.equal(r.new, '2.36.0');
  } finally {
    cleanup(root);
  }
});

test('an edit to the carrier file that leaves the version alone is not a release', () => {
  // Adding a field to plugin.json is not shipping anything. Firing a HARD-GATE on
  // every such merge trains agents to wave it through.
  const root = repoWithMerge('2.36.0', '2.36.0');
  try {
    const file = path.join(root, ...CARRIER);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    j.description = 'reworded';
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'reword');

    const r = detectReleaseBump(root);
    assert.equal(r.released, false);
  } finally {
    cleanup(root);
  }
});

test('a plain (non-merge) commit that bumped the version is detected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b545-bump-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    writeVersion(root, '2.37.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'bump');

    const r = detectReleaseBump(root);
    assert.deepEqual(r, { old: '2.36.0', new: '2.37.0', released: true });
  } finally {
    cleanup(root);
  }
});

test('a branch tip whose bump is not the last commit refuses to answer', () => {
  // The PR-merge flow: the version was bumped several commits back and HEAD never moved
  // to main. "Did the last commit change the version" answers no while a release shipped
  // — the same silent skip this script exists to close.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b545-bump-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');

    git(root, 'checkout', '-q', '-b', 'feature');
    writeVersion(root, '2.37.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'bump');
    fs.writeFileSync(path.join(root, 'later.txt'), 'later\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'review nit');

    assert.throws(() => detectReleaseBump(root), /not the tip of the default branch/);
  } finally {
    cleanup(root);
  }
});

test('a stale local main refuses instead of reporting an old release as the new one', () => {
  // Being *a* known tip is not enough. A checkout that skipped the pull sits several
  // releases back; asking it what just shipped gets a confident, wrong answer — which is
  // worse than the silent skip this script was written to close.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b545-bump-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');

    writeVersion(root, '2.34.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');

    writeVersion(root, '2.35.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'ship 2.35.0');
    const stale = git(root, 'rev-parse', 'HEAD');

    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'ship 2.36.0');

    // A remote-tracking ref that is ahead of the stale commit we are asking about.
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    assert.throws(() => detectReleaseBump(root, stale), /is behind the default branch/);
  } finally {
    cleanup(root);
  }
});

test('a local merge that has not been pushed yet is still answerable', () => {
  // The real Step 8.5 path: Step 7 merged into main locally. origin/main is an ancestor
  // of HEAD, not ahead of it, so the freshness check must not fire here.
  const root = repoWithMerge('2.36.0', '2.37.0');
  try {
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD^1');
    const r = detectReleaseBump(root);
    assert.deepEqual(r, { old: '2.36.0', new: '2.37.0', released: true });
  } finally {
    cleanup(root);
  }
});

test('a root commit with no parent refuses to answer instead of saying "no release"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b545-bump-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'root');

    assert.throws(() => detectReleaseBump(root), /no first parent/);
  } finally {
    cleanup(root);
  }
});

test('the CLI exits non-zero and stays silent on stdout when it cannot tell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b545-bump-'));
  try {
    const r = spawnSync(process.execPath, [scriptPath, root], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /\[release-bump\]/);
  } finally {
    cleanup(root);
  }
});
