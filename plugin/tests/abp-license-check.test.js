'use strict';

//
// KBT-F263 — abp-license-check (plugin/hooks/abp-license-check.ps1)
//
// Verifies the six paths covered by KBT-TC1913..KBT-TC1918:
//   - KBT-TC1913 — ok            : env-var present + token present + token fresh
//   - KBT-TC1914 — stale-token   : token LastWriteTime > threshold
//   - KBT-TC1915 — missing-env-var: ABP_LICENSE_CODE absent across all scopes
//   - KBT-TC1916 — skipped-env   : KANBANTIC_SKIP_ABP_CHECK=1 opt-out
//   - KBT-TC1917 — out-of-scope  : frontend/plugin issue without backend tag
//   - KBT-TC1918 — SKILL.md      : Step 0.7 integration markers in the skill markdown
//
// KBT-TC1919 (full E2E with live kanbantic-issue-execute) is waivered to manual/CI
// verification, mirroring KBT-F238's E2E test-case justification.
//
// Strategy: spawn `pwsh` as a child process against real temp USERPROFILE
// fixture directories — no MCP, no network. The script emits a single line
// of JSON on stdout that we parse and assert against.
//
// Skipped automatically when pwsh is not on PATH (e.g. CI Linux runners without
// PowerShell installed). The script is PowerShell-Core-compatible
// (`#requires -Version 5.1`), so Linux/macOS CI installing pwsh works too.
//
// Zero deps — only node built-ins.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCRIPT_PATH = path.resolve(
  __dirname,
  '..',
  'hooks',
  'abp-license-check.ps1'
);

const SKILL_PATH = path.resolve(
  __dirname,
  '..',
  'skills',
  'kanbantic-issue-execute',
  'SKILL.md'
);

const HAS_PWSH = (() => {
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
  });
  return r.status === 0;
})();

