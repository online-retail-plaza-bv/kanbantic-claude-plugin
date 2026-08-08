'use strict';

//
// credential-helper-version-independence.test.js — KBT-B547
//
// The defect was never "the helper is broken" — it was that the PATH TO the
// helper, written verbatim into `.git/config`, carries a version number the
// plugin cache prunes on upgrade. A test that invokes the helper directly
// misses that entirely: it runs against whichever path exists right now.
//
// So these tests simulate the upgrade. Cache version A is created, configured,
// exercised, deleted, replaced by B, and exercised again.
//
// Three levels:
//   Unit (KBT-TC3436)        — resolvePluginRoot precedence; no newest-version
//                              scan; a `searched` list when nothing resolves.
//   Integration (KBT-TC3424) — real `git credential fill` before AND after the
//                              simulated upgrade, plus the no-cache diagnosis.
//   E2E (KBT-TC3437)         — the documented snippet from the lane-SKILL.md
//                              files is extracted and executed; the docs
//                              themselves are the artefact under test.
//
// Safety rails:
//   - Everything happens in temp dirs. The `.git/config` of the checkout this
//     runs in is never read, written, or used as a fixture.
//   - The credential comes from a local stub MCP server. No real PAT, no
//     network, and the token is asserted never to reach stderr.
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
const {
  resolvePluginRoot,
  pluginRootsOnPath,
  notFoundMessage,
} = require('../scripts/kanbantic-plugin-root.js');
const { install, helperConfigValue } = require('../scripts/install-git-credential-helper.js');

const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');
const SKILL_FILES = ['kanbantic-issue-execute', 'kanbantic-issue-prepare', 'kanbantic-issue-review']
  .map((s) => path.resolve(__dirname, '..', 'skills', s, 'SKILL.md'));

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const HAS_SH = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' }).status === 0;

const SNIPPET_FIRST_LINE = '   PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"';
const SNIPPET_LAST_MARKER = '--print-helper)"';

/**
 * Lift the credential-helper snippet out of a SKILL.md and de-indent it so it
 * can be run as-is. Reading it from the document rather than restating it here
 * is the whole point: KBT-B547 was a defect in the instruction, and a copy in
 * the test would be free to stay right while the document went wrong.
 */
function extractDocumentedSnippet(skillFile) {
  const doc = fs.readFileSync(skillFile, 'utf8');
  const start = doc.indexOf(SNIPPET_FIRST_LINE);
  const end = doc.indexOf(SNIPPET_LAST_MARKER, start);
  assert.ok(start !== -1 && end !== -1, `no credential-helper snippet found in ${skillFile}`);
  return doc
    .slice(start, end + SNIPPET_LAST_MARKER.length)
    .split('\n')
    .map((l) => l.replace(/^ {3}/, ''))
    .join('\n');
}

const tmpRoots = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/**
 * A stand-in for `~/.claude/plugins/cache/<mp>/kanbantic-claude-plugin/<version>`,
 * carrying a real copy of the credential helper + resolver.
 */
function makeCacheVersion(cacheRoot, version) {
  const root = path.join(cacheRoot, 'kanbantic', 'kanbantic-claude-plugin', version);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const scripts = [
    'kanbantic-git-credential-helper.js',
    'kanbantic-plugin-root.js',
    'kanbantic-credential-helper-shim.js',
    'install-git-credential-helper.js',
  ];
  for (const name of scripts) {
    fs.copyFileSync(path.join(SCRIPTS_DIR, name), path.join(root, 'scripts', name));
  }
  return root;
}

/** A PATH with every Kanbantic plugin entry removed — including the real one. */
function pathWithoutPlugin(pathValue) {
  return pathValue
    .split(path.delimiter)
    .filter((e) => !e.includes('kanbantic-claude-plugin'))
    .join(path.delimiter);
}

// ---------------------------------------------------------------------------
// Unit — KBT-TC3436
// ---------------------------------------------------------------------------

