#!/usr/bin/env node
'use strict';

//
// lint-skills — KBT-B192 / KBT-RL064 / KBT-TC1881
//
// Static lint over plugin/skills/kanbantic-issue-*/SKILL.md asserting the
// four mechanical invariants from KBT-RL064. This is the FORWARD direction
// of the drift-detection coverage that complements KBT-B200's
// `check-bundle-tool-drift.js` (which checks the REVERSE direction —
// MUST-HAVE tools registered live → bundle).
//
// Invariants:
//   1. F1   — `kanbantic-issue-execute` AND `kanbantic-issue-review` both
//             reference `update_validation_status` somewhere in their
//             SKILL.md. Catches the regression where the lifecycle hook
//             goes missing and linked user stories stay on `NotImplemented`
//             after Done (KBT-B192 critical defect).
//   2. C2   — `kanbantic-issue-review/SKILL.md` contains zero occurrences
//             of `/prepare-issue` or `/execute-issue` as slash-command
//             references. (`/triage-issue` is allowed because it IS a
//             registered command per the intake-skill frontmatter.)
//   3. (iii) — every `mcp__kanbantic__<name>` reference resolves to a name
//             in the canonical snapshot `known-mcp-tools.json`. Catches
//             references to tools that were renamed, removed, or never
//             shipped.
//   4. (iv) — `kanbantic-issue-review/SKILL.md` does NOT contain
//             `Review → Done` (with the exact unicode arrow). The review
//             skill's exit-transition is `Review → InDeployment`
//             per KBT-RL053.
//   5. (v)  — version-awareness invariant (KBT-RL147 / KBT-F320). After the
//             F10 release→version rename + the F12 known-mcp-tools sync, the
//             lane-skills must carry NO stale release-domain tokens:
//             `releaseId`, `release_id`, the capital-cased whole word
//             `Release`, or any of the four removed release-tools
//             (`create_release`, `list_releases`, `update_release`,
//             `get_release_notes`). A line may opt out of this check with an
//             explicit marker `lint-skills-allow-release` (e.g. a documented
//             reference to a GitHub Release in prose). Complements invariant
//             3: the prefixed `mcp__kanbantic__<version-tool>` refs restored
//             in F12 are validated against the synced snapshot there.
//
// Exit codes (mirror `check-bundle-tool-drift.js`):
//   0 — all invariants pass.
//   1 — invariant violation (drift detected).
//   2 — infrastructure failure (file unreadable, snapshot missing).
//
// Usage:
//   node plugin/scripts/lint-skills.js
//   SKILLS_DIR=/tmp/foo SNAPSHOT=/tmp/bar.json node plugin/scripts/lint-skills.js
//
// Zero deps — Node built-ins only.
//

const fs = require('node:fs');
const path = require('node:path');

// Resolve directories with env-var overrides so the test wrapper can run
// negative cases against tmp-dirs without touching the real tree.
const SKILLS_DIR = process.env.SKILLS_DIR
  || path.resolve(__dirname, '..', 'skills');
const SNAPSHOT = process.env.SNAPSHOT
  || path.resolve(__dirname, 'known-mcp-tools.json');

function fatal(code, msg) {
  process.stderr.write(`lint-skills: ${msg}\n`);
  process.exit(code);
}

function loadSnapshot() {
  let raw;
  try {
    raw = fs.readFileSync(SNAPSHOT, 'utf8');
  } catch (e) {
    fatal(2, `infrastructure: snapshot unreadable at ${SNAPSHOT}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fatal(2, `infrastructure: snapshot is not valid JSON: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.tools)) {
    fatal(2, 'infrastructure: snapshot has no `tools` array.');
  }
  return new Set(parsed.tools);
}

