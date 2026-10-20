'use strict';

//
// KBT-B392 / KBT-TC2940 — param-aware drift-detector test (positive + negative).
//
// Verifies that plugin/scripts/check-tool-param-drift.js correctly:
//   - exits 0 when create_version exposes `applicationId` in
//     inputSchema.required (the PR #242 app-scoped contract),
//   - exits 1 when create_version drops `applicationId` from required,
//   - exits 1 when create_version is absent from the registry entirely.
//
// Stubs a local HTTP server playing the role of the MCP backend; runs the
// script as a child process with KANBANTIC_MCP_URL pointed at the stub. Zero
// external deps. Mirrors check-drift.test.js.
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
  'check-tool-param-drift.js'
);

// `tools` is an array of full tool objects: { name, inputSchema: { required } }.
function startStub(tools) {
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
        result = { tools };
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

const tool = (name, required) => ({
  name,
  description: '',
  inputSchema: { type: 'object', properties: {}, required },
});

test('param-drift: positive — create_version requires applicationId → exit 0', async () => {
  const stub = await startStub([
    tool('create_version', ['workspaceId', 'applicationId', 'name']),
    tool('report_tool_activity', ['sessionId', 'toolUseId']),
    // KBT-F742 — the contract grew; a positive stub must expose every contract tool.
    tool('request_decision', ['workspaceId', 'question', 'optionsJson', 'recipientRole']),
    tool('answer_decision', ['decisionRequestId', 'optionKey']),
    tool('list_versions', ['workspaceId']),
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
      /OK: required-parameter contract satisfied/,
      'stdout reports OK'
    );
  } finally {
    stub.server.close();
  }
});

test('param-drift: negative — create_version drops applicationId → exit 1', async () => {
  const stub = await startStub([
    // applicationId intentionally removed from required
    tool('create_version', ['workspaceId', 'name']),
    tool('report_tool_activity', ['sessionId', 'toolUseId']),
    tool('request_decision', ['workspaceId', 'question', 'optionsJson', 'recipientRole']),
    tool('answer_decision', ['decisionRequestId', 'optionKey']),
    tool('list_versions', ['workspaceId']),
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
      /applicationId/,
      'stderr names applicationId as the drifted param'
    );
  } finally {
    stub.server.close();
  }
});

test('param-drift: negative — create_version missing entirely → exit 1', async () => {
  const stub = await startStub([
    tool('list_versions', ['workspaceId']),
  ]);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(
      result.code,
      1,
      `expected exit 1; got ${result.code}. stdout: ${result.stdout}, stderr: ${result.stderr}`
    );
    assert.match(result.stderr, /not exposed by the live registry/, 'stderr flags missing tool');
  } finally {
    stub.server.close();
  }
});

test('param-drift: negative — report_tool_activity drops toolUseId (KBT-F741) → exit 1', async () => {
  const stub = await startStub([
    tool('create_version', ['workspaceId', 'applicationId', 'name']),
    tool('report_tool_activity', ['sessionId']),
    tool('request_decision', ['workspaceId', 'question', 'optionsJson', 'recipientRole']),
    tool('answer_decision', ['decisionRequestId', 'optionKey']),
  ]);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(result.code, 1, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.match(result.stderr, /report_tool_activity/);
    assert.match(result.stderr, /toolUseId/);
  } finally {
    stub.server.close();
  }
});

test('param-drift: negative — report_tool_activity missing entirely (KBT-F741) → exit 1', async () => {
  const stub = await startStub([tool('create_version', ['workspaceId', 'applicationId', 'name'])]);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(result.code, 1);
    assert.match(result.stderr, /report_tool_activity/);
  } finally {
    stub.server.close();
  }
});

// ── KBT-F742 / KBT-SR643 §Registry — decision tools in the required-parameter contract ──
//
//   request_decision → ["workspaceId","question","optionsJson","recipientRole"]
//   answer_decision  → ["decisionRequestId","optionKey"]

