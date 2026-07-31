'use strict';

//
// specialist-subagent-resolution.test.js — KBT-B504
//
// De vier specialist-skills delegeren hun analyse naar een subagent. De naam
// waaronder Claude Code die subagent kent is de SLUG VAN DE TITEL van het
// Toolkit-item, geschreven door /kanbantic-sync-workspace-skills — niet iets
// dat de plugin mag vaststellen.
//
// Dat ging mis: `kanbantic-specialist-test-coverage` declareerde
// `test-specialist`, terwijl de Toolkit-titel "Test Coverage Specialist" via
// slugify() `test-coverage-specialist` oplevert. De skill dispatchte dus naar
// een naam die na een sync niet bestaat.
//
// Het bleef onzichtbaar doordat de shared core bij een onvindbare subagent
// stilletjes terugviel op inline-analyse. Die terugval is nu gesplitst: een
// ontbrekend Toolkit-item is een legitieme leemte, een item dat bestaat maar
// niet te dispatchen is een misconfiguratie die gemeld hoort te worden.
//
// Zichtbaar geworden door KBT-B495: zolang gesyncte agents helemaal niet
// laadden, viel een verkeerde naam niemand op.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
const CORE = path.join(SKILLS_DIR, 'specialist-run-shared', 'lifecycle-core.md');

const { slugify } = require(path.join(PLUGIN_ROOT, 'scripts', 'sync-workspace-skills.js'));

/** De vier specialist-wrappers en de Toolkit-titel waar hun subagent uit volgt. */
const SPECIALISTS = [
  { skill: 'kanbantic-specialist-test-coverage', toolkitTitle: 'Test Coverage Specialist' },
  { skill: 'kanbantic-specialist-documentation', toolkitTitle: 'Documentation Specialist' },
  { skill: 'kanbantic-specialist-security', toolkitTitle: 'Security Specialist' },
  { skill: 'kanbantic-specialist-project-manager', toolkitTitle: 'Project Manager Specialist' },
];

function readSkill(name) {
  return fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
}

/** Haal de gedeclareerde SUBAGENT-waarde uit de identity-tabel. */
function declaredSubagent(text) {
  const m = /\|\s*`SUBAGENT`\s*\|\s*`([^`]+)`\s*\|/.exec(text);
  return m ? m[1] : null;
}

test('KBT-B504: elke specialist-skill declareert de naam die de sync daadwerkelijk schrijft', () => {
  const mismatches = [];
  for (const { skill, toolkitTitle } of SPECIALISTS) {
    const declared = declaredSubagent(readSkill(skill));
    const expected = slugify(toolkitTitle);
    assert.ok(declared, `${skill}: geen SUBAGENT-regel gevonden in de identity-tabel`);
    if (declared !== expected) {
      mismatches.push(`  ${skill}: declareert "${declared}", maar "${toolkitTitle}" slugificeert naar "${expected}"`);
    }
  }
  assert.equal(mismatches.length, 0,
    'De gedeclareerde subagent-naam moet gelijk zijn aan de slug van de Toolkit-titel —\n'
    + 'anders dispatcht de skill naar een agent die na een sync niet bestaat (KBT-B504):\n'
    + mismatches.join('\n'));
});

test('KBT-B504: de gedeclareerde naam is een hint, niet de bron — de core resolvet hem', () => {
  const core = fs.readFileSync(CORE, 'utf8');

  assert.match(core, /## Step 3a: Resolve the subagent's actual name/,
    'de shared core moet een expliciete resolutiestap hebben');
  assert.match(core, /list_toolkit_items\(workspaceId: <workspaceId>, category: "Subagent"\)/,
    'de resolutie moet de Toolkit raadplegen, niet de gedeclareerde naam vertrouwen');
  assert.match(core, /Agent\(subagent_type: <name resolved in Step 3a>/,
    'Step 3 moet de geresolvede naam dispatchen, niet de rauwe SUBAGENT-variabele');
  assert.match(core, /a hint, not an assumption/,
    'de identity-tabel moet duidelijk maken dat SUBAGENT een verwachting is');
});

test('KBT-B504: een bestaand item zonder bruikbare mirror is een misconfiguratie, geen stille terugval', () => {
  const core = fs.readFileSync(CORE, 'utf8');

  // De terugval moet expliciet beperkt zijn tot "geen item gevonden".
  assert.match(core, /no Subagent item at all/,
    'de inline-terugval moet expliciet beperkt zijn tot een ontbrekend Toolkit-item');
  assert.match(core, /misconfiguration/i,
    'het geval "item bestaat, dispatch onmogelijk" moet als misconfiguratie benoemd zijn');

  // En dat onderscheid moet in een HARD-GATE staan, niet als losse suggestie.
  const gate = /<HARD-GATE>[\s\S]*?<\/HARD-GATE>/g;
  const gates = core.match(gate) || [];
  assert.ok(
    gates.some(g => /silently substituting|only continue inline if the user explicitly asks/i.test(g)),
    'het verbod op stil doorgaan bij een onbruikbare mirror hoort in een HARD-GATE te staan');
});

test('KBT-B504: de slug-regel levert voor de echte Toolkit-titels bruikbare agent-namen op', () => {
  for (const { toolkitTitle } of SPECIALISTS) {
    const slug = slugify(toolkitTitle);
    assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/,
      `"${toolkitTitle}" moet een schone agent-naam opleveren, kreeg "${slug}"`);
  }
  // De regressie zelf, expliciet vastgelegd.
  assert.equal(slugify('Test Coverage Specialist'), 'test-coverage-specialist');
  assert.notEqual(slugify('Test Coverage Specialist'), 'test-specialist');
});
