#!/usr/bin/env node
'use strict';

//
// kanbantic-git-identity — KBT-F616
//
// Resolves and applies the git commit identity for the current repository,
// deterministically — not dependent on an agent reading SKILL.md prose
// correctly and typing the right `git config` lines. Precedence:
//
//   1. GIT_AUTHOR_NAME + GIT_AUTHOR_EMAIL env vars, if both set — git already
//      honors these over `git config` for every commit; this script does
//      nothing (no git config changes), so it never fights an explicit
//      operator override configured once per workstation.
//   2. get_current_agent_identity (KBT-F615) — the calling agent's own name/
//      email, resolved server-side from the authenticated API key. Read-only
//      and safe to call any number of times — unlike register_agent_session,
//      which always inserts a new AgentSession row (KBT-F613/F615 finding).
//   3. get_repository(repositoryId) — the repository's configured
//      gitAuthorName/gitAuthorEmail (the pre-KBT-F614 per-repo fallback).
//
// Used two ways:
//   - Explicitly, once, from kanbantic-issue-execute / kanbantic-issue-review
//     Step 0b — replaces the old manual precedence-prose + two `git config`
//     lines with a single script invocation.
//   - As a required library by the self-healing PreToolUse gate
//     (pre-tool-use-git-identity-gate.js), which calls resolveAndApplyIdentity
//     before every `git commit` Bash call as a safety net that does not
//     depend on the SKILL.md step having run at all.
//
// Auth + HTTP mirror kanbantic-git-credential-helper.js exactly (KBT-B330):
// KANBANTIC_API_KEY from process.env or HKCU\Environment on Windows; a single
// stateless tools/call POST against KANBANTIC_MCP_URL, no initialize
// handshake or session id required. Zero dependencies — Node.js built-ins
// only.
//
// Never throws and never blocks the caller: every failure mode falls through
// silently, leaving git config untouched. A missing identity is a quality
// gap the PreToolUse gate can still catch next time, not a reason to fail a
// clone/checkout/commit.
//

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execSync, execFileSync } = require('child_process');

const MCP_URL = process.env.KANBANTIC_MCP_URL || 'https://kanbantic.com/mcp';
const REQUEST_TIMEOUT_MS = 15_000;

