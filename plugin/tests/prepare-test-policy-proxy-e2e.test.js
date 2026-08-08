'use strict';

//
// prepare-test-policy-proxy-e2e.test.js — KBT-B551 / KBT-TC3433 (real-proxy E2E)
//
// Drives the REAL bundled MCP proxy (plugin/proxy/kanbantic-mcp-proxy.js) as a
// separate process against a stub backend that keeps an actual per-issue policy
// record, and replays exactly the call-sequence the repaired prepare steps
// 5F.5 / 5B.6 prescribe: three `set_test_policy` calls (Unit / Integration /
// E2E), then the Step 6.1 `get_test_policy` read-back.
//
// Why E2E is Required here — the third E2E condition (ADM-TRUL015). The changed
// artifact is a SKILL.md from the plugin skill-tree: a file a runtime (Claude
// Code) reads AT STARTUP. There is no UI surface and no public API surface, but
// that third condition alone keeps the level Required. That is exactly the trap
// KBT-B531 and KBT-B532 fell into — a skill-file change feels like documentation
// while it is in fact runtime-loaded configuration.
//
// So the assertion is NOT "the file is correct" (the unit cases in
// prepare-test-policy-record.test.js cover that) but "the chain the file
// prescribes works end-to-end". Follows the house convention set by
// wireframe-proxy-e2e.test.js: the step "the agent follows the SKILL.md prose"
// is inherently not automatable; what IS automatable is the tool contract that
// prose leans on — and that is the layer where this bug was fatal. A prescribed
// call-shape the proxy mangles or drops would produce the same silent class of
// failure the fix exists to remove.
//
// Zero deps — node built-ins only. No real Kanbantic backend, no API key: the
// stub listens on 127.0.0.1 on a free port.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');
const INIT_PARAMS = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } };

function jsonContent(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// Stub that behaves like the real policy surface: set_test_policy writes a
// per-level record, get_test_policy returns what was written. Defaults mirror
// the server (all three Required, min 1) so a MISSING set_test_policy call is
// visible as "still on the defaults" — the exact signature of KBT-B551.
function makePolicyBackend() {
  const records = new Map(); // issueId -> { level -> record }

  function defaults() {
    return {
      Unit: { level: 'Unit', applicability: 'Required', minCount: 1, isFrozen: false },
      Integration: { level: 'Integration', applicability: 'Required', minCount: 1, isFrozen: false },
      E2E: { level: 'E2E', applicability: 'Required', minCount: 1, isFrozen: false },
    };
  }

  return {
    set(args) {
      const { issueId, level, applicability, minimumCount, notApplicableReason } = args || {};
      if (!issueId || !level || !applicability) {
        return { success: false, error: 'issueId, level and applicability are required' };
      }
      if (applicability === 'NotApplicable' && !notApplicableReason) {
        return { success: false, error: 'notApplicableReason is required for NotApplicable' };
      }
      if (!records.has(issueId)) records.set(issueId, defaults());
      const rec = {
        level,
        applicability,
        minCount: applicability === 'NotApplicable' ? 0 : (minimumCount == null ? 1 : minimumCount),
        isFrozen: false,
      };
      if (notApplicableReason) rec.notApplicableReason = notApplicableReason;
      records.get(issueId)[level] = rec;
      return { success: true, policies: [rec] };
    },
    get(args) {
      const issueId = args && args.issueId;
      const byLevel = records.get(issueId) || defaults();
      return { success: true, policies: ['Unit', 'Integration', 'E2E'].map((l) => byLevel[l]) };
    },
  };
}

function startStub(backend) {
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
      const msg = JSON.parse(body);
      const name = msg.params && msg.params.name;
      const args = msg.params && msg.params.arguments;
      received.push({ method: msg.method, name, args });

      res.setHeader('Mcp-Session-Id', req.headers['mcp-session-id'] || 'stub-session');
      res.setHeader('Content-Type', 'application/json');

      if (msg.method === 'initialize') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } },
        }));
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }

      let result;
      if (name === 'set_test_policy') result = jsonContent(backend.set(args));
      else if (name === 'get_test_policy') result = jsonContent(backend.get(args));
      else result = jsonContent({ success: true, echo: name || msg.method });

      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

function spawnProxy(port) {
  const env = { ...process.env, KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`, KANBANTIC_API_KEY: 'test-key' };
  for (const k of ['KANBANTIC_WORKSPACE_ID', 'KANBANTIC_WORKSTATION_ID', 'KANBANTIC_HOST', 'KANBANTIC_SPAWN_COMMAND_ID']) delete env[k];
  const child = spawn(process.execPath, [PROXY_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const pending = new Map();
  let buf = '';
  let stderr = '';
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
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderr += c));
  const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  function rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const t = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC timeout ${method} (id=${id}). stderr: ${stderr}`)); }
      }, 10000);
      if (typeof t.unref === 'function') t.unref();
    });
  }
  async function shutdown() { child.stdin.end(); return exitPromise; }
  return { rpc, shutdown, getStderr: () => stderr };
}

function parseToolResult(resp) {
  return JSON.parse(resp.result.content[0].text);
}

