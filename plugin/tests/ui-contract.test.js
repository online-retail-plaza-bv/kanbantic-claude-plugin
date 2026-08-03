'use strict';

//
// ui-contract.test.js — KBT-F627
//
// Verifies that wireframe-fidelity is enforced across the whole lane-flow:
//
//   Include  — plugin/skills/lane-shared/ui-contract.md exists and carries the
//              core sections (contract format, attachment conventions,
//              no-pixel-diff conformity rules, opt-out, workspace policy).
//   Wrappers — all four lane-skills (prepare / execute / review / graduation)
//              reference the shared include (lifecycle-core precedent).
//   Prepare  — 5F.3b UI-contract step, 5W relational pin + reference crops,
//              6a report lines, 5B bug-route paragraph.
//   Execute  — implementer-prompt wireframe section + checklist + report +
//              usage; SKILL.md 6e result-screenshots + Step 7 condition 4.
//   Review   — Step 1b uiContract loading, Step 2.5 deterministic pre-gate,
//              reviewer-prompt input/check/output/verdict additions.
//
// Same static-assertion style as lane-skill-process-rules.test.js: all
// assertions read on-disk files; no tmp-dir or mutation needed.
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

const INCLUDE_PATH = path.join(SKILLS_ROOT, 'lane-shared', 'ui-contract.md');

// ─── Include: lane-shared/ui-contract.md ─────────────────────────────────────

test('KBT-F627: shared include lane-shared/ui-contract.md exists', () => {
  assert.ok(fs.existsSync(INCLUDE_PATH), 'plugin/skills/lane-shared/ui-contract.md must exist');
});

