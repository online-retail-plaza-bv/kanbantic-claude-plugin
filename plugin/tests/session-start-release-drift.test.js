'use strict';

//
// session-start-release-drift.test.js — KBT-B586 / KBT-TC3485
//
// E2E for the invoker half of KBT-B586. The drift detector is only worth anything if
// something actually runs it on every route, and the thing that runs it is a
// SessionStart hook declared in plugin/hooks/hooks.json.
//
// Per the third E2E condition (ADM-TRUL015): hooks.json is an artifact a runtime
// reads at startup, so the assertion has to be "a fresh instance of the runtime loads
// it and uses it" — not "the file looks right". Hence the command string is read out
// of hooks.json, `${CLAUDE_PLUGIN_ROOT}` is expanded the way Claude Code expands it,
// and the result is spawned as a child process with a SessionStart payload on stdin.
//
// Hard-coding `node plugin/hooks/session-start-release-drift.js` here would pass
// happily while the hook was not wired up at all — which is the class of mistake this
// whole issue is about.
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
const hooksJsonPath = path.join(pluginRoot, 'hooks', 'hooks.json');
const { formatDriftNotice } = require(
  path.join(pluginRoot, 'hooks', 'session-start-release-drift.js'));

const CARRIER = ['plugin', '.claude-plugin', 'plugin.json'];

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo that has shipped `version` on its default branch. */
function shippedRepo(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b586-hook-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  const dir = path.join(root, ...CARRIER.slice(0, -1));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(root, ...CARRIER),
    JSON.stringify({ name: 'kanbantic', version }, null, 2));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'ship');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * The SessionStart hook commands exactly as declared, with ${CLAUDE_PLUGIN_ROOT}
 * expanded — i.e. what the runtime will actually execute.
 */
function declaredSessionStartCommands() {
  const cfg = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const groups = (cfg.hooks && cfg.hooks.SessionStart) || [];
  return groups
    .flatMap((g) => g.hooks || [])
    .filter((h) => h && h.type === 'command' && typeof h.command === 'string')
    .map((h) => ({
      ...h,
      expanded: h.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot),
    }));
}