test('unit: resolution precedence is KANBANTIC_PLUGIN_ROOT → CLAUDE_PLUGIN_ROOT → PATH', () => {
  const cache = mkTmp('kbt-b547-cache-');
  const a = makeCacheVersion(cache, '2.14.0');
  const b = makeCacheVersion(cache, '2.35.0');

  assert.equal(
    resolvePluginRoot({ env: { KANBANTIC_PLUGIN_ROOT: a, CLAUDE_PLUGIN_ROOT: b, PATH: path.join(b, 'bin') } }).root,
    path.resolve(a),
  );
  assert.equal(
    resolvePluginRoot({ env: { CLAUDE_PLUGIN_ROOT: b, PATH: path.join(a, 'bin') } }).root,
    path.resolve(b),
  );
  assert.equal(
    resolvePluginRoot({ env: { PATH: `${path.join(b, 'bin')}${path.delimiter}/usr/bin` } }).source,
    'PATH',
  );
});

test('unit: PATH names the RUNNING version — no newest-version scan (KBT-F637)', () => {
  const cache = mkTmp('kbt-b547-cache-');
  const older = makeCacheVersion(cache, '2.14.0');
  makeCacheVersion(cache, '2.35.0'); // newer, present on disk, NOT on PATH

  const r = resolvePluginRoot({ env: { PATH: path.join(older, 'bin') } });
  assert.equal(r.root, path.resolve(older), 'must follow PATH, not the highest version number');
});

