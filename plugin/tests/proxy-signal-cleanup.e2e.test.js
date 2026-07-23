'use strict';

//
// KBT-B224 — E2E-level coverage of the SIGTERM/SIGINT cleanup contract.
//
// Why a separate E2E-tier test exists alongside the existing Integration
// test (proxy-signal-cleanup.test.js):
//   The Integration test asserts the cleanup MCP sequence (end_agent_session
//   with reason="ProxyShutdown", inbox-poll stops, exit 0) — but on Windows
//   hosts it self-skips because Node converts child.kill('SIGTERM') and
//   child.kill('SIGINT') to SIGKILL, so the proxy's signal handlers never
//   run. Coverage on Windows hosts is provided by the docker wrapper script
//   (KBT-RL062 platform note); locally there is currently NO test-level
//   that exercises the proxy end-to-end on a Windows developer machine.
//
//   This E2E-tier test closes that gap with a platform-aware strategy:
//
//     - POSIX hosts (macOS / Linux / CI):
//         Send a real SIGTERM via child.kill('SIGTERM'). Assert exit 0 within
//         5s and that the stub backend observed end_agent_session with
//         reason="ProxyShutdown". This is the canonical signal path.
//
//     - Windows hosts:
//         Trigger the SAME gracefulExit() cleanup function via stdin-close
//         (process.stdin.on('end', ...) → gracefulExit(0)). The proxy wires
//         BOTH signal handlers AND the stdin-end handler to the same
//         shared cleanup body (see plugin/proxy/kanbantic-mcp-proxy.js,
//         gracefulExit + the three process.on registrations). Asserting the
//         cleanup contract via stdin-close on Windows is the documented
//         alternative path (already used by KBT-B200's proxy-approve-review
//         test for the same reason). The full external contract — exit
//         code 0, end_agent_session with reason="ProxyShutdown", session
//         file removed — is validated identically on both platforms.
//
// Test level: E2E (per KBT-RL062 + KBT-TC1865/1866 contract; spawns the real
//   proxy binary and a real local HTTP backend stub, asserts only externally
//   observable behaviour — exit code, MCP traffic, filesystem side-effects).
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

