'use strict';

//
// release-drift-route-independence.test.js — KBT-B586 / KBT-TC3483 / KBT-TC3484
//
// KBT-B545 gave the review-lane a release-registration step. KBT-B586 is what the
// first application of that step revealed: it only fires for a release the skill
// merged *itself*. On 2026-08-10 eight PRs were merged and not one of them went
// through it — every time a subagent delivered up to `Review` and a supervising
// agent merged after checking, which is the division of labour KBT-TRUL030
// prescribes. Coverage of the guard was therefore zero, including for the release
// of v2.37.0, the release that introduced the guard.
//
// The defect is not in the detector, it is in the SHAPE of the question.
// `detect-release-bump.js` asks an event-shaped question — "did *this commit*
// change the version?" — by diffing HEAD against its first parent, and it refuses
// outright any ref that is not the tip of the default branch. That question is
// only answerable by whoever stands on the merge commit at the moment it is
// created. Every other route gets silence or a refusal.
//
// A state-shaped question needs no event: "does the registry lag the repo?" is a
// comparison of two numbers, answerable at any time, by anyone, regardless of who
// merged or with which strategy. Route-independence then is not a property that
// has to be policed — it follows from the shape. That is KBT-RL210.
//
// These tests are red on the pre-fix tree (KBT-B483: a guard whose trigger is
// never exercised is how KBT-B545 opened in the first place, so the trigger is
// proven to fire before it is trusted).
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
const driftScript = path.join(repoRoot, 'plugin', 'scripts', 'detect-release-drift.js');
const bumpScript = path.join(repoRoot, 'plugin', 'scripts', 'detect-release-bump.js');

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

