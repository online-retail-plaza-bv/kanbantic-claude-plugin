#!/usr/bin/env node
'use strict';

//
// kanbantic-mcp-proxy — stdio-to-HTTP bridge for Kanbantic MCP Server
//
// Why this exists:
//   Claude Code's HTTP MCP client has an OAuth-first auth strategy. When the
//   server returns 401, Claude Code enters OAuth discovery mode and caches the
//   result in .credentials.json. Once cached, it never falls back to static
//   Bearer tokens — even after the server removes all OAuth endpoints. This
//   "cache poisoning" causes intermittent auth failures days after install.
//
//   This proxy uses stdio transport (no OAuth, no discovery, no cache) and
//   handles HTTP + Bearer auth itself. Problem permanently eliminated.
//
// Agent Communication Hub (KBT-E046 Phase 3b):
//   When the host calls the `register_agent_session` tool, the proxy:
//     1. Captures the returned sessionId + channelId.
//     2. Declares `experimental.claude/channel` capability on the next initialize-
//        response so Claude Code accepts inbound channel notifications.
//     3. Starts a 1s inbox-poll-loop that calls `get_channel_messages` with an
//        After-cursor and pushes each new message via `notifications/claude/channel`.
//     4. On SIGINT/SIGTERM: stops the poll, calls `end_agent_session`, exits clean.
//
// Zero dependencies — uses only Node.js built-ins.
//

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { execSync } = require('child_process');

const MCP_URL = process.env.KANBANTIC_MCP_URL || 'https://kanbantic.com/mcp';
let API_KEY = process.env.KANBANTIC_API_KEY;

// Claude Desktop and Cowork launch the proxy as a child of a GUI process that
// inherits its environment from explorer.exe at sign-in. User env vars added
// afterwards are invisible to them until the user signs out and back in. Fall
// back to HKCU\Environment so the key is resolvable without that cycle and
// without requiring a literal secret in claude_desktop_config.json.
if (!API_KEY && process.platform === 'win32') {
  try {
    const out = execSync('reg query HKCU\\Environment /v KANBANTIC_API_KEY', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/KANBANTIC_API_KEY\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i);
    if (m) API_KEY = m[1].trim();
  } catch {
    // Value absent; handled at dispatch time with a clear JSON-RPC error.
  }
}

let sessionId = null;            // MCP transport session (Mcp-Session-Id header)
let stdinEnded = false;
let shuttingDown = false;

// Agent Communication Hub state (set after register_agent_session succeeds).
let agentSessionId = null;       // Kanbantic AgentSession.Id
let agentChannelId = null;       // Kanbantic AgentChannel.Id (1:1 with session)
let inboxCursor = null;          // ISO timestamp — only fetch messages with SentAt > this
let inboxPollTimer = null;
const INBOX_POLL_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// stdio: read newline-delimited JSON-RPC from stdin, write to stdout
// Messages are queued and processed sequentially to ensure session state
// (e.g. Mcp-Session-Id from initialize) is available for later requests.
// ---------------------------------------------------------------------------

let buf = '';
const queue = [];
let processing = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  drain();
});
process.stdin.on('end', () => {
  stdinEnded = true;
  if (!processing) gracefulExit(0);
});

function drain() {
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) queue.push(line);
  }
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    await dispatch(queue.shift());
  }
  processing = false;
  if (stdinEnded) gracefulExit(0);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------------------
// dispatch: validate, forward, post-process, respond
// ---------------------------------------------------------------------------

