'use strict';

//
// KBT-F454 (KBT-E089) — version-sync guard test (KBT-TC2770).
//
// Verifies plugin/scripts/check-version-sync.js:
//   1. marketplace.json (plugins[].version) and plugin.json (version) are in lockstep
//      on the committed state.
//   2. the script exits 0 on the committed (synced) state.
//   3. the script exits non-zero when the two manifests drift (fixture).
//
// Zero deps — only node built-ins.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const marketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
const pluginPath = path.join(repoRoot, 'plugin', '.claude-plugin', 'plugin.json');
const scriptPath = path.join(repoRoot, 'plugin', 'scripts', 'check-version-sync.js');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function runScript(env) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('marketplace.json and plugin.json versions are in lockstep', () => {
  const marketplace = readJson(marketplacePath);
  const plugin = readJson(pluginPath);
  const entry = (marketplace.plugins || []).find((p) => p.name === plugin.name)
    || (marketplace.plugins || [])[0];

  assert.ok(entry, 'marketplace.json must have a plugins entry');
  assert.equal(
    entry.version,
    plugin.version,
    `marketplace.json (${entry.version}) must equal plugin.json (${plugin.version})`);
});

test('check-version-sync.js exits 0 on the committed (synced) state', () => {
  const res = runScript({});
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stdout}${res.stderr}`);
});

test('check-version-sync.js exits non-zero on injected drift', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-versionsync-'));
  try {
    const mp = path.join(dir, 'marketplace.json');
    const pl = path.join(dir, 'plugin.json');
    fs.writeFileSync(mp, JSON.stringify({
      name: 'kanbantic',
      plugins: [{ name: 'kanbantic-claude-plugin', version: '9.9.9' }],
    }));
    fs.writeFileSync(pl, JSON.stringify({ name: 'kanbantic-claude-plugin', version: '1.0.0' }));

    const res = runScript({ VERSION_SYNC_MARKETPLACE: mp, VERSION_SYNC_PLUGIN: pl });
    assert.notEqual(res.status, 0, 'expected non-zero exit on drift');
    assert.match(res.stderr, /DRIFT/, 'stderr should explain the drift');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
