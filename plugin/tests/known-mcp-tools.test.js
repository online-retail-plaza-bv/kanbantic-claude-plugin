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
const tools = new Set(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).tools);

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
  'get_roadmap_data',
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
