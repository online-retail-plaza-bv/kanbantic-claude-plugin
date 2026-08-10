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
  assert.equal(detectReleaseDrift.length, 1);
});

test('a registry that already knows the shipped number is silent', () => {
  const { detectReleaseDrift } = require(driftScript);
  const r = detectReleaseDrift({ repoVersion: '2.37.0', baselineNumber: 'v2.37.0' });
  assert.equal(r.answerable, true);
  assert.equal(r.drifted, false);
  assert.equal(r.relation, 'in-step');
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

test('the CLI degrades readably instead of falsely reporting "no drift"', () => {
  // No registry reachable and no baseline supplied: the check must not conclude
  // that all is well. It exits 0 (a session-start hook may never break a session)
  // but says it could not tell, and does not claim drifted:false.
  const root = newRepo();
  try {
    writeVersion(root, '2.37.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');

    const r = spawnSync(process.execPath, [driftScript, root], {
      encoding: 'utf8',
      env: {
        ...process.env,
        KANBANTIC_API_KEY: '',
        KANBANTIC_MCP_URL: 'http://127.0.0.1:9/unreachable',
      },
    });
    assert.equal(r.status, 0, 'the CLI must never fail a session over an unreachable registry');
    const said = `${r.stdout}${r.stderr}`;
    assert.match(said, /\S/, 'it must say something rather than pass in silence');
    assert.doesNotMatch(said, /"drifted"\s*:\s*false/,
      'an unanswerable check must not emit drifted:false — that is the silent '
        + '"no release" this whole family of guards exists to prevent');
  } finally {
    cleanup(root);
  }
});

test('a repo with no readable carrier cannot tell, and says so', () => {
  const root = newRepo();
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'no carrier here\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const r = runDrift(root, '--baseline', 'v2.36.0');
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /"drifted"\s*:\s*false/);
  } finally {
    cleanup(root);
  }
});
