'use strict';

//
// git-identity-workstation-isolation.test.js — KBT-B546
//
// Guards the property the fix actually delivers: the git-identity tests give
// the same answer on every workstation, whatever the developer has in
// `~/.gitconfig`.
//
// Six tests used to fail on a machine with a global `user.name`, because
// `git config --get` reads the system → global → local cascade and a freshly
// `git init`-ed temp repo contributes nothing to it. The assertions were
// therefore statements about the machine, not about the code. Fixing the six
// without a guard would only reset the clock: the originals looked correct too,
// on the machine where they were written.
//
// Three levels, three different claims:
//   Unit (KBT-TC3423)        — the config-reading helpers are a pure function
//                              of the injected source.
//   Integration (KBT-TC3434) — the hook's self-heal DECISION is too, across
//                              the process boundary.
//   E2E (KBT-TC3435)         — running the two real test files three times
//                              under three global configs yields three
//                              identical TAP tallies.
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

const { isolatedGitEnv, identityConfig, globalConfigVariants } = require('./helpers/git-env.js');
const { getGitConfig } = require('../scripts/kanbantic-git-identity.js');
const { identityAlreadyConfigured } = require('../hooks/pre-tool-use-git-identity-gate.js');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'pre-tool-use-git-identity-gate.js');
const IDENTITY_TEST_FILES = [
  path.resolve(__dirname, 'kanbantic-git-identity.test.js'),
  path.resolve(__dirname, 'pre-tool-use-git-identity-gate.test.js'),
];

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function mkTmpRepo(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b546-'));
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir, env });
  return dir;
}

// ---------------------------------------------------------------------------
// Unit — KBT-TC3423
// ---------------------------------------------------------------------------

