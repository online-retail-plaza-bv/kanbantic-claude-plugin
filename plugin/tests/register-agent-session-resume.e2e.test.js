'use strict';

//
// KBT-F722 (KBT-SR624) — E2E: a freshly spawned REAL proxy process, driven by a model-invoked
// `register_agent_session` tools/call (NOT the auto-register path — KANBANTIC_WORKSPACE_ID is
// deliberately unset so autoRegister() never fires), must forward a body that carries
// `claudeCliSessionId`. This is the exact KBT-GTCH149-style trap the coordinator flagged: a
// mutation (attachClaudeCliSessionIdToRegisterCall) computed inside dispatch() but never OR'd
// into `bodyToForward` would pass every isolated unit test of the attach-function itself while
// silently never reaching the server. Same harness pattern as
// chat-protocol-join-room.e2e.test.js: spawn the real proxy binary against a stub HTTP backend
// and inspect what the backend ACTUALLY received.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');
const TEST_CLAUDE_SESSION_ID = 'kbt-f722-e2e-resume-session';

function startStubBackend(receivedBodies) {
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
      receivedBodies.push(msg);

      res.setHeader('Mcp-Session-Id', 'stub-session');
      res.setHeader('Content-Type', 'application/json');

      let result;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } };
      } else if (msg.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      } else if (msg.method === 'tools/call' && msg.params?.name === 'register_agent_session') {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: 'sess-e2e', channelId: 'chan-e2e' }) }] };
      } else {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'unhandled-by-stub' }) }] };
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function spawnProxy(port, homeDir) {
  const env = {
    ...process.env,
    KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    KANBANTIC_API_KEY: 'test-key',
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CODE_SESSION_ID: TEST_CLAUDE_SESSION_ID,
  };
  // Deliberately no KANBANTIC_WORKSPACE_ID — autoRegister() must NOT fire, so the only
  // register_agent_session call reaching the backend is the model-invoked one this test sends.
  delete env.KANBANTIC_WORKSPACE_ID;
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
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const t = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout (10s): ${method} (id=${id}). stderr: ${stderr}`));
        }
      }, 10000);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  return { child, rpc, getStderr: () => stderr };
}

test('KBT-F722 — a model-invoked register_agent_session call forwards claudeCliSessionId to the real server', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f722-resume-e2e-'));
  const receivedBodies = [];
  const stub = await startStubBackend(receivedBodies);
  const proxy = spawnProxy(stub.port, homeDir);

  try {
    await proxy.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kbt-f722-e2e', version: '1.0.0' },
    }, 1);

    // NOTE: arguments deliberately carry an explicit `processToken` so
    // attachProcessTokenToRegisterCall returns false (no mutation of its own) — isolating THIS
    // test's assertion to the claudeCliSessionId mutation alone. Without this, tokenAttached
    // would independently force JSON.stringify(msg) regardless of whether cliSessionIdAttached
    // is wired into the ternary, masking a regression in the exact line this test exists to guard.
    const registerResp = await proxy.rpc('tools/call', {
      name: 'register_agent_session',
      arguments: { workspaceId: 'ws-e2e', host: 'e2e-host', cwd: '/repo', processToken: 'caller-supplied-token' },
    }, 2);

    assert.ok(registerResp.result, `register call must succeed: ${JSON.stringify(registerResp)}`);

    const forwardedRegisterCall = receivedBodies.find(
      (b) => b.method === 'tools/call' && b.params?.name === 'register_agent_session'
    );
    assert.ok(forwardedRegisterCall, 'the stub backend must have received the forwarded register_agent_session call');

    // The actual assertion: the REAL server-received body — not just the in-process msg object —
    // carries claudeCliSessionId. This is what would silently regress if cliSessionIdAttached
    // were computed but left out of the bodyToForward ternary.
    assert.strictEqual(
      forwardedRegisterCall.params.arguments.claudeCliSessionId,
      TEST_CLAUDE_SESSION_ID,
      'the server-received body must carry claudeCliSessionId — proves the mutation reached bodyToForward, not just the in-memory msg object'
    );
  } finally {
    proxy.child.kill('SIGKILL');
    stub.server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('KBT-F722 — MUTATION CHECK baseline: without CLAUDE_CODE_SESSION_ID, no claudeCliSessionId is forwarded', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f722-resume-e2e-baseline-'));
  const receivedBodies = [];
  const stub = await startStubBackend(receivedBodies);

  const env = {
    ...process.env,
    KANBANTIC_MCP_URL: `http://127.0.0.1:${stub.port}/mcp`,
    KANBANTIC_API_KEY: 'test-key',
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
  delete env.KANBANTIC_WORKSPACE_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
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
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  function rpc(method, params, id) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } }, 1);
    await rpc('tools/call', { name: 'register_agent_session', arguments: { workspaceId: 'ws-e2e', host: 'e2e-host', cwd: '/repo' } }, 2);

    const forwardedRegisterCall = receivedBodies.find(
      (b) => b.method === 'tools/call' && b.params?.name === 'register_agent_session'
    );
    assert.ok(forwardedRegisterCall, 'the stub backend must have received the forwarded register_agent_session call');
    assert.ok(
      !('claudeCliSessionId' in forwardedRegisterCall.params.arguments),
      'without CLAUDE_CODE_SESSION_ID, no claudeCliSessionId key should be forwarded at all'
    );
  } finally {
    child.kill('SIGKILL');
    stub.server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
