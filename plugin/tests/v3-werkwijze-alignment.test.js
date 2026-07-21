'use strict';

//
// v3-werkwijze-alignment.test.js — KBT-F576 (AUD-09/10/11/12)
//
// Re-runnable regression guard for the Workflow-v3 "werkwijze" additions made in
// KBT-F576 (Epic KBT-E108 Phase 2): model-selectie (§5.6), twee-assen-parallellisme
// (§5.5), the T1/T2/T3 getrapte-teststrategie labels (§6), and continue-statusmelding
// (§5.3). Before this fix, zero of the 5 lane-skills referenced model tiers, the
// two-axis parallelism model was absent from prepare/triage, the T1/T2/T3 labels were
// inconsistently applied between execute and review, and the continue-statusmelding
// call-table was completely absent from prepare/triage/orchestrate.
//
// These assertions encode the concrete AUD findings from
// `e108-audit--pluginskills-vs-workflow-v3-findings-inventory` (KBT-F574) so a future
// change can't silently regress this coverage. Mirrors the structural-check style of
// plugin/tests/v3-vocabulary-alignment.test.js (KBT-F575).
//

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'plugin', 'skills');

const LANE_SKILLS = [
  'kanbantic-issue-triage',
  'kanbantic-issue-prepare',
  'kanbantic-issue-execute',
  'kanbantic-issue-review',
  'kanbantic-orchestrate',
];

function readSkill(lane, file = 'SKILL.md') {
  return fs.readFileSync(path.join(SKILLS_ROOT, lane, file), 'utf8');
}

// ─── AUD-09: every one of the 5 lane-skills must reference model-selection (v3 §5.6) ──

const MODEL_TIER_RE = /Model-selectie/i;
const MODEL_NAME_RE = /Haiku|Sonnet|Opus|Fable/;

for (const lane of LANE_SKILLS) {
  test(`${lane}: carries a Model-selectie section (v3 §5.6, AUD-09)`, () => {
    const content = readSkill(lane);
    assert.match(content, MODEL_TIER_RE, `${lane}/SKILL.md must have a "Model-selectie" section heading`);
    assert.match(content, MODEL_NAME_RE, `${lane}/SKILL.md must name at least one concrete model tier (Haiku/Sonnet/Opus/Fable)`);
  });
}

test('AUD-09: model-selectie tier table uses the v3 §5.6 taxonomy (Licht/Middel/Zwaar/Max), not an invented one', () => {
  // Spot-check the two skills most likely to define the canonical table (execute + orchestrate);
  // the other 3 skills reference the same taxonomy inline without necessarily repeating the table.
  for (const lane of ['kanbantic-issue-execute', 'kanbantic-orchestrate']) {
    const content = readSkill(lane);
    assert.match(content, /\*\*Licht\*\*/, `${lane} must use the "Licht" tier label`);
    assert.match(content, /\*\*Middel\*\*/, `${lane} must use the "Middel" tier label`);
    assert.match(content, /\*\*Zwaar\*\*/, `${lane} must use the "Zwaar" tier label`);
  }
});

test('AUD-09: reviewer model-selection must require equal-or-heavier than the builder', () => {
  const content = readSkill('kanbantic-issue-review');
  assert.match(
    content, /gelijk of zwaarder/i,
    'kanbantic-issue-review must state the reviewer/adversarial-verification tier is equal-or-heavier than the building Agent (v3 §5.6)'
  );
});

// ─── AUD-10: two-axis parallelism (v3 §5.5) must be present in prepare + triage ──

const TWO_AXIS_RE = /Parallellisme\s*—\s*twee assen|twee-assen-parallellisme/i;
const AXIS_LABELS_RE = /As 1[\s\S]{0,3000}As 2/;

for (const lane of ['kanbantic-issue-prepare', 'kanbantic-issue-triage']) {
  test(`${lane}: carries a two-axis parallelism section (v3 §5.5, AUD-10)`, () => {
    const content = readSkill(lane);
    assert.match(content, TWO_AXIS_RE, `${lane}/SKILL.md must have a "Parallellisme — twee assen" section`);
    assert.match(content, AXIS_LABELS_RE, `${lane}/SKILL.md must label both As 1 (Agents) and As 2 (subagents)`);
  });
}