const F742_CONTRACT_TOOLS = [
  tool('create_version', ['workspaceId', 'applicationId', 'name']),
  tool('report_tool_activity', ['sessionId', 'toolUseId']),
  tool('request_decision', ['workspaceId', 'question', 'optionsJson', 'recipientRole']),
  tool('answer_decision', ['decisionRequestId', 'optionKey']),
];

test('param-drift: positive — the F742 decision tools satisfy the contract → exit 0', async () => {
  const stub = await startStub(F742_CONTRACT_TOOLS);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(result.code, 0, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.match(result.stdout, /request_decision/, 'the report names request_decision as a checked tool');
    assert.match(result.stdout, /answer_decision/, 'the report names answer_decision as a checked tool');
  } finally {
    stub.server.close();
  }
});

test('param-drift: negative — request_decision drops optionsJson (KBT-F742) → exit 1', async () => {
  const stub = await startStub([
    ...F742_CONTRACT_TOOLS.filter((t) => t.name !== 'request_decision'),
    tool('request_decision', ['workspaceId', 'question', 'recipientRole']),
  ]);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(result.code, 1, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.match(result.stderr, /request_decision/);
    assert.match(result.stderr, /optionsJson/);
  } finally {
    stub.server.close();
  }
});

test('param-drift: negative — answer_decision drops optionKey (KBT-F742) → exit 1', async () => {
  const stub = await startStub([
    ...F742_CONTRACT_TOOLS.filter((t) => t.name !== 'answer_decision'),
    tool('answer_decision', ['decisionRequestId']),
  ]);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(result.code, 1, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.match(result.stderr, /answer_decision/);
    assert.match(result.stderr, /optionKey/);
  } finally {
    stub.server.close();
  }
});

test('param-drift: negative — request_decision missing entirely (KBT-F742) → exit 1', async () => {
  const stub = await startStub(F742_CONTRACT_TOOLS.filter((t) => t.name !== 'request_decision'));
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(result.code, 1, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.match(result.stderr, /request_decision/);
    assert.match(result.stderr, /not exposed by the live registry/);
  } finally {
    stub.server.close();
  }
});

// ── KBT-F743 / KBT-SR648 §REST en MCP — fleet tools in the required-parameter contract ──
//
//   get_fleet_digest   → ["workspaceId"]
//   get_fleet_overview → ["workspaceId"]

const F743_CONTRACT_TOOLS = [
  ...F742_CONTRACT_TOOLS,
  tool('get_fleet_digest', ['workspaceId']),
  tool('get_fleet_overview', ['workspaceId']),
];

test('param-drift: positive — the F743 fleet tools satisfy the contract → exit 0', async () => {
  const stub = await startStub(F743_CONTRACT_TOOLS);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(result.code, 0, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.match(result.stdout, /get_fleet_digest/, 'the report names get_fleet_digest as a checked tool');
    assert.match(result.stdout, /get_fleet_overview/, 'the report names get_fleet_overview as a checked tool');
  } finally {
    stub.server.close();
  }
});

test('param-drift: negative — get_fleet_digest drops workspaceId (KBT-F743) → exit 1', async () => {
  const stub = await startStub([
    ...F743_CONTRACT_TOOLS.filter((t) => t.name !== 'get_fleet_digest'),
    tool('get_fleet_digest', ['window']),
  ]);
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(result.code, 1, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.match(result.stderr, /get_fleet_digest/);
    assert.match(result.stderr, /workspaceId/);
  } finally {
    stub.server.close();
  }
});

test('param-drift: negative — get_fleet_overview missing entirely (KBT-F743) → exit 1', async () => {
  const stub = await startStub(F743_CONTRACT_TOOLS.filter((t) => t.name !== 'get_fleet_overview'));
  try {
    const result = await runScript(stub.port);
    assert.strictEqual(result.code, 1, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.match(result.stderr, /get_fleet_overview/);
    assert.match(result.stderr, /not exposed by the live registry/);
  } finally {
    stub.server.close();
  }
});
