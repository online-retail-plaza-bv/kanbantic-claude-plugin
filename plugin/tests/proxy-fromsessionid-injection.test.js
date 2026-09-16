'use strict';

//
// KBT-F718 fast-follow — automatic fromSessionId injection on outbound send_message calls.
//
// F718 built an explicit-sender path (send_message's optional fromSessionId param) on the
// server so a caller with two active sessions under the same agent identity is never
// misattributed by the server's "most recently seen" fallback heuristic. That only helps if
// something actually populates it — this proxy is the one place that reliably knows ITS OWN
// sessionId (captured at register time, KBT-F717), so it injects it automatically on every
// outbound send_message call, without the model ever needing to know the parameter exists.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const proxy = require('../proxy/kanbantic-mcp-proxy');

function toolCallMsg(name, args, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

test('attachFromSessionIdToSendMessageCall injects the registered session id', () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('sess-1');
  const msg = toolCallMsg('send_message', { channelId: 'chan-a', content: 'hi' });
  const mutated = proxy.attachFromSessionIdToSendMessageCall(msg);
  assert.strictEqual(mutated, true);
  assert.strictEqual(msg.params.arguments.fromSessionId, 'sess-1');
  proxy.__resetForTest();
});

test('attachFromSessionIdToSendMessageCall never clobbers a caller-supplied fromSessionId', () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('sess-1');
  const msg = toolCallMsg('send_message', { channelId: 'chan-a', content: 'hi', fromSessionId: 'explicit-other' });
  const mutated = proxy.attachFromSessionIdToSendMessageCall(msg);
  assert.strictEqual(mutated, false, 'must not report a mutation when nothing changed');
  assert.strictEqual(msg.params.arguments.fromSessionId, 'explicit-other');
  proxy.__resetForTest();
});

test('attachFromSessionIdToSendMessageCall is a no-op for non-send_message tools', () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('sess-1');
  const msg = toolCallMsg('heartbeat', { sessionId: 'sess-1' });
  const mutated = proxy.attachFromSessionIdToSendMessageCall(msg);
  assert.strictEqual(mutated, false);
  assert.strictEqual(msg.params.arguments.fromSessionId, undefined);
  proxy.__resetForTest();
});

test('attachFromSessionIdToSendMessageCall is a no-op when this process has not registered yet', () => {
  proxy.__resetForTest(); // no session set — agentSessionId is null
  const msg = toolCallMsg('send_message', { channelId: 'chan-a', content: 'hi' });
  const mutated = proxy.attachFromSessionIdToSendMessageCall(msg);
  assert.strictEqual(mutated, false, 'nothing to inject before this process has an identity');
  assert.strictEqual(msg.params.arguments.fromSessionId, undefined);
  proxy.__resetForTest();
});

test('attachFromSessionIdToSendMessageCall handles a send_message call with no arguments object at all', () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('sess-1');
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message' } };
  const mutated = proxy.attachFromSessionIdToSendMessageCall(msg);
  assert.strictEqual(mutated, true);
  assert.strictEqual(msg.params.arguments.fromSessionId, 'sess-1');
  proxy.__resetForTest();
});
