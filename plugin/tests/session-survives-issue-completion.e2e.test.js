'use strict';

//
// KBT-F717 (KBT-TC3685) — E2E: a session that finishes an issue via report_status(Idle) +
// set_current_issue(null) — NOT end_agent_session — still receives a channel message within 2s.
//
// This is the literal acceptance criterion from the issue: "Een sessie die een volledige
// lane-skill doorloopt, ontvangt daarna nog steeds binnen 2s een bericht dat een gebruiker in
// zijn channel post." Spawns the REAL proxy binary against a local stub MCP backend (same
// harness style as proxy-signal-cleanup.e2e.test.js) — a mock backend, not the shared
// ClaudeAgent key (KBT-F718 is out of scope for F717; delivery is proven end-to-end here without
// touching that separate self-post-attribution problem).
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { sessionFilePath: computeSessionFilePath } = require('../proxy/session-file');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');
const TEST_CLAUDE_SESSION_ID = 'kbt-f717-e2e-completion-session';

// ---------------------------------------------------------------------------
// Stub MCP backend — a mutable message queue lets the test "post a message"
// mid-run by pushing into it; the proxy's 1s inbox-poll picks it up on its own.
// ---------------------------------------------------------------------------
function startStubBackend() {
  const received = [];
  const pendingMessages = []; // messages not yet handed to the proxy via get_channel_messages
  let cursor = 0;

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
        result = {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            sessionId: 'agent-session-completion-e2e',
            channelId: 'agent-channel-completion-e2e',
          }) }],
        };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'get_channel_messages') {
        // Hand out every pending message once, tagging a monotonically increasing sentAt so the
        // proxy's cursor advances and never re-delivers the same message.
        const batch = pendingMessages.splice(0, pendingMessages.length).map((m, i) => ({
          id: `msg-${cursor + i}`,
          content: m.content,
          sentAt: new Date(Date.now() + i).toISOString(),
          authorType: 'User',
          authorDisplayName: 'Test User',
          messageType: 'Text',
          channelId: 'agent-channel-completion-e2e',
        }));
        cursor += batch.length;
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true, messages: batch }) }] };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'report_status') {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'set_current_issue') {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'end_agent_session') {
        // The whole point of this test is that this must NEVER be called mid-test.
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'heartbeat') {
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
      resolve({
        server,
        port,
        received,
        postMessage: (content) => pendingMessages.push({ content }),
      });
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
      } else if (msg.id != null && pending.has(msg.id)) {
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

test('KBT-TC3685 — chat survives report_status(Idle)+set_current_issue(null): message arrives within 2s, no end_agent_session', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f717-completion-e2e-'));
  const stub = await startStubBackend();
  const proxy = spawnProxy(stub.port, homeDir);

  try {
    await proxy.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kbt-f717-e2e', version: '1.0.0' },
    }, 1);

    const regResp = await proxy.rpc('tools/call', {
      name: 'register_agent_session', arguments: { workspaceId: 'ws-1', host: 'h', cwd: '/repo' },
    }, 2);
    const regParsed = JSON.parse(regResp.result.content[0].text);
    assert.equal(regParsed.success, true);

    // Give the poll-loop a moment to start and the session file to be written.
    await new Promise((r) => setTimeout(r, 150));
    const sessionFile = computeSessionFilePath(homeDir, { CLAUDE_CODE_SESSION_ID: TEST_CLAUDE_SESSION_ID });
    assert.ok(fs.existsSync(sessionFile), 'session file must exist after register');

    // --- Simulate a lane-skill finishing ITS issue: report_status(Idle) + set_current_issue(null).
    //     Per KBT-F717 this must NOT be end_agent_session.
    await proxy.rpc('tools/call', {
      name: 'report_status', arguments: { sessionId: regParsed.sessionId, status: 'Idle' },
    }, 3);
    await proxy.rpc('tools/call', {
      name: 'set_current_issue', arguments: { sessionId: regParsed.sessionId, issueId: null },
    }, 4);

    // --- The acceptance criterion: a user posts a message AFTER "issue completion" — it must
    //     still arrive via notifications/claude/channel within 2s.
    stub.postMessage('hello after issue completion');
    const deadline = Date.now() + 2000;
    let delivered = null;
    while (Date.now() < deadline && !delivered) {
      delivered = proxy.notifications.find(
        (n) => n.params && n.params.content === 'hello after issue completion'
      );
      if (!delivered) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(delivered, `message must arrive within 2s of posting; stderr: ${proxy.getStderr()}`);

    // --- end_agent_session must never have been called.
    const endCalls = stub.received.filter(
      (r) => r.method === 'tools/call' && r.params?.name === 'end_agent_session'
    );
    assert.equal(endCalls.length, 0, 'end_agent_session must NOT be called by report_status/set_current_issue');

    // --- The session file must still be there — poll/heartbeat are alive.
    assert.ok(fs.existsSync(sessionFile), 'session file must still exist after "issue completion"');
  } finally {
    proxy.child.kill('SIGKILL'); // hard-kill: we've already exercised graceful shutdown elsewhere
    stub.server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
