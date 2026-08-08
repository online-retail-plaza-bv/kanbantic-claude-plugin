'use strict';

//
// prepare-test-policy-record.test.js — KBT-B551 / KBT-TC3430 + KBT-TC3431 + KBT-TC3432
//
// The bug: `kanbantic-issue-prepare` steps 5F.5 / 5B.6 prescribed only
// `add_discussion_entry(entryType: "Decision")` for the per-level test-policy.
// The Done-gates read the *policy record*, which is written exclusively by
// `set_test_policy` — a tool that appeared **zero times** in that SKILL.md
// (verified on origin/main@4cad334; the only three hits in the whole plugin were
// reference/using-kanbantic.md, scripts/check-bundle-tool-drift.js and
// skills/kanbantic-issue-review/SKILL.md).
//
// A declared `N.v.t.` level therefore had no effect at all — silently — until
// `claim_issue` had already frozen the defaults (all three Required, min 1) and
// only an `overrideReason` could still change them. Hit KBT-B531 and KBT-B532
// on the same day.
//
// Two layers, matching the frozen test-policy (KBT-F442 / Regel E):
//
//   - Unit (TC3430, TC3431): structural assertions over the on-disk SKILL.md.
//     Pure fs reads, no network, no mutation.
//   - Integration (TC3432): the shipped guard `lint-skills.js` spawned as a
//     fresh child process — positive over the real tree, plus a negative
//     control over a tmp copy carrying an unresolvable tool name, so a green
//     run proves the guard *can* fail rather than merely that it ran.
//
// E2E (real-proxy round-trip of the prescribed call-shape) lives in
// prepare-test-policy-proxy-e2e.test.js — KBT-TC3433.
//
// Deliberately NOT asserted anywhere here: "the Decision-entry exists". That is
// precisely the check that stayed green for the entire lifetime of the bug.
//
// Zero deps — node:test + node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'plugin', 'skills');
const LINT_SCRIPT = path.join(REPO_ROOT, 'plugin', 'scripts', 'lint-skills.js');
const SNAPSHOT = path.join(REPO_ROOT, 'plugin', 'scripts', 'known-mcp-tools.json');

function readPrepare() {
  return fs.readFileSync(path.join(SKILLS_ROOT, 'kanbantic-issue-prepare', 'SKILL.md'), 'utf8');
}

