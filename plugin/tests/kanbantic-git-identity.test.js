'use strict';

//
// kanbantic-git-identity.test.js — KBT-F616
//
// Exercises plugin/scripts/kanbantic-git-identity.js's CLI entry point
// against a stub MCP HTTP server (same technique as check-drift.test.js /
// locked-version-blocker.test.js) and a real temp git repo (git init, no
// identity configured — same fixture style as git-sync-check.test.js).
//
// Spawns the script as a fresh child process per test (same convention as
// git-credential-helper.test.js) rather than requiring it in-process: its
// `MCP_URL` is resolved once from process.env at module-load time, so an
// in-process require would freeze the very first value seen and silently
// hit the real server on every later test in the same file.
//
// Covers the three-layer precedence:
//   1. GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL env vars set → no-op.
//   2. get_current_agent_identity (KBT-F615) resolves → git config set to it.
//   3. get_repository resolves (agent-identity layer empty) → git config set
//      to gitAuthorName/gitAuthorEmail.
//   4. Nothing resolves → git config left untouched.
//
// Zero deps — node:test + node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { isolatedGitEnv } = require('./helpers/git-env.js');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'kanbantic-git-identity.js');

const { getGitConfig, resolveRepositoryId } = require('../scripts/kanbantic-git-identity.js');

const HAS_GIT = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
})();

function mkTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-git-identity-'));
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  return dir;
}

// Stub MCP server: answers get_current_agent_identity and/or get_repository
// tools/call requests with configurable payloads. No initialize handshake —
// mirrors kanbantic-git-credential-helper.js's stateless contract.
function startStub({ identity, repository } = {}) {
  const server = http.createServer((req, res) => {
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
      let payload = null;
      if (msg.method === 'tools/call' && msg.params.name === 'get_current_agent_identity') {
        payload = identity !== undefined ? identity : { success: true, authenticated: false };
      } else if (msg.method === 'tools/call' && msg.params.name === 'get_repository') {
        payload = repository !== undefined ? repository : { success: true };
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      const result = payload
        ? { content: [{ type: 'text', text: JSON.stringify(payload) }] }
        : {};
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runScript({ cwd, port, apiKey = 'test-key', extraEnv = {}, baseEnv = process.env }) {
  return new Promise((resolve) => {
    const env = { ...baseEnv };
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    delete env.KANBANTIC_REPOSITORY_ID;
    Object.assign(env, extraEnv); // extraEnv re-adds whichever of the above it needs
    if (port) env.KANBANTIC_MCP_URL = `http://127.0.0.1:${port}/mcp`;
    if (apiKey === null) delete env.KANBANTIC_API_KEY;
    else env.KANBANTIC_API_KEY = apiKey;
    const child = spawn(process.execPath, [SCRIPT], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('layer 1: GIT_AUTHOR_NAME/EMAIL env vars set → no-op, git config untouched', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  const env = isolatedGitEnv();
  const r = await runScript({
    cwd: dir,
    apiKey: null,
    baseEnv: env,
    extraEnv: { GIT_AUTHOR_NAME: 'Workstation Override', GIT_AUTHOR_EMAIL: 'override@example.com' },
  });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /workstation override active/);
  assert.equal(getGitConfig(dir, 'user.name', { env }), null);
  assert.equal(getGitConfig(dir, 'user.email', { env }), null);
});

test('layer 2: get_current_agent_identity resolves → git config set to agent identity', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  const env = isolatedGitEnv();
  const stub = await startStub({
    identity: {
      success: true,
      authenticated: true,
      claudeAgentName: 'Axon Alpha',
      claudeAgentEmail: 'axon-alpha@agents.kanbantic.local',
    },
  });
  try {
    const r = await runScript({ cwd: dir, port: stub.port, baseEnv: env });
    assert.equal(r.code, 0);
    assert.equal(getGitConfig(dir, 'user.name', { env }), 'Axon Alpha');
    assert.equal(getGitConfig(dir, 'user.email', { env }), 'axon-alpha@agents.kanbantic.local');
  } finally {
    stub.server.close();
  }
});

test('layer 3: agent identity unauthenticated, get_repository resolves → git config set to repo identity', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  const env = isolatedGitEnv();
  const stub = await startStub({
    identity: { success: true, authenticated: false },
    repository: { success: true, gitAuthorName: 'Repo Bot', gitAuthorEmail: 'repo-bot@example.com' },
  });
  try {
    const r = await runScript({
      cwd: dir, port: stub.port, baseEnv: env, extraEnv: { KANBANTIC_REPOSITORY_ID: 'repo-123' },
    });
    assert.equal(r.code, 0);
    assert.equal(getGitConfig(dir, 'user.name', { env }), 'Repo Bot');
    assert.equal(getGitConfig(dir, 'user.email', { env }), 'repo-bot@example.com');
  } finally {
    stub.server.close();
  }
});

test('layer 3 fallback via git config kanbantic.repositoryId (no env var needed)', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  const env = isolatedGitEnv();
  spawnSync('git', ['config', 'kanbantic.repositoryId', 'repo-456'], { cwd: dir, env });
  const stub = await startStub({
    identity: { success: true, authenticated: false },
    repository: { success: true, gitAuthorName: 'Repo Bot 2', gitAuthorEmail: 'repo-bot-2@example.com' },
  });
  try {
    const r = await runScript({ cwd: dir, port: stub.port, baseEnv: env });
    assert.equal(r.code, 0);
    assert.equal(getGitConfig(dir, 'user.name', { env }), 'Repo Bot 2');
  } finally {
    stub.server.close();
  }
});

test('nothing resolves (no API key) → git config left untouched, no throw', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  const env = isolatedGitEnv();
  const r = await runScript({ cwd: dir, apiKey: null, baseEnv: env });
  assert.equal(r.code, 0);
  assert.equal(getGitConfig(dir, 'user.name', { env }), null);
});

test('nothing resolves (agent unauthenticated + no repositoryId) → left untouched', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  const env = isolatedGitEnv();
  const stub = await startStub({ identity: { success: true, authenticated: false } });
  try {
    const r = await runScript({ cwd: dir, port: stub.port, baseEnv: env });
    assert.equal(r.code, 0);
    assert.equal(getGitConfig(dir, 'user.name', { env }), null);
  } finally {
    stub.server.close();
  }
});

// ---- pure-helper units (safe in-process — no network involved) ----
test('helper: resolveRepositoryId prefers env var over git config', () => {
  if (!HAS_GIT) return;
  const dir = mkTmpRepo();
  const env = isolatedGitEnv();
  spawnSync('git', ['config', 'kanbantic.repositoryId', 'from-config'], { cwd: dir, env });
  // Injected, not mutated: no write to the shared process.env, no restore-in-finally,
  // and the two branches of the precedence are asserted against the same fixture.
  const withOverride = { ...env, KANBANTIC_REPOSITORY_ID: 'from-env' };
  const withoutOverride = { ...env };
  delete withoutOverride.KANBANTIC_REPOSITORY_ID;
  assert.equal(resolveRepositoryId(dir, { env: withOverride }), 'from-env');
  assert.equal(resolveRepositoryId(dir, { env: withoutOverride }), 'from-config');
});

test('helper: getGitConfig returns null for an unset key', () => {
  if (!HAS_GIT) return;
  const dir = mkTmpRepo();
  assert.equal(getGitConfig(dir, 'user.name', { env: isolatedGitEnv() }), null);
});
