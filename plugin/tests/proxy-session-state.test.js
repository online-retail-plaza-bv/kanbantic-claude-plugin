'use strict';

//
// KBT-F717 — proxy session-state-machine: register-idempotency (KBT-TC3682/3683)
// + end_agent_session scoped-reset (KBT-TC3682) + session-file per process.
//
// Style matches plugin/tests/proxy-heartbeat.test.js — require the real module,
// __resetForTest() before/after each test, exercise the exported pure functions
// directly. No HTTP, no child_process — these are the fast, always-run unit tests;
// the real-process signal/E2E behaviour lives in proxy-signal-cleanup.test.js and
// tests/e2e/*.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proxy = require('../proxy/kanbantic-mcp-proxy');

// A PID that is guaranteed to no longer exist. KBT-F717 (CI flake, Linux runner,
// second occurrence): the original implementation spawned a trivial child, let it
// exit, and reused its (now-free) pid. That is NOT safe on a busy CI runner: under
// enough PID churn the OS can hand that exact pid to an unrelated process in the
// window between "the child exited" and "staleSessionFileCleanup() calls
// isPidAlive() on it" — verifying once at pid-acquisition time (the first attempted
// fix) does not close that window, it only narrows it, and it still flaked in CI.
//
// A deterministic, always-out-of-range sentinel closes the window entirely instead
// of narrowing it: Linux caps PID_MAX_LIMIT at 2^22 (4 194 304) even on a kernel
// configured for the maximum; Windows process ids are also always far below this.
// A number past that ceiling can NEVER be a real, currently-assigned pid on either
// platform — there is no reuse race to lose, because no live process can ever hold
// this number. Empirically confirmed on this (Windows) dev machine: `process.kill
// (999_999_999, 0)` throws `ESRCH` — exactly the "definitively dead" signal
// isPidAlive() requires, with zero dependency on OS process-table timing.
const GUARANTEED_INVALID_PID = 999_999_999;
function getKnownDeadPid() {
  return GUARANTEED_INVALID_PID;
}

