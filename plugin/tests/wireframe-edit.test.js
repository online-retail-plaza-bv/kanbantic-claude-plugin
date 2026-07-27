'use strict';

//
// KBT-F517 / KBT-E099 — wireframe-edit.mjs (context-free replace/delete → new version).
//
// Two layers, mirroring the repo's existing script/proxy tests:
//   - Unit: dynamically import() the ESM module and exercise the pure transform
//     helpers (applyEdit / encodeLocalFile / normalizeFilesetPath) directly.
//   - Integration: spawn the REAL script against a stub HTTP backend and assert the
//     full GET-current-fileset -> apply-one-change -> POST-new-version flow, that
//     the untouched files round-trip verbatim, and that NO file bytes leak to
//     stdout (only a JSON summary) — the KBT-RL161 context-free guarantee.
//
// Zero deps — node:test, node:assert/strict, node:http, node:child_process,
// node:fs, node:os, node:path. CommonJS (matches the *.test.js glob) with a
// dynamic import() for the ESM script.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'wireframe-edit.mjs');
const importScript = () => import('file://' + SCRIPT.split(path.sep).join('/'));

// ── Unit: pure transform helpers ────────────────────────────────────────────

test('applyEdit: replace mutates only the target file, preserves the rest', async () => {
  const { applyEdit } = await importScript();
  const files = [
    { path: 'index.html', content: '<h1>hi</h1>' },
    { path: 'css/app.css', content: 'a{}' },
  ];
  const r = applyEdit({ files, entryPointPath: 'index.html', op: 'replace', targetPath: 'css/app.css', newContent: 'b{}' });
  assert.equal(r.files.length, 2);
  assert.equal(r.files.find(f => f.path === 'css/app.css').content, 'b{}');
  assert.equal(r.files.find(f => f.path === 'index.html').content, '<h1>hi</h1>'); // untouched
  assert.match(r.summary, /Replace css\/app\.css/);
});

test('applyEdit: replace on a missing path ADDS the file (normalised to POSIX)', async () => {
  const { applyEdit } = await importScript();
  const files = [{ path: 'index.html', content: 'x' }];
  const r = applyEdit({ files, entryPointPath: 'index.html', op: 'replace', targetPath: 'js\\app.js', newContent: 'y' });
  assert.equal(r.files.length, 2);
  assert.ok(r.files.some(f => f.path === 'js/app.js'));
  assert.match(r.summary, /Add js\/app\.js/);
});

test('applyEdit: delete removes the target and keeps the rest', async () => {
  const { applyEdit } = await importScript();
  const files = [
    { path: 'index.html', content: 'x' },
    { path: 'css/app.css', content: 'a{}' },
  ];
  const r = applyEdit({ files, entryPointPath: 'index.html', op: 'delete', targetPath: 'css/app.css' });
  assert.deepEqual(r.files.map(f => f.path), ['index.html']);
});

test('applyEdit: refuses to delete the entry-point', async () => {
  const { applyEdit } = await importScript();
  const files = [{ path: 'index.html', content: 'x' }, { path: 'a.css', content: 'y' }];
  assert.throws(
    () => applyEdit({ files, entryPointPath: 'index.html', op: 'delete', targetPath: 'index.html' }),
    /entry-point/,
  );
});

test('applyEdit: refuses to delete a file not in the fileset', async () => {
  const { applyEdit } = await importScript();
  const files = [{ path: 'index.html', content: 'x' }];
  assert.throws(
    () => applyEdit({ files, entryPointPath: 'index.html', op: 'delete', targetPath: 'nope.css' }),
    /not found/,
  );
});

test('applyEdit: refuses to produce an empty fileset', async () => {
  const { applyEdit } = await importScript();
  const files = [{ path: 'index.html', content: 'x' }];
  // entry-point is elsewhere so the entry-guard does not pre-empt the empty-guard
  assert.throws(
    () => applyEdit({ files, entryPointPath: 'other.html', op: 'delete', targetPath: 'index.html' }),
    /empty fileset/,
  );
});

test('encodeLocalFile: text as-is, binary as base64', async () => {
  const { encodeLocalFile } = await importScript();
  assert.equal(encodeLocalFile('a.css', Buffer.from('a{}')), 'a{}');
  assert.equal(encodeLocalFile('logo.png', Buffer.from([1, 2, 3])), Buffer.from([1, 2, 3]).toString('base64'));
});