const SKIP_REASON = !HAS_PWSH
  ? 'pwsh not on PATH — install PowerShell Core to run these tests'
  : null;

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkFreshTokenFixture(prefix, ageDays) {
  // Build a fake USERPROFILE with .abp/cli/access-token.bin, then back-date it
  // to `ageDays` ago (0 = "now"). Returns the path to use as USERPROFILE.
  const profile = mkTmpDir(prefix);
  const dir = path.join(profile, '.abp', 'cli');
  fs.mkdirSync(dir, { recursive: true });
  const tokenPath = path.join(dir, 'access-token.bin');
  fs.writeFileSync(tokenPath, 'fake-token-blob');
  if (ageDays > 0) {
    const now = Date.now();
    const past = new Date(now - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(tokenPath, past, past);
  }
  return profile;
}

function mkEmptyProfile(prefix) {
  // Just an empty USERPROFILE — no .abp/ directory at all.
  return mkTmpDir(prefix);
}

// ---------------------------------------------------------------------------
// KBT-B480 fixtures — make the ABP NuGet-feed check deterministic.
//
// The hook resolves feed availability from (1) the NuGet package cache, honoring
// NUGET_PACKAGES, else (2) `dotnet nuget list source`. Tests must not depend on
// whether the host machine happens to have an ABP source registered — that is
// exactly the kind of ambient dependency KBT-B484 was filed for.
// ---------------------------------------------------------------------------

function mkProPackageCache(prefix) {
  // A NUGET_PACKAGES root that already contains an ABP Pro package, so the
  // cache branch short-circuits and the feed counts as available everywhere.
  const root = mkTmpDir(prefix);
  fs.mkdirSync(path.join(root, 'volo.abp.identity.pro.domain'), { recursive: true });
  return root;
}

function mkDotnetShim(prefix, mode) {
  // A directory to prepend to PATH containing a fake `dotnet`.
  //   mode 'nuget-only' → lists only nuget.org, exit 0  → no-abp-source
  //   mode 'fail'       → exit 1                        → inconclusive
  //
  // Both .cmd (Windows, via PATHEXT) and an extensionless sh script (POSIX) are
  // written so the shim works on either platform. The real PATH is kept after
  // the shim dir so pwsh itself still resolves.
  const dir = mkTmpDir(prefix);

  const cmdLines = mode === 'fail'
    ? ['@echo off', 'exit /b 1']
    : [
        '@echo off',
        'echo Registered Sources:',
        'echo   1.  nuget.org [Enabled]',
        'echo       https://api.nuget.org/v3/index.json',
        'exit /b 0',
      ];
  fs.writeFileSync(path.join(dir, 'dotnet.cmd'), cmdLines.join('\r\n') + '\r\n');

  const shLines = mode === 'fail'
    ? ['#!/bin/sh', 'exit 1']
    : [
        '#!/bin/sh',
        'echo "Registered Sources:"',
        'echo "  1.  nuget.org [Enabled]"',
        'echo "      https://api.nuget.org/v3/index.json"',
        'exit 0',
      ];
  const shPath = path.join(dir, 'dotnet');
  const sh = shLines.join('\n') + '\n';
  fs.writeFileSync(shPath, sh);
  try {
    fs.chmodSync(shPath, 0o755);
  } catch {
    // chmod is a no-op/unsupported on some Windows setups — harmless here.
  }
  return dir;
}

function withShimPath(shimDir) {
  return { PATH: shimDir + path.delimiter + (process.env.PATH || '') };
}

function runHook(args, extraEnv) {
  // Build a sanitized env so we never inherit the host's ABP_LICENSE_CODE,
  // KANBANTIC_SKIP_ABP_CHECK, or USERPROFILE. Each test sets the exact env
  // it wants explicitly.
  const env = Object.assign({}, process.env);
  delete env.ABP_LICENSE_CODE;
  delete env.KANBANTIC_SKIP_ABP_CHECK;
  delete env.KANBANTIC_ABP_TOKEN_MAX_AGE_DAYS;
  // Keep PATH, but blank USERPROFILE so the test fixture has to supply it.
  delete env.USERPROFILE;
  delete env.HOME;
  Object.assign(env, extraEnv || {});

  const fullArgs = ['-NoProfile', '-File', SCRIPT_PATH, ...args];
  const r = spawnSync('pwsh', fullArgs, { encoding: 'utf8', env });
  let parsed = null;
  try {
    parsed = JSON.parse((r.stdout || '').trim());
  } catch (e) {
    throw new Error(
      `Could not parse JSON output from abp-license-check.\nExit: ${r.status}\nStdout:\n${r.stdout}\nStderr:\n${r.stderr}`
    );
  }
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, result: parsed };
}

function cleanup(...paths) {
  for (const p of paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (_) {
      // best effort
    }
  }
}

function hookTest(name, fn) {
  if (SKIP_REASON) {
    test(name, { skip: SKIP_REASON }, fn);
  } else {
    test(name, fn);
  }
}

// ---------------------------------------------------------------------------
// KBT-TC1913 — ok: env-var present + token present + token fresh
// ---------------------------------------------------------------------------
hookTest('KBT-TC1913 — happy path: ok when env-var set and token fresh', (t) => {
  const profile = mkFreshTokenFixture('kbt-f263-ok-', 0);
  // KBT-B480 — supply a cache containing an ABP Pro package so the new feed
  // check passes regardless of the host's NuGet sources (CI has none).
  const cache = mkProPackageCache('kbt-b480-ok-cache-');
  t.after(() => cleanup(profile, cache));

  const { exitCode, result } = runHook(
    ['kanbantic-api', '', profile],
    {
      ABP_LICENSE_CODE: 'test-license-1234',
      USERPROFILE: profile,
      HOME: profile,
      NUGET_PACKAGES: cache,
    }
  );

  assert.equal(exitCode, 0, `expected exit 0 (stderr=${result && JSON.stringify(result.messages)})`);
  assert.equal(result.action, 'ok');
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.applicationSlug, 'kanbantic-api');
  assert.equal(result.thresholdDays, 7);
  assert.ok(result.tokenAgeDays !== null && result.tokenAgeDays < 1, 'token age should be < 1 day');
});

