'use strict';

//
// graduation-skill.test.js — KBT-F431 / KBT-TC2728 KBT-TC2729 KBT-TC2730
//
// Structural tests for the kanbantic-graduation skill (SKILL.md + mirror).
// Because the skill is a prose document for Claude (not executable JS),
// these tests verify structural invariants rather than runtime behaviour:
//
//   KBT-TC2728 (Unit) — SKILL.md present + frontmatter valid + required sections present
//   KBT-TC2729 (E2E)  — skipped: requires live sandbox workspace (proxy + real Kanbantic)
//   KBT-TC2730 (Integration) — mirror file present + references correct skill name
//
// Run via: npm test
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, 'plugin', 'skills', 'kanbantic-graduation', 'SKILL.md');
const MIRROR_PATH = path.join(REPO_ROOT, 'plugin', 'commands', 'kanbantic-graduation.md');

// ---------------------------------------------------------------------------
// KBT-TC2728 — Unit: structural invariants of SKILL.md
// ---------------------------------------------------------------------------

test('KBT-TC2728: SKILL.md exists at expected path', () => {
  assert.ok(fs.existsSync(SKILL_PATH), `SKILL.md not found at ${SKILL_PATH}`);
});

test('KBT-TC2728: SKILL.md has YAML frontmatter with name and description', () => {
  const raw = fs.readFileSync(SKILL_PATH, 'utf8');
  const content = raw.replace(/\r\n/g, '\n'); // normalize CRLF (core.autocrlf=true on Windows)
  assert.ok(content.startsWith('---\n'), 'SKILL.md must start with YAML frontmatter ---');
  assert.match(content, /^name:\s+kanbantic-graduation/m, 'frontmatter must include name: kanbantic-graduation');
  assert.match(content, /^description:\s+".+"/m, 'frontmatter must include a non-empty description');
});

test('KBT-TC2728: SKILL.md references KBT-TRUL018 (ripeness gate)', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(content.includes('KBT-TRUL018'),
    'SKILL.md must reference KBT-TRUL018 (the ripeness checklist rule)');
});

test('KBT-TC2728: SKILL.md references KBT-TRUL019 (one-way rule)', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(content.includes('KBT-TRUL019'),
    'SKILL.md must reference KBT-TRUL019 (the one-way rule after graduation)');
});

test('KBT-TC2728: SKILL.md has HARD-GATE for ripeness checklist', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(content.includes('<HARD-GATE>'),
    'SKILL.md must have at least one <HARD-GATE> block');
  // Specifically the ripeness gate must be before the entity creation section
  const hardGateIdx = content.indexOf('<HARD-GATE>');
  const step4Idx = content.indexOf('## Step 4');
  assert.ok(hardGateIdx < step4Idx,
    'HARD-GATE must appear before Step 4 (entity creation) — ripeness is checked first');
});

test('KBT-TC2728: SKILL.md instructs create_user_story on Feature (Regel A)', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  // The skill must reference issueId = featureId for create_user_story, not epicId
  assert.ok(content.includes('create_user_story'),
    'SKILL.md must reference create_user_story');
  assert.ok(
    content.includes('featureId') || content.includes('Feature GUID') || content.includes('Regel A'),
    'SKILL.md must instruct create_user_story with a Feature-level issueId (Regel A / KBT-RL121)'
  );
});

test('KBT-TC2728: SKILL.md instructs create_test_case on Feature (Regel A)', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(content.includes('create_test_case'),
    'SKILL.md must reference create_test_case for Draft Test Case generation');
  // Anti-pattern: create_test_case with epicId is forbidden (Regel A)
  // We cannot easily check the negative here in prose, so we check the positive:
  // the skill must explicitly say issueId = featureId or reference Regel A near create_test_case
  const tcIdx = content.indexOf('create_test_case');
  const nearbyContext = content.substring(Math.max(0, tcIdx - 500), tcIdx + 500);
  assert.ok(
    nearbyContext.includes('featureId') || nearbyContext.includes('Feature') || nearbyContext.includes('Regel A'),
    'create_test_case must be in a context that references featureId / Feature / Regel A'
  );
});

