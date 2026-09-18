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
const crypto = require('crypto');
const { URL } = require('url');
const { execSync } = require('child_process');
const sessionFileHelpers = require('./session-file'); // KBT-F717

// Claude Desktop and Cowork launch the proxy as a child of a GUI process that
// inherits its environment from explorer.exe at sign-in. User env vars added
// afterwards are invisible to them until the user signs out and back in. Fall
// back to HKCU\Environment so values are resolvable without that cycle and
// without requiring a literal secret in claude_desktop_config.json.
function readRegistryEnv(name) {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execSync(`reg query HKCU\\Environment /v ${name}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(new RegExp(`${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)`, 'i'));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined; // Value absent; callers handle the miss.
  }
}

const MCP_URL = process.env.KANBANTIC_MCP_URL || 'https://kanbantic.com/mcp';
let API_KEY = process.env.KANBANTIC_API_KEY || readRegistryEnv('KANBANTIC_API_KEY');

let sessionId = null;            // MCP transport session (Mcp-Session-Id header)
let stdinEnded = false;
let shuttingDown = false;

// Agent Communication Hub state (set after register_agent_session succeeds).
let agentSessionId = null;       // Kanbantic AgentSession.Id
let agentChannelId = null;       // Home channel — the 1:1 AgentChannel of this session
let agentWorkspaceId = null;     // KBT-F717 (hoofdagent-review) — the workspaceId this session was
                                  // registered for; register_agent_session's response never echoes
                                  // it back, so it is captured from the REQUEST arguments instead.
let inboxPollTimer = null;
const INBOX_POLL_INTERVAL_MS = 1000;

// SPIKE (multi-room) — an agent listens to N channels instead of exactly one.
//
// There is no Room entity on the server yet. There does not have to be one for this
// spike: posting to a channel is gated on nothing but workspace-view (see the
// cross-channel branch in AgentChannelAppService.ResolveAgentSessionIdAsync), so any
// channel id that several participants agree to share already behaves as a room. The
// only thing standing in the way was this proxy's single-channel inbox — one variable,
// one cursor. It becomes one subscription per channel:
//
//   Map<channelId, {
//     cursorAt: ISO string,      // KBT-F719 — renamed from `cursor`: paired with cursorId
//                                // below, this is now a composite (SentAt, Id) cursor, not
//                                // a bare timestamp — see get_channel_messages(afterId).
//     cursorId: string|null,     // message id half of the composite cursor
//     label: string,
//     home: boolean,
//     failCount: number,         // KBT-F719 — consecutive poll failures, for backoff
//     nextRetryAt: number,       // KBT-F719 — Date.now() ms; polling this channel is
//                                // skipped until this passes (backoff-with-jitter)
//     archived: boolean,         // KBT-F719 — server said AgentChannel.Archived; stop
//                                // retrying a channel that can never succeed again
//                                // instead of backing off forever on a dead end
//                                // (KBT-F721 finding: end_agent_session archives the
//                                // channel server-side — a permanent, not transient, state)
//   }>
//
// The cap is deliberate: this is the knob the spike exists to measure. Every subscribed
// room pushes into the same context window, so "how many rooms before the agent loses
// the thread" is the question, not an implementation detail to hide.
const roomSubscriptions = new Map();
const MAX_ROOM_SUBSCRIPTIONS = 8;

// KBT-F719 — overlap guard: a single `get_channel_messages` call is allowed up to 120s
// (forward()'s own timeout), but the poll interval is 1s. Without this, a slow request
// plus the next setInterval tick firing anyway meant two concurrent polls of the same
// channel with the SAME (not-yet-advanced) cursor — i.e. every message in flight during
// the slow request got pushed to the host TWICE. `pollInbox` is now a no-op while a
// previous invocation is still running; the timer keeps ticking, but overlapping ticks
// just skip instead of racing.
let pollInFlight = false;

// KBT-F719 — bounded dedup, belt-and-suspenders on top of the cursor fix above. Two
// independent causes could still hand the same messageId to `__sendImpl` twice: a
// process restart that resumes from a slightly-stale persisted cursor (deliberately
// erring toward "maybe one repeat" rather than "maybe a gap" — see
// loadPersistedCursor()), or a future code path this file doesn't anticipate yet. A
// small LRU (Set, insertion-ordered, capped) means a genuine duplicate is dropped
// instead of re-delivered, without growing unbounded over a long session.
const recentlySeenMessageIds = new Set();
const RECENTLY_SEEN_CAP = 500;
function rememberMessageId(id) {
  if (recentlySeenMessageIds.has(id)) return false; // already seen — caller should skip it
  recentlySeenMessageIds.add(id);
  if (recentlySeenMessageIds.size > RECENTLY_SEEN_CAP) {
    // Map/Set iteration order is insertion order — the first key is the oldest.
    recentlySeenMessageIds.delete(recentlySeenMessageIds.values().next().value);
  }
  return true; // not seen before — caller should deliver it
}

// KBT-F719 — backoff-with-jitter tuning. A network blip must never mean "stop polling
// silently forever" (the Epic's own complaint about this proxy) NOR "hammer a down
// server every 1s". Exponential, capped, with jitter so many concurrently-recovering
// rooms do not all retry on the exact same tick.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
function computeBackoffMs(failCount) {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failCount - 1));
  return exp + Math.floor(Math.random() * BACKOFF_BASE_MS); // jitter: up to +1 base interval
}
// KBT-B470 — keep-alive heartbeat. The backend stale-sweep marks a session Stale after
// HeartbeatTimeoutSeconds (300s) of no LastSeen refresh, archiving its channel and dropping it
// from /agent-sessions. An idle spawned agent never calls the heartbeat tool itself, so the
// proxy refreshes LastSeen periodically (well under the 300s window) while it stays connected.
let heartbeatTimer = null;
const HEARTBEAT_INTERVAL_MS = 90_000;

// KBT-E102 F2 — idempotency guard for the startup auto-register side-effect.
let autoRegisterStarted = false;

// KBT-F717 — stable per-process identifier, generated once at module load and
// attached to every outgoing register_agent_session call. Lets the SERVER
// (AgentSessionAppService.RegisterAsync) recognise a second registration from
// this same proxy process even when the client-side short-circuit below is
// bypassed (e.g. a non-proxy MCP client, or a call that carries an update).
// Reset only in tests via __resetForTest so each test gets process isolation.
let PROCESS_TOKEN = crypto.randomUUID();

// ---------------------------------------------------------------------------
// stdio: read newline-delimited JSON-RPC from stdin, write to stdout
// Messages are queued and processed sequentially to ensure session state
// (e.g. Mcp-Session-Id from initialize) is available for later requests.
// ---------------------------------------------------------------------------

let buf = '';
const queue = [];
let processing = false;

// Only wire up stdin/stdout transport when run as a script. When the module is
// require()'d (e.g. by unit tests for the pure helpers below) these side effects
// must not fire. Runtime behavior as a CLI is unchanged.
if (require.main === module) {
  staleSessionFileCleanup(); // KBT-F717 — best-effort, never blocks startup
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    drain();
  });
  process.stdin.on('end', () => {
    stdinEnded = true;
    if (!processing) gracefulExit(0);
  });
}

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

// Test seam: the inbox-poll emits through this indirection so unit tests can capture
// channel notifications instead of writing them to stdout. `send` is a hoisted function
// declaration, so this module-load initialization safely captures it. Production
// behaviour is unchanged.
let __sendImpl = send;
function setSendForTest(fn) { __sendImpl = fn || send; }

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

  // SPIKE (multi-room): join_room / leave_room / list_rooms are proxy-local. They must
  // be answered here and never forwarded — the server does not know these tools.
  const localRoom = handleLocalRoomTool(msg);
  if (localRoom) {
    if (msg.id != null) send(localRoom);
    return;
  }

  // KBT-F717 — a second register_agent_session within a process that already has a
  // confirmed active session is answered from the cache, with zero network round trip,
  // instead of asking the server to create a second AgentSession + AgentChannel. Falls
  // through to a normal forward (with processToken attached below) when the call carries
  // an update (summary/cwd/currentIssueId) — that case must still reach the server so the
  // update persists (server applies it idempotently via processToken, KBT-SR621).
  const registerShortCircuit = handleRegisterAgentSessionShortCircuit(msg);
  if (registerShortCircuit) {
    if (msg.id != null) send(registerShortCircuit);
    return;
  }

  // KBT-F717 — attach the stable per-process token to every register_agent_session
  // call this proxy forwards, so the server can recognise a duplicate registration
  // from this process even when the client-side short-circuit above does not apply.
  // Returns true when it mutated msg.params.arguments — that must feed the same
  // "forward the re-serialized message, not the raw line" decision as the filePath
  // substitution below, or the attached token is silently dropped (KBT-GTCH149-style
  // trap: a mutation that never reaches the forwarded body).
  const tokenAttached = attachProcessTokenToRegisterCall(msg);

  // KBT-F722 — same contract as tokenAttached immediately above: must feed bodyToForward
  // below or the attached CLI session id is silently dropped (KBT-GTCH149-style trap).
  const cliSessionIdAttached = attachClaudeCliSessionIdToRegisterCall(msg);

  // KBT-F718 fast-follow — inject this session's own id into an outbound send_message
  // call so the server uses F718's explicit-sender path instead of its guessing fallback.
  // Must feed the same "forward the re-serialized message" decision as the other
  // mutations here, or the attached id is silently dropped (KBT-GTCH149-style trap).
  const fromSessionIdAttached = attachFromSessionIdToSendMessageCall(msg);

  // KBT-F464: resolve a filePath argument into content before forwarding. On an
  // ambiguity / unreadable-file error, respond with a JSON-RPC error and do NOT
  // forward. On success, the message's arguments are mutated in place and the
  // re-serialized body is forwarded; an untouched message forwards verbatim.
  const fp = resolveFilePathArgument(msg);
  if (fp.error) {
    if (msg.id != null) {
      send({ jsonrpc: '2.0', error: fp.error, id: msg.id });
    } else {
      process.stderr.write(`[kanbantic-proxy] ${fp.error.message}\n`);
    }
    return;
  }
  const bodyToForward = (fp.mutated || tokenAttached || cliSessionIdAttached || fromSessionIdAttached) ? JSON.stringify(msg) : line;

  try {
    const responses = await forward(bodyToForward);
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
    // KBT-E102 F2 — auto-register right after initialize (fire-and-forget; idempotent).
    if (shouldAutoRegister()) autoRegister().catch(() => {});
  }

  // 2. Capture sessionId + channelId from register_agent_session response.
  if (request.method === 'tools/call' &&
      request.params && request.params.name === 'register_agent_session' &&
      response.result && response.result.content) {
    const parsed = parseToolResult(response);
    if (parsed && parsed.success && parsed.sessionId && parsed.channelId) {
      agentSessionId = parsed.sessionId;
      agentChannelId = parsed.channelId;
      // KBT-F717 (hoofdagent-review) — capture from the REQUEST, not the response: the
      // response DTO never echoes workspaceId back.
      agentWorkspaceId = (request.params.arguments && request.params.arguments.workspaceId) || null;
      // SPIKE (multi-room): the session's own channel is just the first subscription —
      // marked home so it keeps its unprefixed wire format and cannot be left.
      subscribeRoom(agentChannelId, 'home', { home: true });
      startHeartbeat(); // KBT-B470 — keep the session alive while connected
      writeSessionFile();
      process.stderr.write(
        `[kanbantic-proxy] agent session ${agentSessionId} registered, ` +
        `channel ${agentChannelId} — inbox-poll started\n`
      );
    }
  }

  // 3. KBT-F717 / KBT-RL259 — reset local state on end_agent_session ONLY when the
  //    call targeted THIS process's own session AND actually succeeded. Previously
  //    this reset unconditionally on every end_agent_session tools/call, so a call
  //    for a different sessionId (or one that failed — network blip, server error)
  //    still went deaf: it stopped this process's own poll/heartbeat/session-file
  //    even though nothing had actually ended server-side.
  if (request.method === 'tools/call' &&
      request.params && request.params.name === 'end_agent_session') {
    const args = request.params.arguments || {};
    const targetSessionId = args.sessionId;
    // No explicit sessionId in the call → the tool ends the caller's own session,
    // which — from this proxy's perspective — is whatever it has cached.
    const isOwnSession = !targetSessionId || targetSessionId === agentSessionId;
    const parsed = parseToolResult(response);
    const succeeded = !!parsed && parsed.success === true;

    if (isOwnSession && succeeded) {
      stopInboxPoll();
      stopHeartbeat(); // KBT-B470
      removeSessionFile();
      agentSessionId = null;
      agentChannelId = null;
      roomSubscriptions.clear(); // SPIKE (multi-room)
    } else if (!isOwnSession) {
      process.stderr.write(
        `[kanbantic-proxy] end_agent_session targeted ${targetSessionId}, not this ` +
        `process's session (${agentSessionId}) — local state untouched\n`
      );
    } else {
      process.stderr.write(
        '[kanbantic-proxy] end_agent_session did not succeed — keeping poll/heartbeat/session-file alive\n'
      );
    }
  }

  // 4. KBT-F464: advertise `filePath` as an optional alternative to each tool's
  //    inline content field on every content-bearing tool in the tools/list response.
  if (request.method === 'tools/list' && response.result) {
    augmentToolsListResponse(response);
    injectRoomToolsIntoList(response); // SPIKE (multi-room) — advertise the local tools
  }
}