function newRepo(prefix = 'kbt-b586-drift-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * The exact shape KBT-B586 was measured on: a feature branch squash-merged into
 * main by `gh pr merge --squash`, with origin/main pointing at the result.
 *
 * There is no merge commit, so HEAD's first parent is the pre-merge main — which
 * makes `detect-release-bump.js` *look* like it should work here. It does, for the
 * commit. What it cannot do is answer at any later moment, or from any ref that is
 * not this exact tip; and nothing invokes it on this route in the first place,
 * because the only caller is a step conditioned on the skill's own merge.
 */
function repoSquashMerged(mainVersion, branchVersion) {
  const root = newRepo();
  writeVersion(root, mainVersion);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');

  git(root, 'checkout', '-q', '-b', 'feature');
  writeVersion(root, branchVersion);
  fs.writeFileSync(path.join(root, 'work.txt'), 'work\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'work');

  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '--squash', '-q', 'feature');
  git(root, 'commit', '-q', '-m', 'fix(KBT-B999): squashed (#68)');
  git(root, 'branch', '-q', '-D', 'feature');
  // What `gh pr merge` leaves behind: the remote tracking ref moved with main.
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return root;
}

function runDrift(...args) {
  return spawnSync(process.execPath, [driftScript, ...args], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// KBT-TC3483 — the pure decision rule
// ---------------------------------------------------------------------------

test('the drift rule answers from two version numbers alone — no ref, no commit, no merge', () => {
  const { detectReleaseDrift } = require(driftScript);

  // The measured v2.37.0 situation: the repo shipped 2.37.0, the registry's highest
  // registered Version is still v2.36.0. Nobody asked the detector because nobody
  // ran the step; the state says it plainly.
  const drifted = detectReleaseDrift({ repoVersion: '2.37.0', baselineNumber: 'v2.36.0' });
  assert.equal(drifted.answerable, true);
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.relation, 'registry-behind');
  assert.match(String(drifted.action), /\S/, 'a drifted answer must name a next action');

  // The signature itself is the point of KBT-RL210: no repoRoot, no ref, nothing
  // git-shaped. A rule that cannot take a ref cannot be route-dependent.
  //
  // Asserted on the parameter list rather than on `.length`, which is 0 here because
  // the sole parameter is defaulted (`= {}`) and defaults do not count toward arity —
  // a detail that makes `.length` useless for expressing this intent.
  const params = String(detectReleaseDrift).slice(
    String(detectReleaseDrift).indexOf('('),
    String(detectReleaseDrift).indexOf(')') + 1);
  assert.match(params, /repoVersion/);
  assert.match(params, /baselineNumber/);
  for (const gitShaped of ['repoRoot', 'ref', 'sha', 'commit', 'branch']) {
    assert.doesNotMatch(params, new RegExp(gitShaped),
      `the rule must not accept ${gitShaped}: taking anything git-shaped is how a `
        + 'state comparison decays back into an event comparison, which is the '
        + 'defect KBT-B586 is about.');
  }
});

test('an in-step registry is not treated as proof the Version was released', () => {
  // KBT-B586 review blocker A1 — the decisive case, and the one the first version got wrong.
  //
  // `baselineNumber` is the highest *registered* Version whatever its lifecycle status, and
  // the row normally exists BEFORE its release ships: Step 8.5c opens the next Planned bucket
  // as part of the previous release. So equality proves the record exists, not that anyone
  // froze it and marked it Released.
  //
  // The miss that follows is the very incident that opened this issue: a release-cut PR bumps
  // to 2.38.0, a supervising agent squash-merges, 8.5b never runs, v2.38.0 stays Planned — and
  // repo 2.38.0 vs baseline v2.38.0 compares equal. Calling that "nothing to do" would go
  // quiet on exactly the failure this check exists for, and would only catch the NEXT one, a
  // release late.
  const { detectReleaseDrift } = require(driftScript);
  const r = detectReleaseDrift({ repoVersion: '2.38.0', baselineNumber: 'v2.38.0' });

  assert.equal(r.answerable, true);
  assert.equal(r.relation, 'in-step');
  // Still not "drift" — the registry is not behind, so there is nothing to create.
  assert.equal(r.drifted, false);
  // But it must not present itself as settled.
  assert.equal(r.mayBeUnreleased, true,
    'an equal number cannot distinguish "Released" from "still Planned", because no MCP tool '
      + 'exposes a Version lifecycle status. It must say so.');
  assert.match(String(r.action), /\S/,
    'there must still be a recommended action — running the idempotent close-out — rather '
      + 'than a null that reads as "done".');
  assert.match(r.reason, /idempotent/,
    'the reason must say the close-out is safe to re-run, or the reader will skip it.');
});

test('an open Planned bucket ahead of the repo is normal, not drift', () => {
  // baselineNumber is the highest *registered* Version, Planned included — verified
  // live against preview_next_version, which returned baselineNumber "v2.38.0" while
  // the repo carried 2.37.0. Treating "registry ahead" as drift would fire on every
  // healthy repo the moment the next bucket is opened, and a guard that cries wolf
  // on the normal case is a guard that gets waved through.
  const { detectReleaseDrift } = require(driftScript);
  const r = detectReleaseDrift({ repoVersion: '2.37.0', baselineNumber: 'v2.38.0' });
  assert.equal(r.answerable, true);
  assert.equal(r.drifted, false);
  assert.equal(r.relation, 'registry-ahead');
});

test('an empty registry is drift, not an error', () => {
  const { detectReleaseDrift } = require(driftScript);
  for (const baselineNumber of [null, undefined, '']) {
    const r = detectReleaseDrift({ repoVersion: '2.37.0', baselineNumber });
    assert.equal(r.answerable, true, `baselineNumber ${JSON.stringify(baselineNumber)}`);
    assert.equal(r.drifted, true);
    assert.equal(r.relation, 'registry-empty');
  }
});

test('an unreadable version says "cannot tell" and never "no drift"', () => {
  // The same discipline as detect-release-bump.js's exit 1: "could not tell" must
  // never be reported as the reassuring answer. That is the whole failure mode this
  // family of guards exists to close.
  const { detectReleaseDrift } = require(driftScript);
  for (const bad of [null, undefined, '', 'not-a-version', {}, 7]) {
    const r = detectReleaseDrift({ repoVersion: bad, baselineNumber: 'v2.36.0' });
    assert.equal(r.answerable, false, `repoVersion ${JSON.stringify(bad)}`);
    assert.notEqual(r.drifted, false,
      'an unanswerable comparison must not present itself as "no drift"');
    assert.match(String(r.reason), /\S/, 'an unanswerable answer must say why');
  }
  // A baseline that is present but unparseable is equally unanswerable — silently
  // treating garbage as "no baseline" would turn a data problem into a false alarm.
  const r = detectReleaseDrift({ repoVersion: '2.37.0', baselineNumber: 'Next (auto)' });
  assert.equal(r.answerable, false);
  assert.notEqual(r.drifted, false);
});

test('the rule distinguishes "no Version record" from "record exists but unreleased"', () => {
  const { detectReleaseDrift } = require(driftScript);
  const empty = detectReleaseDrift({ repoVersion: '2.37.0', baselineNumber: null });
  const behind = detectReleaseDrift({ repoVersion: '2.37.0', baselineNumber: 'v2.36.0' });
  assert.notEqual(empty.action, behind.action,
    'creating a Version and closing out an existing one are different actions; one '
      + 'action string for both makes the report useless to act on');
});

test('the rule is pure — same input, same answer, no accumulated state', () => {
  const { detectReleaseDrift } = require(driftScript);
  const input = { repoVersion: '2.37.0', baselineNumber: 'v2.36.0' };
  assert.deepEqual(detectReleaseDrift(input), detectReleaseDrift(input));
  // Idempotence at the level that matters operationally: running the check twice
  // over an already-registered state stays silent both times.
  const ok = { repoVersion: '2.37.0', baselineNumber: 'v2.37.0' };
  assert.equal(detectReleaseDrift(ok).drifted, false);
  assert.equal(detectReleaseDrift(ok).drifted, false);
});

test('comparison is numeric per segment, not lexical', () => {
  // '2.9.0' vs '2.10.0' is the classic: string comparison says 2.9.0 is the higher
  // number and reports drift on a perfectly current repo.
  const { detectReleaseDrift } = require(driftScript);
  assert.equal(
    detectReleaseDrift({ repoVersion: '2.9.0', baselineNumber: 'v2.10.0' }).relation,
    'registry-ahead');
  assert.equal(
    detectReleaseDrift({ repoVersion: '2.10.0', baselineNumber: 'v2.9.0' }).relation,
    'registry-behind');
});

// ---------------------------------------------------------------------------
// KBT-TC3484 — over a real repo merged by a route the review-skill did not run
// ---------------------------------------------------------------------------

test('a squash-merged release with a lagging registry is reported', () => {
  const root = repoSquashMerged('2.36.0', '2.37.0');
  try {
    const r = runDrift(root, '--baseline', 'v2.36.0');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.drifted, true);
    assert.equal(out.repoVersion, '2.37.0',
      'the repo version must be read from the carrier, not passed in');
  } finally {
    cleanup(root);
  }
});

test('the same repo is silent once the registry has caught up', () => {
  const root = repoSquashMerged('2.36.0', '2.37.0');
  try {
    const r = runDrift(root, '--baseline', 'v2.37.0');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).drifted, false);
  } finally {
    cleanup(root);
  }
});

