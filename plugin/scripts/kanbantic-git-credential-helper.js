#!/usr/bin/env node
'use strict';

//
// kanbantic-git-credential-helper — KBT-B330
//
// A git credential helper that fetches a repository's PAT from Kanbantic
// just-in-time and hands it to git over stdin. The token therefore NEVER lands
// in `.git/config` (no userinfo in the remote URL), a command line, shell
// history, the process list, or the agent transcript — the helper, not the
// agent, calls `get_repository_credential`.
//
// Why this exists (the anti-pattern it replaces):
//   The lane-skills used to clone with `https://<credential>@github.com/...`.
//   Git persists that URL verbatim into `remote.origin.url`, leaking the
//   plaintext PAT to disk for the lifetime of the clone. See KBT-B330.
//
// Git credential protocol (gitcredentials(7)):
//   git invokes:  <helper> <operation>        operation ∈ {get, store, erase}
//   on stdin:     key=value lines, terminated by a blank line
//   for `get`:    print `username=…` and `password=…`, then a blank line, exit 0.
//                 Printing nothing lets git fall through to the next helper /
//                 its normal prompt — so every failure mode here is silent on
//                 stdout (diagnostics go to stderr) and exits 0.
//   store/erase:  no-op. We never persist, so there is nothing to store or erase.
//
// Repository identity — the helper needs the Kanbantic repositoryId, resolved from
//   (1) env  KANBANTIC_REPOSITORY_ID, else
//   (2) `git config --get kanbantic.repositoryId`. The lane-skill sets this in the
//       clone's local config; git also propagates `-c kanbantic.repositoryId=…`
//       to subprocesses via GIT_CONFIG_PARAMETERS, so resolution works DURING the
//       initial clone (before the local config file exists) too.
//
// Auth to Kanbantic mirrors the proxy: KANBANTIC_API_KEY from process.env, or
//   HKCU\Environment on Windows; Bearer against KANBANTIC_MCP_URL
//   (default https://kanbantic.com/mcp). The MCP server is stateless, so a single
//   tools/call POST works — no initialize handshake or session id required.
//
// Zero dependencies — Node.js built-ins only.
//

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execSync, execFileSync } = require('child_process');

const MCP_URL = process.env.KANBANTIC_MCP_URL || 'https://kanbantic.com/mcp';
const REQUEST_TIMEOUT_MS = 30_000;

function log(msg) {
  process.stderr.write(`[kanbantic-credential-helper] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// API key resolution — env first, then HKCU\Environment on Windows (matches the
// proxy so GUI-launched hosts that don't inherit the User env var still work).
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
// Repository id resolution — env override, then git config (which also sees
// `-c kanbantic.repositoryId=…` via GIT_CONFIG_PARAMETERS during clone).
// ---------------------------------------------------------------------------
function resolveRepositoryId() {
  if (process.env.KANBANTIC_REPOSITORY_ID) {
    return process.env.KANBANTIC_REPOSITORY_ID.trim();
  }
  try {
    const out = execFileSync('git', ['config', '--get', 'kanbantic.repositoryId'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const id = out.trim();
    return id || null;
  } catch {
    // key absent (git exits 1) — silent fall-through.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read the git credential request from stdin (key=value lines). We don't depend
// on its contents, but draining stdin avoids the helper exiting before git has
// finished writing (EPIPE) and lets us log the host for diagnostics.
// ---------------------------------------------------------------------------
function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function parseCredentialInput(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i === -1) continue;
    out[line.slice(0, i)] = line.slice(i + 1).replace(/\r$/, '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// forward: POST a single JSON-RPC tools/call to the Kanbantic MCP server with
// Bearer auth. Returns the array of JSON-RPC response objects (handles both
// application/json and text/event-stream). Stateless server → no session.
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

// GitHub/GitLab accept the PAT as the password; the username is a provider-specific
// sentinel. Default to GitHub's convention.
function usernameForProvider(provider) {
  switch ((provider || '').toLowerCase()) {
    case 'gitlab':
      return 'oauth2';
    case 'github':
    default:
      return 'x-access-token';
  }
}

async function handleGet() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    log('no KANBANTIC_API_KEY in env or HKCU\\Environment — falling through');
    return;
  }
  const repositoryId = resolveRepositoryId();
  if (!repositoryId) {
    log('no repositoryId (set kanbantic.repositoryId in git config or '
      + 'KANBANTIC_REPOSITORY_ID) — falling through');
    return;
  }

  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_repository_credential', arguments: { repositoryId } },
  });

  let responses;
  try {
    responses = await forward(apiKey, requestBody);
  } catch (e) {
    log(`credential fetch failed: ${e.message} — falling through`);
    return;
  }

  const result = parseToolResult((responses || []).find((r) => r && r.id === 1) || {});
  if (!result || result.success !== true || !result.token) {
    const reason = result && result.errorMessage ? result.errorMessage : 'no token in response';
    log(`credential unavailable: ${reason} — falling through`);
    return;
  }

  // The ONLY place the token is emitted: straight to git over stdout.
  process.stdout.write(`username=${usernameForProvider(result.provider)}\n`);
  process.stdout.write(`password=${result.token}\n`);
  process.stdout.write('\n');
}

async function main() {
  const op = process.argv[2];
  const raw = await readStdin();

  // store/erase: we never persist, so nothing to do. Draining stdin is enough.
  if (op === 'store' || op === 'erase') return;
  if (op !== 'get') {
    log(`unknown operation "${op}" — ignoring`);
    return;
  }

  const input = parseCredentialInput(raw);
  if (input.host) log(`get for ${input.protocol || 'https'}://${input.host}`);

  await handleGet();
}

main().catch((e) => {
  // Never fail loudly: a thrown helper makes git error out instead of prompting.
  log(`unexpected error: ${e.message}`);
  process.exit(0);
});
