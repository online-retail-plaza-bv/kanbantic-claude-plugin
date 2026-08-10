#!/usr/bin/env node
'use strict';

//
// KBT-B545 — release-notes guard.
//
// Fails (exit 1) when the version in `plugin/.claude-plugin/plugin.json` has no
// matching `RELEASE_NOTES_v<version>.md` at the repo root.
//
// Why this exists: KBT-B545 established that the plugin's release ritual lived
// entirely in agent attentiveness — no release workflow, no enforcement, and a
// registry that fell nineteen minors behind as a result. Step 8.5 of
// `kanbantic-issue-review` writes the ritual down, but a written step is only as
// good as the agent reading it. This is the part a machine can settle: you cannot
// ship a version number without leaving a record of what it contains.
//
// It does not (and cannot) check that the Kanbantic Version was registered — that
// needs API credentials this repo's CI does not have. It checks the half that is
// checkable, and the repo's own history shows the half is worth checking: at the
// time of writing, 19 release-notes files carry no matching git tag and 4 tags
// carry no release notes.
//
// Path can be overridden via env var (used by the test fixture):
//   RELEASE_NOTES_ROOT
//
// Zero deps — only node built-ins.
//

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.env.RELEASE_NOTES_ROOT
  || path.resolve(__dirname, '..', '..');

const pluginManifestPath = path.join(
  repoRoot, 'plugin', '.claude-plugin', 'plugin.json');

/**
 * Resolves the shipped version and the release-notes file it requires.
 * Pure apart from the two reads, so the test can drive it against a fixture tree.
 */
function resolveReleaseNotes(root = repoRoot) {
  const manifestPath = path.join(root, 'plugin', '.claude-plugin', 'plugin.json');
  let version;
  try {
    version = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
  } catch (err) {
    // An absent or malformed manifest should say so, not surface as a stack trace.
    throw new Error(`could not read a version from ${manifestPath}: ${err.message}`);
  }
  const expected = `RELEASE_NOTES_v${version}.md`;
  const expectedPath = path.join(root, expected);
  return {
    version,
    expected,
    exists: fs.existsSync(expectedPath),
    isEmpty: fs.existsSync(expectedPath)
      && fs.readFileSync(expectedPath, 'utf8').trim().length === 0,
  };
}

function main() {
  let resolved;
  try {
    resolved = resolveReleaseNotes();
  } catch (err) {
    console.error(`[release-notes] ${err.message}`);
    process.exit(1);
  }
  const { version, expected, exists, isEmpty } = resolved;

  if (!version) {
    console.error(`[release-notes] Could not read a version from ${pluginManifestPath}.`);
    process.exit(1);
  }

  if (!exists) {
    console.error(
      `[release-notes] MISSING: plugin.json is at ${version} but ${expected} does not exist.\n`
      + `A version number is a promise that something shipped; the notes are where you say what.\n`
      + `Create ${expected} at the repo root, then re-run.`);
    process.exit(1);
  }

  if (isEmpty) {
    console.error(
      `[release-notes] EMPTY: ${expected} exists but has no content.\n`
      + `An empty file passes a file-exists check and tells a reader nothing — write the notes.`);
    process.exit(1);
  }

  console.log(`[release-notes] OK — ${version} is documented in ${expected}.`);
}

if (require.main === module) {
  main();
}

module.exports = { resolveReleaseNotes };
