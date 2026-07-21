'use strict';

//
// v3-kennisborging-alignment.test.js — KBT-F577 (AUD-13/14)
//
// Re-runnable regression guard for the Workflow-v3 "kennisborging" additions made in
// KBT-F577 (Epic KBT-E108 Phase 2): the mandatory consistentie-check (v3 §5.7) before
// writing/updating an AI Toolkit item, and an explicit knowledge-recording step in the
// three lane-skills that previously had none at all.
//
// Before this fix, zero of the 5 lane-skills referenced "consistentie-check" / "AI
// Toolkit" / "kennisborging" anywhere (AUD-13), and `kanbantic-issue-prepare`,
// `kanbantic-issue-triage`, and `kanbantic-orchestrate` had no knowledge-recording step
// at all (AUD-14) — any reusable pattern/gotcha/rule discovered mid-triage,
// mid-requirements-dialogue, or mid-orchestration was not captured unless the agent
// improvised.
//
// These assertions encode the concrete AUD findings from
// `e108-audit--pluginskills-vs-workflow-v3-findings-inventory` (KBT-F574) so a future
// change can't silently regress this coverage. Mirrors the structural-check style of
// plugin/tests/v3-vocabulary-alignment.test.js (KBT-F575) and
// plugin/tests/v3-werkwijze-alignment.test.js (KBT-F576).
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

// ─── AUD-13: consistentie-check must be present in review + execute, referenced from orchestrate ──

const CONSISTENTIE_CHECK_RE = /Consistentie-check/;
const V3_57_RE = /§5\.7/;

for (const lane of ['kanbantic-issue-review', 'kanbantic-issue-execute', 'kanbantic-orchestrate']) {
  test(`${lane}: carries an explicit "Consistentie-check" step citing v3 §5.7 (AUD-13)`, () => {
    const content = readSkill(lane);
    assert.match(content, CONSISTENTIE_CHECK_RE, `${lane}/SKILL.md must name a "Consistentie-check" step`);
    assert.match(content, V3_57_RE, `${lane}/SKILL.md must cite v3 §5.7`);
  });
}

test('AUD-13: review\'s consistentie-check substep is explicit and precedes the create/update_toolkit_item call (not implicit)', () => {
  const content = readSkill('kanbantic-issue-review');
  const idx9a = content.indexOf('### 9a: Toolkit items');
  assert.ok(idx9a >= 0, '9a: Toolkit items section not found');
  const section = content.slice(idx9a);

  const consistentieIdx = section.search(CONSISTENTIE_CHECK_RE);
  const createIdx = section.indexOf('mcp__kanbantic__create_toolkit_item');
  assert.ok(consistentieIdx >= 0, 'review 9a must mention Consistentie-check');
  assert.ok(createIdx >= 0, 'review 9a must call create_toolkit_item');
  assert.ok(
    consistentieIdx < createIdx,
    'the Consistentie-check substep must appear BEFORE the create_toolkit_item call, not after or only implicitly'
  );
});

test('AUD-13: execute\'s consistentie-check precedes its Step 5a/5b Toolkit writes', () => {
  const content = readSkill('kanbantic-issue-execute');
  const idxStep5 = content.indexOf('## Step 5: Update Knowledge Base');
  assert.ok(idxStep5 >= 0, 'Step 5: Update Knowledge Base not found');
  const section = content.slice(idxStep5);

  const consistentieIdx = section.search(CONSISTENTIE_CHECK_RE);
  const createIdx = section.indexOf('mcp__kanbantic__create_toolkit_item');
  assert.ok(consistentieIdx >= 0, 'execute Step 5 must mention Consistentie-check');
  assert.ok(createIdx >= 0, 'execute Step 5 must call create_toolkit_item (5b)');
  assert.ok(
    consistentieIdx < createIdx,
    'the Consistentie-check substep must appear BEFORE the create_toolkit_item call in Step 5'
  );
});

test('AUD-13: every consistentie-check mentions searching/verifying against existing Toolkit items before writing (not just duplicate-avoidance)', () => {
  for (const lane of ['kanbantic-issue-review', 'kanbantic-issue-execute', 'kanbantic-orchestrate',
                       'kanbantic-issue-prepare', 'kanbantic-issue-triage']) {
    const content = readSkill(lane);
    const match = content.match(/Consistentie-check[\s\S]{0,400}/);
    assert.ok(match, `${lane} must have a Consistentie-check block`);
    assert.match(
      match[0], /tegengesproken|contradict/i,
      `${lane}'s Consistentie-check must speak of CONTRADICTION (tegengesproken/contradict), not just duplication`
    );
  }
});

