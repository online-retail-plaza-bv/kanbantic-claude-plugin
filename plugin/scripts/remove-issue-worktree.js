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
// And — KBT-T5233 (review finding I10) — it never destroys work that is not
// committed. Before anything is removed it checks, in this order:
//
//   dirty   — `git -C <worktree> status --porcelain=v1 -z --ignored`. ANY entry
//             (modified/staged tracked file, untracked file, ignored file such
//             as `.env`) ⇒ refuse with reason `dirty`; the first 10 paths are
//             in the JSON (`paths`), the full count in `pathCount`. The only
//             exception is reproducible build output — ignored/untracked
//             entries with a directory named in REPRODUCIBLE_IGNORED
//             (node_modules, bin, obj, dist, .angular) anywhere in their path:
//             those are never "work" and would otherwise make every built
//             worktree un-removable.
//   in-use  — the worktree is `locked` in `git worktree list --porcelain`
//             (an agent/operator deliberately pinned it), OR — Windows only —
//             the directory cannot be renamed. Heuristic: rename the worktree
//             root to `<root>.kbt-rm-probe-<pid>` and straight back. Windows
//             refuses (EPERM/EBUSY) to rename a directory that is the current
//             directory of a live process or that holds an open handle, so a
//             shell / Claude session / dev-server still sitting in the worktree
//             makes the probe fail ⇒ refuse with reason `in-use`. Needs no
//             admin rights and no `handle.exe`. On a failed rename-back the
//             probe retries a few times and reports `error` with the temp name.
//
// Only when both pass does it run a PLAIN `git worktree remove` (no --force)
// followed by `git worktree prune`. Git's own refusal is thereby a second net.
//
// `--force` (operator-only, NEVER passed by the review-skill) skips the dirty
// and in-use checks and restores the old `git worktree remove --force`. The
// JSON then carries `forced: true`.
//
// Usage:
//   node remove-issue-worktree.js --branch <name>  [--repo <root>] [--force]
//   node remove-issue-worktree.js --path <worktree> [--repo <root>] [--force]
//
//   --repo defaults to the git toplevel of the current directory. The branch
//   may be given as `feature/x` or `refs/heads/feature/x`.
//
// Output: ONE JSON object on stdout, `{ removed, path, reason, detached }`:
//   removed   — true only when `git worktree remove` succeeded.
//   path      — the worktree path as git reports it (null when none matched).
//   reason    — null on success; otherwise one of
//               usage | not-a-git-repo | no-worktree | main-worktree |
//               cwd-inside-worktree | dirty | in-use |
//               git-worktree-remove-failed | error
//   detached  — the junctions/symlinks unlinked before the removal.
//   paths     — (reason dirty) up to 10 offending paths; pathCount — all of them.
//   detail    — (reason in-use) `locked` | `process` plus a human hint.
//   forced    — true when --force was given.
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
      cur = { path: line.slice('worktree '.length), head: null, branch: null, bare: false, detached: false, locked: false, lockReason: null };
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
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
      cur.lockReason = line.length > 'locked '.length ? line.slice('locked '.length) : null;
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
// KBT-T5233 — dirty check: uncommitted work is never removed
// ---------------------------------------------------------------------------

/** Ignored top-level directories that are reproducible build output, not work. */
const REPRODUCIBLE_IGNORED = new Set(['node_modules', 'bin', 'obj', 'dist', '.angular']);
const MAX_LISTED_PATHS = 10;

/**
 * Parse `git status --porcelain=v1 -z --ignored` output into
 * `[{ code, path }]`. In -z mode entries are NUL-separated and a rename/copy
 * carries the ORIGINAL path as an extra NUL-terminated field after the entry.
 */
function parseStatusZ(raw) {
  const fields = String(raw).split('\0');
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const code = f.slice(0, 2);
    const p = f.slice(3);
    out.push({ code, path: p });
    if (code[0] === 'R' || code[0] === 'C') i++; // skip the "from" path
  }
  return out;
}

function isReproducibleIgnored(entry) {
  // Ignored (`!!`) or untracked (`??`) — tracked changes under these names
  // still count. A node_modules junction in a repo without .gitignore shows up
  // as `?? node_modules/...` (the KBT-GTCH187 shape).
  if (entry.code !== '!!' && entry.code !== '??') return false;
  // Any segment: `sub/node_modules/...`, `src/Foo/obj/...` (monorepo shapes).
  const segments = entry.path.replace(/\\/g, '/').split('/');
  segments.pop(); // the file itself never counts; only a directory in its prefix
  return segments.some((s) => REPRODUCIBLE_IGNORED.has(s));
}

/**
 * Returns `{ ok, entries, error }`. `entries` are the status lines that count
 * as work (reproducible ignored output filtered out). `ok:false` means status
 * itself failed — the caller treats that as "cannot prove it is clean".
 */
function dirtyEntries(worktree) {
  const r = spawnSync('git', ['-C', worktree, 'status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { ok: false, entries: [], error: (r.stderr || '').trim() || (r.error && r.error.message) || `exit ${r.status}` };
  }
  const entries = parseStatusZ(r.stdout || '').filter((e) => !isReproducibleIgnored(e));
  return { ok: true, entries, error: null };
}

// ---------------------------------------------------------------------------
// KBT-T5233 — in-use check: locked worktree or a live process inside it
// ---------------------------------------------------------------------------

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ }
}