// The exact sequence steps 5F.5 / 5B.6 prescribe, then the Step 6.1 read-back.
async function declarePolicy(rpc, issueId, declaration, idBase) {
  let id = idBase;
  for (const d of declaration) {
    const args = { issueId, level: d.level, applicability: d.applicability };
    if (d.applicability === 'NotApplicable') args.notApplicableReason = d.notApplicableReason;
    else args.minimumCount = d.minimumCount;
    const resp = await rpc('tools/call', { name: 'set_test_policy', arguments: args }, id++);
    const r = parseToolResult(resp);
    assert.equal(r.success, true, `set_test_policy(${d.level}) failed: ${JSON.stringify(r)}`);
  }
  const readBack = await rpc('tools/call', { name: 'get_test_policy', arguments: { issueId } }, id++);
  return parseToolResult(readBack);
}

// ---------------------------------------------------------------------------
// KBT-TC3433 — the prescribed call-shape survives the real proxy intact
// ---------------------------------------------------------------------------

test('KBT-TC3433: the prescribed set_test_policy sequence reaches the backend with arguments intact', async () => {
  const backend = makePolicyBackend();
  const stub = await startStub(backend);
  const proxy = spawnProxy(stub.port);
  const ISSUE = 'KBT-B551';

  // A ≥20-char reason, as 5F.5 requires — and long enough that any truncation
  // on the way through the proxy would be visible.
  const REASON = 'Pure Markdown-skillwijziging zonder service- of DB-aanroepen; er is geen integratieoppervlak om te raken.';

  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);

    const policy = await declarePolicy(proxy.rpc, ISSUE, [
      { level: 'Unit', applicability: 'Required', minimumCount: 2 },
      { level: 'Integration', applicability: 'NotApplicable', notApplicableReason: REASON },
      { level: 'E2E', applicability: 'Required', minimumCount: 1 },
    ], 10);

    // ── the record round-trips: declaration → record → read-back ─────────────
    assert.equal(policy.success, true);
    const byLevel = Object.fromEntries(policy.policies.map((p) => [p.level, p]));

    // minCount 2 (not the default 1) proves the record was actually WRITTEN.
    // This is the single value that stays at 1 when set_test_policy is never
    // called — the whole of KBT-B551 in one assertion.
    assert.equal(byLevel.Unit.applicability, 'Required');
    assert.equal(byLevel.Unit.minCount, 2, 'Unit must reflect the declared minimum, not the default');

    assert.equal(byLevel.Integration.applicability, 'NotApplicable');
    assert.equal(byLevel.Integration.notApplicableReason, REASON, 'the N.v.t. reason must survive the proxy unmodified');

    assert.equal(byLevel.E2E.applicability, 'Required');
    assert.equal(byLevel.E2E.minCount, 1);

    // ── the proxy forwarded three writes, one per level, nothing dropped ─────
    const writes = stub.received.filter((r) => r.name === 'set_test_policy');
    assert.equal(writes.length, 3, 'exactly three set_test_policy calls must reach the backend — one per level');
    assert.deepEqual(
      writes.map((w) => w.args.level).sort(),
      ['E2E', 'Integration', 'Unit'],
      'every level must be set explicitly; an omitted level silently keeps the server default'
    );
    for (const w of writes) {
      assert.equal(w.args.issueId, ISSUE, 'issueId must arrive intact');
      assert.ok(w.args.applicability, 'applicability must arrive intact');
    }

    const naWrite = writes.find((w) => w.args.applicability === 'NotApplicable');
    assert.ok(naWrite, 'the NotApplicable write must be present');
    assert.equal(naWrite.args.notApplicableReason, REASON, 'notApplicableReason must not be dropped or truncated in transit');

    // ── Step 6.1 actually issues a read-back ────────────────────────────────
    const reads = stub.received.filter((r) => r.name === 'get_test_policy');
    assert.equal(reads.length, 1, 'Step 6.1 must read the record back exactly once');
    assert.equal(reads[0].args.issueId, ISSUE);
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});

test('KBT-TC3433 (counterfactual): skipping set_test_policy leaves the record on the defaults', async () => {
  // The pre-fix behaviour, reproduced through the real proxy. Writing only a
  // Decision-entry (here: no policy call at all) leaves every level at
  // Required/min 1 — which is what claim_issue then freezes.
  //
  // Scope note, deliberately not overstated: the returned defaults come from the
  // stub, so that half is thin. The load-bearing assertion is the last one — the
  // proxy forwarded the read and fabricated no write of its own.
  const backend = makePolicyBackend();
  const stub = await startStub(backend);
  const proxy = spawnProxy(stub.port);

  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);

    const resp = await proxy.rpc('tools/call', { name: 'get_test_policy', arguments: { issueId: 'KBT-B531' } }, 10);
    const policy = parseToolResult(resp);

    assert.equal(policy.success, true);
    for (const p of policy.policies) {
      assert.equal(p.applicability, 'Required', `${p.level} silently stays Required without a set_test_policy call`);
      assert.equal(p.minCount, 1, `${p.level} silently stays at min 1 without a set_test_policy call`);
    }
    assert.equal(
      stub.received.filter((r) => r.name === 'set_test_policy').length, 0,
      'counterfactual: no policy write happened'
    );
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});