// Both type-routes declare the policy and both were broken the same way.
const POLICY_SECTIONS = [
  ['5F.5', /### 5F\.5:[\s\S]*?(?=### 5F\.\d|## Step 5B|## Step 6)/, 'Feature route'],
  ['5B.6', /### 5B\.6:[\s\S]*?(?=### 5B\.\d|## Step 5W|## Step 6)/, 'Bug route'],
];

function section(label, re) {
  const m = readPrepare().match(re);
  assert.ok(m, `${label} section not found in prepare SKILL.md`);
  return m[0];
}

// ─── KBT-TC3430 — the record is written, before the freeze ────────────────────

for (const [label, re, route] of POLICY_SECTIONS) {
  test(`KBT-TC3430: prepare ${label} (${route}) prescribes set_test_policy, not only a Decision-entry`, () => {
    const s = section(label, re);

    assert.ok(
      s.includes('mcp__kanbantic__set_test_policy'),
      `${label} must prescribe an affirmative set_test_policy call — a Decision-entry never reaches the policy record the Done-gates read`
    );

    // All three levels named explicitly, so none can silently keep its default.
    for (const level of ['Unit', 'Integration', 'E2E']) {
      assert.ok(
        new RegExp(`set_test_policy[\\s\\S]{0,400}?level:\\s*"${level}"`).test(s),
        `${label} must show a set_test_policy call for level ${level}`
      );
    }

    assert.ok(s.includes('applicability'), `${label} must pass the applicability parameter`);
    assert.ok(
      s.includes('notApplicableReason'),
      `${label} must document notApplicableReason — without it the NotApplicable route is unusable`
    );
  });

  test(`KBT-TC3430: prepare ${label} places the record-write BEFORE the Ready-transition`, () => {
    const s = section(label, re);

    // Ordering is the whole point of the fix: after claim_issue the record is
    // frozen and lowering it requires a reviewer-akkoord.
    assert.ok(
      /vóór de Ready-transitie|voor de Ready-transitie/.test(s),
      `${label} must state that set_test_policy runs before the Ready-transition (i.e. before the claim_issue freeze)`
    );
    assert.ok(
      s.includes('<HARD-GATE>'),
      `${label} must guard the record-write with a HARD-GATE — a soft "consider this" is what let KBT-B531/B532 through`
    );
  });

  test(`KBT-TC3430: prepare ${label} keeps the Decision-entry and cross-references the record`, () => {
    const s = section(label, re);

    // The fix augments, it does not replace: the entry explains *why*, which a
    // policy record cannot express (richting-punt 2 of the issue).
    assert.ok(
      s.includes('## Test-policy (bevroren bij claim_issue'),
      `${label} must retain the canonical Decision-entry header`
    );
    assert.ok(
      s.includes('mcp__kanbantic__add_discussion_entry'),
      `${label} must retain the Decision-entry call`
    );
    assert.ok(
      /Gezet in het beleidsrecord via .?set_test_policy/.test(s),
      `${label}'s Decision-entry template must point at the policy record, so entry and record are findable from each other`
    );
  });
}

test('KBT-TC3430: the allowed-writes HARD-GATE permits set_test_policy', () => {
  const allowed = readPrepare().match(/Allowed MCP writes are:[^\n]*/);
  assert.ok(allowed, 'Allowed-writes line not found in prepare SKILL.md');
  assert.ok(
    allowed[0].includes('set_test_policy'),
    'allowed-writes must permit set_test_policy — otherwise 5F.5/5B.6 prescribe a call the HARD-GATE forbids and the fix contradicts itself'
  );
});

test('KBT-TC3430 (regression witness): set_test_policy is referenced in both routes plus the allowlist', () => {
  // The single assertion that would have gone red on origin/main@4cad334,
  // where this count was exactly 0.
  const occurrences = (readPrepare().match(/set_test_policy/g) || []).length;
  assert.ok(
    occurrences >= 4,
    `prepare must reference set_test_policy in 5F.5, 5B.6 and the allowlist — found ${occurrences}. Before the fix this was 0, while review/SKILL.md and reference/using-kanbantic.md already knew the tool.`
  );
});

// ─── KBT-TC3431 — Step 6.1 divergence gate ────────────────────────────────────

test('KBT-TC3431: Step 6.1 verifies the policy record against the declaration', () => {
  const content = readPrepare();

  assert.ok(content.includes('### 6.1:'), 'Step 6.1 (test-policy record verification) must exist');
  const m = content.match(/### 6\.1:[\s\S]*?(?=### 6a:)/);
  assert.ok(m, '6.1 section not found — it must sit before 6a');
  const s = m[0];

  assert.ok(
    s.includes('mcp__kanbantic__get_test_policy'),
    'Step 6.1 must read the record back with get_test_policy'
  );
  assert.ok(
    s.includes('<HARD-GATE>'),
    'Step 6.1 divergence must be a hard readiness-shortcoming, not a warning — the failure mode being covered is silence'
  );
  for (const field of ['applicability', 'minCount', 'notApplicableReason', 'isFrozen']) {
    assert.ok(s.includes(field), `Step 6.1 must compare the ${field} field`);
  }
});

test('KBT-TC3431: the 6.1 verification precedes the 6a Ready-transition in file order', () => {
  const content = readPrepare();

  const verifyAt = content.indexOf('### 6.1:');
  const transitionAt = content.indexOf('### 6a:');
  const statusCallAt = content.indexOf('update_issue_status(issueId, status: "Ready")');

  assert.ok(verifyAt > 0, 'Step 6.1 not found');
  assert.ok(transitionAt > 0, 'Step 6a not found');
  assert.ok(statusCallAt > 0, 'Ready-transition call not found');
  assert.ok(
    verifyAt < transitionAt && verifyAt < statusCallAt,
    `verification (idx ${verifyAt}) must come before the Ready-transition (6a at ${transitionAt}, call at ${statusCallAt}) — after claim_issue the record is frozen`
  );
});

test('KBT-TC3431: the readiness checklist and 6a report surface the policy-record check', () => {
  const content = readPrepare();

  assert.ok(
    /Validate readiness[^\n]*test-policy-record|test-policy-record[^\n]*Step 6\.1/.test(content),
    'the top-level checklist item 5 must mention the test-policy record verification'
  );
  assert.ok(
    content.includes('Test-policy record: ✓'),
    'the 6a success report must include the test-policy record line, so an operator sees it was checked'
  );
});

// ─── KBT-TC3432 (integration) — the new tool reference resolves ───────────────

test('KBT-TC3432 (integration): known-mcp-tools.json carries set_test_policy and get_test_policy', () => {
  const raw = fs.readFileSync(SNAPSHOT, 'utf8');
  assert.ok(raw.includes('"set_test_policy"'), 'known-mcp-tools.json must contain set_test_policy');
  assert.ok(raw.includes('"get_test_policy"'), 'known-mcp-tools.json must contain get_test_policy');
});

test('KBT-TC3432 (integration): lint-skills.js exits 0 on the modified skill tree', () => {
  const r = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8' });
  assert.equal(
    r.status, 0,
    `lint-skills.js must exit 0 on the modified tree — got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`
  );
});

test('KBT-TC3432 (integration, negative control): an unresolvable tool reference makes lint-skills exit 1', () => {
  // Without this the positive run above only proves the script executed.
  // Invariant 3 of lint-skills resolves every mcp__kanbantic__<name> against
  // the snapshot; swapping in a name that is not there must go red.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt551-lint-'));
  try {
    for (const lane of fs.readdirSync(SKILLS_ROOT)) {
      const src = path.join(SKILLS_ROOT, lane, 'SKILL.md');
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.join(tmp, lane), { recursive: true });
      let body = fs.readFileSync(src, 'utf8');
      if (lane === 'kanbantic-issue-prepare') {
        body = body.replace(/mcp__kanbantic__set_test_policy/g, 'mcp__kanbantic__set_test_policy_bogus');
      }
      fs.writeFileSync(path.join(tmp, lane, 'SKILL.md'), body);
    }

    const bad = spawnSync(process.execPath, [LINT_SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, SKILLS_DIR: tmp, SNAPSHOT },
    });
    assert.equal(
      bad.status, 1,
      `lint-skills.js must exit 1 for an unresolvable tool reference — got ${bad.status}\nSTDOUT: ${bad.stdout}\nSTDERR: ${bad.stderr}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
