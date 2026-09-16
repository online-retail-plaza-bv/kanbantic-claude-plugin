'use strict';

//
// KBT-F723 (KBT-TC3727) — E2E: a freshly spawned REAL proxy process, registered against a
// stub HTTP backend, must (1) push an incoming channel message to the host via
// notifications/claude/channel from its OWN 1s inbox-poll-loop, and (2) report that
// message-id back to the server via acknowledge_channel_delivery — proving the full
// internal chain proxy-poll -> notify -> ack -> HTTP, not just the isolated pollRoom() unit
// (see proxy-delivery-ack.test.js for that). Same harness pattern as
// register-agent-session-resume.e2e.test.js / chat-protocol-join-room.e2e.test.js: spawn the
// real proxy binary against a stub HTTP backend and inspect what it actually sent/received.
//
// register_agent_session's success path auto-subscribes the home channel and starts the
// inbox-poll + heartbeat timers (kanbantic-mcp-proxy.js ~line 354) — no extra join_room call
// is needed for the poll loop to run.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');

function startStubBackend(receivedBodies, cannedMessage) {
  let servedMessages = false;
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
      const toolName = msg.method === 'tools/call' ? msg.params?.name : null;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } };
      } else if (msg.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      } else if (toolName === 'register_agent_session') {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: 'sess-e2e-723', channelId: 'chan-e2e-723' }) }] };
      } else if (toolName === 'get_channel_messages') {
        // KBT-F723 — the FIRST poll tick sees the canned message; every later tick sees an
        // empty inbox, exactly like a real server after the cursor has advanced past it.
        const messages = servedMessages ? [] : [cannedMessage];
        servedMessages = true;
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true, messages }) }] };
      } else if (toolName === 'acknowledge_channel_delivery') {
        const ids = (msg.params.arguments.messageIds || '').split(',');
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true, newlyDeliveredMessageIds: ids }) }] };
      } else if (toolName === 'heartbeat') {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
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
  };
  delete env.KANBANTIC_WORKSPACE_ID; // no auto-register — this test drives register explicitly
  const child = spawn(process.execPath, [PROXY_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const pending = new Map();
  const notifications = [];
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
      if (msg.method === 'notifications/claude/channel') {
        notifications.push(msg);
        continue;
      }
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

  return { child, rpc, notifications, getStderr: () => stderr };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('KBT-F723 — real proxy: an incoming message is pushed via notify AND acknowledged to the server within one poll cycle', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f723-ack-e2e-'));
  const receivedBodies = [];
  const cannedMessage = {
    id: 'msg-e2e-1',
    channelId: 'chan-e2e-723',
    content: 'hallo vanuit de e2e-stub',
    authorAgentSessionId: 'other-session-e2e',
    authorUserId: null,
    authorDisplayName: 'Reviewer',
    authorType: 'AgentSession',
    messageType: 'Chat',
    sentAt: new Date().toISOString(),
  };
  const stub = await startStubBackend(receivedBodies, cannedMessage);
  const proxy = spawnProxy(stub.port, homeDir);

  try {
    await proxy.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kbt-f723-e2e', version: '1.0.0' },
    }, 1);

    const registerResp = await proxy.rpc('tools/call', {
      name: 'register_agent_session',
      arguments: { workspaceId: 'ws-e2e-723', host: 'e2e-host', cwd: '/repo' },
    }, 2);
    assert.ok(registerResp.result, `register call must succeed: ${JSON.stringify(registerResp)}`);

    // The inbox-poll ticks every 1s (INBOX_POLL_INTERVAL_MS) — give it up to 3 ticks
    // (well inside the Feature's own "binnen 3s" acceptance criterion) to see the canned
    // message, push it, and report the ack back.
    let ackCall = null;
    for (let i = 0; i < 30 && !ackCall; i++) {
      await sleep(100);
      ackCall = receivedBodies.find(
        (b) => b.method === 'tools/call' && b.params?.name === 'acknowledge_channel_delivery'
      );
    }

    // 1. The message was actually pushed to the host process.
    assert.equal(proxy.notifications.length, 1, `expected exactly one notify push: ${JSON.stringify(proxy.notifications)}`);
    assert.equal(proxy.notifications[0].params.meta.message_id, 'msg-e2e-1');

    // 2. The proxy reported that delivery back to the REAL (stub) server — this is the
    // assertion that would fail if acknowledge_channel_delivery were only called on the
    // in-process pollRoom() path and never actually reached bodyToForward/HTTP.
    assert.ok(ackCall, `acknowledge_channel_delivery must have reached the server within 3s: stderr=${proxy.getStderr()}`);
    assert.equal(ackCall.params.arguments.sessionId, 'sess-e2e-723');
    assert.equal(ackCall.params.arguments.messageIds, 'msg-e2e-1');
  } finally {
    proxy.child.kill('SIGKILL');
    stub.server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