function loadSkill(skillName) {
  const file = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  try {
    return { name: skillName, file, content: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return { name: skillName, file, content: null, err: e.message };
  }
}

function fail(invariant, file, message) {
  process.stdout.write(
    `FAIL invariant ${invariant}: ${file}\n  ${message}\n`
  );
}

function main() {
  const knownTools = loadSnapshot();

  // The 4 lane-skills KBT-RL064 targets. Intake skills (request-feature,
  // report-bug, propose-epic, triage-issue) are out of scope.
  const lanes = ['kanbantic-issue-triage', 'kanbantic-issue-prepare',
                 'kanbantic-issue-execute', 'kanbantic-issue-review'];

  const skills = lanes.map(loadSkill);
  const missing = skills.filter(s => s.content === null);
  if (missing.length > 0) {
    // Not-found SKILL.md is infrastructure, not drift — exit 2.
    for (const m of missing) {
      process.stderr.write(
        `lint-skills: infrastructure: ${m.file} unreadable: ${m.err}\n`
      );
    }
    process.exit(2);
  }

  const byName = Object.fromEntries(skills.map(s => [s.name, s]));
  let violations = 0;

  // -------- Invariant 1: F1 (update_validation_status presence) ----------
  // Both execute and review must reference the tool. Strict guard: the
  // exact MCP-tool name as it would be invoked.
  const F1_TOKEN = 'update_validation_status';
  for (const lane of ['kanbantic-issue-execute', 'kanbantic-issue-review']) {
    if (!byName[lane].content.includes(F1_TOKEN)) {
      fail(1, byName[lane].file,
        `Missing \`${F1_TOKEN}\` reference. KBT-RL064 requires every lane-skill ` +
        `that owns a user-story lifecycle promotion (Implemented in execute, ` +
        `Validated in review) to mention the tool at the canonical place.`);
      violations++;
    }
  }

  // -------- Invariant 2: C2 (no fake slash-commands in review) -----------
  // /triage-issue is a real command (intake-skill frontmatter), /prepare-issue
  // and /execute-issue are NOT — they must not appear in review SKILL.md.
  const reviewContent = byName['kanbantic-issue-review'].content;
  const fakeCommandRegex = /\/(prepare-issue|execute-issue)\b/g;
  const fakeHits = [...reviewContent.matchAll(fakeCommandRegex)];
  if (fakeHits.length > 0) {
    const hits = fakeHits.map(m => `/${m[1]}`).sort();
    const uniq = [...new Set(hits)].join(', ');
    fail(2, byName['kanbantic-issue-review'].file,
      `Non-existent slash-commands referenced: ${uniq}. ` +
      `Use \`kanbantic-issue-prepare\` / \`kanbantic-issue-execute\` ` +
      `(skill-name form) instead. Per KBT-B192 C2 / KBT-RL064 Invariant 2.`);
    violations++;
  }

  // -------- Invariant 3: MCP-tool refs resolve to live registry ----------
  // Match every `mcp__kanbantic__<snake_case>` reference across all 4
  // lane-skills and assert the tool-name is in the canonical snapshot.
  // Allow trailing identifier characters (lowercase + underscore + digits).
  const mcpRefRegex = /mcp__kanbantic__([a-z][a-z0-9_]*)/g;
  for (const skill of skills) {
    const found = new Set();
    let match;
    while ((match = mcpRefRegex.exec(skill.content)) !== null) {
      found.add(match[1]);
    }
    for (const name of found) {
      if (!knownTools.has(name)) {
        fail(3, skill.file,
          `Unknown MCP-tool reference \`mcp__kanbantic__${name}\` ` +
          `is not in known-mcp-tools.json. Either the tool was removed/renamed ` +
          `(fix the SKILL.md) or the snapshot is stale (regenerate snapshot ` +
          `per the JSON's \`regenerationCommand\` field).`);
        violations++;
      }
    }
  }

  // -------- Invariant 4: lane-state-machine wording in review -----------
  // The review-skill exits at InDeployment (KBT-RL053), not Done.
  // The exact arrow is `→` (U+2192).
  if (/Review\s+→\s+Done/.test(reviewContent)) {
    fail(4, byName['kanbantic-issue-review'].file,
      `Found stale "Review → Done" wording. The review-skill exits to ` +
      `InDeployment per KBT-RL053; the backend auto-promotes to Done on ` +
      `deploy-gate clear (KBT-F236). Use "Review → InDeployment".`);
    violations++;
  }

  // -------- Invariant 5: version-awareness (no stale release refs) -------
  // KBT-RL147 / KBT-F320. The release concept was renamed to version in F10
  // and the four release-tools were removed from the snapshot in F12. No
  // lane-skill may reference the old release-domain tokens any more. A line
  // carrying the `lint-skills-allow-release` marker is exempt (documented
  // legitimate mention, e.g. a GitHub Release in prose).
  const RELEASE_PATTERNS = [
    { re: /releaseId/, label: '`releaseId`' },
    { re: /release_id/, label: '`release_id`' },
    { re: /\bRelease\b/, label: 'capital-cased `Release`' },
    { re: /\b(?:create_release|list_releases|update_release|get_release_notes)\b/,
      label: 'a removed release-tool (create_release/list_releases/update_release/get_release_notes)' },
  ];
  const ALLOW_MARKER = 'lint-skills-allow-release';
  for (const skill of skills) {
    const lines = skill.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(ALLOW_MARKER)) continue; // explicit opt-out
      for (const { re, label } of RELEASE_PATTERNS) {
        if (re.test(line)) {
          fail(5, skill.file,
            `Line ${i + 1} carries stale release-domain token (${label}): ` +
            `"${line.trim().slice(0, 100)}". The release concept was renamed ` +
            `to version (KBT-F318/F10) and the release-tools were removed from ` +
            `the snapshot (KBT-F320/F12). Use the version-flow tools instead, ` +
            `or add the \`${ALLOW_MARKER}\` marker on the line for a documented ` +
            `legitimate mention. Per KBT-RL147 Invariant 5.`);
          violations++;
        }
      }
    }
  }

  if (violations === 0) {
    process.stdout.write('OK: all SKILL.md invariants pass\n');
    process.exit(0);
  }
  process.stdout.write(`\n${violations} violation(s) detected.\n`);
  process.exit(1);
}

main();
