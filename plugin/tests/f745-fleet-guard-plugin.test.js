'use strict';

//
// f745-fleet-guard-plugin.test.js — KBT-F745 / KBT-SR653 §Plugin / KBT-SR652 §MCP / KBT-TC4222
//
// Pins the plugin-side contract of "Daemon als vlootbewaker":
//
//   - the review-skill removes the issue worktree right after the merge
//     (KBT-RL277 §8) via scripts/remove-issue-worktree.js — Step 7, after
//     `git branch -d`, fail-open, with the two worktree gotchas named;
//   - the execute-skill says the worktree is cleaned up in the review lane,
//     not at Review;
//   - the orchestrate-skill reads `get_model_policy` before spawning;
//   - `get_model_policy` is in known-mcp-tools.json AND in the required-
//     parameter contract (`workspaceId`) of check-tool-param-drift.js;
//   - reference/using-kanbantic.md explains a `model-policy:` Blocked and
//     the refused-spawn decision request;
//   - the README mentions the script;
//   - `npm test` actually runs the script's own test file.
//
// Zero deps — reads files only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugin');
const read = (rel) => fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8');

function section(markdown, startHeading, nextHeadingPattern) {
  const start = markdown.indexOf(startHeading);
  assert.ok(start >= 0, `heading not found: ${startHeading}`);
  const rest = markdown.slice(start + startHeading.length);
  const m = rest.match(nextHeadingPattern);
  return m ? rest.slice(0, m.index) : rest;
}

// ── scripts/remove-issue-worktree.js ─────────────────────────────────────────

test('scripts/remove-issue-worktree.js ships with its own node:test file', () => {
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', 'remove-issue-worktree.js')));
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', 'remove-issue-worktree.test.js')));
});

test('npm test includes the scripts/*.test.js files (so CI runs the worktree test)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /plugin\/scripts\/\*\.test\.js/,
    'package.json "test" must glob plugin/scripts/*.test.js next to plugin/tests/*.test.js');
});

// ── kanbantic-issue-review Step 7: "Worktree verwijderen" ─────────────────────

test('review-skill Step 7 removes the worktree after git branch -d via remove-issue-worktree.js', () => {
  const skill = read('skills/kanbantic-issue-review/SKILL.md');
  const step7 = section(skill, '## Step 7: Merge + Push + Cleanup', /\n## Step 7\.5/);

  assert.ok(step7.includes('Worktree verwijderen'), 'Step 7 carries a "Worktree verwijderen" sub-step');
  const call = 'node "$CLAUDE_PLUGIN_ROOT/scripts/remove-issue-worktree.js" --branch';
  assert.ok(step7.includes(call), `Step 7 must contain the call ${call}`);

  const branchDelete = step7.indexOf('git branch -d <feature-branch>');
  const removeCall = step7.indexOf(call);
  assert.ok(branchDelete >= 0 && removeCall > branchDelete,
    'the worktree removal comes AFTER the local branch delete (the branch delete is the merge proof)');

  for (const needle of ['KBT-RL277', 'KBT-GTCH142', 'KBT-GTCH187', 'fail-open', 'cwd-inside-worktree']) {
    assert.ok(step7.includes(needle), `Step 7 names ${needle}`);
  }
  assert.ok(/\{\s*removed/.test(step7), 'Step 7 shows the { removed, path, reason } JSON shape');
});

// ── kanbantic-issue-execute Step 8: worktree is cleaned up in the review lane ─

test('execute-skill Step 8 says the worktree is removed by the review lane, not at Review', () => {
  const skill = read('skills/kanbantic-issue-execute/SKILL.md');
  const step8 = section(skill, '## Step 8: Final Report + Handoff', /\n## /);
  assert.ok(/worktree/i.test(step8), 'Step 8 mentions the worktree');
  assert.ok(step8.includes('kanbantic-issue-review'), 'Step 8 points at the review lane for the cleanup');
  assert.ok(step8.includes('KBT-F745'), 'Step 8 cites KBT-F745');
});

// ── kanbantic-orchestrate Step 0: model policy before spawning ───────────────

test('orchestrate-skill Step 0 reads get_model_policy before spawning agents', () => {
  const skill = read('skills/kanbantic-orchestrate/SKILL.md');
  const step0 = section(skill, '## Step 0:', /\n## Step 1/);
  assert.ok(step0.includes('mcp__kanbantic__get_model_policy'), 'Step 0 calls get_model_policy');
  assert.ok(/workspaceId/.test(step0), 'with workspaceId');
  assert.ok(/model-policy:/.test(step0), 'and names the Blocked reason prefix');
  assert.ok(/Fable/.test(step0), 'and the Fable rule (never allowed, KBT-RL277 §5)');
});

// ── registry + required-parameter contract ───────────────────────────────────

test('known-mcp-tools.json carries get_model_policy (KBT-SR652 §MCP)', () => {
  const snapshot = JSON.parse(read('scripts/known-mcp-tools.json'));
  assert.ok(snapshot.tools.includes('get_model_policy'));
  assert.deepStrictEqual(snapshot.tools, [...snapshot.tools].sort(), 'tools stay alphabetical');
});

test('check-tool-param-drift.js requires workspaceId on get_model_policy', () => {
  const src = read('scripts/check-tool-param-drift.js');
  assert.match(src, /get_model_policy:\s*\[\s*'workspaceId'\s*\]/,
    "REQUIRED_PARAMS must contain get_model_policy: ['workspaceId']");
});

// ── reference/using-kanbantic.md ─────────────────────────────────────────────

test('using-kanbantic.md explains the model-policy Blocked and the refused-spawn decision', () => {
  const doc = read('reference/using-kanbantic.md');
  const sec = section(doc, '### Modelbeleid en preflight (KBT-F745)', /\n##[# ]/);
  const flat = sec.replace(/\s+/g, ' ');
  assert.ok(flat.includes('model-policy:'), 'names the `model-policy:` reason prefix');
  assert.ok(/Working/.test(flat), 'says the session returns to Working by itself after the model is restored');
  assert.ok(/get_model_policy/.test(flat), 'points at get_model_policy for the expected model');
  assert.ok(/Beslisbak/.test(flat) && /retry/.test(flat) && /cancel/.test(flat),
    'says a refused spawn lands in the Beslisbak as a retry/cancel decision request');
  assert.ok(/Fable/.test(flat), 'states that Fable is never allowed');
});

// ── README ───────────────────────────────────────────────────────────────────

test('README mentions remove-issue-worktree.js', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('remove-issue-worktree.js'));
  assert.ok(readme.includes('get_model_policy'));
});
