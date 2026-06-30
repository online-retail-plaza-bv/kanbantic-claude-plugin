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
// maintains (the same `~/.claude-kanbantic-session.json` the transcript hooks
// read). The proxy is the component with the full picture of the current
// issue's Version, so it stamps a `versionContext` object into the session
// file; this hook simply renders it at Stop.
//
// versionContext shape (all fields required to render — any missing field ⇒
// silent no-op so an irrelevant session never prints a half-built line):
//   { versionName, applicationName, issueCount, status, percentDone }
//
// Sessions with no Version context (no session-file, no versionContext) print
// NOTHING and exit 0 — "niet-relevante sessions stil" (TC2365 variant).
//
// Config (env):
//   KANBANTIC_SESSION_FILE — override the session-file path (testing). Default
//                            ~/.claude-kanbantic-session.json (HOME/USERPROFILE).
//
// Zero deps — Node built-ins only.
//

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function sessionFilePath() {
  if (process.env.KANBANTIC_SESSION_FILE) return process.env.KANBANTIC_SESSION_FILE;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.claude-kanbantic-session.json');
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
