'use strict';

//
// session-api.js — KBT-F741 / KBT-T5188 (spec KBT-SR637, SEC063 §1 + §5)
//
// Shared helper for the session-state hooks (Notification, PermissionRequest,
// PreToolUse/PostToolUse tool-activity, UserPromptSubmit turn-start, Stop idle).
//
// Why a REST client here and not the MCP proxy: while Claude Code waits on a
// permission question the model — and with it the MCP-proxy round-trip — is not
// reachable, which is exactly the moment a hang has to be reported. Hooks talk
// to the Kanbantic REST API directly with the API key.
//
// ── Fail-open is the contract ──────────────────────────────────────────────
// A monitoring hook must never wedge a session on its own malfunction. Every
// failure (no session file, no key, network, non-2xx, 5 s timeout, broken
// stdin) ends in exit 0 with empty stdout. `runHook()` enforces that for the
// simple scripts; the PermissionRequest router uses the pieces directly.
//
// ── Secrets (SEC063 §1 / §5) ───────────────────────────────────────────────
// - Free text that leaves the machine (commands, notification text, the last
//   assistant message) goes through `redactText()` first.
// - `debug()` (KANBANTIC_SYNC_DEBUG=1) writes skip-reasons only: never the API
//   key, never the session-file contents or path, never the payload.
//
// Zero deps — Node built-ins plus this plugin's own scripts.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const { resolveExistingSessionFile } = require('../../proxy/session-file');
const { resolveApiKey } = require('../../scripts/mcp-toolkit-fetch.js');

const PREFIX = '[kanbantic-session-hook]';
const DEFAULT_BASE_URL = 'https://kanbantic.com';
const DEFAULT_TIMEOUT_MS = 5000;
const STDIN_TIMEOUT_MS = 3000;

// ── diagnostics ─────────────────────────────────────────────────────────────

/** Skip-reason on stderr, only with KANBANTIC_SYNC_DEBUG. Never changes the exit code. */
function debug(reason, err) {
  if (!process.env.KANBANTIC_SYNC_DEBUG) return;
  const detail = err && err.message ? `: ${String(err.message).slice(0, 200)}` : '';
  try {
    process.stderr.write(`${PREFIX} skipped — ${reason}${detail}\n`);
  } catch (_) { /* best effort */ }
}

// ── stdin ───────────────────────────────────────────────────────────────────

function readStdin(timeoutMs = STDIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(data); } };
    const t = setTimeout(finish, timeoutMs);
    if (typeof t.unref === 'function') t.unref();
    if (process.stdin.isTTY) return finish();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/** The hook payload as a plain object, or null for anything else. */
function parsePayload(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

// ── session file / base URL ─────────────────────────────────────────────────

function homeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

/** A session id that is safe to use as a file-name component. */
function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null;
}

/** The Claude session this hook runs in: env first, then the payload's session_id. */
function claudeSessionId(payload, env = process.env) {
  return safeId(env.CLAUDE_CODE_SESSION_ID) || safeId(payload && payload.session_id);
}

/**
 * Path of this session's session file, or null.
 * `KANBANTIC_SESSION_FILE` (tests) wins; otherwise the shared fail-closed
 * resolver. The payload's `session_id` equals CLAUDE_CODE_SESSION_ID and is used
 * when the env var is missing.
 */
function resolveSessionFilePath(payload, env = process.env) {
  if (env.KANBANTIC_SESSION_FILE) return env.KANBANTIC_SESSION_FILE;
  const e = { ...env };
  const sid = claudeSessionId(payload, env);
  if (sid) e.CLAUDE_CODE_SESSION_ID = sid;
  return resolveExistingSessionFile(homeDir(env), e).path;
}

function readJsonOrNull(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch (_) {
    return null;
  }
}

/**
 * Strip a trailing slash and a trailing /api — on some workstations
 * KANBANTIC_API_URL is `https://kanbantic.com/api`, and the routes below already
 * start with /api/app/….
 */
function normalizeBaseUrl(url) {
  let u = typeof url === 'string' ? url.trim() : '';
  if (!u) return DEFAULT_BASE_URL;
  u = u.replace(/\/+$/, '').replace(/\/api$/i, '').replace(/\/+$/, '');
  return u || DEFAULT_BASE_URL;
}

/**
 * Everything a hook needs to talk to the API, or null (with a debug reason).
 * `{ sessionId, channelId, baseUrl, apiKey, session, sessionFile }`
 */
function loadContext(payload, env = process.env) {
  const sessionFile = resolveSessionFilePath(payload, env);
  if (!sessionFile) { debug('no session file resolved'); return null; }
  const session = readJsonOrNull(sessionFile);
  if (!session) { debug('session file missing or unreadable'); return null; }
  if (typeof session.sessionId !== 'string' || !session.sessionId) {
    debug('session file has no sessionId');
    return null;
  }
  const apiKey = resolveApiKey(env);
  if (!apiKey) { debug('no API key configured'); return null; }
  return {
    sessionId: session.sessionId,
    channelId: typeof session.channelId === 'string' && session.channelId ? session.channelId : null,
    baseUrl: normalizeBaseUrl(env.KANBANTIC_API_URL || session.apiUrl),
    apiKey,
    session,
    sessionFile,
  };
}

const sessionRoute = (ctx, action) =>
  `/api/app/agent-session/${encodeURIComponent(ctx.sessionId)}/${action}`;

