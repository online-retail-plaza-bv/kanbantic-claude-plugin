'use strict';

//
// session-start-disk-space.test.js — KBT-F754 / KBT-TC4233
//
// E2E for the SessionStart half of the disk cleanup. The hook is only worth
// anything if the runtime actually runs it, so — as in
// session-start-release-drift.test.js — the command string is read out of
// hooks.json, `${CLAUDE_PLUGIN_ROOT}` is expanded the way Claude Code expands
// it, and the result is spawned with a SessionStart payload on stdin.
//
// The measurement itself goes through KANBANTIC_DISK_SPACE_FIXTURE: fs.statfs
// cannot be mocked inside a child process, and a hook that is only ever tested
// on the author's workstation (which happened to be full) is not tested.
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const pluginRoot = path.join(repoRoot, 'plugin');
const hooksJsonPath = path.join(pluginRoot, 'hooks', 'hooks.json');
const hook = require(path.join(pluginRoot, 'hooks', 'session-start-disk-space.js'));

const GB = 1024 ** 3;

function declaredSessionStartCommands() {
  const cfg = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const groups = (cfg.hooks && cfg.hooks.SessionStart) || [];
  return groups
    .flatMap((g) => g.hooks || [])
    .filter((h) => h && h.type === 'command' && typeof h.command === 'string')
    .map((h) => ({ ...h, expanded: h.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot) }));
}

function toArgv(command) {
  return (command.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
}

function diskHookCommand() {
  const h = declaredSessionStartCommands().find((x) => x.command.includes('session-start-disk-space.js'));
  assert.ok(h, 'the disk-space hook must be declared before it can be exercised');
  return h.expanded;
}

function fixture(freeGb, totalGb = 128, label = 'X:\\') {
  return JSON.stringify({ freeBytes: freeGb * GB, totalBytes: totalGb * GB, path: label });
}

function runHook(env, { cwd = os.tmpdir(), stdin } = {}) {
  const argv = toArgv(diskHookCommand());
  const clean = { ...process.env };
  for (const k of ['KANBANTIC_DISK_WARN_GB', 'KANBANTIC_DISK_CRITICAL_GB', 'KANBANTIC_SKIP_DISK_CHECK', 'KANBANTIC_DISK_SPACE_FIXTURE']) {
    delete clean[k];
  }
  return spawnSync(argv[0], argv.slice(1), {
    input: stdin === undefined ? JSON.stringify({ hook_event_name: 'SessionStart', cwd, source: 'startup' }) : stdin,
    encoding: 'utf8',
    env: { ...clean, ...env },
    timeout: 8000,
  });
}

// ─── wiring ──────────────────────────────────────────────────────────────────

test('the disk-space check is declared exactly once as a SessionStart hook, with a timeout', () => {
  const match = declaredSessionStartCommands().filter((h) => h.command.includes('session-start-disk-space.js'));
  assert.equal(match.length, 1);
  assert.ok(match[0].timeout > 0, 'a SessionStart hook that hangs makes every session unusable');
});

test('the declared command resolves to a file that exists', () => {
  const target = toArgv(diskHookCommand()).find((a) => a.endsWith('.js'));
  assert.ok(target && fs.existsSync(target), `missing hook file: ${target}`);
});

test('the sibling SessionStart hooks are still declared', () => {
  const commands = declaredSessionStartCommands().map((h) => h.command).join('\n');
  for (const kept of ['check-update.sh', 'session-start-toolkit-sync.js', 'session-start-release-drift.js']) {
    assert.ok(commands.includes(kept), `${kept} must remain declared — this change adds a hook, it replaces none`);
  }
});

// ─── pure halves ─────────────────────────────────────────────────────────────

test('readThresholds: defaults, overrides, off-switches and nonsense', () => {
  assert.deepEqual(hook.readThresholds({}), { warnGb: 20, criticalGb: 12, skip: false });
  assert.deepEqual(hook.readThresholds({ KANBANTIC_DISK_WARN_GB: '40', KANBANTIC_DISK_CRITICAL_GB: '25' }),
    { warnGb: 40, criticalGb: 25, skip: false });
  assert.equal(hook.readThresholds({ KANBANTIC_DISK_WARN_GB: '0' }).skip, true);
  assert.equal(hook.readThresholds({ KANBANTIC_DISK_WARN_GB: 'off' }).skip, true);
  assert.equal(hook.readThresholds({ KANBANTIC_SKIP_DISK_CHECK: '1' }).skip, true);
  assert.deepEqual(hook.readThresholds({ KANBANTIC_DISK_WARN_GB: 'lots', KANBANTIC_DISK_CRITICAL_GB: '-3' }),
    { warnGb: 20, criticalGb: 12, skip: false }, 'garbage falls back to the defaults, never crashes');
  assert.equal(hook.readThresholds({ KANBANTIC_DISK_WARN_GB: '5', KANBANTIC_DISK_CRITICAL_GB: '9' }).criticalGb, 5,
    'critical can never exceed warn');
});

test('formatNotice: silent above the threshold, one line below, critical wording further down', () => {
  const t = { warnGb: 20, criticalGb: 12 };
  assert.equal(hook.formatNotice({ path: 'C:\\', freeBytes: 50 * GB, totalBytes: 128 * GB }, t), null);
  assert.equal(hook.formatNotice({ path: 'C:\\', freeBytes: 20 * GB, totalBytes: 128 * GB }, t), null, 'exactly at the threshold is fine');
  const warn = hook.formatNotice({ path: 'C:\\', freeBytes: 15 * GB, totalBytes: 128 * GB }, t);
  assert.match(warn, /^\[kanbantic-disk-space\] 15\.00 GB vrij van 128\.00 GB op C:\\/);
  assert.match(warn, /drempel van 20 GB/);
  assert.ok(warn.includes(hook.CLEANUP_COMMAND));
  assert.ok(!warn.includes('KRITIEK'));
  const crit = hook.formatNotice({ path: 'C:\\', freeBytes: 0.1 * GB, totalBytes: 128 * GB }, t);
  assert.match(crit, /KRITIEK: 0\.10 GB vrij/);
  assert.ok(crit.includes(hook.CLEANUP_COMMAND));
  assert.equal(hook.formatNotice(null, t), null);
  assert.equal(hook.formatNotice({ freeBytes: NaN, totalBytes: 1 }, t), null);
});

// ─── running it the way the runtime does ─────────────────────────────────────

test('the declared hook is SILENT when there is enough free space', () => {
  const r = runHook({ KANBANTIC_DISK_SPACE_FIXTURE: fixture(60) });
  assert.equal(r.status, 0, 'a SessionStart hook must never fail a session');
  assert.equal(r.stdout.trim(), '', 'silence above the threshold — a hook that always speaks is a hook nobody reads');
});

test('the declared hook warns in one line below the threshold and names the cleanup command', () => {
  const r = runHook({ KANBANTIC_DISK_SPACE_FIXTURE: fixture(9.5) });
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[kanbantic-disk-space\] KRITIEK: 9\.50 GB vrij van 128\.00 GB op X:\\/);
  assert.ok(lines[0].includes('/kanbantic-disk-cleanup'));
});