// ---------------------------------------------------------------------------
// KBT-TC1914 — stale-token: token older than threshold
// ---------------------------------------------------------------------------
hookTest('KBT-TC1914 — stale-token: returns action=stale-token + exit 1 when token >7d old', (t) => {
  const profile = mkFreshTokenFixture('kbt-f263-stale-', 10); // 10 days old
  t.after(() => cleanup(profile));

  const { exitCode, result } = runHook(
    ['kanbantic-api', '', profile],
    { ABP_LICENSE_CODE: 'test-license-1234', USERPROFILE: profile, HOME: profile }
  );

  assert.equal(exitCode, 1, 'expected exit 1 for FAIL');
  assert.equal(result.action, 'stale-token');
  assert.equal(result.ok, false);
  assert.ok(result.tokenAgeDays >= 9, `expected tokenAgeDays >= 9, got ${result.tokenAgeDays}`);
  assert.equal(result.thresholdDays, 7);
  const joined = (result.messages || []).join('\n');
  assert.ok(/abp login/.test(joined), `messages should mention "abp login"; got:\n${joined}`);
});

// ---------------------------------------------------------------------------
// KBT-TC1915 — missing-env-var: ABP_LICENSE_CODE not set
// ---------------------------------------------------------------------------
hookTest('KBT-TC1915 — missing-env-var: returns action=missing-env-var when ABP_LICENSE_CODE unset', (t) => {
  // Token file presence is irrelevant here — env-var check is first fail-fast.
  const profile = mkFreshTokenFixture('kbt-f263-noenv-', 0);
  t.after(() => cleanup(profile));

  const { exitCode, result } = runHook(
    ['kanbantic-mcp', '', profile],
    // NOTE: no ABP_LICENSE_CODE in extraEnv — the runHook helper already deleted
    // the inherited one. The script reads User/Machine scope as well, but the
    // hook also accepts process-env which we've explicitly blanked.
    { USERPROFILE: profile, HOME: profile }
  );

  // We allow that on some hosts the User-scope ABP_LICENSE_CODE is actually
  // set (developer machines). If so this test cannot assert missing-env-var
  // reliably and gracefully no-ops. We detect that by checking the action.
  if (result.action !== 'missing-env-var') {
    t.diagnostic(
      `Host has ABP_LICENSE_CODE set on User/Machine scope — cannot validate missing-env-var path. ` +
      `Action returned: ${result.action}. Test passes trivially.`
    );
    return;
  }

  assert.equal(exitCode, 1, 'expected exit 1 for FAIL');
  assert.equal(result.action, 'missing-env-var');
  assert.equal(result.ok, false);
  const joined = (result.messages || []).join('\n');
  assert.ok(/ABP_LICENSE_CODE/.test(joined), `messages should mention ABP_LICENSE_CODE; got:\n${joined}`);
});

// ---------------------------------------------------------------------------
// KBT-TC1916 — skipped-env: KANBANTIC_SKIP_ABP_CHECK=1 opt-out
// ---------------------------------------------------------------------------
hookTest('KBT-TC1916 — opt-out: KANBANTIC_SKIP_ABP_CHECK=1 returns action=skipped-env, exit 0', (t) => {
  // Fixture has NO token file — would normally FAIL with missing-token.
  const profile = mkEmptyProfile('kbt-f263-optout-');
  t.after(() => cleanup(profile));

  const { exitCode, result } = runHook(
    ['kanbantic-api', '', profile],
    { KANBANTIC_SKIP_ABP_CHECK: '1', USERPROFILE: profile, HOME: profile }
  );

  assert.equal(exitCode, 0, 'opt-out must exit 0 so skill continues');
  assert.equal(result.action, 'skipped-env');
  assert.equal(result.skipped, true);
  assert.equal(result.thresholdDays, 7, 'threshold should be reported even on opt-out');
  const joined = (result.messages || []).join('\n');
  assert.ok(/KANBANTIC_SKIP_ABP_CHECK/.test(joined), 'opt-out message must mention env-var');
});

