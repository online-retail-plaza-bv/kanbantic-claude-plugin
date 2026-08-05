#!/usr/bin/env node
'use strict';

//
// session-start-toolkit-sync.js — KBT-F637
//
// SessionStart hook: materialises the workspace's Toolkit Skill + Subagent
// items as .claude/commands/*.md and .claude/agents/*.md.
//
// Since KBT-TRUL014 was relaxed, those mirrors are generated and gitignored
// rather than committed, so a fresh clone has no commands and no subagents
// until a sync has run. That makes the sync a start-up facility — which is
// exactly why every workstation had hand-rolled one, each with its own bugs.
// This ships it once, in the plugin.
//
// ── Fail-safe is the governing rule (KBT-BD206) ────────────────────────────
// Every failure path ends in exit 0 with at most a line or two of output. No
// API key, no git repo, no network, an unparseable answer, a sync that errors —
// all of it is skipped quietly. This deliberately runs counter to the
// fail-not-skip principle of KBT-RL191: that principle guards gates that
// enforce the correctness of *work*, whereas failing here costs nothing worse
// than mirrors that are one session out of date. Blocking a session start is
// the more expensive mistake.
//
// ── Why --force ────────────────────────────────────────────────────────────
// The mirrors are generated artefacts; local-is-disposable is the correct
// assumption now. Without --force every session would re-print the same
// warnings about files nobody edits by hand.
//

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { detectWorkspace } = require('../scripts/workspace-detect.js');
const {
  createClient,
  fetchToolkitItems,
  fetchWorkspaceRepositories,
  resolveApiKey,
} = require('../scripts/mcp-toolkit-fetch.js');

const SYNC_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'sync-workspace-skills.js');
const PREFIX = '[kanbantic-toolkit-sync]';

function note(msg) {
  process.stdout.write(`${PREFIX} ${msg}\n`);
}

/** Run a git command in `cwd`; '' when git is unavailable or the call fails. */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return '';
  }
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Look for a hand-rolled SessionStart sync still configured in local settings.
 *
 * Reported, never rewritten (KBT-RL208). These are the user's settings; a hook
 * that edits someone else's configuration unasked does more damage than the
 * duplicate sync it would prevent.
 */
function findLegacyHook(rootDir) {
  const dir = path.join(rootDir, '.claude');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  for (const name of entries) {
    if (!/^settings.*\.json$/i.test(name)) continue;
    const file = path.join(dir, name);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    // A textual check is enough and stays robust against shape changes in the
    // settings schema: we only need to know whether something in here runs the
    // sync at session start.
    if (/SessionStart/i.test(raw) && /sync-workspace-skills|toolkit-sync/i.test(raw)) {
      return file;
    }
  }
  return null;
}

/**
 * Does this repository look like one the sync is meant to serve?
 *
 * Used only to decide whether an unresolved workspace is worth mentioning. A
 * previous manifest or an existing .claude/ directory means someone has already
 * wired this repo up; anything else is just a project that happens to be open.
 */
function looksKanbanticManaged(rootDir, manifest) {
  if (manifest) return true;
  try {
    return fs.statSync(path.join(rootDir, '.claude')).isDirectory();
  } catch (_) {
    return false;
  }
}

async function main() {
  const rootDir = process.cwd();

  // ── Preconditions that mean "not our business" ──────────────────────────
  if (!git(['rev-parse', '--git-dir'], rootDir)) {
    return; // not a git repository — nothing to mirror into
  }
  if (!resolveApiKey()) {
    return; // unconfigured workstation; check-update.sh already says so
  }

  const legacy = findLegacyHook(rootDir);

  // ── Layers 1 and 2: free, no network ────────────────────────────────────
  const manifest = readJsonOrNull(path.join(rootDir, '.kanbantic-sync.json'));
  const remoteUrl = git(['remote', 'get-url', 'origin'], rootDir);

  let detected = detectWorkspace({ env: process.env, manifest, remoteUrl, repositories: [] });

  const client = createClient();

  // ── Layer 3: only now do we pay for a round-trip ────────────────────────
  if (!detected.workspace) {
    let repositories = [];
    try {
      repositories = await fetchWorkspaceRepositories({ client });
    } catch (_) {
      return; // unreachable backend — quietly skip, per KBT-BD206
    }
    detected = detectWorkspace({ env: process.env, manifest, remoteUrl, repositories });
  }

  if (!detected.workspace) {
    if (detected.source === 'ambiguous') {
      // A genuine conflict the operator has to settle — always worth saying.
      note(`multiple workspaces claim this remote (${detected.candidates.join(', ')}). `
        + 'Set KANBANTIC_WORKSPACE_ID to pick one.');
    } else if (looksKanbanticManaged(rootDir, manifest)) {
      // Only hint when this repo plausibly *should* be synced. The hook runs on
      // every session start in every repository; an unconditional hint would
      // print in unrelated projects forever, and a message that is usually
      // noise stops being read on the one occasion it matters.
      note('could not determine the workspace for this repository. '
        + 'Set KANBANTIC_WORKSPACE_ID to enable the toolkit sync.');
    }
    return;
  }

  // ── Fetch ───────────────────────────────────────────────────────────────
  let items;
  try {
    items = await fetchToolkitItems({ workspace: detected.workspace, client });
  } catch (_) {
    return; // network, protocol, or parse failure — skip quietly
  }

  // An empty list is not "nothing changed", it is "the fetch told us nothing".
  // Handing that to the sync with --force would delete every existing mirror.
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  // ── Sync ────────────────────────────────────────────────────────────────
  const result = spawnSync(
    process.execPath,
    [SYNC_SCRIPT, '--force', '--workspace', detected.workspace, '--root', rootDir],
    { input: JSON.stringify(items), encoding: 'utf8' }
  );

  if (result.status === 0) {
    const summary = String(result.stdout || '').trim().split(/\r?\n/).pop();
    if (summary) note(summary);
  }

  if (legacy) {
    note(`a hand-written SessionStart sync is still configured in ${legacy} — `
      + 'remove that entry; this hook now ships with the plugin.');
  }
}

// Two nets, because one is not enough: the try/catch below cannot see a
// rejection that escapes an async boundary, and an unhandled rejection is a
// non-zero exit in modern Node — exactly what must never happen here.
process.on('unhandledRejection', () => process.exit(0));
process.on('uncaughtException', () => process.exit(0));

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