// ---------------------------------------------------------------------------
// Stub MCP backend — identical contract to proxy-signal-cleanup.test.js but
// kept inline so this file stands alone. Records every received POST so the
// test can assert exactly which tools/call methods the proxy forwarded.
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
        result = {
          content: [
            { type: 'text', text: JSON.stringify({ success: true, messages: [] }) },
          ],
        };
      } else if (
        msg.method === 'tools/call' &&
        msg.params &&
        msg.params.name === 'end_agent_session'
      ) {
        result = {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
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
// Proxy harness — spawn the real proxy binary, manage JSON-RPC over stdio,
// and surface the exit promise + stderr buffer.
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

  return { child, rpc, exitPromise, getStderr: () => stderr };
}

// ---------------------------------------------------------------------------
// Core E2E body — platform-aware shutdown trigger, identical assertions.
// ---------------------------------------------------------------------------

async function runE2ECleanup({ trigger }) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b224-e2e-'));
  const stub = await startStubBackend();
  const proxy = spawnProxy(stub.port, homeDir);
  let proxyExited = false;

  try {
    // 1. initialize.
    const initResp = await proxy.rpc(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kbt-b224-e2e', version: '1.0.0' },
      },
      1
    );
    assert.ok(initResp.result, 'initialize result present');

    // 2. register_agent_session — proxy captures sessionId, starts inbox-poll.
    const regResp = await proxy.rpc(
      'tools/call',
      { name: 'register_agent_session', arguments: { agentName: 'kbt-b224-e2e' } },
      2
    );
    const regParsed = JSON.parse(regResp.result.content[0].text);
    assert.strictEqual(regParsed.success, true, 'register_agent_session must succeed');
    const capturedSessionId = regParsed.sessionId;
    assert.ok(capturedSessionId, 'proxy must capture a sessionId');

    // Give the proxy a tick to write its session file + start the inbox-poll
    // BEFORE we trigger the shutdown — otherwise we race the handler.
    await new Promise((r) => setTimeout(r, 100));

    // Confirm the session file exists pre-shutdown — required to validate the
    // removeSessionFile() step of gracefulExit afterwards.
    const sessionFile = path.join(homeDir, '.claude-kanbantic-session.json');
    assert.ok(
      fs.existsSync(sessionFile),
      'proxy must write the session file after register_agent_session (pre-shutdown invariant)'
    );

    // 3. Platform-aware shutdown trigger. Both paths land in gracefulExit(0).
    if (trigger === 'SIGTERM') {
      const ok = proxy.child.kill('SIGTERM');
      assert.strictEqual(ok, true, "child.kill('SIGTERM') must report success");
    } else if (trigger === 'stdin-end') {
      // Closing stdin invokes process.stdin.on('end', () => gracefulExit(0))
      // in the proxy — the same cleanup target as the signal handlers. On
      // Windows hosts this is the ONLY cross-platform way to exercise the
      // cleanup contract end-to-end without docker.
      proxy.child.stdin.end();
    } else {
      throw new Error(`unknown trigger: ${trigger}`);
    }

    // 4. Wait for exit (5s ceiling per KBT-RL062 AC4).
    let timer;
    const exitTimeout = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `proxy did not exit within 5s of ${trigger}; stderr: ${proxy.getStderr()}`
            )
          ),
        5000
      );
    });
    let exitResult;
    try {
      exitResult = await Promise.race([proxy.exitPromise, exitTimeout]);
    } finally {
      clearTimeout(timer);
    }
    proxyExited = true;

    const { code, signal } = exitResult;
    assert.strictEqual(
      code,
      0,
      `proxy must exit with code 0 on ${trigger}; got code=${code} signal=${signal}. stderr: ${proxy.getStderr()}`
    );
    assert.strictEqual(
      signal,
      null,
      `proxy must exit voluntarily on ${trigger} (signal=null, not killed); got signal=${signal}. stderr: ${proxy.getStderr()}`
    );

    // 5. Exactly one tools/call end_agent_session observed by the backend,
    //    with reason="ProxyShutdown" and the captured sessionId.
    const endCalls = stub.received.filter(
      (r) => r.method === 'tools/call' && r.params && r.params.name === 'end_agent_session'
    );
    assert.strictEqual(
      endCalls.length,
      1,
      `proxy must call end_agent_session exactly once on ${trigger}; got ${endCalls.length}. ` +
        `All tools/call methods received: ${JSON.stringify(
          stub.received
            .filter((r) => r.method === 'tools/call')
            .map((r) => r.params && r.params.name)
        )}`
    );
    assert.strictEqual(
      endCalls[0].params.arguments.reason,
      'ProxyShutdown',
      'end_agent_session must be called with reason="ProxyShutdown" (KBT-RL062 AC3)'
    );
    assert.strictEqual(
      endCalls[0].params.arguments.sessionId,
      capturedSessionId,
      'end_agent_session must carry the previously captured sessionId'
    );

    // 6. Session file removed post-shutdown (removeSessionFile step).
    assert.ok(
      !fs.existsSync(sessionFile),
      'proxy must remove the session file as part of gracefulExit (KBT-RL062 cleanup step)'
    );
  } finally {
    if (!proxyExited && proxy.child.exitCode == null && !proxy.child.killed) {
      proxy.child.kill('SIGKILL');
    }
    stub.server.close();
    try {
      const sessionFile = path.join(homeDir, '.claude-kanbantic-session.json');
      if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
      fs.rmdirSync(homeDir);
    } catch {
      // Best-effort cleanup.
    }
  }
}

// ---------------------------------------------------------------------------
// Tests — one per platform branch. Exactly one runs on any given host.
// Windows-host: stdin-close (signals would be coerced to SIGKILL).
// POSIX-host:   SIGTERM (the canonical signal path).
// ---------------------------------------------------------------------------

test(
  'KBT-B224 E2E — Windows: proxy shuts down cleanly on stdin-close (signal-handler-equivalent path)',
  { skip: IS_WINDOWS ? false : 'Windows-specific path; POSIX hosts run the SIGTERM variant below' },
  async () => {
    await runE2ECleanup({ trigger: 'stdin-end' });
  }
);

test(
  'KBT-B224 E2E — POSIX: proxy shuts down cleanly on SIGTERM (real signal path)',
  { skip: IS_WINDOWS ? 'POSIX-specific path; Windows hosts run the stdin-close variant above (signals coerced to SIGKILL on win32)' : false },
  async () => {
    await runE2ECleanup({ trigger: 'SIGTERM' });
  }
);