test('KBT-TC2728: SKILL.md has worktree HARD-GATE (KBT-TRUL004)', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(
    content.includes('KBT-TRUL004') || content.includes('git-common-dir') || content.includes('main working tree'),
    'SKILL.md must have a worktree check (KBT-TRUL004)'
  );
});

test('KBT-TC2728: SKILL.md has add_discussion_entry for one-way rule confirmation', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(content.includes('add_discussion_entry'),
    'SKILL.md must call add_discussion_entry for the one-way rule Decision entry');
  assert.ok(
    content.includes('Decision') && content.includes('TRUL019'),
    'The Decision entry for one-way rule must reference KBT-TRUL019'
  );
});

// ---------------------------------------------------------------------------
// KBT-TC2730 — Integration: mirror file and skill cross-references
// ---------------------------------------------------------------------------

test('KBT-TC2730: mirror file exists at plugin/commands/kanbantic-graduation.md', () => {
  assert.ok(fs.existsSync(MIRROR_PATH),
    `Mirror file not found at ${MIRROR_PATH}. KBT-TRUL014 requires SKILL.md + mirror in same commit.`);
});

test('KBT-TC2730: mirror file has valid frontmatter with description', () => {
  const raw = fs.readFileSync(MIRROR_PATH, 'utf8');
  const content = raw.replace(/\r\n/g, '\n'); // normalize CRLF (core.autocrlf=true on Windows)
  assert.ok(content.startsWith('---\n'), 'Mirror file must start with YAML frontmatter ---');
  assert.match(content, /^description:\s+".+"/m, 'Mirror frontmatter must have a non-empty description');
});

test('KBT-TC2730: mirror file body invokes kanbantic-graduation skill', () => {
  const content = fs.readFileSync(MIRROR_PATH, 'utf8');
  assert.ok(
    content.includes('kanbantic-graduation'),
    'Mirror file must reference the kanbantic-graduation skill'
  );
});

test('KBT-TC2730: SKILL.md and mirror description both mention KBT-TRUL018', () => {
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');
  const mirrorContent = fs.readFileSync(MIRROR_PATH, 'utf8');
  assert.ok(skillContent.includes('KBT-TRUL018'), 'SKILL.md must mention KBT-TRUL018');
  assert.ok(mirrorContent.includes('KBT-TRUL018'),
    'Mirror description must mention KBT-TRUL018 so the user sees the ripeness gate in command completion');
});

// ---------------------------------------------------------------------------
// KBT-TC2729 — E2E: skipped (requires live sandbox workspace)
// ---------------------------------------------------------------------------

test('KBT-TC2729 (E2E): graduate mini-epic via real proxy — SKIPPED (requires sandbox)',
  { skip: 'requires live Kanbantic sandbox workspace + running MCP proxy (KANBANTIC_MCP_URL + KANBANTIC_API_KEY)' },
  async () => {
    // E2E scenario:
    // 1. Start MCP proxy against sandbox workspace
    // 2. Run graduation skill with 1 feature, 1 story, 2 ACs
    // 3. Assert via list_issues that Epic + 1 Feature were created
    // 4. Assert via list_user_stories that 1 User Story exists on the Feature (not the Epic)
    // 5. Assert via list_test_cases that 2 Draft Test Cases exist on the Feature (not the Epic)
    // 6. Assert descriptions contain "Afgeleide van AC op KBT-US-..."
    // 7. Assert Decision entry "Één-richting-regel" exists on the Epic
    //
    // See KBT-TRUL013 for the real-proxy E2E test pattern.
    // This test is intentionally left as documentation; enable with:
    //   KANBANTIC_MCP_URL=<sandbox-url> KANBANTIC_API_KEY=<key> npm test
  }
);

// ---------------------------------------------------------------------------
// KBT-TC2731 — Unit: one Draft Test Case per AC (KBT-F432 / T3137)
// ---------------------------------------------------------------------------