test('the declared hook honours the environment thresholds', () => {
  const warn = runHook({ KANBANTIC_DISK_SPACE_FIXTURE: fixture(30), KANBANTIC_DISK_WARN_GB: '40', KANBANTIC_DISK_CRITICAL_GB: '20' });
  assert.equal(warn.status, 0);
  assert.match(warn.stdout, /onder de drempel van 40 GB/);
  assert.ok(!warn.stdout.includes('KRITIEK'));

  const off = runHook({ KANBANTIC_DISK_SPACE_FIXTURE: fixture(0.01), KANBANTIC_DISK_WARN_GB: '0' });
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), '', 'KANBANTIC_DISK_WARN_GB=0 disables the hook');

  const skip = runHook({ KANBANTIC_DISK_SPACE_FIXTURE: fixture(0.01), KANBANTIC_SKIP_DISK_CHECK: '1' });
  assert.equal(skip.status, 0);
  assert.equal(skip.stdout.trim(), '');
});

test('the declared hook is fail-safe: an unusable fixture or payload yields exit 0 and no output', () => {
  const bad = runHook({ KANBANTIC_DISK_SPACE_FIXTURE: '{not json' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.trim(), '');

  const noPayload = runHook({ KANBANTIC_DISK_SPACE_FIXTURE: fixture(1) }, { stdin: 'garbage, not json' });
  assert.equal(noPayload.status, 0);
  assert.match(noPayload.stdout, /KRITIEK/, 'a bad payload falls back to the process cwd, the measurement still runs');
});

test('without a fixture the hook measures the real volume of the payload cwd and still exits 0', () => {
  const r = runHook({}, { cwd: os.tmpdir() });
  assert.equal(r.status, 0);
  // Whether it speaks depends on the machine; what it says must be well-formed.
  if (r.stdout.trim()) {
    assert.match(r.stdout.trim(), /^\[kanbantic-disk-space\] .* GB vrij van .* GB op /);
  }
});
