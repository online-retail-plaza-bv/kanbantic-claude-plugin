#!/usr/bin/env node
'use strict';

//
// kanbantic-credential-helper-shim — KBT-B547
//
// The file whose path lands in `.git/config`. It is installed OUTSIDE the
// version-scoped plugin cache (see install-git-credential-helper.js), so the
// path stored in `.git/config` contains no version number and no upgrade can
// invalidate it:
//
//   credential.helper = !node "<home>/.kanbantic/bin/kanbantic-credential-helper-shim.js"
//
// On every invocation it re-resolves the active plugin root and delegates to
// that installation's kanbantic-git-credential-helper.js. `require` (not
// spawn) on purpose: the real helper runs on load, reads argv and stdin
// itself, and writes the credential straight to stdout — so delegating costs
// no extra process and keeps the token on exactly one path (KBT-B330).
//
// Acknowledged trade-off: this shim is a copy living outside the cache, so it
// is the one thing that can go stale. The installer is idempotent and the
// lane-skills call it on every run, which bounds staleness to "until the next
// lane run" instead of "until someone notices".
//
// Never fails loudly — a thrown helper makes git error out instead of falling
// through to the next helper.
//

const path = require('path');

const { resolvePluginRoot, notFoundMessage, HELPER_RELATIVE_PATH } =
  require(path.join(__dirname, 'kanbantic-plugin-root.js'));

function log(msg) {
  process.stderr.write(`[kanbantic-credential-helper] ${msg}\n`);
}

function main() {
  const { root, source, searched } = resolvePluginRoot();

  if (!root) {
    // The diagnosis KBT-B547 is really about: name what was searched, and say
    // up front that git's next line is a symptom, not the cause.
    log(notFoundMessage(searched));
    process.exit(0);
  }

  const helper = path.join(root, HELPER_RELATIVE_PATH);
  try {
    // Runs on require: reads process.argv[2] (get/store/erase) + stdin.
    require(helper);
  } catch (e) {
    log(`failed to run ${helper} (resolved via ${source}): ${e.message} — falling through`);
    process.exit(0);
  }
}

main();