// ---------------------------------------------------------------------------
// KBT-F717 — client-side register_agent_session idempotency.
//
// Two layers, per the chosen design (KBT-SR620 + KBT-SR621):
//   - This proxy short-circuits a pure-duplicate register within its own process
//     (no new summary/cwd/currentIssueId) — zero network round trip.
//   - Every register call that DOES reach the server carries `processToken`, a
//     stable per-process id, so AgentSessionAppService.RegisterAsync can also
//     recognise a duplicate registration from this same process (defense in
//     depth against any caller that bypasses the short-circuit, e.g. a register
//     call carrying an update, or a non-proxy MCP client).
// ---------------------------------------------------------------------------

// Fields that represent a real UPDATE to the session, not a bare re-register.
// A call carrying any of these must still reach the server so the update
// persists — the local cache alone cannot answer it truthfully.
const REGISTER_UPDATE_FIELDS = ['summary', 'cwd', 'currentIssueId'];

function isRegisterAgentSessionCall(msg) {
  return !!msg && msg.method === 'tools/call' &&
    !!msg.params && msg.params.name === 'register_agent_session';
}

// Returns a synthesized JSON-RPC success response (answered from cache) when this
// register call is a pure duplicate within a process that already has a confirmed
// active session FOR THE SAME WORKSPACE, or null when the call must be forwarded
// (no cached session yet, the call carries an update, or it targets a DIFFERENT
// workspace than the cached session).
function handleRegisterAgentSessionShortCircuit(msg) {
  if (!isRegisterAgentSessionCall(msg)) return null;
  if (!agentSessionId || !agentChannelId) return null; // nothing cached yet — forward normally

  const args = msg.params.arguments || {};

  // KBT-F717 (hoofdagent-review) — MUST-FIX: a process that serves more than one
  // workspace (or a skill that explicitly passes a different workspaceId) must never
  // be handed back a DIFFERENT workspace's cached session — that would leak the wrong
  // sessionId/channelId to the caller, and the server would never see this call at
  // all. Only short-circuit when the incoming workspaceId is absent (caller doesn't
  // care) or matches the cached session's workspace exactly.
  if (args.workspaceId && agentWorkspaceId && args.workspaceId !== agentWorkspaceId) {
    return null; // different workspace — must forward, never answer from this cache
  }

  const carriesUpdate = REGISTER_UPDATE_FIELDS.some((k) =>
    Object.prototype.hasOwnProperty.call(args, k));
  if (carriesUpdate) return null; // let it forward so the update reaches the server

  process.stderr.write(
    `[kanbantic-proxy] register_agent_session short-circuited — process already has ` +
    `session ${agentSessionId}, no server round trip\n`
  );
  return {
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          sessionId: agentSessionId,
          channelId: agentChannelId,
          alreadyRegistered: true,
        }),
      }],
    },
  };
}

