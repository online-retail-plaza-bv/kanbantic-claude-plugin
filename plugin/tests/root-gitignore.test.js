'use strict';

//
// root-gitignore.test.js — KBT-B605
//
// The defect was not "a line is missing from a file" — it was that `git add -A`
// in this repo picked up other agents' worktrees as embedded git repositories,
// because the repo has no root `.gitignore` at all. The only one that existed
// lived in `plugin/` and covers `plugin/` alone.
//
// So the assertion here is deliberately NOT `readFileSync('.gitignore')
// .includes('.claude/worktrees/')`. That would only confirm that a string I
// wrote is a string I wrote. The question that matters is whether GIT ignores
// the path, and git is the only authority on that: ordering, negation,
// directory-only markers and globstar all change the answer, and a hand-rolled
// matcher would get at least one of them wrong.
//
// `git check-ignore` answers from the ignore rules alone, purely on the path
// string — the probe files never have to exist. That keeps the test from
// mutating the working tree, which matters because `node --test` runs test
// FILES IN PARALLEL: creating and deleting directories in the repo root here
// would race against every other suite.
//
// The negative control is the load-bearing half. Without it, a catastrophically
// broad rule (`*`) would satisfy every positive assertion while making the repo
// untrackable.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * Ask git whether `relPath` is covered by the ignore rules of this repo.
 *
 * Returns git's raw exit status: 0 = ignored, 1 = not ignored, other = git
 * could not answer (no repo, etc.), which the callers assert against directly
 * so a broken invocation can never be mistaken for a passing check.
 *
 * `--no-index` asks about the RULES rather than about what happens to be
 * tracked today. Without it a tracked file always reports "not ignored", which
 * would make the negative control below pass for the wrong reason.
 */
function checkIgnoreStatus(relPath) {
  const r = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', relPath], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  return r.status;
}

test('KBT-TC3511: the repository has a root .gitignore', () => {
  const p = path.join(REPO_ROOT, '.gitignore');
  assert.ok(
    fs.existsSync(p),
    `Expected a root .gitignore at ${p}. Without it, \`git add -A\` picks up agent ` +
    `worktrees as embedded git repositories (KBT-B605); plugin/.gitignore does not ` +
    `cover the repo root.`
  );
});

test('KBT-TC3511: agent worktrees under .claude/worktrees/ are ignored', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  // The exact path shape observed during KBT-T4030:
  //   warning: adding embedded git repository: .claude/worktrees/KBT-B586
  const probe = '.claude/worktrees/KBT-PROBE/some-file.md';
  assert.equal(
    checkIgnoreStatus(probe), 0,
    `git does not ignore "${probe}". This is the path agents create for parallel ` +
    `work; leaving it trackable is what put two foreign worktrees into a commit.`
  );
});

test('KBT-TC3511: .wt-* scratch worktrees are ignored', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  // The second shape from the same observation:
  //   warning: adding embedded git repository: .wt-f551min
  const probe = '.wt-f551min/some-file.md';
  assert.equal(
    checkIgnoreStatus(probe), 0,
    `git does not ignore "${probe}". The .wt-* prefix is the other worktree ` +
    `convention in use; both shapes have to be covered.`
  );
});

test('KBT-TC3511: the ignore rules are not so broad that source files disappear', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  // Negative control. A blanket `*` or a stray `.claude/` would satisfy every
  // assertion above while quietly making tracked sources untrackable — this is
  // the assertion that makes the others mean something.
  for (const tracked of [
    'plugin/scripts/sync-workspace-skills.js',
    'plugin/tests/sync-workspace-skills.test.js',
    'package.json',
  ]) {
    assert.equal(
      checkIgnoreStatus(tracked), 1,
      `git ignores "${tracked}", but it is a tracked source file. The root ` +
      `.gitignore is too broad.`
    );
  }
});

test('KBT-TC3511: shared .claude/ content stays trackable — only the worktree subdir is excluded', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  // Deliberate scope choice (see the KBT-B540 decision entry): the root
  // .gitignore must NOT carry a blanket `.claude/` rule. The repo has to be able
  // to track shared `.claude/` content; only `.claude/worktrees/` is private to
  // an agent. A blanket rule would also interact badly with the sync script's
  // own gitignore management.
  assert.equal(
    checkIgnoreStatus('.claude/settings.json'), 1,
    'A blanket `.claude/` rule crept into the root .gitignore. Only ' +
    '`.claude/worktrees/` belongs there — shared .claude/ content must stay trackable.'
  );
});
