'use strict';

//
// issue-execute-toolkit-sync.test.js — KBT-F622 / KBT-T3985
//
// KBT-F637 ships a SessionStart hook that materialises the workspace's Toolkit
// Skill + Subagent items as .claude/ mirrors. That covers the start of a
// session — but a session outlives the Toolkit: another agent adds a Gotcha,
// a Skill gets corrected, a Subagent's model changes, all while this one runs.
//
// KBT-F622 therefore requires kanbantic-issue-execute to re-run the same sync
// in Step 0, before claim_issue makes the agent owner of the work. These tests
// pin that wiring down, because it is easy to lose in a doc refactor and its
// absence is silent — you simply execute against a stale Toolkit.
//
// Structural checks against the on-disk SKILL.md, matching the approach in
// lane-skill-process-rules.test.js. No mutation, no tmp dir.
//

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'plugin', 'skills');
const HOOK_REL    = 'hooks/session-start-toolkit-sync.js';

function readSkill(lane, file = 'SKILL.md') {
  return fs.readFileSync(path.join(SKILLS_ROOT, lane, file), 'utf8');
}

/** Step 0 runs from "## Step 0:" up to the next "## Step" heading. */
function step0Of(content) {
  const m = content.match(/## Step 0:[\s\S]*?(?=\n## Step )/);
  assert.ok(m, 'Step 0 section not found in kanbantic-issue-execute SKILL.md');
  return m[0];
}

// ─── The sync is wired into Step 0 ───────────────────────────────────────────

test('execute Step 0 invokes the shipped toolkit-sync hook', () => {
  const step0 = step0Of(readSkill('kanbantic-issue-execute'));

  assert.ok(
    step0.includes(HOOK_REL),
    `Step 0 must invoke ${HOOK_REL} so mid-session Toolkit changes are picked ` +
    'up before the issue is claimed (KBT-F622 / KBT-T3985).'
  );
});

test('the sync is invoked via $CLAUDE_PLUGIN_ROOT, never a hardcoded path', () => {
  const step0 = step0Of(readSkill('kanbantic-issue-execute'));

  // Pull the line that runs the hook and assert it resolves through the
  // plugin-root variable. A hardcoded path breaks on every version bump —
  // exactly the failure KBT-F622 set out to remove from user settings.
  const line = step0.split('\n').find((l) => l.includes(HOOK_REL));
  assert.ok(line, 'no line invoking the toolkit-sync hook found in Step 0');
  assert.ok(
    line.includes('CLAUDE_PLUGIN_ROOT'),
    `The sync must be invoked via $CLAUDE_PLUGIN_ROOT; found: ${line.trim()}`
  );
});

// ─── It must be documented as fail-safe, not as a gate ───────────────────────

test('Step 0 documents the sync as fail-safe and non-blocking', () => {
  const step0 = step0Of(readSkill('kanbantic-issue-execute')).toLowerCase();

  assert.ok(
    step0.includes('fail-safe'),
    'Step 0 must state that the toolkit sync is fail-safe (KBT-BD206).'
  );
  assert.ok(
    /exits? 0/.test(step0),
    'Step 0 must state that every failure path exits 0, so a failed sync does ' +
    'not block execution.'
  );
  assert.ok(
    step0.includes('rl191'),
    'Step 0 must explain why KBT-RL191 fail-not-skip does NOT apply here — ' +
    'without that, a reader is likely to "fix" this into a blocking gate.'
  );
});

// ─── The hook it points at actually exists and is standalone-runnable ────────

test('the referenced hook exists and does not depend on hook stdin', () => {
  const hookPath = path.join(REPO_ROOT, 'plugin', HOOK_REL);
  assert.ok(
    fs.existsSync(hookPath),
    `Step 0 references ${HOOK_REL}, which does not exist. If the hook moved, ` +
    'update the skill and this test together.'
  );

  // Step 0 calls the hook directly rather than through the hook runner, so it
  // must not block on stdin — a SessionStart hook normally receives JSON there.
  const src = fs.readFileSync(hookPath, 'utf8');
  assert.ok(
    !/process\.stdin|readFileSync\(\s*0\s*[,)]|['"]\/dev\/stdin['"]/.test(src),
    'session-start-toolkit-sync.js must not read stdin — Step 0 invokes it ' +
    'directly, where nothing will be piped in and the call would hang.'
  );
});

// ─── The checklist advertises it, so it is not silently skipped ──────────────

test('the execute checklist mentions the Toolkit refresh', () => {
  const content = readSkill('kanbantic-issue-execute');
  const m = content.match(/## Checklist[\s\S]*?(?=\n<HARD-GATE>|\n## )/);
  assert.ok(m, 'Checklist section not found in kanbantic-issue-execute SKILL.md');

  assert.ok(
    /toolkit/i.test(m[0]),
    'The checklist must mention the Toolkit refresh; a step that appears only ' +
    'in the body is easy to skim past.'
  );
});

// ─── The autopilots must delegate, not re-implement ──────────────────────────

test('sequencer skills delegate to the lane-skill instead of re-implementing Step 0', () => {
  // kanbantic-bug-autopilot and kanbantic-orchestrate drive issues through the
  // lane-skills. As long as they invoke kanbantic-issue-execute rather than
  // reproducing its steps, they inherit the sync for free — which is why
  // KBT-F622's "and the autopilots" needs no separate wiring.
  for (const lane of ['kanbantic-bug-autopilot', 'kanbantic-orchestrate']) {
    const content = readSkill(lane);
    assert.ok(
      content.includes('kanbantic-issue-execute'),
      `${lane} must invoke kanbantic-issue-execute so it inherits Step 0.`
    );
    assert.ok(
      !content.includes(HOOK_REL),
      `${lane} must NOT invoke ${HOOK_REL} itself — that duplicates Step 0 and ` +
      'the two copies will drift.'
    );
  }
});