// Mutates msg.params.arguments in place to add processToken when this is a
// register_agent_session call being forwarded (i.e. it survived the short-circuit
// above). Returns true iff it mutated the message — callers must forward the
// re-serialized message, not the original raw line, when this is true.
function attachProcessTokenToRegisterCall(msg) {
  if (!isRegisterAgentSessionCall(msg)) return false;
  if (!msg.params.arguments || typeof msg.params.arguments !== 'object') {
    msg.params.arguments = {};
  }
  if (msg.params.arguments.processToken) return false; // caller already set one — don't clobber
  msg.params.arguments.processToken = PROCESS_TOKEN;
  return true;
}

// KBT-F722 — attach the Claude Code CLI's own session id (env var CLAUDE_CODE_SESSION_ID) to
// every register_agent_session call this proxy forwards, mirroring attachProcessTokenToRegisterCall
// exactly. A `claude --resume <id>` re-spawn is a NEW OS process (new PROCESS_TOKEN) but keeps this
// SAME env var — it is the field the server matches on FIRST (KBT-SR624) so a resumed registration
// reattaches to the existing AgentSession instead of creating a new one. Same
// "must feed bodyToForward" contract as attachProcessTokenToRegisterCall — see the KBT-GTCH149-style
// trap noted at the call site in dispatch().
function attachClaudeCliSessionIdToRegisterCall(msg) {
  if (!isRegisterAgentSessionCall(msg)) return false;
  if (!process.env.CLAUDE_CODE_SESSION_ID) return false; // nothing to attach
  if (!msg.params.arguments || typeof msg.params.arguments !== 'object') {
    msg.params.arguments = {};
  }
  if (msg.params.arguments.claudeCliSessionId) return false; // caller already set one — don't clobber
  msg.params.arguments.claudeCliSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  return true;
}

// KBT-F718 fast-follow — send_message's explicit-sender path (fromSessionId) only helps if
// something actually populates it. Before this, EVERY call fell back to the server's
// heuristic (AgentChannelAppService.ResolveAgentSessionIdAsync's "most recently seen
// non-Done/Stale session of the same ClaudeAgentId"), which is exactly the guesswork KBT-F718
// built the explicit path to replace — an agent with two active sessions (two processes/
// workstations under the same identity) could have a message misattributed to the wrong one.
// The proxy is the one place that reliably knows ITS OWN sessionId (captured at register
// time, KBT-F717), so it injects it automatically: the model never has to know this
// parameter exists, and an explicit override the caller DID set (rare, but not this proxy's
// call to forbid) is never clobbered.
function attachFromSessionIdToSendMessageCall(msg) {
  if (!msg || msg.method !== 'tools/call' || !msg.params || msg.params.name !== 'send_message') {
    return false;
  }
  if (!agentSessionId) return false; // not registered yet — nothing to inject, forward as-is
  if (!msg.params.arguments || typeof msg.params.arguments !== 'object') {
    msg.params.arguments = {};
  }
  if (msg.params.arguments.fromSessionId) return false; // caller already set one — don't clobber
  msg.params.arguments.fromSessionId = agentSessionId;
  return true;
}

// ---------------------------------------------------------------------------
// KBT-E102 F2 — auto-register the agent session on startup.
//
// When the Workstation Daemon spawns Claude with KANBANTIC_WORKSPACE_ID (and the
// API key), the proxy registers itself automatically right after initialize — no
// reliance on the model deciding to call register_agent_session. Idempotent (one
// shot per process) and backward-compatible: without KANBANTIC_WORKSPACE_ID (local
// / manual plugin use) it never auto-registers.
//
// The register response is routed through postProcess() so the existing
// sessionId/channelId-capture + inbox-poll logic is reused unchanged.
// ---------------------------------------------------------------------------

// Central read of the startup env-vars the Workstation Daemon passes in.
//
// Deliberately process.env only — no HKCU\Environment fallback. The registry
// fallback exists for the API key alone, because GUI-launched hosts inherit a
// stale environment and the key must be resolvable without a sign-out cycle. The
// auto-register context is different: the Daemon always injects it at spawn, so
// a machine-wide KANBANTIC_WORKSPACE_ID could only come from a developer's own
// profile — and would silently auto-register every manually-started plugin,
// which is exactly what KBT-US771 forbids. Keeping this to process.env also
// keeps the guard testable without depending on the dev machine (cf. KBT-B438).
function autoRegisterEnv() {
  return {
    workspaceId: process.env.KANBANTIC_WORKSPACE_ID,
    workstationId: process.env.KANBANTIC_WORKSTATION_ID,
    host: process.env.KANBANTIC_HOST,
    spawnCommandId: process.env.KANBANTIC_SPAWN_COMMAND_ID,
  };
}

function shouldAutoRegister() {
  return !autoRegisterStarted && !!autoRegisterEnv().workspaceId && !!API_KEY;
}

// Test seam: autoRegister forwards via this indirection so unit tests can inject a
// mock without real HTTP. `forward` is a hoisted function declaration, so this
// initialization (which runs during module load) safely captures it.
let __forwardImpl = forward;
function setForwardForTest(fn) { __forwardImpl = fn; }
function __resetForTest() {
  autoRegisterStarted = false;
  agentSessionId = null;
  agentChannelId = null;
  agentWorkspaceId = null; // KBT-F717
  // Re-read from process.env only (never the registry): the test controls the key,
  // so the outcome must not depend on the developer's machine (cf. KBT-B438).
  API_KEY = process.env.KANBANTIC_API_KEY;
  stopInboxPoll();
  stopHeartbeat(); // KBT-B470
  roomSubscriptions.clear(); // SPIKE (multi-room)
  __sendImpl = send;
  PROCESS_TOKEN = crypto.randomUUID(); // KBT-F717 — fresh per-process token per test
  pollInFlight = false; // KBT-F719 — a test must never inherit a stuck in-flight guard
  recentlySeenMessageIds.clear(); // KBT-F719 — dedup set must not leak ids across tests
}

// KBT-B470 — test hook: set the active session id so sendHeartbeat() can be exercised in isolation.
function __setSessionForTest(id) { agentSessionId = id; }
// KBT-F717 — test hooks: set/read BOTH session fields, and read the process token,
// so the register short-circuit / end_agent_session-scoping / session-file tests can
// arrange state and assert on it without a real HTTP round trip.
function __setFullSessionForTest(sid, cid, wsid) {
  agentSessionId = sid;
  agentChannelId = cid;
  if (wsid !== undefined) agentWorkspaceId = wsid; // KBT-F717 — optional 3rd arg, backward-compatible
}
function __getSessionForTest() { return { agentSessionId, agentChannelId, agentWorkspaceId }; }
function __getProcessTokenForTest() { return PROCESS_TOKEN; }

