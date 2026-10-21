'use strict';

//
// epic-pane-readonly.test.js — KBT-F743 / KBT-T5228 (Critical 1) / KBT-SEC065 §1
//
// Static proof that the Claude Code mod `/epic` (plugin/hooks/epic-pane.js) is a
// thin READ client: it never names a mutating MCP tool, and every tool it does
// name is on the read allow-list. The behavioural half (every $.mcp.call made
// during a start/command/refresh/press cycle) lives in plugin/hooks/epic-pane.test.ts
// and runs under `claude plugin test plugin/`; this file runs under `npm test`
// so a mutation slipped into the source goes red without the plugin test kit.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MOD = path.join(__dirname, '..', 'hooks', 'epic-pane.js');
const SRC = fs.readFileSync(MOD, 'utf8');

// Mirrors READ_TOOLS in epic-pane.test.ts.
const READ_TOOLS = ['get_epic_children', 'get_fleet_overview', 'list_decisions', 'get_fleet_digest', 'get_issue'];

test('KBT-T5228 — epic-pane.js names no mutating MCP tool (answer/withdraw/request_decision, update_*, create_*)', () => {
  for (const forbidden of ['answer_decision', 'withdraw_decision', 'request_decision']) {
    assert.ok(!SRC.includes(forbidden), `epic-pane.js must not mention ${forbidden}`);
  }
  const prefixed = SRC.match(/\b(?:update|create|delete|claim|register|set|add|resolve|approve|reject)_[a-z_]+\b/g) || [];
  assert.deepEqual(prefixed, [], `epic-pane.js must not name a mutating tool; found ${JSON.stringify(prefixed)}`);
});

test('KBT-T5228 — every tool name epic-pane.js hands to $.mcp.call is on the read allow-list', () => {
  const names = new Set();
  for (const m of SRC.matchAll(/callTool\(\$,\s*ctx,\s*'([a-z_]+)'/g)) names.add(m[1]);
  for (const m of SRC.matchAll(/\$\.mcp\.call\([^)]*?'([a-z_]+)'/g)) names.add(m[1]);
  assert.ok(names.size >= 3, `expected the three read tools of the refresh; found ${JSON.stringify([...names])}`);
  const offList = [...names].filter((n) => !READ_TOOLS.includes(n));
  assert.deepEqual(offList, [], `tools outside the read allow-list: ${JSON.stringify(offList)}`);
});

test('KBT-T5228 — the pane draws no Button (nothing to press, nothing to mutate)', () => {
  assert.ok(!/\bButton\(/.test(SRC), 'epic-pane.js must not draw a Button');
  assert.ok(!/onPress/.test(SRC), 'epic-pane.js must not register an onPress handler');
});