// Verified against the monorepo integration tests: POST /api/app/agent-channel/message/{channelId}.
const channelMessageRoute = (ctx) =>
  `/api/app/agent-channel/message/${encodeURIComponent(ctx.channelId)}`;

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * POST JSON to `ctx.baseUrl + route`. Resolves `{ status }` for 2xx; rejects for
 * anything else (network, timeout, non-2xx). The error message never contains
 * the API key or the body.
 */
function postJson(ctx, route, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(ctx.baseUrl + route);
    } catch (_) {
      return reject(new Error('invalid API url'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new Error('unsupported API url scheme'));
    }
    const payload = JSON.stringify(body == null ? {} : body);
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Api-Key': ctx.apiKey,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) settle(resolve, { status: res.statusCode });
          else settle(reject, new Error(`HTTP ${res.statusCode}`));
        });
        res.on('error', (e) => settle(reject, e));
      }
    );
    // One overall deadline, not just an idle timeout: a server that drips bytes
    // must not be able to hold a hook open.
    const timer = setTimeout(() => req.destroy(new Error('request timed out')), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    req.on('error', (e) => settle(reject, e));
    req.end(payload);
  });
}

// ── redaction (SEC063 §1) ───────────────────────────────────────────────────

const SENSITIVE = '(?:token|secret|password|passwd|api[_-]?key|authorization|bearer)';
const SENSITIVE_KEY_RE = new RegExp(SENSITIVE, 'i');

// "Bearer <x>" anywhere.
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// --password foo / --api-key=foo / -token foo
const FLAG_RE = new RegExp(
  `(--?[\\w-]*${SENSITIVE}[\\w-]*)(=|\\s+)(?!-)("[^"]*"|'[^']*'|[^\\s"']+)`, 'gi'
);
// key=value / key: value / "key": "value" — also swallows a "Bearer " scheme in the value.
const KV_RE = new RegExp(
  `([\\w-]*${SENSITIVE}[\\w-]*)(["']?\\s*[=:]\\s*)(?:(?:Bearer|Basic)\\s+)?("[^"]*"|'[^']*'|[^\\s,;&"']+)`, 'gi'
);
// Well-known credential shapes that carry no keyword next to them.
const KNOWN_TOKEN_RE = new RegExp(
  [
    '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}',
    '\\bgithub_pat_[A-Za-z0-9_]{20,}',
    '\\bsk-[A-Za-z0-9_-]{16,}',
    '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
    '\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}',
  ].join('|'),
  'g'
);

/** Mask secrets in free text. Never throws; non-strings become ''. */
function redactText(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(BEARER_RE, 'Bearer ***')
    .replace(FLAG_RE, '$1$2***')
    .replace(KV_RE, '$1$2***')
    .replace(KNOWN_TOKEN_RE, '***');
}

/** Deep copy with the values of sensitive keys masked and every string redacted. */
function redactObject(value, depth = 0) {
  if (depth > 8) return '***';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '***' : redactObject(v, depth + 1);
    }
    return out;
  }
  return value;
}

function truncate(text, max) {
  const s = typeof text === 'string' ? text : '';
  return s.length > max ? s.slice(0, max) : s;
}

const BULKY_KEYS = new Set(['content', 'new_string', 'old_string', 'new_source', 'prompt']);

/**
 * One-line, redacted, length-capped description of a tool call's input for the
 * "waiting for permission" prompt. Redaction runs BEFORE truncation so a cut can
 * never split a secret into an unrecognisable (and therefore unmasked) fragment.
 */
function summarizeToolInput(toolName, input, max = 500) {
  if (typeof input === 'string') return truncate(redactText(input), max);
  if (!input || typeof input !== 'object') return '';
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return truncate(redactText(input.command), max);
  }
  const shallow = {};
  for (const [k, v] of Object.entries(input)) {
    shallow[k] = BULKY_KEYS.has(k) && typeof v === 'string' && v.length > 80 ? `[${v.length} chars]` : v;
  }
  let json;
  try { json = JSON.stringify(redactObject(shallow)); } catch (_) { json = ''; }
  return truncate(redactText(json), max);
}

// ── hook runner ─────────────────────────────────────────────────────────────

function exit0() { process.exit(0); }

/**
 * Run `handler(payload, ctx)` as a fail-open hook. A missing context (no
 * session file / no key) or a broken payload ends quietly; so does any throw.
 */
async function runHook(handler, { needContext = true } = {}) {
  process.on('unhandledRejection', exit0);
  process.on('uncaughtException', exit0);
  try {
    const payload = parsePayload(await readStdin());
    if (!payload) { debug('empty or unparseable hook payload'); return exit0(); }
    const ctx = loadContext(payload);
    if (!ctx && needContext) return exit0();
    await handler(payload, ctx);
  } catch (err) {
    debug('unexpected error', err);
  }
  exit0();
}

/** Post and swallow any failure into a debug line. Resolves true on 2xx. */
async function postQuietly(ctx, route, body, label) {
  try {
    await postJson(ctx, route, body);
    return true;
  } catch (err) {
    debug(`${label} failed`, err);
    return false;
  }
}

module.exports = {
  PREFIX,
  DEFAULT_BASE_URL,
  debug,
  readStdin,
  parsePayload,
  homeDir,
  safeId,
  claudeSessionId,
  resolveSessionFilePath,
  readJsonOrNull,
  normalizeBaseUrl,
  loadContext,
  sessionRoute,
  channelMessageRoute,
  postJson,
  postQuietly,
  redactText,
  redactObject,
  truncate,
  summarizeToolInput,
  runHook,
};
