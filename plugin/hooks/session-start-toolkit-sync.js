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
// ── Why --force, and why never --prune ─────────────────────────────────────
// The mirrors are generated artefacts; local-is-disposable is the correct
// assumption now. Without --force every session would re-print the same
// warnings about files nobody edits by hand.
//
// --prune is a different authority and this hook must never pass it. It waives
// the completeness guard (KBT-B489), which is the only thing standing between a
// partial fetch and a mass deletion. Until KBT-B654 the two lived on one flag:
// a fetch that returned 17 Skills and 0 Subagents without erroring deleted all
// nine Subagent mirrors, silently, because this hook skips quietly by design.
// Deleting a mirror whose source is gone from the Toolkit is a deliberate act;
// it does not belong to an unattended session-start hook.
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

const { parseAllowBlock } = require('./lib/permission-allow.js');
const { writeAllowList } = require('./lib/allow-cache.js');
const sessionApi = require('./lib/session-api.js');

const SYNC_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'sync-workspace-skills.js');
const PREFIX = '[kanbantic-toolkit-sync]';
const PERMISSION_ALLOW_TAG = 'permission-allow';
const REJECTED_RULE_MAX = 500;
const REJECTED_REASON_MAX = 100;

function note(msg) {
  process.stdout.write(`${PREFIX} ${msg}\n`);
}

/**
 * Explain a skip — but only when asked.
 *
 * Fail-safe silence is right for an operator and wrong for whoever has to work
 * out why nothing synced. Set KANBANTIC_SYNC_DEBUG=1 to get the reason on
 * stderr; the exit code stays 0 either way, so turning it on can never change
 * behaviour, only visibility.
 */
function debug(reason, err) {
  if (!process.env.KANBANTIC_SYNC_DEBUG) return;
  const detail = err && err.message ? `: ${err.message}` : '';
  process.stderr.write(`${PREFIX} skipped — ${reason}${detail}\n`);
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

/**
 * Allow-list for the PermissionRequest router — KBT-F741 / KBT-T5189 (KBT-SR638).
 *
 * The workspace declares it as a `Custom` Toolkit item tagged `permission-allow`
 * (selection by TAG, never by code or content — same reasoning as the
 * memory-guard, KBT-SR611). Only the fenced ```allow block of that item is
 * parsed; every line is validated against the forbidden list (permission-allow.js)
 * and refused lines are reported as `permission-allow-rejected: <rule>`.
 * The accepted rules go to the session file + a cache file (allow-cache.js).
 *
 * Needs CLAUDE_CODE_SESSION_ID: it names the cache file, and stdin is not read
 * here (this hook never has). Without it there is nothing to write — skip.
 *
 * Fail-open and independent of the Skill/Subagent sync below: a failure here
 * keeps the previous cache (stale rules over no rules is the safe direction for
 * a hook whose worst case is "ask the user as before") and never blocks it.
 */
async function syncPermissionAllowList({ workspace, client }) {
  try {
    if (!process.env.CLAUDE_CODE_SESSION_ID && !process.env.KANBANTIC_ALLOWLIST_FILE) {
      debug('permission allow-list: no CLAUDE_CODE_SESSION_ID to key the cache on');
      return;
    }
    const payload = await client.call('list_toolkit_items', {
      workspaceId: workspace,
      category: 'Custom',
      includeContent: true,
      maxResults: 200,
    });
    if (!payload || !Array.isArray(payload.items) || payload.truncated === true) {
      debug('permission allow-list: Custom items list missing or truncated — keeping the old cache');
      return;
    }
    const tagged = payload.items.filter(
      (item) => item && Array.isArray(item.tags) && item.tags.includes(PERMISSION_ALLOW_TAG)
    );
    if (tagged.length > 1) {
      debug(`permission allow-list: ${tagged.length} items tagged "${PERMISSION_ALLOW_TAG}" `
        + `(${tagged.map((t) => t.code || '?').join(', ')}) — using the first`);
    }
    const { rules, rejected } = tagged.length
      ? parseAllowBlock(tagged[0].content || '')
      : { rules: [], rejected: [] };

    for (const r of rejected) note(`permission-allow-rejected: ${r.rule}`);
    writeAllowList(rules, { env: process.env, workspace });
    await reportRejectedRules(rejected);
  } catch (err) {
    debug('permission allow-list sync failed', err);
  }
}

/**
 * Tell the session about every refused rule — KBT-T5221 (SEC063 §2).
 *
 * POST /api/app/agent-session/{id}/report-allow-rule-rejected, one call per
 * rule, body `{ rule (≤500, redacted), reason (≤100) }`, with the agent's own
 * API key over the same REST transport and session-file resolution as the
 * session-state hooks (session-api.js). The answer `{ recorded: false }`
 * (session without a workstation) is not an error and nothing is retried.
 *
 * Fail-open: no session file or API key → silent skip (at SessionStart the
 * session file usually does not exist yet); network error, non-2xx or the 5 s
 * deadline → swallowed. Runs after the cache write, so it can never block or
 * change the sync itself.
 */
async function reportRejectedRules(rejected) {
  if (!Array.isArray(rejected) || rejected.length === 0) return;
  const ctx = sessionApi.loadContext({}, process.env);
  if (!ctx) return;
  const route = sessionApi.sessionRoute(ctx, 'report-allow-rule-rejected');
  await Promise.all(rejected.map((r) => sessionApi.postQuietly(ctx, route, {
    rule: sessionApi.truncate(sessionApi.redactText(String(r.rule)), REJECTED_RULE_MAX),
    reason: sessionApi.truncate(String(r.reason || 'rejected'), REJECTED_REASON_MAX),
  }, 'report-allow-rule-rejected')));
}

async function main() {
  const rootDir = process.cwd();

  // ── Preconditions that mean "not our business" ──────────────────────────
  if (!git(['rev-parse', '--git-dir'], rootDir)) {
    debug('not a git repository');
    return; // nothing to mirror into
  }
  if (!resolveApiKey()) {
    debug('no API key configured');
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
    } catch (err) {
      debug('could not load repositories for detection layer 3', err);
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

  await syncPermissionAllowList({ workspace: detected.workspace, client });

  // ── Fetch ───────────────────────────────────────────────────────────────
  let items;
  try {
    items = await fetchToolkitItems({ workspace: detected.workspace, client });
  } catch (err) {
    debug('toolkit fetch failed', err);
    return; // network, protocol, or parse failure — skip quietly
  }

  // An empty list is not "nothing changed", it is "the fetch told us nothing".
  // Handing that to the sync with --force would delete every existing mirror.
  if (!Array.isArray(items) || items.length === 0) {
    debug('fetch returned no items — refusing to run --force against an empty list');
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
  .catch((err) => { debug('unexpected error', err); process.exit(0); });
