#!/usr/bin/env node
'use strict';

//
// kanbantic-pr-identity-stamp — KBT-B538
//
// Stamps the creating agent's identity into a PR's title/body at PR-creation
// time. GitHub PR authorship is tied to whichever shared, per-repository PAT
// authenticated the `gh pr create` call (KBT-GTCH086) — it cannot be
// overridden per-call, and per-agent GitHub accounts/tokens don't scale as
// the agent fleet grows (KBT-B538 scope decision, confirmed with operator
// 2026-08-06). This script makes the creating agent visible on GitHub's own
// PR list without touching GitHub's authorship model at all: a title-prefix +
// body-footer stamp, sourced from the same get_current_agent_identity
// (KBT-F615) call kanbantic-git-identity.js already uses for commit
// authorship (KBT-F616).
//
// Used by kanbantic-issue-review Step 7, immediately before `gh pr create`:
//
//   STAMPED_TITLE=$(printf '%s' "$TITLE" | node "$CLAUDE_PLUGIN_ROOT/scripts/kanbantic-pr-identity-stamp.js" title)
//   STAMPED_BODY=$(printf '%s' "$BODY"   | node "$CLAUDE_PLUGIN_ROOT/scripts/kanbantic-pr-identity-stamp.js" body)
//   gh pr create --title "$STAMPED_TITLE" --body "$STAMPED_BODY"
//
// Auth + HTTP mirrors kanbantic-git-credential-helper.js / kanbantic-git-identity.js
// exactly (KBT-B330): KANBANTIC_API_KEY from process.env or HKCU\Environment on
// Windows; a single stateless tools/call POST against KANBANTIC_MCP_URL, no
// initialize handshake or session id required. Zero dependencies — Node.js
// built-ins only.
//
// Never throws and never blocks the caller: every failure mode passes the
// original text through unstamped. A missing identity is a quality gap the
// reviewer can still notice, not a reason to fail a PR-creation call.
//

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execSync } = require('child_process');

const MCP_URL = process.env.KANBANTIC_MCP_URL || 'https://kanbantic.com/mcp';
const REQUEST_TIMEOUT_MS = 15_000;

function log(msg) {
  process.stderr.write(`[kanbantic-pr-identity-stamp] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// API key resolution — identical to kanbantic-git-credential-helper.js /
// kanbantic-git-identity.js.
// ---------------------------------------------------------------------------
function resolveApiKey() {
  if (process.env.KANBANTIC_API_KEY) return process.env.KANBANTIC_API_KEY;
  if (process.platform === 'win32') {
    try {
      const out = execSync('reg query HKCU\\Environment /v KANBANTIC_API_KEY', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/KANBANTIC_API_KEY\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i);
      if (m) return m[1].trim();
    } catch {
      // absent — handled by the caller (silent fall-through).
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// forward: POST a single JSON-RPC tools/call to the Kanbantic MCP server with
// Bearer auth. Mirrors kanbantic-git-credential-helper.js / kanbantic-git-identity.js.
// ---------------------------------------------------------------------------
function forward(apiKey, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(MCP_URL);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${apiKey}`,
        },
      },
      (res) => {
        if (res.statusCode === 401) {
          reject(new Error('authentication failed (401) — check KANBANTIC_API_KEY'));
          res.resume();
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let d = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (d += c));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`)));
          return;
        }
        const ct = (res.headers['content-type'] || '').toLowerCase();
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(ct.includes('text/event-stream') ? parseSSE(data) : [JSON.parse(data)]);
          } catch (e) {
            reject(new Error(`failed to parse server response: ${e.message}`));
          }
        });
      },
    );
    req.on('error', (e) => reject(new Error(`connection failed: ${e.message}`)));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('request timeout')));
    req.write(body);
    req.end();
  });
}

function parseSSE(data) {
  const messages = [];
  for (const block of data.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        const json = line.charAt(5) === ' ' ? line.slice(6) : line.slice(5);
        try {
          messages.push(JSON.parse(json));
        } catch {
          // skip malformed SSE data lines
        }
      }
    }
  }
  return messages;
}

// MCP wraps the tool result JSON in content[0].text as a string.
function parseToolResult(response) {
  try {
    const content = response.result.content;
    if (!Array.isArray(content) || content.length === 0) return null;
    const text = content[0].text;
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function callTool(apiKey, name, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const responses = await forward(apiKey, body);
  return parseToolResult((responses || []).find((r) => r && r.id === 1) || {});
}

// ---------------------------------------------------------------------------
// resolveAgentName — the current agent's display name via get_current_agent_identity
// (KBT-F615, read-only, safe to call any number of times). Returns null on any
// failure (no API key, unauthenticated, network error) — never throws.
// ---------------------------------------------------------------------------
async function resolveAgentName() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    log('no KANBANTIC_API_KEY in env or HKCU\\Environment — leaving text unstamped');
    return null;
  }
  try {
    const identity = await callTool(apiKey, 'get_current_agent_identity', {});
    if (identity && identity.success && identity.claudeAgentName) {
      return identity.claudeAgentName;
    }
    log('get_current_agent_identity returned no claudeAgentName — leaving text unstamped');
    return null;
  } catch (e) {
    log(`get_current_agent_identity failed: ${e.message} — leaving text unstamped`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure stamping helpers — no network, safe to unit-test in-process.
// Idempotent: re-stamping already-stamped text is a no-op, so a retried
// `gh pr create` (or a second pipeline run) never compounds the stamp.
//
// The idempotency check is tied to THIS agent's own resolved name, not any
// bracket-shaped prefix — a shape-only check (e.g. /^\[.+?\]\s/) would
// mistake an unrelated bracket-prefixed title ("[skip ci] ...", "[WIP] ...")
// for an existing stamp and silently skip stamping it.
// ---------------------------------------------------------------------------
const BODY_FOOTER_MARKER = 'Created by:';

function stampTitle(title, agentName) {
  const prefix = `[${agentName}] `;
  if (title.startsWith(prefix)) return title;
  return `${prefix}${title}`;
}

function stampBody(body, agentName) {
  if (body.includes(BODY_FOOTER_MARKER)) return body;
  const footer = `${BODY_FOOTER_MARKER} ${agentName}`;
  return body.trim().length > 0 ? `${body}\n\n---\n${footer}` : footer;
}

// ---------------------------------------------------------------------------
// CLI entry point — `node kanbantic-pr-identity-stamp.js <title|body>`,
// original text piped in via stdin, stamped text written to stdout.
// ---------------------------------------------------------------------------
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const field = process.argv[2];
  if (field !== 'title' && field !== 'body') {
    log(`usage: node kanbantic-pr-identity-stamp.js <title|body>  (got: ${field || '(none)'})`);
    process.exitCode = 1;
    return;
  }
  let original = '';
  try {
    original = await readStdin();
  } catch (e) {
    log(`failed to read stdin: ${e.message}`);
    return;
  }
  const agentName = await resolveAgentName();
  const stamped = agentName
    ? field === 'title'
      ? stampTitle(original, agentName)
      : stampBody(original, agentName)
    : original;
  process.stdout.write(stamped);
}

if (require.main === module) {
  main().catch((e) => {
    log(`unexpected error: ${e.message}`);
    process.exitCode = 0;
  });
}

module.exports = {
  resolveAgentName,
  resolveApiKey,
  stampTitle,
  stampBody,
};
