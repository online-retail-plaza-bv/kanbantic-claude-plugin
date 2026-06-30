'use strict';

//
// stop-version-summary.test.js — KBT-F320 / KBT-T2422 / KBT-TC2365
//
// Integration test for the Stop hook `plugin/hooks/stop-version-summary.js`.
// Writes a tmp session-file with a versionContext, points the hook at it via
// KANBANTIC_SESSION_FILE, feeds a Stop payload on stdin, and asserts the
// exact summary line. Also covers the "no context ⇒ silent" variants.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'stop-version-summary.js');
const { formatSummary } = require('../hooks/stop-version-summary.js');

function runHook(sessionFile) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (sessionFile === null) {
      env.KANBANTIC_SESSION_FILE = path.join(os.tmpdir(), `no-such-${Date.now()}.json`);
    } else {
      env.KANBANTIC_SESSION_FILE = sessionFile;
    }
    const child = spawn(process.execPath, [HOOK], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }));
    child.stdin.end();
  });
}

function writeSession(contents) {
  const f = path.join(os.tmpdir(), `kbt-session-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(contents), 'utf8');
  return f;
}

test('prints the exact Version summary line from versionContext', async () => {
  const f = writeSession({
    channelId: 'c1',
    versionContext: {
      versionName: 'v1.5.0',
      applicationName: 'Kanbantic API',
      issueCount: 5,
      status: 'InProgress',
      percentDone: 60,
    },
  });
  try {
    const r = await runHook(f);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.equal(
      r.stdout.trim(),
      'Version v1.5.0 voor Kanbantic API — 5 issues, status InProgress, %done 60%'
    );
  } finally {
    fs.unlinkSync(f);
  }
});

test('silent when session-file is absent', async () => {
  const r = await runHook(null);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('silent when versionContext is missing', async () => {
  const f = writeSession({ channelId: 'c1' });
  try {
    const r = await runHook(f);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    fs.unlinkSync(f);
  }
});

test('silent when versionContext is incomplete (missing a field)', async () => {
  const f = writeSession({
    versionContext: { versionName: 'v1.0.0', applicationName: 'X', issueCount: 1, status: 'InProgress' },
  });
  try {
    const r = await runHook(f);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    fs.unlinkSync(f);
  }
});

test('helper: formatSummary returns null on incomplete context', () => {
  assert.equal(formatSummary(null), null);
  assert.equal(formatSummary({ versionName: 'v1' }), null);
  assert.equal(
    formatSummary({
      versionName: 'v1.5.0',
      applicationName: 'Kanbantic API',
      issueCount: 5,
      status: 'InProgress',
      percentDone: 60,
    }),
    'Version v1.5.0 voor Kanbantic API — 5 issues, status InProgress, %done 60%'
  );
});