/**
 * Windows-only live-process heuristic. Renames the worktree root to a sibling
 * temp name and immediately back. A directory that is the cwd of a running
 * process (or has any open handle without FILE_SHARE_DELETE) cannot be renamed
 * on Windows — the rename throws EPERM/EBUSY/EACCES. No admin rights needed.
 *
 * Returns `{ inUse, error }`. `error` is set only when the rename-BACK failed
 * after retries; the directory then sits at `error.tempPath` and the caller
 * must surface that loudly.
 */
function probeDirectoryInUse(worktree) {
  if (!IS_WIN) return { inUse: false, error: null };
  const temp = `${worktree.replace(/[\\/]+$/, '')}.kbt-rm-probe-${process.pid}`;
  try {
    fs.renameSync(worktree, temp);
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) return { inUse: true, error: null };
    // ENOENT or anything else: nothing to hold on to, let git decide.
    return { inUse: false, error: null };
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.renameSync(temp, worktree); return { inUse: false, error: null }; } catch (e) { lastErr = e; sleepMs(100 * (attempt + 1)); }
  }
  return { inUse: false, error: { tempPath: temp, message: lastErr ? lastErr.message : 'rename back failed' } };
}

// ---------------------------------------------------------------------------
// main flow
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { branch: null, path: null, repo: null, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    if (key === '--branch') out.branch = val();
    else if (key === '--path') out.path = val();
    else if (key === '--repo') out.repo = val();
    else if (key === '--force' || key === '-f') out.force = true;
    else if (key === '--help' || key === '-h') out.help = true;
  }
  return out;
}

/**
 * Run the removal. Returns the result object; never throws.
 * @param {{branch?:string, path?:string, repo?:string, force?:boolean, cwd?:string, warn?:(m:string)=>void}} opts
 */
function removeIssueWorktree(opts) {
  const warn = opts.warn || (() => {});
  const cwd = opts.cwd || process.cwd();
  const force = Boolean(opts.force);
  const result = { removed: false, path: null, reason: null, detached: [] };
  if (force) result.forced = true;

  if (!opts.branch && !opts.path) {
    result.reason = 'usage';
    warn('usage: remove-issue-worktree.js --branch <name> | --path <worktree> [--repo <root>] [--force]');
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

  const dirExists = fs.existsSync(entry.path);

  // KBT-T5233 — refuse to destroy uncommitted work or a worktree in use.
  // Skipped only with the operator-only --force.
  if (!force) {
    if (dirExists) {
      const st = dirtyEntries(entry.path);
      if (!st.ok) {
        result.reason = 'dirty';
        result.paths = [];
        result.pathCount = 0;
        result.detail = `git status failed: ${st.error}`;
        warn(`dirty: cannot prove ${entry.path} is clean (git status failed: ${st.error}) — refusing; inspect it, or --force as operator`);
        return result;
      }
      if (st.entries.length > 0) {
        result.reason = 'dirty';
        result.paths = st.entries.slice(0, MAX_LISTED_PATHS).map((e) => `${e.code} ${e.path}`);
        result.pathCount = st.entries.length;
        warn(`dirty: ${entry.path} has ${st.entries.length} uncommitted/untracked/ignored path(s) — refusing. ` +
             `First ${Math.min(st.entries.length, MAX_LISTED_PATHS)}: ${result.paths.join(', ')}. ` +
             `Inspect with: git -C "${entry.path}" status --ignored  (operator-only override: --force)`);
        return result;
      }
    }

    if (entry.locked) {
      result.reason = 'in-use';
      result.detail = `locked${entry.lockReason ? `: ${entry.lockReason}` : ''}`;
      warn(`in-use: ${entry.path} is locked in git worktree list${entry.lockReason ? ` (${entry.lockReason})` : ''} — ` +
           `refusing; \`git worktree unlock "${entry.path}"\` once the owner is done`);
      return result;
    }

    if (dirExists) {
      const probe = probeDirectoryInUse(entry.path);
      if (probe.error) {
        result.reason = 'error';
        result.detail = `rename probe could not restore the directory; it is at ${probe.error.tempPath}: ${probe.error.message}`;
        warn(`error: ${result.detail}`);
        return result;
      }
      if (probe.inUse) {
        result.reason = 'in-use';
        result.detail = 'process: a live process holds the worktree directory (cwd or open handle)';
        warn(`in-use: ${entry.path} is held by a live process (cwd or open handle: a shell, Claude session or dev-server still inside it) — ` +
             `refusing; close it and run again (operator-only override: --force)`);
        return result;
      }
    }
  }

  // KBT-GTCH187
  if (dirExists) {
    result.detached = detachLinksUnderNodeModules(entry.path, warn);
  }

  const rmArgs = force ? ['worktree', 'remove', '--force', entry.path] : ['worktree', 'remove', entry.path];
  const rm = git(rmArgs, repo);
  const prune = git(['worktree', 'prune'], repo);
  if (!prune.ok) warn(`git worktree prune: ${prune.stderr}`);

  if (!rm.ok) {
    result.reason = 'git-worktree-remove-failed';
    warn(`git ${rmArgs.slice(0, 3).join(' ')} failed: ${rm.stderr || (rm.error && rm.error.message) || `exit ${rm.status}`}`);
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
    warn('usage: remove-issue-worktree.js --branch <name> | --path <worktree> [--repo <root>] [--force]');
  } else {
    try {
      result = removeIssueWorktree({ branch: args.branch, path: args.path, repo: args.repo, force: args.force, warn });
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
  parseStatusZ,
  dirtyEntries,
  probeDirectoryInUse,
  removeIssueWorktree,
  REPRODUCIBLE_IGNORED,
};

if (require.main === module) main();