async function autoRegister() {
  if (!shouldAutoRegister()) return;
  autoRegisterStarted = true; // claim the slot up-front → idempotent across re-initialize

  const env = autoRegisterEnv();
  const args = {
    workspaceId: env.workspaceId,
    host: env.host || os.hostname(),
    cwd: process.cwd(),
  };
  if (env.workstationId) args.workstationId = env.workstationId;
  if (env.spawnCommandId) args.spawnCommandId = env.spawnCommandId;
  // KBT-F717 — the idempotency key is ALWAYS processToken, never spawnCommandId.
  // spawnCommandId identifies the daemon's spawn REQUEST, which is deliberately
  // reused across a crash-respawn (KBT-F550) — matching on it there would wrongly
  // reattach the freshly-spawned replacement process to its dead predecessor's
  // session. processToken identifies THIS proxy PROCESS and is regenerated on every
  // process start (including a crash-respawn), so it is the correct idempotency key.
  args.processToken = PROCESS_TOKEN;
  // KBT-F722 — same idempotency-key upgrade as processToken, but for the resume scenario:
  // CLAUDE_CODE_SESSION_ID survives a `claude --resume <id>` re-spawn (a new OS process, new
  // PROCESS_TOKEN) so the server can reattach to the existing AgentSession instead of creating a
  // new one (KBT-SR624). Absent for a proxy build/launch that has no such env var (older claude,
  // or a context where it isn't set) — omitted rather than sent as an empty string.
  if (process.env.CLAUDE_CODE_SESSION_ID) args.claudeCliSessionId = process.env.CLAUDE_CODE_SESSION_ID;

  const request = {
    jsonrpc: '2.0',
    id: `proxy-autoregister-${Date.now()}`,
    method: 'tools/call',
    params: { name: 'register_agent_session', arguments: args },
  };

  // Finite retry (3×, 1s/2s/4s backoff); never crash the proxy on a register failure.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const responses = await __forwardImpl(JSON.stringify(request));
      for (const r of responses) postProcess(request, r); // reuse capture + inbox-poll
      if (agentSessionId) {
        process.stderr.write(
          `[kanbantic-proxy] auto-registered agent session ${agentSessionId} (channel ${agentChannelId})\n`
        );
        return;
      }
      process.stderr.write(
        `[kanbantic-proxy] auto-register attempt ${attempt}/3: no session in response\n`
      );
    } catch (e) {
      process.stderr.write(
        `[kanbantic-proxy] auto-register attempt ${attempt}/3 failed: ${e.message}\n`
      );
      if (/401|403/.test(e.message || '')) {
        process.stderr.write(
          '[kanbantic-proxy] check KANBANTIC_API_KEY + workspace-lidmaatschap (AgentSessions.Create)\n'
        );
      }
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
  }
  process.stderr.write('[kanbantic-proxy] auto-register gave up after 3 attempts\n');
}

// ---------------------------------------------------------------------------
// filePath → content substitution (KBT-F464)
//
// The proxy runs locally with filesystem access, so it can resolve a large file
// on disk into the `content` argument before forwarding — Claude never has to
// load the file into its context. Generic: applies to ANY tools/call carrying a
// `filePath` argument (KBT-RL134), not just add_wireframe_version.
//
//   - filePath absent / blank      → no-op, message forwarded verbatim (KBT-BD147)
//   - filePath + non-empty content → ambiguity error, NOT forwarded (KBT-RL133)
//   - filePath only                → read file, set content, drop filePath (KBT-PR279)
//   - filePath unreadable           → clear error, NOT forwarded (KBT-SR481)
//
// Returns one of:
//   { }                  — leave the message untouched (forward verbatim)
//   { mutated: true }    — arguments rewritten in place (forward re-serialized)
//   { error: {code,message} } — respond with this JSON-RPC error, do not forward
// ---------------------------------------------------------------------------

// Most content-bearing tools carry their large payload in a `content` argument,
// but some use a differently-named field — e.g. the wireframe fileset tools carry
// their whole payload in `filesJson` (a JSON-array string), not `content`. The
// filePath machinery reads the file into whichever field the tool actually expects.
// This alias table is the single source of truth for tools whose content-field is
// not literally `content`; every other tool defaults to `content`.
const CONTENT_FIELD_BY_TOOL = {
  // KBT-F519: create_wireframe now creates version 1 from a fileset — its payload is
  // `filesJson` (a JSON-array string), not the removed `initialContent` (KBT-B390).
  // Same filePath offload as add_wireframe_version_files.
  create_wireframe: 'filesJson',
  // KBT-B417: the multi-file fileset tool carries its whole payload in `filesJson`
  // (a JSON-array string), not `content`. Mapping it here lets the same filePath
  // offload keep large filesets OUT of the MCP tools/call message — the exact
  // client-side message-size cap (~60-90KB) that KBT-F464 solved for `content`.
  // The file at filePath must contain the filesJson value (the JSON array text).
  add_wireframe_version_files: 'filesJson',
};

function contentFieldFor(toolName) {
  return CONTENT_FIELD_BY_TOOL[toolName] || 'content';
}

// KBT-B398: the wireframe-content tools store raw HTML / filesets. Their filePath
// source must never be a serialized MCP *response* that was saved to disk by mistake.
// (KBT-F519 removed add_wireframe_version; create_wireframe + the fileset tool remain.)
const WIREFRAME_CONTENT_TOOLS = new Set(['create_wireframe', 'add_wireframe_version_files']);

// KBT-B398: recognise a serialized get_wireframe / create_wireframe /
// add_wireframe_version_files response that was saved to disk and then re-used as an
// upload source. The fingerprint is a JSON object whose `.version` is an object
// carrying a string `content` (or `initialContent`) — a shape that raw wireframe
// HTML (which starts with `<`, not `{`) can never take. Detecting it lets the proxy
// refuse the upload loudly instead of silently double-wrapping the wireframe.
function looksLikeSavedWireframeResponse(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimStart();
  if (trimmed[0] !== '{') return false; // raw HTML never starts with '{'
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false; // not JSON → genuine content, leave it alone
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const version = parsed.version;
  if (!version || typeof version !== 'object' || Array.isArray(version)) return false;
  return typeof version.content === 'string' || typeof version.initialContent === 'string';
}

// ---------------------------------------------------------------------------
// KBT-B411 — confine the local filePath read channel.
//
// resolveFilePathArgument reads filePath from disk and forwards the bytes to the
// remote server through a channel deliberately kept OUT of the model transcript
// (KBT-F464). A prompt-injected filePath could therefore point at a secret
// (~/.ssh/id_rsa, .env) and exfiltrate it invisibly. Before reading we now:
//   - canonicalize with realpathSync (defeats symlink escape),
//   - reject anything but a regular file and cap the size,
//   - refuse known secret/credential files (denylist), and
//   - audit every read to stderr so the channel is never silent.
// ---------------------------------------------------------------------------
const MAX_FILEPATH_BYTES = 25 * 1024 * 1024; // 25 MiB — generous vs. real wireframe filesets