test('a fast-forward merge whose bump is not the last commit is still reported', () => {
  // KBT-B585 point 2 is the same underlying state seen from the event side: the
  // event-shaped detector answers "no release" here because HEAD^1 already carries
  // the new number. The state-shaped question is unaffected by where in the history
  // the bump sits — which is the point of doing it this way.
  const root = newRepo();
  try {
    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    writeVersion(root, '2.37.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'bump');
    fs.writeFileSync(path.join(root, 'after.txt'), 'after\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'follow-up after the bump');
    git(root, 'checkout', '-q', 'main');
    git(root, 'merge', '--ff-only', '-q', 'feature');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    // Characterisation of the gap, so the evidence lives next to the fix: on this
    // very repo the event-shaped detector reports no release.
    const bump = spawnSync(process.execPath, [bumpScript, root], { encoding: 'utf8' });
    if (bump.status === 0) {
      assert.equal(JSON.parse(bump.stdout).released, false,
        'characterisation: the first-parent diff sees nothing here');
    }

    const r = runDrift(root, '--baseline', 'v2.36.0');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).drifted, true,
      'the state comparison must not care where in the history the bump sits');
  } finally {
    cleanup(root);
  }
});

test('an opted-in clone with an unreachable registry says so, even under --quiet', () => {
  // The one "could not tell" that IS worth reporting: configured, asked, and it failed. This
  // must survive --quiet, because here silence would be indistinguishable from a clean repo.
  //
  // An Application is configured explicitly so the run reaches the registry call instead of
  // stopping at not-opted-in — the distinction blocker A2 turns on.
  const root = newRepo();
  try {
    writeVersion(root, '2.37.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'config', 'kanbantic.applicationId', '00000000-0000-0000-0000-000000000000');

    const r = spawnSync(process.execPath, [driftScript, root, '--quiet'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        KANBANTIC_API_KEY: '',
        KANBANTIC_MCP_URL: 'http://127.0.0.1:9/unreachable',
      },
    });
    assert.equal(r.status, 0, 'the CLI must never fail a session over an unreachable registry');
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.applicable, true);
    assert.equal(out.optedIn, true);
    assert.equal(out.answerable, false);
    assert.notEqual(out.drifted, false,
      'an unanswerable check must not emit drifted:false — that is the silent '
        + '"no release" this whole family of guards exists to prevent');
  } finally {
    cleanup(root);
  }
});

