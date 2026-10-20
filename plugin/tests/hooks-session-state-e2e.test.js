'use strict';

//
// hooks-session-state-e2e.test.js — KBT-F741 / KBT-TC4199 (real-session E2E)
//
// Starts a REAL headless Claude Code session (`claude -p`) with this checkout's
// plugin loaded via --plugin-dir, against a local API stub on 127.0.0.1 that
// records which /api/app/agent-session/* calls the hooks make. Nothing here
// talks to a real Kanbantic: the stub is the API, the session file and the
// allow-list cache are pre-written, user settings are not loaded
// (--setting-sources project), so neither the installed plugin nor the user's
// own permission rules can interfere.
//
// The task for the model: read <tmp>/allowed/a.txt and <tmp>/other/b.txt (both
// outside the working directory, so both raise a permission question). The
// allow-list holds Read(<tmp>/allowed/**), hence:
//   - a.txt  → PermissionRequest router allows; tool-activity with
//              permissionDecision "allow-list: Read(...)"
//   - b.txt  → no rule; wait-for-user "[permission] Read: ..."; no decision, so
//              in -p mode Claude Code denies the read
//   - end    → Stop hook sends heartbeat status Idle
//
// KBT_E2E_HOOKS_DISABLED=1 runs the same session against a copy of the plugin
// whose hooks.json has the new entries stripped. The assertions are unchanged,
// so the test MUST go red — that is the proof it detects missing hooks.
//
// Skipped (with the reason) when `claude` is not on PATH or KBT_E2E_CLAUDE=0.
// The model is a cheap one with a hard budget cap; one run is ~30-60 s.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { mkTmp, rmTmp, startApiStub } = require('./helpers/hook-harness.js');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const NEW_COMMANDS = /notification-session-state|permission-request-router|tool-activity|turn-start|stop-session-idle/;

function claudeAvailable() {
  if (process.env.KBT_E2E_CLAUDE === '0') return 'KBT_E2E_CLAUDE=0';
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (r.error || r.status !== 0) return 'the `claude` CLI is not on PATH';
  return null;
}

/** Copy of the plugin with every new hook entry removed from hooks.json. */
function strippedPluginCopy(dest) {
  fs.cpSync(PLUGIN_DIR, dest, {
    recursive: true,
    filter: (src) => !/[\\/]tests([\\/]|$)/.test(src.slice(PLUGIN_DIR.length)),
  });
  const file = path.join(dest, 'hooks', 'hooks.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [event, entries] of Object.entries(json.hooks)) {
    json.hooks[event] = entries
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !NEW_COMMANDS.test(h.command)) }))
      .filter((e) => e.hooks.length > 0);
    if (json.hooks[event].length === 0) delete json.hooks[event];
  }
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

function runClaude({ cwd, pluginDir, prompt, env, timeoutMs }) {
  const childEnv = { ...process.env };
  // A nested session must not believe it is the outer one.
  for (const k of Object.keys(childEnv)) if (/^CLAUDE(CODE|_CODE)/i.test(k)) delete childEnv[k];
  for (const k of Object.keys(childEnv)) if (/^KANBANTIC_/.test(k)) delete childEnv[k];
  const args = [
    '-p', prompt,
    '--plugin-dir', pluginDir,
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'json',
    '--model', process.env.KBT_E2E_MODEL || 'haiku',
    '--max-budget-usd', '1',
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env: { ...childEnv, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
    child.stdin.end();
  });
}

const skipReason = claudeAvailable();

