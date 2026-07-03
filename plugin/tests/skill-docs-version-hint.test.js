'use strict';

//
// skill-docs-version-hint.test.js — KBT-B392 / KBT-TC2941
//
// Static regression guard: the lane-skill docs that mention `create_version`
// must carry the app-scoped hint near that mention — `applicationId` is
// required and new Versions start in `Planned`. Prevents a future edit from
// reverting to a bare `create_version` reference without the app-scoped
// context (the exact drift KBT-B392 fixed).
//
// Also re-asserts that lint-skills.js still passes on the real tree, so the
// added prose stays Invariant-5-clean (no stale release-domain tokens).
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'plugin', 'skills');
const LINT_SCRIPT = path.join(REPO_ROOT, 'plugin', 'scripts', 'lint-skills.js');

// The lane-skills that reference create_version and therefore must carry the hint.
const HINTED_SKILLS = ['kanbantic-issue-execute', 'kanbantic-issue-prepare'];

// Proximity window (chars) after a `create_version` occurrence in which the
// app-scoped hint tokens must all appear.
const WINDOW = 320;
const HINT_TOKENS = ['app-scoped', 'applicationId', 'Planned'];

function readSkill(name) {
  return fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
}

function hasHintNearCreateVersion(content) {
  const needle = 'create_version';
  let from = 0;
  let idx;
  while ((idx = content.indexOf(needle, from)) !== -1) {
    const window = content.slice(idx, idx + WINDOW);
    if (HINT_TOKENS.every((t) => window.includes(t))) return true;
    from = idx + needle.length;
  }
  return false;
}

for (const skill of HINTED_SKILLS) {
  test(`${skill}: create_version mention carries the app-scoped hint`, () => {
    const content = readSkill(skill);
    assert.ok(
      content.includes('create_version'),
      `${skill}/SKILL.md is expected to reference create_version`
    );
    assert.ok(
      hasHintNearCreateVersion(content),
      `${skill}/SKILL.md must state near a create_version mention that it is ` +
        `app-scoped (applicationId required) and new Versions start in Planned. ` +
        `Expected all of [${HINT_TOKENS.join(', ')}] within ${WINDOW} chars of a ` +
        `create_version occurrence.`
    );
  });
}

test('lint-skills passes on the real tree (added hint stays Invariant-5-clean)', () => {
  const r = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8' });
  assert.equal(
    r.status,
    0,
    `expected lint-skills exit 0, got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`
  );
  assert.match(r.stdout, /OK: all SKILL.md invariants pass/);
});
