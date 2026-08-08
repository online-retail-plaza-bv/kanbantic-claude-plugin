#!/usr/bin/env node
'use strict';

//
// install-git-credential-helper — KBT-B547
//
// Installs the versionless credential-helper shim and prints the value to put
// in `credential.helper`. Replaces the old instruction, which persisted an
// expanded, version-pinned path into `.git/config`:
//
//   HELPER="!node \"$CLAUDE_PLUGIN_ROOT/scripts/kanbantic-git-credential-helper.js\""
//   git config credential.helper "$HELPER"      # ← pins the version, forever
//
// Usage:
//   node install-git-credential-helper.js --print-helper     # install + print value
//   node install-git-credential-helper.js --repo <dir>       # install + configure that repo
//   node install-git-credential-helper.js --install-dir <d>  # override target (tests)
//
// Idempotent: re-running overwrites the two installed files with the current
// plugin's copies, so the shim tracks the plugin instead of drifting from it.
//
// Zero dependencies — Node built-ins only.
//

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SHIM_NAME = 'kanbantic-credential-helper-shim.js';
const RESOLVER_NAME = 'kanbantic-plugin-root.js';

/** Default install location — stable across plugin versions, outside the cache. */
function defaultInstallDir({ env = process.env } = {}) {
  const home = env.KANBANTIC_HOME || env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.kanbantic', 'bin');
}

/**
 * Copy the shim + its resolver to `installDir`.
 *
 * The resolver is copied ALONGSIDE the shim rather than required from the
 * plugin cache: a shim that reached back into the cache to find out where the
 * cache is would reintroduce exactly the dependency this issue removes.
 *
 * @returns {{installDir: string, shimPath: string, files: string[]}}
 */
function install({ installDir = defaultInstallDir(), sourceDir = __dirname } = {}) {
  fs.mkdirSync(installDir, { recursive: true });
  const files = [];
  for (const name of [RESOLVER_NAME, SHIM_NAME]) {
    const target = path.join(installDir, name);
    fs.copyFileSync(path.join(sourceDir, name), target);
    files.push(target);
  }
  return { installDir, shimPath: path.join(installDir, SHIM_NAME), files };
}

/**
 * The `credential.helper` value. `!` = run as a shell command; forward slashes
 * so the same string is valid for git on Windows and POSIX alike.
 */
function helperConfigValue(shimPath) {
  return `!node "${shimPath.replace(/\\/g, '/')}"`;
}

function configureRepo(repoDir, helperValue) {
  // Reset first: an inherited `manager` from the system/global config would
  // otherwise stay ahead of ours in the helper chain (see KBT-CLMD001).
  execFileSync('git', ['config', '--local', 'credential.helper', ''], { cwd: repoDir });
  execFileSync('git', ['config', '--local', '--add', 'credential.helper', helperValue], { cwd: repoDir });
}

function parseArgs(argv) {
  const opts = { printHelper: false, repo: null, installDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--print-helper') opts.printHelper = true;
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--install-dir') opts.installDir = argv[++i];
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { shimPath } = install(
    opts.installDir ? { installDir: opts.installDir } : {},
  );
  const helperValue = helperConfigValue(shimPath);

  if (opts.repo) {
    configureRepo(opts.repo, helperValue);
    process.stderr.write(`[install-git-credential-helper] configured ${opts.repo}\n`);
  }
  // Printed unconditionally: the caller almost always wants to capture it, and
  // a value on stdout is easier to compose than a flag to remember.
  process.stdout.write(`${helperValue}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  install,
  helperConfigValue,
  configureRepo,
  defaultInstallDir,
  SHIM_NAME,
  RESOLVER_NAME,
};
