'use strict';

//
// pre-tool-use-git-identity-gate.test.js — KBT-F616
//
// Integration test for the PreToolUse hook
// plugin/hooks/pre-tool-use-git-identity-gate.js: spawns the hook as a child
// process (same technique as locked-version-blocker.test.js), feeds it a
// Bash PreToolUse payload on stdin against a real temp git repo, and asserts
// it (a) NEVER blocks (always exit 0 — this is a self-healing safety net,
// not a HARD-GATE), and (b) sets git config when appropriate.
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

const HOOK = path.resolve(__dirname, '..', 'hooks', 'pre-tool-use-git-identity-gate.js');

const {
  isGitCommitCommand,
  extractTargetDir,
  identityAlreadyConfigured,
} = require('../hooks/pre-tool-use-git-identity-gate.js');

const HAS_GIT = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
})();

function mkTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-identity-gate-'));
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  return dir;
}

// KBT-B546 — the config source is passed in, never assumed. Without it this
// reads the developer's ~/.gitconfig and the assertions below become claims
// about the machine rather than about the hook.
function gitConfig(dir, key, env = process.env) {
  const r = spawnSync('git', ['config', '--get', key], { cwd: dir, encoding: 'utf8', env });
  return r.status === 0 ? r.stdout.trim() : null;
}

function startStub(identity) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      const payload =
        msg.method === 'tools/call' && msg.params.name === 'get_current_agent_identity'
          ? identity
          : { success: true };
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runHook({ payload, port, apiKey = 'test-key', cwd, baseEnv = process.env }) {
  return new Promise((resolve) => {
    const env = { ...baseEnv };
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    if (port) env.KANBANTIC_MCP_URL = `http://127.0.0.1:${port}/mcp`;
    if (apiKey === null) delete env.KANBANTIC_API_KEY;
    else env.KANBANTIC_API_KEY = apiKey;
    const child = spawn(process.execPath, [HOOK], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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

test('allow: non-Bash tool is ignored (no network call needed)', async () => {
  const r = await runHook({
    payload: { tool_name: 'mcp__kanbantic__get_issue', tool_input: { issueId: 'KBT-F999' } },
    port: undefined,
    apiKey: null,
  });
  assert.equal(r.code, 0);
});

test('allow: Bash tool but not a git commit is ignored', async () => {
  const r = await runHook({
    payload: { tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    port: undefined,
    apiKey: null,
  });
  assert.equal(r.code, 0);
});

test('self-heals: git commit with no identity configured → sets git config, exit 0', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  // The premise 'no identity configured' is now ENFORCED via the injected
  // config source instead of assumed of the machine (KBT-B546). The
  // complementary branch — a global identity present, hook must no-op — is
  // asserted in git-identity-workstation-isolation.test.js.
  const env = isolatedGitEnv();
  const stub = await startStub({
    success: true,
    authenticated: true,
    claudeAgentName: 'Axon Beta',
    claudeAgentEmail: 'axon-beta@agents.kanbantic.local',
  });
  try {
    const r = await runHook({
      payload: { tool_name: 'Bash', tool_input: { command: 'git commit -m "test"' }, cwd: dir },
      port: stub.port,
      baseEnv: env,
    });
    assert.equal(r.code, 0);
    assert.equal(gitConfig(dir, 'user.name', env), 'Axon Beta');
    assert.equal(gitConfig(dir, 'user.email', env), 'axon-beta@agents.kanbantic.local');
  } finally {
    stub.server.close();
  }
});

test('no-op: identity already configured → allow without touching config', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  const env = isolatedGitEnv();
  spawnSync('git', ['config', 'user.name', 'Existing Name'], { cwd: dir, env });
  spawnSync('git', ['config', 'user.email', 'existing@example.com'], { cwd: dir, env });
  const r = await runHook({
    payload: { tool_name: 'Bash', tool_input: { command: 'git commit -m "test"' }, cwd: dir },
    port: undefined,
    apiKey: null,
    baseEnv: env,
  });
  assert.equal(r.code, 0);
  assert.equal(gitConfig(dir, 'user.name', env), 'Existing Name');
});

test('fail-open: no API key + no identity configured → still exit 0 (never blocks)', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  const r = await runHook({
    payload: { tool_name: 'Bash', tool_input: { command: 'git commit -m "test"' }, cwd: dir },
    port: undefined,
    apiKey: null,
    baseEnv: isolatedGitEnv(),
  });
  assert.equal(r.code, 0);
});

test('recognizes `git -C <dir> commit` and targets that dir', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  const dir = mkTmpRepo();
  const env = isolatedGitEnv();
  const stub = await startStub({
    success: true,
    authenticated: true,
    claudeAgentName: 'Axon Gamma',
    claudeAgentEmail: 'axon-gamma@agents.kanbantic.local',
  });
  try {
    const r = await runHook({
      payload: { tool_name: 'Bash', tool_input: { command: `git -C "${dir}" commit -m "test"` } },
      port: stub.port,
      baseEnv: env,
    });
    assert.equal(r.code, 0);
    assert.equal(gitConfig(dir, 'user.name', env), 'Axon Gamma');
  } finally {
    stub.server.close();
  }
});

// ---- pure-helper units ----
test('helper: isGitCommitCommand matches plain + -C forms, rejects others', () => {
  assert.ok(isGitCommitCommand('git commit -m "x"'));
  assert.ok(isGitCommitCommand('git -C /some/dir commit -m "x"'));
  assert.ok(!isGitCommitCommand('git status'));
  assert.ok(!isGitCommitCommand('git log --oneline'));
  assert.ok(!isGitCommitCommand(undefined));
});

test('helper: extractTargetDir prefers `git -C <dir>`, else eventCwd, else process.cwd()', () => {
  assert.equal(extractTargetDir('git -C /foo/bar commit', '/other'), '/foo/bar');
  assert.equal(extractTargetDir('git commit', '/other'), '/other');
  assert.equal(extractTargetDir('git commit', undefined), process.cwd());
});

test('helper: identityAlreadyConfigured true when GIT_AUTHOR_NAME/EMAIL env vars set', () => {
  // Injected, not mutated — no write to the shared process.env.
  const env = { ...isolatedGitEnv(), GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: 'x@example.com' };
  assert.equal(identityAlreadyConfigured('/nonexistent/path', { env }), true);
});
