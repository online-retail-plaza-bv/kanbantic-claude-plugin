'use strict';

//
// lane-skill-process-rules.test.js — KBT-F449 / KBT-TC2759 / KBT-TC2760 / KBT-TC2761
//
// Verifies that the lane-skill SKILL.md files conform to procesregels A–E
// as required by KBT-F449 (v0.15.0):
//
//   Regel A  — No create_test_case calls on Epic issueId in kanbantic-issue-prepare.
//   Regel E  — Per-issue test-policy declaration step present in prepare (5F.5, 5B.6).
//   Execute  — frozenPolicy loading (Step 3c) and coverage-aware gate (Step 7).
//   Review   — test-policy check in Step 1b + verdict gate in reviewer-prompt.md.
//   TRUL013  — superseded; the skill files must no longer reference it as active guidance.
//
// All assertions read on-disk files from the plugin/skills/ tree (same directory the
// running test harness lives in). No tmp-dir or mutation needed — these are positive
// structural checks. Each test is independent.
//

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'plugin', 'skills');

function readSkill(lane, file = 'SKILL.md') {
  return fs.readFileSync(path.join(SKILLS_ROOT, lane, file), 'utf8');
}

// ─── Regel A: No test cases on Epic level ─────────────────────────────────────

test('Regel A: prepare 5E.4 must NOT call create_test_case on Epic issueId', () => {
  const content = readSkill('kanbantic-issue-prepare');

  // Locate the 5E.4 section (everything between "### 5E.4:" and the next "### 5E.").
  const sectionMatch = content.match(/### 5E\.4:[\s\S]*?(?=### 5E\.\d|## Step)/);
  assert.ok(sectionMatch, '5E.4 section not found in prepare SKILL.md');

  const section = sectionMatch[0];
  // The HARD-GATE may contain "Do NOT call `create_test_case`" — that's fine.
  // What must NOT be present is an affirmative MCP call instruction.
  assert.ok(
    !section.match(/MCP:.*create_test_case|mcp__kanbantic__create_test_case/),
    'Regel A violation: 5E.4 must not contain an affirmative create_test_case MCP call — test cases belong to child Features, not the Epic'
  );
});

test('Regel A: prepare 5E.4 must contain a HARD-GATE blocking test-case creation on Epic', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const sectionMatch = content.match(/### 5E\.4:[\s\S]*?(?=### 5E\.\d|## Step)/);
  assert.ok(sectionMatch, '5E.4 section not found');

  const section = sectionMatch[0];
  assert.ok(
    section.includes('<HARD-GATE>'),
    'Regel A: 5E.4 must have a HARD-GATE that prevents create_test_case on Epic'
  );
  assert.ok(
    section.match(/Regel A|KBT-F449|child Feature|child-Feature/i),
    'Regel A: 5E.4 HARD-GATE must reference Regel A, KBT-F449, or child Features'
  );
});

// ─── Regel E: Test-policy declaration step in Feature route (5F.5) ────────────

test('Regel E: prepare must contain a 5F.5 test-policy declaration step', () => {
  const content = readSkill('kanbantic-issue-prepare');

  assert.ok(
    content.includes('### 5F.5:'),
    'Regel E: Section 5F.5 must exist in prepare SKILL.md'
  );
  const sectionMatch = content.match(/### 5F\.5:[\s\S]*?(?=### 5F\.\d|## Step 5B|## Step 6)/);
  assert.ok(sectionMatch, '5F.5 section not found');

  const section = sectionMatch[0];
  assert.ok(
    section.match(/test-policy|Test-policy/),
    'Regel E: 5F.5 must be the test-policy declaration step'
  );
  assert.ok(
    section.includes('KBT-F442') || section.includes('Regel E'),
    'Regel E: 5F.5 must reference KBT-F442 or Regel E'
  );
  assert.ok(
    section.includes('## Test-policy (bevroren bij claim_issue'),
    'Regel E: 5F.5 must show the canonical Decision-entry header format'
  );
});

test('Regel E: prepare 5F.5 must require N.v.t. rationale of ≥20 chars', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const sectionMatch = content.match(/### 5F\.5:[\s\S]*?(?=### 5F\.\d|## Step 5B|## Step 6)/);
  assert.ok(sectionMatch, '5F.5 section not found');

  const section = sectionMatch[0];
  assert.ok(
    section.match(/≥20 chars|≥ 20 chars|20 char/),
    'Regel E: 5F.5 must require N.v.t. rationale of ≥20 chars'
  );
});

test('Regel E: prepare must have a 5F.6 Decision entry (renamed from old 5F.5)', () => {
  const content = readSkill('kanbantic-issue-prepare');
  assert.ok(
    content.includes('### 5F.6:'),
    'Old 5F.5 (Decision entry) must be renumbered to 5F.6 after test-policy step insertion'
  );
  const sectionMatch = content.match(/### 5F\.6:[\s\S]*?(?=### 5F\.\d|## Step 5B|## Step 6)/);
  assert.ok(sectionMatch, '5F.6 section not found');
  assert.ok(
    sectionMatch[0].match(/Decision entry|entryType.*Decision/),
    '5F.6 must be the Decision entry step'
  );
});

// ─── Regel E: Test-policy declaration step in Bug route (5B.6) ───────────────

test('Regel E: prepare must contain a 5B.6 test-policy declaration step', () => {
  const content = readSkill('kanbantic-issue-prepare');

  assert.ok(
    content.includes('### 5B.6:'),
    'Regel E: Section 5B.6 must exist in prepare SKILL.md'
  );
  const sectionMatch = content.match(/### 5B\.6:[\s\S]*?(?=### 5B\.\d|## Step 6)/);
  assert.ok(sectionMatch, '5B.6 section not found');

  const section = sectionMatch[0];
  assert.ok(
    section.match(/test-policy|Test-policy/),
    'Regel E: 5B.6 must be the test-policy declaration step'
  );
  assert.ok(
    section.includes('## Test-policy (bevroren bij claim_issue'),
    'Regel E: 5B.6 must show the canonical Decision-entry header format'
  );
});

test('Regel E: prepare must have a 5B.7 Decision entry (renamed from old 5B.6)', () => {
  const content = readSkill('kanbantic-issue-prepare');
  assert.ok(
    content.includes('### 5B.7:'),
    'Old 5B.6 (Decision entry) must be renumbered to 5B.7 after test-policy step insertion'
  );
  const sectionMatch = content.match(/### 5B\.7:[\s\S]*?(?=### 5B\.\d|## Step 6)/);
  assert.ok(sectionMatch, '5B.7 section not found');
  assert.ok(
    sectionMatch[0].match(/Decision entry|entryType.*Decision|Root cause hypothesis/),
    '5B.7 must be the Decision entry step containing root-cause content'
  );
});

// ─── Execute: frozenPolicy loading (Step 3c) ──────────────────────────────────

test('Execute Step 3c: must load frozenPolicy from test-policy Decision-entry', () => {
  const content = readSkill('kanbantic-issue-execute');

  assert.ok(
    content.includes('frozenPolicy'),
    'Execute must introduce frozenPolicy in Step 3'
  );
  assert.ok(
    content.includes('## Test-policy (bevroren bij claim_issue'),
    'Execute must look for the canonical test-policy Decision-entry header'
  );
  assert.ok(
    content.match(/3c|Step 3c/),
    'Execute must have a Step 3c section for frozenPolicy loading'
  );
});

test('Execute Step 3c: frozenPolicy must be read-only (no loosening allowed)', () => {
  const content = readSkill('kanbantic-issue-execute');
  const sectionMatch = content.match(/### 3c:[\s\S]*?(?=### 3\w|## Step 4)/);
  assert.ok(sectionMatch, 'Step 3c section not found in execute');

  const section = sectionMatch[0];
  assert.ok(
    section.match(/read.?only|lees.*only|HARD.?GATE|niet.*wijzig|may NOT|cannot be modified/i),
    'Execute Step 3c must mark frozenPolicy as read-only (no mid-flight loosening)'
  );
});

// ─── Execute: coverage-aware Step 7 gate ─────────────────────────────────────

test('Execute Step 7: must check MISSING coverage (count < minimum), not just failing tests', () => {
  const content = readSkill('kanbantic-issue-execute');

  // Find Step 7 HARD-GATE block.
  const gateMatch = content.match(/## Step 7:[\s\S]*?<\/HARD-GATE>/);
  assert.ok(gateMatch, 'Step 7 HARD-GATE block not found in execute');

  const gate = gateMatch[0];
  assert.ok(
    gate.includes('frozenPolicy'),
    'Execute Step 7 must reference frozenPolicy for coverage check'
  );
  assert.ok(
    gate.match(/count.*Passed|Passed.*count|Passed.*<.*min|minimum/i),
    'Execute Step 7 must check Passed count against minimum (missing coverage gate)'
  );
  assert.ok(
    gate.match(/zero test cases|0 test cases|geen test cases|level with zero|count < min/i)
    || gate.match(/even if no test cases.*Failed|missing.*blocker/i)
    || gate.match(/zero.*fails.*check|without.*Passed/i)
    || gate.match(/Passed.*must be.*≥|≥.*frozenPolicy/i),
    'Execute Step 7 must explicitly state that zero test cases fails the check (missing coverage is a blocker)'
  );
});

test('Execute Step 7: N.v.t. levels must not require minimum count', () => {
  const content = readSkill('kanbantic-issue-execute');
  const gateMatch = content.match(/## Step 7:[\s\S]*?<\/HARD-GATE>/);
  assert.ok(gateMatch, 'Step 7 HARD-GATE block not found in execute');

  const gate = gateMatch[0];
  assert.ok(
    gate.match(/N\.v\.t\.|NotApplicable|not applicable/i),
    'Execute Step 7 must handle N.v.t. levels separately (no minimum count required)'
  );
});

// ─── Review: test-policy check in Step 1b ────────────────────────────────────

test('Review Step 1b: must load discussion entries to find test-policy Decision-entry', () => {
  const content = readSkill('kanbantic-issue-review');

  const sectionMatch = content.match(/## Step 1b:[\s\S]*?(?=## Step 2)/);
  assert.ok(sectionMatch, 'Step 1b section not found in review SKILL.md');

  const section = sectionMatch[0];
  assert.ok(
    section.includes('list_discussion_entries'),
    'Review Step 1b must call list_discussion_entries to load the test-policy entry'
  );
  assert.ok(
    section.includes('frozenPolicy'),
    'Review Step 1b must parse and store frozenPolicy from the test-policy entry'
  );
  assert.ok(
    section.includes('## Test-policy (bevroren bij claim_issue'),
    'Review Step 1b must look for the canonical test-policy header'
  );
});

// ─── Review: reviewer-prompt.md must contain test-policy section ──────────────

test('Review reviewer-prompt: must include Frozen Test-Policy section', () => {
  const content = readSkill('kanbantic-issue-review', 'reviewer-prompt.md');

  assert.ok(
    content.match(/Frozen Test.?Policy|Test-Policy Coverage/i),
    'reviewer-prompt.md must include a Frozen Test-Policy section'
  );
  assert.ok(
    content.includes('ONTBREKENDE COVERAGE'),
    'reviewer-prompt.md must use "ONTBREKENDE COVERAGE" for missing coverage cases'
  );
  assert.ok(
    content.match(/KBT-F442|Regel E/),
    'reviewer-prompt.md must reference KBT-F442 or Regel E'
  );
});

test('Review reviewer-prompt: missing coverage must yield REJECT (critical)', () => {
  const content = readSkill('kanbantic-issue-review', 'reviewer-prompt.md');

  assert.ok(
    content.match(/missing coverage.*REJECT|REJECT.*missing coverage|ONTBREKENDE.*Critical|Critical.*ONTBREKENDE/i)
    || content.match(/always REJECT|always.*reject/i),
    'reviewer-prompt.md must state that missing coverage always yields REJECT'
  );
});

test('Review reviewer-prompt: output format must include Test-Policy Coverage section', () => {
  const content = readSkill('kanbantic-issue-review', 'reviewer-prompt.md');

  // Check output format section has the test-policy table.
  assert.ok(
    content.includes('## Test-Policy Coverage (Regel E)')
    || content.includes('## Test-Policy Coverage'),
    'reviewer-prompt.md output format must include a Test-Policy Coverage section'
  );
});

// ─── TRUL013 supersession ─────────────────────────────────────────────────────

test('TRUL013 supersession: prepare skill must NOT reference KBT-TRUL013 as active guidance', () => {
  const content = readSkill('kanbantic-issue-prepare');

  // TRUL013 may be mentioned historically but must not be cited as a live rule to follow.
  // If it appears, it must be coupled with a supersession note.
  const idx = content.indexOf('KBT-TRUL013');
  if (idx !== -1) {
    const ctx = content.slice(Math.max(0, idx - 100), idx + 200);
    assert.ok(
      ctx.match(/opgeheven|superseded|vervangen|OPGEHEVEN/i),
      'Any TRUL013 reference in prepare must note it is superseded/opgeheven'
    );
  }
  // If not referenced at all, that's fine too — pass through.
});

test('TRUL013 supersession: test-policy declaration step references its replacement', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const sectionMatch = content.match(/### 5F\.5:[\s\S]*?(?=### 5F\.\d|## Step 5B|## Step 6)/);
  assert.ok(sectionMatch, '5F.5 section not found');

  const section = sectionMatch[0];
  assert.ok(
    section.match(/KBT-TRUL013|TRUL013/),
    '5F.5 must mention KBT-TRUL013 as superseded to help readers understand the history'
  );
});

// ─── KBT-B513: Step 5W must be reachable from every prepare route ─────────────
//
// Regression for KBT-B513 / KBT-TC3368: the wireframe-validation gate (Step 5W,
// KBT-RL191) was dead text — all three type-routes (5F.6 / 5B.7 / 5E.9) ended
// with "Go to Step 6." and nothing routed through 5W. These assertions pin the
// routing so a future restructuring cannot silently orphan the gate again.

test('KBT-B513: 5F.6, 5B.7 and 5E.9 must route to Step 5W (not directly to Step 6)', () => {
  const content = readSkill('kanbantic-issue-prepare');
  for (const [label, pattern] of [
    ['5F.6', /### 5F\.6:[\s\S]*?(?=## Step 5B)/],
    ['5B.7', /### 5B\.7:[\s\S]*?(?=## Step 5E)/],
    ['5E.9', /### 5E\.9:[\s\S]*?(?=## Step 5W)/],
  ]) {
    const sectionMatch = content.match(pattern);
    assert.ok(sectionMatch, `${label} section not found in prepare SKILL.md`);
    const section = sectionMatch[0];
    assert.ok(
      section.match(/Go to Step 5W\./),
      `${label} must end with "Go to Step 5W." so the wireframe gate is reachable`
    );
    assert.ok(
      !section.match(/Go to Step 6\./),
      `${label} must not route directly to Step 6 — that orphans Step 5W (KBT-B513)`
    );
  }
});

test('KBT-B513: Step 5W must route onward to Step 6', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const sectionMatch = content.match(/## Step 5W:[\s\S]*?(?=## Step 6: Validate Readiness)/);
  assert.ok(sectionMatch, 'Step 5W section not found in prepare SKILL.md');
  assert.ok(
    sectionMatch[0].match(/Go to Step 6\./),
    'Step 5W must close with an explicit "Go to Step 6." so no path is left without a destination'
  );
});

test('KBT-B513: the Checklist must include the 5W wireframe-validation step', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const checklistMatch = content.match(/## Checklist[\s\S]*?(?=<HARD-GATE>)/);
  assert.ok(checklistMatch, 'Checklist section not found in prepare SKILL.md');
  assert.ok(
    checklistMatch[0].match(/Step 5W/) && checklistMatch[0].match(/[Ww]ireframe/),
    'Checklist must list the wireframe-validation step (Step 5W) between routing and readiness'
  );
});

test('KBT-B513: allowed-writes must include link_wireframe_to_issue and add_issue_attachment', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const allowedMatch = content.match(/Allowed MCP writes are:[^\n]*/);
  assert.ok(allowedMatch, 'Allowed-writes line not found in prepare SKILL.md');
  assert.ok(
    allowedMatch[0].includes('link_wireframe_to_issue'),
    'allowed-writes must permit link_wireframe_to_issue (relational wireframe pinning)'
  );
  assert.ok(
    allowedMatch[0].includes('add_issue_attachment'),
    'allowed-writes must permit add_issue_attachment (reference-attachments for UI-issues)'
  );
});

// ─── Lint integration: real tree still passes all invariants ──────────────────

test('Integration: lint-skills.js still passes on the updated skill tree', () => {
  const { spawnSync } = require('node:child_process');
  const SCRIPT = path.join(REPO_ROOT, 'plugin', 'scripts', 'lint-skills.js');

  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(
    r.status, 0,
    `lint-skills.js must exit 0 on the updated tree — got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`
  );
  assert.match(r.stdout, /OK: all SKILL.md invariants pass/);
});
