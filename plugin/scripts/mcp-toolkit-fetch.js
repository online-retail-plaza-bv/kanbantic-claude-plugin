'use strict';

//
// mcp-toolkit-fetch.js — KBT-F637 / KBT-RL208
//
// Fetches Skill + Subagent toolkit items straight from the Kanbantic MCP
// endpoint, for the SessionStart toolkit-sync hook.
//
// Why MCP and not the REST API: MCP returns `category` and `model` as enum
// *names* ("Subagent", "Sonnet"); REST returns them as integers (6, 1). The
// hand-written workstation hooks fetched over REST and therefore had to rebuild
// that mapping themselves — one of them did it for `category` and forgot it for
// `model`, which is how every subagent ended up running on the wrong model
// (KBT-B531). Choosing the transport that already speaks the right contract
// removes the mapping step entirely, and with it the place to forget it.
//
// This module builds no alias table of its own. An unrecognised value is passed
// through untouched to sync-workspace-skills.js, which normalises it there.
//
// The auth handshake mirrors proxy/kanbantic-mcp-proxy.js: Bearer token,
// `Accept: application/json, text/event-stream`, and the Mcp-Session-Id from
// the initialize response echoed back on every subsequent request.
//
// Zero deps — node built-ins only.
//

const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const DEFAULT_MCP_URL = 'https://kanbantic.com/mcp';

// Every request carries a timeout. This is the one failure mode that a plain
// try/catch cannot cover: an endpoint that accepts the connection and then
// never answers hangs forever, and a SessionStart hook that hangs makes every
// session on that workstation unusable. All the other failures announce
// themselves; this one just stops.
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Read a value from the Windows user environment registry.
 *
 * A GUI-launched session (Claude Desktop, Cowork) inherits its environment from
 * explorer.exe at sign-in, so a variable added afterwards is invisible until the
 * user signs out and back in. The proxy has the same fallback for the same
 * reason; without it the hook silently does nothing on a machine where the key
 * is demonstrably set.
 */
function readRegistryEnv(name) {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(new RegExp(`${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)`, 'i'));
    return m ? m[1].trim() : undefined;
  } catch (_) {
    return undefined;
  }
}

function resolveApiKey(env = process.env) {
  const fromEnv = env.KANBANTIC_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();

  // An explicitly-empty variable means "no key", and must NOT fall through to
  // the registry. In a GUI-inherited environment an unconfigured key is
  // *absent*, never an empty string — so setting it to '' is a deliberate
  // signal, and it is the only way a test can simulate an unconfigured
  // workstation on a machine where the registry value is set.
  if (typeof fromEnv === 'string') return '';

  return readRegistryEnv('KANBANTIC_API_KEY') || '';
}

/**
 * Parse a text/event-stream body into the JSON-RPC messages it carries.
 */
function parseSSE(raw) {
  const out = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try { out.push(JSON.parse(payload)); } catch (_) { /* not our frame */ }
  }
  return out;
}

/**
 * One JSON-RPC POST. Resolves to the parsed messages plus any session id the
 * server handed back.
 */