test('KBT-F627: include carries the canonical contract format', () => {
  const content = fs.readFileSync(INCLUDE_PATH, 'utf8');
  assert.ok(
    content.includes('## UI-contract (bevroren bij claim_issue — KBT-F627)'),
    'include must define the canonical Decision-entry header'
  );
  // The five element categories.
  for (const cat of ['Knoppen', 'Tabelkolommen', 'breadcrumbs', 'Menu-plaatsing', 'States']) {
    assert.ok(content.includes(cat), `include must list element category "${cat}"`);
  }
  assert.ok(
    content.match(/## Wireframe.?-blok|`## Wireframe`-blok/),
    'contract must be derived from the pinned pages of the ## Wireframe-blok'
  );
  assert.ok(
    content.includes('Do not duplicate this logic into the wrappers'),
    'include must carry the lifecycle-core-style do-not-duplicate header'
  );
  assert.ok(
    content.includes('$CLAUDE_PLUGIN_ROOT/skills/lane-shared/ui-contract.md'),
    'include must name its own canonical reference path'
  );
});

test('KBT-F627: include carries the attachment conventions', () => {
  const content = fs.readFileSync(INCLUDE_PATH, 'utf8');
  assert.ok(
    content.includes('wf-<versie>-<pagina>-<state>.png'),
    'include must define the prepare-crop naming convention'
  );
  assert.ok(
    content.includes('result-<versie>-<pagina>-<state>.png'),
    'include must define the result-screenshot naming convention'
  );
  assert.ok(content.includes('1440'), 'include must pin the 1440px width');
  assert.ok(content.match(/Playwright/i), 'include must name Playwright as the capture mechanism');
  assert.ok(
    content.includes('add_issue_attachment'),
    'include must route both sets through add_issue_attachment'
  );
  assert.ok(
    content.match(/afgeleide/i),
    'include must state attachments are derivatives (states live in the wireframe)'
  );
});

test('KBT-F627: include carries the no-pixel-diff conformity rules', () => {
  const content = fs.readFileSync(INCLUDE_PATH, 'utf8');
  assert.ok(
    content.match(/element-voor-element/i),
    'include must require element-for-element comparison'
  );
  assert.ok(
    content.match(/NOOIT pixel-diff|nooit pixel-diff/i),
    'include must forbid pixel-diff comparison'
  );
  assert.ok(
    content.includes('Afgeweken van het wireframe'),
    'include must name the deviation heading'
  );
  assert.ok(
    content.match(/fix-vereist/i),
    'include must state that an unreported deviation is fix-vereist'
  );
});

test('KBT-F627: include carries the opt-out and the workspace-policy rule', () => {
  const content = fs.readFileSync(INCLUDE_PATH, 'utf8');
  assert.ok(
    content.includes('## Wireframe — n.v.t. (geen UI)'),
    'include must document the explicit opt-out block'
  );
  assert.ok(
    content.match(/Toolkit-Rule/i),
    'include must delegate UI-plicht policy to a workspace Toolkit-Rule item'
  );
  assert.ok(
    content.match(/KBT-B499|KBT-BD202/),
    'include must reference the mechaniek-in-plugin / beleid-in-workspace precedent'
  );
  assert.ok(
    content.match(/pre-flight-checks/),
    'include must name the Step 0.7 pre-flight-checks model'
  );
});

// ─── Wrappers: all four skills reference the include ─────────────────────────

test('KBT-F627: all four lane-skills reference lane-shared/ui-contract.md near the top', () => {
  for (const lane of [
    'kanbantic-issue-prepare',
    'kanbantic-issue-execute',
    'kanbantic-issue-review',
    'kanbantic-graduation',
  ]) {
    const content = readSkill(lane);
    assert.ok(
      content.includes('$CLAUDE_PLUGIN_ROOT/skills/lane-shared/ui-contract.md'),
      `${lane}/SKILL.md must reference the shared ui-contract include`
    );
    // The reference must appear before the Overview section (top-of-file placement).
    const refIdx = content.indexOf('lane-shared/ui-contract.md');
    const overviewIdx = content.indexOf('## Overview');
    assert.ok(
      refIdx !== -1 && overviewIdx !== -1 && refIdx < overviewIdx,
      `${lane}/SKILL.md must reference the include above the Overview section`
    );
  }
});

// ─── Prepare: 5F.3b + 5W + 6a + bug-route ────────────────────────────────────

test('KBT-F627: prepare has a 5F.3b UI-contract section between 5F.3 and 5F.4', () => {
  const content = readSkill('kanbantic-issue-prepare');
  assert.ok(
    content.includes('### 5F.3b: UI-contract (HARD voor UI-issues — KBT-F627)'),
    'prepare must carry section 5F.3b'
  );
  const idx3b = content.indexOf('### 5F.3b:');
  const idx4 = content.indexOf('### 5F.4:');
  assert.ok(idx3b !== -1 && idx4 !== -1 && idx3b < idx4, '5F.3b must precede 5F.4');

  const sectionMatch = content.match(/### 5F\.3b:[\s\S]*?(?=### 5F\.4)/);
  assert.ok(sectionMatch, '5F.3b section not found');
  const section = sectionMatch[0];
  assert.ok(
    section.includes('## UI-contract (bevroren bij claim_issue — KBT-F627)'),
    '5F.3b must show the canonical UI-contract Decision-entry header'
  );
  assert.ok(
    section.includes('add_discussion_entry'),
    '5F.3b must carry an add_discussion_entry code block'
  );
  assert.ok(
    section.includes('lane-shared/ui-contract.md'),
    '5F.3b must reference the shared include'
  );
  assert.ok(
    section.match(/n\.v\.t\. \(geen UI\)/),
    '5F.3b must document the opt-out skip'
  );
});

test('KBT-F627: prepare Step 5W pins relationally and attaches reference crops', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const sectionMatch = content.match(/## Step 5W:[\s\S]*?(?=## Step 6: Validate Readiness)/);
  assert.ok(sectionMatch, 'Step 5W section not found');
  const section = sectionMatch[0];
  assert.ok(
    section.includes('link_wireframe_to_issue'),
    '5W must call link_wireframe_to_issue after successful page validation'
  );
  assert.ok(
    section.includes('add_issue_attachment'),
    '5W must attach Playwright screenshot crops via add_issue_attachment'
  );
  assert.ok(
    section.includes('wf-<versie>-<pagina>-<state>.png'),
    '5W must use the include naming convention for reference crops'
  );
  assert.ok(
    section.match(/afgeleide/i),
    '5W must note the attachment is a derivative (states live in the wireframe)'
  );
});

test('KBT-F627: prepare bug-route routes UI-rakende bugs through the UI-contract mechanism', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const sectionMatch = content.match(/### 5B\.6:[\s\S]*?(?=### 5B\.7)/);
  assert.ok(sectionMatch, '5B.6 section (incl. trailing paragraph) not found');
  const section = sectionMatch[0];
  assert.ok(
    section.match(/UI-rakende bugs|UI-contract \(KBT-F627\)/),
    'bug-route must carry the UI-contract paragraph between 5B.6 and 5B.7'
  );
  assert.ok(
    section.includes('5F.3b') && section.includes('lane-shared/ui-contract.md'),
    'bug-route paragraph must reference 5F.3b and the shared include'
  );
});

test('KBT-F627: prepare 6a report includes Wireframe pinned + UI-contract lines', () => {
  const content = readSkill('kanbantic-issue-prepare');
  const sectionMatch = content.match(/### 6a:[\s\S]*?(?=### 6b)/);
  assert.ok(sectionMatch, '6a section not found');
  const section = sectionMatch[0];
  assert.ok(
    section.match(/- Wireframe pinned: ✓ \(vN, <pagina's>\) \/ n\.v\.t\./),
    '6a report must carry the "Wireframe pinned" line'
  );
  assert.ok(
    section.match(/- UI-contract: ✓ \/ n\.v\.t\./),
    '6a report must carry the "UI-contract" line'
  );
});

// ─── Execute: implementer-prompt + 6e + Step 7 condition 4 ───────────────────

test('KBT-F627: implementer-prompt has the binding wireframe section before Project Patterns', () => {
  const content = readSkill('kanbantic-issue-execute', 'implementer-prompt.md');
  assert.ok(
    content.includes('## Wireframe (bindend — gepinde versie)'),
    'implementer-prompt must carry the binding wireframe section'
  );
  const codeIdx = content.indexOf('## Code Instructions');
  const wfIdx = content.indexOf('## Wireframe (bindend — gepinde versie)');
  const patternsIdx = content.indexOf('## Project Patterns (from Kanbantic Toolkit)');
  assert.ok(
    codeIdx !== -1 && wfIdx !== -1 && patternsIdx !== -1 && codeIdx < wfIdx && wfIdx < patternsIdx,
    'wireframe section must sit between Code Instructions and Project Patterns'
  );
  const section = content.slice(wfIdx, patternsIdx);
  assert.ok(
    section.match(/normatief/i),
    'wireframe section must state every element is normative'
  );
  assert.ok(
    section.match(/NIET bouwen|niet bouwen/),
    'wireframe section must forbid building unlisted elements (report instead)'
  );
  assert.ok(
    section.match(/structure-faithful/) && section.match(/KBT-RL191/),
    'wireframe section must cite structure-faithful (KBT-RL191)'
  );
  assert.ok(
    section.match(/[Pp]ixel-spacing.*vrij/),
    'wireframe section must leave pixel-spacing free'
  );
});

test('KBT-F627: implementer-prompt checklist + report + usage carry the wireframe items', () => {
  const content = readSkill('kanbantic-issue-execute', 'implementer-prompt.md');
  const patternsIdx = content.indexOf('- [ ] Code follows existing codebase patterns');
  const wfCheckIdx = content.indexOf(
    '- [ ] UI matches the pinned wireframe element-for-element (or the deviation is reported below)'
  );
  assert.ok(
    patternsIdx !== -1 && wfCheckIdx !== -1 && wfCheckIdx > patternsIdx,
    'checklist must add the wireframe item after "Code follows existing codebase patterns"'
  );
  assert.ok(
    content.includes('- Wireframe deviations ("Afgeweken van het wireframe"): <lijst of "geen">'),
    'report format must carry the wireframe-deviations item'
  );
  assert.ok(
    content.includes('- Result screenshots: <paden>'),
    'report format must carry the result-screenshots item'
  );
  const usageIdx = content.indexOf('## Usage');
  assert.ok(usageIdx !== -1, 'Usage section must exist');
  const usage = content.slice(usageIdx);
  assert.ok(
    usage.match(/get_wireframe\(<slug>, <versie>, <pagina>\)/),
    'Usage must state the parent calls get_wireframe(<slug>, <versie>, <pagina>) to fill the placeholder'
  );
});

test('KBT-F627: execute has Step 6e for result-screenshot attachments', () => {
  const content = readSkill('kanbantic-issue-execute');
  assert.ok(
    content.includes('### 6e: Resultaat-screenshots als attachment (UI-issues — KBT-F627)'),
    'execute must carry section 6e'
  );
  const idx6d = content.indexOf('### 6d:');
  const idx6e = content.indexOf('### 6e:');
  const idx7 = content.indexOf('## Step 7:');
  assert.ok(idx6d < idx6e && idx6e < idx7, '6e must sit after 6d and before Step 7');

  const section = content.slice(idx6e, idx7);
  assert.ok(section.includes('add_issue_attachment'), '6e must attach via add_issue_attachment');
  assert.ok(
    section.match(/dezelfde breedtes|zelfde breedtes|zelfde uitsneden|dezelfde.*uitsneden/i),
    '6e must require the same widths/crops as the prepare attachments'
  );
  assert.ok(
    section.includes('lane-shared/ui-contract.md'),
    '6e must reference the include for naming'
  );
});

test('KBT-F627: execute Step 7 HARD-GATE carries condition 4 (wireframe conformity)', () => {
  const content = readSkill('kanbantic-issue-execute');
  const gateMatch = content.match(/## Step 7:[\s\S]*?<\/HARD-GATE>/);
  assert.ok(gateMatch, 'Step 7 HARD-GATE block not found');
  const gate = gateMatch[0];
  assert.ok(
    gate.match(/4\.\s+\*\*Wireframe-conformiteit \(UI-issues — KBT-F627\)\*\*/),
    'Step 7 gate must carry numbered condition 4 for UI-issues'
  );
  assert.ok(
    gate.includes('Afgeweken van het wireframe'),
    'condition 4 must require the deviation heading in the handoff-entry'
  );
  assert.ok(
    gate.includes('list_issue_attachments'),
    'condition 4 must verify result-attachments via list_issue_attachments'
  );
  assert.ok(
    gate.match(/element-voor-element/),
    'condition 4 must confirm element-for-element conformity'
  );
  assert.ok(
    gate.match(/blijft `?InProgress`?/),
    'condition 4 must keep the issue InProgress when unmet'
  );
});

// ─── Review: Step 1b + Step 2.5 + reviewer-prompt ───────────────────────────

test('KBT-F627: review Step 1b loads wireframe-blok, UI-contract and attachment-sets as uiContract', () => {
  const content = readSkill('kanbantic-issue-review');
  const sectionMatch = content.match(/## Step 1b:[\s\S]*?(?=## Step 2)/);
  assert.ok(sectionMatch, 'Step 1b section not found');
  const section = sectionMatch[0];
  assert.ok(section.includes('parseWireframeBlock'), 'Step 1b must parse the ## Wireframe-blok');
  assert.ok(
    section.match(/prefix `## UI-contract`|begint met.*## UI-contract|starts with the prefix `## UI-contract`/),
    'Step 1b must locate the UI-contract Decision-entry by its prefix'
  );
  assert.ok(
    section.includes('list_issue_attachments'),
    'Step 1b must load both attachment-sets via list_issue_attachments'
  );
  assert.ok(
    section.includes('download_issue_attachment'),
    'Step 1b must mention download_issue_attachment for pixel access'
  );
  assert.ok(section.includes('uiContract'), 'Step 1b must store the result as uiContract');
  assert.ok(
    section.match(/If no UI-contract Decision-entry is found on a UI-issue.*Critical review issue.*prepare-step was incomplete/s),
    'Step 1b must flag a missing UI-contract as Critical with the test-policy-absence phrasing'
  );
});

test('KBT-F627: review has a deterministic Step 2.5 UI-pre-gate-scan between Step 2 and Step 3', () => {
  const content = readSkill('kanbantic-issue-review');
  assert.ok(
    content.includes('## Step 2.5: UI-pre-gate-scan (deterministisch — KBT-F627)'),
    'review must carry Step 2.5'
  );
  const idx2 = content.indexOf('## Step 2:');
  const idx25 = content.indexOf('## Step 2.5:');
  const idx3 = content.indexOf('## Step 3:');
  assert.ok(idx2 < idx25 && idx25 < idx3, 'Step 2.5 must sit between Step 2 and Step 3');

  const section = content.slice(idx25, idx3);
  assert.ok(
    section.includes('list_issue_wireframes'),
    'Step 2.5 must check the relational pin via list_issue_wireframes'
  );
  assert.ok(
    section.includes('list_issue_attachments'),
    'Step 2.5 must check the result-attachments via list_issue_attachments'
  );
  assert.ok(section.match(/Critical/), 'Step 2.5 must auto-flag Critical');
  assert.ok(section.includes('⚠️'), 'Step 2.5 must carry the ⚠️ block with herstelacties');
  assert.ok(
    section.match(/niet-UI-issues: continue silently|niet-UI-issues:\*\* continue silently/i),
    'Step 2.5 must let non-UI issues continue silently'
  );
  assert.ok(
    section.match(/Step 6\.5|Deferred-Cancel Scan/),
    'Step 2.5 must cite the Step 6.5 Deferred-Cancel Scan model'
  );
});

test('KBT-F627: reviewer-prompt carries UI-contract input, checkpoint 6, output section and verdict note', () => {
  const content = readSkill('kanbantic-issue-review', 'reviewer-prompt.md');
  assert.ok(
    content.includes('## UI-contract & Wireframe (KBT-F627)'),
    'reviewer-prompt must carry the UI-contract input section'
  );
  assert.ok(
    content.match(/6\.\s+\*\*Wireframe Conformity Check\*\* \(KBT-F627\)/),
    'reviewer-prompt must carry checkpoint 6 Wireframe Conformity Check'
  );
  // Checkpoint 6 sits after checkpoint 5 (test-policy) and before the renumbered Issues checkpoint.
  const idx5 = content.indexOf('5. **Test-Policy Coverage Check**');
  const idx6 = content.indexOf('6. **Wireframe Conformity Check**');
  const idx7 = content.indexOf('7. **Issues**');
  assert.ok(idx5 !== -1 && idx6 !== -1 && idx7 !== -1 && idx5 < idx6 && idx6 < idx7,
    'checkpoint 6 must follow checkpoint 5, and Issues must be renumbered to 7');

  const check = content.slice(idx6, idx7);
  assert.ok(
    check.match(/element-voor-element/),
    'checkpoint 6 must compare element-for-element against the UI-contract'
  );
  assert.ok(
    check.match(/unreported deviation = Critical|[Oo]ngemelde afwijking.*Critical/i),
    'checkpoint 6 must make an unreported deviation Critical'
  );
  assert.ok(
    content.includes('## Wireframe Conformity (KBT-F627)'),
    'reviewer-prompt output format must carry a Wireframe Conformity section'
  );
  assert.ok(
    content.includes(
      'Note: missing wireframe conformity on a UI-issue → always REJECT — it cannot be overridden by other strengths.'
    ),
    'reviewer-prompt must carry the wireframe verdict note'
  );
  assert.ok(
    content.match(/n\.v\.t\./),
    'reviewer-prompt must mark non-UI issues as n.v.t. in the UI sections'
  );
});

// ─── KBT-F627 review-fix (Important #2/#3): handoff-entry + marker are defined
//     and produced by named steps ────────────────────────────────────────────────

test('KBT-F627 fix: execute 6e defines the handoff-entry (add_discussion_entry with the deviation section)', () => {
  const content = readSkill('kanbantic-issue-execute');
  const sectionMatch = content.match(/### 6e:[\s\S]*?(?=## Step 7)/);
  assert.ok(sectionMatch, '6e section not found in execute SKILL.md');
  const section = sectionMatch[0];
  assert.ok(
    section.includes('add_discussion_entry'),
    '6e must CREATE the handoff-entry via add_discussion_entry — not merely reference it'
  );
  assert.ok(
    section.includes('Afgeweken van het wireframe'),
    '6e handoff-entry template must contain the deviation section'
  );
});

test('KBT-F627 fix: execute Step 7 condition 4c produces the "UI-UX review:" marker entry', () => {
  const content = readSkill('kanbantic-issue-execute');
  const gateMatch = content.match(/4\. \*\*Wireframe-conformiteit[\s\S]*?(?=<\/HARD-GATE>)/);
  assert.ok(gateMatch, 'Step 7 condition 4 not found in execute SKILL.md');
  const gate = gateMatch[0];
  assert.ok(
    gate.includes('UI-UX review:') && gate.includes('add_discussion_entry'),
    'condition 4c must record the conformity confirmation as a discussion-entry starting with "UI-UX review:"'
  );
});

test('KBT-F627 fix: review Step 2.5 names the marker-entry producer (execute 7-4c)', () => {
  const content = readSkill('kanbantic-issue-review');
  const sectionMatch = content.match(/## Step 2\.5:[\s\S]*?(?=## Step 3)/);
  assert.ok(sectionMatch, 'Step 2.5 section not found in review SKILL.md');
  assert.ok(
    sectionMatch[0].includes('UI-UX review:'),
    'Step 2.5 must check the "UI-UX review:"-entry and name who writes it'
  );
});

// ─── Lint integration: real tree still passes all invariants ─────────────────

test('Integration: lint-skills.js still passes after the KBT-F627 additions', () => {
  const { spawnSync } = require('node:child_process');
  const SCRIPT = path.join(REPO_ROOT, 'plugin', 'scripts', 'lint-skills.js');

  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(
    r.status, 0,
    `lint-skills.js must exit 0 on the updated tree — got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`
  );
  assert.match(r.stdout, /OK: all SKILL.md invariants pass/);
});