async function dispatch(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write('[kanbantic-proxy] invalid JSON on stdin\n');
    return;
  }

  // Guard: no API key
  if (!API_KEY) {
    process.stderr.write('[kanbantic-proxy] KANBANTIC_API_KEY not set\n');
    if (msg.id != null) {
      send({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'KANBANTIC_API_KEY not found in environment or Windows User registry. '
            + 'Set it via System Properties → Environment Variables → User variables, '
            + 'then restart the host application.'
        },
        id: msg.id,
      });
    }
    return;
  }

  try {
    const responses = await forward(line);
    for (const r of responses) {
      postProcess(msg, r);
      send(r);
    }
    // Side-effect (fire-and-forget): surface readiness-gate overrides so a second
    // party can confirm them. Never blocks or alters the response above.
    flagOverrideIfPresent(msg, responses).catch(() => {});
  } catch (err) {
    process.stderr.write(`[kanbantic-proxy] ${err.message}\n`);
    if (msg.id != null) {
      send({
        jsonrpc: '2.0',
        error: { code: -32603, message: err.message },
        id: msg.id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// postProcess: inspect responses for capability negotiation + register_agent_session
// ---------------------------------------------------------------------------

function postProcess(request, response) {
  // 1. Declare claude/channel capability on initialize-response so Claude Code
  //    accepts inbound notifications/claude/channel.
  if (request.method === 'initialize' && response.result) {
    response.result.capabilities = response.result.capabilities || {};
    response.result.capabilities.experimental =
      response.result.capabilities.experimental || {};
    response.result.capabilities.experimental['claude/channel'] = {};
  }

  // 2. Capture sessionId + channelId from register_agent_session response.
  if (request.method === 'tools/call' &&
      request.params && request.params.name === 'register_agent_session' &&
      response.result && response.result.content) {
    const parsed = parseToolResult(response);
    if (parsed && parsed.success && parsed.sessionId && parsed.channelId) {
      agentSessionId = parsed.sessionId;
      agentChannelId = parsed.channelId;
      // Initialize the inbox-poll cursor at 'now' so we don't replay old history.
      inboxCursor = new Date().toISOString();
      startInboxPoll();
      writeSessionFile();
      process.stderr.write(
        `[kanbantic-proxy] agent session ${agentSessionId} registered, ` +
        `channel ${agentChannelId} — inbox-poll started\n`
      );
    }
  }

  // 3. Reset state on end_agent_session so a graceful end stops the poll-loop.
  if (request.method === 'tools/call' &&
      request.params && request.params.name === 'end_agent_session') {
    stopInboxPoll();
    removeSessionFile();
    agentSessionId = null;
    agentChannelId = null;
  }
}

// ---------------------------------------------------------------------------
// Session-file: persistent metadata read by Claude Code hook scripts
// (UserPromptSubmit / PreToolUse / PostToolUse / Stop) to discover the active
// AgentChannel + API URL. Hooks run as separate subprocesses and don't share
// memory with the proxy — the file is the IPC mechanism.
// Path: ~/.claude-kanbantic-session.json (single-session per user, last register
// wins for multi-Claude-session-per-workstation scenarios — see KBT-E046 P4 README).
// ---------------------------------------------------------------------------

function sessionFilePath() {
  return path.join(os.homedir(), '.claude-kanbantic-session.json');
}

function writeSessionFile() {
  if (!agentSessionId || !agentChannelId) return;
  const payload = {
    sessionId: agentSessionId,
    channelId: agentChannelId,
    apiUrl: deriveApiUrl(),
    writtenAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(sessionFilePath(), JSON.stringify(payload, null, 2), { encoding: 'utf8' });
  } catch (e) {
    process.stderr.write(`[kanbantic-proxy] failed to write session file: ${e.message}\n`);
  }
}

function removeSessionFile() {
  try {
    fs.unlinkSync(sessionFilePath());
  } catch {
    // file may not exist; ignore.
  }
}

function deriveApiUrl() {
  // KANBANTIC_API_URL takes precedence; otherwise derive from MCP_URL by stripping the /mcp path.
  if (process.env.KANBANTIC_API_URL) return process.env.KANBANTIC_API_URL.replace(/\/$/, '');
  try {
    const url = new URL(MCP_URL);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'https://kanbantic.com';
  }
}

function parseToolResult(response) {
  // Tool results in MCP wrap the actual response in content[0].text as JSON string.
  try {
    const content = response.result.content;
    if (!Array.isArray(content) || content.length === 0) return null;
    const text = content[0].text;
    if (typeof text !== 'string') return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Readiness-gate override governance flag
//
// `update_issue_status` and `claim_issue` accept an `overrideReason` that bypasses
// a failing readiness gate under both Soft AND Hard enforcement. That escape hatch
// is what let an entire initiative reach Done with no review-approval, no test
// results, and no merged-branch record (the "skew" that motivated this guard).
//
// The proxy cannot — and should not — block the call (it is a transparent bridge,
// and the authoritative fix belongs in the backend's IssueReadinessService). What
// it CAN do, centrally for every agent on every workstation regardless of
// workspace, is make each override visible for second-party review: it posts a
// greppable Comment on the affected issue. The server already records a passive
// Decision audit entry; this is the actionable, aggregatable governance flag.
//
// Opt out with KANBANTIC_SKIP_OVERRIDE_FLAG=1 (mirrors KANBANTIC_SKIP_GIT_SYNC).
// ---------------------------------------------------------------------------

const OVERRIDE_FLAG_TOOLS = new Set(['update_issue_status', 'claim_issue']);
const OVERRIDE_FLAG_MARKER = '[override-governance]';

async function flagOverrideIfPresent(request, responses) {
  if (process.env.KANBANTIC_SKIP_OVERRIDE_FLAG === '1') return;
  if (!request || request.method !== 'tools/call' || !request.params) return;

  const name = request.params.name;
  const args = request.params.arguments;
  if (!OVERRIDE_FLAG_TOOLS.has(name)) return;
  if (!args || typeof args.overrideReason !== 'string' || args.overrideReason.trim() === '') return;
  if (!args.issueId) return;

  // Only flag when the override actually succeeded — match the response by id.
  const resp = Array.isArray(responses)
    ? responses.find((r) => r && r.id === request.id)
    : null;
  const parsed = resp ? parseToolResult(resp) : null;
  if (!parsed || parsed.success !== true) return;

  const target = parsed.issueCode || args.issueId;
  const action =
    name === 'claim_issue'
      ? 'claim (Prepared → InProgress)'
      : `status change to "${args.status}"`;

  const content =
    `⚠️ **${OVERRIDE_FLAG_MARKER}** A readiness gate was bypassed via \`overrideReason\` ` +
    `on a ${action}.\n\n` +
    `**Override reason given:** ${args.overrideReason.trim()}\n\n` +
    `**Why this is flagged:** an \`overrideReason\` lets a single agent pass a gate that ` +
    `would otherwise block (e.g. All Tests Passed / Review Approved / Specs Approved / ` +
    `Child Issues Done). Per separation-of-duties this transition should be confirmed by a ` +
    `second party who did not perform the work. Search \`${OVERRIDE_FLAG_MARKER}\` to review ` +
    `every proxy-flagged override.\n\n` +
    `_Auto-flagged by kanbantic-mcp-proxy. Set \`KANBANTIC_SKIP_OVERRIDE_FLAG=1\` to disable._`;

  try {
    await callInternalTool('add_discussion_entry', {
      issueId: target,
      entryType: 'Comment',
      content,
    });
    process.stderr.write(`[kanbantic-proxy] flagged readiness-gate override on ${target} (${name})\n`);
  } catch (e) {
    process.stderr.write(
      `[kanbantic-proxy] failed to flag override on ${target}: ${e.message}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Inbox-poll loop — calls get_channel_messages every 1s, pushes new messages
// to the host via notifications/claude/channel.
// ---------------------------------------------------------------------------

function startInboxPoll() {
  if (inboxPollTimer) return;
  inboxPollTimer = setInterval(pollInbox, INBOX_POLL_INTERVAL_MS);
}

function stopInboxPoll() {
  if (!inboxPollTimer) return;
  clearInterval(inboxPollTimer);
  inboxPollTimer = null;
}

async function pollInbox() {
  if (!agentChannelId || shuttingDown) return;

  try {
    const result = await callInternalTool('get_channel_messages', {
      channelId: agentChannelId,
      after: inboxCursor,
      maxResults: 50,
    });

    if (!result || !result.success) return;
    const messages = result.messages || [];
    if (messages.length === 0) return;

    for (const msg of messages) {
      // Skip messages authored by the same session — those are our own outbound
      // posts coming back through the channel.
      if (msg.authorAgentSessionId && msg.authorAgentSessionId === agentSessionId) {
        if (msg.sentAt > inboxCursor) inboxCursor = msg.sentAt;
        continue;
      }

      send({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: msg.content,
          meta: {
            from_session: msg.authorAgentSessionId || null,
            from_user: msg.authorUserId || null,
            from_display_name: msg.authorDisplayName || 'Unknown',
            author_type: msg.authorType,
            message_type: msg.messageType,
            sent_at: msg.sentAt,
            message_id: msg.id,
            channel_id: msg.channelId,
          },
        },
      });

      if (msg.sentAt > inboxCursor) inboxCursor = msg.sentAt;
    }
  } catch (e) {
    process.stderr.write(`[kanbantic-proxy] inbox-poll error: ${e.message}\n`);
  }
}

// callInternalTool: invokes a tool/call against the server WITHOUT going through
// the stdin queue. Used by the poll-loop to fetch inbox messages internally.
async function callInternalTool(toolName, toolArgs) {
  const requestId = `proxy-internal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: { name: toolName, arguments: toolArgs },
  });
  const responses = await forward(body);
  for (const r of responses) {
    if (r.id === requestId) {
      return parseToolResult(r);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// forward: POST JSON-RPC to Kanbantic MCP server with Bearer auth
// ---------------------------------------------------------------------------

function forward(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(MCP_URL);
    const transport = url.protocol === 'https:' ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${API_KEY}`,
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      },
      (res) => {
        // Track session across requests
        if (res.headers['mcp-session-id']) {
          sessionId = res.headers['mcp-session-id'];
        }

        // 202 Accepted — notification acknowledged, no response body
        if (res.statusCode === 202) {
          resolve([]);
          return;
        }

        // 401 — auth failure
        if (res.statusCode === 401) {
          reject(new Error(
            'Authentication failed (401). Verify KANBANTIC_API_KEY is correct.'
          ));
          return;
        }

        // Other errors
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let d = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (d += c));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${d}`)));
          return;
        }

        // Success — parse response
        const ct = (res.headers['content-type'] || '').toLowerCase();
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            if (ct.includes('text/event-stream')) {
              resolve(parseSSE(data));
            } else {
              resolve([JSON.parse(data)]);
            }
          } catch (e) {
            reject(new Error(`Failed to parse server response: ${e.message}`));
          }
        });
      },
    );

    req.on('error', (e) => reject(new Error(`Connection failed: ${e.message}`)));
    req.setTimeout(120_000, () => req.destroy(new Error('Request timeout (120s)')));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// parseSSE: extract JSON-RPC messages from Server-Sent Events stream
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Graceful shutdown — SIGINT/SIGTERM handlers
//
// On signal: stop the poll-loop, call end_agent_session if we have a sessionId,
// then exit. Wraps process.exit so stdin-end and signals share the same cleanup
// path.
// ---------------------------------------------------------------------------

async function gracefulExit(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  stopInboxPoll();
  removeSessionFile();

  if (agentSessionId && API_KEY) {
    try {
      await callInternalTool('end_agent_session', {
        sessionId: agentSessionId,
        reason: 'ProxyShutdown',
      });
      process.stderr.write(`[kanbantic-proxy] ended session ${agentSessionId}\n`);
    } catch (e) {
      process.stderr.write(
        `[kanbantic-proxy] failed to end session on shutdown: ${e.message}\n`
      );
    }
  }

  process.exit(code);
}

process.on('SIGINT', () => {
  process.stderr.write('[kanbantic-proxy] received SIGINT, shutting down\n');
  gracefulExit(0);
});
process.on('SIGTERM', () => {
  process.stderr.write('[kanbantic-proxy] received SIGTERM, shutting down\n');
  gracefulExit(0);
});
