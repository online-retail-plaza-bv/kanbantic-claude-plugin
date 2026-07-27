// KBT-B470 — the proxy sends a periodic keep-alive heartbeat so an idle spawned agent stays
// visible in /agent-sessions instead of being reaped by the backend stale-sweep (300s).
const test = require('node:test');
const assert = require('node:assert/strict');
const proxy = require('../proxy/kanbantic-mcp-proxy');

test('sendHeartbeat: calls the heartbeat tool with the active sessionId', async () => {
  proxy.__resetForTest();
  const calls = [];
  proxy.setForwardForTest(async (body) => {
    const parsed = JSON.parse(body);
    calls.push(parsed);
    return [{ jsonrpc: '2.0', id: parsed.id, result: { content: [] } }];
  });
  proxy.__setSessionForTest('sess-b470');

  await proxy.sendHeartbeat();

  assert.equal(calls.length, 1, 'exactly one forwarded call');
  assert.equal(calls[0].method, 'tools/call');
  assert.equal(calls[0].params.name, 'heartbeat');
  assert.deepEqual(calls[0].params.arguments, { sessionId: 'sess-b470' });
  proxy.__resetForTest();
});

test('sendHeartbeat: no-op when there is no active session', async () => {
  proxy.__resetForTest(); // agentSessionId = null
  const calls = [];
  proxy.setForwardForTest(async (body) => { calls.push(body); return []; });

  await proxy.sendHeartbeat();

  assert.equal(calls.length, 0, 'no forward when there is no session');
  proxy.__resetForTest();
});

test('startHeartbeat/stopHeartbeat: idempotent start and clean stop (no dangling timer)', () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('sess-timer');
  proxy.startHeartbeat();
  proxy.startHeartbeat(); // idempotent — must not double-schedule or throw
  proxy.stopHeartbeat();
  proxy.stopHeartbeat(); // safe double-stop
  proxy.__resetForTest();
  // Reaching here without a hanging test process proves the interval was cleared.
  assert.ok(true);
});