test('unit: nothing resolvable → null plus the list of sources searched', () => {
  const cache = mkTmp('kbt-b547-cache-');
  makeCacheVersion(cache, '2.35.0'); // in the cache, but nothing points at it

  const r = resolvePluginRoot({ env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.root, null, 'a cache directory alone must not be enough — that is the abolished scan');
  assert.equal(r.source, null);
  assert.ok(r.searched.some((s) => s.startsWith('KANBANTIC_PLUGIN_ROOT')));
  assert.ok(r.searched.some((s) => s.startsWith('CLAUDE_PLUGIN_ROOT')));
  assert.ok(r.searched.some((s) => s.startsWith('PATH')));

  const msg = notFoundMessage(r.searched);
  assert.match(msg, /could not read Username/, 'the diagnosis must pre-empt git\'s misleading message');
  assert.match(msg, /not an authentication failure/);
});

test('unit: a directory without the helper script does not count as a plugin root', () => {
  const empty = mkTmp('kbt-b547-empty-');
  const r = resolvePluginRoot({ env: { KANBANTIC_PLUGIN_ROOT: empty, PATH: '' } });
  assert.equal(r.root, null);
});

test('unit: pluginRootsOnPath strips /bin and ignores unrelated entries', () => {
  const roots = pluginRootsOnPath(
    ['/usr/bin', '/x/kanbantic-claude-plugin/2.35.0/bin', '/y/other-plugin/1.0.0/bin'].join(':'),
    ':',
  );
  assert.deepEqual(roots, ['/x/kanbantic-claude-plugin/2.35.0']);
});

// ---------------------------------------------------------------------------
// Integration — KBT-TC3424
// ---------------------------------------------------------------------------

const TOKEN = 'ghp_stub_token_never_real';

function startCredentialStub() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      const payload = { success: true, token: TOKEN, provider: 'github' };
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

/**
 * `git credential fill` against a throwaway repo — never the real checkout.
 *
 * Async on purpose: the stub MCP server the helper talks to runs on THIS
 * process's event loop, so a synchronous spawn would deadlock it into a
 * request timeout that looks exactly like a broken helper.
 */
function credentialFill(repoDir, env) {
  return new Promise((resolve) => {
    const child = spawn('git', ['credential', 'fill'], {
      cwd: repoDir,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.write('protocol=https\nhost=github.com\n\n');
    child.stdin.end();
  });
}

/** Windows path → the form the MSYS `sh` bundled with Git understands. */
function toShPath(p) {
  return process.platform === 'win32'
    ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
    : p;
}

test('integration: the credential survives the plugin upgrade that deletes the configured version', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');

  const stub = await startCredentialStub();
  try {
    const cache = mkTmp('kbt-b547-cache-');
    const versionA = makeCacheVersion(cache, '2.14.0');
    const installDir = path.join(mkTmp('kbt-b547-home-'), '.kanbantic', 'bin');
    const { shimPath } = install({ installDir, sourceDir: SCRIPTS_DIR });
    const helperValue = helperConfigValue(shimPath);

    // The whole point: what lands in .git/config carries no version number.
    assert.ok(!/\d+\.\d+\.\d+/.test(helperValue), `helper value still pins a version: ${helperValue}`);
    assert.ok(!helperValue.includes(cache), 'helper value must not point into the plugin cache');

    const repo = mkTmp('kbt-b547-repo-');
    const baseEnv = isolatedGitEnv();
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: repo, env: baseEnv });
    spawnSync('git', ['config', '--local', 'credential.helper', ''], { cwd: repo, env: baseEnv });
    spawnSync('git', ['config', '--local', '--add', 'credential.helper', helperValue], { cwd: repo, env: baseEnv });

    const envFor = (pluginRoot) => {
      const env = {
        ...baseEnv,
        PATH: `${path.join(pluginRoot, 'bin')}${path.delimiter}${baseEnv.PATH}`,
        KANBANTIC_API_KEY: 'test-key',
        KANBANTIC_MCP_URL: `http://127.0.0.1:${stub.port}/mcp`,
        KANBANTIC_REPOSITORY_ID: 'repo-under-test',
      };
      delete env.KANBANTIC_PLUGIN_ROOT;
      delete env.CLAUDE_PLUGIN_ROOT;
      return env;
    };

    // Step 2 — works today, with the configured version present.
    const before = await credentialFill(repo, envFor(versionA));
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, new RegExp(`password=${TOKEN}`));
    assert.ok(!before.stderr.includes(TOKEN), 'the token must never reach stderr');

    // Step 3/4 — the upgrade: version A is pruned, B takes over.
    fs.rmSync(versionA, { recursive: true, force: true });
    const versionB = makeCacheVersion(cache, '2.36.0');

    const after = await credentialFill(repo, envFor(versionB));
    assert.equal(after.status, 0, after.stderr);
    assert.match(
      after.stdout,
      new RegExp(`password=${TOKEN}`),
      'this is the assertion that fails with a version-pinned helper path',
    );
    assert.ok(!after.stderr.includes(TOKEN));

    // Step 5 — no plugin cache at all: a recognisable diagnosis, not a mystery.
    fs.rmSync(versionB, { recursive: true, force: true });
    // The machine running this test has a real plugin on PATH; strip it, or the
    // "no plugin anywhere" case silently resolves to the real installation.
    const orphaned = await credentialFill(repo, {
      ...envFor(versionB),
      PATH: pathWithoutPlugin(baseEnv.PATH),
    });
    assert.match(orphaned.stderr, /no active Kanbantic plugin installation found/);
    assert.match(orphaned.stderr, /searched:/);
    assert.match(orphaned.stderr, /not an authentication failure/);
    assert.ok(!orphaned.stdout.includes(TOKEN), 'no credential may be emitted without a plugin');
  } finally {
    stub.server.close();
  }
});

test('integration: reinstalling is idempotent and refreshes the shim in place', () => {
  const installDir = path.join(mkTmp('kbt-b547-home-'), '.kanbantic', 'bin');
  const first = install({ installDir, sourceDir: SCRIPTS_DIR });
  fs.writeFileSync(first.shimPath, '// stale copy from an older plugin version\n');
  const second = install({ installDir, sourceDir: SCRIPTS_DIR });

  assert.equal(second.shimPath, first.shimPath, 'the stable path must not move between runs');
  assert.equal(
    fs.readFileSync(second.shimPath, 'utf8'),
    fs.readFileSync(path.join(SCRIPTS_DIR, 'kanbantic-credential-helper-shim.js'), 'utf8'),
    'a stale shim must be overwritten by the running plugin\'s copy',
  );
});

// ---------------------------------------------------------------------------
// E2E — KBT-TC3437
// ---------------------------------------------------------------------------

const VERSION_PINNED_CACHE_PATH = /kanbantic-claude-plugin[\\/]\d+\.\d+\.\d+/;