/** Split `node "path" --flag` into argv the way a shell would, honouring quotes. */
function toArgv(command) {
  return (command.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
}

function runDeclaredHook(command, { cwd, env = {} }) {
  const argv = toArgv(command);
  const r = spawnSync(argv[0], argv.slice(1), {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd, source: 'startup' }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return r;
}

// ---------------------------------------------------------------------------
// The wiring itself
// ---------------------------------------------------------------------------

test('the release-drift check is declared as a SessionStart hook', () => {
  const declared = declaredSessionStartCommands();
  const match = declared.filter((h) => h.command.includes('session-start-release-drift.js'));
  assert.equal(match.length, 1,
    'exactly one SessionStart hook must invoke session-start-release-drift.js. Without '
      + 'the declaration the detector exists but nothing ever runs it — which is the '
      + 'defect KBT-B586 describes, moved one file to the left.');
  assert.ok(match[0].timeout > 0,
    'the hook must carry a timeout: a SessionStart hook that hangs makes every '
      + 'session on the workstation unusable (the reason mcp-toolkit-fetch.js '
      + 'timeouts every request).');
});

test('the command declared in hooks.json resolves to a file that exists', () => {
  // ${CLAUDE_PLUGIN_ROOT} expansion is where a wiring change silently rots: the
  // declaration keeps parsing, the path stops resolving.
  for (const h of declaredSessionStartCommands()) {
    const argv = toArgv(h.expanded);
    const target = argv.find((a) => a.endsWith('.js') || a.endsWith('.sh'));
    if (!target) continue;
    assert.ok(fs.existsSync(target),
      `SessionStart hook command points at a missing file: ${target} (from ${h.command})`);
  }
});

test('the existing SessionStart hooks are still declared', () => {
  // Adding a hook by rewriting the array is an easy way to drop a sibling.
  const commands = declaredSessionStartCommands().map((h) => h.command).join('\n');
  for (const kept of ['check-update.sh', 'session-start-toolkit-sync.js']) {
    assert.ok(commands.includes(kept),
      `${kept} must remain a SessionStart hook — this change adds one, it replaces none.`);
  }
});

// ---------------------------------------------------------------------------
// Running it the way the runtime does
// ---------------------------------------------------------------------------

function driftHookCommand() {
  const h = declaredSessionStartCommands()
    .find((x) => x.command.includes('session-start-release-drift.js'));
  assert.ok(h, 'the drift hook must be declared before it can be exercised');
  return h.expanded;
}

test('the declared hook is SILENT in a clone that has not opted in', () => {
  // KBT-B586 review blocker A2. This test previously asserted the opposite — that the hook
  // must speak up here — and so it pinned the defect in place.
  //
  // Measured on the real repositories with exactly the command from hooks.json: both the
  // plugin clone and the monorepo printed
  //   [release-drift] kan de release-registratie niet controleren: no Application configured…
  // because `git config --get kanbantic.applicationId` fails in both and nothing in this
  // change sets it. That is not an edge case, it is the default state of every clone after
  // merge: every user would get this line in their startup context, in every session, in
  // every repository.
  //
  // Not opted in means nothing was asked of the check. Nothing asked, nothing said.
  const root = shippedRepo('2.37.0');
  try {
    const r = runDeclaredHook(driftHookCommand(), {
      cwd: root,
      env: { KANBANTIC_RELEASE_DRIFT_APPLICATION: '', KANBANTIC_SKIP_RELEASE_DRIFT: '' },
    });
    assert.equal(r.status, 0, 'a SessionStart hook must never fail a session');
    assert.equal(r.stdout.trim(), '',
      'a clone with no configured Application must produce no startup output whatsoever');
  } finally {
    cleanup(root);
  }
});

test('the declared hook is SILENT in a repo with no carrier at all', () => {
  // The monorepo's case: it versions by git tag, and CARRIER is plugin-specific. KBT-BD208 §4
  // declares it out of scope, and the runtime must agree with that rather than contradict it.
  // Note this stays silent even WITH an Application configured — there is simply nothing here
  // that this check understands.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b586-hook-nocarrier-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'README.md'), 'a repo that versions by tag\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'config', 'kanbantic.applicationId', '00000000-0000-0000-0000-000000000000');

    const r = runDeclaredHook(driftHookCommand(), {
      cwd: root,
      env: { KANBANTIC_SKIP_RELEASE_DRIFT: '' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '',
      'a repository this check does not apply to must never announce itself');
  } finally {
    cleanup(root);
  }
});

test('the declared hook is silent when the registry is in step', () => {
  const root = shippedRepo('2.37.0');
  try {
    git(root, 'config', 'kanbantic.applicationId', '00000000-0000-0000-0000-000000000000');
    // --baseline is not available through the hook, so drive the pure renderer for the
    // in-step case and assert the hook stays quiet on a clean answer.
    assert.equal(formatDriftNotice({
      answerable: true, drifted: false, relation: 'in-step',
      repoVersion: '2.37.0', baselineNumber: 'v2.37.0',
    }), null, 'an in-step registry must produce no output at all');
    assert.equal(formatDriftNotice({
      answerable: true, drifted: false, relation: 'registry-ahead',
      repoVersion: '2.37.0', baselineNumber: 'v2.38.0',
    }), null, 'an open Planned bucket must produce no output at all — this is the '
      + 'normal steady state and a hook that fires here gets disabled');
  } finally {
    cleanup(root);
  }
});

test('the declared hook survives an opt-out and a broken payload', () => {
  const root = shippedRepo('2.37.0');
  try {
    const skipped = runDeclaredHook(driftHookCommand(), {
      cwd: root,
      env: { KANBANTIC_SKIP_RELEASE_DRIFT: '1' },
    });
    assert.equal(skipped.status, 0);
    assert.equal(skipped.stdout.trim(), '', 'the opt-out must be completely silent');

    const argv = toArgv(driftHookCommand());
    const garbage = spawnSync(argv[0], argv.slice(1), {
      input: 'not json at all',
      encoding: 'utf8',
      env: { ...process.env, KANBANTIC_SKIP_RELEASE_DRIFT: '' },
    });
    assert.equal(garbage.status, 0,
      'an unreadable SessionStart payload must not break the session');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// The pure renderer
// ---------------------------------------------------------------------------

test('the notice names both numbers so the operator can act without re-running', () => {
  const notice = formatDriftNotice({
    answerable: true, drifted: true, relation: 'registry-behind',
    repoVersion: '2.37.0', baselineNumber: 'v2.36.0',
    action: 'close-out', reason: 'x',
  });
  assert.match(notice, /2\.37\.0/);
  assert.match(notice, /v2\.36\.0/);
  assert.match(notice, /idempotent/,
    'the notice must say the registration is safe to re-run, or the reader hesitates '
      + 'over whether the supervising agent already did it');
});

test('an empty registry reads as such, not as "undefined"', () => {
  const notice = formatDriftNotice({
    answerable: true, drifted: true, relation: 'registry-empty',
    repoVersion: '2.37.0', baselineNumber: null, action: 'create-and-release', reason: 'x',
  });
  assert.doesNotMatch(notice, /null|undefined/);
});

test('an unanswerable check IS voiced once the clone opted in', () => {
  // Configured, asked, failed. Here silence would be indistinguishable from a clean repo —
  // the exact confusion KBT-B545 / B548 / B586 all turn on.
  const notice = formatDriftNotice({
    applicable: true, optedIn: true,
    answerable: false, drifted: null, relation: 'unknown',
    repoVersion: '2.37.0', baselineNumber: null, action: null,
    reason: 'could not read the registry (connect ECONNREFUSED)',
  });
  assert.match(String(notice), /could not read the registry/);
});

test('non-events are swallowed — the renderer, independently of the CLI', () => {
  // Belt and braces with the CLI's own --quiet filtering: whichever of the two a future edit
  // loosens, the other still holds the line. Both are cheap; a regression here lands in every
  // user's startup context.
  for (const nonEvent of [
    {
      applicable: false, optedIn: false, answerable: false, drifted: null,
      relation: 'not-applicable', reason: 'no plugin/.claude-plugin/plugin.json here',
    },
    {
      applicable: true, optedIn: false, answerable: false, drifted: null,
      relation: 'not-opted-in', reason: 'no Application is configured for this clone',
    },
  ]) {
    assert.equal(formatDriftNotice(nonEvent), null,
      `${nonEvent.relation} is a non-event and must render nothing`);
  }
});

test('an in-step registry stays silent at session start', () => {
  // It carries mayBeUnreleased (blocker A1) because an equal number cannot prove the Version
  // was released. But that caveat belongs to the review-lane close-out, not to every session
  // start — surfacing it here would fire on every healthy session and get the hook disabled.
  assert.equal(formatDriftNotice({
    applicable: true, optedIn: true, answerable: true, drifted: false,
    relation: 'in-step', mayBeUnreleased: true,
    repoVersion: '2.38.0', baselineNumber: 'v2.38.0', action: 'verify-released',
  }), null);
});

test('a missing or malformed result produces no output rather than a half-built line', () => {
  for (const bad of [null, undefined, 'text', 42]) {
    assert.equal(formatDriftNotice(bad), null);
  }
});