// Sensitive directory anywhere in the path (e.g. ~/.ssh/id_rsa, ~/.aws/credentials).
const SECRET_PATH_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker']);
// Exact credential filenames.
const SECRET_BASENAMES = new Set([
  '.env', '.npmrc', '.netrc', '.pgpass', '.git-credentials', '.credentials.json',
  '.claude.json', 'credentials', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
// Key / certificate extensions.
const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.pfx', '.p12', '.keystore', '.ppk']);

// Returns a human reason string if the canonical path looks like a secret, else null.
function secretFileReason(canonicalPath) {
  const norm = canonicalPath.replace(/\\/g, '/').toLowerCase();
  const segments = norm.split('/').filter(Boolean);
  const base = segments[segments.length - 1] || '';

  for (const seg of segments) {
    if (SECRET_PATH_SEGMENTS.has(seg)) return `path traverses a sensitive directory ('${seg}')`;
  }
  if (SECRET_BASENAMES.has(base)) return `filename '${base}' is a known credential file`;
  if (base === '.env' || base.startsWith('.env.')) return `filename '${base}' is a dotenv secret file`;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot) : '';
  if (SECRET_EXTENSIONS.has(ext)) return `extension '${ext}' is a private key / certificate file`;
  return null;
}

// Screens a filePath before it is read. Returns { path, bytes } on success or
// { error: {code,message} } (JSON-RPC error) on refusal — never throws.
function screenFilePathRead(filePath, toolName) {
  const readFail = (verb, e) => ({
    error: {
      code: -32603,
      message:
        `Failed to ${verb} filePath '${filePath}' for tool '${toolName}': ` +
        `${e.code || e.name || 'Error'}: ${e.message}. The call was not forwarded.`,
    },
  });

  let canonical;
  try {
    canonical = fs.realpathSync(filePath); // resolve symlinks + relative segments
  } catch (e) {
    return readFail('read', e);
  }

  let stat;
  try {
    stat = fs.statSync(canonical);
  } catch (e) {
    return readFail('stat', e);
  }

  if (!stat.isFile()) {
    return { error: { code: -32602, message:
      `filePath '${filePath}' for tool '${toolName}' is not a regular file. The call was not forwarded.` } };
  }
  if (stat.size > MAX_FILEPATH_BYTES) {
    return { error: { code: -32602, message:
      `filePath '${filePath}' for tool '${toolName}' is ${stat.size} bytes, over the ` +
      `${MAX_FILEPATH_BYTES}-byte limit. The call was not forwarded.` } };
  }

  const secret = secretFileReason(canonical);
  if (secret) {
    return { error: { code: -32602, message:
      `Refused to read filePath '${filePath}' for tool '${toolName}': ${secret}. The proxy will ` +
      `not upload secret/credential files. The call was not forwarded.` } };
  }

  // KBT-B411 audit: this read channel is intentionally invisible to the transcript,
  // so surface it on stderr (operator log) — the channel is never silent.
  process.stderr.write(
    `[kanbantic-mcp-proxy] filePath read for '${toolName}': ${canonical} (${stat.size} bytes)\n`);

  return { path: canonical, bytes: stat.size };
}

function resolveFilePathArgument(msg) {
  if (!msg || msg.method !== 'tools/call' || !msg.params) return {};
  const args = msg.params.arguments;
  if (!args || typeof args !== 'object') return {};

  const filePath = args.filePath;
  if (typeof filePath !== 'string' || filePath.trim() === '') return {};

  const toolName = msg.params.name || '(unknown tool)';
  const contentField = contentFieldFor(toolName);

  // Ambiguity: both a filePath and a non-empty inline content field were supplied.
  // Refuse rather than silently pick one — a silent precedence hides a caller mistake.
  if (typeof args[contentField] === 'string' && args[contentField].length > 0) {
    return {
      error: {
        code: -32602,
        message:
          `Ambiguous arguments for tool '${toolName}': both 'filePath' and '${contentField}' ` +
          `were provided. Use exactly one — 'filePath' to have the proxy read the file ` +
          `from disk, or '${contentField}' to pass the value inline. The call was not forwarded.`,
      },
    };
  }

  // KBT-B411 — screen the path before reading: canonicalize, cap size, refuse
  // secret/credential files, and audit to stderr.
  const screen = screenFilePathRead(filePath, toolName);
  if (screen.error) return { error: screen.error };

  let fileContent;
  try {
    fileContent = fs.readFileSync(screen.path, 'utf8');
  } catch (e) {
    return {
      error: {
        code: -32603,
        message:
          `Failed to read filePath '${filePath}' for tool '${toolName}': ` +
          `${e.code || e.name || 'Error'}: ${e.message}. The call was not forwarded.`,
      },
    };
  }

  // KBT-B398: guard against a silently double-wrapped upload. If the file for a
  // wireframe-content tool is itself a serialized MCP response envelope
  // ({"success":...,"version":{"content":...}}) rather than raw HTML, the caller
  // almost certainly saved a get_wireframe / add_wireframe_version response to disk
  // by mistake. Storing it verbatim buries the real HTML one level deep and the
  // wireframe preview renders JSON. Refuse loudly — consistent with the ambiguity
  // guard above ("refuse rather than silently pick"), never silently corrupt.
  if (WIREFRAME_CONTENT_TOOLS.has(toolName) && looksLikeSavedWireframeResponse(fileContent)) {
    return {
      error: {
        code: -32602,
        message:
          `The file at filePath '${filePath}' for tool '${toolName}' looks like a saved ` +
          `Kanbantic API response ({"success":...,"version":{"content":...}}), not raw ` +
          `wireframe HTML. Storing it would double-wrap the wireframe — the real HTML ends ` +
          `up buried one level deep and the preview renders JSON. Upload the raw HTML ` +
          `instead (the value of the response's .version.content field). The call was not forwarded.`,
      },
    };
  }

  args[contentField] = fileContent;
  delete args.filePath;
  return { mutated: true };
}

// ---------------------------------------------------------------------------
// tools/list augmentation (KBT-F464)
//
// Tool schemas are served by the remote MCP server; the plugin cannot change them
// server-side. So the proxy enriches the tools/list response: every tool that
// accepts an inline content field also advertises an optional `filePath` alternative
// (KBT-SR482). Driven by the presence of the tool's content field — `content` for
// most tools, or a mapped alias like `initialContent` for create_wireframe (KBT-B390)
// — never a hardcoded tool list (KBT-RL134). `filePath` is never added to `required`.
// ---------------------------------------------------------------------------

// KBT-B514: the advertised wording must match the CONTENT_FIELD_BY_TOOL mapping.
// For filesJson-tools the file must contain the filesJson VALUE itself (a JSON
// array of {path, content} objects) — raw HTML/CSS/JS fails server-side with
// "Invalid filesJson". The generic wording misled callers into passing raw files.
function filePathPropDescriptionFor(contentField) {
  if (contentField === 'filesJson') {
    return (
      "Optional alternative to passing filesJson inline: an absolute local file path. " +
      'The kanbantic-mcp-proxy reads the file locally and substitutes its contents into ' +
      "the tool's filesJson field before forwarding, so large filesets never enter the " +
      "model's context. IMPORTANT: the file must contain the filesJson VALUE itself — a " +
      'JSON array of {"path","content"} objects, e.g. [{"path":"index.html","content":"…"}] — ' +
      "NOT a raw HTML/CSS/JS file. Provide either 'filePath' or inline filesJson, not both."
    );
  }
  return (
    "Optional alternative to passing the content inline: an absolute local file path. " +
    'The kanbantic-mcp-proxy reads the file locally and substitutes its contents into ' +
    "the tool's content field before forwarding, so large files never enter the model's " +
    "context. Provide either 'filePath' or the inline content field, not both."
  );
}

function augmentToolsListResponse(response) {
  const tools = response && response.result && response.result.tools;
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const schema = tool && tool.inputSchema;
    const props = schema && schema.properties;
    if (!props || typeof props !== 'object') continue;

    // Resolve the tool's content-bearing field: the alias table for tools that use
    // a non-standard name (e.g. create_wireframe → initialContent), else the
    // conventional `content` (KBT-B390). Only augment tools that actually expose it.
    const contentField = contentFieldFor(tool.name);
    if (!props[contentField]) continue; // only content-bearing tools
    if (props.filePath) continue;       // already advertised — don't clobber

    props.filePath = { type: 'string', description: filePathPropDescriptionFor(contentField) };

    // Remove the content field from required so Claude knows it may use filePath
    // instead. Without this, Claude sees content as mandatory and fills it alongside
    // filePath, which triggers the ambiguity guard in resolveFilePathArgument (KBT-B349).
    if (Array.isArray(schema.required)) {
      schema.required = schema.required.filter(r => r !== contentField);
    }

    if (typeof tool.description === 'string' && !tool.description.includes('filePath')) {
      const tip = contentField === 'filesJson'
        ? `\n\nTip: for large filesets you may pass 'filePath' (an absolute local path) ` +
          `instead of 'filesJson'; the proxy reads the file locally so it never enters context. ` +
          `The file must contain the filesJson JSON array itself ` +
          `([{"path":"index.html","content":"…"}]), not a raw HTML/CSS/JS file.`
        : `\n\nTip: for large content you may pass 'filePath' (an absolute local path) ` +
          `instead of '${contentField}'; the proxy reads the file locally so it never enters context.`;
      tool.description = tool.description.trimEnd() + tip;
    }
  }
}

// ---------------------------------------------------------------------------
// Session-file: persistent metadata read by Claude Code hook scripts to
// discover the active AgentChannel + API URL. Hooks run as separate
// subprocesses and don't share memory with the proxy — the file is the IPC
// mechanism. The only registered reader today is hooks/stop-version-summary.js
// (Stop hook, see hooks.json). KBT-F726 removed the four PowerShell hooks
// (UserPromptSubmit/PreToolUse/PostToolUse/Stop.ps1) that used to read this
// file — they were never registered in hooks.json and so never ran; see
// KBT-BD242 for why the daemon-side transcript-ingest producer they backed
// stays out of scope for this cleanup.
//
// KBT-F717 — per-SESSION, not global. Path:
//   ~/.claude-kanbantic-session-<CLAUDE_CODE_SESSION_ID>.json
// (PID-based fallback — ~/.claude-kanbantic-session-pid-<pid>.json — only when
// CLAUDE_CODE_SESSION_ID is absent, e.g. an older Claude Code build). Naming
// scheme lives in session-file.js so the writer (here) and the reader
// (hooks/stop-version-summary.js) cannot drift apart. Each process writes and
// removes ONLY its own file — see the end_agent_session scoping fix above and
// staleSessionFileCleanup() below for the two ways a stray file could
// otherwise accumulate.
// ---------------------------------------------------------------------------

