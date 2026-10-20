#!/usr/bin/env node
'use strict';

//
// remove-issue-worktree — KBT-F745 / KBT-SR653 §Plugin / KBT-RL277 §8
//
// Removes the git worktree of a merged issue branch, the way the review-skill
// (kanbantic-issue-review Step 7, right after `git branch -d`) wants it done —
// so the worktree does not linger until the daemon's nightly HygieneService
// gets to it. It is the plugin-side twin of that service and honours the same
// two gotchas:
//
//   KBT-GTCH142 — `git worktree remove` run from INSIDE the worktree fails and
//                 leaves an orphan directory behind. The script therefore
//                 refuses (reason `cwd-inside-worktree`) instead of trying.
//   KBT-GTCH187 — on Windows, `git worktree remove --force` on a worktree whose
//                 `node_modules` is a junction follows the junction and EMPTIES
//                 ITS TARGET (typically the main checkout's node_modules). The
//                 script detaches every junction/symlink that sits directly
//                 under any `<worktree>/**/node_modules` first — `rmdir` on the
//                 link itself, never touching what it points to.
//
// Usage:
//   node remove-issue-worktree.js --branch <name>  [--repo <root>]
//   node remove-issue-worktree.js --path <worktree> [--repo <root>]
//
//   --repo defaults to the git toplevel of the current directory. The branch
//   may be given as `feature/x` or `refs/heads/feature/x`.
//
// Output: ONE JSON object on stdout, `{ removed, path, reason, detached }`:
//   removed  — true only when `git worktree remove --force` succeeded.
//   path     — the worktree path as git reports it (null when none matched).
//   reason   — null on success; otherwise one of
//              usage | not-a-git-repo | no-worktree | main-worktree |
//              cwd-inside-worktree | git-worktree-remove-failed | error
//   detached — the junctions/symlinks unlinked before the removal.
//
// Exit code is ALWAYS 0 (fail-open): a failed cleanup must never block the
// merge → InDeployment transition. The reason is in the JSON and a warning is
// written to stderr. The local branch is NOT deleted here — `git branch -d`
// in the skill is the proof that the merge happened and stays the skill's job.
//
// Zero deps — Node built-ins only.
//

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const MAX_WALK_DEPTH = 24;

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(args, cwd) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error || null,
  };
}

/**
 * Parse `git worktree list --porcelain` into
 * `[{ path, head, branch, bare, detached, main }]`. The first entry is the
 * main worktree (git's documented ordering).
 */
function parseWorktreeList(porcelain) {
  const entries = [];
  let cur = null;
  for (const raw of String(porcelain).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '') {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length), head: null, branch: null, bare: false, detached: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length);
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line === 'detached') {
      cur.detached = true;
    }
  }
  if (cur) entries.push(cur);
  entries.forEach((e, i) => { e.main = i === 0; });
  return entries;
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

/**
 * Canonical form for comparisons: real path when it exists (expands Windows
 * 8.3 names and resolves junctions in the PREFIX, which is what matters for
 * "is cwd inside"), forward slashes, case-folded on Windows, no trailing slash.
 */
function canon(p) {
  if (!p) return '';
  let real = p;
  try { real = fs.realpathSync.native(p); } catch { /* not on disk — compare as given */ }
  let s = path.resolve(real).replace(/\\/g, '/').replace(/\/+$/, '');
  if (IS_WIN) s = s.toLowerCase();
  return s;
}

function isInside(cwd, worktree) {
  const a = canon(cwd);
  const b = canon(worktree);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + '/');
}

function branchMatches(entryBranch, wanted) {
  if (!entryBranch || !wanted) return false;
  const want = wanted.startsWith('refs/heads/') ? wanted : `refs/heads/${wanted}`;
  return entryBranch === want;
}

function findWorktree(entries, { branch, worktreePath }) {
  if (branch) return entries.find((e) => branchMatches(e.branch, branch)) || null;
  if (worktreePath) {
    const want = canon(worktreePath);
    return entries.find((e) => canon(e.path) === want) || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// KBT-GTCH187 — detach links under node_modules, never follow them
// ---------------------------------------------------------------------------

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Remove the link itself. Directory junctions/symlinks need rmdir on Windows. */
function detachLink(p) {
  if (IS_WIN) {
    try { fs.rmdirSync(p); return true; } catch { /* fall through: file symlink */ }
    fs.unlinkSync(p);
    return true;
  }
  try { fs.unlinkSync(p); return true; } catch { /* fall through */ }
  fs.rmdirSync(p);
  return true;
}

/**
 * Walk the worktree (without following links, skipping `.git`) and detach:
 *   - any `node_modules` entry that is itself a link;
 *   - any link directly under a real `node_modules` dir, including one level
 *     of `@scope/<pkg>` links.
 * The contents of a real node_modules are not descended into any further —
 * what lives below belongs to the packages and `git worktree remove` handles
 * plain directories fine.
 */
function detachLinksUnderNodeModules(worktree, warn) {
  const detached = [];

  function detachChildLinks(nodeModulesDir) {
    let children;
    try { children = fs.readdirSync(nodeModulesDir, { withFileTypes: true }); } catch { return; }
    for (const c of children) {
      const full = path.join(nodeModulesDir, c.name);
      if (isLink(full)) {
        try { detachLink(full); detached.push(full); } catch (e) { warn(`could not detach ${full}: ${e.message}`); }
        continue;
      }
      if (c.name.startsWith('@') && c.isDirectory()) {
        let scoped;
        try { scoped = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
        for (const s of scoped) {
          const sp = path.join(full, s.name);
          if (isLink(sp)) {
            try { detachLink(sp); detached.push(sp); } catch (e) { warn(`could not detach ${sp}: ${e.message}`); }
          }
        }
      }
    }
  }

  function walk(dir, depth) {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.name === 'node_modules') {
        if (isLink(full)) {
          try { detachLink(full); detached.push(full); } catch (err) { warn(`could not detach ${full}: ${err.message}`); }
        } else if (e.isDirectory()) {
          detachChildLinks(full);
        }
        continue;
      }
      if (isLink(full)) continue;          // never follow a link out of the worktree
      if (e.isDirectory()) walk(full, depth + 1);
    }
  }

  walk(worktree, 0);
  return detached;
}

// ---------------------------------------------------------------------------
// main flow
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { branch: null, path: null, repo: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    if (key === '--branch') out.branch = val();
    else if (key === '--path') out.path = val();
    else if (key === '--repo') out.repo = val();
    else if (key === '--help' || key === '-h') out.help = true;
  }
  return out;
}