test('normalizeFilesetPath: backslashes -> POSIX, strips leading slashes', async () => {
  const { normalizeFilesetPath } = await importScript();
  assert.equal(normalizeFilesetPath('js\\app.js'), 'js/app.js');
  assert.equal(normalizeFilesetPath('/index.html'), 'index.html');
});

// ── Integration: spawn the real script against a stub backend ────────────────

function startStub(wireframeId, currentVersion) {
  let capturedPost = null;
  const server = http.createServer((req, res) => {
    const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === `/api/app/wireframe/${wireframeId}`) {
      return send({ id: wireframeId, latestVersionNumber: currentVersion.versionNumber });
    }
    if (req.method === 'GET' && req.url === `/api/app/wireframe/${wireframeId}/version/${currentVersion.versionNumber}`) {
      return send(currentVersion);
    }
    if (req.method === 'POST' && req.url === `/api/app/wireframe/${wireframeId}/version/files`) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { capturedPost = JSON.parse(body); send({ versionNumber: currentVersion.versionNumber + 1 }); });
      return;
    }
    res.writeHead(404); res.end('no');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, getPost: () => capturedPost }));
  });
}

// Async spawn — the stub HTTP server runs in THIS process, so we must NOT block
// the event loop (spawnSync would deadlock: the child's fetch can't be served).
function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('integration: replace fetches current fileset, swaps one file, POSTs a new version', async () => {
  const wid = '11111111-1111-1111-1111-111111111111';
  const current = {
    versionNumber: 3,
    entryPointPath: 'index.html',
    files: [
      { path: 'index.html', content: '<h1>v3</h1>', contentType: 'text/html' },
      { path: 'css/app.css', content: 'a{color:red}', contentType: 'text/css' },
    ],
  };
  const stub = await startStub(wid, current);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-edit-'));
  const local = path.join(tmp, 'new.css');
  fs.writeFileSync(local, 'a{color:blue}');
  try {
    const r = await runScript([
      '--wireframe', wid, '--replace', 'css/app.css', '--file', local,
      '--summary', 'blue', '--api', `http://127.0.0.1:${stub.port}`, '--token', 'k',
    ]);
    assert.equal(r.status, 0, r.stderr);
    const post = stub.getPost();
    assert.ok(post, 'server received a POST');
    assert.equal(post.entryPointPath, 'index.html');
    assert.equal(post.files.length, 2);
    assert.equal(post.files.find(f => f.path === 'css/app.css').content, 'a{color:blue}'); // replaced
    assert.equal(post.files.find(f => f.path === 'index.html').content, '<h1>v3</h1>'); // untouched, verbatim
    // stdout is a summary only — no file bytes
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(out.versionNumber, 4);
    assert.ok(!r.stdout.includes('color:blue'), 'file bytes must not leak to stdout');
  } finally {
    stub.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('integration: delete drops one file and POSTs the smaller fileset', async () => {
  const wid = '22222222-2222-2222-2222-222222222222';
  const current = {
    versionNumber: 1,
    entryPointPath: 'index.html',
    files: [
      { path: 'index.html', content: '<h1>hi</h1>', contentType: 'text/html' },
      { path: 'extra.js', content: 'console.log(1)', contentType: 'application/javascript' },
    ],
  };
  const stub = await startStub(wid, current);
  try {
    const r = await runScript([
      '--wireframe', wid, '--delete', 'extra.js',
      '--api', `http://127.0.0.1:${stub.port}`, '--token', 'k',
    ]);
    assert.equal(r.status, 0, r.stderr);
    const post = stub.getPost();
    assert.deepEqual(post.files.map(f => f.path), ['index.html']);
    assert.equal(JSON.parse(r.stdout.trim()).versionNumber, 2);
  } finally {
    stub.server.close();
  }
});

test('integration: deleting the entry-point fails without POSTing', async () => {
  const wid = '33333333-3333-3333-3333-333333333333';
  const current = {
    versionNumber: 1,
    entryPointPath: 'index.html',
    files: [{ path: 'index.html', content: 'x', contentType: 'text/html' }, { path: 'a.css', content: 'y', contentType: 'text/css' }],
  };
  const stub = await startStub(wid, current);
  try {
    const r = await runScript([
      '--wireframe', wid, '--delete', 'index.html',
      '--api', `http://127.0.0.1:${stub.port}`, '--token', 'k',
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /entry-point/);
    assert.equal(stub.getPost(), null, 'no POST on validation failure');
  } finally {
    stub.server.close();
  }
});
