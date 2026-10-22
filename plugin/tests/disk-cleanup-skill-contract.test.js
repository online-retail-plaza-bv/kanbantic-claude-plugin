'use strict';

//
// disk-cleanup-skill-contract.test.js — KBT-F754 / KBT-TC4232
//
// SKILL.md is the document an agent actually follows. For a skill whose job is
// deleting things, the prose IS the safety mechanism: the hard limits, the
// measure-first order and the fallback step have to stay in the text, and the
// text has to keep pointing at the scripts that exist. This pins those.
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(PLUGIN_ROOT, 'skills', 'kanbantic-disk-cleanup', 'SKILL.md');
const COMMAND = path.join(PLUGIN_ROOT, 'commands', 'kanbantic-disk-cleanup.md');
const README = path.join(PLUGIN_ROOT, 'README.md');
const { POLICY_ITEM_TITLE } = require(path.join(PLUGIN_ROOT, 'scripts', 'disk-cleanup-policy.js'));

const skill = fs.readFileSync(SKILL, 'utf8');
const command = fs.readFileSync(COMMAND, 'utf8');

test('the skill and its slash-command exist with frontmatter', () => {
  assert.match(skill, /^---\nname: kanbantic-disk-cleanup\ndescription: "/);
  assert.match(command, /^---\ndescription: "/);
  assert.match(command, /argument-hint: \[--dry-run\] \[--full\]/);
  assert.ok(command.includes('$ARGUMENTS'));
});

test('the skill points at scripts that exist', () => {
  for (const rel of ['scripts/disk-space.js', 'scripts/disk-cleanup-policy.js', 'hooks/session-start-disk-space.js']) {
    assert.ok(skill.includes(rel), `SKILL.md must name ${rel}`);
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, rel)), `${rel} must exist`);
  }
});

test('the skill searches for the same Toolkit item title the parser exports', () => {
  assert.ok(skill.includes(`\`${POLICY_ITEM_TITLE}\``));
  assert.ok(skill.includes(`search: "${POLICY_ITEM_TITLE}"`),
    'the list_toolkit_items call must search for the fixed title');
});

test('measure comes first and the report is about measured, not budgeted, gains', () => {
  const measure = skill.indexOf('## Step 0: Measure');
  const firstDelete = skill.indexOf('worktree remove --force');
  assert.ok(measure > 0 && firstDelete > measure, 'Step 0 must measure before anything is removed');
  assert.match(skill, /\*\*measured\*\* gain/);
  assert.ok(skill.includes('free space **before** and **after**'));
});

test('the hard limits are stated inside a HARD-GATE and name the forbidden commands', () => {
  const gate = skill.match(/<HARD-GATE>[\s\S]*?<\/HARD-GATE>/);
  assert.ok(gate, 'SKILL.md must carry a HARD-GATE block');
  for (const forbidden of [
    'docker system prune', 'docker container prune', 'docker volume prune', 'docker rm -f',
    'git branch -D', 'node_modules', 'Never elevate',
  ]) {
    assert.ok(gate[0].includes(forbidden), `HARD-GATE must name: ${forbidden}`);
  }
  assert.ok(gate[0].includes('Fail-not-skip'));
});

test('worktree removal records a fallback and detaches shared junctions first', () => {
  const step = skill.slice(skill.indexOf('## Step 3'), skill.indexOf('## Step 4'));
  assert.ok(step.includes('worktree-backup-'), 'a refs backup must be written before removal');
  assert.ok(step.indexOf('worktree-backup-') < step.indexOf('worktree remove --force'),
    'the backup must come before the removal');
  assert.ok(step.includes('Directory]::Delete'), 'the junction must be detached non-recursively first');
  assert.ok(step.includes('worktree prune'));
  assert.ok(step.includes('Veilig = ja'), 'only verified-safe rows are candidates');
});

test('Docker is build-cache only, behind an empty docker ps -a', () => {
  const step = skill.slice(skill.indexOf('## Step 6'), skill.indexOf('## Step 7'));
  assert.ok(step.includes('docker ps -a'));
  assert.ok(step.includes('docker buildx prune -af'));
  assert.ok(step.includes('Skip Docker completely'));
});

test('the elevated part is written for a human and explicitly never executed', () => {
  const step = skill.slice(skill.indexOf('## Step 7'), skill.indexOf('## Step 8'));
  assert.ok(step.includes('**Do not execute it.**'));
  assert.ok(step.includes('verbatim'), 'an elevated script named by the policy is taken verbatim, not regenerated');
  assert.ok(step.includes('.Attached'), 'the detach verification is the lesson that must not be lost');
});

test('delegation to a workspace maintenance subagent is described', () => {
  const step = skill.slice(skill.indexOf('## Step 2'), skill.indexOf('## Step 3'));
  assert.ok(step.includes('.claude/agents/maintenance-agent.md'));
  assert.ok(step.includes('delegate-to'));
});

test('the dry-run mode and the hook variables are documented', () => {
  assert.ok(skill.includes('--dry-run'));
  for (const v of ['KANBANTIC_DISK_WARN_GB', 'KANBANTIC_DISK_CRITICAL_GB', 'KANBANTIC_SKIP_DISK_CHECK']) {
    assert.ok(skill.includes(v), `SKILL.md must document ${v}`);
  }
});

test('the README introduces the skill and the hook', () => {
  const readme = fs.readFileSync(README, 'utf8');
  assert.ok(readme.includes('/kanbantic-disk-cleanup'));
  assert.ok(readme.includes('session-start-disk-space.js'));
  assert.ok(readme.includes(POLICY_ITEM_TITLE));
});

test('lint-skills still passes with the new skill in the tree', () => {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'lint-skills.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
