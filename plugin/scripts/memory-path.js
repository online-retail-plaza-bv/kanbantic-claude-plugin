'use strict';

//
// memory-path.js — KBT-B492 / KBT-BD210
//
// Decides whether a file path is a *local memory* location — the thing
// KBT-TRUL021 (and ADM-TRUL006) forbid writing knowledge to.
//
// This module is deliberately a **pure function** over a single string: no
// filesystem, no network, no environment. That is what makes the hook's
// *ordering* testable — KBT-SR611 requires the path-match to run before any
// workspace detection or network round-trip, and an impure version could only
// be checked on its answer, never on whether it short-circuited first.
//
// The ordering is not a micro-optimisation. This runs on every single Write
// and Edit, in every repository, Kanbantic-related or not. The overwhelming
// majority of calls are misses, and a miss must cost nothing.
//
// Two shapes count as local memory:
//   1. anything under `.claude/projects/<slug>/memory/`
//   2. a file named exactly `MEMORY.md`, at any level
//
// Both come straight from the rule's own wording. The second is deliberately
// broad — the rule names that file explicitly — and is the only place a false
// positive is plausible. It is bounded by requiring an exact basename match:
// `MEMORY.md.bak` and `NOT-MEMORY.md` are not it.
//

/**
 * Normalise a path for matching: backslashes to forward slashes, collapse
 * repeated separators, and lowercase.
 *
 * Windows paths arrive with backslashes and arbitrary casing; the same file
 * must match whether it came in as `C:\Users\x\.claude\...` or
 * `/c/Users/x/.claude/...`. Casing is folded because Windows filesystems are
 * case-insensitive and a rule that depends on `Memory` vs `memory` would be a
 * coin flip.
 *
 * Returns '' for anything unusable, which never matches.
 */
function normalizePath(filePath) {
  if (typeof filePath !== 'string') return '';
  const s = filePath.trim();
  if (!s) return '';
  return s.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

// Anything below `.claude/projects/<slug>/memory/`. The `<slug>` segment must
// be a real segment — `[^/]+` — so `.claude/projects/memory/x.md` (no project
// slug) does not match: that is not the per-project memory store.
const PROJECT_MEMORY_DIR = /(^|\/)\.claude\/projects\/[^/]+\/memory\//;

/**
 * Is this path a local-memory location?
 *
 * @param {string} filePath  a `tool_input.file_path` value, any separator style
 * @returns {boolean}
 */
function isLocalMemoryPath(filePath) {
  const p = normalizePath(filePath);
  if (!p) return false;

  if (PROJECT_MEMORY_DIR.test(p)) return true;

  // Exact basename match. Splitting on '/' and comparing the last segment is
  // stricter than a regex on the whole string and cannot be fooled by a
  // suffix: `memory.md.bak` has basename `memory.md.bak`, not `memory.md`.
  const basename = p.slice(p.lastIndexOf('/') + 1);
  return basename === 'memory.md';
}

module.exports = { isLocalMemoryPath, normalizePath, PROJECT_MEMORY_DIR };
