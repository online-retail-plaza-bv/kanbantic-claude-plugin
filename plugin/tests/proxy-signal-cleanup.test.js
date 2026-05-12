'use strict';

//
// KBT-B224 — Regression: real-proxy SIGTERM/SIGINT handlers trigger gracefulExit.
//
// Per KBT-RL062 + KBT-TC1865 + KBT-TC1866 + KBT-TRUL013 (plugin row):
//   "Real-proxy test — child_process.spawn the actual proxy and assert
//    end-to-end behaviour (signals, channel-end, exit code)."
//
// Why this exists:
//   KBT-B200's existing test (`proxy-approve-review.test.js`) verifies the
//   `gracefulExit()` cleanup path via STDIN-CLOSE because Windows hosts
//   cannot send real POSIX signals — `child.kill('SIGTERM')` and
//   `child.kill('SIGINT')` are both converted to SIGKILL by Node on win32
//   (see proxy-approve-review.test.js:312-313). The actual signal-handler
//   wiring at `kanbantic-mcp-proxy.js:481-488` therefore stayed untested
//   end-to-end. This test closes that gap on POSIX hosts; on Windows hosts
//   the test self-skips and full coverage is provided by
//   `plugin/scripts/run-signal-tests-in-docker.sh` which runs this same
//   file inside `node:lts-alpine` (KBT-B195 docker-test pattern).
//
// What is verified per test (one test per signal):
//   1. Spawn the real proxy + a local stub MCP backend.
//   2. JSON-RPC initialize the proxy (proxy captures Mcp-Session-Id).
//   3. JSON-RPC tools/call register_agent_session (proxy captures
//      agentSessionId + agentChannelId, starts inbox-poll).
//   4. child.kill('SIGTERM' | 'SIGINT').
//   5. Within 5s the proxy exits with code 0 and signal === null
//      (signal === null proves the proxy exited voluntarily via
//      process.exit(0) and was NOT terminated by SIGKILL).
//   6. The stub backend recorded exactly one POST corresponding to
//      tools/call end_agent_session with reason: "ProxyShutdown" and
//      the previously captured sessionId in the arguments.
//
// Zero deps — only node:test, node:assert/strict, node:child_process,
// node:http, node:path, node:fs, node:os. CommonJS to match the proxy.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');
const IS_WINDOWS = process.platform === 'win32';

const SKIP_WINDOWS_REASON =
  "Windows host: Node converts child.kill('SIGTERM') and child.kill('SIGINT') " +
  'to SIGKILL — the proxy signal handlers never run, so a native run would ' +
  'either hang or kill the proxy without exercising the cleanup path. ' +
  'Coverage on Windows hosts is provided by ' +
  'plugin/scripts/run-signal-tests-in-docker.sh which runs this same test ' +
  'inside a node:lts-alpine container where POSIX signal semantics are ' +
  'honored end-to-end. See KBT-RL062 platform note + KBT-B195 docker-test ' +
  'pattern. KBT-B200 covers the stdin-close cleanup path natively.';

// ---------------------------------------------------------------------------
// Stub MCP backend — records every POST and returns canned JSON-RPC results.
// Supports the four methods this test exercises:
//   - initialize
//   - notifications/initialized (202)
//   - tools/call register_agent_session  → success + sessionId + channelId
//   - tools/call get_channel_messages    → success + empty messages array
//   - tools/call end_agent_session       → success
// ---------------------------------------------------------------------------

function startStubBackend() {
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
      received.push({
        method: msg.method,
        params: msg.params,
        id: msg.id,
        headers: req.headers,
      });

      const sid =
        req.headers['mcp-session-id'] ||
        `stub-session-${Math.random().toString(36).slice(2, 10)}`;
      res.setHeader('Mcp-Session-Id', sid);
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
      } else if (
        msg.method === 'tools/call' &&
        msg.params &&
        msg.params.name === 'register_agent_session'
      ) {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                sessionId: 'agent-session-' + Math.random().toString(36).slice(2, 10),
                channelId: 'agent-channel-' + Math.random().toString(36).slice(2, 10),
              }),
            },
          ],
        };
      } else if (
        msg.method === 'tools/call' &&
        msg.params &&
        msg.params.name === 'get_channel_messages'
      ) {
        // Proxy's inbox-poll fires every 1s after register_agent_session.
        // Always reply with empty messages so the poll stays quiet.
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, messages: [] }),
            },
          ],
        };
      } else if (
        msg.method === 'tools/call' &&
        msg.params &&
        msg.params.name === 'end_agent_session'
      ) {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true }),
            },
          ],
        };
      } else {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: false, error: 'unhandled-by-stub' }),
            },
          ],
        };
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, received });
    });
  });
}

// ---------------------------------------------------------------------------
// Proxy harness — mirrors plugin/tests/proxy-approve-review.test.js style.
// Adds a `homeDir` override so the proxy's session-file lives in a temp dir
// instead of polluting $HOME/.claude-kanbantic-session.json.
// ---------------------------------------------------------------------------

