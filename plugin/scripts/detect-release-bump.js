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
  //
  // Being *a* known tip is not enough, because a stale local `main` is still a tip. A
  // checkout that skipped the pull sits several releases back and reports whichever
  // release happened at that old commit — confidently, and wrong. So also refuse when a
  // known tip is strictly ahead. A local merge that has not been pushed yet stays fine:
  // there `origin/main` is an ancestor of HEAD, not ahead of it.
  //
  // KBT-B585 — the ahead-test alone was not enough either, because "strictly behind" is
  // only one of the two ways a ref can be off the shared line. A local `main` that has
  // DIVERGED from `origin/main` — its own commit on one side, upstream's on the other —
  // is a known tip and is not an ancestor of anything, so both arms stayed false and the
  // detector answered from the wrong line. Measured: a local main carrying 2.35.0 against
  // an upstream that shipped 2.36.0 returned {"old":"2.33.0","new":"2.35.0","released":
  // true} with exit 0.
  //
  // Both cases share one property: some tip holds a commit this ref does not. So invert
  // the test — answer only when this ref is a tip AND every other tip is an ANCESTOR of
  // it. Behind and diverged then both fall out as unanswerable, and the un-pushed local
  // merge (origin/main an ancestor of HEAD) still answers.
  const head = git(repoRoot, ['rev-parse', '--verify', ref]).stdout.trim();
  const tips = ['main', 'origin/main', 'master', 'origin/master']
    .map((r) => git(repoRoot, ['rev-parse', '--verify', r]))
    .filter((r) => r.status === 0)
    .map((r) => r.stdout.trim());

  const isAncestor = (a, b) =>
    git(repoRoot, ['merge-base', '--is-ancestor', a, b]).status === 0;

  const others = tips.filter((t) => t !== head);
  const ahead = others.filter((t) => isAncestor(head, t));
  const diverged = others.filter((t) => !isAncestor(head, t) && !isAncestor(t, head));

  if (tips.length > 0 && (!tips.includes(head) || ahead.length > 0 || diverged.length > 0)) {
    // Order matters, and getting it wrong misdirects the operator on the commonest path.
    //
    // A plain feature branch with main moved on ahead of it satisfies BOTH "not a tip" and
    // "diverged" — a feature branch is, formally, diverged from main. Testing `diverged`
    // first therefore told an operator standing on a perfectly ordinary feature branch that
    // his repository had diverged and he should run `git fetch origin`. Nothing was wrong
    // with his repository; he was simply not on main. The refusal was right, the advice was
    // not. So establish "are you even on the default branch" before diagnosing the shape of
    // the disagreement between two branches that both claim to be it.
    let why;
    if (!tips.includes(head)) {
      why = 'is not the tip of the default branch';
    } else if (ahead.length > 0) {
      why = `is behind the default branch (${ahead[0].slice(0, 8)} is ahead of it)`;
    } else {
      why = `has diverged from the default branch (${diverged[0].slice(0, 8)} holds `
        + `commits this ref does not, and vice versa)`;
    }
    throw new Error(
      `${ref} (${head.slice(0, 8)}) ${why}. Step 8.5 runs on the merge commit, so this `
      + `ref cannot say what just shipped. Run "git fetch origin" and re-run against `
      + `origin/main (worktree-safe), or "git checkout main && git pull". Refusing to `
      + `answer from a ref that cannot.`);
  }

  const before = versionAt(repoRoot, `${ref}^1`);
  const after = versionAt(repoRoot, ref);

  if (after === null) {
    throw new Error(`no readable version in ${CARRIER} at ${ref}.`);
  }

  const result = { old: before, new: after, released: before !== after };

  // KBT-B585 — say how wide the window was, when the answer depends on it.
  //
  // The first-parent diff spans exactly one commit. On a --no-ff merge commit that is
  // the whole merge, which is why Step 7 prescribes --no-ff. Deviate from that path —
  // fast-forward, or a rebase-merge — and several commits land as a row of ordinary
  // single-parent commits. If the bump is not the last of them, HEAD and HEAD^1 both
  // already carry the new number and the answer is a confident-looking "no release".
  // Measured: a fast-forward with the bump one commit back returned released:false,
  // silently.
  //
  // Refusing outright is not the fix. A single-parent commit that did not touch the
  // version is the overwhelmingly common case — every ordinary commit on main — and
  // there released:false is exactly right. Refusing on all of them would make the
  // detector useless and train its callers to ignore it.
  //
  // Of the bug's two suggested directions, one is genuinely unworkable: "refuse when the
  // bump is not in HEAD" reduces to "refuse on every ordinary commit", because whether a
  // bump exists at all is precisely what this script does not know.
  //
  // The other — diff against the fork point with the default branch — IS workable, and an
  // earlier version of this comment wrongly called it impossible. Before the push,
  // `refs/remotes/origin/main` still holds the pre-merge position, so
  // `merge-base(HEAD, origin/main)` recovers the window; and since the freshness check
  // above already requires origin/main to be an ancestor of HEAD whenever we answer at
  // all, that merge-base IS the pre-merge position. Step 8.5a runs directly after the
  // local merge, which is exactly that pre-push state. Only after the push does the
  // information disappear.
  //
  // Widening the window that way would make the answer *correct* rather than merely
  // honest, and it is tracked as its own issue rather than smuggled into this one. What is
  // fixed here is the silence: mark the answer inconclusive and name the check that does
  // not depend on the window at all. The state-shaped drift check
  // (`detect-release-drift.js`, KBT-B586 / KBT-RL210) compares the shipped carrier against
  // the registry, so where in the history the bump sits cannot affect it.
  // The caveat fields appear ONLY when they carry information. Three existing tests pin
  // the answer shape with a strict deepEqual on { old, new, released }, and that pinning
  // is worth keeping: it is the contract Step 8.5a reads. A `basis` on every answer would
  // be noise on the settled ones and would have forced those assertions to change for no
  // gain.
  const parents = git(repoRoot, ['rev-list', '--parents', '-n', '1', ref])
    .stdout.trim().split(/\s+/).length - 1;

  if (parents <= 1 && !result.released) {
    result.basis = 'single-parent';
    result.conclusive = false;
    result.note = 'compared against the first parent, a one-commit window. HEAD is not a '
      + 'merge commit, so if several commits arrived together (fast-forward or '
      + 'rebase-merge) a version bump further back cannot be ruled out. For an answer that '
      + 'does not depend on the window, run the state-shaped drift check '
      + '(detect-release-drift.js, KBT-B586): it compares the shipped carrier against the '
      + 'registry instead of against a commit.';
  }

  return result;
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

  // KBT-B585 — an inconclusive answer must not read as a clean one. The JSON carries the
  // flag for programmatic callers; stderr carries it for the human reading a transcript,
  // who is the one most likely to skim `released:false` and move on.
  if (result.conclusive === false) {
    console.error(`[release-bump] inconclusive: ${result.note}`);
  }

  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main();
}

module.exports = { detectReleaseBump, CARRIER };
