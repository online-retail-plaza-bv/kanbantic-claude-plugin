#!/usr/bin/env node
'use strict';

//
// KBT-B545 — release-bump detector for `kanbantic-issue-review` Step 8.5a.
//
// Answers one question: did the commit at HEAD change the plugin's version number?
//
// This is a script rather than a snippet in the skill doc for a reason. The first
// attempt WAS a snippet, and it was wrong in a way no test could catch, because
// prose is not executed: it compared against `git merge-base origin/main HEAD`,
// but Step 8.5 runs *after* Step 7 has already merged and checked out `main`. At
// that point HEAD is origin/main, the merge-base is HEAD itself, and the answer is
// always "no release" — a HARD-GATE that can never fire. A guard whose trigger is
// never executed in a test is exactly how KBT-B545 opened in the first place.
//
// The correct comparison for a `--no-ff` merge commit is against its FIRST PARENT:
// the state of `main` before the merge. That also behaves sensibly on a plain
// (non-merge) commit, where the first parent is simply the previous commit.
//
// Output: one line of JSON — { "old": "2.36.0", "new": "2.37.0", "released": true }
// Exit code 0 when the question could be answered (released true or false), 1 when
// it could not (not a repo, no parent, unreadable manifest). "Could not tell" is
// never silently reported as "no release".
//
// Usage:
//   node plugin/scripts/detect-release-bump.js [repoRoot] [ref]
//
// Zero deps — only node built-ins.
//

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CARRIER = 'plugin/.claude-plugin/plugin.json';

function git(repoRoot, args) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function versionAt(repoRoot, ref) {
  const r = git(repoRoot, ['show', `${ref}:${CARRIER}`]);
  if (r.status !== 0) return null; // carrier absent at that ref
  try {
    return JSON.parse(r.stdout).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Compares the version carrier at `ref` against its first parent.
 * Returns { old, new, released } or throws with a message the caller can print.
 */
function detectReleaseBump(repoRoot, ref = 'HEAD') {
  const inside = git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }

  const parent = git(repoRoot, ['rev-parse', '--verify', `${ref}^1`]);
  if (parent.status !== 0) {
    throw new Error(
      `${ref} has no first parent — cannot tell what changed. Refusing to report "no release".`);
  }

  // Step 8.5 runs on the merge commit sitting on the default branch. Anywhere else,
  // "did the last commit change the version" is the wrong question: on a branch tip the
  // bump is usually several commits back, and on a PR merged through GitHub the local
  // HEAD never moved to main at all. Both answer "no release" while a release shipped —
  // the same silent-skip this script exists to close. Refuse instead.
  const head = git(repoRoot, ['rev-parse', '--verify', ref]).stdout.trim();
  const tips = ['main', 'origin/main', 'master', 'origin/master']
    .map((r) => git(repoRoot, ['rev-parse', '--verify', r]))
    .filter((r) => r.status === 0)
    .map((r) => r.stdout.trim());

  if (tips.length > 0 && !tips.includes(head)) {
    throw new Error(
      `${ref} (${head.slice(0, 8)}) is not the tip of the default branch. Step 8.5 runs `
      + `after Step 7 merged and checked out main, so this ref was never the merge `
      + `commit. Run "git checkout main && git pull" (or pull the merged PR) and try `
      + `again. Refusing to report "no release" from a ref that cannot answer.`);
  }

  const before = versionAt(repoRoot, `${ref}^1`);
  const after = versionAt(repoRoot, ref);

  if (after === null) {
    throw new Error(`no readable version in ${CARRIER} at ${ref}.`);
  }

  return { old: before, new: after, released: before !== after };
}

function main() {
  const repoRoot = process.argv[2] || process.cwd();
  const ref = process.argv[3] || 'HEAD';

  let result;
  try {
    result = detectReleaseBump(path.resolve(repoRoot), ref);
  } catch (err) {
    console.error(`[release-bump] ${err.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main();
}

module.exports = { detectReleaseBump, CARRIER };
