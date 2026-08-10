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

test('kanbantic-issue-review carries a release-registration step', () => {
  assert.match(
    content,
    /##\s*Step\s*8\.5:\s*Versie-registratie/,
    'kanbantic-issue-review/SKILL.md must keep the "Step 8.5: Versie-registratie" '
      + 'section — the step that records a shipped version in Kanbantic (KBT-B545).'
  );
});

test('the release-registration step names the tools that actually record a release', () => {
  // Without these two calls the step is a reminder, not a procedure: a Planned Version
  // that is never frozen and never marked Released leaves the registry looking like
  // nothing ever shipped.
  for (const tool of ['freeze_version', 'mark_version_released']) {
    assert.ok(
      content.includes(tool),
      `kanbantic-issue-review/SKILL.md must call ${tool} in the release-registration `
        + `step; recording a release is the whole point of KBT-B545.`
    );
  }
});

test('the release-registration step is triggered by the version files, not by memory', () => {
  // The trigger has to be observable from the diff. "Remember to register the release"
  // is precisely the instruction that failed for nineteen consecutive releases.
  const section = content.slice(content.indexOf('## Step 8.5: Versie-registratie'));
  assert.ok(
    section.includes('plugin/.claude-plugin/plugin.json')
      && section.includes('.claude-plugin/marketplace.json'),
    'the release-registration step must key off the repo version files '
      + '(plugin.json + marketplace.json) so the trigger is visible in the diff.'
  );
});

test('the step warns against trusting preview_next_version over the repo', () => {
  const section = content.slice(content.indexOf('## Step 8.5: Versie-registratie'));
  assert.ok(
    section.includes('preview_next_version') && section.includes('baselineNumber'),
    'the release-registration step must tell the agent to check '
      + "preview_next_version's baselineNumber against the repo's own version — "
      + 'following the proposal blind is what produced the v2.16.0 collision in KBT-B545.'
  );
});