function sessionFilePath() {
  return sessionFileHelpers.sessionFilePath(os.homedir());
}

function writeSessionFile() {
  if (!agentSessionId || !agentChannelId) return;
  // KBT-F719 — persist each subscribed channel's composite cursor so a restarted proxy for
  // this SAME logical session (same CLAUDE_CODE_SESSION_ID, see sessionFilePath()) can resume
  // exactly where it left off via loadPersistedCursor() instead of defaulting to 'now' (a gap)
  // or re-reading from empty (a replay). Built fresh from roomSubscriptions on every write —
  // no separate tracking to keep in sync.
  const cursors = {};
  for (const [channelId, sub] of roomSubscriptions.entries()) {
    if (sub.cursorAt) cursors[channelId] = { at: sub.cursorAt, id: sub.cursorId };
  }
  const payload = {
    sessionId: agentSessionId,
    channelId: agentChannelId,
    // KBT-F722 — explicit field, not just implicit via the filename (sessionFilePath() already
    // keys the file by CLAUDE_CODE_SESSION_ID when available, see session-file.js). Writing it
    // into the body too lets a reader verify/correlate it without re-deriving the filename logic.
    claudeCliSessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    apiUrl: deriveApiUrl(),
    writtenAt: new Date().toISOString(),
    pid: process.pid, // KBT-F717 — liveness check for staleSessionFileCleanup(); NOT an identity key
    cursors,
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

// KBT-F717 — best-effort startup GC for session files left behind by a process
// that never got to run its own cleanup (crash, kill -9, power loss). Never
// touches the CURRENT process's own file (computed fresh, excluded by name) and
// never throws — a GC failure must not block startup.
//
// Hoofdagent-review: mtime alone is NOT proof of death. writeSessionFile() runs
// once, at register time — a long-running but perfectly healthy overnight
// session's file can be many hours old without ever being rewritten. Age can
// therefore never be the deletion criterion on its own. The only thing this GC
// deletes on is a DEMONSTRABLY dead writer: the PID recorded in the file no
// longer exists (process.kill(pid, 0) → ESRCH). Any other outcome — the
// process is alive, we're not permitted to probe it (EPERM, still alive from
// our point of view), the pid field is missing/malformed, or listing/reading
// races with another process — leaves the file untouched. "Bij twijfel laten
// staan": doubt always resolves to keeping the file, never to removing it.
// KBT-F717 (hoofdagent-review) — PID reuse: the OS can hand the recorded pid to an unrelated,
// currently-running process after the original writer exited, making this return `true` for a
// process that is genuinely dead. That is the safe side of the error: it just leaves the file on
// disk one GC cycle longer than strictly necessary, never deletes a live session's file.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null; // unknown — never a deletion basis
  try {
    process.kill(pid, 0); // signal 0: probe only, sends nothing
    return true; // no throw → the OS confirms the process exists
  } catch (e) {
    if (e && e.code === 'ESRCH') return false; // no such process — definitively dead
    if (e && e.code === 'EPERM') return true; // exists, we just can't signal it — treat as alive
    return null; // any other failure — unknown, not a deletion basis
  }
}

function staleSessionFileCleanup() {
  const home = os.homedir();
  const ownPath = sessionFilePath();
  let candidates;
  try {
    candidates = sessionFileHelpers.listSessionFiles(home);
  } catch {
    return; // best-effort — a listing failure is not fatal
  }
  for (const name of candidates) {
    const full = path.join(home, name);
    if (full === ownPath) continue;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue; // unreadable/unparseable — doubt → leave it
    }
    if (isPidAlive(payload && payload.pid) === false) {
      try {
        fs.unlinkSync(full);
        process.stderr.write(
          `[kanbantic-proxy] removed stale session file ${name} (writer pid ${payload.pid} no longer exists)\n`
        );
      } catch {
        // Raced with another process removing/replacing it, or a permission blip — ignore.
      }
    }
    // isPidAlive() returning true or null → leave the file. A file with no
    // recorded pid at all (e.g. written by a future/older format) is also left.
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

// KBT-B470 — periodic session keep-alive so an idle spawned agent stays visible in
// /agent-sessions instead of being reaped by the backend stale-sweep after 300s.
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function sendHeartbeat() {
  if (!agentSessionId || shuttingDown) return;
  try {
    await callInternalTool('heartbeat', { sessionId: agentSessionId });
  } catch (e) {
    // Best-effort: a failed heartbeat (transient blip) must never crash the proxy — the next
    // tick retries. The stale-sweep only reaps after 300s, so occasional misses are tolerated.
    process.stderr.write(`[kanbantic-proxy] heartbeat failed (non-fatal): ${e.message}\n`);
  }
}

// --- room subscriptions -----------------------------------------------------

// KBT-F719 — resume without a gap or a replay after a proxy restart. The session file
// (KBT-F717, keyed by CLAUDE_CODE_SESSION_ID so it is STABLE across a crash-respawn of
// the same logical Claude Code session, not per proxy-process) already persists
// sessionId/channelId; this reads back whatever cursor a PREVIOUS instance of this same
// session last wrote for `channelId`, before falling back to "now" for a genuinely new
// subscription. Never throws — a missing/corrupt/mismatched file just means "no
// persisted cursor", the same as before this feature existed.
function loadPersistedCursor(channelId) {
  try {
    const raw = fs.readFileSync(sessionFilePath(), { encoding: 'utf8' });
    const payload = JSON.parse(raw);
    // Paranoia: only trust a cursor written by THIS session, matched by both ids —
    // a stale/foreign file must never seed a wrong channel's cursor.
    if (payload.sessionId !== agentSessionId) return null;
    const saved = payload.cursors && payload.cursors[channelId];
    if (!saved || typeof saved.at !== 'string') return null;
    return { at: saved.at, id: typeof saved.id === 'string' ? saved.id : null };
  } catch {
    return null; // no file, unreadable, or malformed — fall back to "now"
  }
}

function subscribeRoom(channelId, label, { home = false } = {}) {
  if (!channelId || typeof channelId !== 'string') {
    return { ok: false, reason: 'channelId is required' };
  }
  const existing = roomSubscriptions.get(channelId);
  if (existing) {
    if (label) existing.label = label;
    return { ok: true, alreadyJoined: true, channelId, label: existing.label };
  }
  if (roomSubscriptions.size >= MAX_ROOM_SUBSCRIPTIONS) {
    return {
      ok: false,
      reason: `already listening to ${MAX_ROOM_SUBSCRIPTIONS} rooms (spike cap) — leave one first`,
    };
  }
  // KBT-F719 — resume from a persisted cursor (proxy restart, same logical session) if
  // one exists; otherwise start at 'now' exactly as before (joining a room must never
  // replay its backlog into context — history stays reachable on demand via
  // get_channel_messages(before: ...)).
  const persisted = loadPersistedCursor(channelId);
  roomSubscriptions.set(channelId, {
    cursorAt: persisted ? persisted.at : new Date().toISOString(),
    cursorId: persisted ? persisted.id : null,
    label: label || (home ? 'home' : `room-${channelId.slice(0, 8)}`),
    home,
    failCount: 0,
    nextRetryAt: 0,
    archived: false,
  });
  if (persisted) {
    process.stderr.write(
      `[kanbantic-proxy] resuming channel ${channelId} from persisted cursor ${persisted.at} ` +
      `(no gap, no replay across the restart)\n`
    );
  }
  startInboxPoll();
  return { ok: true, alreadyJoined: false, channelId, label: roomSubscriptions.get(channelId).label };
}

function unsubscribeRoom(channelId) {
  const sub = roomSubscriptions.get(channelId);
  if (!sub) return { ok: false, reason: 'not listening to that room' };
  if (sub.home) {
    return { ok: false, reason: 'the home channel of this session cannot be left' };
  }
  roomSubscriptions.delete(channelId);
  return { ok: true, channelId, label: sub.label };
}

function listRooms() {
  return [...roomSubscriptions.entries()].map(([channelId, s]) => ({
    channelId,
    label: s.label,
    home: s.home,
    cursor: s.cursorAt, // wire-compat name; composite id half is internal (cursorId)
    archived: s.archived,
  }));
}

// --- proxy-local room tools -------------------------------------------------
//
// join_room / leave_room / list_rooms are answered by the proxy and never forwarded:
// the server has no Room entity, and subscribing is per-process state that no server
// call could hold anyway. Keeping them local is also what makes this spike deployable
// — it runs against production Kanbantic with no backend change and no migration.

const LOCAL_ROOM_TOOLS = {
  join_room: {
    description:
      'Start listening to another agent channel as a shared room. Messages posted there '
      + 'arrive in your context prefixed with the room label, alongside your own channel. '
      + 'Get channel ids from list_agents. Reply into a room with send_message(channelId). '
      + 'KBT-F720 chat-protocol: correlate every message with the issue code it concerns '
      + '(e.g. "[KBT-F123] ..."); cap agent-to-agent back-and-forth on one topic at 3 rounds '
      + 'without a human, then escalate (send_message + wait_for_user to a human, or set the '
      + 'issue Blocked) instead of continuing to negotiate.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'AgentChannel id to listen to.' },
        label: {
          type: 'string',
          description: 'Short name used to tag incoming messages, e.g. "KBT-B123".',
        },
      },
      required: ['channelId'],
    },
  },
  leave_room: {
    description: 'Stop listening to a room. Your own session channel cannot be left.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string' } },
      required: ['channelId'],
    },
  },
  list_rooms: {
    description: 'List the rooms this session is currently listening to.',
    inputSchema: { type: 'object', properties: {} },
  },
};

