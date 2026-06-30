'use strict';

//
// lint-skills.test.js — KBT-B192 / KBT-RL064 / KBT-TC1881
//
// Wraps `plugin/scripts/lint-skills.js` so `npm test` auto-runs it. Covers
// the positive case (real on-disk tree exits 0) + four negative cases (one
// per invariant) + one infrastructure-failure case (missing snapshot).
//
// Negative cases work via the `SKILLS_DIR` env-var override: each test
// creates a tmp-dir, copies the real SKILL.md files into it, applies a
// targeted regression-mutation, and runs the script against the tmp-dir.
// This avoids any risk of mutating the real on-disk tree.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'plugin', 'scripts', 'lint-skills.js');
const REAL_SKILLS = path.join(REPO_ROOT, 'plugin', 'skills');
const REAL_SNAPSHOT = path.join(REPO_ROOT, 'plugin', 'scripts', 'known-mcp-tools.json');

const LANES = ['kanbantic-issue-triage', 'kanbantic-issue-prepare',
               'kanbantic-issue-execute', 'kanbantic-issue-review'];

function runLint(env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function makeTmpSkills() {
  // Copies the real SKILL.md files into a fresh tmp-dir so a test can
  // mutate one file without polluting the worktree.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-skills-'));
  for (const lane of LANES) {
    fs.mkdirSync(path.join(dir, lane), { recursive: true });
    fs.copyFileSync(
      path.join(REAL_SKILLS, lane, 'SKILL.md'),
      path.join(dir, lane, 'SKILL.md')
    );
  }
  return dir;
}

function mutate(dir, lane, transform) {
  const f = path.join(dir, lane, 'SKILL.md');
  const original = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, transform(original), 'utf8');
}

test('positive: real on-disk tree passes all invariants', () => {
  const r = runLint();
  assert.equal(r.status, 0,
    `expected exit 0 on real tree, got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /OK: all SKILL.md invariants pass/);
});

test('negative 1 (F1): stripping update_validation_status from execute fails invariant 1', () => {
  const dir = makeTmpSkills();
  mutate(dir, 'kanbantic-issue-execute',
    s => s.replace(/update_validation_status/g, 'totally_unrelated_token'));
  const r = runLint({ SKILLS_DIR: dir });
  assert.equal(r.status, 1,
    `expected exit 1, got ${r.status}\nSTDOUT: ${r.stdout}`);
  assert.match(r.stdout, /FAIL invariant 1/);
});

test('negative 2 (C2): inserting /prepare-issue into review fails invariant 2', () => {
  const dir = makeTmpSkills();
  mutate(dir, 'kanbantic-issue-review',
    s => s + '\n\nRun `/prepare-issue ABC-1` to fix.\n');
  const r = runLint({ SKILLS_DIR: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL invariant 2/);
  assert.match(r.stdout, /\/prepare-issue/);
});

test('negative 3 (drift): unknown mcp__kanbantic__bogus_tool fails invariant 3', () => {
  const dir = makeTmpSkills();
  mutate(dir, 'kanbantic-issue-prepare',
    s => s + '\n\nUse `mcp__kanbantic__bogus_tool` for something.\n');
  const r = runLint({ SKILLS_DIR: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL invariant 3/);
  assert.match(r.stdout, /bogus_tool/);
});

test('negative 4 (state-machine): inserting "Review → Done" into review fails invariant 4', () => {
  const dir = makeTmpSkills();
  mutate(dir, 'kanbantic-issue-review',
    s => s + '\n\nReview → Done is the lane-exit.\n');
  const r = runLint({ SKILLS_DIR: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL invariant 4/);
});

test('negative 5 (version-awareness): "Create a Release" in a lane fails invariant 5', () => {
  // KBT-F320 / KBT-RL147 / KBT-TC2360 — case-sensitive capital `Release`.
  const dir = makeTmpSkills();
  mutate(dir, 'kanbantic-issue-prepare',
    s => s + '\n\nThen Create a Release for the issue.\n');
  const r = runLint({ SKILLS_DIR: dir });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nSTDOUT: ${r.stdout}`);
  assert.match(r.stdout, /FAIL invariant 5/);
});

test('negative 5 (version-awareness): a removed release-tool ref fails invariant 5', () => {
  const dir = makeTmpSkills();
  mutate(dir, 'kanbantic-issue-execute',
    s => s + '\n\nCall `get_release_notes` afterwards.\n');
  const r = runLint({ SKILLS_DIR: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL invariant 5/);
});

test('positive 5 (version-awareness): lowercase "release notes" does NOT hard-fail', () => {
  // TC2360 design-choice: only the capital-cased whole word `Release`,
  // `releaseId`/`release_id`, and the removed tool-names trip the lint.
  // Lowercase prose like "release notes" is allowed (no hard fail).
  const dir = makeTmpSkills();
  mutate(dir, 'kanbantic-issue-prepare',
    s => s + '\n\nGenerate the release notes for the version.\n');
  const r = runLint({ SKILLS_DIR: dir });
  assert.equal(r.status, 0,
    `lowercase "release" must not hard-fail; got ${r.status}\nSTDOUT: ${r.stdout}`);
});

test('positive 5 (opt-out): a line carrying the allow-marker is exempt', () => {
  const dir = makeTmpSkills();
  mutate(dir, 'kanbantic-issue-review',
    s => s + '\n\nThe F6-handler creates a GitHub Release. <!-- lint-skills-allow-release -->\n');
  const r = runLint({ SKILLS_DIR: dir });
  assert.equal(r.status, 0,
    `allow-marker line must be exempt; got ${r.status}\nSTDOUT: ${r.stdout}`);
});

test('infrastructure: missing snapshot exits 2', () => {
  const fakeSnapshot = path.join(os.tmpdir(), `no-such-snapshot-${Date.now()}.json`);
  // Ensure absence.
  try { fs.unlinkSync(fakeSnapshot); } catch (_) { /* expected ENOENT */ }
  const r = runLint({ SNAPSHOT: fakeSnapshot });
  assert.equal(r.status, 2,
    `expected exit 2 (infrastructure), got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stderr, /infrastructure/);
});

test('infrastructure: malformed snapshot exits 2', () => {
  const tmp = path.join(os.tmpdir(), `malformed-snapshot-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{ this is not json', 'utf8');
  try {
    const r = runLint({ SNAPSHOT: tmp });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /infrastructure/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('sanity: real snapshot includes update_validation_status', () => {
  const raw = fs.readFileSync(REAL_SNAPSHOT, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(parsed.tools.includes('update_validation_status'),
    'known-mcp-tools.json must include update_validation_status — required by Invariant 1');
});
