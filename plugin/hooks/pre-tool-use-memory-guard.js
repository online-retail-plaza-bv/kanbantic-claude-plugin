#!/usr/bin/env node
'use strict';

//
// pre-tool-use-memory-guard — KBT-B492 / KBT-SR611 / KBT-RL212 / KBT-BD210
//
// A PreToolUse hook on Write|Edit that intercepts a write to a *local memory*
// location and asks the operator to confirm it, quoting the workspace's own
// rule about where knowledge belongs.
//
// ── Why `ask` and not `deny` or a PostToolUse warning (KBT-RL212) ──────────
// A PostToolUse warning fires after the file exists: you are left with both a
// violation and a message, and someone still has to clean up. `deny` overshoots
// the other way — it would also block *shrinking* MEMORY.md down to a single
// pointer, which is exactly what the rule prescribes. `ask` intercepts without
// judging: an unintended write no longer slips through silently, and a
// deliberate clean-up is approved and proceeds.
//
// ── Why the rule text is not in this file (KBT-SR611) ──────────────────────
// KBT-TRUL028 / KBT-B499 already moved workspace-specific preconditions out of
// this plugin: it ships to every workspace, and one workspace's working
// practice does not belong in all of them. So the hook detects the workspace
// and reads the rule from that workspace's own Toolkit. No workspace, or no
// such rule, means this plugin has no standing to say anything — exit quietly.
//
// ── Order is part of the contract, not an optimisation ─────────────────────
// The path match runs FIRST and short-circuits, before any workspace detection
// or network call. This hook runs on every Write and Edit in every repository;
// the overwhelming majority are misses and a miss must cost nothing.
//
// ── Fail-open (KBT-BD210) ──────────────────────────────────────────────────
// Every failure path allows the tool call: no API key, no workspace, network
// error, timeout, unparseable answer, no matching rule. This hook enforces an
// administrative convention, not the correctness of work — it deliberately
// runs counter to fail-not-skip (KBT-RL191), for the same reason KBT-BD206
// gives for the SessionStart sync: a hook that wedges an unrelated Write shut
// on its own malfunction is a worse defect than the one it guards against.
//
// Config (env):
//   KANBANTIC_WORKSPACE_ID  — explicit workspace override (detection layer 1)
//   KANBANTIC_API_KEY       — required for the Toolkit lookup; absent ⇒ allow
//   KANBANTIC_MCP_URL       — default https://kanbantic.com/mcp
//   KANBANTIC_SYNC_DEBUG    — write skip-reasons to stderr; never changes exit
//
// Zero deps — Node built-ins plus this plugin's own scripts.
//

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { isLocalMemoryPath } = require('../scripts/memory-path.js');
const { detectWorkspace } = require('../scripts/workspace-detect.js');
const {
  createClient,
  fetchWorkspaceRepositories,
  resolveApiKey,
} = require('../scripts/mcp-toolkit-fetch.js');

const PREFIX = '[kanbantic-memory-guard]';
const LOOKUP_TIMEOUT_MS = 4_000;

function allow() {
  process.exit(0);
}

/**
 * Explain a skip — but only when asked.
 *
 * Silence is right for an operator and wrong for whoever has to work out why
 * nothing happened. The exit code stays 0 either way, so turning this on can
 * never change behaviour, only visibility. Same contract as the SessionStart
 * sync's debug channel (KBT-BD206).
 */
function debug(reason, err) {
  if (!process.env.KANBANTIC_SYNC_DEBUG) return;
  const detail = err && err.message ? `: ${err.message}` : '';
  process.stderr.write(`${PREFIX} allowed — ${reason}${detail}\n`);
}

/**
 * Pause the write and hand the decision to the operator.
 *
 * `permissionDecision: "ask"` with exit 0 — NOT exit 2, which is the blocking
 * (deny) contract. Getting that wrong would turn this into the `deny` variant
 * KBT-RL212 explicitly rejects.
 */
function ask(reason) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: reason,
        },
      }) + '\n'
    );
  } catch (_) {
    /* stdout best-effort — never let a write failure become a thrown hook */
  }
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/**
 * Pull the target path out of a PreToolUse event.
 *
 * Both spellings are accepted: different tools in the Claude Code surface have
 * used `file_path` and `filePath`, and a missed spelling silently disables the
 * hook — the exact failure mode KBT-B492 is about.
 *
 * Scope of the hooks.json matcher, measured rather than assumed (KBT-T4318):
 * `NotebookEdit` carries `notebook_path`, NOT `file_path`, so adding it to the
 * matcher would extract nothing and register as a permanent miss. `MultiEdit`
 * does not exist in the current tool-set. Hence `Write|Edit` and nothing more —
 * widen the matcher only together with the extraction below.
 *
 * Pure and exported so the ordering guarantee above stays testable.
 */