// ─── AUD-14: prepare / triage / orchestrate must each have an explicit knowledge-recording step ──

const AI_TOOLKIT_RE = /AI Toolkit/;
const NOT_LOCAL_MEMORY_RE = /niet.{0,15}lokale memory|not.{0,10}local memory/i;

for (const lane of ['kanbantic-issue-prepare', 'kanbantic-issue-triage', 'kanbantic-orchestrate']) {
  test(`${lane}: has an explicit knowledge-recording step pointing at the AI Toolkit, not local memory (AUD-14)`, () => {
    const content = readSkill(lane);
    assert.match(content, AI_TOOLKIT_RE, `${lane}/SKILL.md must reference "AI Toolkit"`);
    assert.match(content, NOT_LOCAL_MEMORY_RE, `${lane}/SKILL.md must explicitly exclude local memory`);
    assert.ok(
      content.includes('mcp__kanbantic__create_toolkit_item'),
      `${lane}/SKILL.md must reference create_toolkit_item as the knowledge-recording call`
    );
  });
}

test('AUD-14: prepare/triage/orchestrate knowledge-recording steps run the consistentie-check before create_toolkit_item', () => {
  for (const lane of ['kanbantic-issue-prepare', 'kanbantic-issue-triage', 'kanbantic-orchestrate']) {
    const content = readSkill(lane);
    const consistentieIdx = content.search(CONSISTENTIE_CHECK_RE);
    const createIdx = content.indexOf('mcp__kanbantic__create_toolkit_item');
    assert.ok(consistentieIdx >= 0 && createIdx >= 0, `${lane} must have both a consistentie-check and a create_toolkit_item call`);
    assert.ok(consistentieIdx < createIdx, `${lane}: consistentie-check must precede create_toolkit_item`);
  }
});

test('AUD-14: knowledge-recording steps in prepare/triage/orchestrate are explicitly optional (skip-if-nothing-discovered)', () => {
  for (const lane of ['kanbantic-issue-prepare', 'kanbantic-issue-triage', 'kanbantic-orchestrate']) {
    const content = readSkill(lane);
    assert.match(
      content, /optional[\s\S]{0,120}not forced|Skip this step entirely/i,
      `${lane}'s knowledge-recording step must be clearly optional, not a forced/blocking step`
    );
  }
});

// ─── Cross-check: no contradictory kennisborging wording between skills (KBT-TC3248) ──

test('No internal contradiction: all 5 lane-skills route reusable knowledge to the AI Toolkit, never local memory', () => {
  for (const lane of LANE_SKILLS) {
    const content = readSkill(lane);
    assert.match(content, AI_TOOLKIT_RE, `${lane} must mention the AI Toolkit`);
  }
  // None of the 5 lane-skills may instruct writing reusable knowledge to "local memory"
  // as a valid destination (only as the thing being explicitly excluded).
  for (const lane of LANE_SKILLS) {
    const content = readSkill(lane);
    const badLines = content
      .split('\n')
      .filter((line) => /local memory|lokale memory/i.test(line))
      .filter((line) => !/niet|not\b|excluding|instead of/i.test(line));
    assert.deepEqual(
      badLines, [],
      `${lane} must never recommend local memory as a valid destination for reusable knowledge:\n${badLines.join('\n')}`
    );
  }
});

test('kanbantic-orchestrate: the new Step 5.5 knowledge-recording step does not contradict its own "Comment entries only" boundary rule', () => {
  const content = readSkill('kanbantic-orchestrate');
  // The pre-existing rule is about *issue discussion entries* (Comment vs Decision/
  // KnowledgeExtraction); Step 5.5 writes to the *Toolkit* (create_toolkit_item), a
  // different write-channel entirely — assert both statements co-exist without one
  // being deleted to make room for the other.
  assert.match(content, /records \*\*Comment\*\* entries only/, 'orchestrate must still restrict its issue discussion-entries to Comment');
  assert.match(content, /Step 5\.5: Record Reusable Knowledge/, 'orchestrate must have the new Step 5.5');
  assert.match(
    content, /distinct from the per-issue Decision\/KnowledgeExtraction/i,
    'orchestrate must explicitly distinguish Step 5.5 (Toolkit writes) from the Comment-only discussion-entry rule'
  );
});

// ─── Integration: lint-skills.js still passes on the updated skill tree ──

test('Integration: lint-skills.js still passes after the v3-kennisborging additions', () => {
  const { spawnSync } = require('node:child_process');
  const SCRIPT = path.join(REPO_ROOT, 'plugin', 'scripts', 'lint-skills.js');

  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(
    r.status, 0,
    `lint-skills.js must exit 0 on the updated tree — got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`
  );
});
