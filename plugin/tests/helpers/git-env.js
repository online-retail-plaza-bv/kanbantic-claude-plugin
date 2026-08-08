'use strict';

//
// git-env.js — KBT-B546
//
// An explicit, injectable git-config source for tests.
//
// Why this exists: `git config --get <key>` reads the full system → global →
// local cascade. A test that runs `git init` in a temp dir and then asserts
// "no identity is configured" is only asserting the state of the *developer's*
// `~/.gitconfig`. On a workstation with `user.name` set, six tests in
// `kanbantic-git-identity.test.js` + `pre-tool-use-git-identity-gate.test.js`
// failed for that reason alone — same class of defect as KBT-B484 (cwd
// isolation of the credential-helper tests).
//
// The fix is not to prepare a temporary `HOME` in a `before()` hook — that
// hides the dependency somewhere the assertion cannot see it. Instead every
// function that reads or writes git config now takes an explicit `env`
// (default `process.env`), and this helper builds the env to pass:
// `GIT_CONFIG_GLOBAL` + `GIT_CONFIG_SYSTEM` pointed at temp files this helper
// owns (git ≥ 2.32). `HOME` is left completely untouched.
//
// The same env object works on both sides of a process boundary: pass it to
// `spawn()` for the script/hook under test AND to the in-process assertion
// helpers, so child and assertion agree on which config source is real.
//
// Zero deps — node built-ins only.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const createdDirs = [];

process.on('exit', () => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — never fail a suite over a leftover temp dir.
    }
  }
});

/**
 * Build an env object whose git-config cascade is fully under the test's
 * control.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.base]    Env to extend (default `process.env`).
 * @param {string}  [opts.global]  Literal contents of the global gitconfig.
 * @param {string}  [opts.system]  Literal contents of the system gitconfig.
 * @returns {object} a full env object safe to hand to `spawn`/`execFileSync`.
 */
function isolatedGitEnv({ base = process.env, global: globalConfig = '', system: systemConfig = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-gitconfig-'));
  createdDirs.push(dir);

  const globalFile = path.join(dir, 'global.gitconfig');
  const systemFile = path.join(dir, 'system.gitconfig');
  fs.writeFileSync(globalFile, globalConfig, 'utf8');
  fs.writeFileSync(systemFile, systemConfig, 'utf8');

  return {
    ...base,
    GIT_CONFIG_GLOBAL: globalFile,
    GIT_CONFIG_SYSTEM: systemFile,
  };
}

/** Gitconfig text setting a user identity — for the "machine has an identity" variants. */
function identityConfig(name, email) {
  return `[user]\n\tname = ${name}\n\temail = ${email}\n`;
}

/**
 * The three global-config variants KBT-TC3423 requires every identity test to
 * be indifferent to: empty, an arbitrary identity, and — the sneaky one — an
 * identity that happens to equal what the test asserts. Variant (c) catches a
 * test that is green only because the environment agrees with it.
 */
function globalConfigVariants(expectedName = 'Axon Beta', expectedEmail = 'axon-beta@agents.kanbantic.local') {
  return [
    { label: 'empty global config', global: '' },
    { label: 'arbitrary workstation identity', global: identityConfig('Ronald Evers', 'ronald@onlineretailplaza.com') },
    { label: 'global identity equal to the expected value', global: identityConfig(expectedName, expectedEmail) },
  ];
}

module.exports = { isolatedGitEnv, identityConfig, globalConfigVariants };
