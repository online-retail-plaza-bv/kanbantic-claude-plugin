'use strict';

//
// pre-tool-use-ui-gate.test.js — KBT-F627 / KBT-RL200
//
// Unit tests for the pure helpers of the PreToolUse hook
// `plugin/hooks/pre-tool-use-ui-gate.js` (same require-the-module technique as
// locked-version-blocker.test.js — the `require.main === module` guard keeps
// `main()` from firing), plus registration assertions on hooks.json and a
// no-side-effects require check.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'pre-tool-use-ui-gate.js');
const HOOKS_JSON = path.resolve(__dirname, '..', 'hooks', 'hooks.json');

const {
  isUpdateIssueStatus,
  targetsReview,
  shouldBlock,
  UI_UX_REVIEW_MARKER,
} = require(HOOK_PATH);

// ─── isUpdateIssueStatus: matcher variants ───────────────────────────────────

test('isUpdateIssueStatus: matches the canonical mcp__kanbantic__ form', () => {
  assert.equal(isUpdateIssueStatus('mcp__kanbantic__update_issue_status'), true);
});

test('isUpdateIssueStatus: matches the fully-qualified plugin proxy form', () => {
  assert.equal(isUpdateIssueStatus('mcp__plugin_x__update_issue_status'), true);
  assert.equal(
    isUpdateIssueStatus('mcp__plugin_kanbantic-claude-plugin_kanbantic__update_issue_status'),
    true
  );
});

test('isUpdateIssueStatus: matches the bare tool name', () => {
  assert.equal(isUpdateIssueStatus('update_issue_status'), true);
});

test('isUpdateIssueStatus: does NOT match update_issue or other tools', () => {
  assert.equal(isUpdateIssueStatus('mcp__kanbantic__update_issue'), false);
  assert.equal(isUpdateIssueStatus('update_issue'), false);
  assert.equal(isUpdateIssueStatus('mcp__kanbantic__update_task_status'), false);
  assert.equal(isUpdateIssueStatus('mcp__kanbantic__claim_issue'), false);
  assert.equal(isUpdateIssueStatus('update_issue_status_v2'), false);
  assert.equal(isUpdateIssueStatus(''), false);
  assert.equal(isUpdateIssueStatus(null), false);
  assert.equal(isUpdateIssueStatus(undefined), false);
  assert.equal(isUpdateIssueStatus(42), false);
});

// ─── targetsReview: exact enum value only ────────────────────────────────────

test('targetsReview: true only for the exact enum value "Review"', () => {
  assert.equal(targetsReview({ status: 'Review' }), true);
});

test('targetsReview: case-sensitive like the IssueStatus enum', () => {
  assert.equal(targetsReview({ status: 'review' }), false);
  assert.equal(targetsReview({ status: 'REVIEW' }), false);
});

test('targetsReview: false for other statuses and degenerate input', () => {
  assert.equal(targetsReview({ status: 'InProgress' }), false);
  assert.equal(targetsReview({ status: 'Done' }), false);
  assert.equal(targetsReview({ status: 'InDeployment' }), false);
  assert.equal(targetsReview({}), false);
  assert.equal(targetsReview(null), false);
  assert.equal(targetsReview(undefined), false);
});

// ─── shouldBlock: truth table incl. fail-open cases ──────────────────────────

test('shouldBlock: blocks ONLY on pinned wireframe + no review entry + no attachments', () => {
  assert.equal(
    shouldBlock({ hasLinkedWireframe: true, hasUiUxReviewEntry: false, hasResultAttachments: false }),
    true
  );
});

test('shouldBlock: full truth table — every other combination allows', () => {
  const combos = [];
  for (const w of [true, false]) {
    for (const e of [true, false]) {
      for (const a of [true, false]) {
        combos.push({ hasLinkedWireframe: w, hasUiUxReviewEntry: e, hasResultAttachments: a });
      }
    }
  }
  for (const c of combos) {
    const expected = c.hasLinkedWireframe && !c.hasUiUxReviewEntry && !c.hasResultAttachments;
    assert.equal(
      shouldBlock(c),
      expected,
      `shouldBlock(${JSON.stringify(c)}) must be ${expected}`
    );
  }
});

