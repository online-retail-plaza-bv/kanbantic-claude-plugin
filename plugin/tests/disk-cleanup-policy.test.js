'use strict';

//
// disk-cleanup-policy.test.js — KBT-F754 / KBT-TC4232
//
// The policy item is the one place a workspace can say "do not touch this
// folder". A parser that silently drops a row it does not understand turns
// that protection into a false sense of safety — so the shape under test is
// fail-not-skip (KBT-RL191): every malformed row lands in `errors`.
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { POLICY_ITEM_TITLE, DEFAULTS, parseDiskCleanupPolicy, isProtected } =
  require(path.resolve(__dirname, '..', 'scripts', 'disk-cleanup-policy.js'));

const FULL = `
# Disk cleanup policy for this workspace

Some prose that the parser must ignore.

| Setting | Value |
|---|---|
| warn-gb | 25 |
| critical-gb | 10 |
| repo-roots | C:\\github, D:\\work |
| protected-paths | C:\\github\\big\\node_modules; D:\\keep |
| temp-age-days | 3 |
| delegate-to | maintenance-agent |
| elevated-script | KBT-CUST002 |
| docker | skip |
`;

test('the item title is the fixed slug the skill searches for', () => {
  assert.equal(POLICY_ITEM_TITLE, 'disk-cleanup-policy');
});

test('an empty or absent body yields the defaults and no errors', () => {
  for (const body of ['', null, undefined, '# nothing here\n\njust prose']) {
    const r = parseDiskCleanupPolicy(body);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.policy, { ...DEFAULTS, repoRoots: [], protectedPaths: [] });
    assert.deepEqual(r.seen, []);
  }
});

test('a full table parses every setting, columns recognised by name', () => {
  const r = parseDiskCleanupPolicy(FULL);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.policy, {
    warnGb: 25,
    criticalGb: 10,
    repoRoots: ['C:\\github', 'D:\\work'],
    protectedPaths: ['C:\\github\\big\\node_modules', 'D:\\keep'],
    tempAgeDays: 3,
    delegateTo: 'maintenance-agent',
    elevatedScript: 'KBT-CUST002',
    docker: 'skip',
  });
  assert.equal(r.seen.length, 8);
});

test('column order does not matter and the key is matched loosely', () => {
  const body = '| Value | Setting |\n|---|---|\n| 30 | Warn GB |\n| 2 | temp_age_days |\n';
  const r = parseDiskCleanupPolicy(body);
  assert.deepEqual(r.errors, []);
  assert.equal(r.policy.warnGb, 30);
  assert.equal(r.policy.tempAgeDays, 2);
});

test('fail-not-skip: an unknown setting lands in errors with its line number', () => {
  const body = '| Setting | Value |\n|---|---|\n| protect-paths | C:\\x |\n';
  const r = parseDiskCleanupPolicy(body);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 3);
  assert.match(r.errors[0].reason, /onbekende setting "protect-paths"/);
  assert.deepEqual(r.policy.protectedPaths, [], 'a misspelt protected-paths must not be guessed into place');
});

test('fail-not-skip: a non-numeric threshold and an unknown docker mode are errors', () => {
  const body = '| Setting | Value |\n|---|---|\n| warn-gb | twenty |\n| docker | everything |\n';
  const r = parseDiskCleanupPolicy(body);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0].reason, /warn-gb: verwacht een getal/);
  assert.match(r.errors[1].reason, /docker verwacht build-cache-only of skip/);
  assert.equal(r.policy.warnGb, DEFAULTS.warnGb, 'the bad value must not leak into the policy');
});

test('a critical threshold above the warn threshold is reported', () => {
  const body = '| Setting | Value |\n|---|---|\n| warn-gb | 10 |\n| critical-gb | 15 |\n';
  const r = parseDiskCleanupPolicy(body);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].reason, /critical-gb \(15\) hoort niet boven warn-gb \(10\)/);
});

test('tables without a Setting/Value header are ignored, not misread', () => {
  const body = '| Check | Scope | Command | On fail |\n|---|---|---|---|\n| docker up | always | docker info | stop |\n';
  const r = parseDiskCleanupPolicy(body);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.seen, []);
});

test('a dash or empty value clears an optional string setting', () => {
  const body = '| Setting | Value |\n|---|---|\n| delegate-to | - |\n| elevated-script | |\n';
  const r = parseDiskCleanupPolicy(body);
  assert.deepEqual(r.errors, []);
  assert.equal(r.policy.delegateTo, null);
  assert.equal(r.policy.elevatedScript, null);
});

test('isProtected matches the path itself and anything nested under it', () => {
  const prot = ['C:\\github\\big\\node_modules', '/srv/keep'];
  assert.equal(isProtected('C:\\github\\big\\node_modules', prot, { platform: 'win32' }), true);
  assert.equal(isProtected('c:/github/BIG/node_modules/pkg', prot, { platform: 'win32' }), true);
  assert.equal(isProtected('C:\\github\\big\\node_modules2', prot, { platform: 'win32' }), false);
  assert.equal(isProtected('/srv/keep/sub', prot, { platform: 'linux' }), true);
  assert.equal(isProtected('/srv/KEEP', prot, { platform: 'linux' }), false, 'case-sensitive outside Windows');
  assert.equal(isProtected('/srv/other', [], { platform: 'linux' }), false);
});
