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

    // Branch `main` STAYS on the stale commit — that is the whole point. Asking about a
    // bare stale sha would also be refused by a check that only tests tip-membership,
    // so this fixture would pass against the very bug it exists to pin, discriminating
    // on the error message rather than on behaviour.
    git(root, 'checkout', '-q', '-b', 'upstream');
    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'ship 2.36.0');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'checkout', '-q', 'main');

    assert.throws(() => detectReleaseBump(root, 'main'), /is behind the default branch/);
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

//
// KBT-B585 — the two remaining silent answers.
//
// Both were classified as follow-ups by the KBT-B545 review (rounds 4 and 5) rather than
// as merge blockers. Both were re-measured live before being fixed (KBT-GTCH116) instead
// of taken on the review write-up's word.
//

/** A repo whose local default branch has genuinely diverged from its remote. */
function repoWithDivergedMain(baseVersion, upstreamVersion, localVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b585-bump-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');

  writeVersion(root, baseVersion);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');

  // Upstream ships on its own commit above the shared base.
  git(root, 'checkout', '-q', '-b', 'upstream');
  writeVersion(root, upstreamVersion);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `upstream ships ${upstreamVersion}`);
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  // Local main commits on the SAME base, so neither side is an ancestor of the other.
  // That distinction is the whole point: a fixture where local main merely lagged is
  // already caught by the pre-existing behind-check, so it would pass against the very
  // bug this pins.
  git(root, 'checkout', '-q', 'main');
  writeVersion(root, localVersion);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'local divergent release');
  return root;
}

/**
 * A repo fast-forwarded onto a branch whose bump is not its last commit.
 *
 * `advanceRemote` decides which of two real states is built, and the distinction matters
 * (review finding B1):
 *
 *   true  — post-push. origin/main has moved with main, so the pre-merge position is gone
 *           from the graph and the window cannot be recovered.
 *   false — pre-push, which is the state Step 8.5a actually runs in: the local merge has
 *           happened but origin/main still points at the pre-merge commit.
 *
 * The original fixture only built the post-push state, which made the pre-merge position
 * look irretrievable in general and led me to write that a fork point does not exist. It
 * does, in the state that matters. See the pre-push test below.
 */
function repoFastForwardedPastBump(mainVersion, branchVersion, advanceRemote = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b585-bump-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');

  writeVersion(root, mainVersion);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');

  git(root, 'checkout', '-q', '-b', 'feature');
  writeVersion(root, branchVersion);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `bump to ${branchVersion}`);
  fs.writeFileSync(path.join(root, 'after.txt'), 'after\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'docs, after the bump');

  // Pre-merge main, i.e. what origin/main still points at before the push.
  const preMerge = git(root, 'rev-parse', 'main');

  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '--ff-only', '-q', 'feature');
  git(root, 'update-ref', 'refs/remotes/origin/main', advanceRemote ? 'HEAD' : preMerge);
  return root;
}

