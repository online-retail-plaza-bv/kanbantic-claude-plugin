'use strict';

//
// hooks-version-independence.test.js — KBT-B555 / KBT-TC3514
//
// `plugin/hooks/settings.json.template` hardcoded a plugin-cache path pinned to
// version 2.2.0 while the plugin had reached 2.38.0, and nothing in the repo
// referenced the file — it was neither read, copied, nor generated. Eighteen
// minor releases of drift that nobody noticed, because nothing could notice.
//
// The obvious assertion — `!existsSync('settings.json.template')` — is a trap.
// It goes green the moment the file is deleted and can never fail again, which
// makes it a line of coverage rather than a test. The failure mode worth
// guarding is broader and recurring: *somewhere in the hook distribution sits a
// path with a version number in it that the next release will silently
// invalidate.* KBT-B547 is the same bug in a different file, where the pinned
// path lived in `.git/config` and the plugin cache pruned it on upgrade.
//
// So this scans, and a future reintroduction in a brand-new file fails too.
//
// Scope is `plugin/hooks/` only. RELEASE_NOTES_v*.md and history.md name
// versions legitimately — they describe the past and are supposed to stay put.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(PLUGIN_DIR, 'hooks');
const PLUGIN_JSON = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');

// Matches the plugin-cache path shape: .../kanbantic-claude-plugin/<x.y.z>/...
const PINNED_PATH = /kanbantic-claude-plugin\/(\d+\.\d+\.\d+)/g;

function currentPluginVersion() {
  return JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version;
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(abs));
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

test('KBT-TC3514: no file under plugin/hooks/ pins a plugin version into a path', () => {
  const version = currentPluginVersion();
  const findings = [];

  for (const abs of walk(HOOKS_DIR)) {
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (_) {
      continue; // unreadable/binary — nothing to pin
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(PINNED_PATH)) {
        findings.push({
          file: path.relative(PLUGIN_DIR, abs).split(path.sep).join('/'),
          line: i + 1,
          found: m[1],
        });
      }
    });
  }

  assert.deepEqual(
    findings, [],
    `Hardcoded plugin-version path(s) found under plugin/hooks/. The plugin is at ` +
    `${version}; a pinned path stops resolving as soon as the cache prunes that ` +
    `version, and the hook then silently does nothing (KBT-B555, same shape as ` +
    `KBT-B547).\n` +
    findings.map(f => `  ${f.file}:${f.line} pins ${f.found} (current: ${version})`).join('\n')
  );
});

test('KBT-TC3514: the orphaned settings.json.template is gone', () => {
  // Narrower companion to the scan: this specific file was the reason for the
  // issue, and its removal was an explicit decision (delete rather than
  // modernise) because zero references meant no supported caller, and keeping it
  // would preserve a second settings-distribution route that KBT-F638 is meant
  // to replace.
  const p = path.join(HOOKS_DIR, 'settings.json.template');
  assert.equal(
    fs.existsSync(p), false,
    `${p} still exists. It was removed under KBT-B555: nothing referenced it and ` +
    `it pinned a v2.2.0 cache path. If it is being reintroduced, it must be ` +
    `version-independent AND referenced by a script, skill or document.`
  );
});
