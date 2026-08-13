'use strict';

//
// sync-crlf-drift.test.js — KBT-B543 / KBT-TC3512
//
// The drift-detector compared RAW BYTES. sync-workspace-skills writes LF; git
// rewrites those same files to CRLF on checkout whenever `core.autocrlf=true`
// — the default Git-for-Windows install. Every sync after a git operation then
// reported every mirror as "locally edited" while nobody had touched anything.
//
// That is worse than noise. The warning is the only brake between a sync and
// overwriting work that is not in the Toolkit yet. Making it fire falsely on
// every Windows run trains the operator to reach for `--force` — which is
// exactly what happened in KBT-B525, where one of seventeen "false positives"
// was real and `kanbantic-deploy.md` lost 345 lines of runbook.
//
// Two things therefore have to be true at once, and the tests are built as a
// pair so neither can be satisfied alone:
//
//   1. line-ending-only differences must NOT warn   (the bug)
//   2. genuine content edits must STILL warn        (the protection)
//
// (2) is what stops a lazy fix. Stripping all whitespace, or comparing only
// lengths, would make (1) pass and silently delete the safety net. The
// third test — CRLF *and* a real edit in the same file — is the one that
// catches over-normalisation, because it is the only case where the two
// requirements pull in opposite directions.
//
// The conversion is performed by the test itself rather than by setting
// `core.autocrlf`. A test that only turns red on a Windows workstation would
// not catch the regression in Linux CI, and the condition under test is
// "the file on disk has CRLF", not "git is configured a certain way".
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'sync-workspace-skills.js');
const sync = require(SCRIPT);

const FIXED_NOW = '2026-08-13T09:00:00.000Z';

function mkTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b543-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function skillItem(overrides) {
  return Object.assign({
    id: '11111111-1111-1111-1111-111111111111',
    code: 'KBT-SKIL777',
    category: 'Skill',
    title: '/crlf-probe — CRLF drift probe (KBT-B543)',
    content: 'First line of the body.\n\nSecond paragraph here.\nThird line.\n',
    isActive: true,
  }, overrides);
}

const MIRROR = path.join('.claude', 'commands', 'crlf-probe.md');

/**
 * Rewrite a file's line endings LF -> CRLF, changing nothing else.
 *
 * This is precisely what git's autocrlf filter does on checkout. Byte-for-byte
 * the file differs; character-for-character, ignoring line terminators, it is
 * identical.
 */
function toCrlf(absPath) {
  const before = fs.readFileSync(absPath, 'utf8');
  const after = before.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(absPath, after, 'utf8');
  return { before, after };
}

// ---------------------------------------------------------------------------
// 1. CRLF-only — must NOT warn  (DoD 1)
// ---------------------------------------------------------------------------

