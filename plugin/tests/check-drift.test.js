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
const fs = require('node:fs');
const os = require('node:os');
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

// KBT-B483 — write a throwaway snapshot so the comparison is deterministic and
// never depends on the real known-mcp-tools.json (which legitimately changes).
function mkSnapshot(tools, curatedOut) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b483-snap-'));
  const file = path.join(dir, 'known-mcp-tools.json');
  const body = { generatedAt: '2026-01-01', source: 'test fixture', tools };
  if (curatedOut !== undefined) body.curatedOut = curatedOut;
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return { dir, file };
}

function rmSnapshot(snap) {
  try {
    fs.rmSync(snap.dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function runScript(port, opts) {
  const { snapshot, strict } = opts || {};
  return new Promise((resolve) => {
    const args = [SCRIPT_PATH];
    if (strict) args.push('--strict');
    const env = {
      ...process.env,
      KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      KANBANTIC_API_KEY: 'test-key',
    };
    if (snapshot) env.KANBANTIC_TOOLS_SNAPSHOT = snapshot;
    // Never inherit a strict flag from the ambient environment.
    delete env.KANBANTIC_DRIFT_STRICT;
    const child = spawn(process.execPath, args, {
      env,
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
  // KBT-B483 — snapshot matching the stub exactly, so the new comparison stays
  // silent here and this test keeps testing only the MUST-HAVE verdict.
  const snap = mkSnapshot(
    ['approve_review', 'complete_run_review', 'extra_tool', 'start_run_review'],
    []
  );
  try {
    const result = await runScript(stub.port, { snapshot: snap.file });
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
    rmSnapshot(snap);
  }
});

test('drift-detector: negative case — approve_review missing → exit 1', async () => {
  const stub = await startStub([
    // approve_review intentionally absent
    'start_run_review',
    'complete_run_review',
    'extra_tool',
  ]);
  const snap = mkSnapshot(['complete_run_review', 'extra_tool', 'start_run_review'], []);
  try {
    const result = await runScript(stub.port, { snapshot: snap.file });
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
    rmSnapshot(snap);
  }
});

// ---------------------------------------------------------------------------
// KBT-TC3292 (KBT-B483 / KBT-SR586) — snapshot vs live comparison.
//
// Before B483 this script checked three MUST_HAVE names and nothing else, so it
// reported "OK ... 222 total exposed" while known-mcp-tools.json was missing 8
// live tools. These tests pin the behaviour a guard needs: it must be able to
// fail when the snapshot is behind.
// ---------------------------------------------------------------------------

const MUST = ['approve_review', 'start_run_review', 'complete_run_review'];

test('KBT-TC3292 — live tool absent from snapshot: warns, exit 0 (advisory default)', async () => {
  const stub = await startStub([...MUST, 'brand_new_tool']);
  const snap = mkSnapshot([...MUST].sort(), []);
  try {
    const result = await runScript(stub.port, { snapshot: snap.file });
    assert.strictEqual(result.code, 0, `advisory default must not block; stderr: ${result.stderr}`);
    assert.match(result.stdout, /snapshot drift \(advisory\)/, 'labels itself advisory');
    assert.match(result.stdout, /brand_new_tool/, 'names the missing tool');
    assert.match(result.stdout, /1 live tool\(s\) missing/, 'counts the backlog');
  } finally {
    stub.server.close();
    rmSnapshot(snap);
  }
});

test('KBT-TC3292 — same backlog with --strict: exit 1', async () => {
  const stub = await startStub([...MUST, 'brand_new_tool']);
  const snap = mkSnapshot([...MUST].sort(), []);
  try {
    const result = await runScript(stub.port, { snapshot: snap.file, strict: true });
    assert.strictEqual(result.code, 1, 'strict must block');
    assert.match(result.stderr, /SNAPSHOT DRIFT/, 'stderr carries the strict label');
    assert.match(result.stderr, /brand_new_tool/, 'names the missing tool');
  } finally {
    stub.server.close();
    rmSnapshot(snap);
  }
});

test('KBT-TC3292 — curatedOut suppresses the warning for deliberate exclusions', async () => {
  // create_release exists live but is deliberately excluded — the exact case
  // that used to be indistinguishable from a forgotten name.
  const stub = await startStub([...MUST, 'create_release']);
  const snap = mkSnapshot([...MUST].sort(), ['create_release']);
  try {
    const result = await runScript(stub.port, { snapshot: snap.file, strict: true });
    assert.strictEqual(result.code, 0, 'a curated-out tool is not drift, even under --strict');
    assert.doesNotMatch(result.stdout, /drift/i, 'no drift warning for curated exclusions');
  } finally {
    stub.server.close();
    rmSnapshot(snap);
  }
});

test('KBT-TC3292 — phantom name in snapshot that is not live: warns, blocks under --strict', async () => {
  const stub = await startStub([...MUST]);
  const snap = mkSnapshot([...MUST, 'ghost_tool'].sort(), []);
  try {
    const advisory = await runScript(stub.port, { snapshot: snap.file });
    assert.strictEqual(advisory.code, 0);
    assert.match(advisory.stdout, /ghost_tool/, 'names the phantom');
    assert.match(advisory.stdout, /no longer live/, 'explains what a phantom is');

    const strict = await runScript(stub.port, { snapshot: snap.file, strict: true });
    assert.strictEqual(strict.code, 1, 'strict blocks on phantoms too');
  } finally {
    stub.server.close();
    rmSnapshot(snap);
  }
});

test('KBT-TC3292 — a name in both tools and curatedOut always fails, even without --strict', async () => {
  const stub = await startStub([...MUST, 'create_release']);
  const snap = mkSnapshot([...MUST, 'create_release'].sort(), ['create_release']);
  try {
    const result = await runScript(stub.port, { snapshot: snap.file });
    assert.strictEqual(result.code, 1, 'an internally inconsistent snapshot is never advisory');
    assert.match(result.stderr, /INCONSISTENT SNAPSHOT/);
    assert.match(result.stderr, /create_release/);
  } finally {
    stub.server.close();
    rmSnapshot(snap);
  }
});

test('KBT-TC3292 — snapshot exactly covering live: silent, exit 0 in both modes', async () => {
  const stub = await startStub([...MUST, 'extra_tool', 'create_release']);
  const snap = mkSnapshot([...MUST, 'extra_tool'].sort(), ['create_release']);
  try {
    for (const strict of [false, true]) {
      const result = await runScript(stub.port, { snapshot: snap.file, strict });
      assert.strictEqual(result.code, 0, `expected exit 0 (strict=${strict})`);
      assert.doesNotMatch(result.stdout, /drift/i, `no drift output (strict=${strict})`);
    }
  } finally {
    stub.server.close();
    rmSnapshot(snap);
  }
});

test('KBT-TC3292 — auth failure stays exit 2 and is not reported as drift', async () => {
  // 401 from the stub: "could not check" must remain distinct from "checked and
  // it drifted", which is why exit code 2 exists.
  const server = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end('unauthorized');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const snap = mkSnapshot([...MUST].sort(), []);
  try {
    const result = await runScript(port, { snapshot: snap.file, strict: true });
    assert.strictEqual(result.code, 2, 'infrastructure failure is exit 2');
    assert.doesNotMatch(result.stdout + result.stderr, /SNAPSHOT DRIFT/, 'must not claim drift');
  } finally {
    server.close();
    rmSnapshot(snap);
  }
});

test('KBT-TC3292 — unreadable snapshot skips the comparison without inventing drift', async () => {
  const stub = await startStub([...MUST, 'whatever']);
  try {
    const result = await runScript(stub.port, {
      snapshot: path.join(os.tmpdir(), 'kbt-b483-does-not-exist', 'known-mcp-tools.json'),
      strict: true,
    });
    // MUST-HAVE verdict still stands on its own.
    assert.strictEqual(result.code, 0, 'a missing snapshot must not fail the MUST-HAVE check');
    assert.match(result.stderr, /snapshot unreadable/, 'says why it skipped');
    assert.doesNotMatch(result.stdout + result.stderr, /SNAPSHOT DRIFT/);
  } finally {
    stub.server.close();
  }
});
