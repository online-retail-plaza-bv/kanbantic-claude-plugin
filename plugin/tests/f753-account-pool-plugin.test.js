'use strict';

//
// f753-account-pool-plugin.test.js — KBT-F753 / KBT-SR659 §Plugin / KBT-TC4226
//
// Pins the plugin-side contract of "Claude-accountpool":
//
//   - `get_account_pool` (no required parameters, optional workspaceId) is in
//     known-mcp-tools.json (alphabetical) AND in the required-parameter
//     contract of check-tool-param-drift.js with an EMPTY list;
//   - the contract stub in fleet-proxy-e2e.test.js exposes it, and the drift
//     script runs green against a stub that carries it (red without it);
//   - kanbantic-orchestrate tells the orchestrator NOT to restart a team
//     member itself on a `usage-limit` signal: Kanbantic balances (F753),
//     check `get_account_pool` `recentEvents`, handle only a
//     `DecisionRequested` outcome via the Beslisbak;
//   - reference/using-kanbantic.md has the "Accountpool (KBT-F753)" section;
//   - the README mentions the tool.
//
// Zero deps — node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugin');
const read = (rel) => fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8');

function section(markdown, startHeading, nextHeadingPattern) {
  const start = markdown.indexOf(startHeading);
  assert.ok(start >= 0, `heading not found: ${startHeading}`);
  const rest = markdown.slice(start + startHeading.length);
  const m = rest.match(nextHeadingPattern);
  return m ? rest.slice(0, m.index) : rest;
}

// ── registry + required-parameter contract ───────────────────────────────────

test('known-mcp-tools.json carries get_account_pool and stays alphabetical', () => {
  const snapshot = JSON.parse(read('scripts/known-mcp-tools.json'));
  assert.ok(snapshot.tools.includes('get_account_pool'));
  assert.deepStrictEqual(snapshot.tools, [...snapshot.tools].sort(), 'tools stay alphabetical');
});

test('check-tool-param-drift.js lists get_account_pool with an empty required-parameter list', () => {
  const src = read('scripts/check-tool-param-drift.js');
  assert.match(src, /get_account_pool:\s*\[\s*\]/,
    'REQUIRED_PARAMS must contain get_account_pool: []');
});

test('fleet-proxy-e2e.test.js CONTRACT_TOOLS exposes get_account_pool with no required params', () => {
  const src = fs.readFileSync(path.join(__dirname, 'fleet-proxy-e2e.test.js'), 'utf8');
  assert.match(src, /tool\('get_account_pool',\s*\[\s*\]\)/);
});

// ── drift script against a stub: green with the tool, red without ────────────

function tool(name, required) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, required },
  };
}

// Minimal streamable-HTTP MCP stub: initialize + tools/list.
function startStub(tools) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let msg = {};
        try { msg = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const reply = (result) => {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'stub' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg.method === 'initialize') {
          return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } });
        }
        if (msg.method === 'tools/list') return reply({ tools });
        res.writeHead(202);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function runDrift(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'check-tool-param-drift.js')], {
      env: { ...process.env, KANBANTIC_MCP_URL: url, KANBANTIC_API_KEY: 'test-key' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const CONTRACT_TOOLS = [
  tool('create_version', ['workspaceId', 'applicationId', 'name']),
  tool('report_tool_activity', ['sessionId', 'toolUseId']),
  tool('request_decision', ['workspaceId', 'question', 'optionsJson', 'recipientRole']),
  tool('answer_decision', ['decisionRequestId', 'optionKey']),
  tool('get_fleet_digest', ['workspaceId']),
  tool('get_fleet_overview', ['workspaceId']),
  tool('get_model_policy', ['workspaceId']),
  tool('get_account_pool', []),
];

test('param-drift: positive — a stub exposing get_account_pool (no required params) → exit 0', { timeout: 60000 }, async () => {
  const stub = await startStub(CONTRACT_TOOLS);
  try {
    const result = await runDrift(stub.url);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /get_account_pool/, 'the report names get_account_pool as a checked tool');
  } finally {
    await stub.close();
  }
});

test('param-drift: negative — get_account_pool missing from the live tool list → exit 1', { timeout: 60000 }, async () => {
  const stub = await startStub(CONTRACT_TOOLS.filter((t) => t.name !== 'get_account_pool'));
  try {
    const result = await runDrift(stub.url);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /get_account_pool/);
  } finally {
    await stub.close();
  }
});

// ── kanbantic-orchestrate: usage-limit → Kanbantic balances ──────────────────

test('orchestrate-skill: on a usage-limit signal do not restart or pick another account; read get_account_pool', () => {
  const skill = read('skills/kanbantic-orchestrate/SKILL.md');
  assert.ok(skill.includes('usage-limit'), 'names the usage-limit signal');
  const flat = skill.replace(/\s+/g, ' ');
  const idx = flat.indexOf('usage-limit');
  const para = flat.slice(Math.max(0, idx - 400), idx + 1600);
  assert.ok(/KBT-F753/.test(para), 'cites KBT-F753');
  assert.ok(/niet zelf/i.test(para), 'tells the orchestrator not to restart / choose an account itself');
  assert.ok(/get_account_pool/.test(para), 'points at get_account_pool');
  assert.ok(/recentEvents/.test(para), 'says to check recentEvents');
  assert.ok(/DecisionRequested/.test(para), 'handles only a DecisionRequested outcome');
  assert.ok(/Beslisbak/.test(para), 'via the Beslisbak');
});

// ── reference/using-kanbantic.md ─────────────────────────────────────────────

test('using-kanbantic.md has the Accountpool (KBT-F753) section', () => {
  const doc = read('reference/using-kanbantic.md');
  const sec = section(doc, '### Accountpool (KBT-F753)', /\n##[# ]/);
  const flat = sec.replace(/\s+/g, ' ');
  assert.ok(/get_account_pool/.test(flat), 'names the tool');
  for (const key of ['accounts', 'assignments', 'loginStatus', 'policy', 'recentEvents']) {
    assert.ok(flat.includes(key), `describes the ${key} response field`);
  }
  assert.ok(/workspaceId/.test(flat), 'mentions the optional workspaceId');
  assert.ok(/CLAUDE_CONFIG_DIR/.test(flat), 'says the daemon sets CLAUDE_CONFIG_DIR per account');
  assert.ok(/settings\.json/.test(flat), 'says the proxy already honours it for settings.json');
  assert.ok(/~\/\.claude/.test(flat), 'says the session administration stays in ~/.claude');
});

// ── README ───────────────────────────────────────────────────────────────────

test('README mentions get_account_pool', () => {
  assert.ok(read('README.md').includes('get_account_pool'));
});
