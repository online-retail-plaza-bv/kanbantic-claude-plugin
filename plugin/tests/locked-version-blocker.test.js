'use strict';

//
// locked-version-blocker.test.js — KBT-F320 / KBT-T2421 / KBT-TC2362
//
// Integration test for the PreToolUse hook
// `plugin/hooks/pre-tool-use-locked-version-blocker.js`. Stubs a local MCP
// HTTP server (same technique as check-drift.test.js) that answers
// `issue_version_lookup` with a configurable lifecycleStatus, feeds the hook a
// `claim_issue` PreToolUse payload on stdin, and asserts:
//   - locked Version (StagingDeployed / Released) ⇒ exit 2 + block message.
//   - unlocked Version (InProgress) ⇒ exit 0 (allow).
//   - non-claim tool ⇒ exit 0 (allow).
//   - no API key ⇒ fail-open exit 0.
// Plus pure-helper unit assertions on the lifecycle ordering.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOOK = path.resolve(
  __dirname,
  '..',
  'hooks',
  'pre-tool-use-locked-version-blocker.js'
);

const {
  isClaimIssue,
  isLockedStatus,
  unwrapToolResult,
} = require('../hooks/pre-tool-use-locked-version-blocker.js');

// MCP stub: answers initialize + a tools/call for issue_version_lookup with a
// version of the given lifecycleStatus (relation DeliveredIn).
function startStub(lifecycleStatus, versionName = 'v1.5.0') {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      return res.end();
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
        return res.end();
      }
      const sessionId =
        req.headers['mcp-session-id'] ||
        `stub-${Math.random().toString(36).slice(2, 8)}`;
      res.setHeader('Mcp-Session-Id', sessionId);
      res.setHeader('Content-Type', 'application/json');
      let result;
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub', version: '1.0.0' },
        };
      } else if (msg.method === 'tools/call') {
        const payload = {
          success: true,
          issueId: msg.params && msg.params.arguments && msg.params.arguments.issueId,
          versions: [
            {
              id: 'ver-1',
              name: versionName,
              number: 1,
              lifecycleStatus,
              relation: 'DeliveredIn',
            },
          ],
        };
        result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
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

function runHook({ port, payload, apiKey = 'test-key' }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (port) env.KANBANTIC_MCP_URL = `http://127.0.0.1:${port}/mcp`;
    if (apiKey === null) delete env.KANBANTIC_API_KEY;
    else env.KANBANTIC_API_KEY = apiKey;
    const child = spawn(process.execPath, [HOOK], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const claimPayload = {
  hook_event_name: 'PreToolUse',
  tool_name: 'mcp__plugin_kanbantic-claude-plugin_kanbantic__claim_issue',
  tool_input: { issueId: 'KBT-F999' },
};

test('block: claim_issue on StagingDeployed Version → exit 2 + message', async () => {
  const stub = await startStub('StagingDeployed');
  try {
    const r = await runHook({ port: stub.port, payload: claimPayload });
    assert.equal(r.code, 2, `expected exit 2; got ${r.code}. stderr=${r.stderr}`);
    const combined = r.stdout + r.stderr;
    assert.match(combined, /Locked Version v1\.5\.0 \(status StagingDeployed\)/);
    assert.match(combined, /klaim niet toegestaan na lock-on-deploy/);
  } finally {
    stub.server.close();
  }
});

test('block: claim_issue on Released Version → exit 2', async () => {
  const stub = await startStub('Released', 'v2.0.0');
  try {
    const r = await runHook({ port: stub.port, payload: claimPayload });
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /Locked Version v2\.0\.0 \(status Released\)/);
  } finally {
    stub.server.close();
  }
});

test('allow: claim_issue on InProgress Version → exit 0 (silent)', async () => {
  const stub = await startStub('InProgress');
  try {
    const r = await runHook({ port: stub.port, payload: claimPayload });
    assert.equal(r.code, 0, `expected exit 0; got ${r.code}. stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), '');
  } finally {
    stub.server.close();
  }
});

test('allow: non-claim tool is ignored (no network call needed)', async () => {
  const r = await runHook({
    port: undefined,
    payload: {
      tool_name: 'mcp__plugin_kanbantic-claude-plugin_kanbantic__get_issue',
      tool_input: { issueId: 'KBT-F999' },
    },
  });
  assert.equal(r.code, 0);
});

test('fail-open: no API key → allow even for claim_issue', async () => {
  const r = await runHook({ port: 1, payload: claimPayload, apiKey: null });
  assert.equal(r.code, 0);
});

// ---- pure-helper units ----
test('helper: isClaimIssue matches proxy + bare forms, rejects others', () => {
  assert.ok(isClaimIssue('mcp__plugin_kanbantic-claude-plugin_kanbantic__claim_issue'));
  assert.ok(isClaimIssue('mcp__kanbantic__claim_issue'));
  assert.ok(isClaimIssue('claim_issue'));
  assert.ok(!isClaimIssue('mcp__kanbantic__get_issue'));
  assert.ok(!isClaimIssue('unclaim_issue_extra'));
});

test('helper: isLockedStatus threshold at StagingDeployed', () => {
  assert.ok(!isLockedStatus('Planned'));
  assert.ok(!isLockedStatus('InProgress'));
  assert.ok(!isLockedStatus('Frozen'));
  assert.ok(isLockedStatus('StagingDeployed'));
  assert.ok(isLockedStatus('Released'));
  assert.ok(isLockedStatus('Archived'));
  assert.ok(!isLockedStatus('Bogus')); // unknown ⇒ fail-open
});

test('helper: unwrapToolResult parses MCP text content-block', () => {
  const out = unwrapToolResult({
    result: { content: [{ type: 'text', text: '{"success":true,"versions":[]}' }] },
  });
  assert.deepEqual(out, { success: true, versions: [] });
  assert.equal(unwrapToolResult(null), null);
  assert.equal(unwrapToolResult({ result: { content: [{ type: 'text', text: 'nope' }] } }), null);
});