test('KBT-TC2731: SKILL.md Step 5 instructs one create_test_case per AC (not per story)', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  // Step 5 must exist and reference create_test_case on Feature level
  assert.ok(content.includes('## Step 5'), 'SKILL.md must have a Step 5 section for Draft Test Cases');
  assert.ok(content.includes('create_test_case'), 'Step 5 must call create_test_case');
  // The call must be in a per-AC iteration context (not per-story)
  const step5Start = content.indexOf('## Step 5');
  const step6Start = content.indexOf('## Step 6');
  const step5Body = content.substring(step5Start, step6Start);
  assert.ok(
    step5Body.includes('per AC') || step5Body.includes('each AC') || step5Body.includes('AC op'),
    'Step 5 must describe creating one Draft Test Case per AC (not per story)'
  );
  assert.ok(
    step5Body.includes('featureId') || step5Body.includes('Feature — Regel A'),
    'Step 5 create_test_case must target the Feature (Regel A / KBT-RL121)'
  );
});

test('KBT-TC2731: SKILL.md Step 5 uses issueId: featureId (not epicId) for create_test_case', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  const step5Start = content.indexOf('## Step 5');
  const step6Start = content.indexOf('## Step 6');
  const step5Body = content.substring(step5Start, step6Start);
  // Must contain featureId as the issueId argument — anti-pattern is epicId
  assert.ok(step5Body.includes('issueId: featureId'),
    'create_test_case in Step 5 must use issueId: featureId (Regel A — not epicId)');
  // Must contain userStoryId for traceability
  assert.ok(step5Body.includes('userStoryId'),
    'create_test_case in Step 5 must include userStoryId for US-level traceability');
});

// ---------------------------------------------------------------------------
// KBT-TC2733 — Integration: description format has AC text + story code ref
// ---------------------------------------------------------------------------

test('KBT-TC2733: Step 5 description format includes both acText and [storyCode] (KBT-RL123)', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  const step5Start = content.indexOf('## Step 5');
  const step6Start = content.indexOf('## Step 6');
  const step5Body = content.substring(step5Start, step6Start);
  // Description must reference acText (the AC content) and storyCode (the US reference)
  assert.ok(step5Body.includes('acText'),
    'Step 5 description must include acText — the full AC text is required by KBT-RL123');
  assert.ok(step5Body.includes('storyCode'),
    'Step 5 description must include storyCode — the US reference is required by KBT-RL123');
  // Must use square brackets around storyCode per KBT-RL123 spec: "Afgeleide van AC op [KBT-US-XXX]"
  assert.ok(
    step5Body.includes('"Afgeleide van AC op ["') || step5Body.includes("'Afgeleide van AC op ['"),
    'Step 5 description format must wrap storyCode in square brackets: "Afgeleide van AC op [" + storyCode + "]" (KBT-RL123)'
  );
});

test('KBT-TC2733: Step 5 instructs not to create_test_case before create_user_story (storyCode dependency)', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  const step5Start = content.indexOf('## Step 5');
  const step6Start = content.indexOf('## Step 6');
  const step5Body = content.substring(step5Start, step6Start);
  assert.ok(
    step5Body.includes('create_user_story') || step5Body.includes('storyCode is needed'),
    'Step 5 must note the dependency on create_user_story completing first (storyCode is required for traceable description)'
  );
});

// ---------------------------------------------------------------------------
// KBT-TC2732 — E2E: skipped (requires live sandbox workspace)
// ---------------------------------------------------------------------------

test('KBT-TC2732 (E2E): story with 2 ACs → 2 Draft TCs on Feature — SKIPPED (requires sandbox)',
  { skip: 'requires live Kanbantic sandbox workspace + running MCP proxy (KANBANTIC_MCP_URL + KANBANTIC_API_KEY)' },
  async () => {
    // E2E scenario (extension of KBT-TC2729):
    // 1. Graduate a mini-epic via real proxy: 1 feature, 1 story, 2 ACs
    // 2. Assert via list_test_cases(issueId: featureId) that exactly 2 Draft Test Cases exist
    // 3. Assert each TC description matches: "Afgeleide van AC op [KBT-US-XXX]:\n\"<AC text>\""
    // 4. Assert NO test cases exist on the Epic (list_test_cases(issueId: epicId).totalCount == 0)
    // 5. Assert each TC has userStoryId pointing to the correct User Story
    //
    // Enable with: KANBANTIC_MCP_URL=<sandbox-url> KANBANTIC_API_KEY=<key> npm test
  }
);
