'use strict';

//
// bug-autopilot-delegation.test.js — KBT-B494 / KBT-TC3521
//
// `kanbantic-bug-autopilot` used to describe the four lanes generically without
// ever naming the lane-skills. A grep for `kanbantic-issue-(triage|prepare|
// execute|review)` in its SKILL.md returned zero. The skill nonetheless asserted
// a HARD-GATE that "every lane skill performs its own checks" — true only if
// those skills actually run. With no instruction to invoke them, the executing
// agent improvised each lane and silently skipped everything the lane-skills
// carry.
//
// Two documented losses in the ADM-B248 run of 2026-07-30: the test-policy
// declaration (Regel E / KBT-F442), which left the issue stuck on the
// InDeployment gate with a redundant manual E2E case to cancel; and the worktree
// HARD-GATE (KBT-TRUL004), which ran the issue in the main checkout.
//
// The prose was corrected in commit 3c13472 — but WITHOUT a test. That is why
// this file exists even though the bug is already fixed: the fix currently lives
// only as sentences in a markdown file, and the next rewrite of that file can
// drop a section without anything turning red. Which is precisely how the bug
// arose the first time.
//
// The absence assertion at the bottom is the one that carries weight. The four
// presence checks are easy to satisfy; forbidding `set_test_policy` in this file
// pins the architectural decision the issue insists on — "delegate, do not
// duplicate" — and blocks the most tempting wrong fix, namely making the
// autopilot set the policy itself and creating a second source that drifts the
// moment prepare tightens its criteria.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_MD = path.resolve(
  __dirname, '..', 'skills', 'kanbantic-bug-autopilot', 'SKILL.md'
);

const LANE_SKILLS = [
  'kanbantic-issue-triage',
  'kanbantic-issue-prepare',
  'kanbantic-issue-execute',
  'kanbantic-issue-review',
];

function read() {
  return fs.readFileSync(SKILL_MD, 'utf8');
}

test('KBT-TC3521: the autopilot names every lane-skill it delegates to', () => {
  const md = read();
  const missing = LANE_SKILLS.filter(s => !md.includes(s));
  assert.deepEqual(
    missing, [],
    `kanbantic-bug-autopilot/SKILL.md does not name: ${missing.join(', ')}. ` +
    `Without the name, the executing agent has nothing to invoke and improvises ` +
    `the lane instead — skipping the gates that lane-skill carries (KBT-B494).`
  );
});

test('KBT-TC3521: the autopilot has a Boundary section stating what it does NOT do', () => {
  const md = read();
  assert.match(
    md, /^##+\s+Boundary\b/m,
    'No `## Boundary` section found. kanbantic-orchestrate is the reference model ' +
    'here: sequencing skills must state explicitly that they do not re-implement ' +
    'lane logic, claim, merge, or test-policy.'
  );
});

test('KBT-TC3521: the autopilot declares that it owns sequencing, not lane content', () => {
  const md = read();
  assert.match(
    md, /sequencing/i,
    'The skill should say in so many words that it owns sequencing only — that is ' +
    'the sentence that stops an agent from performing the lane itself.'
  );
});

test('KBT-TC3521: the two gates lost in the ADM-B248 run are named', () => {
  const md = read();
  // Regel E / KBT-F442 — the test-policy declaration, owned by prepare.
  assert.match(
    md, /KBT-F442/,
    'KBT-F442 (Regel E, test-policy) is not mentioned. This is the gate that was ' +
    'missed in the ADM-B248 run; the autopilot needs the pointer without copying ' +
    "prepare's §5B.6 table."
  );
  // KBT-TRUL004 — the worktree HARD-GATE, owned by execute.
  assert.match(
    md, /KBT-TRUL004/,
    'KBT-TRUL004 (worktree HARD-GATE) is not mentioned. The ADM-B248 run executed ' +
    'in the main checkout because nothing pointed at it.'
  );
});

test('KBT-TC3521: the autopilot does NOT call set_test_policy itself', () => {
  const md = read();
  assert.equal(
    md.includes('set_test_policy'), false,
    'kanbantic-bug-autopilot/SKILL.md references set_test_policy. The issue is ' +
    'explicit that this is the wrong repair: declaring the policy here creates a ' +
    'second source of truth that drifts as soon as kanbantic-issue-prepare ' +
    'tightens its criteria. Delegate to prepare instead (KBT-B494).'
  );
});

test('KBT-TC3521: each lane-skill is bound to a status in the routing table', () => {
  const md = read();
  // The delegation only works if the agent can tell WHICH skill to invoke from
  // the issue's current status. Naming the skills without that mapping would
  // leave the same improvisation gap one step further along.
  for (const [status, skill] of [
    ['New', 'kanbantic-issue-triage'],
    ['Triaged', 'kanbantic-issue-prepare'],
    ['Ready', 'kanbantic-issue-execute'],
    ['Review', 'kanbantic-issue-review'],
  ]) {
    const row = new RegExp(`\`${status}\`[^\\n]*${skill}`);
    assert.match(
      md, row,
      `No routing row maps status \`${status}\` to ${skill}. An agent resuming a ` +
      `part-finished bug needs to know which lane-skill picks it up.`
    );
  }
});
