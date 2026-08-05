'use strict';

//
// workspace-detect.js — KBT-F637 / KBT-SR606
//
// Determines which Kanbantic workspace the current repository belongs to, for
// the SessionStart toolkit-sync hook.
//
// This module is deliberately a **pure function** over already-gathered inputs:
// no filesystem, no network, no environment access of its own. Everything it
// needs is handed to it. That is what makes the layer *ordering* testable — an
// impure version could only be checked on its answer, never on whether it
// consulted layer 3 while layer 2 already knew.
//
// The ordering is not a micro-optimisation. Layer 3 costs a network round-trip
// on every single session start; layers 1 and 2 cost nothing. Getting the order
// wrong is invisible in the result and expensive in practice.
//
// Layers, highest precedence first:
//   1. env   — KANBANTIC_WORKSPACE_ID. Explicit always wins.
//   2. manifest — the `workspace` field of an existing .kanbantic-sync.json.
//                 After one successful sync the repo knows its own workspace.
//   3. remote — match the git remote URL against the known repositories.
//               This is the layer that serves a fresh clone.
//   4. none  — give up quietly. The hook prints one hint and exits 0.
//

/**
 * Normalise a git remote URL down to the part that actually identifies a
 * repository, so that cosmetic differences don't defeat the match.
 *
 * Equivalent inputs that must all collapse to `github.com/org/repo`:
 *   https://github.com/Org/Repo.git
 *   https://github.com/org/repo
 *   git@github.com:org/repo.git
 *   ssh://git@github.com/org/repo.git
 *
 * Returns '' for anything unusable, which never matches.
 */
function normalizeRemote(url) {
  if (typeof url !== 'string') return '';
  let s = url.trim();
  if (!s) return '';

  // scp-style shorthand: git@host:org/repo → host/org/repo
  const scp = s.match(/^[^/]+@([^:/]+):(.+)$/);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    // Strip any scheme, then any user@ prefix left over from ssh:// URLs.
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    s = s.replace(/^[^/@]+@/, '');
  }

  // Order matters: a URL can end in `.git/`, so trailing slashes have to go
  // first or the `.git` suffix survives and defeats the match.
  s = s.replace(/\/+$/, '');      // trailing slashes say nothing about identity
  s = s.replace(/\.git$/i, '');   // ...and neither does a trailing .git
  s = s.replace(/\/+$/, '');      // in case stripping .git exposed another
  return s.toLowerCase();
}

/**
 * Decide the workspace.
 *
 * @param {object} input
 * @param {object} [input.env]            process.env-shaped object
 * @param {object|null} [input.manifest]  parsed .kanbantic-sync.json, or null
 * @param {string} [input.remoteUrl]      `git remote get-url origin` output
 * @param {Array}  [input.repositories]   [{ workspace, url }, ...] known repos
 *
 * @returns {{workspace: string|null, source: string, candidates?: string[]}}
 *   `source` is one of 'env' | 'manifest' | 'remote' | 'none' | 'ambiguous'.
 *   It exists so callers — and tests — can see which layer answered, not just
 *   what the answer was.
 */
function detectWorkspace(input) {
  const { env = {}, manifest = null, remoteUrl = '', repositories = [] } = input || {};

  // ── Layer 1: explicit environment override ──────────────────────────────
  const fromEnv = typeof env.KANBANTIC_WORKSPACE_ID === 'string'
    ? env.KANBANTIC_WORKSPACE_ID.trim()
    : '';
  if (fromEnv) {
    return { workspace: fromEnv, source: 'env' };
  }

  // ── Layer 2: the repo's own manifest from a previous successful sync ────
  const fromManifest = manifest && typeof manifest.workspace === 'string'
    ? manifest.workspace.trim()
    : '';
  if (fromManifest) {
    return { workspace: fromManifest, source: 'manifest' };
  }

  // ── Layer 3: match the git remote against known repositories ────────────
  const target = normalizeRemote(remoteUrl);
  if (target) {
    const hits = [];
    for (const repo of repositories) {
      if (!repo || normalizeRemote(repo.url) !== target) continue;
      const ws = typeof repo.workspace === 'string' ? repo.workspace.trim() : '';
      if (ws && !hits.includes(ws)) hits.push(ws);
    }
    if (hits.length === 1) {
      return { workspace: hits[0], source: 'remote' };
    }
    if (hits.length > 1) {
      // Two workspaces claim the same remote. Picking one at random would sync
      // this repo against someone else's skills and overwrite the mirrors with
      // them — strictly worse than doing nothing. Report and let the operator
      // settle it with layer 1.
      return { workspace: null, source: 'ambiguous', candidates: hits };
    }
  }

  // ── Layer 4: no answer ──────────────────────────────────────────────────
  return { workspace: null, source: 'none' };
}

module.exports = { detectWorkspace, normalizeRemote };