function post({ url, apiKey, sessionId, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
      },
      (res) => {
        const nextSession = res.headers['mcp-session-id'] || sessionId || null;

        if (res.statusCode === 202) {
          res.resume();
          resolve({ messages: [], sessionId: nextSession });
          return;
        }

        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const ct = String(res.headers['content-type'] || '').toLowerCase();
          try {
            const messages = ct.includes('text/event-stream')
              ? parseSSE(data)
              : [JSON.parse(data)];
            resolve({ messages, sessionId: nextSession });
          } catch (_) {
            reject(new Error('unparseable response body'));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/**
 * An MCP session. Holds the handshake state so a caller can make several
 * tool-calls over one connection instead of re-initialising per call.
 */
function createClient({
  url = process.env.KANBANTIC_MCP_URL || DEFAULT_MCP_URL,
  apiKey = resolveApiKey(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let sessionId = null;
  let nextId = 1;
  let ready = false;

  const send = async (body) => {
    const res = await post({ url, apiKey, sessionId, body, timeoutMs });
    if (res.sessionId) sessionId = res.sessionId;
    return res.messages;
  };

  async function handshake() {
    if (ready) return;
    if (!apiKey) throw new Error('no API key available');
    await send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kanbantic-session-start-sync', version: '1.0.0' },
      },
    });
    await send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    ready = true;
  }

  /**
   * Call one MCP tool and return its parsed JSON payload.
   */
  async function call(name, args) {
    await handshake();
    const messages = await send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const msg = messages.find((m) => m && (m.result || m.error));
    if (!msg) throw new Error(`no response for ${name}`);
    if (msg.error) throw new Error(`${name} failed`);
    const text = (msg.result.content || []).map((c) => c.text || '').join('');
    return JSON.parse(text);
  }

  return { call };
}

/**
 * Fetch the Skill + Subagent toolkit items for a workspace.
 *
 * @returns {Promise<Array>} the concatenated items, exactly as MCP returned
 *   them. Callers get the enum *names*, not integers.
 * @throws on any transport, protocol, or parse failure. The hook is responsible
 *   for turning that into a quiet exit 0 (KBT-BD206); this module reports
 *   honestly so the tests can see what broke.
 */
async function fetchToolkitItems({
  workspace,
  client = createClient(),
  categories = ['Skill', 'Subagent'],
} = {}) {
  if (!workspace) throw new Error('workspace is required');

  const items = [];
  for (const category of categories) {
    const payload = await client.call('list_toolkit_items', {
      workspaceId: workspace,
      category,
      maxResults: 200,
    });

    // KBT-B654 — `payload.items || []` used to stand here, which made "the call
    // came back without an items key" indistinguishable from "there are zero
    // items of this category". The caller then handed a half-empty list to a
    // sync running with --force, and nine Subagent mirrors were deleted. A
    // malformed or truncated answer is an error, not an empty result: throwing
    // here reaches the hook, which skips the sync entirely (KBT-BD206).
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error(
        `list_toolkit_items(${category}) returned no items array — ` +
        `refusing to treat a malformed answer as an empty category`
      );
    }
    if (payload.truncated === true) {
      throw new Error(
        `list_toolkit_items(${category}) reported truncated:true — the list is incomplete`
      );
    }
    if (typeof payload.totalCount === 'number' && payload.totalCount !== payload.items.length) {
      throw new Error(
        `list_toolkit_items(${category}) returned ${payload.items.length} items ` +
        `but reported totalCount ${payload.totalCount}`
      );
    }

    for (const item of payload.items) items.push(item);
  }
  return items;
}

/**
 * Build the `{ workspace, url }` list that detection layer 3 matches against.
 *
 * Only reached on a fresh clone — layers 1 and 2 answer without any network at
 * all — so the extra round-trip per workspace is paid once, not every session.
 * A workspace whose repository list fails to load is skipped rather than
 * aborting the whole lookup: one unreachable workspace should not stop the
 * repo we are actually in from being recognised.
 */
async function fetchWorkspaceRepositories({ client = createClient() } = {}) {
  const context = await client.call('get_context', {});
  const workspaces = (context.workspaces || [])
    .map((w) => (w && (w.slug || w.name)) || '')
    .filter(Boolean);

  const repositories = [];
  for (const workspace of workspaces) {
    let payload;
    try {
      payload = await client.call('list_repositories', { workspaceId: workspace });
    } catch (_) {
      continue;
    }
    for (const repo of payload.repositories || payload.items || []) {
      const url = (repo && (repo.url || repo.cloneUrl || repo.remoteUrl)) || '';
      if (url) repositories.push({ workspace, url });
    }
  }
  return repositories;
}

module.exports = {
  createClient,
  fetchToolkitItems,
  fetchWorkspaceRepositories,
  resolveApiKey,
  parseSSE,
  DEFAULT_MCP_URL,
  DEFAULT_TIMEOUT_MS,
};
