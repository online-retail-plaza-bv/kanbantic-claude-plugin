'use strict';

//
// dev-channels-consistency.test.js — KBT-F726 (KBT-T4631/T4633, KBT-SR632, KBT-B976)
//
// Re-runnable regression guard for the dev-channels launch-flag fix. Before this fix,
// both launch scripts used --dangerously-load-development-channels server:kanbantic
// (wrong value — matches only a hand-configured MCP server, never a plugin-delivered
// one, KBT-B465) in the SPACE form (flag and value as separate argv entries, KBT-B242:
// the CLI parser then swallows the following positional prompt as an untagged channel
// entry and exits 1). KBT-SR632 records the norm: the equals-form
// (--dangerously-load-development-channels=plugin:<plugin>@<marketplace>) is the only
// form that is safe in every case. This guard fails loudly if either regression
// reappears, instead of relying on someone re-reading the scripts by eye.
//
// Mirrors the file-content-scan style of plugin/tests/v3-vocabulary-alignment.test.js
// (KBT-F575).
//

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORRECT_EQUALS_FORM = '--dangerously-load-development-channels=plugin:kanbantic-claude-plugin@kanbantic';
const STALE_VALUE = 'server:kanbantic';

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('KBT-SR632: launch-orchestrator.ps1 uses the equals-form with the plugin-delivered value', () => {
  const content = read('scripts/launch-orchestrator.ps1');
  assert.ok(
    content.includes(CORRECT_EQUALS_FORM),
    `launch-orchestrator.ps1 must build the flag as one equals-form argument: ${CORRECT_EQUALS_FORM}`
  );
  assert.ok(
    !content.includes(STALE_VALUE),
    `launch-orchestrator.ps1 must not reference the stale value "${STALE_VALUE}" (KBT-B465 — matches only a hand-configured MCP server, never accepts a channel push from the plugin)`
  );
});

test('KBT-SR632: launch-orchestrator.sh uses the equals-form with the plugin-delivered value', () => {
  const content = read('scripts/launch-orchestrator.sh');
  assert.ok(
    content.includes(CORRECT_EQUALS_FORM),
    `launch-orchestrator.sh must invoke claude with one equals-form argument: ${CORRECT_EQUALS_FORM}`
  );
  assert.ok(
    !content.includes(STALE_VALUE),
    `launch-orchestrator.sh must not reference the stale value "${STALE_VALUE}"`
  );
});

test('README.md no longer documents the stale server:kanbantic value', () => {
  const content = read('README.md');
  assert.ok(
    !content.includes(STALE_VALUE),
    `README.md must not reference the stale value "${STALE_VALUE}" (KBT-B465 — the correct value is plugin:kanbantic-claude-plugin@kanbantic)`
  );
});

test('README.md lane table/diagram no longer uses the dead "Prepared" status name (non-historical)', () => {
  const content = read('README.md');
  // Historical notes (e.g. "renamed from `Prepared`", the seeder class name) are allowed —
  // this guard only fails on a BARE "Prepared" used as if it were still a live status.
  const bareOffenders = content
    .split('\n')
    .filter((line) => line.includes('Prepared'))
    .filter((line) => !/renamed from `?Prepared`?|PreparedStatusBackfillSeeder|originally named `?Prepared`?/i.test(line));
  assert.deepEqual(
    bareOffenders, [],
    `README.md still contains a non-historical "Prepared" reference (dead v3 enum value, renamed to Ready in KBT-E103/v3):\n${bareOffenders.join('\n')}`
  );
});
