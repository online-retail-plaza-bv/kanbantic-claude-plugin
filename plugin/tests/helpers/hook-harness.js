'use strict';

//
// hook-harness.js — KBT-F741 / KBT-T5188
//
// Shared test helpers for the session-state hooks: an API stub that records
// every request, and a runner that spawns a hook script as a real child
// process with a stdin payload. Node built-ins only.
//
// The environment handed to the child is scrubbed first: a developer machine
// (and CI inside a Claude session) has KANBANTIC_* / CLAUDE_CODE_SESSION_ID in
// its environment, and a test that silently inherits them would read the
// developer's real session file or talk to the real API.
//

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOOKS_DIR = path.resolve(__dirname, '..', '..', 'hooks');

const SCRUBBED = [
  'KANBANTIC_API_KEY', 'KANBANTIC_API_URL', 'KANBANTIC_MCP_URL', 'KANBANTIC_SESSION_FILE',
  'KANBANTIC_ALLOWLIST_FILE', 'KANBANTIC_HOOK_STATE_DIR', 'KANBANTIC_SYNC_DEBUG',
  'KANBANTIC_WORKSPACE_ID', 'CLAUDE_CODE_SESSION_ID', 'ROUTER_MUTATION',
];

function mkTmp(prefix = 'kbt-f741-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Local API stub. `respond(call)` may return { status, body }, or { hang: true }
 * to never answer (KBT-F742: the router's 5 s time-out on the decision-create).
 * Hung sockets are destroyed when the stub closes.
 */
function startApiStub(respond) {
  const calls = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = raw; }
      const call = { method: req.method, url: req.url, headers: req.headers, body, raw };
      calls.push(call);
      const out = (respond && respond(call)) || { status: 200, body: {} };
      if (out.hang) return; // never answered — the client has to time out
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body === undefined ? {} : out.body));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        calls,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

/** A port nothing listens on. */
function closedPort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Spawn `node <script> [args]` with `stdin` (string | object | undefined).
 * Async spawn on purpose: the API stub lives in this process.
 */
function runScript(script, { stdin, args = [], env = {}, cwd, timeoutMs = 30000 } = {}) {
  const base = { ...process.env };
  for (const k of SCRUBBED) delete base[k];
  const file = path.isAbsolute(script) ? script : path.join(HOOKS_DIR, script);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd,
      env: { ...base, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const guard = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (status, signal) => {
      clearTimeout(guard);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

/** Write a session file the way the proxy does and return its path. */
function writeSessionFile(dir, extra = {}) {
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify({
    sessionId: 'SESS-1',
    channelId: 'CHAN-1',
    claudeCliSessionId: 's1',
    apiUrl: 'http://127.0.0.1:1',
    writtenAt: new Date().toISOString(),
    pid: process.pid,
    cursors: {},
    ...extra,
  }), 'utf8');
  return file;
}

/** Standard env for a hook run against `stub`. */
function hookEnv(dir, stub, extra = {}) {
  return {
    HOME: dir,
    USERPROFILE: dir,
    KANBANTIC_API_URL: stub ? stub.url : 'http://127.0.0.1:1',
    KANBANTIC_API_KEY: 'test',
    KANBANTIC_SESSION_FILE: path.join(dir, 'session.json'),
    KANBANTIC_HOOK_STATE_DIR: path.join(dir, 'state'),
    ...extra,
  };
}

module.exports = {
  HOOKS_DIR, mkTmp, rmTmp, startApiStub, closedPort, runScript, writeSessionFile, hookEnv,
};