// Returns a JSON-RPC response when `msg` is a local room tool call, else null.
function handleLocalRoomTool(msg) {
  if (!msg || msg.method !== 'tools/call' || !msg.params) return null;
  const name = msg.params.name;
  if (!Object.prototype.hasOwnProperty.call(LOCAL_ROOM_TOOLS, name)) return null;

  const args = msg.params.arguments || {};
  let payload;
  if (name === 'join_room') payload = subscribeRoom(args.channelId, args.label);
  else if (name === 'leave_room') payload = unsubscribeRoom(args.channelId);
  else payload = { ok: true, rooms: listRooms() };

  const { ok, ...rest } = payload;
  return {
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ success: ok, ...rest }) }],
    },
  };
}

function injectRoomToolsIntoList(response) {
  const tools = response && response.result && response.result.tools;
  if (!Array.isArray(tools)) return;
  for (const [name, def] of Object.entries(LOCAL_ROOM_TOOLS)) {
    if (tools.some((t) => t && t.name === name)) continue;
    tools.push({ name, description: def.description, inputSchema: def.inputSchema });
  }
}

// --- inbox poll -------------------------------------------------------------

async function pollInbox() {
  if (shuttingDown || roomSubscriptions.size === 0) return;
  // KBT-F719 — overlap guard: a single tick must never start a second wave of
  // get_channel_messages calls while a previous tick (any one call of which can take up to
  // 120s — see callInternalTool/forward's timeout) is still in flight. Without this, the 1s
  // setInterval firing on schedule regardless of in-flight work is exactly what caused
  // duplicate delivery of the SAME message via overlapping polls.
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    // Snapshot the keys: a leave_room issued while an await is in flight must not be
    // undone by a drain that is still walking the old set.
    for (const channelId of [...roomSubscriptions.keys()]) {
      await pollRoom(channelId);
    }
  } finally {
    pollInFlight = false;
  }
}

// KBT-B1012 — Claude Code's notifications/claude/channel schema is `meta: Record<string, string>`.
// A null, boolean, number or nested value is "Invalid params" to Claude Code >= 2.1.277, and the
// error handler there closes the MCP connection. Keys are left as-is (identifiers already); values
// that are null/undefined are dropped rather than sent as "null", everything else becomes a string.
function channelMeta(fields) {
  const meta = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    meta[key] = typeof value === 'string' ? value : String(value);
  }
  return meta;
}