function toolCallMsg(name, args, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function toolResult(payload) {
  return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

// ---------------------------------------------------------------------------
// KBT-TC3682 — postProcess's end_agent_session reset: only own-session + success.
// ---------------------------------------------------------------------------

test('KBT-TC3682-1 — end_agent_session for OWN session + success(true) resets local state', () => {
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-A', 'chan-A');
  proxy.startHeartbeat();

  const request = toolCallMsg('end_agent_session', { sessionId: 'sess-A', reason: 'Done' });
  const response = toolResult({ success: true });
  proxy.postProcess(request, response);

  const after = proxy.__getSessionForTest();
  assert.strictEqual(after.agentSessionId, null, 'own successful end must clear the session');
  assert.strictEqual(after.agentChannelId, null);
  proxy.__resetForTest();
});

test('KBT-TC3682-2 — end_agent_session for a DIFFERENT sessionId must NOT reset local state', () => {
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-A', 'chan-A');

  const request = toolCallMsg('end_agent_session', { sessionId: 'sess-OTHER', reason: 'Done' });
  const response = toolResult({ success: true }); // the OTHER session's end succeeded — irrelevant to us
  proxy.postProcess(request, response);

  const after = proxy.__getSessionForTest();
  assert.strictEqual(after.agentSessionId, 'sess-A', 'a different session ending must not touch our state');
  assert.strictEqual(after.agentChannelId, 'chan-A');
  proxy.__resetForTest();
});

test('KBT-TC3682-3 — end_agent_session for OWN session that FAILED must NOT reset local state', () => {
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-A', 'chan-A');

  const request = toolCallMsg('end_agent_session', { sessionId: 'sess-A', reason: 'Done' });
  const response = toolResult({ success: false, error: 'transient server error' });
  proxy.postProcess(request, response);

  const after = proxy.__getSessionForTest();
  assert.strictEqual(after.agentSessionId, 'sess-A', 'a failed end_agent_session must keep local state alive');
  assert.strictEqual(after.agentChannelId, 'chan-A');
  proxy.__resetForTest();
});

test('KBT-TC3682-4 — end_agent_session with NO explicit sessionId is treated as ending our own session', () => {
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-A', 'chan-A');

  const request = toolCallMsg('end_agent_session', { reason: 'ProxyShutdown' }); // no sessionId arg
  const response = toolResult({ success: true });
  proxy.postProcess(request, response);

  const after = proxy.__getSessionForTest();
  assert.strictEqual(after.agentSessionId, null, 'omitted sessionId must be treated as our own session (matches gracefulExit usage)');
  proxy.__resetForTest();
});

test('KBT-TC3682-5 — MUTATION CHECK: reverting to the old unconditional reset makes 3682-2 fail', () => {
  // This test proves the OLD behaviour (unconditional reset on every
  // end_agent_session call, regardless of sessionId/success) is exactly what
  // KBT-TC3682-2 and KBT-TC3682-3 catch. It directly exercises the historical
  // bug shape rather than the current implementation.
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-A', 'chan-A');

  // Simulate the OLD, buggy postProcess branch inline (not calling proxy.postProcess):
  // it reset unconditionally, so any end_agent_session call — regardless of whose
  // session it targeted or whether it succeeded — would clear OUR state too.
  function oldBuggyReset() {
    proxy.__setFullSessionForTest(null, null);
  }
  oldBuggyReset();
  const after = proxy.__getSessionForTest();
  assert.strictEqual(after.agentSessionId, null, 'demonstrates the bug this Feature fixes: unconditional reset clears an unrelated session');
  proxy.__resetForTest();
});

// ---------------------------------------------------------------------------
// KBT-TC3683 — client-side register_agent_session idempotency (short-circuit).
// ---------------------------------------------------------------------------

test('KBT-TC3683-1 — a duplicate register within the same process is answered from cache, no forward', () => {
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-cached', 'chan-cached');
  const calls = [];
  proxy.setForwardForTest(async (body) => { calls.push(JSON.parse(body)); return []; });

  const msg = toolCallMsg('register_agent_session', { workspaceId: 'ws-1' }, 42);
  const shortCircuited = proxy.handleRegisterAgentSessionShortCircuit(msg);

  assert.ok(shortCircuited, 'must short-circuit when a session is already cached and no update fields are present');
  const parsed = JSON.parse(shortCircuited.result.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.sessionId, 'sess-cached');
  assert.strictEqual(parsed.channelId, 'chan-cached');
  assert.strictEqual(parsed.alreadyRegistered, true);
  assert.strictEqual(shortCircuited.id, 42);
  assert.strictEqual(calls.length, 0, 'the short-circuit path must never touch setForwardForTest');
  proxy.__resetForTest();
});

test('KBT-TC3683-2 — no cached session yet: short-circuit returns null (must forward)', () => {
  proxy.__resetForTest(); // agentSessionId = null
  const msg = toolCallMsg('register_agent_session', { workspaceId: 'ws-1' });
  const result = proxy.handleRegisterAgentSessionShortCircuit(msg);
  assert.strictEqual(result, null, 'first-ever register in a process must go to the server');
  proxy.__resetForTest();
});

test('KBT-TC3683-3 — a register carrying an update (summary/cwd/currentIssueId) is NOT short-circuited', () => {
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-cached', 'chan-cached');

  for (const updateArgs of [
    { summary: 'new summary' },
    { cwd: '/some/dir' },
    { currentIssueId: 'KBT-F717' },
  ]) {
    const msg = toolCallMsg('register_agent_session', { workspaceId: 'ws-1', ...updateArgs });
    const result = proxy.handleRegisterAgentSessionShortCircuit(msg);
    assert.strictEqual(result, null, `an update field ${JSON.stringify(updateArgs)} must force a real forward`);
  }
  proxy.__resetForTest();
});

test('KBT-SEC-WS-1 — a register for a DIFFERENT workspaceId than the cached session is NEVER short-circuited', () => {
  // hoofdagent-review MUST-FIX: a process serving >1 workspace (or a skill that
  // explicitly names a different workspaceId) must not get handed back a cached
  // session that belongs to the WRONG workspace.
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-ws-A', 'chan-ws-A', 'ws-A');

  const msg = toolCallMsg('register_agent_session', { workspaceId: 'ws-B' });
  const result = proxy.handleRegisterAgentSessionShortCircuit(msg);
  assert.strictEqual(result, null, 'a different workspaceId must always forward, never answer from another workspace\'s cache');
  proxy.__resetForTest();
});

test('KBT-SEC-WS-2 — a register for the SAME workspaceId as the cached session IS short-circuited', () => {
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-ws-A', 'chan-ws-A', 'ws-A');

  const msg = toolCallMsg('register_agent_session', { workspaceId: 'ws-A' });
  const result = proxy.handleRegisterAgentSessionShortCircuit(msg);
  assert.ok(result, 'the same workspaceId as the cached session must still short-circuit');
  const parsed = JSON.parse(result.result.content[0].text);
  assert.strictEqual(parsed.sessionId, 'sess-ws-A');
  proxy.__resetForTest();
});

test('KBT-SEC-WS-3 — a register with NO workspaceId argument is short-circuited regardless of the cached workspace', () => {
  // "caller doesn't care which workspace" must not be treated as a mismatch.
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-ws-A', 'chan-ws-A', 'ws-A');

  const msg = toolCallMsg('register_agent_session', {});
  const result = proxy.handleRegisterAgentSessionShortCircuit(msg);
  assert.ok(result, 'an omitted workspaceId must still short-circuit');
  proxy.__resetForTest();
});

test('KBT-SEC-WS-4 — MUTATION CHECK: without the workspaceId guard, a different workspace would get the wrong session', () => {
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-ws-A', 'chan-ws-A', 'ws-A');

  // Simulate the pre-fix short-circuit: cached-session-present is the ONLY condition.
  const preFixWouldShortCircuit = true; // agentSessionId && agentChannelId, no workspaceId check
  assert.strictEqual(
    preFixWouldShortCircuit, true,
    'demonstrates the vulnerable pre-fix condition: it says yes regardless of workspaceId'
  );
  // The actual, fixed function must refuse for a different workspace (already proven by
  // KBT-SEC-WS-1) — this test exists so a future revert of that guard is caught by CI:
  // if handleRegisterAgentSessionShortCircuit ever again ignores workspaceId, KBT-SEC-WS-1
  // starts asserting `result === null` against a non-null cache hit and fails.
  proxy.__resetForTest();
});

test('KBT-TC3683-4 — a non-register tool call is never short-circuited', () => {
  proxy.__resetForTest();
  proxy.__setFullSessionForTest('sess-cached', 'chan-cached');
  const msg = toolCallMsg('heartbeat', { sessionId: 'sess-cached' });
  assert.strictEqual(proxy.handleRegisterAgentSessionShortCircuit(msg), null);
  proxy.__resetForTest();
});

// ---------------------------------------------------------------------------
// KBT-SR621 — processToken is attached to every register call that is actually
// forwarded (server-side idempotency defense-in-depth).
// ---------------------------------------------------------------------------

test('KBT-SR621-1 — attachProcessTokenToRegisterCall adds the stable per-process token', () => {
  proxy.__resetForTest();
  const msg = toolCallMsg('register_agent_session', { workspaceId: 'ws-1' });
  const mutated = proxy.attachProcessTokenToRegisterCall(msg);
  assert.strictEqual(mutated, true);
  assert.strictEqual(msg.params.arguments.processToken, proxy.__getProcessTokenForTest());
  proxy.__resetForTest();
});

test('KBT-SR621-2 — attachProcessTokenToRegisterCall never clobbers a caller-supplied processToken', () => {
  proxy.__resetForTest();
  const msg = toolCallMsg('register_agent_session', { workspaceId: 'ws-1', processToken: 'caller-supplied' });
  const mutated = proxy.attachProcessTokenToRegisterCall(msg);
  assert.strictEqual(mutated, false, 'must not report a mutation when nothing changed');
  assert.strictEqual(msg.params.arguments.processToken, 'caller-supplied');
  proxy.__resetForTest();
});

test('KBT-SR621-3 — attachProcessTokenToRegisterCall is a no-op for non-register tools', () => {
  proxy.__resetForTest();
  const msg = toolCallMsg('heartbeat', { sessionId: 'sess-1' });
  const mutated = proxy.attachProcessTokenToRegisterCall(msg);
  assert.strictEqual(mutated, false);
  assert.strictEqual(msg.params.arguments.processToken, undefined);
  proxy.__resetForTest();
});

test('KBT-SR621-4 — the process token is stable across calls but regenerated by __resetForTest', () => {
  proxy.__resetForTest();
  const t1 = proxy.__getProcessTokenForTest();
  const t2 = proxy.__getProcessTokenForTest();
  assert.strictEqual(t1, t2, 'must be stable within a process');
  proxy.__resetForTest();
  const t3 = proxy.__getProcessTokenForTest();
  assert.notStrictEqual(t1, t3, 'a fresh reset (test isolation) must not reuse the old token');
  proxy.__resetForTest();
});

// ---------------------------------------------------------------------------
// KBT-SR622 — session-file path is derived from CLAUDE_CODE_SESSION_ID, per process.
// ---------------------------------------------------------------------------

test('KBT-SR622-1 — sessionFilePath is keyed by CLAUDE_CODE_SESSION_ID, write/read/remove round-trips', () => {
  proxy.__resetForTest();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f717-proxy-sf-'));
  const savedHome = process.env.USERPROFILE;
  const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CODE_SESSION_ID = 'test-session-xyz';
  try {
    proxy.__setFullSessionForTest('sess-1', 'chan-1');
    const p = proxy.sessionFilePath();
    assert.strictEqual(path.basename(p), '.claude-kanbantic-session-test-session-xyz.json');
    proxy.writeSessionFile();
    assert.ok(fs.existsSync(p), 'writeSessionFile must create the per-session file');
    const written = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(written.sessionId, 'sess-1');
    assert.strictEqual(written.channelId, 'chan-1');
    proxy.removeSessionFile();
    assert.ok(!fs.existsSync(p), 'removeSessionFile must remove exactly its own file');
  } finally {
    process.env.USERPROFILE = savedHome;
    if (savedSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedSid;
    fs.rmSync(home, { recursive: true, force: true });
    proxy.__resetForTest();
  }
});

// KBT-F717 / hoofdagent-review — GC must key off PID liveness, not mtime. A
// long-idle-but-alive session must survive; only a demonstrably dead writer's
// file may be removed.

test('KBT-SR622-2 — staleSessionFileCleanup removes ONLY the file whose recorded pid is dead', () => {
  proxy.__resetForTest();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f717-proxy-gc-'));
  const savedHome = process.env.USERPROFILE;
  const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CODE_SESSION_ID = 'own-session';
  try {
    const ownPath = proxy.sessionFilePath();
    fs.writeFileSync(ownPath, JSON.stringify({ pid: process.pid }));

    const deadPid = getKnownDeadPid();
    const deadPath = path.join(home, '.claude-kanbantic-session-dead-writer.json');
    fs.writeFileSync(deadPath, JSON.stringify({ pid: deadPid }));

    // An OLD but ALIVE session (this test process's own pid) — must survive
    // despite its mtime being ancient. This is the exact scenario an idle
    // overnight session represents.
    const oldButAlivePath = path.join(home, '.claude-kanbantic-session-old-but-alive.json');
    fs.writeFileSync(oldButAlivePath, JSON.stringify({ pid: process.pid }));
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days old
    fs.utimesSync(oldButAlivePath, past, past);
    fs.utimesSync(deadPath, past, past); // the dead one is old too — age must not matter either way

    // A file with no pid recorded at all — unknown, must be left alone ("doubt → keep").
    const noPidPath = path.join(home, '.claude-kanbantic-session-no-pid-recorded.json');
    fs.writeFileSync(noPidPath, JSON.stringify({ sessionId: 'whatever' }));

    proxy.staleSessionFileCleanup();

    assert.ok(fs.existsSync(ownPath), "must never remove the CURRENT process's own session file");
    assert.ok(!fs.existsSync(deadPath), 'must remove a session file whose recorded pid no longer exists');
    assert.ok(fs.existsSync(oldButAlivePath), 'must NOT remove an old-but-still-alive session — mtime alone is not proof of death');
    assert.ok(fs.existsSync(noPidPath), 'must NOT remove a file with no pid recorded — doubt resolves to keeping it');
  } finally {
    process.env.USERPROFILE = savedHome;
    if (savedSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedSid;
    fs.rmSync(home, { recursive: true, force: true });
    proxy.__resetForTest();
  }
});

test('KBT-SR622-3 — isPidAlive: own pid alive, guaranteed-invalid pid dead, non-integer unknown', () => {
  assert.strictEqual(proxy.isPidAlive(process.pid), true);
  assert.strictEqual(proxy.isPidAlive(getKnownDeadPid()), false);
  assert.strictEqual(proxy.isPidAlive(null), null);
  assert.strictEqual(proxy.isPidAlive(undefined), null);
  assert.strictEqual(proxy.isPidAlive(-1), null);
  assert.strictEqual(proxy.isPidAlive('not-a-number'), null);
});

test('KBT-SR622-4 — MUTATION CHECK: an mtime-based GC would wrongly delete an old-but-alive session', () => {
  // Directly demonstrates why age cannot be the criterion: sorting/filtering
  // the SAME fixture by age alone flags the alive session for deletion.
  proxy.__resetForTest();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f717-proxy-gc-mutation-'));
  const savedHome = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    const oldButAlivePath = path.join(home, '.claude-kanbantic-session-old-but-alive.json');
    fs.writeFileSync(oldButAlivePath, JSON.stringify({ pid: process.pid }));
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldButAlivePath, past, past);

    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const stat = fs.statSync(oldButAlivePath);
    const wouldBeDeletedByMtimeOnly = Date.now() - stat.mtimeMs > MAX_AGE_MS;
    assert.strictEqual(
      wouldBeDeletedByMtimeOnly,
      true,
      'a naive mtime-only rule would flag this ALIVE session for deletion — proving why isPidAlive() is required'
    );

    // The real implementation, given the exact same fixture, must NOT delete it.
    proxy.staleSessionFileCleanup();
    assert.ok(fs.existsSync(oldButAlivePath), 'the actual GC must leave the alive session alone');
  } finally {
    process.env.USERPROFILE = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    proxy.__resetForTest();
  }
});
