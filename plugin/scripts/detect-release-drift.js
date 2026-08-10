#!/usr/bin/env node
'use strict';

//
// KBT-B586 — release-drift detector: does the registry lag the repo?
//
// Companion to detect-release-bump.js, and deliberately the opposite shape.
//
// `detect-release-bump.js` asks an EVENT-shaped question: "did this commit change
// the version?" It diffs HEAD against its first parent and refuses any ref that is
// not the tip of the default branch. Correct for what it asks — and answerable only
// by whoever stands on the merge commit at the moment it is created.
//
// That is why KBT-B545's guard covered nothing. It hung off `kanbantic-issue-review`
// Step 7, the merge the skill performs itself, and in this workspace that is the one
// route deliberately not taken: KBT-TRUL030 has a subagent deliver up to `Review` and
// a supervising agent merge after checking. On 2026-08-10 all eight merged PRs went
// that way — including the release of v2.37.0, which shipped the guard and had to be
// registered by hand.
//
// This script asks a STATE-shaped question instead: "does the registry lag the repo?"
// Two numbers, compared. No commit, no ref, no merge — so no merge route can bypass
// it, and it is answerable at any later moment by anyone. Route-independence is not
// a property that has to be policed here; it follows from the shape (KBT-RL210).
//
// What it deliberately does NOT do — see KBT-BD208 for the full list: it reports
// after the fact rather than preventing, it needs something to run it, it has no CI
// coverage (this repo's CI holds no Kanbantic credentials), it only covers repos with
// a resolvable carrier, and it never backfills history.
//
// The baseline comes from `preview_next_version`, whose `baselineNumber` is the
// highest *registered* Version for the Application — Planned included. Verified live:
// with the repo on 2.37.0 it answered `baselineNumber: "v2.38.0"`, because a Planned
// bucket for the next release was already open. So "registry ahead of repo" is the
// healthy steady state and must not be reported as drift; only the registry being
// *behind* the repo means a shipped release went unrecorded.
//
// Output: one line of JSON, e.g.
//   {"answerable":true,"drifted":true,"repoVersion":"2.37.0","baselineNumber":"v2.36.0",
//    "relation":"registry-behind","action":"close-out","reason":"..."}
//
// Exit code is always 0. This runs as a SessionStart hook, and a hook that fails a
// session is worse than the drift it reports. "Could not tell" is reported as
// `answerable:false` and never as `drifted:false` — the same discipline as
// detect-release-bump.js's exit 1.
//
// Usage:
//   node plugin/scripts/detect-release-drift.js [repoRoot] [--baseline <version>]
//                                              [--application <guid>] [--quiet]
//
// Zero deps — only node built-ins.
//

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const CARRIER = 'plugin/.claude-plugin/plugin.json';

// Same candidate list as detect-release-bump.js, and for the same reason: there is no
// cheap, offline way to ask git which branch is "the" default one, and these four
// cover every repo in this workspace. Kept identical on purpose — two guards that
// disagree about which branch is authoritative would be worse than either alone.
const DEFAULT_BRANCH_REFS = ['origin/main', 'main', 'origin/master', 'master'];

function git(repoRoot, args) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

/**
 * Parse a version into comparable segments.
 *
 * Accepts `2.37.0`, `v2.37.0`, and `v2.37` (patch defaults to 0). Anything else
 * returns null, which the caller must turn into "cannot tell" rather than a
 * reassuring answer.
 *
 * Note the deliberate strictness: Kanbantic Version *names* are free text and
 * routinely carry a description ("v2.36.0 — Toolkit-sync hygiëne"), while
 * `baselineNumber` is a clean number. A leading-anchored match keeps a name that
 * merely *contains* digits from being mistaken for a version.
 */
function normalizeVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** -1 when a < b, 0 when equal, 1 when a > b. Numeric per segment. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The pure decision rule. Takes two version numbers and nothing else.
 *
 * The single-object arity is load-bearing, not stylistic: a rule that cannot
 * accept a repoRoot or a ref cannot become route-dependent later. A test pins
 * `detectReleaseDrift.length === 1` for exactly that reason.
 *
 * @param {{repoVersion: string|null, baselineNumber: string|null}} input
 * @returns {{answerable: boolean, drifted: boolean|null, repoVersion: *,
 *            baselineNumber: *, relation: string, action: string|null,
 *            reason: string}}
 */