/**
 * Run the removal. Returns the result object; never throws.
 * @param {{branch?:string, path?:string, repo?:string, cwd?:string, warn?:(m:string)=>void}} opts
 */
function removeIssueWorktree(opts) {
  const warn = opts.warn || (() => {});
  const cwd = opts.cwd || process.cwd();
  const result = { removed: false, path: null, reason: null, detached: [] };

  if (!opts.branch && !opts.path) {
    result.reason = 'usage';
    warn('usage: remove-issue-worktree.js --branch <name> | --path <worktree> [--repo <root>]');
    return result;
  }

  // Repo root: --repo, else the toplevel of cwd (works from any worktree).
  let repo = opts.repo ? path.resolve(opts.repo) : null;
  if (!repo) {
    const top = git(['rev-parse', '--show-toplevel'], cwd);
    if (!top.ok || !top.stdout) {
      result.reason = 'not-a-git-repo';
      warn(`not a git repository: ${cwd}${top.stderr ? ` (${top.stderr})` : ''}`);
      return result;
    }
    repo = top.stdout;
  }

  const list = git(['worktree', 'list', '--porcelain'], repo);
  if (!list.ok) {
    result.reason = 'not-a-git-repo';
    warn(`git worktree list failed in ${repo}: ${list.stderr || (list.error && list.error.message) || ''}`);
    return result;
  }

  const entries = parseWorktreeList(list.stdout);
  const entry = findWorktree(entries, { branch: opts.branch, worktreePath: opts.path });
  if (!entry) {
    result.reason = 'no-worktree';
    warn(`no worktree for ${opts.branch ? `branch ${opts.branch}` : `path ${opts.path}`} — nothing to remove`);
    return result;
  }
  result.path = entry.path;

  if (entry.main || entry.bare) {
    result.reason = 'main-worktree';
    warn(`${entry.path} is the main checkout — refusing to remove it`);
    return result;
  }

  // KBT-GTCH142
  if (isInside(cwd, entry.path)) {
    result.reason = 'cwd-inside-worktree';
    warn(`cwd-inside-worktree: ${cwd} lies inside ${entry.path}; ` +
         `cd to the main checkout first (KBT-GTCH142: removing from inside leaves an orphan directory)`);
    return result;
  }

  // KBT-GTCH187
  if (fs.existsSync(entry.path)) {
    result.detached = detachLinksUnderNodeModules(entry.path, warn);
  }

  const rm = git(['worktree', 'remove', '--force', entry.path], repo);
  const prune = git(['worktree', 'prune'], repo);
  if (!prune.ok) warn(`git worktree prune: ${prune.stderr}`);

  if (!rm.ok) {
    result.reason = 'git-worktree-remove-failed';
    warn(`git worktree remove --force failed: ${rm.stderr || (rm.error && rm.error.message) || `exit ${rm.status}`}`);
    return result;
  }

  result.removed = true;
  if (fs.existsSync(entry.path)) {
    warn(`worktree unregistered but the directory still exists: ${entry.path}`);
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const warn = (m) => process.stderr.write(`remove-issue-worktree: ${m}\n`);
  let result;
  if (args.help) {
    result = { removed: false, path: null, reason: 'usage', detached: [] };
    warn('usage: remove-issue-worktree.js --branch <name> | --path <worktree> [--repo <root>]');
  } else {
    try {
      result = removeIssueWorktree({ branch: args.branch, path: args.path, repo: args.repo, warn });
    } catch (e) {
      result = { removed: false, path: null, reason: 'error', detached: [], error: String(e && e.message || e) };
      warn(`unexpected error: ${e && e.stack || e}`);
    }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0); // fail-open, always
}

module.exports = {
  parseWorktreeList,
  findWorktree,
  isInside,
  detachLinksUnderNodeModules,
  removeIssueWorktree,
};

if (require.main === module) main();
