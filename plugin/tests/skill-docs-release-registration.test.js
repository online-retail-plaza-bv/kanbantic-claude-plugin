'use strict';

//
// skill-docs-release-registration.test.js — KBT-B545 / KBT-TC3422
//
// Static regression guard: `kanbantic-issue-review` must keep a release-registration
// step that closes the loop between "the repo shipped a version" and "Kanbantic knows
// about it".
//
// KBT-B545: the plugin repo cut a release per merged issue, while Kanbantic only got a
// new Version when the claim-gate demanded a bucket for new work. Nineteen shipped
// minors were never recorded, so `preview_next_version` — which reckons from the highest
// *registered* Version — kept proposing numbers that had been out for weeks. The fix is
// a step in the review-lane; this guard is what stops that step from quietly eroding
// away in a later edit, which is exactly how the gap opened in the first place.
//
// The API-side monotonicity clamp (VersionAppService, same issue) stops a bad *number*
// from being handed out. It cannot stop the registry from falling behind the repo —
// nothing server-side can. Only this step can, which is why it is worth pinning.
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REVIEW_SKILL = path.join(
  REPO_ROOT, 'plugin', 'skills', 'kanbantic-issue-review', 'SKILL.md');

const content = fs.readFileSync(REVIEW_SKILL, 'utf8');

const HEADING = '## Step 8.5: Versie-registratie';

/**
 * Returns the Step 8.5 section only — from its heading to the next `## ` heading.
 *
 * Scoping matters: an assertion against the whole 800-line SKILL.md passes on a
 * mention anywhere in the file, so a rewrite that keeps the heading but moves the
 * tool calls elsewhere would slip through the guard while gutting the step.
 * Slicing from `indexOf` alone is no better — on a renamed heading it returns -1
 * and `slice(-1)` yields the file's last character, failing for a reason that
 * misdescribes the cause.
 */
