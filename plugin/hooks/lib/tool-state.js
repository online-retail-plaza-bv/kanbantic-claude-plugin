'use strict';

//
// tool-state.js — KBT-F741 / KBT-T5188 + T5189
//
// Tiny per-session scratch state shared by the hook scripts, kept in files
// because every hook is its own short-lived process.
//
// 1. PreToolUse remembers `tool_use_id` per call, so the PermissionRequest
//    router can attach its allow-decision to the SAME tool-activity row.
//    Claude Code's PermissionRequest payload carries NO `tool_use_id` (checked
//    against the hooks reference), while PreToolUse — which fires before the
//    permission question — does. Matching is by tool name + a hash of the
//    input; no match falls back to a synthetic id (see `fallbackToolUseId`).
//    One file per call (no read-modify-write) so parallel tool calls cannot
//    lose each other's entries.
//
// 2. The router leaves a marker when it has reported a permission question, so
//    the Notification(permission_prompt) that follows does not overwrite the
//    router's richer "[permission] <tool>: <input>" prompt with a generic one.
//
// Location: $KANBANTIC_HOOK_STATE_DIR (tests) or <tmpdir>/kanbantic-hooks.
// Everything is best effort: any I/O error means "no state", never a failure.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_AGE_MS = 60 * 60 * 1000;
const MARKER_WINDOW_MS = 60 * 1000;

function stateDir(env = process.env) {
  const dir = env.KANBANTIC_HOOK_STATE_DIR || path.join(os.tmpdir(), 'kanbantic-hooks');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
  return dir;
}

const part = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function inputHash(toolName, toolInput) {
  return crypto.createHash('sha1').update(`${toolName}\n${stable(toolInput)}`).digest('hex');
}

/** Synthetic id when the payload has none: <session_id>:<tool_name>:<timestamp>. */
function fallbackToolUseId(sessionId, toolName) {
  return `${sessionId || 'unknown'}:${toolName || 'tool'}:${Date.now()}`;
}

function preFile(env, sessionId, toolUseId) {
  return path.join(stateDir(env), `pre-${part(sessionId)}-${part(toolUseId)}.json`);
}

function sweep(dir) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      try {
        if (now - fs.statSync(f).mtimeMs > MAX_AGE_MS) fs.unlinkSync(f);
      } catch (_) { /* raced with another hook */ }
    }
  } catch (_) { /* best effort */ }
}

function rememberPre(env, sessionId, toolUseId, toolName, toolInput) {
  try {
    const f = preFile(env, sessionId, toolUseId);
    sweep(path.dirname(f));
    fs.writeFileSync(f, JSON.stringify({
      toolUseId, toolName, hash: inputHash(toolName, toolInput), at: Date.now(),
    }));
  } catch (_) { /* best effort */ }
}

function forgetPre(env, sessionId, toolUseId) {
  try { fs.unlinkSync(preFile(env, sessionId, toolUseId)); } catch (_) { /* gone already */ }
}

/** The newest remembered PreToolUse id for this exact tool call, or null. */
function findPre(env, sessionId, toolName, toolInput) {
  try {
    const dir = stateDir(env);
    const wanted = inputHash(toolName, toolInput);
    const prefix = `pre-${part(sessionId)}-`;
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_) { continue; }
      if (!rec || rec.toolName !== toolName || rec.hash !== wanted) continue;
      if (Date.now() - rec.at > MAX_AGE_MS) continue;
      if (!best || rec.at > best.at) best = rec;
    }
    return best ? best.toolUseId : null;
  } catch (_) {
    return null;
  }
}

const markerFile = (env, sessionId) => path.join(stateDir(env), `permreq-${part(sessionId)}.json`);

function markPermissionReported(env, sessionId) {
  try { fs.writeFileSync(markerFile(env, sessionId), JSON.stringify({ at: Date.now() })); } catch (_) { /* best effort */ }
}

function permissionRecentlyReported(env, sessionId) {
  try {
    const rec = JSON.parse(fs.readFileSync(markerFile(env, sessionId), 'utf8'));
    return typeof rec.at === 'number' && Date.now() - rec.at < MARKER_WINDOW_MS;
  } catch (_) {
    return false;
  }
}

module.exports = {
  stateDir, inputHash, fallbackToolUseId, rememberPre, forgetPre, findPre,
  markPermissionReported, permissionRecentlyReported,
};
