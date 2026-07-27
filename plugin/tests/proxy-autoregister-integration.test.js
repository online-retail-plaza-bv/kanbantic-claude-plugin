'use strict';

//
// KBT-F551 — startup auto-register, integration level (KBT-TC3130 … KBT-TC3133).
//
// These spawn the REAL proxy against a local stub MCP backend and drive it over
// stdio, because that is what the test cases specify: the trigger under test is
// the `initialize` handshake, not the autoRegister() function. The sibling file
// proxy-autoregister.test.js covers the guard/function at unit level; this file
// covers the wiring — that an initialize actually fires the registration, once,
// with the right payload, and that failure never takes the proxy down.
//
// Env isolation: the spawned proxy inherits process.env, and this dev machine
// carries a real KANBANTIC_API_KEY. Every spawn therefore passes an explicit env
// and deletes the auto-register vars it does not want, so a test can never read
// the developer's machine config (the failure mode of KBT-B438).
//
// Zero deps — node:test, node:assert/strict, node:http, node:path, node:child_process.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');

// ---------------------------------------------------------------------------
// Stub MCP backend. Records every request; can be told to fail register_agent_session
// with a given HTTP status so the 403 path (TC3133) is exercised for real.
// ---------------------------------------------------------------------------

function startStubBackend({ registerStatus = 200 } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end('bad json');
        return;
      }
      received.push({ method: msg.method, params: msg.params, id: msg.id });

      const toolName = msg.params && msg.params.name;

      // register_agent_session failure path (TC3133) — answer before any headers
      // so the proxy sees a genuine non-2xx from the transport.
      if (toolName === 'register_agent_session' && registerStatus !== 200) {
        res.statusCode = registerStatus;
        res.end('Forbidden');
        return;
      }

      res.setHeader('Mcp-Session-Id', req.headers['mcp-session-id'] || 'stub-session');
      res.setHeader('Content-Type', 'application/json');

      let result;
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub', version: '1.0.0' },
        };
      } else if (msg.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      } else if (toolName === 'register_agent_session') {
        result = jsonContent({ success: true, sessionId: 's1', channelId: 'c1' });
      } else if (toolName === 'get_channel_messages') {
        result = jsonContent({ success: true, messages: [] });
      } else {
        result = jsonContent({ success: true, echo: toolName || msg.method });
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

function jsonContent(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function registerCalls(received) {
  return received.filter(
    (r) => r.method === 'tools/call' && r.params && r.params.name === 'register_agent_session'
  );
}

// ---------------------------------------------------------------------------
// Proxy harness — spawn the real proxy; rpc() writes a line on stdin and
// resolves with the matching response from stdout.
// ---------------------------------------------------------------------------

function spawnProxy(port, autoRegisterEnv = {}) {
  const env = {
    ...process.env,
    KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    KANBANTIC_API_KEY: 'test-key',
  };
  // Never inherit the developer's auto-register context — set it explicitly or not at all.
  for (const key of [
    'KANBANTIC_WORKSPACE_ID',
    'KANBANTIC_WORKSTATION_ID',
    'KANBANTIC_HOST',
    'KANBANTIC_SPAWN_COMMAND_ID',
  ]) {
    delete env[key];
  }
  Object.assign(env, autoRegisterEnv);

  const child = spawn(process.execPath, [PROXY_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  function rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const t = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method} (id=${id}). stderr: ${stderr}`));
        }
      }, 10000);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  async function shutdown() {
    child.stdin.end();
    await exitPromise;
  }

  return { child, rpc, shutdown, getStderr: () => stderr };
}

const INIT_PARAMS = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test', version: '1.0.0' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Auto-register is fire-and-forget off the initialize response, so poll for the
// effect instead of guessing a fixed delay.
async function waitFor(predicate, { timeout = 8000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(interval);
  }
  return false;
}

// ---------------------------------------------------------------------------
// KBT-TC3130 — auto-register fires on initialize when the daemon context is present
// ---------------------------------------------------------------------------

test('TC3130: initialize triggers exactly one register_agent_session with the daemon context', async () => {
  const stub = await startStubBackend();
  const proxy = spawnProxy(stub.port, {
    KANBANTIC_WORKSPACE_ID: 'ws-1',
    KANBANTIC_WORKSTATION_ID: 'st-1',
    KANBANTIC_SPAWN_COMMAND_ID: 'cmd-1',
    KANBANTIC_HOST: 'test-host',
  });

  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);

    const fired = await waitFor(() => registerCalls(stub.received).length >= 1);
    assert.ok(fired, `no register call fired. stderr: ${proxy.getStderr()}`);

    const calls = registerCalls(stub.received);
    assert.equal(calls.length, 1, 'exactly one register call');

    const args = calls[0].params.arguments;
    assert.equal(args.workspaceId, 'ws-1');
    assert.equal(args.workstationId, 'st-1');
    assert.equal(args.spawnCommandId, 'cmd-1', 'spawnCommandId forwarded so F3 can correlate');
    assert.equal(args.host, 'test-host');
    assert.ok(args.cwd, 'cwd reported');

    // The response is routed through postProcess(), so the capture + inbox-poll
    // must engage exactly as on a manual register: a poll proves both.
    const polled = await waitFor(() =>
      stub.received.some((r) => r.params && r.params.name === 'get_channel_messages')
    );
    assert.ok(polled, `inbox-poll did not start (sessionId/channelId not captured). stderr: ${proxy.getStderr()}`);
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});

// ---------------------------------------------------------------------------
// KBT-TC3131 — backward compatibility: no workspace-id, no auto-register
// ---------------------------------------------------------------------------

test('TC3131: without KANBANTIC_WORKSPACE_ID nothing registers and other tools keep working', async () => {
  const stub = await startStubBackend();
  const proxy = spawnProxy(stub.port); // no auto-register env at all

  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);

    // A normal tool-call must still work — the guard may not break the proxy.
    const res = await proxy.rpc('tools/call', { name: 'list_issues', arguments: {} }, 2);
    assert.ok(res.result, 'ordinary tool-call still answered');

    // Given the round-trip above completed, a register (fired off initialize)
    // would already be visible.
    assert.equal(registerCalls(stub.received).length, 0, 'no register_agent_session sent');
    assert.ok(
      !stub.received.some((r) => r.params && r.params.name === 'get_channel_messages'),
      'no inbox-poll started'
    );
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});

// ---------------------------------------------------------------------------
// KBT-TC3132 — idempotency across repeated initialize
// ---------------------------------------------------------------------------

test('TC3132: a second initialize does not register again', async () => {
  const stub = await startStubBackend();
  const proxy = spawnProxy(stub.port, { KANBANTIC_WORKSPACE_ID: 'ws-1' });

  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);
    assert.ok(await waitFor(() => registerCalls(stub.received).length >= 1), 'first register fired');

    await proxy.rpc('initialize', INIT_PARAMS, 2);
    await sleep(500); // give a (wrongly) re-fired register time to show up

    assert.equal(registerCalls(stub.received).length, 1, 'still exactly one register call');
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});

// ---------------------------------------------------------------------------
// KBT-TC3133 — a 403 on register is logged, retried finitely, and never fatal
// ---------------------------------------------------------------------------

test('TC3133: register 403 is logged with a clear hint, retried, and the proxy survives', async () => {
  const stub = await startStubBackend({ registerStatus: 403 });
  const proxy = spawnProxy(stub.port, { KANBANTIC_WORKSPACE_ID: 'ws-1' });

  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);

    // Finite retry: 3 attempts with 1s/2s backoff between them.
    const retried = await waitFor(() => registerCalls(stub.received).length >= 3, { timeout: 12000 });
    assert.ok(retried, `expected 3 attempts, saw ${registerCalls(stub.received).length}`);

    await sleep(500);
    assert.equal(registerCalls(stub.received).length, 3, 'stops after 3 — no infinite retry');

    const stderr = proxy.getStderr();
    assert.match(stderr, /403/, 'the 403 is surfaced');
    assert.match(stderr, /KANBANTIC_API_KEY/, 'operator gets an actionable hint');
    assert.match(stderr, /gave up after 3 attempts/, 'gives up loudly rather than silently');

    // The whole point: a failed register must not take the proxy with it.
    const res = await proxy.rpc('tools/call', { name: 'list_issues', arguments: {} }, 2);
    assert.ok(res.result, 'tool-calls still work after a failed auto-register');
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});
