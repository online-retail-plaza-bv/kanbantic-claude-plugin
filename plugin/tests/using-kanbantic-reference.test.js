'use strict';

//
// using-kanbantic-reference.test.js — KBT-F623 / KBT-TC3353
//
// F7 splitst de AI-kennis op doelgroep (KBT-TRUL014 / KBT-RL198):
//
//   USE-KANBANTIC — hoe je Kanbantic zelf bedient (MCP-tools, lane-workflow,
//                   readiness-gates). Geldt in ELKE workspace  → plugin.
//   BUILD-APP     — hoe je een specifieke app bouwt/deployt   → workspace-Toolkit.
//
// Het kanaal is de hele reden voor deze feature: gotchas zijn per-workspace data
// die via `bootstrap_agent` alleen de eigen workspace bereiken, terwijl skills en
// reference-docs plugin-shipped zijn en overal laden. Een agent in AdminHub kreeg
// de lane-lessen dus simpelweg nooit te zien.
//
// Deze tests pinnen vast dat het referentiedoc bestaat, dat elke lane ernaar
// wijst, en dat de wiring niet stilletjes verdwijnt bij een doc-refactor — want
// het uitvallen ervan is onzichtbaar: je merkt het pas als een agent ergens
// anders in dezelfde val trapt.
//

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugin');
const SKILLS_ROOT = path.join(PLUGIN_ROOT, 'skills');
const DOC_REL     = 'reference/using-kanbantic.md';
const DOC_PATH    = path.join(PLUGIN_ROOT, DOC_REL);

function readDoc() {
  return fs.readFileSync(DOC_PATH, 'utf8');
}

function readSkill(relPath) {
  return fs.readFileSync(path.join(SKILLS_ROOT, relPath), 'utf8');
}

// ─── B2: het referentiedoc bestaat en is een echte bron ──────────────────────

test('the USE-KANBANTIC reference doc exists', () => {
  assert.ok(
    fs.existsSync(DOC_PATH),
    `${DOC_REL} is the single source of truth for USE-KANBANTIC knowledge (KBT-RL198). ` +
    'If it moved, update this test and every skill pointer together.'
  );
});

test('the reference doc carries content, not just a pointer', () => {
  // kanbantic-workflow-v3.md next to it IS deliberately a pointer, because the
  // Library doc is reachable. This one cannot be: a pointer into the Kanbantic
  // workspace is unreadable from AdminHub or ShopSentry, which is the exact
  // failure KBT-F623 fixes. So it must hold the lessons itself.
  const doc = readDoc();
  assert.ok(
    doc.length > 4000,
    `${DOC_REL} looks too short to be carrying the lessons (${doc.length} chars) — ` +
    'has it been reduced to a pointer? That would re-break cross-workspace reach.'
  );
});

test('the reference doc states the BUILD-APP vs USE-KANBANTIC split', () => {
  // Match on collapsed whitespace: the doc is hard-wrapped, so a phrase can span
  // a line break. Asserting on raw text would fail on reflow alone, which would
  // make this test a nuisance rather than a guard.
  const doc = readDoc().replace(/\s+/g, ' ');
  for (const needle of ['USE-KANBANTIC', 'BUILD-APP', 'elke workspace']) {
    assert.ok(
      doc.includes(needle),
      `${DOC_REL} must explain the "${needle}" side of the split — without it the ` +
      'next author has no rule for deciding where a new lesson belongs.'
    );
  }
});

// ─── B1: elke lane wijst naar het doc ────────────────────────────────────────

const WIRED_SKILLS = [
  'kanbantic-issue-prepare/SKILL.md',
  'kanbantic-issue-execute/SKILL.md',
  'kanbantic-issue-review/SKILL.md',
  'kanbantic-issue-triage/SKILL.md',
  'kanbantic-orchestrate/SKILL.md',
  'specialist-run-shared/lifecycle-core.md',
];

for (const rel of WIRED_SKILLS) {
  test(`${rel} points at the reference doc`, () => {
    assert.ok(
      readSkill(rel).includes('reference/using-kanbantic.md'),
      `${rel} must reference ${DOC_REL} (KBT-SR595 B1). A lane that does not point ` +
      'at it leaves its agents without the lessons for that lane.'
    );
  });
}

test('the pointers resolve via $CLAUDE_PLUGIN_ROOT, never a hardcoded path', () => {
  for (const rel of WIRED_SKILLS) {
    const line = readSkill(rel)
      .split('\n')
      .find((l) => l.includes('reference/using-kanbantic.md'));
    assert.ok(line, `no pointer line found in ${rel}`);
    assert.ok(
      line.includes('CLAUDE_PLUGIN_ROOT'),
      `${rel} must resolve the doc via $CLAUDE_PLUGIN_ROOT — a hardcoded path breaks ` +
      `on every version bump. Found: ${line.trim().slice(0, 120)}`
    );
  }
});

// ─── De lane-specifieke lessen staan bij de juiste lane ──────────────────────

test('each lane names the lessons that apply to it', () => {
  // A bare "see the reference doc" is easy to skim past. The pointer names the
  // concrete traps for that lane so an agent recognises the symptom in situ.
  const expectations = [
    ['kanbantic-issue-prepare/SKILL.md', ['update_specification', 'user story', 'Epics']],
    ['kanbantic-issue-execute/SKILL.md', ['isReadyToClaim', 'Ready', 'EnterWorktree']],
    ['kanbantic-issue-review/SKILL.md', ['InDeployment', 'approve_review', 'worktree']],
  ];

  for (const [rel, needles] of expectations) {
    const content = readSkill(rel);
    for (const needle of needles) {
      assert.ok(
        content.includes(needle),
        `${rel} should name "${needle}" in its using-kanbantic pointer, so the trap ` +
        'is recognisable without opening the doc first.'
      );
    }
  }
});

// ─── Migratiehygiëne: geen verouderde terminologie meegenomen ────────────────

test('the reference doc uses the current lane name, and flags the old one', () => {
  const doc = readDoc();

  // The lane was renamed Prepared → Ready in KBT-E103. The source gotchas
  // (GTCH025/026) still said "Prepared"; copying that verbatim would have
  // shipped stale terminology as the new canonical source.
  assert.ok(
    doc.includes('`Ready`'),
    'The doc must use the current lane name `Ready`.'
  );
  assert.ok(
    /hernoemd|KBT-E103/.test(doc),
    'The doc must explain the Prepared → Ready rename (KBT-E103), otherwise a ' +
    'reader who meets "Prepared" in older material cannot tell it is stale.'
  );
});

test('the doc reflects the post-KBT-B512 test-policy behaviour', () => {
  const doc = readDoc();

  // GTCH105 documented a workaround (override the diversity gate) that B512 made
  // unnecessary. Migrating it verbatim would have shipped advice that is wrong on
  // a patched server — and dropping it would have stranded anyone still on an
  // older one. It must therefore be present AND qualified.
  assert.ok(
    doc.includes('KBT-B512'),
    'The doc must mention KBT-B512, which made the pre-deploy and diversity gates ' +
    'honour the Regel-E policy.'
  );
  assert.ok(
    /Failed|rood/.test(doc),
    'The doc must state that NotApplicable is not a licence for a red test case.'
  );
});
