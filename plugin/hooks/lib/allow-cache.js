'use strict';

//
// allow-cache.js — KBT-F741 / KBT-T5189
//
// Where the workspace allow-list lives on the workstation between the
// SessionStart sync (which fetches it) and the PermissionRequest router (which
// reads it, with no network on the hot path).
//
// Two locations, deliberately:
//
//   1. the session file  ~/.claude-kanbantic-session-<id>.json, fields
//      `allowList` + `allowListFetchedAt` — the spec'd home, merged into the
//      JSON the proxy wrote.
//   2. a cache file      ~/.claude-kanbantic-allowlist-<id>.json
//      { allowList, allowListFetchedAt, workspace } — ALWAYS written next to (1).
//
// Why both: at SessionStart the proxy has usually not registered yet, so the
// session file does not exist; and the proxy rewrites the whole session file on
// every writeSessionFile(), which would silently drop the merged fields.
// The cache file is neither affected. The router reads both and takes the one
// with the newer `allowListFetchedAt`, so a revoked rule disappears as soon as
// the next sync has run.
//
// `KANBANTIC_ALLOWLIST_FILE` overrides the cache-file path (tests, E2E).
//

const fs = require('node:fs');
const path = require('node:path');

const {
  homeDir, claudeSessionId, resolveSessionFilePath, readJsonOrNull,
} = require('./session-api.js');

const CACHE_PREFIX = '.claude-kanbantic-allowlist-';

function cacheFilePath(payload, env = process.env) {
  if (env.KANBANTIC_ALLOWLIST_FILE) return env.KANBANTIC_ALLOWLIST_FILE;
  const sid = claudeSessionId(payload, env);
  return sid ? path.join(homeDir(env), `${CACHE_PREFIX}${sid}.json`) : null;
}

function asEntry(obj) {
  if (!obj || !Array.isArray(obj.allowList)) return null;
  const at = Date.parse(obj.allowListFetchedAt);
  return { rules: obj.allowList.filter((r) => typeof r === 'string'), at: Number.isNaN(at) ? 0 : at };
}

/**
 * The rules the router should use: `[]` when nothing usable is cached.
 * Never throws.
 */
function loadAllowList(payload, env = process.env) {
  try {
    const entries = [];
    const sessionFile = resolveSessionFilePath(payload, env);
    if (sessionFile) entries.push(asEntry(readJsonOrNull(sessionFile)));
    const cache = cacheFilePath(payload, env);
    if (cache) entries.push(asEntry(readJsonOrNull(cache)));
    const usable = entries.filter(Boolean).sort((a, b) => b.at - a.at);
    return usable.length ? usable[0].rules : [];
  } catch (_) {
    return [];
  }
}

/**
 * Persist `rules`. Creates the cache file only when there is something to
 * store (or one exists to be cleared), so workspaces without an allow-list do
 * not litter the home directory.
 */
function writeAllowList(rules, { payload, env = process.env, workspace = null } = {}) {
  const stamp = { allowList: rules, allowListFetchedAt: new Date().toISOString() };

  const cache = cacheFilePath(payload, env);
  if (cache && (rules.length > 0 || fs.existsSync(cache))) {
    fs.writeFileSync(cache, JSON.stringify({ ...stamp, workspace }, null, 2), 'utf8');
  }

  const sessionFile = resolveSessionFilePath(payload, env);
  const session = sessionFile ? readJsonOrNull(sessionFile) : null;
  if (session) {
    fs.writeFileSync(sessionFile, JSON.stringify({ ...session, ...stamp }, null, 2), 'utf8');
  }
}

module.exports = { CACHE_PREFIX, cacheFilePath, loadAllowList, writeAllowList };
