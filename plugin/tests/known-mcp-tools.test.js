'use strict';

//
// known-mcp-tools.test.js — KBT-F320 / KBT-T2419 / KBT-TC2359
//
// Asserts the bundle's `known-mcp-tools.json` snapshot is correctly synced to
// the LIVE registry after the F10 release→version rename:
//   - contains all 12 live Version-flow tools,
//   - omits the 4 legacy release-tools,
//   - omits the stale/non-existent names listed in the F320 description
//     (which never shipped as MCP tools).
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT = path.resolve(__dirname, '..', 'scripts', 'known-mcp-tools.json');
// KBT-B483 — keep the whole parsed snapshot around so tests can assert on
// `curatedOut` as well, not just the tool-name set.
const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const tools = new Set(snapshot.tools);

const LIVE_VERSION_TOOLS = [
  'create_version',
  'list_versions',
  'update_version',
  'freeze_version',
  'mark_version_released',
  'preview_next_version',
  'get_version_notes',
  'app_version_at_date',
  'issue_version_lookup',
  'version_audit_timeline',
  'evaluate_rollout_readiness',
  'record_rollout_decision',
];

const LEGACY_RELEASE_TOOLS = [
  'create_release',
  'list_releases',
  'update_release',
  'get_release_notes',
];

const STALE_NONEXISTENT = [
  'assess_version_readiness',
  'get_application_version_at_date',
  'get_version_timeline',
  'get_issue_deployment_info',
  'archive_version',
  'add_affects_version',
  'remove_affects_version',
  // KBT-B483 — `get_roadmap_data` was removed from this list on 2026-07-27.
  // F320 listed it as a name that "never shipped as an MCP tool", but it has
  // since been implemented and is present in the live tools/list on
  // kanbantic.com (verified directly against tools/list, alongside the four
  // names below which really are still absent). Keeping it here would forbid
  // the snapshot from recording a tool that genuinely exists.
  'search_deployment_history',
];

test('contains all 12 live Version-flow tools', () => {
  assert.equal(LIVE_VERSION_TOOLS.length, 12);
  for (const t of LIVE_VERSION_TOOLS) {
    assert.ok(tools.has(t), `snapshot must contain live Version tool \`${t}\``);
  }
});

test('omits all 4 legacy release-tools', () => {
  for (const t of LEGACY_RELEASE_TOOLS) {
    assert.ok(!tools.has(t), `snapshot must NOT contain legacy release-tool \`${t}\``);
  }
});

test('omits stale/non-existent names from the F320 description', () => {
  for (const t of STALE_NONEXISTENT) {
    assert.ok(!tools.has(t), `snapshot must NOT contain stale non-existent name \`${t}\``);
  }
});

// ---------------------------------------------------------------------------
// KBT-TC3292 (KBT-B483 / KBT-SR586) — curatedOut makes the curation
// machine-readable. Before B483 "which tools do we deliberately exclude?" lived
// only in the `source` / `regenerationCommand` prose, so no check could tell a
// deliberate exclusion apart from a forgotten name.
// ---------------------------------------------------------------------------
test('KBT-TC3292 — curatedOut exists, is an array, and never overlaps tools', () => {
  const snap = snapshot;

  assert.ok(Array.isArray(snap.curatedOut), 'curatedOut must be an array');
  assert.ok(snap.curatedOut.length > 0, 'curatedOut should list the deliberate exclusions');

  const tools = new Set(snap.tools);
  const overlap = snap.curatedOut.filter((n) => tools.has(n));
  assert.deepStrictEqual(
    overlap,
    [],
    `curatedOut and tools must be disjoint; overlapping: ${overlap.join(', ')}`
  );
});

test('KBT-TC3292 — the 4 deprecated release tools are curated out, not merely absent', () => {
  const snap = snapshot;
  const curated = new Set(snap.curatedOut);
  const tools = new Set(snap.tools);

  for (const name of ['create_release', 'list_releases', 'update_release', 'get_release_notes']) {
    assert.ok(curated.has(name), `${name} must be listed in curatedOut`);
    assert.ok(!tools.has(name), `${name} must not appear in tools`);
  }
});
