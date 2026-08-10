'use strict';

//
// KBT-B545 — release-notes guard test.
//
// Verifies plugin/scripts/check-release-notes.js:
//   1. the committed tree is clean — the shipped version has its notes.
//   2. the script exits non-zero when a version has no notes (fixture).
//   3. the script exits non-zero when the notes file exists but is empty
//      (fixture) — a file-exists check that an empty file satisfies is a guard
//      that cannot fail, which is the KBT-B483 anti-pattern.
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
const scriptPath = path.join(repoRoot, 'plugin', 'scripts', 'check-release-notes.js');

function runScript(root) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_NOTES_ROOT: root },
  });
}

/** Builds a throwaway tree with a plugin.json at `version` and optional notes. */
function fixture(version, notes /* undefined = absent, string = content */) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b545-notes-'));
  const manifestDir = path.join(root, 'plugin', '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify({ name: 'kanbantic', version }, null, 2));
  if (notes !== undefined) {
    fs.writeFileSync(path.join(root, `RELEASE_NOTES_v${version}.md`), notes);
  }
  return root;
}

test('the committed tree ships a version that has its release notes', () => {
  const r = runScript(repoRoot);
  assert.equal(
    r.status, 0,
    `expected exit 0 on the committed tree, got ${r.status}\n`
      + `STDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /\[release-notes\] OK/);
});

test('a version without release notes fails the guard', () => {
  const root = fixture('9.9.9', undefined);
  try {
    const r = runScript(root);
    assert.notEqual(r.status, 0, 'expected a non-zero exit when the notes are missing');
    assert.match(r.stderr, /MISSING/);
    assert.match(r.stderr, /RELEASE_NOTES_v9\.9\.9\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty release-notes file fails the guard', () => {
  const root = fixture('9.9.9', '   \n');
  try {
    const r = runScript(root);
    assert.notEqual(r.status, 0, 'expected a non-zero exit when the notes are empty');
    assert.match(r.stderr, /EMPTY/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release notes with content pass the guard', () => {
  const root = fixture('9.9.9', '# Release Notes — v9.9.9\n\nSomething shipped.\n');
  try {
    const r = runScript(root);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nSTDERR: ${r.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