async function pollRoom(channelId) {
  const sub = roomSubscriptions.get(channelId);
  if (shuttingDown || !sub) return;
  if (sub.archived) return; // KBT-F719 — permanently ended channel (end_agent_session
  // archives it server-side, KBT-F721 finding); retrying forever would just burn a poll
  // slot and eventually re-log the same terminal error every tick.
  if (sub.nextRetryAt && Date.now() < sub.nextRetryAt) return; // backing off from a prior failure

  try {
    const result = await callInternalTool('get_channel_messages', {
      channelId,
      after: sub.cursorAt,
      afterId: sub.cursorId || undefined, // KBT-F719 — composite cursor tiebreak
      maxResults: 50,
    });

    if (!result || !result.success) {
      // KBT-F719 — a permanently archived channel (end_agent_session already ran) is a
      // terminal condition, not a transient failure: back off forever, once, with a clear
      // log line, instead of retrying every tick until the process exits.
      //
      // KBT-F726 (dead-code finding, KBT-T4610 cancelled) — as of today this branch is
      // UNREACHABLE against the real server: AgentChannelAppService.GetMessagesAsync (the
      // handler behind get_channel_messages) never checks channel.IsArchived and so never
      // raises `AgentChannel.Archived` — only the WRITE side (PostMessageAsync) does, as
      // part of the working Stale/Done archival distinction KBT-F722 built (do not remove
      // that). Reading a poll on an archived channel today just returns whatever messages
      // exist (or an empty page), never this error. Kept as defensive handling in case the
      // read side ever grows the same check — see KBT-T4610 for why that fix was not made
      // now — and covered by a unit test that exercises it via a mocked response, not a
      // real server round-trip.
      const msg = (result && result.errorMessage) || '';
      if (msg.includes('AgentChannel.Archived')) {
        sub.archived = true;
        process.stderr.write(
          `[kanbantic-proxy] channel ${channelId} (${sub.label}) is archived (session ended) — ` +
          `stopping polls for this room\n`
        );
        return;
      }
      recordPollFailure(sub, `get_channel_messages returned success=false: ${msg || '(no errorMessage)'}`, channelId);
      return;
    }

    // A successful call clears any prior backoff — the channel is reachable again.
    sub.failCount = 0;
    sub.nextRetryAt = 0;

    const messages = result.messages || [];
    if (messages.length === 0) return;

    let cursorAdvanced = false;
    // KBT-F723 — message-id's this poll-round successfully forwarded via notifications/
    // claude/channel, for the HOME channel only (see the batched ack below the loop).
    const deliveredMessageIds = [];
    for (const msg of messages) {
      // Re-read every iteration: the subscription can disappear mid-drain.
      const current = roomSubscriptions.get(channelId);
      if (!current || shuttingDown) return;

      // KBT-F719 (hoofdagent-review) — composite cursor: advance unconditionally to this
      // message, trusting the SERVER's order rather than re-deriving it here. `pollRoom`
      // always calls get_channel_messages with `after: sub.cursorAt` set (subscribeRoom
      // never leaves it unset), which is exclusively the ascending-(SentAt, Id) branch of
      // AgentChannelAppService.GetMessagesAsync — so `messages` already arrives in the
      // exact order the cursor must walk. Two comparison-based approaches were tried and
      // rejected here:
      //   - Comparing `sentAt` as strings (`msg.sentAt > current.cursorAt`) is fragile: the
      //     .NET side does not guarantee fixed fractional-second precision on
      //     serialization, so the identical instant can arrive as
      //     "...T03:00:00Z" vs "...T03:00:00.000Z" — those compare UNEQUAL, and in the
      //     wrong direction, as plain strings.
      //   - Re-deriving a tiebreak from `msg.id` on the JS side does not work either: the
      //     server's tiebreak is `Guid.CompareTo`, which does NOT sort a GUID's string
      //     form lexicographically. Comparing id strings here can advance the cursor to a
      //     message the server considers EARLIER in its own order, silently skipping
      //     whatever the server considers to sit between them.
      // Trusting iteration order sidesteps both: it never inspects sentAt's format or
      // reimplements Guid ordering, it just walks forward exactly as far as the server
      // already walked.
      current.cursorAt = msg.sentAt;
      current.cursorId = msg.id || null;
      cursorAdvanced = true;

      // KBT-F719 — dedup on message id. The overlap guard above should make this
      // unreachable in steady state, but a message can also legitimately be re-delivered
      // by the SERVER's own >= widening around an exact-timestamp tie (see
      // AgentChannelAppService.GetMessagesAsync) — this is the client-side backstop that
      // makes double-delivery impossible regardless of cause.
      if (msg.id && !rememberMessageId(msg.id)) continue;

      // Skip messages authored by the same session — those are our own outbound
      // posts coming back through the channel.
      if (msg.authorAgentSessionId && msg.authorAgentSessionId === agentSessionId) continue;

      // Room provenance goes in the content, not only in meta. Whether the model can
      // keep several concurrent rooms apart is the whole question this spike asks, and
      // meta is not guaranteed to reach it — so for a non-home room the origin is made
      // literal. The home channel keeps its exact current wire format.
      const content = current.home ? msg.content : `[${current.label}] ${msg.content}`;

      // KBT-F723 — only a message __sendImpl actually forwarded WITHOUT throwing counts
      // as "delivered". A synchronous stdout-write failure (e.g. EPIPE) must never be
      // reported to the server as delivered — that would tell the UI "afgeleverd" for a
      // push that never left this process. Best-effort: a send failure here must not
      // abort the rest of the poll-round (mirrors the heartbeat try/catch pattern).
      try {
        __sendImpl({
          jsonrpc: '2.0',
          method: 'notifications/claude/channel',
          params: {
            content,
            // KBT-B1012 — meta is Record<string, string> in Claude Code's channel schema
            // (channels-reference "Notification format"). Claude Code 2.1.277 validates that and
            // rejects the whole notification — then DROPS THE MCP CONNECTION — on any other value.
            // Measured on Kanbantic-Dev-03: "Invalid params ... meta.from_user: Invalid input,
            // meta.room_is_home: Invalid input" (a null and a boolean), after which the agent had
            // no Kanbantic tools at all. Older Claude versions let it through, which is why this
            // surfaced only now. channelMeta() drops null/undefined and stringifies the rest.
            meta: channelMeta({
              from_session: msg.authorAgentSessionId,
              from_user: msg.authorUserId,
              from_display_name: msg.authorDisplayName || 'Unknown',
              author_type: msg.authorType,
              message_type: msg.messageType,
              sent_at: msg.sentAt,
              message_id: msg.id,
              channel_id: msg.channelId,
              room_label: current.label,
              room_is_home: current.home,
            }),
          },
        });
        // KBT-F723 — only the HOME channel is this session's OWN channel; the server
        // rejects (harmlessly) an ack for a message in a room-channel it doesn't own
        // (SPIKE multi-room). Never batch those — there is nothing to gain from a call
        // that is guaranteed to land in RejectedMessageIds.
        if (current.home && msg.id) deliveredMessageIds.push(msg.id);
      } catch (e) {
        process.stderr.write(
          `[kanbantic-proxy] notify send failed for message ${msg.id} (non-fatal, not acked): ${e.message}\n`
        );
      }
    }

    // KBT-F719 — persist the advanced cursor so a proxy restart of this SAME logical
    // session resumes here instead of at 'now' (a gap) or at the old cursor (a replay).
    if (cursorAdvanced) writeSessionFile();

    // KBT-F723 — batched delivery-ack: report every message this poll-round actually
    // forwarded, ONE call per poll-round (not per message). Best-effort — a failed ack
    // must never crash the poll-loop; the next successful ack round for the SAME message
    // is a no-op server-side (idempotent), so nothing is lost, only delayed.
    if (deliveredMessageIds.length > 0 && agentSessionId) {
      try {
        await callInternalTool('acknowledge_channel_delivery', {
          sessionId: agentSessionId,
          messageIds: deliveredMessageIds.join(','),
        });
      } catch (e) {
        process.stderr.write(
          `[kanbantic-proxy] acknowledge_channel_delivery failed (non-fatal): ${e.message}\n`
        );
      }
    }
  } catch (e) {
    recordPollFailure(sub, e.message, channelId);
  }
}

// KBT-F719 — shared backoff-with-jitter bookkeeping for both the "tool call returned
// success=false" and the "tool call threw" paths. Never disables the room outright (only
// a confirmed AgentChannel.Archived does that) — a network blip must self-heal.
function recordPollFailure(sub, message, channelId) {
  sub.failCount = (sub.failCount || 0) + 1;
  sub.nextRetryAt = Date.now() + computeBackoffMs(sub.failCount);
  process.stderr.write(
    `[kanbantic-proxy] inbox-poll error (${channelId}), backing off ${sub.nextRetryAt - Date.now()}ms ` +
    `(failCount=${sub.failCount}): ${message}\n`
  );
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
  // KBT-B470 — go through __forwardImpl (defaults to forward) so callInternalTool is unit-testable
  // via setForwardForTest, matching the request-handling path. Production behaviour is unchanged.
  const responses = await __forwardImpl(body);
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
  stopHeartbeat(); // KBT-B470
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

if (require.main === module) {
  process.on('SIGINT', () => {
    process.stderr.write('[kanbantic-proxy] received SIGINT, shutting down\n');
    gracefulExit(0);
  });
  process.on('SIGTERM', () => {
    process.stderr.write('[kanbantic-proxy] received SIGTERM, shutting down\n');
    gracefulExit(0);
  });
}

// Exported for unit testing of the pure helpers (no runtime side effects on
// require — see the `require.main === module` guards above). KBT-F464.
module.exports = {
  channelMeta, // KBT-B1012
  resolveFilePathArgument,
  augmentToolsListResponse,
  parseToolResult,
  // KBT-B411 — exported for unit testing the filePath read confinement.
  screenFilePathRead,
  secretFileReason,
  MAX_FILEPATH_BYTES,
  // KBT-F551 — exported for testing the startup auto-register.
  shouldAutoRegister,
  autoRegister,
  // KBT-F722 — exported so a test can drive a real dispatch() call and inspect the ACTUAL
  // forwarded body, proving a mutation (e.g. attachClaudeCliSessionIdToRegisterCall) really
  // reaches bodyToForward instead of only exercising the attach-function in isolation
  // (the KBT-GTCH149-style trap: a mutation computed but never OR'd into bodyToForward).
  dispatch,
  setForwardForTest,
  __resetForTest,
  stopInboxPoll,
  // KBT-B470 — exported for testing the keep-alive heartbeat timer.
  startHeartbeat,
  stopHeartbeat,
  sendHeartbeat,
  __setSessionForTest,
  // SPIKE (multi-room) — exported for testing the room subscriptions + local tools.
  subscribeRoom,
  unsubscribeRoom,
  listRooms,
  handleLocalRoomTool,
  injectRoomToolsIntoList,
  pollInbox,
  setSendForTest,
  MAX_ROOM_SUBSCRIPTIONS,
  // KBT-F717 — exported for testing register-idempotency + end_agent_session scoping
  // + the per-session session-file.
  postProcess,
  handleRegisterAgentSessionShortCircuit,
  attachProcessTokenToRegisterCall,
  // KBT-F722 — exported for testing the automatic ClaudeCliSessionId injection (resume-reattach).
  attachClaudeCliSessionIdToRegisterCall,
  // KBT-F718 fast-follow — exported for testing the automatic fromSessionId injection.
  attachFromSessionIdToSendMessageCall,
  sessionFilePath,
  writeSessionFile,
  removeSessionFile,
  staleSessionFileCleanup,
  isPidAlive,
  __setFullSessionForTest,
  __getSessionForTest,
  __getProcessTokenForTest,
  // KBT-F719 — exported for testing overlap guard, dedup, backoff, archived-channel
  // handling, and cursor persistence/resume.
  pollRoom,
  computeBackoffMs,
  rememberMessageId,
  loadPersistedCursor,
  __isPollInFlightForTest: () => pollInFlight,
};