test('shouldBlock: fail-open on missing/undefined signals (no positive wireframe signal ⇒ allow)', () => {
  assert.equal(shouldBlock({}), false);
  assert.equal(
    shouldBlock({ hasLinkedWireframe: undefined, hasUiUxReviewEntry: undefined, hasResultAttachments: undefined }),
    false
  );
  // Evidence of fidelity work always allows, even with a pinned wireframe.
  assert.equal(
    shouldBlock({ hasLinkedWireframe: true, hasUiUxReviewEntry: true, hasResultAttachments: false }),
    false
  );
  assert.equal(
    shouldBlock({ hasLinkedWireframe: true, hasUiUxReviewEntry: false, hasResultAttachments: true }),
    false
  );
});

// ─── Marker constant ─────────────────────────────────────────────────────────

test('UI_UX_REVIEW_MARKER is the documented discussion-entry prefix', () => {
  assert.equal(UI_UX_REVIEW_MARKER, 'UI-UX review:');
});

// ─── hooks.json registration ─────────────────────────────────────────────────

test('hooks.json: registers the update_issue_status matcher with the ui-gate script', () => {
  const parsed = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const preToolUse = parsed.hooks && parsed.hooks.PreToolUse;
  assert.ok(Array.isArray(preToolUse), 'hooks.json must have a PreToolUse array');

  const entry = preToolUse.find((e) => e.matcher === 'mcp__.*__update_issue_status');
  assert.ok(entry, 'PreToolUse must carry the mcp__.*__update_issue_status matcher');

  const cmd = entry.hooks && entry.hooks[0];
  assert.ok(cmd, 'matcher entry must carry a command hook');
  assert.equal(cmd.type, 'command');
  assert.match(cmd.command, /pre-tool-use-ui-gate\.js/);
  assert.match(cmd.command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.equal(cmd.timeout, 20000);
});

test('hooks.json: the existing claim_issue matcher is still registered alongside', () => {
  const parsed = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const preToolUse = parsed.hooks.PreToolUse;
  const claim = preToolUse.find((e) => e.matcher === 'mcp__.*__claim_issue');
  assert.ok(claim, 'the claim_issue matcher must remain registered (KBT-F320)');
});

// ─── Require-ability without side effects ────────────────────────────────────

test('hook module is require-able without side effects (require.main guard)', () => {
  // The top-of-file require already loaded the module without spawning main().
  // Re-require from cache and verify the exports are the pure helpers.
  const mod = require(HOOK_PATH);
  assert.equal(typeof mod.isUpdateIssueStatus, 'function');
  assert.equal(typeof mod.targetsReview, 'function');
  assert.equal(typeof mod.shouldBlock, 'function');
  assert.equal(typeof mod.unwrapToolResult, 'function');
  assert.equal(typeof mod.extractArray, 'function');

  // The source must carry the require.main guard so `node --test` cannot hang
  // on the hook reading the runner's stdin.
  const src = fs.readFileSync(HOOK_PATH, 'utf8');
  assert.match(src, /require\.main === module/);
});

test('extractArray: unwraps bare arrays and common envelope shapes', () => {
  const { extractArray } = require(HOOK_PATH);
  assert.deepEqual(extractArray([1, 2], ['items']), [1, 2]);
  assert.deepEqual(extractArray({ items: [3] }, ['wireframes', 'items']), [3]);
  assert.deepEqual(extractArray({ wireframes: [] }, ['wireframes', 'items']), []);
  assert.equal(extractArray({ nope: [1] }, ['items']), null);
  assert.equal(extractArray(null, ['items']), null);
  assert.equal(extractArray('text', ['items']), null);
});
