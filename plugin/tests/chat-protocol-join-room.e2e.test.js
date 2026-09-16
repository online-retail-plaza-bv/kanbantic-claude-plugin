'use strict';

//
// KBT-F720 (KBT-TC3713) — E2E: a freshly spawned REAL proxy process serves the
// chat-protocol correlation/escalation guidance on the `join_room` local room-tool
// description (LOCAL_ROOM_TOOLS in kanbantic-mcp-proxy.js). This proves the runtime
// artifact a client actually reads (tools/list over the live process), not just the
// source file — same harness pattern as session-survives-issue-completion.e2e.test.js /
// proxy-signal-cleanup.e2e.test.js: spawn the real proxy binary against a stub HTTP
// MCP backend.
//
// It also pins the existing `experimental['claude/channel']` capability declaration on
// `initialize` as an unconditional regression-guard (KBT-F720 must not change that
// unconditional-declare behavior, per the "no direct flag-detection signal" finding in
// Toolkit Rule KBT-TRUL041 Section 4).
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');
const TEST_CLAUDE_SESSION_ID = 'kbt-f720-e2e-join-room-session';

function startStubBackend() {
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

      res.setHeader('Mcp-Session-Id', 'stub-session');
      res.setHeader('Content-Type', 'application/json');

      let result;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } };
      } else if (msg.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      } else if (msg.method === 'tools/list') {
        // Minimal upstream tool list — the proxy appends LOCAL_ROOM_TOOLS on top of this.
        result = { tools: [{ name: 'get_channel_messages', description: 'stub', inputSchema: { type: 'object', properties: {} } }] };
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

test('KBT-TC3713 — a freshly spawned proxy serves the enriched join_room description + unconditional claude/channel capability', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f720-join-room-e2e-'));
  const stub = await startStubBackend();
  const proxy = spawnProxy(stub.port, homeDir);

  try {
    const initResp = await proxy.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kbt-f720-e2e', version: '1.0.0' },
    }, 1);

    // Regression-guard: unconditional capability declaration, unchanged by KBT-F720.
    assert.ok(
      initResp.result?.capabilities?.experimental?.['claude/channel'],
      'experimental["claude/channel"] must still be declared unconditionally on initialize'
    );

    const listResp = await proxy.rpc('tools/list', {}, 2);
    const tools = listResp.result?.tools || [];
    const joinRoom = tools.find((t) => t.name === 'join_room');

    assert.ok(joinRoom, 'join_room must be injected into tools/list by the live proxy process');
    assert.match(
      joinRoom.description,
      /issue code/i,
      'join_room description must carry the KBT-F720 issue-code correlation guidance'
    );
    assert.match(
      joinRoom.description,
      /3 rounds/i,
      'join_room description must carry the KBT-F720 max-3-rounds escalation guidance'
    );
  } finally {
    proxy.child.kill('SIGKILL');
    stub.server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
