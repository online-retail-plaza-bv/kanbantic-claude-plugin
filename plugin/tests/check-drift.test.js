'use strict';

//
// KBT-B200 / KBT-TC1856 — drift-detector test (positive + negative cases).
//
// Verifies that plugin/scripts/check-bundle-tool-drift.js correctly:
//   - exits 0 when all MUST-HAVE tools are present in the live registry
//   - exits 1 and names the missing tool when one is absent
//
// Stubs a local HTTP server playing the role of the MCP backend; runs the
// script as a child process with KANBANTIC_MCP_URL pointed at the stub. Zero
// external deps.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT_PATH = path.resolve(
  __dirname,
  '..',
  'scripts',
  'check-bundle-tool-drift.js'
);

function startStub(toolNames) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      res.end();
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
        res.end();
        return;
      }
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
      } else if (msg.method === 'tools/list') {
        result = {
          tools: toolNames.map((n) => ({
            name: n,
            description: '',
            inputSchema: { type: 'object' },
          })),
        };
      } else {
        result = {};
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port })
    );
  });
}

function runScript(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`,
        KANBANTIC_API_KEY: 'test-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code, signal) =>
      resolve({ code, signal, stdout, stderr })
    );
  });
}

test('drift-detector: positive case — all MUST-HAVE tools present', async () => {
  const stub = await startStub([
    'approve_review',
    'start_run_review',
    'complete_run_review',
    'extra_tool',
  ]);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(
      result.code,
      0,
      `expected exit 0; got ${result.code}. stderr: ${result.stderr}, stdout: ${result.stdout}`
    );
    assert.match(
      result.stdout,
      /OK: all MUST-HAVE tools present/,
      'stdout reports OK'
    );
  } finally {
    stub.server.close();
  }
});

test('drift-detector: negative case — approve_review missing → exit 1', async () => {
  const stub = await startStub([
    // approve_review intentionally absent
    'start_run_review',
    'complete_run_review',
    'extra_tool',
  ]);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(
      result.code,
      1,
      `expected exit 1; got ${result.code}. stdout: ${result.stdout}, stderr: ${result.stderr}`
    );
    assert.match(result.stderr, /DRIFT/, 'stderr says DRIFT');
    assert.match(
      result.stderr,
      /approve_review/,
      'stderr names approve_review as missing'
    );
  } finally {
    stub.server.close();
  }
});