function spawnProxy(port, homeDir) {
  const env = {
    ...process.env,
    KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    KANBANTIC_API_KEY: 'test-key',
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
  const child = spawn(process.execPath, [PROXY_PATH], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

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
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  function rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const t = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout (10s): ${method} (id=${id}). stderr so far: ${stderr}`));
        }
      }, 10000);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  return {
    child,
    rpc,
    exitPromise,
    getStderr: () => stderr,
  };
}

// ---------------------------------------------------------------------------
// Shared body — one signal per test.
// ---------------------------------------------------------------------------

async function runSignalCleanupTest(signalName) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b224-'));
  const stub = await startStubBackend();
  const proxy = spawnProxy(stub.port, homeDir);
  let proxyDoneExited = false;

  try {
    // 1. initialize — proxy captures Mcp-Session-Id from response.
    const initResp = await proxy.rpc(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kbt-b224-signal-test', version: '1.0.0' },
      },
      1
    );
    assert.ok(initResp.result, 'initialize result present');

    // 2. register_agent_session — proxy captures agentSessionId, starts inbox-poll.
    const regResp = await proxy.rpc(
      'tools/call',
      {
        name: 'register_agent_session',
        arguments: { agentName: 'kbt-b224-signal-test' },
      },
      2
    );
    assert.ok(regResp.result, 'register_agent_session result present');
    const regParsed = JSON.parse(regResp.result.content[0].text);
    assert.strictEqual(
      regParsed.success,
      true,
      'register_agent_session must succeed so the proxy captures sessionId'
    );
    const capturedSessionId = regParsed.sessionId;
    assert.ok(capturedSessionId, 'stub returned a sessionId for the proxy to capture');

    // 3. Give the proxy a tick to write its session file + start inbox-poll
    //    before we hit it with the signal. Without this, the agentSessionId
    //    might not be set yet when gracefulExit() reads it.
    await new Promise((r) => setTimeout(r, 100));

    // 4. Send the real signal. On POSIX this triggers process.on('SIGTERM|SIGINT')
    //    → gracefulExit(0) → callInternalTool('end_agent_session') → process.exit(0).
    const killed = proxy.child.kill(signalName);
    assert.strictEqual(
      killed,
      true,
      `child.kill('${signalName}') must report success (process was alive)`
    );

    // 5. Race exit against a 5s timeout (per KBT-TC1865 / KBT-TC1866 AC).
    let timer;
    const exitTimeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`proxy did not exit within 5s of ${signalName}; stderr: ${proxy.getStderr()}`)),
        5000
      );
    });
    let exitResult;
    try {
      exitResult = await Promise.race([proxy.exitPromise, exitTimeout]);
    } finally {
      clearTimeout(timer);
    }
    proxyDoneExited = true;

    const { code, signal } = exitResult;
    assert.strictEqual(
      code,
      0,
      `proxy must exit with code 0 on ${signalName}; got code=${code} signal=${signal}. stderr: ${proxy.getStderr()}`
    );
    assert.strictEqual(
      signal,
      null,
      `proxy must exit voluntarily on ${signalName} (signal=null), not be terminated by SIGKILL; got signal=${signal}. ` +
        `stderr: ${proxy.getStderr()}`
    );

    // 6. The stub recorded exactly one tools/call end_agent_session with
    //    reason: "ProxyShutdown" and the captured sessionId in arguments.
    const endCalls = stub.received.filter(
      (r) => r.method === 'tools/call' && r.params && r.params.name === 'end_agent_session'
    );
    assert.strictEqual(
      endCalls.length,
      1,
      `proxy must call end_agent_session exactly once on ${signalName}; got ${endCalls.length}. ` +
        `All tools/call methods received: ${JSON.stringify(
          stub.received
            .filter((r) => r.method === 'tools/call')
            .map((r) => r.params && r.params.name)
        )}`
    );
    assert.strictEqual(
      endCalls[0].params.arguments.reason,
      'ProxyShutdown',
      `end_agent_session must be called with reason="ProxyShutdown"; got "${endCalls[0].params.arguments.reason}"`
    );
    assert.strictEqual(
      endCalls[0].params.arguments.sessionId,
      capturedSessionId,
      `end_agent_session must include the captured sessionId="${capturedSessionId}"; ` +
        `got "${endCalls[0].params.arguments.sessionId}"`
    );
  } finally {
    // Belt-and-braces: ensure no orphan proxy if the assertions failed
    // before exit was awaited.
    if (!proxyDoneExited && proxy.child.exitCode == null && !proxy.child.killed) {
      proxy.child.kill('SIGKILL');
    }
    stub.server.close();
    // Remove the session file (if proxy didn't already remove it) + the temp dir.
    try {
      const sessionFile = path.join(homeDir, '.claude-kanbantic-session.json');
      if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
      fs.rmdirSync(homeDir);
    } catch {
      // Best-effort cleanup; ignore residual files (e.g. on Windows skip-path
      // where the proxy was never spawned).
    }
  }
}

// ---------------------------------------------------------------------------
// Tests — one per signal.
// ---------------------------------------------------------------------------

test(
  'KBT-TC1865 — proxy graceful shutdown on SIGTERM (end_agent_session called once, exit 0)',
  { skip: IS_WINDOWS ? SKIP_WINDOWS_REASON : false },
  async () => {
    await runSignalCleanupTest('SIGTERM');
  }
);

test(
  'KBT-TC1866 — proxy graceful shutdown on SIGINT (end_agent_session called once, exit 0)',
  { skip: IS_WINDOWS ? SKIP_WINDOWS_REASON : false },
  async () => {
    await runSignalCleanupTest('SIGINT');
  }
);