test('a repo with no carrier reports "not applicable", and stays out of the way', () => {
  // KBT-B586 review — this test used to assert only `doesNotMatch(/"drifted":false/)`. That
  // is a purely negative assertion: with the module absent the output was empty, so it held
  // vacuously and could never fail for the reason it claimed. Replaced with positive
  // assertions about the state that must be reported.
  //
  // This is also the monorepo's case — it versions by git tag, and CARRIER is plugin-specific.
  // KBT-BD208 §4 declares it out of scope, so the runtime has to agree with that instead of
  // announcing itself there (review blocker A2).
  const root = newRepo();
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'no carrier here\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');

    const r = runDrift(root, '--baseline', 'v2.36.0');
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.applicable, false, 'a repo without the carrier is not applicable');
    assert.equal(out.relation, 'not-applicable');
    assert.notEqual(out.drifted, false, 'and it must never claim there is no drift');
    assert.match(out.reason, /not applicable/i);

    // Under --quiet, which is how the hook runs it, a non-event prints nothing at all.
    const q = runDrift(root, '--baseline', 'v2.36.0', '--quiet');
    assert.equal(q.status, 0);
    assert.equal(q.stdout.trim(), '',
      'a non-event must be completely silent under --quiet, or every session in every '
        + 'repository opens with a line about a check nobody asked for');
  } finally {
    cleanup(root);
  }
});

test('a carrier without a configured Application is "not opted in", and silent', () => {
  // The other half of blocker A2. Measured on the real repos: `git config --get
  // kanbantic.applicationId` fails in both the plugin clone and the monorepo, and nothing in
  // this change sets it — so this is the DEFAULT state for every user after merge, not an
  // edge case.
  const root = newRepo();
  try {
    const dir = path.join(root, ...CARRIER.slice(0, -1));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, ...CARRIER),
      JSON.stringify({ name: 'kanbantic', version: '2.37.0' }, null, 2));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'ship');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    const env = { KANBANTIC_RELEASE_DRIFT_APPLICATION: '' };
    const verbose = spawnSync(process.execPath, [driftScript, root],
      { encoding: 'utf8', env: { ...process.env, ...env } });
    const out = JSON.parse(verbose.stdout.trim());
    assert.equal(out.applicable, true, 'the carrier IS there, so the repo is applicable');
    assert.equal(out.optedIn, false, 'but no Application is configured');
    assert.equal(out.relation, 'not-opted-in');
    assert.notEqual(out.drifted, false);

    const quiet = spawnSync(process.execPath, [driftScript, root, '--quiet'],
      { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(quiet.stdout.trim(), '',
      'not-opted-in is a non-event: nothing was asked of the check, so it says nothing');
  } finally {
    cleanup(root);
  }
});
