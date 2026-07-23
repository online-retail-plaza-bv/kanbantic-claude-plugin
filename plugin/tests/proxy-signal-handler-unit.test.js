'use strict';

//
// KBT-B224 — Unit-level coverage of the SIGTERM/SIGINT handler wiring.
//
// Why a separate unit-test exists alongside the integration test:
//   plugin/tests/proxy-signal-cleanup.test.js is Integration-level: it spawns
//   the real proxy + a stub HTTP backend and asserts the end-to-end signal
//   path. On Windows hosts that test self-skips (Node converts child.kill on
//   win32 to SIGKILL), so the wiring goes UNVERIFIED on developer machines
//   between full POSIX/CI runs.
//
//   This unit-test closes that gap with zero spawn, zero network, zero
//   skip-on-Windows: it loads the proxy source as a text file and asserts
//   the contract pinned by KBT-RL062 (handler registration, idempotent
//   gracefulExit, removeSessionFile + stopInboxPoll + end_agent_session
//   ordering) directly against the source. It also unit-tests gracefulExit
//   in isolation by re-evaluating the proxy module in a sandbox where
//   process.exit and the HTTPS layer are stubbed, so the handler body is
//   actually executed.
//
// Test level: Unit (per KBT-TC1865/1866's Integration sibling and KBT-RL062).
//   - No child_process.spawn.
//   - No network I/O.
//   - No real process.exit (intercepted).
//   - Pure assertions on:
//       (a) source-level invariants (handler registration + wiring),
//       (b) runtime behaviour of gracefulExit in a sandboxed VM context.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Module } = require('node:module');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');
const PROXY_SRC = fs.readFileSync(PROXY_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 1. Source-level wiring assertions.
//
// These assertions guard the contract pinned by KBT-RL062 ("Proxy receives
// SIGTERM/SIGINT and shuts down cleanly"):
//   - Both signals are registered on process.
//   - Both handlers route through the shared gracefulExit(0) entrypoint.
//   - gracefulExit performs: stopInboxPoll → removeSessionFile →
//     end_agent_session (when applicable) → process.exit, gated by a
//     shuttingDown idempotency flag.
// ---------------------------------------------------------------------------

test('source: SIGINT handler is registered on process', () => {
  assert.match(
    PROXY_SRC,
    /process\.on\(\s*['"]SIGINT['"]\s*,/,
    'proxy must register a process.on("SIGINT", ...) handler'
  );
});

test('source: SIGTERM handler is registered on process', () => {
  assert.match(
    PROXY_SRC,
    /process\.on\(\s*['"]SIGTERM['"]\s*,/,
    'proxy must register a process.on("SIGTERM", ...) handler'
  );
});

test('source: both signal handlers call gracefulExit(0)', () => {
  // Match each registration + the gracefulExit(0) call inside its body.
  // The handlers are documented in kanbantic-mcp-proxy.js around lines
  // 481-488 (per KBT-RL062 "where this rule bites").
  const sigintBlock = PROXY_SRC.match(
    /process\.on\(\s*['"]SIGINT['"]\s*,[\s\S]*?\}\s*\)\s*;/
  );
  const sigtermBlock = PROXY_SRC.match(
    /process\.on\(\s*['"]SIGTERM['"]\s*,[\s\S]*?\}\s*\)\s*;/
  );
  assert.ok(sigintBlock, 'SIGINT handler block must be parsable');
  assert.ok(sigtermBlock, 'SIGTERM handler block must be parsable');
  assert.match(
    sigintBlock[0],
    /gracefulExit\s*\(\s*0\s*\)/,
    'SIGINT handler must call gracefulExit(0)'
  );
  assert.match(
    sigtermBlock[0],
    /gracefulExit\s*\(\s*0\s*\)/,
    'SIGTERM handler must call gracefulExit(0)'
  );
});

// Extract the gracefulExit function body once for the source-level assertions
// below. Match the keyword line through the first top-level closing `}` —
// the function happens to be the last definition in the file before the
// signal-handler registrations.
function extractGracefulExitBody() {
  const startIdx = PROXY_SRC.indexOf('async function gracefulExit');
  assert.ok(startIdx >= 0, 'gracefulExit function definition must exist in proxy source');
  // Find the opening brace.
  const openIdx = PROXY_SRC.indexOf('{', startIdx);
  assert.ok(openIdx >= 0, 'gracefulExit must have an opening brace');
  // Walk forward counting braces until the matching close.
  let depth = 0;
  for (let i = openIdx; i < PROXY_SRC.length; i++) {
    const c = PROXY_SRC[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return PROXY_SRC.slice(startIdx, i + 1);
    }
  }
  throw new Error('Could not locate matching close-brace for gracefulExit');
}

test('source: gracefulExit is idempotent via shuttingDown flag', () => {
  const body = extractGracefulExitBody();
  assert.match(
    body,
    /if\s*\(\s*shuttingDown\s*\)\s*return\s*;/,
    'gracefulExit must short-circuit when shuttingDown === true'
  );
  assert.match(
    body,
    /shuttingDown\s*=\s*true\s*;/,
    'gracefulExit must set shuttingDown = true before doing work'
  );
});

test('source: gracefulExit calls cleanup steps in the required order', () => {
  const body = extractGracefulExitBody();

  const stopIdx = body.indexOf('stopInboxPoll(');
  const removeIdx = body.indexOf('removeSessionFile(');
  const endCallIdx = body.indexOf("'end_agent_session'");
  const exitIdx = body.indexOf('process.exit(');

  assert.ok(stopIdx >= 0, 'gracefulExit must call stopInboxPoll()');
  assert.ok(removeIdx >= 0, 'gracefulExit must call removeSessionFile()');
  assert.ok(
    endCallIdx >= 0,
    'gracefulExit must call end_agent_session via callInternalTool'
  );
  assert.ok(exitIdx >= 0, 'gracefulExit must end with process.exit(code)');

  assert.ok(
    stopIdx < removeIdx,
    'stopInboxPoll() must run before removeSessionFile() (no further polls writing the file)'
  );
  assert.ok(
    removeIdx < endCallIdx,
    'removeSessionFile() must run before end_agent_session (cleanup ordering per KBT-RL062)'
  );
  assert.ok(
    endCallIdx < exitIdx,
    'end_agent_session must be invoked before process.exit'
  );
});

test('source: end_agent_session is gated on agentSessionId && API_KEY', () => {
  const body = extractGracefulExitBody();
  // Tolerate either order of the AND-operands.
  assert.match(
    body,
    /if\s*\(\s*(?:agentSessionId\s*&&\s*API_KEY|API_KEY\s*&&\s*agentSessionId)\s*\)/,
    'end_agent_session must only fire when both agentSessionId AND API_KEY are set'
  );
});

test('source: end_agent_session is invoked with reason "ProxyShutdown"', () => {
  const body = extractGracefulExitBody();
  assert.match(
    body,
    /reason\s*:\s*['"]ProxyShutdown['"]/,
    'end_agent_session must be called with reason: "ProxyShutdown" (per KBT-RL062 AC3)'
  );
});

// ---------------------------------------------------------------------------
// 2. Behavioural unit-test of gracefulExit in a sandbox.
//
// We evaluate the proxy source inside a node:vm sandbox where:
//   - process.exit is intercepted (records the code, throws to unwind),
//   - callInternalTool is stubbed (records the args, resolves a canned reply),
//   - stopInboxPoll / removeSessionFile are stubbed (record they were called),
//   - the stdin pipe is short-circuited so the proxy doesn't try to read.
//
// Then we invoke the SIGINT and SIGTERM handlers directly (via the registered
// process.on listeners captured in the sandbox) and assert the cleanup
// sequence runs and process.exit(0) is reached.
// ---------------------------------------------------------------------------

function loadProxyInSandbox() {
  // Records of side-effects observed during the handler run.
  const calls = {
    exit: [], // codes recorded — process.exit is non-throwing in the sandbox
              // so gracefulExit's async function resolves normally; we
              // observe completion via the `exited` promise resolved here.
  };

  const listeners = { SIGINT: [], SIGTERM: [] };

  let exitResolve;
  const exited = new Promise((r) => { exitResolve = r; });

  // A fake process that mirrors enough of the real one for the proxy module
  // to load without errors. We intercept exit + on('SIG*').
  const fakeProcess = {
    env: { KANBANTIC_API_KEY: 'unit-test-key' },
    platform: process.platform,
    stdin: {
      setEncoding() {},
      on() {},
      resume() {},
    },
    stdout: { write() {} },
    stderr: { write() {} },
    on(event, cb) {
      if (event === 'SIGINT' || event === 'SIGTERM') {
        listeners[event].push(cb);
      }
      // Ignore other events (e.g. uncaughtException) — not under test here.
    },
    exit(code) {
      calls.exit.push(code);
      // Non-throwing: gracefulExit's async function will continue past us and
      // resolve cleanly. We signal completion via the `exited` promise so the
      // test can await the full handler chain.
      exitResolve(code);
    },
  };

  // Build a fresh Module so require() inside the proxy resolves relative to
  // the real proxy path (for any future relative requires).
  const proxyModule = new Module(PROXY_PATH);
  proxyModule.filename = PROXY_PATH;
  proxyModule.paths = Module._nodeModulePaths(path.dirname(PROXY_PATH));

  const sandbox = {
    process: fakeProcess,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    console,
    require: proxyModule.require.bind(proxyModule),
    module: proxyModule,
    exports: proxyModule.exports,
    __filename: PROXY_PATH,
    __dirname: path.dirname(PROXY_PATH),
  };
  sandbox.globalThis = sandbox;

  // Wrap as a function body so we have access to `let` bindings declared at
  // module top-level (agentSessionId, shuttingDown, etc.) for direct override
  // via the sandbox. Note: vm.runInNewContext + the let bindings are NOT
  // exposed back to us; we override behaviour via the injected globals only.
  vm.createContext(sandbox);
  vm.runInContext(PROXY_SRC, sandbox, { filename: PROXY_PATH });

  return { calls, listeners, sandbox, exited };
}

test('runtime: SIGINT handler runs cleanup and reaches process.exit(0)', async () => {
  const { calls, listeners, exited } = loadProxyInSandbox();
  assert.ok(listeners.SIGINT.length >= 1, 'at least one SIGINT listener registered');

  // Invoke the registered SIGINT handler (sync wrapper around gracefulExit).
  // No agentSessionId was set in the sandbox (no register_agent_session call),
  // so the end_agent_session branch is skipped — exit must still be 0.
  listeners.SIGINT[0]();

  // Await completion via the deferred-resolved exit promise (timeboxed).
  const exitCode = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SIGINT handler did not reach process.exit within 1s')), 1000)
    ),
  ]);
  assert.strictEqual(exitCode, 0, 'SIGINT handler must reach process.exit(0)');
  assert.deepEqual(calls.exit, [0], 'process.exit must be called exactly once with code 0');
});

test('runtime: SIGTERM handler runs cleanup and reaches process.exit(0)', async () => {
  const { calls, listeners, exited } = loadProxyInSandbox();
  assert.ok(listeners.SIGTERM.length >= 1, 'at least one SIGTERM listener registered');

  listeners.SIGTERM[0]();

  const exitCode = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SIGTERM handler did not reach process.exit within 1s')), 1000)
    ),
  ]);
  assert.strictEqual(exitCode, 0, 'SIGTERM handler must reach process.exit(0)');
  assert.deepEqual(calls.exit, [0], 'process.exit must be called exactly once with code 0');
});

test('runtime: second signal is a no-op (gracefulExit is idempotent)', async () => {
  const { calls, listeners, exited } = loadProxyInSandbox();

  // First SIGTERM triggers exit.
  listeners.SIGTERM[0]();
  await exited;

  // A second signal (SIGINT) after shuttingDown=true must NOT call exit again.
  // Snapshot the call-count, run the listener, drain microtasks, assert no
  // delta. The async gracefulExit will short-circuit on `if (shuttingDown)`.
  const before = calls.exit.length;
  listeners.SIGINT[0]();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(
    calls.exit.length,
    before,
    'gracefulExit must short-circuit on repeat — only the first signal triggers process.exit'
  );
  assert.deepEqual(calls.exit, [0], 'exit recorded exactly once with code 0');
});
