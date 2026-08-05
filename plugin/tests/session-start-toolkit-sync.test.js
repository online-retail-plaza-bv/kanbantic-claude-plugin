'use strict';

//
// session-start-toolkit-sync.test.js — KBT-F637
//   KBT-TC3412 (Integration) — every failure path exits 0 and writes nothing
//   KBT-TC3413 (real-proxy E2E) — the real hook against a stub MCP backend
//
// The E2E follows the house convention set by wireframe-proxy-e2e.test.js:
// drive the REAL script against a stub backend over HTTP on a local port via
// KANBANTIC_MCP_URL. No network, no external deps — node built-ins only.
//
// The hook is spawned as a separate process throughout, never require()d. That
// is deliberate: an unhandled rejection or a stray process.exit only shows up
// in a real exit code, and the exit code is the entire contract here.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'session-start-toolkit-sync.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkRepo({ withClaudeDir = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f637-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'ignore' });
  if (withClaudeDir) fs.mkdirSync(path.join(dir, '.claude'));
  return dir;
}

function mkPlainDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f637-plain-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run the hook as a child process and resolve with its result.
 *
 * Deliberately async `spawn`, not `spawnSync`: the stub backend lives in this
 * same process, and spawnSync blocks the event loop — the server would never
 * accept the connection and every request would "time out" against a stub that
 * was never listening. Same reason wireframe-proxy-e2e.test.js spawns async.
 */
function runHook(cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd,
      env: {
        ...process.env,
        // Default to "unconfigured" so each test opts in to what it needs. An
        // explicitly-empty key means no key and must not reach the registry.
        KANBANTIC_API_KEY: '',
        KANBANTIC_WORKSPACE_ID: '',
        KANBANTIC_MCP_URL: 'http://127.0.0.1:1/mcp',
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    // A ceiling well above the hook's own request timeout: if the hook ever
    // blocks, we want a failed assertion rather than a run that hangs forever.
    const guard = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (status, signal) => {
      clearTimeout(guard);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

/** Files written under .claude/ — the thing that must stay untouched on failure. */
function claudeFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else out.push(r);
    }
  };
  walk(path.join(root, '.claude'), '');
  return out.sort();
}

// ---------------------------------------------------------------------------
// KBT-TC3412 (Integration) — fail-safe: always exit 0, never a partial write
// ---------------------------------------------------------------------------

test('KBT-TC3412 stap 1: geen git-repo → exit 0', async () => {
  const dir = mkPlainDir();
  try {
    const r = await runHook(dir);
    assert.equal(r.status, 0);
  } finally { cleanup(dir); }
});

test('KBT-TC3412 stap 2: git-repo zonder API-key → exit 0', async () => {
  const dir = mkRepo();
  try {
    const r = await runHook(dir, { KANBANTIC_API_KEY: '' });
    assert.equal(r.status, 0);
    assert.deepEqual(claudeFiles(dir), []);
  } finally { cleanup(dir); }
});

test('KBT-TC3412 stap 3: gesloten poort → exit 0, niets geschreven', async () => {
  const dir = mkRepo();
  try {
    const r = await runHook(dir, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: 'http://127.0.0.1:1/mcp',
    });
    assert.equal(r.status, 0);
    assert.deepEqual(claudeFiles(dir), []);
  } finally { cleanup(dir); }
});

for (const [label, handler] of [
  ['HTTP 500', (req, res) => { res.writeHead(500); res.end('boom'); }],
  ['onparsebare body', (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('<not json>'); }],
]) {
  test(`KBT-TC3412 stap 4/5: ${label} → exit 0, niets geschreven`, async () => {
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dir = mkRepo();
    try {
      const res = await runHook(dir, {
        KANBANTIC_API_KEY: 'test-key',
        KANBANTIC_WORKSPACE_ID: 'kanbantic',
        KANBANTIC_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`,
      });
      assert.equal(res.status, 0);
      assert.deepEqual(claudeFiles(dir), []);
    } finally {
      cleanup(dir);
      server.close();
    }
  });
}

test('KBT-TC3412 stap 6: server antwoordt nooit → hook eindigt op de time-out, niet op oneindig wachten', async () => {
  // The failure mode that no try/catch can catch. Without a request timeout the
  // hook would hang and every session start on that workstation with it — this
  // test hanging IS the regression signal.
  const held = [];
  const server = http.createServer((req, res) => { held.push(res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkRepo();
  try {
    const res = await runHook(dir, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`,
    });
    assert.equal(res.status, 0, 'must exit cleanly rather than be killed by the harness timeout');
    assert.equal(res.signal, null, 'a signal here means the timeout never fired');
    assert.deepEqual(claudeFiles(dir), []);
  } finally {
    for (const r of held) { try { r.destroy(); } catch (_) { /* already gone */ } }
    cleanup(dir);
    server.close();
  }
});

test('KBT-TC3412 stap 7: workspace onbepaalbaar → exit 0', async () => {
  // A git repo with no remote, no manifest and no workspace override: layer 3
  // finds nothing to match on.
  const dir = mkRepo({ withClaudeDir: true });
  try {
    const r = await runHook(dir, { KANBANTIC_API_KEY: '' });
    assert.equal(r.status, 0);
  } finally { cleanup(dir); }
});

test('KBT-TC3412: geen enkele faalconditie produceert een stacktrace', async () => {
  const dir = mkRepo();
  try {
    const r = await runHook(dir, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: 'http://127.0.0.1:1/mcp',
    });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    assert.doesNotMatch(output, /\s+at\s+.+:\d+:\d+/, 'raw stack frames leaked to the operator');
    assert.doesNotMatch(output, /Error:/);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// KBT-TC3413 (real-proxy E2E) — real hook, stub MCP backend
// ---------------------------------------------------------------------------

function toolkitItem(overrides) {
  return Object.assign({
    id: '00000000-0000-0000-0000-000000000000',
    code: 'KBT-SAGN900',
    category: 'Subagent',
    title: 'Stub Specialist',
    content: 'Stub body line.\n',
    isActive: true,
  }, overrides);
}

/**
 * Stub MCP backend. Records every request so the test can assert on the
 * handshake, and hands back enum *names* the way the real MCP endpoint does.
 */
async function startStub(items) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body); } catch (_) { /* recorded as-is below */ }
      seen.push({ method: msg.method, headers: req.headers, params: msg.params });

      const send = (payload) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'stub-session-1',
        });
        res.end(JSON.stringify(payload));
      };

      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202); res.end();
        return;
      }
      if (msg.method === 'tools/call') {
        const category = msg.params?.arguments?.category;
        const payload = { success: true, items: items.filter((i) => i.category === category) };
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        });
        return;
      }
      res.writeHead(400); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

