'use strict';

//
// KBT-F717 (KBT-TC3686) — E2E: two concurrent Claude processes on one workstation keep separate
// sessions, separate session files, and separate inboxes. Ending one does not touch the other.
// Also proves a THIRD, independent subprocess (simulating a hook like stop-version-summary.js —
// no knowledge of either proxy's PID, only its own CLAUDE_CODE_SESSION_ID) resolves to the
// correct session file via plugin/proxy/session-file.js's shared, fail-closed logic.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { sessionFilePath: computeSessionFilePath } = require('../proxy/session-file');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');

function startStubBackend() {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.statusCode = 404; res.end('not found'); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.statusCode = 400; res.end('bad json'); return; }
      received.push({ method: msg.method, params: msg.params, id: msg.id });
      res.setHeader('Mcp-Session-Id', 'stub-session');
      res.setHeader('Content-Type', 'application/json');

      let result;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } };
      } else if (msg.method === 'notifications/initialized') {
        res.statusCode = 202; res.end(); return;
      } else if (msg.method === 'tools/call' && msg.params?.name === 'register_agent_session') {
        // Each proxy registers under its own sessionId, derived from its cwd arg so P1/P2 differ.
        const tag = (msg.params.arguments && msg.params.arguments.cwd) || 'x';
        result = { content: [{ type: 'text', text: JSON.stringify({
          success: true, sessionId: `agent-session-${tag}`, channelId: `agent-channel-${tag}`,
        }) }] };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'get_channel_messages') {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true, messages: [] }) }] };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'end_agent_session') {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      } else {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'unhandled-by-stub' }) }] };
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

function spawnProxy(port, homeDir, claudeSessionId, cwdTag) {
  const env = {
    ...process.env,
    KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    KANBANTIC_API_KEY: 'test-key',
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CODE_SESSION_ID: claudeSessionId,
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
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  function rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const t = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC timeout: ${method}. stderr: ${stderr}`)); } }, 10000);
      if (typeof t.unref === 'function') t.unref();
    });
  }
  return { child, rpc, exitPromise, getStderr: () => stderr };
}

test('KBT-TC3686 — two processes keep separate session files, ending one leaves the other untouched', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f717-two-proc-e2e-'));
  const stub = await startStubBackend();
  const sidP1 = 'kbt-f717-two-proc-session-P1';
  const sidP2 = 'kbt-f717-two-proc-session-P2';
  const p1 = spawnProxy(stub.port, homeDir, sidP1, 'repo-P1');
  const p2 = spawnProxy(stub.port, homeDir, sidP2, 'repo-P2');
  let p1Exited = false;

  try {
    await p1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p1', version: '1' } }, 1);
    await p2.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p2', version: '1' } }, 1);

    const reg1 = await p1.rpc('tools/call', { name: 'register_agent_session', arguments: { workspaceId: 'ws', host: 'h', cwd: 'repo-P1' } }, 2);
    const reg2 = await p2.rpc('tools/call', { name: 'register_agent_session', arguments: { workspaceId: 'ws', host: 'h', cwd: 'repo-P2' } }, 2);
    const sessionId1 = JSON.parse(reg1.result.content[0].text).sessionId;
    const sessionId2 = JSON.parse(reg2.result.content[0].text).sessionId;
    assert.notEqual(sessionId1, sessionId2, 'the two processes must register DIFFERENT sessions');

    await new Promise((r) => setTimeout(r, 150)); // let both write their session files

    const pathP1 = computeSessionFilePath(homeDir, { CLAUDE_CODE_SESSION_ID: sidP1 });
    const pathP2 = computeSessionFilePath(homeDir, { CLAUDE_CODE_SESSION_ID: sidP2 });
    assert.notEqual(pathP1, pathP2, 'the two session-file paths must differ');
    assert.ok(fs.existsSync(pathP1), 'P1 session file must exist');
    assert.ok(fs.existsSync(pathP2), 'P2 session file must exist');
    const contentsP1 = JSON.parse(fs.readFileSync(pathP1, 'utf8'));
    const contentsP2 = JSON.parse(fs.readFileSync(pathP2, 'utf8'));
    assert.equal(contentsP1.sessionId, sessionId1);
    assert.equal(contentsP2.sessionId, sessionId2);

    // --- A THIRD, independent subprocess (simulating a hook: stop-version-summary.js) that
    //     knows NOTHING about either proxy's PID — only its own CLAUDE_CODE_SESSION_ID=sidP2 —
    //     must resolve to EXACTLY P2's file via the shared session-file.js resolver.
    const hookProbe = spawnSync(process.execPath, [
      '-e',
      `const { resolveExistingSessionFile } = require(${JSON.stringify(path.resolve(__dirname, '..', 'proxy', 'session-file.js'))});` +
      `const r = resolveExistingSessionFile(process.env.USERPROFILE, process.env);` +
      `process.stdout.write(JSON.stringify(r));`,
    ], { env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir, CLAUDE_CODE_SESSION_ID: sidP2 } });
    const hookResult = JSON.parse(hookProbe.stdout.toString('utf8'));
    assert.equal(hookResult.path, pathP2, "a hook-only subprocess with only sidP2's env var must resolve to exactly P2's file");
    assert.notEqual(hookResult.path, pathP1);

    // --- End P1 (via its OWN sessionId). P2 must be completely unaffected.
    await p1.rpc('tools/call', { name: 'end_agent_session', arguments: { sessionId: sessionId1, reason: 'Done' } }, 3);
    await new Promise((r) => setTimeout(r, 150));

    assert.ok(!fs.existsSync(pathP1), "P1's session file must be removed after its own end_agent_session");
    assert.ok(fs.existsSync(pathP2), "P2's session file must be UNTOUCHED by P1 ending");
    assert.equal(
      JSON.parse(fs.readFileSync(pathP2, 'utf8')).sessionId, sessionId2,
      "P2's session file content must be unchanged"
    );

    // P2 must still be able to register/heartbeat-equivalent traffic — prove liveness with a
    // trivial round trip rather than assuming it from file-existence alone.
    const p2StillAlive = await p2.rpc('tools/call', { name: 'get_channel_messages', arguments: { channelId: 'agent-channel-repo-P2', after: new Date().toISOString() } }, 4);
    assert.equal(JSON.parse(p2StillAlive.result.content[0].text).success, true, 'P2 must still be responsive after P1 ended');
  } finally {
    p1.child.kill('SIGKILL');
    p2.child.kill('SIGKILL');
    stub.server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