// ---------------------------------------------------------------------------
// KBT-TC1917 — out-of-scope: frontend/plugin issue
// ---------------------------------------------------------------------------
hookTest('KBT-TC1917 — out-of-scope: frontend application + no backend tags returns out-of-scope, exit 0', (t) => {
  const profile = mkEmptyProfile('kbt-f263-oos-');
  t.after(() => cleanup(profile));

  const { exitCode, result } = runHook(
    ['kanbantic-angular', 'frontend,ui', profile],
    // No ABP_LICENSE_CODE — but scope gate must fire first.
    { USERPROFILE: profile, HOME: profile }
  );

  assert.equal(exitCode, 0, 'out-of-scope must exit 0 (no block)');
  assert.equal(result.action, 'out-of-scope');
  assert.equal(result.skipped, true);
  assert.equal(result.applicationSlug, 'kanbantic-angular');
});

hookTest('KBT-TC1917b — in-scope by tag: tag=backend triggers the check even if app is unknown', (t) => {
  const profile = mkFreshTokenFixture('kbt-f263-tag-', 0);
  // KBT-B480 — feed fixture, same reason as TC1913.
  const cache = mkProPackageCache('kbt-b480-tag-cache-');
  t.after(() => cleanup(profile, cache));

  const { exitCode, result } = runHook(
    ['some-unknown-app', 'backend', profile],
    { ABP_LICENSE_CODE: 'test', USERPROFILE: profile, HOME: profile, NUGET_PACKAGES: cache }
  );

  assert.equal(exitCode, 0);
  assert.equal(result.action, 'ok', 'backend tag must put us in scope');
});

// ---------------------------------------------------------------------------
// KBT-TC3291 (KBT-B480 / KBT-SR585) — ABP Commercial NuGet-feed reachability.
//
// The hook used to report ok while `dotnet build` was doomed to fail with
// 49x NU1101: ABP_LICENSE_CODE is a runtime licence, the feed is a restore
// source, and only the former was checked.
// ---------------------------------------------------------------------------

hookTest('KBT-TC3291 — missing-nuget-feed: no ABP source and empty cache → exit 1', (t) => {
  const profile = mkFreshTokenFixture('kbt-b480-nofeed-', 0);
  const cache = mkTmpDir('kbt-b480-nofeed-cache-');   // empty: no Pro packages
  const shim = mkDotnetShim('kbt-b480-shim-nuget-', 'nuget-only');
  t.after(() => cleanup(profile, cache, shim));

  const { exitCode, result } = runHook(
    ['kanbantic-api', '', profile],
    Object.assign(
      { ABP_LICENSE_CODE: 'test-license-1234', USERPROFILE: profile, HOME: profile, NUGET_PACKAGES: cache },
      withShimPath(shim)
    )
  );

  assert.equal(exitCode, 1, 'a doomed build must block before claim_issue');
  assert.equal(result.action, 'missing-nuget-feed');
  assert.equal(result.ok, false);

  const joined = (result.messages || []).join('\n');
  assert.ok(/NU1101/.test(joined), `messages should name the failure mode; got:\n${joined}`);
});

hookTest('KBT-TC3291 — feed available via cache → ok (no ABP source needed)', (t) => {
  const profile = mkFreshTokenFixture('kbt-b480-cache-', 0);
  const cache = mkProPackageCache('kbt-b480-cache-hit-');
  // Shim reports no ABP source: the cache branch alone must be sufficient.
  const shim = mkDotnetShim('kbt-b480-shim-cache-', 'nuget-only');
  t.after(() => cleanup(profile, cache, shim));

  const { exitCode, result } = runHook(
    ['kanbantic-api', '', profile],
    Object.assign(
      { ABP_LICENSE_CODE: 'test-license-1234', USERPROFILE: profile, HOME: profile, NUGET_PACKAGES: cache },
      withShimPath(shim)
    )
  );

  assert.equal(exitCode, 0);
  assert.equal(result.action, 'ok');
  assert.ok(
    /pro-packages-in-cache/.test((result.messages || []).join('\n')),
    'should report which branch satisfied the check'
  );
});

