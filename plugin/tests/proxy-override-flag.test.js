'use strict';

//
// Readiness-gate override governance flag — real-proxy spawn test.
//
// Motivation: an `overrideReason` on update_issue_status / claim_issue bypasses a
// failing readiness gate under both Soft AND Hard enforcement. This is the escape
// hatch that let an entire initiative reach Done with no review-approval / no test
// results / no merged-branch record. The proxy now surfaces every such override as
// a greppable Comment on the affected issue, centrally for every agent regardless
// of workspace, without blocking or altering the forwarded response.
//
// Asserts, end-to-end against the real proxy:
//   1. update_issue_status WITH overrideReason → response returned verbatim AND a
//      follow-up tools/call add_discussion_entry is sent to the backend, carrying
//      the issue code and the `[override-governance]` marker.
//   2. update_issue_status WITHOUT overrideReason → NO add_discussion_entry follows.
//
// Zero deps — only node:test, node:assert/strict, node:child_process, node:http,
// node:path. CommonJS to match the proxy's own module system.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');

// ---------------------------------------------------------------------------
// Stub MCP backend — returns success for update_issue_status + add_discussion_entry
// and records every received POST so the test can assert the proxy's follow-up call.
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
      received.push({ method: msg.method, params: msg.params, id: msg.id });

      const sid =
        req.headers['mcp-session-id'] ||
        `stub-session-${Math.random().toString(36).slice(2, 10)}`;
      res.setHeader('Mcp-Session-Id', sid);
      res.setHeader('Content-Type', 'application/json');

      const toolName = msg.method === 'tools/call' && msg.params ? msg.params.name : null;

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
      } else if (toolName === 'update_issue_status') {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                issueCode: 'KBT-OVR1',
                message: 'Updated KBT-OVR1 status to Done',
              }),
            },
          ],
        };
      } else if (toolName === 'add_discussion_entry') {
        result = {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      } else {
        result = {
          content: [
            { type: 'text', text: JSON.stringify({ success: false, error: 'unhandled-by-stub' }) },
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
// Proxy harness — spawn the real proxy, per-id RPC over stdin/stdout.
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

// Poll a predicate until true or timeout — used to await the fire-and-forget flag.
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

async function initProxy(proxy) {
  await proxy.rpc(
    'initialize',
    { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'override-flag-test', version: '1.0.0' } },
    1
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('override on update_issue_status → response verbatim + add_discussion_entry flag posted', async () => {
  const stub = await startStubBackend();
  const proxy = spawnProxy(stub.port);

  try {
    await initProxy(proxy);

    const resp = await proxy.rpc(
      'tools/call',
      {
        name: 'update_issue_status',
        arguments: {
          issueId: 'KBT-OVR1',
          status: 'Done',
          overrideReason: 'Work merged to main; tests verified green — backfilling status.',
        },
      },
      2
    );

    // 1. Response forwarded verbatim — proxy did not alter it.
    const parsed = JSON.parse(resp.result.content[0].text);
    assert.strictEqual(parsed.success, true, 'update_issue_status response returned verbatim');
    assert.strictEqual(parsed.issueCode, 'KBT-OVR1', 'issueCode preserved verbatim');

    // 2. The proxy's fire-and-forget flag reached the backend.
    await waitFor(
      () =>
        stub.received.some(
          (r) => r.method === 'tools/call' && r.params && r.params.name === 'add_discussion_entry'
        ),
      3000,
      'proxy must post add_discussion_entry after an overridden transition'
    );

    const flag = stub.received.find(
      (r) => r.method === 'tools/call' && r.params && r.params.name === 'add_discussion_entry'
    );
    assert.ok(flag, 'add_discussion_entry call recorded');
    assert.strictEqual(flag.params.arguments.issueId, 'KBT-OVR1', 'flag targets the overridden issue');
    assert.match(
      flag.params.arguments.content,
      /\[override-governance\]/,
      'flag content carries the greppable marker'
    );
    assert.match(
      flag.params.arguments.content,
      /Work merged to main/,
      'flag echoes the override reason for context'
    );
  } finally {
    proxy.child.stdin.end();
    if (proxy.child.exitCode == null && !proxy.child.killed) proxy.child.kill('SIGKILL');
    stub.server.close();
  }
});

test('update_issue_status WITHOUT overrideReason → no flag posted', async () => {
  const stub = await startStubBackend();
  const proxy = spawnProxy(stub.port);

  try {
    await initProxy(proxy);

    const resp = await proxy.rpc(
      'tools/call',
      { name: 'update_issue_status', arguments: { issueId: 'KBT-OVR1', status: 'Done' } },
      2
    );
    assert.strictEqual(
      JSON.parse(resp.result.content[0].text).success,
      true,
      'plain status change still forwarded'
    );

    // Give any (erroneous) fire-and-forget call time to land, then assert none did.
    await new Promise((r) => setTimeout(r, 300));
    const flagged = stub.received.some(
      (r) => r.method === 'tools/call' && r.params && r.params.name === 'add_discussion_entry'
    );
    assert.strictEqual(flagged, false, 'no add_discussion_entry without an overrideReason');
  } finally {
    proxy.child.stdin.end();
    if (proxy.child.exitCode == null && !proxy.child.killed) proxy.child.kill('SIGKILL');
    stub.server.close();
  }
});
