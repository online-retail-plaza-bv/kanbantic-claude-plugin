#!/usr/bin/env node
'use strict';

//
// pre-tool-use-git-identity-gate — KBT-F616
//
// A PreToolUse hook (matcher: "Bash") that self-heals the git commit identity
// right before `git commit` runs. This is the actual enforcement layer behind
// KBT-F614/F615/F616's precedence (env-var override > per-agent identity >
// per-repo identity): it works even when the SKILL.md step that normally sets
// the identity was skipped, run by a human outside any lane-skill, or run by
// a future/third-party skill that never adopts kanbantic-git-identity.js.
//
// Contract (Claude Code PreToolUse):
//   stdin  — JSON { tool_name, tool_input, ... }.
//   allow  — exit 0 silently.
//   (this hook never blocks — see below.)
//
// Deliberately NOT a HARD-GATE like pre-tool-use-locked-version-blocker.js:
// a missing/unresolvable git identity is a quality gap (the commit lands
// with whatever identity git itself guesses), never a reason to brick a
// commit. Every failure mode — no API key, network error, not a
// Kanbantic-linked repo — falls through to `allow()`.
//

const path = require('path');
const {
  resolveAndApplyIdentity,
  getGitConfig,
} = require(path.join(__dirname, '..', 'scripts', 'kanbantic-git-identity.js'));

function log(msg) {
  process.stderr.write(`[git-identity-gate] ${msg}\n`);
}

function allow() {
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

// Matches `git commit`, optionally preceded by `git -C <dir>`. Deliberately
// loose: a false positive just costs one harmless extra config-check; a
// false negative just means the safety net didn't fire for that call (the
// explicit SKILL.md step is still the primary path).
const GIT_COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;

function isGitCommitCommand(command) {
  return typeof command === 'string' && GIT_COMMIT_RE.test(command);
}

// Best-effort target directory: `git -C <dir> commit` names it explicitly;
// otherwise fall back to the hook event's cwd, then this process's own cwd.
function extractTargetDir(command, eventCwd) {
  const m = typeof command === 'string' ? command.match(/git\s+-C\s+(\S+)/) : null;
  if (m) return m[1].replace(/^["']|["']$/g, '');
  return eventCwd || process.cwd();
}

function identityAlreadyConfigured(cwd) {
  if (process.env.GIT_AUTHOR_NAME && process.env.GIT_AUTHOR_EMAIL) return true;
  const name = getGitConfig(cwd, 'user.name');
  const email = getGitConfig(cwd, 'user.email');
  return Boolean(name && email);
}

async function main() {
  const raw = await readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return allow(); // no/garbage payload — don't interfere
  }
  if (!event || event.tool_name !== 'Bash') return allow();

  const command = event.tool_input && event.tool_input.command;
  if (!isGitCommitCommand(command)) return allow();

  const cwd = extractTargetDir(command, event.cwd);
  if (identityAlreadyConfigured(cwd)) return allow();

  try {
    const result = await resolveAndApplyIdentity({ cwd });
    if (result.applied) log(`self-healed git identity (${result.source}) in ${cwd}`);
  } catch (e) {
    log(`resolution failed: ${e.message} — allowing commit with whatever identity git already has`);
  }
  return allow();
}

if (require.main === module) {
  main().catch(() => allow());
}

// Exported for unit-testing the pure helpers without spawning a process.
module.exports = { isGitCommitCommand, extractTargetDir, identityAlreadyConfigured };
