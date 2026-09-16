'use strict';

//
// KBT-F717 — plugin/proxy/session-file.js
//
// Pure unit tests for the shared session-file naming + fail-closed reader
// resolution. TC3682 (writer key) + TC3687 (reader fail-closed fallback).
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ownSessionFileKey,
  sessionFileName,
  sessionFilePath,
  resolveExistingSessionFile,
  listSessionFiles,
} = require('../proxy/session-file');

test('KBT-TC3682a — ownSessionFileKey prefers CLAUDE_CODE_SESSION_ID over PID', () => {
  const key = ownSessionFileKey({ CLAUDE_CODE_SESSION_ID: 'abc-123' }, 999);
  assert.strictEqual(key, 'abc-123');
});

test('KBT-TC3682b — ownSessionFileKey falls back to pid-<pid> when the env var is absent', () => {
  const key = ownSessionFileKey({}, 999);
  assert.strictEqual(key, 'pid-999');
});

test('KBT-TC3682c — sessionFilePath is per-session, two sessions never collide', () => {
  const home = '/home/x';
  const p1 = sessionFilePath(home, { CLAUDE_CODE_SESSION_ID: 'session-A' }, 111);
  const p2 = sessionFilePath(home, { CLAUDE_CODE_SESSION_ID: 'session-B' }, 222);
  assert.notStrictEqual(p1, p2);
  assert.strictEqual(p1, path.join(home, sessionFileName('session-A')));
  assert.strictEqual(p2, path.join(home, sessionFileName('session-B')));
});

// ---------------------------------------------------------------------------
// KBT-TC3687 — reader-side fail-closed resolution. Uses a REAL temp directory
// (not a listDirFn stub) so the mutation-check below exercises the exact
// production listing code path.
// ---------------------------------------------------------------------------

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f717-sessionfile-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('KBT-TC3687a — env var present: resolver returns that exact path, existence not required', () => {
  withTempHome((home) => {
    const resolved = resolveExistingSessionFile(home, { CLAUDE_CODE_SESSION_ID: 'session-Z' });
    assert.strictEqual(resolved.path, path.join(home, sessionFileName('session-Z')));
    assert.strictEqual(resolved.ambiguous, false);
  });
});

test('KBT-TC3687b — env var absent, exactly one candidate file: that file is used', () => {
  withTempHome((home) => {
    fs.writeFileSync(path.join(home, sessionFileName('only-one')), '{}');
    const resolved = resolveExistingSessionFile(home, {});
    assert.strictEqual(resolved.path, path.join(home, sessionFileName('only-one')));
    assert.strictEqual(resolved.ambiguous, false);
  });
});

test('KBT-TC3687c — env var absent, zero candidate files: silent no-op (path=null, not ambiguous)', () => {
  withTempHome((home) => {
    const resolved = resolveExistingSessionFile(home, {});
    assert.strictEqual(resolved.path, null);
    assert.strictEqual(resolved.ambiguous, false);
  });
});

test('KBT-TC3687d — env var absent, TWO candidate files: fail-closed (path=null, ambiguous=true), never guesses', () => {
  withTempHome((home) => {
    // Deliberately give the "wrong" file a much newer mtime than the "right" one, so a
    // mtime-based "pick the newest" heuristic would pick WRONG — proving this is not
    // just untested by coincidence.
    const older = path.join(home, sessionFileName('session-OLD'));
    const newer = path.join(home, sessionFileName('session-NEW'));
    fs.writeFileSync(older, '{}');
    fs.writeFileSync(newer, '{}');
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    fs.utimesSync(older, past, past);
    fs.utimesSync(newer, now, now);

    const resolved = resolveExistingSessionFile(home, {});
    assert.strictEqual(resolved.path, null, 'must not pick either file');
    assert.strictEqual(resolved.ambiguous, true, 'must flag ambiguity so the caller can warn');
    assert.strictEqual(resolved.candidates.length, 2);
  });
});

test('KBT-TC3687e — MUTATION CHECK: an mtime-"pick the newest" fallback would choose wrong', () => {
  // This test does NOT call the production resolver — it demonstrates, on the same
  // fixture as TC3687d, that the naive heuristic this Feature explicitly rejects
  // picks the wrong file. It is the mutation-check partner of TC3687d: if someone
  // "fixes" resolveExistingSessionFile to fall back to mtime-sort, TC3687d goes red
  // (asserts path === null) while this one would go green for the WRONG reason —
  // together they pin the fail-closed behaviour, not just its absence of a crash.
  withTempHome((home) => {
    const older = path.join(home, sessionFileName('session-OLD-correct-one'));
    const newer = path.join(home, sessionFileName('session-NEW-wrong-one'));
    fs.writeFileSync(older, '{}');
    fs.writeFileSync(newer, '{}');
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    fs.utimesSync(older, past, past);
    fs.utimesSync(newer, now, now);

    const files = listSessionFiles(home).map((name) => ({
      name,
      mtime: fs.statSync(path.join(home, name)).mtimeMs,
    }));
    const naiveNewest = files.sort((a, b) => b.mtime - a.mtime)[0].name;
    assert.strictEqual(
      naiveNewest,
      sessionFileName('session-NEW-wrong-one'),
      'the naive heuristic picks the file that is NOT the one under test — proving ' +
      'why resolveExistingSessionFile must not do this'
    );
  });
});

test('KBT-TC3687f — listSessionFiles ignores unrelated files in the same directory', () => {
  withTempHome((home) => {
    fs.writeFileSync(path.join(home, sessionFileName('real-one')), '{}');
    fs.writeFileSync(path.join(home, '.some-other-file.json'), '{}');
    fs.writeFileSync(path.join(home, 'notes.txt'), 'hi');
    const files = listSessionFiles(home);
    assert.deepStrictEqual(files, [sessionFileName('real-one')]);
  });
});
