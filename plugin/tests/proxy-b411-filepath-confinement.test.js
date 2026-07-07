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