test('KBT-TC4199 — a real headless session reports allow-list, permission wait and idle to the API', { skip: skipReason || false, timeout: 240000 }, async () => {
  const root = mkTmp('kbt-f741-e2e-');
  const stub = await startApiStub();
  try {
    const work = path.join(root, 'work');
    const allowed = path.join(root, 'allowed');
    const other = path.join(root, 'other');
    for (const d of [work, allowed, other]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(allowed, 'a.txt'), 'AAA-content\n');
    fs.writeFileSync(path.join(other, 'b.txt'), 'BBB-content\n');

    const sessionFile = path.join(root, 'session.json');
    fs.writeFileSync(sessionFile, JSON.stringify({
      sessionId: 'SESS-E2E', channelId: 'CHAN-E2E', claudeCliSessionId: null,
      apiUrl: stub.url, writtenAt: new Date().toISOString(), pid: process.pid, cursors: {},
    }));
    const allowFile = path.join(root, 'allow.json');
    const slash = (p) => p.replace(/\\/g, '/');
    fs.writeFileSync(allowFile, JSON.stringify({
      allowList: [`Read(${slash(allowed)}/**)`],
      allowListFetchedAt: new Date().toISOString(),
    }));

    let pluginDir = PLUGIN_DIR;
    if (process.env.KBT_E2E_HOOKS_DISABLED === '1') {
      pluginDir = path.join(root, 'plugin-without-new-hooks');
      strippedPluginCopy(pluginDir);
    }

    const a = path.join(allowed, 'a.txt');
    const b = path.join(other, 'b.txt');
    const r = await runClaude({
      cwd: work,
      pluginDir,
      prompt: `Use the Read tool on ${a} and then on ${b}. Use no other tool. Then say which of the two you could read.`,
      timeoutMs: 200000,
      env: {
        KANBANTIC_API_URL: stub.url,
        KANBANTIC_API_KEY: 'test',
        KANBANTIC_MCP_URL: 'http://127.0.0.1:1/mcp',
        KANBANTIC_SESSION_FILE: sessionFile,
        KANBANTIC_ALLOWLIST_FILE: allowFile,
        KANBANTIC_HOOK_STATE_DIR: path.join(root, 'state'),
        KANBANTIC_SYNC_DEBUG: '1',
      },
    });

    assert.ok(!r.timedOut, `claude timed out. stderr: ${r.stderr.slice(0, 500)}`);
    const diag = () => `claude exit=${r.status}\nstdout=${r.stdout.slice(0, 1500)}\nstderr=${r.stderr.slice(0, 800)}\ncalls=${JSON.stringify(stub.calls.map((c) => [c.url, c.body]))}`;

    const calls = stub.calls.filter((c) => c.url.startsWith('/api/app/agent-session/SESS-E2E/'));
    const bodies = (suffix) => calls.filter((c) => c.url.endsWith(suffix)).map((c) => c.body);

    const activity = bodies('/tool-activity');
    const allowed1 = activity.find((x) => x && typeof x.permissionDecision === 'string' && x.permissionDecision.startsWith('allow-list:'));
    assert.ok(allowed1, `no tool-activity with an allow-list: decision\n${diag()}`);
    assert.equal(allowed1.toolName, 'Read');
    // The router attaches its decision to the SAME row the PreToolUse hook opened
    // (PermissionRequest has no tool_use_id of its own).
    assert.ok(
      activity.some((x) => x && x.startedAt && x.toolUseId === allowed1.toolUseId),
      `allow decision is not correlated with a PreToolUse tool_use_id\n${diag()}`
    );

    const waits = bodies('/wait-for-user');
    assert.ok(waits.some((x) => x && /^\[permission\] Read/.test(x.prompt) && x.prompt.includes('b.txt')),
      `no wait-for-user "[permission] Read" for b.txt\n${diag()}`);
    assert.ok(!waits.some((x) => x && x.prompt.includes('a.txt') && /^\[permission\]/.test(x.prompt)),
      `the allowed read must not raise a permission wait\n${diag()}`);

    assert.ok(calls.some((c) => c.url.endsWith('/turn-start')), `no turn-start\n${diag()}`);
    assert.ok(activity.some((x) => x && x.startedAt && x.toolName === 'Read'), `no PreToolUse tool-activity\n${diag()}`);
    const beats = bodies('/heartbeat');
    assert.ok(beats.some((x) => x && x.status === 'Idle'), `no heartbeat Idle at the end\n${diag()}`);

    // The router never produced a deny: the model must have been told "denied",
    // not been handed content of b.txt.
    assert.ok(!r.stdout.includes('BBB-content'), `b.txt content must not have been readable\n${diag()}`);
  } finally {
    await stub.close();
    rmTmp(root);
  }
});
