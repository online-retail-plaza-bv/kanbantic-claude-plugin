'use strict';

//
// session-file.js — KBT-F717
//
// Shared, pure helpers for the per-process Kanbantic session-file. Required by
// both kanbantic-mcp-proxy.js (the writer) and hooks/stop-version-summary.js
// (the only registered reader) so the naming scheme lives in exactly one
// place. KBT-F726 removed hooks/transcript-helpers.ps1 (a second, dead
// PowerShell reimplementation of this same scheme, never registered in
// hooks.json and so never invoked) — there is no longer a second reader to
// keep in sync by hand.
//
// Why CLAUDE_CODE_SESSION_ID and not PID:
//   The proxy (an MCP-server stdio subprocess) and the hooks (separate
//   subprocesses, also spawned directly by the Claude Code CLI) do not share
//   memory and cannot learn each other's PID. Both independently see
//   CLAUDE_CODE_SESSION_ID in their environment — Claude Code sets it on
//   itself and it is inherited by every child process it spawns, REGARDLESS of
//   an `env` allowlist in .mcp.json (verified empirically for KBT-F717: a
//   probe MCP-server + a SessionStart hook, spawned independently, saw an
//   identical CLAUDE_CODE_SESSION_ID, equal to the hook's stdin
//   `session_id` payload field; `claude --resume <id>` re-spawns both as new
//   OS processes but keeps the same CLAUDE_CODE_SESSION_ID). That is the
//   correct identity for "one Claude session = one AgentSession" — it also
//   survives a resume, where the PID does not.
//

const fs = require('fs');
const path = require('path');

const SESSION_FILE_PREFIX = '.claude-kanbantic-session-';
const SESSION_FILE_SUFFIX = '.json';

// The WRITER's own key. Only the proxy may use the PID fallback — it is the
// one process that actually knows its own PID; a reader (hook) has no way to
// learn it and must use resolveExistingSessionFile() below instead of guessing.
function ownSessionFileKey(env = process.env, pid = process.pid) {
  return env.CLAUDE_CODE_SESSION_ID || `pid-${pid}`;
}

function sessionFileName(key) {
  return `${SESSION_FILE_PREFIX}${key}${SESSION_FILE_SUFFIX}`;
}

function sessionFilePath(homeDir, env = process.env, pid = process.pid) {
  return path.join(homeDir, sessionFileName(ownSessionFileKey(env, pid)));
}

// READER-side resolution. Never guesses:
//   - CLAUDE_CODE_SESSION_ID present  → that exact file's path (caller checks existence).
//   - absent, exactly 1 candidate file on disk → that file (safe: single-session case).
//   - absent, 0 candidates            → { path: null, ambiguous: false } — silent no-op.
//   - absent, ≥2 candidates           → { path: null, ambiguous: true } — caller must
//     warn and skip; picking "the newest" here is exactly the bug this Feature fixes.
function resolveExistingSessionFile(homeDir, env = process.env, listDirFn = fs.readdirSync) {
  const sid = env.CLAUDE_CODE_SESSION_ID;
  if (sid) {
    return { path: path.join(homeDir, sessionFileName(sid)), ambiguous: false, candidates: null };
  }
  const candidates = listSessionFiles(homeDir, listDirFn);
  if (candidates.length === 1) {
    return { path: path.join(homeDir, candidates[0]), ambiguous: false, candidates };
  }
  return { path: null, ambiguous: candidates.length >= 2, candidates };
}

function listSessionFiles(homeDir, listDirFn = fs.readdirSync) {
  let entries;
  try {
    entries = listDirFn(homeDir);
  } catch {
    return [];
  }
  return entries.filter(
    (name) => name.startsWith(SESSION_FILE_PREFIX) && name.endsWith(SESSION_FILE_SUFFIX)
  );
}

module.exports = {
  SESSION_FILE_PREFIX,
  SESSION_FILE_SUFFIX,
  ownSessionFileKey,
  sessionFileName,
  sessionFilePath,
  resolveExistingSessionFile,
  listSessionFiles,
};
