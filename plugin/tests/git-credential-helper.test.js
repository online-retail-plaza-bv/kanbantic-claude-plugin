'use strict';

//
// KBT-B330 — git credential helper unit tests.
//
// The helper (`plugin/scripts/kanbantic-git-credential-helper.js`) fetches a
// repository PAT from Kanbantic over the git credential protocol so the token
// never lands in `.git/config`, a remote URL, shell history, the process list,
// or the agent transcript. These tests boot a local stub MCP backend and spawn
// the real helper against it, asserting:
//   1. `get` → emits `username`/`password` from get_repository_credential, and
//      forwards the repositoryId to the backend verbatim.
//   2. provider GitLab → username `oauth2` (GitHub default is `x-access-token`).
//   3. backend `success:false` → nothing on stdout, exit 0 (git falls through).
//   4. `store` / `erase` → no-op: backend never contacted, exit 0.
//   5. the token is NEVER written to stderr (only ever to git over stdout).
//
// Zero deps — only node:test, node:assert/strict, node:child_process, node:http,
// node:path. CommonJS to match the helper's own module system.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HELPER_PATH = path.resolve(
  __dirname, '..', 'scripts', 'kanbantic-git-credential-helper.js'
);

// ---------------------------------------------------------------------------
// Stub MCP backend — responds to tools/call get_repository_credential with a
// canned DecryptedCredentialResponse and records every received request.
// ---------------------------------------------------------------------------
function startStubBackend(credentialResult) {
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
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end('bad json');
        return;
      }
      received.push({ method: msg.method, params: msg.params, id: msg.id });

      res.setHeader('Content-Type', 'application/json');
      let result;
      if (
        msg.method === 'tools/call' &&
        msg.params &&
        msg.params.name === 'get_repository_credential'
      ) {
        result = { content: [{ type: 'text', text: JSON.stringify(credentialResult) }] };
      } else {
        result = {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'unhandled-by-stub' }) }],
        };
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

// ---------------------------------------------------------------------------
// Spawn the real helper. `apiKey` defaults to a literal so the Windows
// HKCU\Environment fallback never triggers (which would make the test depend on
// the dev machine's real key). repositoryId is passed via env so the test does
// not need a real git repo for resolution.
// ---------------------------------------------------------------------------
function runHelper(op, { port, stdin, repositoryId = 'repo-123', apiKey = 'test-key' } = {}) {
  const env = { ...process.env, KANBANTIC_API_KEY: apiKey };
  if (port != null) env.KANBANTIC_MCP_URL = `http://127.0.0.1:${port}/mcp`;
  if (repositoryId != null) env.KANBANTIC_REPOSITORY_ID = repositoryId;
  else delete env.KANBANTIC_REPOSITORY_ID;

  const child = spawn(process.execPath, [HELPER_PATH, op], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));

  const done = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });

  child.stdin.write(stdin != null ? stdin : 'protocol=https\nhost=github.com\npath=org/repo.git\n\n');
  child.stdin.end();
  return done;
}

function parseCreds(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i !== -1) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

test('get → emits username/password and forwards repositoryId (GitHub default)', async () => {
  const stub = await startStubBackend({
    success: true,
    token: 'ghp_secretTokenValue123',
    provider: 'GitHub',
    cloneUrl: 'https://github.com/org/repo.git',
    defaultBranch: 'main',
  });
  try {
    const { code, stdout, stderr } = await runHelper('get', { port: stub.port, repositoryId: 'repo-abc' });
    assert.strictEqual(code, 0, `exit 0; stderr: ${stderr}`);
    const creds = parseCreds(stdout);
    assert.strictEqual(creds.username, 'x-access-token', 'GitHub username sentinel');
    assert.strictEqual(creds.password, 'ghp_secretTokenValue123', 'PAT emitted as password');

    const fwd = stub.received.find(
      (r) => r.method === 'tools/call' && r.params && r.params.name === 'get_repository_credential'
    );
    assert.ok(fwd, 'backend received get_repository_credential');
    assert.strictEqual(fwd.params.arguments.repositoryId, 'repo-abc', 'repositoryId forwarded verbatim');

    // The token must never leak to stderr — stdout-to-git is the only channel.
    assert.ok(!stderr.includes('ghp_secretTokenValue123'), 'token absent from stderr');
  } finally {
    stub.server.close();
  }
});

test('get → provider GitLab uses oauth2 username', async () => {
  const stub = await startStubBackend({
    success: true,
    token: 'glpat-xyz',
    provider: 'GitLab',
  });
  try {
    const { code, stdout } = await runHelper('get', { port: stub.port });
    assert.strictEqual(code, 0);
    const creds = parseCreds(stdout);
    assert.strictEqual(creds.username, 'oauth2', 'GitLab username sentinel');
    assert.strictEqual(creds.password, 'glpat-xyz');
  } finally {
    stub.server.close();
  }
});

test('get → backend success:false → empty stdout, exit 0 (fall through)', async () => {
  const stub = await startStubBackend({ success: false, errorMessage: 'No active credential found' });
  try {
    const { code, stdout } = await runHelper('get', { port: stub.port });
    assert.strictEqual(code, 0, 'exit 0 so git can fall through to its normal flow');
    assert.strictEqual(stdout.trim(), '', 'nothing emitted to git on failure');
  } finally {
    stub.server.close();
  }
});

test('get → no repositoryId resolvable → empty stdout, backend not contacted', async () => {
  const stub = await startStubBackend({ success: true, token: 't', provider: 'GitHub' });
  try {
    // repositoryId:null clears the env var, and the temp cwd is not a git repo,
    // so `git config --get kanbantic.repositoryId` finds nothing.
    const { code, stdout } = await runHelper('get', { port: stub.port, repositoryId: null });
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout.trim(), '', 'no token emitted without a repositoryId');
    assert.strictEqual(stub.received.length, 0, 'backend not contacted without a repositoryId');
  } finally {
    stub.server.close();
  }
});

test('store → no-op: backend never contacted, exit 0', async () => {
  const stub = await startStubBackend({ success: true, token: 't', provider: 'GitHub' });
  try {
    const { code, stdout } = await runHelper('store', {
      port: stub.port,
      stdin: 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=t\n\n',
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout.trim(), '', 'store emits nothing');
    assert.strictEqual(stub.received.length, 0, 'store must not call the backend');
  } finally {
    stub.server.close();
  }
});

test('erase → no-op: backend never contacted, exit 0', async () => {
  const stub = await startStubBackend({ success: true, token: 't', provider: 'GitHub' });
  try {
    const { code, stdout } = await runHelper('erase', { port: stub.port });
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout.trim(), '', 'erase emits nothing');
    assert.strictEqual(stub.received.length, 0, 'erase must not call the backend');
  } finally {
    stub.server.close();
  }
});
