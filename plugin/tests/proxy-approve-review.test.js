'use strict';

//
// KBT-B200 — Regression: real-proxy spawn forwards approve_review.
//
// Per KBT-SR298 + KBT-TC1855 + KBT-TRUL013 (plugin row):
//   "Spawn-the-real-proxy test using `child_process.spawn` against the actual
//    proxy script — signal handling, channel-end, exit codes verified
//    end-to-end."
//
// Why this exists:
//   The original B200 symptom (Axon 02, 2026-05-02) was a missing `approve_review`
//   in the plugin's tool namespace. The proxy was never at fault — it is a
//   transparent stdio→HTTP bridge — but no regression-test existed to catch a
//   future bundle ↔ live drift before it bites another agent. This test boots
//   a local stub MCP backend and spawns the real proxy against it, asserting:
//     1. `tools/list` exposes `approve_review`.
//     2. `tools/call name=approve_review` is forwarded verbatim to the backend
//        (same name + arguments) and the backend's response is returned verbatim.
//     3. The proxy exits cleanly when stdin closes (cross-platform — Windows does
//        not honor SIGTERM in `child.kill()`, so we use stdin-close instead;
//        the gracefulExit(0) path covers both per the proxy source).
//
// Zero deps — only node:test, node:assert/strict, node:child_process, node:http,
// node:path. CommonJS so it matches the proxy's own module system.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');

// ---------------------------------------------------------------------------
// Stub MCP backend — listens on 127.0.0.1:<random> /mcp and responds with
// canned JSON-RPC results based on the incoming method. Records every received
// request so the test can assert the proxy forwarded the body verbatim.
// ---------------------------------------------------------------------------

function startStubBackend(toolsListResult, approveReviewResult) {
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
        raw: msg,
      });

      const sessionId =
        req.headers['mcp-session-id'] ||
        `stub-session-${Math.random().toString(36).slice(2, 10)}`;
      res.setHeader('Mcp-Session-Id', sessionId);
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
      } else if (msg.method === 'tools/list') {
        result = toolsListResult;
      } else if (
        msg.method === 'tools/call' &&
        msg.params &&
        msg.params.name === 'approve_review'
      ) {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(approveReviewResult),
            },
          ],
        };
      } else {
        // Generic success envelope for any other tool/call (keeps the proxy happy).
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
// Proxy harness — spawn the real proxy, expose a per-id RPC helper that writes
// a line on stdin and resolves with the matching JSON-RPC response from stdout.
// ---------------------------------------------------------------------------

function spawnProxy(port) {
  const child = spawn(process.execPath, [PROXY_PATH], {
    env: {
      ...process.env,
      KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      KANBANTIC_API_KEY: 'test-key',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map(); // id → resolve
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
      // Allow the timer to be unrefenced so it does not keep the test running.
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
// The test
// ---------------------------------------------------------------------------

test('proxy forwards approve_review via tools/list + tools/call (real-proxy spawn)', async () => {
  const toolsListResult = {
    tools: [
      {
        name: 'approve_review',
        description: 'Record a review approval (KBT-F170 / KBT-PR191).',
        inputSchema: {
          type: 'object',
          properties: {
            issueId: { type: 'string' },
            verdict: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['issueId', 'verdict', 'reason'],
        },
      },
      {
        name: 'start_run_review',
        description: 'Start an automation run review.',
        inputSchema: { type: 'object' },
      },
      {
        name: 'complete_run_review',
        description: 'Complete an automation run review.',
        inputSchema: { type: 'object' },
      },
    ],
  };
  const approveReviewResult = { success: true, message: 'stub-approved' };

  const stub = await startStubBackend(toolsListResult, approveReviewResult);
  const proxy = spawnProxy(stub.port);

  try {
    // ---- 1. initialize ----
    const initResp = await proxy.rpc(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kbt-b200-regression', version: '1.0.0' },
      },
      1
    );
    assert.ok(initResp.result, 'initialize result present');
    assert.ok(initResp.result.capabilities, 'capabilities present in initialize result');
    assert.ok(
      initResp.result.capabilities.experimental,
      'proxy must inject experimental capabilities on initialize-response'
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(
        initResp.result.capabilities.experimental,
        'claude/channel'
      ),
      'proxy declared experimental[claude/channel] for Agent Communication Hub (KBT-E046 P3b)'
    );

    // ---- 2. tools/list ----
    const listResp = await proxy.rpc('tools/list', {}, 2);
    assert.ok(listResp.result, 'tools/list result present');
    assert.ok(Array.isArray(listResp.result.tools), 'tools array present');
    const names = listResp.result.tools.map((t) => t.name);
    assert.ok(
      names.includes('approve_review'),
      `tools/list response MUST include approve_review (KBT-B200 root acceptance). Got: [${names.join(', ')}]`
    );

    // ---- 3. tools/call approve_review ----
    const callResp = await proxy.rpc(
      'tools/call',
      {
        name: 'approve_review',
        arguments: {
          issueId: 'KBT-B200',
          verdict: 'Approved',
          reason: 'Smoke-test for proxy forwarding (≥20 chars guaranteed)',
        },
      },
      3
    );
    assert.ok(callResp.result, 'tools/call result present');
    assert.ok(Array.isArray(callResp.result.content), 'content array present');
    assert.ok(callResp.result.content.length > 0, 'content has at least one element');
    const parsed = JSON.parse(callResp.result.content[0].text);
    assert.strictEqual(parsed.success, true, 'stub returned success — proxy passed it through verbatim');
    assert.strictEqual(parsed.message, 'stub-approved', 'stub message returned verbatim');

    // ---- 4. The backend received the call with verbatim name + arguments ----
    const forwarded = stub.received.find(
      (r) => r.method === 'tools/call' && r.params && r.params.name === 'approve_review'
    );
    assert.ok(forwarded, 'stub backend received the tools/call for approve_review');
    assert.strictEqual(
      forwarded.params.arguments.issueId,
      'KBT-B200',
      'issueId argument forwarded verbatim'
    );
    assert.strictEqual(
      forwarded.params.arguments.verdict,
      'Approved',
      'verdict argument forwarded verbatim'
    );
    assert.ok(
      forwarded.params.arguments.reason.startsWith('Smoke-test for proxy forwarding'),
      'reason argument forwarded verbatim'
    );

    // ---- 5. Clean shutdown: close stdin, expect exit 0 ----
    // (We use stdin-close rather than SIGTERM because child.kill('SIGTERM') on
    // Windows is treated as SIGKILL and skips the proxy's signal handler. The
    // stdin-close path exercises the same gracefulExit(0) in the proxy.)
    proxy.child.stdin.end();
    const { code } = await proxy.exitPromise;
    assert.strictEqual(code, 0, `proxy must exit 0 on stdin close; got code=${code}. stderr: ${proxy.getStderr()}`);
  } finally {
    if (proxy.child.exitCode == null && !proxy.child.killed) {
      proxy.child.kill('SIGKILL');
    }
    stub.server.close();
  }
});
