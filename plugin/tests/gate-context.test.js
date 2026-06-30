'use strict';

//
// gate-context.test.js — KBT-F447 / KBT-T3299 / KBT-T3302
//
// Covers the pure decision helper `shouldEnforceWorktreeGate` (3 paths +
// edge cases) and `detectGitRepo` (best-effort, never-throws), plus an
// integration-style assertion of the no-repo SKIP path: when !hasGitRepo the
// decision is "skip" and an opt-out log entry should be produced (mirroring
// the KANBANTIC_SKIP_GIT_SYNC pattern). No real skill-run is needed — we test
// the helper logic + the skip-intent it implies.
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { shouldEnforceWorktreeGate, detectGitRepo } =
  require('../scripts/gate-context.js');

// ---------------------------------------------------------------------------
// shouldEnforceWorktreeGate — the three canonical paths (KBT-T3299)
// ---------------------------------------------------------------------------

test('path 1: no git repo → gate is NOT enforced (skip)', () => {
  assert.equal(
    shouldEnforceWorktreeGate({ hasGitRepo: false, touchesFilesystem: false }),
    false
  );
  // Even if a (nonsensical) "touches filesystem" flag is set, no repo wins.
  assert.equal(
    shouldEnforceWorktreeGate({ hasGitRepo: false, touchesFilesystem: true }),
    false
  );
});

test('path 2: repo present but MCP-only (no fs work) → gate is NOT enforced (skip)', () => {
  assert.equal(
    shouldEnforceWorktreeGate({ hasGitRepo: true, touchesFilesystem: false }),
    false
  );
});

test('path 3: repo present AND fs/code work → gate IS enforced (strict, KBT-BD155)', () => {
  assert.equal(
    shouldEnforceWorktreeGate({ hasGitRepo: true, touchesFilesystem: true }),
    true
  );
});

// ---------------------------------------------------------------------------
// shouldEnforceWorktreeGate — edge cases / input coercion
// ---------------------------------------------------------------------------

test('edge: missing argument object → defaults to skip (false)', () => {
  assert.equal(shouldEnforceWorktreeGate(), false);
  assert.equal(shouldEnforceWorktreeGate({}), false);
});

test('edge: truthy/falsy non-boolean inputs are coerced deterministically', () => {
  // hasGitRepo truthy (1) + touchesFilesystem truthy ('x') → enforce.
  assert.equal(
    shouldEnforceWorktreeGate({ hasGitRepo: 1, touchesFilesystem: 'x' }),
    true
  );
  // hasGitRepo truthy but touchesFilesystem falsy (0 / '' / undefined) → skip.
  assert.equal(
    shouldEnforceWorktreeGate({ hasGitRepo: 1, touchesFilesystem: 0 }),
    false
  );
  assert.equal(
    shouldEnforceWorktreeGate({ hasGitRepo: 'yes', touchesFilesystem: '' }),
    false
  );
  // hasGitRepo falsy → always skip regardless of fs flag.
  assert.equal(
    shouldEnforceWorktreeGate({ hasGitRepo: 0, touchesFilesystem: 'x' }),
    false
  );
});

test('purity: helper has no side effects and returns a strict boolean', () => {
  const arg = { hasGitRepo: true, touchesFilesystem: true };
  const r = shouldEnforceWorktreeGate(arg);
  assert.equal(typeof r, 'boolean');
  // Argument object is not mutated.
  assert.deepEqual(arg, { hasGitRepo: true, touchesFilesystem: true });
});

// ---------------------------------------------------------------------------
// detectGitRepo — best-effort, never throws
// ---------------------------------------------------------------------------

const HAS_GIT = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
})();

test('detectGitRepo: a non-repo temp dir returns false (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ctx-norepo-'));
  try {
    assert.equal(detectGitRepo(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectGitRepo: an initialised repo returns true', { skip: HAS_GIT ? false : 'git not on PATH' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ctx-repo-'));
  try {
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir, encoding: 'utf8' });
    assert.equal(detectGitRepo(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectGitRepo: bogus cwd never throws → false', () => {
  // A path that does not exist: spawn fails → caught → false.
  const bogus = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`);
  assert.equal(detectGitRepo(bogus), false);
});

// ---------------------------------------------------------------------------
// Integration: the no-repo SKIP path produces a skip-decision + opt-out log
// (KBT-T3302). We model the skill's skip behaviour: when the gate is NOT
// enforced, the skill must emit an opt-out Comment-discussion log mirroring
// the KANBANTIC_SKIP_GIT_SYNC pattern. We assert the helper drives the skip
// and that a faithful log-builder produces a message referencing the rule.
// ---------------------------------------------------------------------------

// Mirror of the skip-log the SKILL.md prose instructs the agent to record.
// Kept local to the test so it documents the contract without coupling the
// pure helper to logging concerns.
function buildGateSkipLog(ctx) {
  const enforce = shouldEnforceWorktreeGate(ctx);
  if (enforce) return null; // gate enforced → no skip log
  const reason = !ctx.hasGitRepo
    ? 'no git repository in this environment (MCP-only prepare)'
    : 'MCP-only step (no filesystem/code work)';
  return {
    skipped: true,
    entryType: 'Comment',
    message:
      `Worktree HARD-GATE skipped: ${reason}. `
      + 'Decision per shouldEnforceWorktreeGate (gate-context.js, KBT-F447). '
      + 'Mirrors the KANBANTIC_SKIP_GIT_SYNC opt-out pattern.',
  };
}

test('integration: !hasGitRepo → decision is skip AND an opt-out log is produced', () => {
  const ctx = { hasGitRepo: false, touchesFilesystem: false };
  assert.equal(shouldEnforceWorktreeGate(ctx), false, 'no-repo must skip the gate');

  const log = buildGateSkipLog(ctx);
  assert.ok(log, 'a skip log must be produced when the gate is skipped');
  assert.equal(log.skipped, true);
  assert.equal(log.entryType, 'Comment');
  assert.match(log.message, /shouldEnforceWorktreeGate/);
  assert.match(log.message, /KANBANTIC_SKIP_GIT_SYNC/);
  assert.match(log.message, /no git repository/);
});

test('integration: MCP-only-in-repo → skip log cites the MCP-only reason', () => {
  const ctx = { hasGitRepo: true, touchesFilesystem: false };
  assert.equal(shouldEnforceWorktreeGate(ctx), false);
  const log = buildGateSkipLog(ctx);
  assert.ok(log);
  assert.match(log.message, /MCP-only step/);
});

test('integration: code-work-in-repo → gate enforced, NO skip log (KBT-BD155)', () => {
  const ctx = { hasGitRepo: true, touchesFilesystem: true };
  assert.equal(shouldEnforceWorktreeGate(ctx), true);
  assert.equal(buildGateSkipLog(ctx), null,
    'enforcing the gate must NOT produce a skip log — code work stays guarded');
});