function log(msg) {
  process.stderr.write(`[kanbantic-git-identity] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// API key resolution — identical to kanbantic-git-credential-helper.js.
//
// KBT-B546 — every function below that reads or writes git config takes an
// explicit `env` (default `process.env`). Production behaviour is unchanged;
// tests inject a config source (GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM) so their
// outcome no longer depends on the developer's own `~/.gitconfig`. The
// dependency is visible in the signature instead of hidden behind a prepared
// HOME — and, unlike an in-process stub, an env object also survives the
// process boundary to the spawned CLI/hook.
// ---------------------------------------------------------------------------
function resolveApiKey({ env = process.env } = {}) {
  if (env.KANBANTIC_API_KEY) return env.KANBANTIC_API_KEY;
  if (process.platform === 'win32') {
    try {
      const out = execSync('reg query HKCU\\Environment /v KANBANTIC_API_KEY', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env,
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
// Repository id resolution — env override, then git config. Same convention
// as the credential helper; used here for the layer-3 (per-repo) fallback.
// ---------------------------------------------------------------------------
function resolveRepositoryId(cwd, { env = process.env } = {}) {
  if (env.KANBANTIC_REPOSITORY_ID) {
    return env.KANBANTIC_REPOSITORY_ID.trim();
  }
  try {
    const out = execFileSync('git', ['config', '--get', 'kanbantic.repositoryId'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    const id = out.trim();
    return id || null;
  } catch {
    // key absent (git exits 1) — silent fall-through.
    return null;
  }
}

function getGitConfig(cwd, key, { env = process.env } = {}) {
  try {
    const out = execFileSync('git', ['config', '--get', key], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function setGitConfig(cwd, key, value, { env = process.env } = {}) {
  execFileSync('git', ['config', key, value], { cwd, stdio: ['ignore', 'ignore', 'ignore'], env });
}

// ---------------------------------------------------------------------------
// forward: POST a single JSON-RPC tools/call to the Kanbantic MCP server with
// Bearer auth. Mirrors kanbantic-git-credential-helper.js's `forward` exactly
// — the server is stateless, so no initialize handshake is needed.
// ---------------------------------------------------------------------------
function forward(apiKey, body, mcpUrl = MCP_URL) {
  return new Promise((resolve, reject) => {
    const url = new URL(mcpUrl);
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

async function callTool(apiKey, name, args, mcpUrl = MCP_URL) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const responses = await forward(apiKey, body, mcpUrl);
  return parseToolResult((responses || []).find((r) => r && r.id === 1) || {});
}

// ---------------------------------------------------------------------------
// resolveAndApplyIdentity — the exported entry point, shared by the CLI and
// the PreToolUse gate.
// ---------------------------------------------------------------------------
async function resolveAndApplyIdentity({ cwd = process.cwd(), env = process.env } = {}) {
  const mcpUrl = env.KANBANTIC_MCP_URL || MCP_URL;

  // Layer 1 — operator override via native git env vars. Git already honors
  // these over `git config`; do nothing.
  if (env.GIT_AUTHOR_NAME && env.GIT_AUTHOR_EMAIL) {
    log('GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL set — workstation override active, no git config change');
    return { applied: false, source: 'env-override' };
  }

  const apiKey = resolveApiKey({ env });
  if (!apiKey) {
    log('no KANBANTIC_API_KEY in env or HKCU\\Environment — cannot resolve, leaving git config untouched');
    return { applied: false, source: null };
  }

  // Layer 2 — the calling agent's own identity (KBT-F615, read-only).
  try {
    const identity = await callTool(apiKey, 'get_current_agent_identity', {}, mcpUrl);
    if (identity && identity.success && identity.claudeAgentName && identity.claudeAgentEmail) {
      setGitConfig(cwd, 'user.name', identity.claudeAgentName, { env });
      setGitConfig(cwd, 'user.email', identity.claudeAgentEmail, { env });
      log(`identity set from get_current_agent_identity: ${identity.claudeAgentName} <${identity.claudeAgentEmail}>`);
      return { applied: true, source: 'agent-identity', name: identity.claudeAgentName, email: identity.claudeAgentEmail };
    }
  } catch (e) {
    log(`get_current_agent_identity failed: ${e.message} — falling back to repository identity`);
  }

  // Layer 3 — the repository's configured gitAuthorName/gitAuthorEmail.
  const repositoryId = resolveRepositoryId(cwd, { env });
  if (!repositoryId) {
    log('no repositoryId (kanbantic.repositoryId git config or KANBANTIC_REPOSITORY_ID) — cannot resolve layer 3');
    return { applied: false, source: null };
  }

  try {
    const repo = await callTool(apiKey, 'get_repository', { repositoryId }, mcpUrl);
    if (repo && repo.success && repo.gitAuthorName && repo.gitAuthorEmail) {
      setGitConfig(cwd, 'user.name', repo.gitAuthorName, { env });
      setGitConfig(cwd, 'user.email', repo.gitAuthorEmail, { env });
      log(`identity set from get_repository: ${repo.gitAuthorName} <${repo.gitAuthorEmail}>`);
      return { applied: true, source: 'repository', name: repo.gitAuthorName, email: repo.gitAuthorEmail };
    }
    log('get_repository returned no gitAuthorName/gitAuthorEmail — leaving git config untouched');
  } catch (e) {
    log(`get_repository failed: ${e.message} — leaving git config untouched`);
  }

  return { applied: false, source: null };
}

// ---------------------------------------------------------------------------
// CLI entry point — `node kanbantic-git-identity.js` from within the clone.
// ---------------------------------------------------------------------------
async function main() {
  await resolveAndApplyIdentity({ cwd: process.cwd(), env: process.env });
}

if (require.main === module) {
  main().catch((e) => {
    log(`unexpected error: ${e.message}`);
    process.exit(0); // never fail the caller
  });
}

module.exports = {
  resolveAndApplyIdentity,
  resolveApiKey,
  resolveRepositoryId,
  getGitConfig,
  setGitConfig,
};
