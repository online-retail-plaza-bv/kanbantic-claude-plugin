'use strict';

//
// kanbantic-pr-identity-stamp.test.js — KBT-B538
//
// Two layers, matching the frozen test-policy (Unit + Integration, both
// Vereist/min 1 — KBT-F442):
//
//   - Unit: the pure stampTitle/stampBody helpers, exercised in-process,
//     zero network involved.
//   - Integration: the CLI entry point, spawned as a fresh child process per
//     test against a stub MCP HTTP server (same technique as
//     kanbantic-git-identity.test.js / check-drift.test.js). Spawning rather
//     than requiring in-process because MCP_URL is resolved once from
//     process.env at module-load time — an in-process require would freeze
//     the first value seen.
//
// E2E (real `gh pr create` + `gh pr view` against a real repo) is covered
// manually per KBT-TC3416 — not automated here, mirrors the "real-proxy for
// plugin" E2E convention (kanbantic-issue-prepare 5F.5).
//
// Zero deps — node:test + node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'kanbantic-pr-identity-stamp.js');
const { stampTitle, stampBody } = require('../scripts/kanbantic-pr-identity-stamp.js');

// ---- Unit: pure helpers (safe in-process — no network) ----

test('unit: stampTitle prefixes with [agentName]', () => {
  assert.equal(stampTitle('Fix the thing', 'Axon 04'), '[Axon 04] Fix the thing');
});

test('unit: stampTitle is idempotent — title already carrying THIS agent\'s own stamp is left unchanged', () => {
  assert.equal(stampTitle('[Axon 04] Fix the thing', 'Axon 04'), '[Axon 04] Fix the thing');
});

test('unit: stampTitle does not mistake an unrelated bracket-prefixed title for an existing stamp', () => {
  // regression: a shape-only idempotency check (any [x] prefix) would wrongly
  // treat these as already-stamped and silently skip stamping them.
  assert.equal(stampTitle('[skip ci] Fix flaky test', 'Axon 04'), '[Axon 04] [skip ci] Fix flaky test');
  assert.equal(stampTitle('[WIP] Draft change', 'Axon 04'), '[Axon 04] [WIP] Draft change');
  // a different agent's own stamp is not mistaken for this agent's stamp either
  assert.equal(stampTitle('[Axon 03] Fix the thing', 'Axon 04'), '[Axon 04] [Axon 03] Fix the thing');
});

test('unit: stampBody appends a Created-by footer to a non-empty body', () => {
  const result = stampBody('This PR does X.', 'Axon 04');
  assert.equal(result, 'This PR does X.\n\n---\nCreated by: Axon 04');
});

test('unit: stampBody handles an empty body — footer only, no leading separator', () => {
  assert.equal(stampBody('', 'Axon 04'), 'Created by: Axon 04');
  assert.equal(stampBody('   ', 'Axon 04'), 'Created by: Axon 04');
});

test('unit: stampBody is idempotent — body already carrying a footer left unchanged', () => {
  const already = 'This PR does X.\n\n---\nCreated by: Axon 04';
  assert.equal(stampBody(already, 'Axon 03'), already);
});

// ---- Integration: CLI entry point against a stub MCP server ----

function startStub({ identity } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        return res.end();
      }
      let payload = null;
      if (msg.method === 'tools/call' && msg.params.name === 'get_current_agent_identity') {
        payload = identity !== undefined ? identity : { success: true, authenticated: false };
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      const result = payload ? { content: [{ type: 'text', text: JSON.stringify(payload) }] } : {};
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runScript({ field, stdin, port, apiKey = 'test-key' }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (port) env.KANBANTIC_MCP_URL = `http://127.0.0.1:${port}/mcp`;
    if (apiKey === null) delete env.KANBANTIC_API_KEY;
    else env.KANBANTIC_API_KEY = apiKey;
    const args = field !== undefined ? [SCRIPT, field] : [SCRIPT];
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

test('integration: identity resolves → CLI stamps title read from stdin', async () => {
  const stub = await startStub({
    identity: { success: true, authenticated: true, claudeAgentName: 'Axon Alpha' },
  });
  try {
    const r = await runScript({ field: 'title', stdin: 'Fix the thing', port: stub.port });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '[Axon Alpha] Fix the thing');
  } finally {
    stub.server.close();
  }
});

test('integration: identity resolves → CLI stamps body read from stdin', async () => {
  const stub = await startStub({
    identity: { success: true, authenticated: true, claudeAgentName: 'Axon Alpha' },
  });
  try {
    const r = await runScript({ field: 'body', stdin: 'This PR does X.', port: stub.port });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'This PR does X.\n\n---\nCreated by: Axon Alpha');
  } finally {
    stub.server.close();
  }
});

test('integration: identity unauthenticated → original text passed through unchanged', async () => {
  const stub = await startStub({ identity: { success: true, authenticated: false } });
  try {
    const r = await runScript({ field: 'title', stdin: 'Fix the thing', port: stub.port });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'Fix the thing');
  } finally {
    stub.server.close();
  }
});

test('integration: no API key → original text passed through unchanged, no throw', async () => {
  const r = await runScript({ field: 'body', stdin: 'This PR does X.', apiKey: null });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'This PR does X.');
});

test('integration: missing field argument → usage error, exit code 1', async () => {
  const r = await runScript({ field: undefined, stdin: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage:/);
});