function section() {
  const start = content.indexOf(HEADING);
  assert.notEqual(
    start, -1,
    `kanbantic-issue-review/SKILL.md must keep the "${HEADING}" section — the step `
      + 'that records a shipped version in Kanbantic (KBT-B545).');
  const rest = content.slice(start + HEADING.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

test('kanbantic-issue-review carries a release-registration step', () => {
  assert.ok(section().trim().length > 0, `${HEADING} must not be an empty section`);
});

test('the release-registration step names the tools that actually record a release', () => {
  // Without these two calls the step is a reminder, not a procedure: a Planned Version
  // that is never frozen and never marked Released leaves the registry looking like
  // nothing ever shipped.
  const body = section();
  for (const tool of ['freeze_version', 'mark_version_released']) {
    assert.ok(
      body.includes(tool),
      `the ${HEADING} section must call ${tool}; recording a release is the whole `
        + `point of KBT-B545. A mention elsewhere in the file does not count.`
    );
  }
});

test('the release-registration step triggers on a changed version, not a touched file', () => {
  // The trigger has to be observable from the diff, and it has to be the *value*:
  // an edit to a carrier file that leaves `version` alone is not a release, and
  // firing a HARD-GATE on every such PR trains agents to wave it through.
  const body = section();
  assert.ok(
    body.includes('plugin/.claude-plugin/plugin.json'),
    'the step must name the plugin version carrier explicitly.'
  );
  assert.ok(
    body.includes('detect-release-bump.js'),
    'the step must delegate the trigger to detect-release-bump.js. An inline snippet '
      + 'is not executed by anything, which is how the first attempt shipped a '
      + 'comparison against git merge-base that can never fire after Step 7 has '
      + 'already merged and checked out main.'
  );
  // Only the runnable blocks are checked. The prose explains at length why merge-base is
  // the wrong comparison, and that explanation is the thing keeping a later editor from
  // reintroducing it — so mentioning it must stay allowed while running it must not.
  const fenced = body.match(/```[\s\S]*?```/g) || [];
  assert.ok(
    fenced.some((block) => block.includes('detect-release-bump.js')),
    'a runnable block in the step must actually invoke detect-release-bump.js — naming '
      + 'the script in prose while the block does something else is how the first '
      + 'attempt shipped an inert trigger.'
  );
  // A block that names merge-base or origin/main *without* going through the detector is
  // comparing by hand — and after Step 7 both resolve to HEAD, so it would report "no
  // release" on every real release. Passing origin/main to the detector as the ref to
  // inspect is the opposite: that is the worktree-safe invocation.
  // Per line, not per block: a block that invokes the detector *and* hand-rolls a
  // comparison alongside it would slip through a block-level exclusion.
  const handRolled = fenced
    .join('\n')
    .split('\n')
    .filter((line) => !line.includes('detect-release-bump.js'));
  for (const inert of ['merge-base', 'origin/main']) {
    assert.ok(
      !handRolled.some((line) => line.includes(inert)),
      `no runnable block in the step may compare against ${inert} by hand: Step 8.5 runs `
        + `after Step 7 checked out main, so both resolve to HEAD and the trigger would `
        + `report "no release" on every real release. Go through detect-release-bump.js.`
    );
  }
  assert.ok(
    body.includes('first parent'),
    'the step must say why the comparison is against the first parent, so a later '
      + 'edit does not "simplify" it back into an inert form.'
  );
});

test('the step states that the version carrier is repo-specific', () => {
  // kanbantic-issue-review runs for every repo in the workspace. The monorepo's
  // carrier is its git-tag stream, not a JSON file; without saying so, the gate is
  // a silent no-op everywhere except one repo.
  const body = section();
  assert.ok(
    body.includes('repo-specific') || body.includes('Version carrier'),
    'the step must make clear which repository each version carrier belongs to.'
  );
});

test('the step warns against trusting preview_next_version over the repo', () => {
  const body = section();
  assert.ok(
    body.includes('preview_next_version') && body.includes('baselineNumber'),
    "the step must tell the agent to check preview_next_version's baselineNumber "
      + "against the repo's own version — following the proposal blind is what "
      + 'produced the v2.16.0 collision in KBT-B545.'
  );
});

//
// KBT-B586 — the step must be reachable by more than the merge it performs itself.
//
// KBT-B545 put the registration behind Step 7's merge. That merge is one route
// among several, and in this workspace it is the route that is deliberately NOT
// taken: KBT-TRUL030 has a subagent deliver up to `Review` and a supervising agent
// merge after checking. On 2026-08-10 all eight merged PRs went that way, so the
// step covered none of them — including the release of v2.37.0, which shipped the
// step itself and was registered by hand.
//
// A guard that only fires on the route nobody uses is not a guard.
//

test('the registration is reachable by a route other than the skill\'s own merge', () => {
  const body = section();
  assert.ok(
    body.includes('detect-release-drift.js'),
    'the step must offer an entry that does not depend on Step 7 having merged. '
      + 'detect-release-bump.js answers an event-shaped question (HEAD vs its first '
      + 'parent) and refuses any ref that is not the tip of the default branch, so '
      + 'it is answerable only by whoever stands on the merge commit. The drift '
      + 'detector compares repo against registry and needs no event — see KBT-RL210.'
  );
  const fenced = (body.match(/```[\s\S]*?```/g) || []).join('\n');
  assert.ok(
    fenced.includes('detect-release-drift.js'),
    'a runnable block must actually invoke detect-release-drift.js. KBT-B545 shipped '
      + 'its first trigger as prose and it was inert for exactly that reason.'
  );
});

test('the registration declares itself idempotent', () => {
  // Two routes into one procedure means it will sometimes run twice on the same
  // release — the skill merges and registers, and the drift check later finds
  // nothing to do. That has to be stated as safe, or the second caller hesitates.
  const body = section();
  assert.ok(
    /idempotent/i.test(body),
    'the step must say that running it again on an already-registered release is a '
      + 'no-op, because it now has more than one caller.'
  );
});

test('the step says what the route-independent entry does NOT cover', () => {
  // Detecting drift catches every missed route but reports after the fact. Silence
  // about that limit is how a partial guard gets mistaken for a complete one —
  // which is the mistake KBT-B545 made about its own coverage.
  const body = section();
  assert.ok(
    body.includes('KBT-BD208'),
    "the step must point at the Boundary spec recording the route's limits "
      + '(reports after the fact, needs a session, no CI coverage, carrier-resolvable '
      + 'repos only, no historical backfill).'
  );
});
