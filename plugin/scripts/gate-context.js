#!/usr/bin/env node
'use strict';

//
// gate-context — KBT-F447 (KBT-E087) — context-aware lane-skill gate helper.
//
// The four lane-skills (triage / prepare / execute / review) carry two
// workstation-only HARD-GATEs:
//   - Step 0   "Ensure Repository Access" (clone the repo)
//   - Step 0.5 "Worktree HARD-GATE"       (refuse to run in the main tree)
//
// Those gates assume a real git checkout on a developer workstation. In
// Cowork/desktop the run is MCP-only: there is no git repo, the prepare is
// pure Kanbantic-artifact work, and the worktree gate has nothing to guard.
// Enforcing it there is a false-positive STOP that blocks legitimate work.
//
// This module is the single source of truth for the decision. It is PURE —
// no filesystem writes, no process.exit, no MCP — so it is trivially unit-
// testable and can be referenced from the SKILL.md prose (decision rule
// `shouldEnforceWorktreeGate`).
//
// Decision rule (KBT-BD155 scope boundary):
//   !hasGitRepo                       → false  (no repo → nothing to guard)
//   hasGitRepo && !touchesFilesystem  → false  (MCP-only → no code work)
//   hasGitRepo &&  touchesFilesystem  → true   (real code work in a repo —
//                                               full parallel-agent safety,
//                                               KBT-TRUL004 / KBT-TRUL004)
//
// When the decision is `false` the skill SKIPS the gate and logs the skip as
// a Comment discussion-entry — a mirror of the existing KANBANTIC_SKIP_GIT_SYNC
// opt-out pattern (KBT-F238). When `true` the STRICT worktree gate stays fully
// in force; this helper never weakens the code-in-a-repo path.
//
// Zero deps — Node built-ins only. CommonJS, `module.exports` (matches the
// style of check-version-sync.js / lint-skills.js).
//

const { execFileSync } = require('node:child_process');

/**
 * Pure decision helper: should the worktree/repo HARD-GATE be enforced?
 *
 * @param {object}  ctx
 * @param {boolean} ctx.hasGitRepo        true when the run is inside a real git checkout.
 * @param {boolean} ctx.touchesFilesystem true when the step performs filesystem/code work
 *                                         (clone, branch, edit, commit, merge, push) as
 *                                         opposed to MCP-only Kanbantic-artifact work.
 * @returns {boolean} true → enforce the strict gate; false → skip it (and log the skip).
 */
function shouldEnforceWorktreeGate({ hasGitRepo, touchesFilesystem } = {}) {
  // Coerce to strict booleans so callers passing truthy/falsy values
  // (undefined, 1, '') get deterministic behaviour.
  const repo = Boolean(hasGitRepo);
  const fsWork = Boolean(touchesFilesystem);

  // No git repo → there is no main-tree / worktree distinction to protect.
  if (!repo) return false;

  // In a repo but the step is MCP-only (no code reads/writes) → nothing
  // for the worktree gate to guard against.
  if (!fsWork) return false;

  // Real code work inside a repo → enforce the strict gate (parallel-agent
  // safety). This is the path KBT-BD155 forbids weakening.
  return true;
}

/**
 * Best-effort, pure-ish detection of whether `cwd` is inside a git repo.
 *
 * Returns a plain boolean and never throws — a non-zero exit, a missing git
 * binary, or any spawn error all resolve to `false` (treat as "no repo",
 * which makes the gate skip rather than hard-stop). It performs no writes.
 *
 * @param {string} [cwd] working directory to probe (defaults to process.cwd()).
 * @returns {boolean} true when `git rev-parse --is-inside-work-tree` succeeds.
 */
function detectGitRepo(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch (_) {
    return false;
  }
}

module.exports = { shouldEnforceWorktreeGate, detectGitRepo };