test('pre-push, the fork point still recovers the window — the info is NOT gone', () => {
  // Review finding B1, pinned as a fact so the "there is no fork" claim cannot come back.
  //
  // Step 8.5a runs directly after the local merge, before the push. In that state
  // origin/main still holds the pre-merge position, so merge-base(HEAD, origin/main) is
  // exactly the commit whose carrier we want to compare against — and it carries the OLD
  // version even though HEAD^1 already carries the new one.
  //
  // Note this is guaranteed rather than lucky: the freshness check only lets the detector
  // answer when origin/main is an ancestor of HEAD, and on a fast-forward that ancestor IS
  // the pre-merge position.
  //
  // Widening the window to use this would make the answer correct rather than merely honest.
  // Deliberately NOT done here — tracked as its own issue — but the possibility is asserted
  // so nobody re-writes it off as impossible.
  const root = repoFastForwardedPastBump('2.36.0', '2.37.0', /* advanceRemote */ false);
  try {
    const base = git(root, 'merge-base', 'HEAD', 'origin/main');
    const atBase = JSON.parse(
      spawnSync('git', ['show', `${base}:${CARRIER.join('/')}`], { cwd: root, encoding: 'utf8' })
        .stdout);
    const atHead = JSON.parse(
      spawnSync('git', ['show', `HEAD:${CARRIER.join('/')}`], { cwd: root, encoding: 'utf8' })
        .stdout);

    assert.equal(atBase.version, '2.36.0',
      'the fork point carries the pre-release version — the window is recoverable pre-push');
    assert.equal(atHead.version, '2.37.0');
    assert.notEqual(atBase.version, atHead.version,
      'so a fork-point comparison would report released:true here, where the first-parent '
        + 'comparison reports false');

    // And the detector still answers in this state rather than refusing: origin/main is an
    // ancestor of HEAD, which the freshness check explicitly permits.
    const r = detectReleaseBump(root);
    assert.equal(r.released, false, 'first-parent window: unchanged carrier');
    assert.equal(r.conclusive, false, 'and it says so, which is what this issue fixes');
  } finally {
    cleanup(root);
  }
});

test('a diverged local main refuses instead of answering from the wrong line', () => {
  // KBT-B585 point 1. The freshness check tested only for strictly-behind, via
  // `merge-base --is-ancestor head tip`. A diverged local main is a known tip and is an
  // ancestor of nothing, so both arms of the condition stayed false and the detector
  // answered — from a line upstream never saw.
  //
  // Measured on the pre-fix script: local main carrying 2.35.0 against an upstream that
  // shipped 2.36.0 returned {"old":"2.33.0","new":"2.35.0","released":true}, exit 0.
  const root = repoWithDivergedMain('2.33.0', '2.36.0', '2.35.0');
  try {
    assert.equal(
      spawnSync('git', ['merge-base', '--is-ancestor', 'main', 'origin/main'], { cwd: root })
        .status === 0, false, 'fixture sanity: local main must not be an ancestor');
    assert.equal(
      spawnSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'main'], { cwd: root })
        .status === 0, false, 'fixture sanity: upstream must not be an ancestor either');

    assert.throws(() => detectReleaseBump(root, 'main'), /diverged from the default branch/);
  } finally {
    cleanup(root);
  }
});

test('the diverged refusal is distinguishable from the behind refusal', () => {
  // Two different operator actions: a diverged main needs the local commit reconciled,
  // a stale one needs a pull. One shared message would send half the readers the wrong way.
  const diverged = repoWithDivergedMain('2.33.0', '2.36.0', '2.35.0');
  try {
    assert.throws(() => detectReleaseBump(diverged, 'main'), (err) => {
      assert.match(err.message, /diverged/);
      assert.doesNotMatch(err.message, /is behind the default branch/);
      return true;
    });
  } finally {
    cleanup(diverged);
  }
});

test('an ordinary feature branch is told it is not the tip, not that it diverged', () => {
  // Review finding B2 — a regression I introduced on the commonest path.
  //
  // A feature branch with main moved on ahead of it satisfies BOTH conditions: it is not a
  // tip, and it is formally diverged from main. Testing `diverged` first told an operator on
  // a perfectly ordinary feature branch that his repository had diverged and he should run
  // `git fetch origin`. Nothing was wrong with his repository — he was simply not on main.
  // The refusal stayed correct; the advice misdirected.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b585-bump-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');

    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');

    // The feature branch the agent is actually standing on.
    git(root, 'checkout', '-q', '-b', 'feature/some-work');
    writeVersion(root, '2.37.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'bump on the branch');

    // Meanwhile main moves on, so HEAD and main have genuinely diverged.
    const branchTip = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(root, 'other.txt'), 'someone else\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'unrelated work on main');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'checkout', '-q', branchTip);

    assert.throws(() => detectReleaseBump(root), (err) => {
      assert.match(err.message, /is not the tip of the default branch/,
        'being on a feature branch is the diagnosis; the branch-shape comparison is not');
      assert.doesNotMatch(err.message, /diverged/,
        'telling a feature-branch operator that his repo diverged sends him to fix '
          + 'something that is not broken');
      return true;
    });
  } finally {
    cleanup(root);
  }
});