// What the machine itself has configured globally. Used below to assert the
// injected source really displaces it — on a machine with no global identity
// that half of the assertion is vacuous and gets skipped rather than faked.
const MACHINE_GLOBAL_NAME = (() => {
  const r = spawnSync('git', ['config', '--global', '--get', 'user.name'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
})();

test('unit: getGitConfig returns what the injected source says, never what the machine says', (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');

  const cases = [
    { label: 'empty global config', global: '', expected: null },
    { label: 'injected global identity', global: identityConfig('Injected Global', 'injected@example.invalid'), expected: 'Injected Global' },
  ];

  for (const { label, global, expected } of cases) {
    const env = isolatedGitEnv({ global });
    const dir = mkTmpRepo(env);

    // 1. The value is exactly what the injected source contains.
    assert.equal(getGitConfig(dir, 'user.name', { env }), expected, `${label}: wrong value`);

    // 2. And it is never the machine's own global value — the failure mode
    //    that produced the six red tests of KBT-B546.
    if (MACHINE_GLOBAL_NAME && MACHINE_GLOBAL_NAME !== expected) {
      assert.notEqual(
        getGitConfig(dir, 'user.name', { env }),
        MACHINE_GLOBAL_NAME,
        `${label}: the workstation's ~/.gitconfig leaked through the injected source`,
      );
    }

    // 3. Isolation must not degrade into "git config no longer works": a value
    //    the repo sets locally still wins over the injected global.
    spawnSync('git', ['config', 'user.name', 'Repo Local'], { cwd: dir, env });
    assert.equal(getGitConfig(dir, 'user.name', { env }), 'Repo Local', `${label}: local scope masked`);
  }
});

test('unit: identityAlreadyConfigured follows the injected source, not the machine', (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');

  const emptyGlobal = isolatedGitEnv();
  const filledGlobal = isolatedGitEnv({ global: identityConfig('Workstation Owner', 'owner@example.com') });
  const repoA = mkTmpRepo(emptyGlobal);
  const repoB = mkTmpRepo(filledGlobal);

  // Both directions asserted explicitly. Before KBT-B546 only whichever one
  // the running machine happened to produce was ever exercised.
  assert.equal(identityAlreadyConfigured(repoA, { env: emptyGlobal }), false);
  assert.equal(identityAlreadyConfigured(repoB, { env: filledGlobal }), true);

  // Env-var override wins over both, regardless of the config source.
  const withEnvOverride = { ...emptyGlobal, GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: 'x@example.com' };
  assert.equal(identityAlreadyConfigured(repoA, { env: withEnvOverride }), true);
});

// ---------------------------------------------------------------------------
// Integration — KBT-TC3434
// ---------------------------------------------------------------------------

function startIdentityStub(identity) {
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
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runHook(env, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.stdout.resume();
    child.on('exit', (code) => resolve({ code, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test('integration: the hook self-heal decision crosses the process boundary unchanged', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');

  const AGENT = {
    success: true,
    authenticated: true,
    claudeAgentName: 'Axon Beta',
    claudeAgentEmail: 'axon-beta@agents.kanbantic.local',
  };
  const stub = await startIdentityStub(AGENT);

  try {
    for (const { label, global } of globalConfigVariants('Axon Beta', 'axon-beta@agents.kanbantic.local')) {
      const env = {
        ...isolatedGitEnv({ global }),
        KANBANTIC_API_KEY: 'test-key',
        KANBANTIC_MCP_URL: `http://127.0.0.1:${stub.port}/mcp`,
      };
      delete env.GIT_AUTHOR_NAME;
      delete env.GIT_AUTHOR_EMAIL;

      const dir = mkTmpRepo(env);
      const r = await runHook(env, {
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "x"' },
        cwd: dir,
      });

      assert.equal(r.code, 0, `${label}: the hook must never block`);

      const local = spawnSync('git', ['config', '--local', '--get', 'user.name'], {
        cwd: dir, encoding: 'utf8', env,
      });
      const localName = local.status === 0 ? local.stdout.trim() : null;

      if (global === '') {
        // Nothing resolvable → self-heal writes the agent identity locally.
        assert.equal(localName, 'Axon Beta', `${label}: expected a self-heal`);
      } else {
        // An identity IS resolvable → documented precedence says no-op. The
        // third variant is the trap: its global value equals the expected
        // agent name, so an assertion on the EFFECTIVE config would go green
        // for the wrong reason. Asserting on the LOCAL scope keeps it honest.
        assert.equal(localName, null, `${label}: expected a no-op, not a local write`);
      }
    }
  } finally {
    stub.server.close();
  }
});

// ---------------------------------------------------------------------------
// E2E — KBT-TC3435
// ---------------------------------------------------------------------------

function runTestFiles(env) {
  return new Promise((resolve) => {
    // `node --test` marks its own children with NODE_TEST_CONTEXT, which makes
    // a nested run emit the v8-serialized stream instead of TAP. Strip it so
    // the grandchild is a plain, parseable test run.
    const childEnv = { ...env };
    delete childEnv.NODE_TEST_CONTEXT;

    const child = spawn(
      process.execPath,
      ['--test', '--test-reporter=tap', ...IDENTITY_TEST_FILES],
      { env: childEnv, cwd: path.resolve(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.resume();
    child.on('exit', () => {
      const read = (key) => {
        const m = out.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
        return m ? Number(m[1]) : null;
      };
      resolve({ tests: read('tests'), pass: read('pass'), fail: read('fail') });
    });
  });
}

test('e2e: the identity test files tally identically under three global git configs', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');

  const runs = [];
  for (const { label, global } of globalConfigVariants()) {
    const env = isolatedGitEnv({ global });
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    runs.push({ label, tally: await runTestFiles(env) });
  }

  for (const { label, tally } of runs) {
    assert.notEqual(tally.tests, null, `${label}: no TAP summary parsed`);
    assert.equal(tally.fail, 0, `${label}: ${tally.fail} failing test(s) — the suite still reads the machine`);
  }

  const [first, ...rest] = runs;
  for (const r of rest) {
    assert.deepEqual(
      r.tally,
      first.tally,
      `"${r.label}" tallied differently from "${first.label}" — the outcome still depends on the global git config`,
    );
  }
});