function extractFilePath(event) {
  const input = event && typeof event.tool_input === 'object' ? event.tool_input : null;
  if (!input) return '';
  const raw = input.file_path || input.filePath;
  return typeof raw === 'string' ? raw : '';
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
 * Does this Toolkit item state the local-memory rule?
 *
 * Selection is by CONTENT, never by item code. A hard-coded `KBT-TRUL021`
 * would put one workspace's identifier in a plugin every workspace installs —
 * the very thing KBT-SR611 forbids — and would silently fail in AdminHub,
 * where the same rule is ADM-TRUL006.
 *
 * A textual match is enough and stays robust against re-numbering or a
 * re-title, mirroring the reasoning behind `findLegacyHook()` in the
 * SessionStart sync. The cost of a false positive is one confirmation prompt
 * quoting a slightly-off rule; the cost of a false negative is no guard at all.
 *
 * Pure and exported for unit-testing.
 */
function selectMemoryRule(items) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!item) continue;
    const haystack = `${item.title || ''}\n${item.content || ''}`;
    // Either shape the rule is about: the per-project memory directory, or the
    // MEMORY.md file it names explicitly.
    if (/\.claude\/[^\s]*memory\//i.test(haystack) || /\bMEMORY\.md\b/i.test(haystack)) {
      return item;
    }
  }
  return null;
}

/**
 * Resolve the workspace for the current directory, cheapest layer first.
 *
 * Layers 1 and 2 cost nothing; layer 3 costs a network round-trip and is only
 * reached when the first two are silent. Same precedence as the SessionStart
 * sync (KBT-SR606) and the same `detectWorkspace` implementation — not a
 * second copy of the logic.
 */
async function resolveWorkspace(rootDir, client) {
  const manifest = readJsonOrNull(path.join(rootDir, '.kanbantic-sync.json'));
  const remoteUrl = git(['remote', 'get-url', 'origin'], rootDir);

  let detected = detectWorkspace({
    env: process.env,
    manifest,
    remoteUrl,
    repositories: [],
  });
  if (detected.workspace) return detected.workspace;

  let repositories = [];
  try {
    repositories = await fetchWorkspaceRepositories({ client });
  } catch (err) {
    debug('could not load repositories for detection layer 3', err);
    return null;
  }
  detected = detectWorkspace({ env: process.env, manifest, remoteUrl, repositories });
  return detected.workspace || null;
}

/**
 * Fetch the workspace's Rule items and pick the local-memory one.
 *
 * `includeContent: true` is required: the knowledge categories (Pattern,
 * Gotcha, Rule) return summaries WITHOUT a body by default, and selecting on
 * content against a body-less payload would match nothing — a silent no-op
 * indistinguishable from "this workspace has no such rule".
 */
async function findMemoryRule(workspace, client) {
  const payload = await client.call('list_toolkit_items', {
    workspaceId: workspace,
    category: 'Rule',
    includeContent: true,
    maxResults: 200,
  });
  return selectMemoryRule(payload && payload.items);
}

/** Compose the operator-facing message from the workspace's own rule. */
function buildReason(filePath, rule) {
  const code = rule.code ? `${rule.code} — ` : '';
  const title = rule.title || 'lokale memory is niet de plek voor kennis';
  return (
    `${code}${title}\n\n` +
    `Deze schrijfactie gaat naar lokale memory:\n  ${filePath}\n\n` +
    `${(rule.content || '').trim()}\n\n` +
    `Leg dit in plaats daarvan vast met create_toolkit_item (of een Library-document). ` +
    `Keur alleen goed wanneer dit juist het opruimen is dat de regel voorschrijft — ` +
    `bijvoorbeeld MEMORY.md terugbrengen tot één verwijzing.`
  );
}

async function main() {
  const raw = await readStdin();

  let event;
  try {
    event = JSON.parse(raw);
  } catch (_) {
    return allow(); // no or garbage payload ⇒ don't interfere
  }

  // ── Step 1: the cheap check, before anything can cost a round-trip ───────
  const filePath = extractFilePath(event);
  if (!isLocalMemoryPath(filePath)) return allow();

  if (!resolveApiKey()) {
    debug('no API key configured');
    return allow();
  }

  const client = createClient({ timeoutMs: LOOKUP_TIMEOUT_MS });

  // ── Step 2: which workspace's rules apply here? ──────────────────────────
  let workspace;
  try {
    workspace = await resolveWorkspace(process.cwd(), client);
  } catch (err) {
    debug('workspace detection failed', err);
    return allow();
  }
  if (!workspace) {
    debug('no workspace detected for this directory');
    return allow();
  }

  // ── Step 3: what does that workspace actually say? ───────────────────────
  let rule;
  try {
    rule = await findMemoryRule(workspace, client);
  } catch (err) {
    debug('toolkit lookup failed', err);
    return allow();
  }
  if (!rule) {
    debug(`workspace ${workspace} declares no local-memory rule`);
    return allow();
  }

  return ask(buildReason(filePath, rule));
}

// Two nets, because one is not enough: the catch below cannot see a rejection
// that escapes an async boundary, and an unhandled rejection is a non-zero exit
// in modern Node — which here would read as a BLOCK, the one outcome this hook
// must never produce by accident.
process.on('unhandledRejection', () => process.exit(0));
process.on('uncaughtException', () => process.exit(0));

// Only run when executed directly. When the module is `require`d by a test,
// main() must NOT fire — it would read the test runner's stdin and hang.
if (require.main === module) {
  main().catch((err) => {
    debug('unexpected error', err);
    allow();
  });
}

module.exports = {
  extractFilePath,
  selectMemoryRule,
  buildReason,
  resolveWorkspace,
  findMemoryRule,
};