test('KBT-TC3512: a CRLF-converted mirror is UNCHANGED, not a local edit', () => {
  const root = mkTmpRoot();
  try {
    const items = [skillItem()];

    const first = sync.runSync({ rootDir: root, items, workspace: 'probe', now: FIXED_NOW });
    assert.equal(first.created, 1, 'setup: first sync should create the mirror');
    assert.equal(first.warnings, 0, 'setup: a fresh sync must not warn');

    const abs = path.join(root, MIRROR);
    const { before, after } = toCrlf(abs);
    // Guard the fixture itself: if the conversion were a no-op the test would
    // pass for the wrong reason.
    assert.notEqual(after, before, 'fixture: the CRLF conversion must change the bytes');
    assert.ok(after.includes('\r\n'), 'fixture: the file must actually contain CRLF now');

    const second = sync.runSync({ rootDir: root, items, workspace: 'probe', now: FIXED_NOW });

    assert.equal(
      second.warnings, 0,
      `A line-ending-only difference was reported as a local edit. ` +
      `warningsList=${JSON.stringify(second.warningsList)}`
    );
    assert.equal(second.unchanged, 1, 'the mirror should register as UNCHANGED');
    assert.equal(second.updated, 0, 'nothing about the source changed, so no update either');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// 2. Genuine edit — must STILL warn  (DoD 2)
// ---------------------------------------------------------------------------

test('KBT-TC3512: a genuinely hand-edited mirror still warns', () => {
  const root = mkTmpRoot();
  try {
    const items = [skillItem()];
    sync.runSync({ rootDir: root, items, workspace: 'probe', now: FIXED_NOW });

    const abs = path.join(root, MIRROR);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\nA line a human added by hand.\n', 'utf8');

    const second = sync.runSync({ rootDir: root, items, workspace: 'probe', now: FIXED_NOW });

    assert.equal(second.warnings, 1, 'a real local edit must be protected by a warning');
    assert.equal(second.warningsList[0].targetPath, MIRROR.split(path.sep).join('/'));
    assert.match(second.warningsList[0].reason, /on-disk hash differs from manifest targetHash/);
    // And the human's text must survive.
    assert.match(fs.readFileSync(abs, 'utf8'), /A line a human added by hand\./);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// 3. CRLF *and* a genuine edit — the over-normalisation detector  (DoD 2/3)
// ---------------------------------------------------------------------------

test('KBT-TC3512: CRLF plus a real edit still warns — normalisation must not go further than line endings', () => {
  const root = mkTmpRoot();
  try {
    const items = [skillItem()];
    sync.runSync({ rootDir: root, items, workspace: 'probe', now: FIXED_NOW });

    const abs = path.join(root, MIRROR);
    // Real content change AND the autocrlf rewrite, in that order — the exact
    // shape of the KBT-B525 near-miss, where one genuinely edited file hid
    // inside a batch of line-ending noise.
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\nOperational runbook step nobody wants to lose.\n', 'utf8');
    toCrlf(abs);

    const second = sync.runSync({ rootDir: root, items, workspace: 'probe', now: FIXED_NOW });

    assert.equal(
      second.warnings, 1,
      'A file that was BOTH converted to CRLF and genuinely edited must still warn. ' +
      'Zero warnings here means the normalisation is eating real content differences.'
    );
    assert.match(fs.readFileSync(abs, 'utf8'), /Operational runbook step nobody wants to lose\./);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// 4. sourceHash — the other side of the comparison
// ---------------------------------------------------------------------------

test('KBT-TC3512: CRLF in the toolkit content does not fake an UPDATE', () => {
  const root = mkTmpRoot();
  try {
    // Same content, delivered once with CRLF and once with LF. The rendered
    // file is identical either way (renderFile already normalises the body), so
    // any difference can only come from sourceHash — which the issue flags
    // explicitly: "sourceHash needs the same treatment, otherwise the problem
    // just moves."
    const crlf = skillItem({ content: 'Alpha line.\r\n\r\nBeta line.\r\nGamma line.\r\n' });
    const lf = skillItem({ content: 'Alpha line.\n\nBeta line.\nGamma line.\n' });

    const first = sync.runSync({ rootDir: root, items: [crlf], workspace: 'probe', now: FIXED_NOW });
    assert.equal(first.created, 1, 'setup: first sync creates the mirror');

    const second = sync.runSync({ rootDir: root, items: [lf], workspace: 'probe', now: FIXED_NOW });

    assert.equal(
      second.updated, 0,
      'Re-delivering byte-identical content with different line endings must not ' +
      'register as a source change.'
    );
    assert.equal(second.unchanged, 1, 'the item should register as UNCHANGED');
    assert.equal(second.warnings, 0, 'and it must not warn either');
  } finally {
    cleanup(root);
  }
});

test('KBT-TC3512: a real content change is still an UPDATE when line endings also differ', () => {
  const root = mkTmpRoot();
  try {
    // The mirror of test 3, on the source side: normalising sourceHash must not
    // swallow an actual edit to the toolkit item.
    const v1 = skillItem({ content: 'Alpha line.\r\nBeta line.\r\n' });
    const v2 = skillItem({ content: 'Alpha line.\nBeta line.\nGamma line added in the Toolkit.\n' });

    sync.runSync({ rootDir: root, items: [v1], workspace: 'probe', now: FIXED_NOW });
    const second = sync.runSync({ rootDir: root, items: [v2], workspace: 'probe', now: FIXED_NOW });

    assert.equal(second.updated, 1, 'a genuine toolkit edit must still re-render the mirror');
    assert.match(
      fs.readFileSync(path.join(root, MIRROR), 'utf8'),
      /Gamma line added in the Toolkit\./
    );
  } finally {
    cleanup(root);
  }
});
