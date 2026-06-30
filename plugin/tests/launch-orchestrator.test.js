'use strict';

//
// launch-orchestrator.test.js — KBT-F438 / KBT-T3293
//
// Validates plugin/scripts/launch-orchestrator.ps1 WITHOUT ever spawning a real
// Claude Code process. The script exposes two test seams that make this
// deterministic and side-effect-free:
//
//   -DryRun          resolve everything and print the launch plan as one JSON
//                    line, then exit 0 instead of spawning Claude Code. The API
//                    key value is never printed — only its presence + source.
//   -RegistryValue   dependency-injection for the HKCU\Environment fallback:
//                    use the supplied value as if it came from the registry, so
//                    the fallback branch is exercised without touching the real
//                    registry.
//   -SkipRegistryFallback  force the env-only path so a real machine-level key
//                    cannot mask the missing-key fail-fast branch.
//
// Coverage:
//   1. argument parsing + env resolution (DryRun plan reflects workspace /
//      initiative / repos and apiKeySource=env).
//   2. env takes precedence over the registry fallback.
//   3. registry fallback resolves when env is absent (injected value).
//   4. fail-fast: missing key → exit 3, diagnostic on stderr, no spawn.
//   5. fail-fast: missing required -Workspace → exit 2.
//
// PowerShell selection: prefer `pwsh` (PS 7+); fall back to `powershell`
// (Windows PowerShell 5.1 — the script targets #requires -Version 5.1). If
// neither is on PATH (e.g. a bare Linux CI without PowerShell), the whole suite
// is skipped rather than failing — the script is Windows-primary and a POSIX
// `.sh` counterpart exists for non-Windows hosts.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(
  __dirname, '..', 'scripts', 'launch-orchestrator.ps1'
);

function findPowerShell() {
  for (const cand of ['pwsh', 'powershell']) {
    const probe = spawnSync(cand, ['-NoProfile', '-Command', 'exit 0'], {
      encoding: 'utf8',
    });
    if (!probe.error && probe.status === 0) return cand;
  }
  return null;
}

const PWSH = findPowerShell();

// Build a clean env with KANBANTIC_API_KEY removed, then apply overrides.
function envWithout(...overrides) {
  const env = { ...process.env };
  delete env.KANBANTIC_API_KEY;
  return Object.assign(env, ...overrides);
}

function runScript(args, env) {
  return spawnSync(
    PWSH,
    ['-NoProfile', '-File', SCRIPT, ...args],
    { encoding: 'utf8', env }
  );
}

// Parse the single compressed-JSON line a -DryRun emits.
function parsePlan(stdout) {
  const line = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
  return JSON.parse(line);
}

test('launch-orchestrator.ps1', { skip: PWSH ? false : 'no PowerShell (pwsh/powershell) on PATH' }, async (t) => {

  await t.test('1: parses args + resolves key from env (DryRun, no spawn)', () => {
    const r = runScript(
      ['-Workspace', 'kanbantic', '-Initiative', 'KBT-INI033',
       '-Repos', 'repoA,repoB', '-DryRun'],
      envWithout({ KANBANTIC_API_KEY: 'ka_env_abc123' })
    );
    assert.equal(r.status, 0, `expected exit 0\nSTDERR: ${r.stderr}`);
    const plan = parsePlan(r.stdout);
    assert.equal(plan.workspace, 'kanbantic');
    assert.equal(plan.initiative, 'KBT-INI033');
    assert.equal(plan.repos, 'repoA,repoB');
    assert.equal(plan.apiKeyPresent, true);
    assert.equal(plan.apiKeySource, 'env');
    assert.equal(plan.spawned, false);
    // The channel flag is always present; the prompt carries the parameters.
    assert.ok(plan.claudeArgs.includes('--dangerously-load-development-channels'));
    assert.ok(plan.claudeArgs.includes('server:kanbantic'));
    assert.match(plan.prompt, /^\/kanbantic-orchestrate workspace=kanbantic initiative=KBT-INI033 repos=repoA,repoB$/);
    // The key value must NEVER appear in output.
    assert.ok(!r.stdout.includes('ka_env_abc123'), 'API key leaked into stdout');
  });

  await t.test('2: env wins over registry fallback', () => {
    const r = runScript(
      ['-Workspace', 'kanbantic', '-Initiative', 'KBT-INI033',
       '-RegistryValue', 'ka_reg_zzz', '-DryRun'],
      envWithout({ KANBANTIC_API_KEY: 'ka_env_abc123' })
    );
    assert.equal(r.status, 0, `expected exit 0\nSTDERR: ${r.stderr}`);
    const plan = parsePlan(r.stdout);
    assert.equal(plan.apiKeySource, 'env');
  });

  await t.test('3: registry fallback resolves when env is absent', () => {
    const r = runScript(
      ['-Workspace', 'kanbantic', '-Initiative', 'KBT-INI033',
       '-RegistryValue', 'ka_reg_zzz', '-DryRun'],
      envWithout()
    );
    assert.equal(r.status, 0, `expected exit 0\nSTDERR: ${r.stderr}`);
    const plan = parsePlan(r.stdout);
    assert.equal(plan.apiKeySource, 'registry(injected)');
    assert.equal(plan.repos, null, 'repos omitted should serialize as null');
    assert.ok(!r.stdout.includes('ka_reg_zzz'), 'injected key leaked into stdout');
  });

  await t.test('4: fail-fast on missing key — exit 3, no spawn', () => {
    const r = runScript(
      ['-Workspace', 'kanbantic', '-Initiative', 'KBT-INI033',
       '-SkipRegistryFallback'],
      envWithout()
    );
    assert.equal(r.status, 3, `expected exit 3\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
    assert.match(r.stderr, /KANBANTIC_API_KEY not found/);
    assert.match(r.stderr, /NOT started/);
    // No launch plan was printed → the script never reached the spawn branch.
    assert.ok(!r.stdout.includes('"spawned"'), 'should not have produced a plan');
  });

  await t.test('5: fail-fast on missing -Workspace — exit 2', () => {
    const r = runScript(
      ['-Initiative', 'KBT-INI033', '-DryRun'],
      envWithout({ KANBANTIC_API_KEY: 'ka_env_abc123' })
    );
    assert.equal(r.status, 2, `expected exit 2\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
    assert.match(r.stderr, /missing -Workspace/);
  });
});
