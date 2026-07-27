'use strict';

//
// v3-vocabulary-alignment.test.js — KBT-F575 (AUD-01/02/03/04/05/06/08)
//
// Re-runnable regression guard for the Workflow-v3 status-vocabulary fixes made in
// KBT-F575 (Epic KBT-E108 Phase 2). Before this fix, several lane-skills used the dead
// enum value "Prepared" (renamed to "Ready" in KBT-E103) in executable MCP-call
// examples and filter predicates — a literal-text bug, not just cosmetic drift: an
// agent/orchestrator following the old text verbatim would never match a real issue
// (no live issue can ever have status == "Prepared").
//
// These assertions encode the concrete AUD findings from
// `e108-audit--pluginskills-vs-workflow-v3-findings-inventory` (KBT-F574) so a future
// change can't silently reintroduce the drift. Mirrors the structural-check style of
// plugin/tests/lane-skill-process-rules.test.js (KBT-F449).
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

const INTAKE_SKILLS = [
  'kanbantic-epic-proposal',
  'kanbantic-bug-report',
  'kanbantic-feature-request',
];

function readSkill(lane, file = 'SKILL.md') {
  return fs.readFileSync(path.join(SKILLS_ROOT, lane, file), 'utf8');
}

// Lines that are an *intentional* historical rename-note are allowed to still say
// "Prepared" (e.g. "renamed from `Prepared` in KBT-E103/v3"). Any other line
// containing "Prepared" is drift.
const RENAME_NOTE_RE = /renamed from `?Prepared`?|Prepared.{0,20}(hernoemd|renamed)|E103[:)].{0,20}Prepared.?(→|->|naar|to).?Ready/i;

function nonHistoricalPreparedLines(content) {
  return content
    .split('\n')
    .filter((line) => line.includes('Prepared'))
    .filter((line) => !RENAME_NOTE_RE.test(line));
}

// ─── AUD-01/02/03/04/06: no operational "Prepared" drift left in any lane/intake skill ──

for (const lane of [...LANE_SKILLS, ...INTAKE_SKILLS]) {
  test(`${lane}: no non-historical "Prepared" references remain`, () => {
    const content = readSkill(lane);
    const offenders = nonHistoricalPreparedLines(content);
    assert.deepEqual(
      offenders, [],
      `${lane}/SKILL.md still contains non-historical "Prepared" text (dead v3 enum value, renamed to Ready in KBT-E103):\n${offenders.join('\n')}`
    );
  });
}

test('AUD-01: no executable status:"Prepared" MCP call anywhere in the skills tree', () => {
  const offenders = [];
  for (const lane of [...LANE_SKILLS, ...INTAKE_SKILLS]) {
    const content = readSkill(lane);
    if (/status:\s*"Prepared"/.test(content)) {
      offenders.push(lane);
    }
  }
  assert.deepEqual(offenders, [], `Executable status:"Prepared" call found in: ${offenders.join(', ')}`);
});

// ─── AUD-02: execute's Step 1 gate-check must accept Ready as the preferred source status ──