test('a fast-forward whose bump is not the last commit says its answer is inconclusive', () => {
  // KBT-B585 point 2. Measured on the pre-fix script: released:false, exit 0, and no
  // signal of any kind that the one-commit window could have missed the bump.
  const root = repoFastForwardedPastBump('2.36.0', '2.37.0');
  try {
    const r = detectReleaseBump(root);
    assert.equal(r.released, false, 'the one-commit window genuinely sees no change');
    assert.equal(r.basis, 'single-parent');
    assert.equal(r.conclusive, false,
      'released:false from a one-commit window on a non-merge commit must not present '
        + 'itself as a settled answer');
    assert.match(r.note, /detect-release-drift\.js/,
      'the inconclusive answer must name the check that does not depend on the window');
  } finally {
    cleanup(root);
  }
});

test('an ordinary commit that shipped nothing is still answered plainly', () => {
  // The counterweight. Refusing on every ordinary single-parent commit would make the
  // detector useless, and a guard that fires on the common case is one its callers learn
  // to ignore. released:false and exit 0 must survive.
  const root = repoWithMerge('2.36.0', '2.36.0');
  try {
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'unrelated change');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    const r = detectReleaseBump(root);
    assert.equal(r.released, false);

    const cli = spawnSync(process.execPath, [scriptPath, root], { encoding: 'utf8' });
    assert.equal(cli.status, 0, 'an ordinary commit must never fail the caller');
    assert.equal(JSON.parse(cli.stdout).released, false);
  } finally {
    cleanup(root);
  }
});

test('a --no-ff merge carries no caveat, and the answer shape is unchanged', () => {
  // The prescribed Step 7 path: the first parent IS pre-merge main, so the window covers
  // the whole merge and the answer is settled. Flagging it too would dilute the signal —
  // and the caveat fields are deliberately absent rather than present-and-false, so the
  // three pre-existing deepEqual assertions on { old, new, released } keep holding. That
  // shape is the contract Step 8.5a reads; extending it for settled answers would buy
  // nothing and cost a spec change.
  const root = repoWithMerge('2.36.0', '2.36.0');
  try {
    const r = detectReleaseBump(root);
    assert.equal(r.conclusive, undefined);
    assert.equal(r.basis, undefined);
    assert.equal(r.note, undefined);
    assert.deepEqual(Object.keys(r).sort(), ['new', 'old', 'released']);
  } finally {
    cleanup(root);
  }
});

test('the CLI refuses a diverged ref with a non-zero exit and silent stdout', () => {
  // Same contract as the pre-existing "cannot tell" case: stdout stays empty so a caller
  // parsing JSON has nothing to misread, and the reason goes to stderr.
  const root = repoWithDivergedMain('2.33.0', '2.36.0', '2.35.0');
  try {
    const cli = spawnSync(process.execPath, [scriptPath, root, 'main'], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0);
    assert.equal(cli.stdout.trim(), '');
    assert.match(cli.stderr, /\[release-bump\]/);
    assert.match(cli.stderr, /diverged/);
  } finally {
    cleanup(root);
  }
});

test('the CLI voices an inconclusive answer on stderr, not only in the JSON', () => {
  // A transcript reader skims `released:false` and moves on. The JSON flag serves
  // programmatic callers; the stderr line serves the human, who is who this defect fooled.
  const root = repoFastForwardedPastBump('2.36.0', '2.37.0');
  try {
    const cli = spawnSync(process.execPath, [scriptPath, root], { encoding: 'utf8' });
    assert.equal(cli.status, 0);
    assert.equal(JSON.parse(cli.stdout).conclusive, false);
    assert.match(cli.stderr, /inconclusive/);
  } finally {
    cleanup(root);
  }
});