test('e2e: no lane-skill document hands out a version-pinned plugin path', () => {
  for (const file of SKILL_FILES) {
    const text = fs.readFileSync(file, 'utf8');
    const hit = text.match(VERSION_PINNED_CACHE_PATH);
    assert.equal(hit, null, `${path.basename(path.dirname(file))}/SKILL.md pins a plugin version: ${hit && hit[0]}`);
  }
});

test('e2e: running the documented snippet yields a versionless helper that survives an upgrade', async (t) => {
  if (!HAS_GIT) return t.skip('git not on PATH');
  if (!HAS_SH) return t.skip('sh not available');

  // Take the instruction from the document, verbatim — the docs are what broke.
  const snippet = extractDocumentedSnippet(SKILL_FILES[0]);

  const stub = await startCredentialStub();
  try {
    const cache = mkTmp('kbt-b547-cache-');
    const versionA = makeCacheVersion(cache, '2.14.0');
    const home = mkTmp('kbt-b547-home-');
    const baseEnv = isolatedGitEnv();

    const ran = spawnSync('sh', ['-c', `${snippet}\nprintf '%s' "$HELPER"`], {
      encoding: 'utf8',
      env: { ...baseEnv, CLAUDE_PLUGIN_ROOT: versionA, KANBANTIC_HOME: home, HOME: home, USERPROFILE: home },
    });
    assert.equal(ran.status, 0, ran.stderr);
    const helperValue = ran.stdout.trim();

    assert.ok(helperValue.startsWith('!node '), `unexpected helper value: ${helperValue}`);
    assert.ok(!VERSION_PINNED_CACHE_PATH.test(helperValue), `documented snippet still pins a version: ${helperValue}`);
    assert.ok(!helperValue.includes(cache), 'the persisted value must live outside the plugin cache');

    const repo = mkTmp('kbt-b547-repo-');
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: repo, env: baseEnv });
    spawnSync('git', ['config', '--local', 'credential.helper', ''], { cwd: repo, env: baseEnv });
    spawnSync('git', ['config', '--local', '--add', 'credential.helper', helperValue], { cwd: repo, env: baseEnv });

    const mcpEnv = (root) => {
      const env = {
        ...baseEnv,
        PATH: `${path.join(root, 'bin')}${path.delimiter}${baseEnv.PATH}`,
        KANBANTIC_API_KEY: 'test-key',
        KANBANTIC_MCP_URL: `http://127.0.0.1:${stub.port}/mcp`,
        KANBANTIC_REPOSITORY_ID: 'repo-under-test',
      };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.KANBANTIC_PLUGIN_ROOT;
      return env;
    };

    const before = await credentialFill(repo, mcpEnv(versionA));
    assert.match(before.stdout, new RegExp(`password=${TOKEN}`), before.stderr);

    fs.rmSync(versionA, { recursive: true, force: true });
    const versionB = makeCacheVersion(cache, '2.36.0');
    const after = await credentialFill(repo, mcpEnv(versionB));
    assert.match(
      after.stdout,
      new RegExp(`password=${TOKEN}`),
      `the documented instruction must still work after the plugin upgrade: ${after.stderr}`,
    );
  } finally {
    stub.server.close();
  }
});

test('e2e: the snippet\'s fallback branch finds the running plugin without CLAUDE_PLUGIN_ROOT', (t) => {
  if (!HAS_SH) return t.skip('sh not available');

  // Measured in the wild: git spawns the helper with CLAUDE_PLUGIN_ROOT empty.
  // The documented snippet therefore carries a PATH-derived fallback — which is
  // only worth documenting if it actually resolves.
  const cache = mkTmp('kbt-b547-cache-');
  const versionA = makeCacheVersion(cache, '2.14.0');
  const snippet = extractDocumentedSnippet(SKILL_FILES[0]).split('\n')
    .filter((l) => !l.startsWith('HELPER='))
    .join('\n');

  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;

  const ran = spawnSync(
    'sh',
    ['-c', `PATH="${toShPath(path.join(versionA, 'bin'))}:$PATH"\n${snippet}\nprintf '%s' "$PLUGIN_ROOT"`],
    { encoding: 'utf8', env },
  );
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), toShPath(versionA));
});