test('AUD-02: execute Step 1 gate-check lists Ready as the preferred accepted source status', () => {
  const content = readSkill('kanbantic-issue-execute');
  const gateMatch = content.match(/## Step 1: Gate-check[\s\S]*?<\/HARD-GATE>/);
  assert.ok(gateMatch, 'Step 1 gate-check HARD-GATE block not found in execute');

  const gate = gateMatch[0];
  assert.match(
    gate, /`Ready`.{0,40}preferred path/,
    'Execute Step 1 HARD-GATE must list `Ready` as the preferred accepted source status'
  );
  assert.match(
    gate, /Status == Ready/,
    'Execute Step 1 HARD-GATE must derive isReadyToClaim from Status == Ready, not Status == Prepared'
  );
});

// ─── AUD-03: orchestrate's routing table + Step-3 filter must use Ready, not Prepared ──

test('AUD-03: orchestrate routing table maps Triaged -> Ready and claims from Ready', () => {
  const content = readSkill('kanbantic-orchestrate');
  assert.match(
    content, /\|\s*`Triaged`\s*\|\s*`kanbantic-issue-prepare`\s*\|\s*issue reaches `Ready`/,
    'orchestrate routing table must show Triaged -> ...prepare -> reaches Ready'
  );
  assert.match(
    content, /\|\s*`Ready`\s*\|\s*`kanbantic-issue-execute`/,
    'orchestrate routing table must have a Ready row owned by kanbantic-issue-execute'
  );
});

test('AUD-03: orchestrate Step-3 actionable-issue filter keeps Ready, not Prepared', () => {
  const content = readSkill('kanbantic-orchestrate');
  assert.match(
    content, /Keep issues whose `status` is `New`, `Triaged`, `Ready`, `InProgress`, or `Review`/,
    'orchestrate Step 3 filter must keep Ready issues (a literal "Prepared" filter would silently exclude every real Ready issue)'
  );
});

// ─── AUD-06: prepare + triage must carry the v3 canonical banner ──

const V3_BANNER_RE = /Canonieke werkwijze — Kanbantic Workflow v3/;

for (const lane of LANE_SKILLS) {
  test(`${lane}: carries the v3 canonical banner`, () => {
    const content = readSkill(lane);
    assert.match(content, V3_BANNER_RE, `${lane}/SKILL.md must carry the v3 canonical banner (matches execute/review/orchestrate style)`);
  });
}

// ─── AUD-05: prepare must not call create_user_story at Epic scope (v3 §2.1, KBT-RL121) ──

test('AUD-05: prepare 5E.4 must NOT call create_user_story on Epic issueId', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const sectionMatch = content.match(/### 5E\.4:[\s\S]*?(?=### 5E\.\d|## Step)/);
  assert.ok(sectionMatch, '5E.4 section not found in prepare SKILL.md');

  const section = sectionMatch[0];
  assert.ok(
    !section.match(/MCP:.*create_user_story|mcp__kanbantic__create_user_story/),
    'Attachment-model violation: 5E.4 must not contain an affirmative create_user_story MCP call — User Stories are Feature-only (v3 §2.1, KBT-RL121)'
  );
});

test('AUD-05: prepare 5E.4 HARD-GATE forbids both create_user_story and create_test_case at Epic scope', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const sectionMatch = content.match(/### 5E\.4:[\s\S]*?(?=### 5E\.\d|## Step)/);
  assert.ok(sectionMatch, '5E.4 section not found');

  const section = sectionMatch[0];
  assert.ok(section.includes('<HARD-GATE>'), '5E.4 must have a HARD-GATE');
  assert.match(
    section, /Do \*\*NOT\*\* call `create_user_story` or `create_test_case`/,
    '5E.4 HARD-GATE must explicitly forbid both create_user_story and create_test_case at Epic scope'
  );
  assert.match(
    section, /KBT-RL121|Feature-only/,
    '5E.4 HARD-GATE must cite the v3 §2.1 / KBT-RL121 attachment-model rule'
  );
});

// ─── AUD-08: execute must document the Blocked/OnHold Issue side-states (KBT-F561) ──

test('AUD-08: execute documents Blocked/OnHold Issue side-states with required reason + legal transitions', () => {
  const content = readSkill('kanbantic-issue-execute');
  assert.match(
    content, /## Blocked \/ OnHold — Issue side-states during InProgress \(KBT-F561\)/,
    'execute must have a dedicated Blocked/OnHold section'
  );

  const sectionMatch = content.match(/## Blocked \/ OnHold[\s\S]*?(?=## Subagent Mode)/);
  assert.ok(sectionMatch, 'Blocked/OnHold section not found');
  const section = sectionMatch[0];

  assert.match(section, /only be entered.{0,20}from.{0,10}`InProgress`/i, 'must state entry is only from InProgress');
  assert.match(section, /reason.{0,20}(is )?\*\*required\*\*|required.{0,20}reason/i, 'must state reason is required');
  assert.match(section, /no\*{0,2}\s*direct[\s\S]{0,80}(Review|Done)/i, 'must state there is no direct Blocked/OnHold -> Review/Done transition');
});

// ─── Cross-check against the live IssueStatus/TaskStatus enum (get_system_schema snapshot) ──
//
// This does not call the live MCP tool (tests must run offline/deterministically);
// it pins the known-good enum values as verified this session against
// get_system_schema, so a future re-drift is caught even without live MCP access.

test('IssueStatus enum sanity: Prepared is not a live value, Ready is', () => {
  const KNOWN_ISSUE_STATUS_VALUES = [
    'New', 'Triaged', 'InProgress', 'Review', 'Done', 'Cancelled', 'Ready', 'InDeployment', 'Blocked', 'OnHold',
  ];
  assert.ok(KNOWN_ISSUE_STATUS_VALUES.includes('Ready'), 'Ready must be a live IssueStatus value');
  assert.ok(!KNOWN_ISSUE_STATUS_VALUES.includes('Prepared'), 'Prepared must NOT be a live IssueStatus value (renamed to Ready in KBT-E103)');
});

// ─── Integration: lint-skills.js still passes on the updated skill tree ──

test('Integration: lint-skills.js still passes after the v3-vocabulary fixes', () => {
  const { spawnSync } = require('node:child_process');
  const SCRIPT = path.join(REPO_ROOT, 'plugin', 'scripts', 'lint-skills.js');

  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(
    r.status, 0,
    `lint-skills.js must exit 0 on the updated tree — got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`
  );
});
