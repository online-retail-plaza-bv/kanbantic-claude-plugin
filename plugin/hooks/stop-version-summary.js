#!/usr/bin/env node
'use strict';

//
// stop-version-summary — KBT-F320 / KBT-T2422 / KBT-TC2365
//
// A Stop hook that prints a one-line Version summary when a session ends,
// e.g.:
//
//   Version v1.5.0 voor Kanbantic API — 5 issues, status InProgress, %done 60%
//
// The summary is read from the Kanbantic session-file that the stdio proxy
// maintains — since KBT-F717 one file PER Claude session
// (`~/.claude-kanbantic-session-<CLAUDE_CODE_SESSION_ID>.json`), not one
// global file.
//
// versionContext shape (all fields required to render — any missing field ⇒
// silent no-op so an irrelevant session never prints a half-built line):
//   { versionName, applicationName, issueCount, status, percentDone }
//
// KBT-F726 (misleading-description finding) — as of today NOTHING writes this
// field. `writeSessionFile()` in plugin/proxy/kanbantic-mcp-proxy.js persists
// { sessionId, channelId, claudeCliSessionId, apiUrl, writtenAt, pid, cursors }
// only; it never computes or stamps a `versionContext`. This hook is therefore
// ALWAYS silent today — `loadVersionContext()` always returns null. The shape
// above documents the intended contract for whoever wires up the write side
// (tracked as a follow-up; this hook and its tests are correct and stay in
// place as the read/render half of that contract).
//
// Sessions with no Version context (no session-file, no versionContext) print
// NOTHING and exit 0 — "niet-relevante sessions stil" (TC2365 variant).
//
// KBT-F717 — resolving WHICH session file is this hook's job now that there
// can be several on disk at once (one Claude session per proxy process). This
// hook is a separate subprocess from the proxy and does not know the proxy's
// PID, so it uses the shared, fail-closed resolver in session-file.js:
//   - CLAUDE_CODE_SESSION_ID set  → that exact file.
//   - unset, exactly 1 file found → that file (single-session-on-workstation case).
//   - unset, 0 or ≥2 files found  → no file (never GUESS which one is "ours" —
//     that is precisely the cross-session bug this Feature fixes).
//
// Config (env):
//   KANBANTIC_SESSION_FILE — override the session-file path (testing). Takes
//                            precedence over the resolver above.
//
// Zero deps — Node built-ins only (session-file.js is a plugin-local sibling).
//

const fs = require('node:fs');
const os = require('node:os');
const { resolveExistingSessionFile } = require('../proxy/session-file');

function sessionFilePath() {
  if (process.env.KANBANTIC_SESSION_FILE) return process.env.KANBANTIC_SESSION_FILE;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const resolved = resolveExistingSessionFile(home, process.env);
  if (resolved.ambiguous) {
    process.stderr.write(
      '[kanbantic-hook] multiple session files found and CLAUDE_CODE_SESSION_ID is not ' +
      `set — cannot tell which session is ours (candidates: ${resolved.candidates.join(', ')}). ` +
      'Skipping the Version summary rather than guessing.\n'
    );
  }
  return resolved.path; // may be null — loadVersionContext() below already handles that
}

function loadVersionContext() {
  let raw;
  try {
    raw = fs.readFileSync(sessionFilePath(), 'utf8');
  } catch (_) {
    return null; // no session-file ⇒ silent
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null; // unparseable ⇒ silent
  }
  return (parsed && parsed.versionContext) || null;
}

// Render the exact summary line, or null when any required field is absent.
function formatSummary(ctx) {
  if (!ctx) return null;
  const { versionName, applicationName, issueCount, status, percentDone } = ctx;
  if (
    versionName == null ||
    applicationName == null ||
    issueCount == null ||
    status == null ||
    percentDone == null
  ) {
    return null;
  }
  return (
    `Version ${versionName} voor ${applicationName} — ` +
    `${issueCount} issues, status ${status}, %done ${percentDone}%`
  );
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

async function main() {
  // Drain stdin (Stop payload) so the pipe closes cleanly; content unused.
  await readStdin();
  const line = formatSummary(loadVersionContext());
  if (line) process.stdout.write(line + '\n');
  process.exit(0);
}

// Only run when executed directly; `require`-ing the module (unit-test of the
// pure renderer) must not trigger stdin-reading `main()`.
if (require.main === module) {
  main().catch(() => process.exit(0));
}

// Exported for unit-testing the pure renderer.
module.exports = { formatSummary };