function detectReleaseDrift({ repoVersion, baselineNumber } = {}) {
  const repo = normalizeVersion(repoVersion);

  if (repo === null) {
    return {
      answerable: false,
      drifted: null,
      repoVersion: repoVersion ?? null,
      baselineNumber: baselineNumber ?? null,
      relation: 'unknown',
      action: null,
      reason: `cannot read a version number from the repository carrier `
        + `(${JSON.stringify(repoVersion ?? null)}). Refusing to report "no drift".`,
    };
  }

  // No registered Version at all for this Application. That is drift — the repo has
  // shipped something the registry has never heard of — and it is not an error.
  if (baselineNumber === null || baselineNumber === undefined || baselineNumber === '') {
    return {
      answerable: true,
      drifted: true,
      repoVersion,
      baselineNumber: null,
      relation: 'registry-empty',
      action: 'create-and-release',
      reason: `the repository carries ${repoVersion} and the registry holds no Version `
        + `for this Application at all. Create it, then freeze + mark it released.`,
    };
  }

  const baseline = normalizeVersion(baselineNumber);

  if (baseline === null) {
    // A baseline that exists but cannot be parsed is a data problem, not an absence.
    // Treating it as "no baseline" would raise a false alarm; treating it as "in
    // step" would hide a real one. Neither is honest, so say so instead.
    return {
      answerable: false,
      drifted: null,
      repoVersion,
      baselineNumber,
      relation: 'unknown',
      action: null,
      reason: `the registry's baseline ${JSON.stringify(baselineNumber)} is not a `
        + `version number, so it cannot be compared with ${repoVersion}. `
        + `Refusing to report "no drift".`,
    };
  }

  const cmp = compareVersions(repo, baseline);

  if (cmp > 0) {
    return {
      answerable: true,
      drifted: true,
      repoVersion,
      baselineNumber,
      relation: 'registry-behind',
      action: 'close-out',
      reason: `the repository carries ${repoVersion} but the registry's highest `
        + `registered Version is ${baselineNumber}. A release shipped without being `
        + `recorded — register ${repoVersion}, then freeze + mark it released.`,
    };
  }

  if (cmp === 0) {
    return {
      answerable: true,
      drifted: false,
      repoVersion,
      baselineNumber,
      relation: 'in-step',
      action: null,
      reason: `the registry knows ${baselineNumber}, which is what the repository `
        + `carries. Nothing to register.`,
    };
  }

  // Registry ahead of repo: a Planned bucket is open for work that has not shipped
  // yet. This is the normal steady state after Step 8.5c, not a fault.
  return {
    answerable: true,
    drifted: false,
    repoVersion,
    baselineNumber,
    relation: 'registry-ahead',
    action: null,
    reason: `the registry is at ${baselineNumber}, ahead of the repository's `
      + `${repoVersion} — an open Planned bucket for unshipped work. Nothing to do.`,
  };
}

/**
 * Read the version the repo has actually *shipped*.
 *
 * Deliberately the default branch, not the working tree. On a release branch the
 * working-tree carrier already holds the new number while nothing has shipped, and
 * reading it would make this check cry drift on every release PR — precisely the
 * false alarm that gets a hook disabled. Falls back to the working tree only when no
 * default-branch ref resolves at all (a fresh repo with no remote).
 */
function readShippedVersion(repoRoot) {
  for (const ref of DEFAULT_BRANCH_REFS) {
    if (git(repoRoot, ['rev-parse', '--verify', ref]).status !== 0) continue;
    const shown = git(repoRoot, ['show', `${ref}:${CARRIER}`]);
    if (shown.status !== 0) continue;
    try {
      const v = JSON.parse(shown.stdout).version;
      if (v) return v;
    } catch (_) {
      // fall through to the next ref
    }
  }
  try {
    const v = JSON.parse(fs.readFileSync(path.join(repoRoot, CARRIER), 'utf8')).version;
    return v || null;
  } catch (_) {
    return null;
  }
}