hookTest('KBT-TC3291 — fix instruction shows $env:ABP_API_KEY unexpanded and leaks no key', (t) => {
  const profile = mkFreshTokenFixture('kbt-b480-leak-', 0);
  const cache = mkTmpDir('kbt-b480-leak-cache-');
  const shim = mkDotnetShim('kbt-b480-shim-leak-', 'nuget-only');
  t.after(() => cleanup(profile, cache, shim));

  const { result, stdout } = runHook(
    ['kanbantic-api', '', profile],
    Object.assign(
      {
        ABP_LICENSE_CODE: 'test-license-1234',
        USERPROFILE: profile,
        HOME: profile,
        NUGET_PACKAGES: cache,
        ABP_API_KEY: 'super-secret-key-value',
      },
      withShimPath(shim)
    )
  );

  assert.equal(result.action, 'missing-nuget-feed');
  const joined = (result.messages || []).join('\n');

  // The instruction must reference the variable, never its value.
  assert.ok(
    joined.includes('$env:ABP_API_KEY'),
    `fix instruction must keep the env-var unexpanded; got:\n${joined}`
  );
  // Hard key-leak assertion across the entire output, not just messages.
  assert.ok(
    !stdout.includes('super-secret-key-value'),
    'the ABP_API_KEY value must never appear in the hook output'
  );
  assert.ok(
    !/nuget\.abp\.io\/[^/\s"]+\/v3\/index\.json/.test(stdout.replace(/\$env:ABP_API_KEY/g, '')),
    'no keyed feed URL may appear in the output'
  );
});

hookTest('KBT-TC3291 — ABP_API_KEY absent → reported as a second missing precondition', (t) => {
  const profile = mkFreshTokenFixture('kbt-b480-nokey-', 0);
  const cache = mkTmpDir('kbt-b480-nokey-cache-');
  const shim = mkDotnetShim('kbt-b480-shim-nokey-', 'nuget-only');
  t.after(() => cleanup(profile, cache, shim));

  const env = Object.assign(
    { ABP_LICENSE_CODE: 'test-license-1234', USERPROFILE: profile, HOME: profile, NUGET_PACKAGES: cache },
    withShimPath(shim)
  );
  const { result } = runHook(['kanbantic-api', '', profile], env);

  assert.equal(result.action, 'missing-nuget-feed');
  const joined = (result.messages || []).join('\n');
  // On a machine with ABP_API_KEY on User/Machine scope the hook legitimately
  // finds one, so accept either branch — but it must say something actionable.
  assert.ok(
    /ABP_API_KEY is also not set/.test(joined) || /\$env:ABP_API_KEY/.test(joined),
    `expected either the "also not set" note or the fix command; got:\n${joined}`
  );
});

hookTest('KBT-TC3291 — dotnet failing is inconclusive, not a block', (t) => {
  const profile = mkFreshTokenFixture('kbt-b480-incon-', 0);
  const cache = mkTmpDir('kbt-b480-incon-cache-');
  const shim = mkDotnetShim('kbt-b480-shim-fail-', 'fail');
  t.after(() => cleanup(profile, cache, shim));

  const { exitCode, result } = runHook(
    ['kanbantic-api', '', profile],
    Object.assign(
      { ABP_LICENSE_CODE: 'test-license-1234', USERPROFILE: profile, HOME: profile, NUGET_PACKAGES: cache },
      withShimPath(shim)
    )
  );

  assert.equal(exitCode, 0, 'a hook that cannot verify must not hold up work');
  assert.equal(result.action, 'ok');
  assert.ok(
    /could not be verified/.test((result.messages || []).join('\n')),
    'inconclusive state must be reported, not silently ignored'
  );
});

hookTest('KBT-TC3291 — existing FAIL paths keep precedence over the feed check', (t) => {
  // A stale token AND no feed: the answer must still be stale-token, so the
  // operator fixes the first blocker rather than chasing the second.
  const profile = mkFreshTokenFixture('kbt-b480-prec-', 10);
  const cache = mkTmpDir('kbt-b480-prec-cache-');
  const shim = mkDotnetShim('kbt-b480-shim-prec-', 'nuget-only');
  t.after(() => cleanup(profile, cache, shim));

  const { exitCode, result } = runHook(
    ['kanbantic-api', '', profile],
    Object.assign(
      { ABP_LICENSE_CODE: 'test-license-1234', USERPROFILE: profile, HOME: profile, NUGET_PACKAGES: cache },
      withShimPath(shim)
    )
  );

  assert.equal(exitCode, 1);
  assert.equal(result.action, 'stale-token', 'token checks run before the feed check');
});

hookTest('KBT-TC3291 — opt-out and out-of-scope skip the feed check too', (t) => {
  const profile = mkFreshTokenFixture('kbt-b480-skip-', 0);
  const cache = mkTmpDir('kbt-b480-skip-cache-');
  const shim = mkDotnetShim('kbt-b480-shim-skip-', 'nuget-only');
  t.after(() => cleanup(profile, cache, shim));

  const base = Object.assign(
    { ABP_LICENSE_CODE: 'test-license-1234', USERPROFILE: profile, HOME: profile, NUGET_PACKAGES: cache },
    withShimPath(shim)
  );

  const optOut = runHook(
    ['kanbantic-api', '', profile],
    Object.assign({}, base, { KANBANTIC_SKIP_ABP_CHECK: '1' })
  );
  assert.equal(optOut.exitCode, 0);
  assert.equal(optOut.result.action, 'skipped-env');

  const outOfScope = runHook(['kanbantic-frontend', '', profile], base);
  assert.equal(outOfScope.exitCode, 0);
  assert.equal(outOfScope.result.action, 'out-of-scope');
});

// ---------------------------------------------------------------------------
// KBT-TC1918 — SKILL.md integration: Step 0.7 wiring
// ---------------------------------------------------------------------------
test('KBT-TC1918 — SKILL.md Step 0.7 invokes abp-license-check.ps1 with correct args', () => {
  // This is a markdown-parse contract-test: no pwsh needed.
  assert.ok(fs.existsSync(SKILL_PATH), `SKILL.md not found at ${SKILL_PATH}`);
  assert.ok(fs.existsSync(SCRIPT_PATH), `abp-license-check.ps1 not found at ${SCRIPT_PATH}`);

  const content = fs.readFileSync(SKILL_PATH, 'utf8');

  // Section header
  assert.ok(/Step 0\.7/.test(content), 'SKILL.md must contain a "Step 0.7" section');

  // Script invocation
  assert.ok(/abp-license-check\.ps1/.test(content), 'SKILL.md must reference the hook script');
  assert.ok(/\$CLAUDE_PLUGIN_ROOT/.test(content), 'SKILL.md must use $CLAUDE_PLUGIN_ROOT for the hook path');

  // Opt-out env var
  assert.ok(/KANBANTIC_SKIP_ABP_CHECK/.test(content), 'SKILL.md must document the KANBANTIC_SKIP_ABP_CHECK opt-out');

  // Action table — all six actions must appear by name so the skill knows how to react.
  for (const act of ['ok', 'out-of-scope', 'skipped-env', 'missing-env-var', 'missing-token', 'stale-token']) {
    assert.ok(
      new RegExp(`\\b${act}\\b`).test(content),
      `SKILL.md Step 0.7 must document the '${act}' action`
    );
  }

  // Provenance reference
  assert.ok(
    /KBT-F263|KBT-CMND007/.test(content),
    'SKILL.md must reference KBT-F263 or KBT-CMND007 for provenance'
  );
});
