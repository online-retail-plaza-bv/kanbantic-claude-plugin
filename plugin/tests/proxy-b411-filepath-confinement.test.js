'use strict';

//
// KBT-B411 — confinement of the local filePath read channel.
//
// resolveFilePathArgument reads filePath from disk and forwards the bytes to the
// remote server through a channel kept out of the model transcript (KBT-F464). A
// prompt-injected filePath could point at a secret and exfiltrate it invisibly.
// The hardening canonicalizes the path (defeats symlink escape), caps the size,
// refuses known secret/credential files, and audits every read to stderr.
//
// Zero deps — node:test only, matching the repo's other proxy tests.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');
const {
  resolveFilePathArgument,
  screenFilePathRead,
  secretFileReason,
  MAX_FILEPATH_BYTES,
} = require(PROXY_PATH);

let counter = 0;
function tmpDir() {
  const d = path.join(os.tmpdir(), `kbt-b411-${process.pid}-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writeFile(dir, name, content = 'x') {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
function callMsg(filePath, tool = 'add_discussion_entry') {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { filePath } } };
}

// ── secretFileReason (pure) ────────────────────────────────────────────────

test('secretFileReason flags credential basenames, dotenv, key extensions and sensitive dirs', () => {
  assert.ok(secretFileReason('/home/u/.ssh/id_rsa'));            // segment + basename
  assert.ok(secretFileReason('C:/Users/u/project/.env'));       // dotenv
  assert.ok(secretFileReason('C:/Users/u/project/.env.production')); // dotenv variant
  assert.ok(secretFileReason('/home/u/certs/server.pem'));      // key extension
  assert.ok(secretFileReason('/home/u/.aws/credentials'));      // sensitive dir + basename
  assert.equal(secretFileReason('/home/u/project/wireframe.html'), null); // legit
});

// ── screenFilePathRead (I/O) ───────────────────────────────────────────────

test('screenFilePathRead refuses a .env file and does not surface its bytes', () => {
  const dir = tmpDir();
  const secret = writeFile(dir, '.env', 'API_KEY=supersecret');
  const res = screenFilePathRead(secret, 'add_discussion_entry');
  assert.ok(res.error, 'expected refusal');
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /Refused to read/);
  assert.equal(res.path, undefined);
});

test('screenFilePathRead refuses an id_rsa private key and a .pem certificate', () => {
  const dir = tmpDir();
  for (const name of ['id_rsa', 'server.pem']) {
    const p = writeFile(dir, name, 'KEY');
    const res = screenFilePathRead(p, 'add_issue_attachment');
    assert.ok(res.error, `expected refusal for ${name}`);
    assert.match(res.error.message, /Refused to read/);
  }
});

test('screenFilePathRead refuses a path traversing a .ssh directory', () => {
  const dir = tmpDir();
  const p = writeFile(dir, path.join('.ssh', 'notes.txt'), 'x');
  const res = screenFilePathRead(p, 'add_discussion_entry');
  assert.ok(res.error);
  assert.match(res.error.message, /sensitive directory/);
});

test('screenFilePathRead refuses a file over the size cap', () => {
  const dir = tmpDir();
  const p = writeFile(dir, 'huge.html', 'x');
  fs.truncateSync(p, MAX_FILEPATH_BYTES + 1); // sparse — instant
  const res = screenFilePathRead(p, 'add_wireframe_version');
  assert.ok(res.error);
  assert.match(res.error.message, /over the/);
});

test('screenFilePathRead resolves a symlink to a secret and still refuses it', () => {
  const dir = tmpDir();
  const secret = writeFile(dir, '.env', 'SECRET=1');
  const link = path.join(dir, 'innocent.html');
  try {
    fs.symlinkSync(secret, link);
  } catch (e) {
    // Windows without privilege can't create symlinks — the realpath/denylist logic
    // is already covered by the direct-path tests above.
    return;
  }
  const res = screenFilePathRead(link, 'add_wireframe_version');
  assert.ok(res.error, 'symlink to a secret must be refused after realpath');
  assert.match(res.error.message, /Refused to read/);
});

test('screenFilePathRead allows a normal file and returns its canonical path + size', () => {
  const dir = tmpDir();
  const p = writeFile(dir, 'wireframe.html', '<html><body>ok</body></html>');
  const res = screenFilePathRead(p, 'add_wireframe_version');
  assert.equal(res.error, undefined);
  assert.equal(res.bytes, fs.statSync(p).size);
  assert.ok(res.path && fs.existsSync(res.path));
});

test('screenFilePathRead reports a missing file as a read error (unchanged contract)', () => {
  const res = screenFilePathRead(path.join(os.tmpdir(), 'does-not-exist-kbt-b411.html'), 'add_discussion_entry');
  assert.ok(res.error);
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /Failed to read/);
});

// ── resolveFilePathArgument end-to-end ─────────────────────────────────────

test('resolveFilePathArgument refuses a secret filePath and does NOT forward it', () => {
  const dir = tmpDir();
  const secret = writeFile(dir, '.env', 'TOKEN=abc');
  const msg = callMsg(secret);
  const result = resolveFilePathArgument(msg);
  assert.ok(result.error, 'must return a JSON-RPC error, not mutate/forward');
  assert.match(result.error.message, /Refused to read/);
  // Original args are untouched (nothing read into content).
  assert.equal(msg.params.arguments.content, undefined);
  assert.equal(msg.params.arguments.filePath, secret);
});

test('resolveFilePathArgument still reads a legit file into content and drops filePath', () => {
  const dir = tmpDir();
  const body = '<html><body>legit wireframe</body></html>';
  const file = writeFile(dir, 'wf.html', body);
  const msg = callMsg(file, 'add_wireframe_version');
  const result = resolveFilePathArgument(msg);
  assert.deepEqual(result, { mutated: true });
  assert.equal(msg.params.arguments.content, body);
  assert.equal(msg.params.arguments.filePath, undefined);
});

// ===========================================================================
// Spawn harness — drives the REAL proxy process over stdio against a stub HTTP
// backend, so the confinement is proven at the process boundary (mirrors the
// harness in proxy-filepath.test.js).
// ===========================================================================

function startStubBackend() {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.statusCode = 404; res.end('nf'); return; }
    let body = ''; req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg; try { msg = JSON.parse(body); } catch { res.statusCode = 400; res.end('bad'); return; }
      received.push({ method: msg.method, params: msg.params, id: msg.id });
      const sid = req.headers['mcp-session-id'] || `stub-${process.pid}`;
      res.setHeader('Mcp-Session-Id', sid);
      res.setHeader('Content-Type', 'application/json');
      if (msg.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
      let result;
      if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } };
      else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      else result = { content: [{ type: 'text', text: JSON.stringify({ success: false }) }] };
      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

function spawnProxy(port) {
  const child = spawn(process.execPath, [PROXY_PATH], {
    env: { ...process.env, KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`, KANBANTIC_API_KEY: 'test-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { const r = pending.get(msg.id); pending.delete(msg.id); r(msg); }
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderr += c));
  function rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const t = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC timeout: ${method}. stderr: ${stderr}`)); } }, 10000);
      if (typeof t.unref === 'function') t.unref();
    });
  }
  return { child, rpc, getStderr: () => stderr };
}

async function initProxy(p) {
  await p.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'b411-test', version: '1.0.0' } }, 1);
}
function teardown(p, stub) {
  p.child.stdin.end();
  if (p.child.exitCode == null && !p.child.killed) p.child.kill('SIGKILL');
  stub.server.close();
}

// ── Integration — secret filePath refused through the real proxy process ────

test('KBT-B411 (integration): a secret filePath is refused by the real proxy and NEVER forwarded', async () => {
  const stub = await startStubBackend();
  const p = spawnProxy(stub.port);
  const dir = tmpDir();
  const secret = writeFile(dir, '.env', 'TOKEN=supersecret');
  try {
    await initProxy(p);
    const resp = await p.rpc('tools/call',
      { name: 'add_discussion_entry', arguments: { issueId: 'KBT-B411', filePath: secret } }, 2);
    assert.ok(resp.error, 'proxy must answer with a JSON-RPC error');
    assert.match(resp.error.message, /Refused to read/);
    const forwarded = stub.received.find((r) => r.method === 'tools/call');
    assert.equal(forwarded, undefined, 'the secret-bearing call must never reach the backend');
    // The secret bytes must not appear anywhere the backend saw.
    assert.equal(JSON.stringify(stub.received).includes('supersecret'), false);
  } finally {
    teardown(p, stub);
  }
});

// ── E2E — full stdio round-trip: legit forwarded, oversized refused ─────────

test('KBT-B411 (e2e): a legit filePath is read + forwarded; an oversized one is refused', async () => {
  const stub = await startStubBackend();
  const p = spawnProxy(stub.port);
  const dir = tmpDir();
  const legit = writeFile(dir, 'wf.html', '<html><body>legit</body></html>');
  const huge = writeFile(dir, 'huge.html', 'x');
  fs.truncateSync(huge, MAX_FILEPATH_BYTES + 1);
  try {
    await initProxy(p);

    const ok = await p.rpc('tools/call',
      { name: 'add_wireframe_version', arguments: { wireframeId: 'wf-1', filePath: legit } }, 2);
    assert.equal(JSON.parse(ok.result.content[0].text).success, true, 'legit call is forwarded and succeeds');
    const call = stub.received.find((r) => r.method === 'tools/call');
    assert.ok(call, 'backend received the legit call');
    assert.equal(call.params.arguments.content, '<html><body>legit</body></html>');
    assert.equal('filePath' in call.params.arguments, false);

    const big = await p.rpc('tools/call',
      { name: 'add_wireframe_version', arguments: { wireframeId: 'wf-2', filePath: huge } }, 3);
    assert.ok(big.error, 'oversized filePath is refused');
    assert.match(big.error.message, /over the/);
  } finally {
    teardown(p, stub);
  }
});