/**
 * The Application whose registry we compare against.
 *
 * Read from `git config kanbantic.applicationId`, mirroring the `kanbantic.repositoryId`
 * key the bundled credential helper already relies on. Per-clone git config is the
 * right home: it is opt-in, it survives plugin upgrades, and worktrees inherit the
 * primary clone's config so one setting covers them all.
 *
 * Absent ⇒ this clone has not opted in, and the check stays silent. That is a stated
 * limit (KBT-BD208), not a silent failure: a wrong Application would compare against
 * someone else's version stream and produce confident nonsense.
 */
function resolveApplicationId(repoRoot, argv) {
  const flag = argv.indexOf('--application');
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  if (process.env.KANBANTIC_RELEASE_DRIFT_APPLICATION) {
    return process.env.KANBANTIC_RELEASE_DRIFT_APPLICATION;
  }
  const r = git(repoRoot, ['config', '--get', 'kanbantic.applicationId']);
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v || null;
}

/** Ask Kanbantic for the highest registered Version. Never throws. */
async function fetchBaseline(applicationId) {
  let createClient;
  try {
    ({ createClient } = require('./mcp-toolkit-fetch.js'));
  } catch (_) {
    return { baselineNumber: null, error: 'the MCP helper could not be loaded' };
  }
  try {
    const payload = await createClient().call('preview_next_version', { applicationId });
    // An Application with no Versions yet answers without a baseline. That is a real
    // "registry-empty", so pass the absence through rather than calling it an error.
    return { baselineNumber: payload && payload.baselineNumber ? payload.baselineNumber : null };
  } catch (err) {
    return { baselineNumber: null, error: (err && err.message) || 'unknown error' };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a, i) => !a.startsWith('--')
    && !(i > 0 && ['--baseline', '--application'].includes(argv[i - 1])));
  const repoRoot = path.resolve(positional[0] || process.cwd());
  const quiet = argv.includes('--quiet');

  const say = (obj) => {
    if (!quiet || obj.drifted === true || obj.answerable === false) {
      process.stdout.write(`${JSON.stringify(obj)}\n`);
    }
  };

  if (git(repoRoot, ['rev-parse', '--is-inside-work-tree']).status !== 0) {
    say({
      answerable: false, drifted: null, repoVersion: null, baselineNumber: null,
      relation: 'unknown', action: null,
      reason: `not a git repository: ${repoRoot}`,
    });
    return;
  }

  const repoVersion = readShippedVersion(repoRoot);

  const baselineFlag = argv.indexOf('--baseline');
  let baselineNumber = null;
  let fetchError = null;

  if (baselineFlag !== -1 && argv[baselineFlag + 1]) {
    baselineNumber = argv[baselineFlag + 1];
  } else {
    const applicationId = resolveApplicationId(repoRoot, argv);
    if (!applicationId) {
      say({
        answerable: false, drifted: null, repoVersion, baselineNumber: null,
        relation: 'unknown', action: null,
        reason: 'no Application configured for this clone, so there is no registry to '
          + 'compare against. Set it with: git config kanbantic.applicationId <guid>. '
          + 'Until then this check cannot tell (see KBT-BD208).',
      });
      return;
    }
    ({ baselineNumber, error: fetchError } = await fetchBaseline(applicationId));
    if (fetchError) {
      say({
        answerable: false, drifted: null, repoVersion, baselineNumber: null,
        relation: 'unknown', action: null,
        reason: `could not read the registry (${fetchError}), so drift cannot be `
          + `determined. Refusing to report "no drift".`,
      });
      return;
    }
  }

  say(detectReleaseDrift({ repoVersion, baselineNumber }));
}

if (require.main === module) {
  // Exit 0 on every path, including an unexpected throw: this is a SessionStart hook
  // and breaking the session is a worse outcome than an unreported drift.
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({
      answerable: false,
      drifted: null,
      repoVersion: null,
      baselineNumber: null,
      relation: 'unknown',
      action: null,
      reason: `release-drift check failed: ${(err && err.message) || 'unknown error'}`,
    })}\n`);
    process.exit(0);
  });
}

module.exports = {
  detectReleaseDrift,
  normalizeVersion,
  compareVersions,
  readShippedVersion,
  resolveApplicationId,
  CARRIER,
};
