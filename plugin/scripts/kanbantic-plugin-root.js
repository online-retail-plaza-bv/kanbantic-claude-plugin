#!/usr/bin/env node
'use strict';

//
// kanbantic-plugin-root — KBT-B547
//
// Resolves the root of the *currently active* Kanbantic plugin installation,
// without ever writing a version number down.
//
// Why this exists:
//   `.git/config` used to hold a literal, version-pinned path:
//
//     credential.helper = !node ".../kanbantic-claude-plugin/2.14.0/scripts/..."
//
//   The plugin cache is version-scoped and gets pruned on upgrade; `.git/config`
//   is per-repo and survives it. So every upgrade broke every repo that had ever
//   configured the helper — and git did not say "helper missing", it fell through
//   to the inherited Git Credential Manager, which cannot prompt in a
//   non-interactive session. Result: `could not read Username`, which reads like
//   an auth failure while it is a dead file path.
//
// Precedence — highest first:
//   1. KANBANTIC_PLUGIN_ROOT  — explicit override (also what the tests inject).
//   2. CLAUDE_PLUGIN_ROOT     — set inside the Claude Code hook context. NOT set
//      for processes git spawns: measured with a helper that echoed its own
//      environment, `CLAUDE_PLUGIN_ROOT` came back empty. It is kept as a layer
//      because it IS present in the hook context, but it can never be the only
//      one.
//   3. PATH                   — Claude Code puts `<plugin root>/bin` on PATH for
//      the session, unconditionally (the directory need not even exist). That
//      entry names the version that is actually RUNNING, which is precisely what
//      the abolished `sort -V | tail -1` scan could not guarantee (KBT-F637).
//
// There is deliberately NO "newest directory in the cache" fallback. Picking a
// version that is not the running one is the failure mode KBT-F637 removed; it
// is not reintroduced here as a convenience.
//
// Zero dependencies — Node built-ins only.
//

const fs = require('fs');
const path = require('path');

const PLUGIN_DIR_NAME = 'kanbantic-claude-plugin';
const HELPER_RELATIVE_PATH = path.join('scripts', 'kanbantic-git-credential-helper.js');

/** A candidate only counts if it actually carries the helper we are going to run. */
function looksLikePluginRoot(candidate) {
  if (!candidate) return false;
  try {
    return fs.statSync(path.join(candidate, HELPER_RELATIVE_PATH)).isFile();
  } catch {
    return false;
  }
}

/**
 * Pull `<root>` out of any `<root>/bin` PATH entry belonging to the Kanbantic
 * plugin. The entry Claude Code injects looks like
 *   .../plugins/cache/<marketplace>/kanbantic-claude-plugin/<version>/bin
 * The `/bin` suffix is stripped when present; an entry pointing straight at the
 * root is accepted too, so the lookup does not hinge on a layout detail.
 */
function pluginRootsOnPath(pathValue, delimiter) {
  if (!pathValue) return [];
  const sep = delimiter || path.delimiter;
  const roots = [];
  for (const raw of pathValue.split(sep)) {
    const entry = raw.trim();
    if (!entry || !entry.includes(PLUGIN_DIR_NAME)) continue;
    const normalized = entry.replace(/[\\/]+$/, '');
    const base = path.basename(normalized).toLowerCase();
    roots.push(base === 'bin' ? path.dirname(normalized) : normalized);
  }
  return roots;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env]  Environment to resolve from (default `process.env`).
 * @returns {{root: string|null, source: string|null, searched: string[]}}
 *          `searched` is always populated so a caller can say what it looked at.
 */
function resolvePluginRoot({ env = process.env } = {}) {
  const searched = [];

  const explicit = [
    ['KANBANTIC_PLUGIN_ROOT', env.KANBANTIC_PLUGIN_ROOT],
    ['CLAUDE_PLUGIN_ROOT', env.CLAUDE_PLUGIN_ROOT],
  ];
  for (const [source, value] of explicit) {
    searched.push(value ? `${source}=${value}` : `${source} (unset)`);
    if (value && looksLikePluginRoot(value)) {
      return { root: path.resolve(value), source, searched };
    }
  }

  const fromPath = pluginRootsOnPath(env.PATH || env.Path, env.KANBANTIC_PATH_DELIMITER);
  searched.push(
    fromPath.length
      ? `PATH (${fromPath.length} ${PLUGIN_DIR_NAME} entr${fromPath.length === 1 ? 'y' : 'ies'})`
      : `PATH (no ${PLUGIN_DIR_NAME} entry)`,
  );
  for (const candidate of fromPath) {
    if (looksLikePluginRoot(candidate)) {
      return { root: path.resolve(candidate), source: 'PATH', searched };
    }
  }

  return { root: null, source: null, searched };
}

/** The single line every caller should print when resolution fails. */
function notFoundMessage(searched) {
  return (
    'no active Kanbantic plugin installation found — searched: '
    + searched.join('; ')
    + '. If git next reports "could not read Username", that is the fallback '
    + 'credential helper prompting, not an authentication failure.'
  );
}

if (require.main === module) {
  const result = resolvePluginRoot();
  if (result.root) {
    process.stdout.write(`${result.root}\n`);
  } else {
    process.stderr.write(`[kanbantic-plugin-root] ${notFoundMessage(result.searched)}\n`);
    process.exit(1);
  }
}

module.exports = {
  resolvePluginRoot,
  pluginRootsOnPath,
  looksLikePluginRoot,
  notFoundMessage,
  HELPER_RELATIVE_PATH,
  PLUGIN_DIR_NAME,
};
