'use strict';

//
// release-bump-skill-contract.test.js — KBT-B585 / KBT-TC3496
//
// End-to-end for the contract between `kanbantic-issue-review` Step 8.5a and
// `detect-release-bump.js`.
//
// The command an agent runs is not written in this test. It is extracted from
// `plugin/skills/kanbantic-issue-review/SKILL.md` — the artifact Claude Code loads at
// session start — with `${CLAUDE_PLUGIN_ROOT}` expanded the way the runtime expands it, then
// spawned as a child process. That is the third E2E condition (ADM-TRUL015): the assertion is
// "a fresh instance of the runtime loads the artifact and uses it", not "the file looks right".
//
// Why this tier is worth having for KBT-B585 specifically. Both fixes here change what the
// CALLER sees: a refusal (non-zero exit, empty stdout, reason on stderr) and an inconclusive
// answer (exit 0, a flag in the JSON, a line on stderr). Neither is visible to an in-process
// unit test of `detectReleaseBump`, because both live in the CLI boundary the skill actually
// talks to. A test that never crosses that boundary cannot tell whether the skill's own
// documented invocation still produces a usable answer.
//
// Zero deps — only node built-ins.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const pluginRoot = path.join(repoRoot, 'plugin');
const reviewSkill = path.join(pluginRoot, 'skills', 'kanbantic-issue-review', 'SKILL.md');

const CARRIER = ['plugin', '.claude-plugin', 'plugin.json'];

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function writeVersion(root, version) {
  const dir = path.join(root, ...CARRIER.slice(0, -1));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, ...CARRIER),
    JSON.stringify({ name: 'kanbantic', version }, null, 2));
}

function newRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b585-contract-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * Every runnable invocation of detect-release-bump.js that Step 8.5a documents, taken from
 * the skill's own fenced blocks with ${CLAUDE_PLUGIN_ROOT} / $CLAUDE_PLUGIN_ROOT expanded.
 */
function documentedInvocations() {
  const content = fs.readFileSync(reviewSkill, 'utf8');
  return (content.match(/```[\s\S]*?```/g) || [])
    .join('\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('node ') && l.includes('detect-release-bump.js'))
    .map((l) => l
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
      .replace(/\$CLAUDE_PLUGIN_ROOT/g, pluginRoot));
}

/** Split `node "path" arg` into argv the way a shell would, honouring quotes. */
function toArgv(command) {
  return (command.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
}

/**
 * Run a documented invocation against `repo`.
 *
 * The skill's blocks pass `.` as the repo root (they run from the repo), so the trailing
 * `.` is replaced with the fixture path rather than the command being rewritten.
 */
function runDocumented(command, repo) {
  const argv = toArgv(command).map((a) => (a === '.' ? repo : a));
  return spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', cwd: repo });
}

test('Step 8.5a documents at least one runnable detect-release-bump invocation', () => {
  const found = documentedInvocations();
  assert.ok(found.length > 0,
    'the review skill must document a runnable invocation of detect-release-bump.js — '
      + 'without one there is no contract to honour, and KBT-B545 shipped exactly that: a '
      + 'trigger that existed only as prose.');
  for (const cmd of found) {
    const target = toArgv(cmd).find((a) => a.endsWith('.js'));
    assert.ok(fs.existsSync(target),
      `the documented invocation points at a missing file: ${target}`);
  }
});

test('every documented invocation refuses a diverged default branch, through the CLI', () => {
  // Point 1, end to end. What the skill's caller sees on a diverged main must be a refusal:
  // non-zero exit, nothing parseable on stdout, and the reason on stderr.
  const root = newRepo();
  try {
    writeVersion(root, '2.33.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'upstream');
    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'upstream ships 2.36.0');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'checkout', '-q', 'main');
    writeVersion(root, '2.35.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'local divergent release');

    const invocations = documentedInvocations();
    assert.ok(invocations.length > 0);
    for (const cmd of invocations) {
      const r = runDocumented(cmd, root);
      assert.notEqual(r.status, 0, `documented invocation answered a diverged repo: ${cmd}`);
      assert.equal(r.stdout.trim(), '',
        'stdout must stay empty so a caller parsing JSON has nothing to misread');
      assert.match(r.stderr, /\[release-bump\]/);
      assert.match(r.stderr, /diverged/);
      assert.doesNotMatch(r.stdout, /2\.35\.0/,
        'no version number may escape from a line the detector cannot speak for');
    }
  } finally {
    cleanup(root);
  }
});

test('a fast-forward past the bump reaches the caller as inconclusive, not as clean', () => {
  // Point 2, end to end. The JSON flag serves a programmatic caller; the stderr line serves
  // the agent reading a transcript, who is who this defect actually fooled.
  const root = newRepo();
  try {
    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    writeVersion(root, '2.37.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'bump');
    fs.writeFileSync(path.join(root, 'after.txt'), 'after\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'docs after the bump');
    git(root, 'checkout', '-q', 'main');
    git(root, 'merge', '--ff-only', '-q', 'feature');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    for (const cmd of documentedInvocations()) {
      const r = runDocumented(cmd, root);
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout.trim());
      assert.equal(out.released, false);
      assert.equal(out.conclusive, false,
        'the caller must be able to see that this "no release" came from a one-commit window');
      assert.match(r.stderr, /inconclusive/);
    }
  } finally {
    cleanup(root);
  }
});

test('the prescribed --no-ff path still yields a clean, settled answer', () => {
  // The counterweight: the route Step 7 actually prescribes must be untouched, and must not
  // acquire a caveat. A guard that hedges on the happy path teaches its readers to skim.
  const root = newRepo();
  try {
    writeVersion(root, '2.36.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    writeVersion(root, '2.37.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'bump');
    git(root, 'checkout', '-q', 'main');
    git(root, 'merge', '--no-ff', '-q', 'feature', '-m', 'Merge feature');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    for (const cmd of documentedInvocations()) {
      const r = runDocumented(cmd, root);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout.trim());
      assert.equal(out.released, true);
      assert.equal(out.old, '2.36.0');
      assert.equal(out.new, '2.37.0');
      assert.equal(out.conclusive, undefined, 'the prescribed path carries no caveat');
      assert.doesNotMatch(r.stderr, /inconclusive/);
    }
  } finally {
    cleanup(root);
  }
});