const E2E_ITEMS = [
  toolkitItem({ code: 'KBT-SAGN901', title: 'Sonnet Stub', content: 'a\n', model: 'Sonnet' }),
  toolkitItem({ code: 'KBT-SAGN902', title: 'Opus Stub', content: 'b\n', model: 'Opus' }),
  toolkitItem({ code: 'KBT-SAGN903', title: 'Haiku Stub', content: 'c\n', model: 'Haiku' }),
  toolkitItem({ code: 'KBT-SKIL901', category: 'Skill', title: '/stub-skill — Stub', content: 'd\n' }),
  toolkitItem({ code: 'KBT-CMND901', category: 'Command', title: 'stub command', content: 'e\n' }),
];

test('KBT-TC3413: hook voert de MCP-handshake en schrijft geldige mirrors', async () => {
  const stub = await startStub(E2E_ITEMS);
  const dir = mkRepo();
  try {
    const r = await runHook(dir, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: stub.url,
    });
    assert.equal(r.status, 0);

    // Stap 2 — handshake volgorde + auth op elk verzoek.
    const methods = stub.seen.map((s) => s.method);
    assert.equal(methods[0], 'initialize');
    assert.equal(methods[1], 'notifications/initialized');
    assert.ok(methods.slice(2).every((m) => m === 'tools/call'));
    for (const req of stub.seen) {
      assert.equal(req.headers.authorization, 'Bearer test-key');
      assert.match(req.headers.accept, /application\/json/);
      assert.match(req.headers.accept, /text\/event-stream/);
    }

    // Stap 3 — de sessie-header uit initialize gaat mee op vervolgverzoeken.
    for (const req of stub.seen.slice(1)) {
      assert.equal(req.headers['mcp-session-id'], 'stub-session-1');
    }

    // Stap 4 — geldige aliassen op schijf, geen getallen; Command niet gemirrord.
    const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
    assert.match(read('.claude/agents/sonnet-stub.md'), /\nmodel: sonnet\n/);
    assert.match(read('.claude/agents/opus-stub.md'), /\nmodel: opus\n/);
    assert.match(read('.claude/agents/haiku-stub.md'), /\nmodel: haiku\n/);
    assert.ok(fs.existsSync(path.join(dir, '.claude/commands/stub-skill.md')));
    for (const f of claudeFiles(dir)) {
      if (!f.endsWith('.md')) continue;
      assert.doesNotMatch(read(path.join('.claude', f)), /\nmodel: \d+\n/, `${f} carries a numeric alias`);
    }
    assert.ok(!claudeFiles(dir).some((f) => /stub-command/.test(f)), 'Command items must stay Toolkit-only');

    // Stap 5 — tweede run is een no-op.
    const before = claudeFiles(dir).map((f) => fs.statSync(path.join(dir, '.claude', f)).mtimeMs);
    const again = await runHook(dir, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: stub.url,
    });
    assert.equal(again.status, 0);
    assert.match(`${again.stdout}`, /unchanged=/);
  } finally {
    cleanup(dir);
    stub.server.close();
  }
});

test('KBT-TC3413 stap 6: handgeschreven hook wordt gemeld, niet herschreven', async () => {
  const stub = await startStub(E2E_ITEMS);
  const dir = mkRepo({ withClaudeDir: true });
  const settings = path.join(dir, '.claude', 'settings.local.json');
  const original = JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/sync-workspace-skills.sh' }] }],
    },
  }, null, 2);
  fs.writeFileSync(settings, original, 'utf8');
  try {
    const r = await runHook(dir, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: stub.url,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /hand-written SessionStart sync/i);
    assert.match(r.stdout, /settings\.local\.json/);
    assert.equal(fs.readFileSync(settings, 'utf8'), original, 'user settings must be left byte-identical');
  } finally {
    cleanup(dir);
    stub.server.close();
  }
});