test('AUD-10: kanbantic-issue-execute retains its (pre-existing + now-explicit) two-axis section', () => {
  const content = readSkill('kanbantic-issue-execute');
  assert.match(content, TWO_AXIS_RE, 'execute must have an explicit "Parallellisme — twee assen" section (v3 §5.5)');
  assert.match(content, AXIS_LABELS_RE, 'execute must label both As 1 and As 2');
});

// ─── AUD-11: T1/T2/T3 getrapte-teststrategie labels normalized between execute + review ──

for (const lane of ['kanbantic-issue-execute', 'kanbantic-issue-review']) {
  test(`${lane}: uses the T1/T2/T3 test-tier labels (v3 §6, AUD-11)`, () => {
    const content = readSkill(lane);
    assert.match(content, /\bT1\b/, `${lane}/SKILL.md must reference the T1 tier`);
    assert.match(content, /\bT2\b/, `${lane}/SKILL.md must reference the T2 tier`);
    assert.match(content, /\bT3\b/, `${lane}/SKILL.md must reference the T3 tier`);
  });
}

test('AUD-11: execute explicitly scopes T3 (full CI) as out-of-scope, owned by review', () => {
  const content = readSkill('kanbantic-issue-execute');
  assert.match(
    content, /T3[\s\S]{0,200}out of scope[\s\S]{0,120}kanbantic-issue-review/,
    'execute must explicitly state T3 is out of scope for this skill and owned by kanbantic-issue-review'
  );
});

// ─── AUD-12: continue statusmelding (v3 §5.3) must be present in prepare, triage, orchestrate ──

const STATUS_CALL_NAMES = ['register_agent_session', 'heartbeat', 'report_status', 'end_agent_session'];

for (const lane of ['kanbantic-issue-prepare', 'kanbantic-issue-triage', 'kanbantic-orchestrate']) {
  test(`${lane}: documents the continue-statusmelding calls (v3 §5.3, AUD-12)`, () => {
    const content = readSkill(lane);
    for (const call of STATUS_CALL_NAMES) {
      assert.ok(
        content.includes(call),
        `${lane}/SKILL.md must mention \`${call}\` as part of its continue-statusmelding guidance`
      );
    }
  });
}

test('AUD-12: kanbantic-issue-execute still documents the full continue-statusmelding call-set (regression guard)', () => {
  const content = readSkill('kanbantic-issue-execute');
  for (const call of ['claim_issue', 'register_agent_session', 'set_current_issue', 'heartbeat', 'update_test_case', 'report_status', 'end_agent_session']) {
    assert.ok(content.includes(call), `execute must still mention \`${call}\``);
  }
  assert.match(content, /§5\.3/, 'execute must cite v3 §5.3 for the mandatory-calls table');
});

// ─── Cross-check: no two skills recommend incompatible model-tier defaults for the same role ──

test('No internal contradiction: execute + review agree the builder-tier sets the review-tier floor', () => {
  const executeContent = readSkill('kanbantic-issue-execute');
  const reviewContent  = readSkill('kanbantic-issue-review');
  // execute documents Middel-default / Zwaar-escalation for the builder;
  // review documents "equal or heavier" as its own rule — assert both concepts co-exist,
  // not that the wording is identical (they are different roles).
  assert.match(executeContent, /Middel \(Sonnet 5\)/);
  assert.match(reviewContent, /Zwaar \(Opus 4\.8\)/);
});

// ─── Integration: lint-skills.js still passes on the updated skill tree ──

test('Integration: lint-skills.js still passes after the v3-werkwijze additions', () => {
  const { spawnSync } = require('node:child_process');
  const SCRIPT = path.join(REPO_ROOT, 'plugin', 'scripts', 'lint-skills.js');

  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(
    r.status, 0,
    `lint-skills.js must exit 0 on the updated tree — got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`
  );
});
