// KBT-B1012 — notifications/claude/channel `meta` must be Record<string, string>.
//
// Claude Code 2.1.277 validates the channel notification schema and, on any non-string meta
// value, throws "Invalid params for notification notifications/claude/channel" — and its error
// handler then closes the MCP connection. Measured on Kanbantic-Dev-03, 2026-09-18 21:46Z:
//   meta.from_user: Invalid input, meta.room_is_home: Invalid input
// followed by "STDIO connection dropped". from_user was null (a message authored by an agent
// session, i.e. every agent-to-agent message) and room_is_home was a boolean. Older Claude
// versions let both through, which is why the harness — whose ProxyHarness accepts any
// notification — never saw it.
//
// Two layers: channelMeta() in isolation, and the real pollRoom() path so the assertion is on
// what actually leaves the proxy, not on a helper nobody wired in.
const test = require('node:test');
const assert = require('node:assert/strict');
const proxy = require('../proxy/kanbantic-mcp-proxy');

test('channelMeta: drops null/undefined and stringifies everything else', () => {
  const meta = proxy.channelMeta({
    from_session: 'sess-1',
    from_user: null,
    missing: undefined,
    room_is_home: false,
    count: 3,
    label: 'home',
  });

  assert.deepEqual(meta, { from_session: 'sess-1', room_is_home: 'false', count: '3', label: 'home' });
  for (const value of Object.values(meta)) assert.equal(typeof value, 'string');
});

function forwardStub(messages) {
  let served = false;
  return async (body) => {
    const parsed = JSON.parse(body);
    const toolName = parsed.params && parsed.params.name;
    if (toolName === 'get_channel_messages') {
      const payload = served ? [] : messages;
      served = true;
      return [{
        jsonrpc: '2.0',
        id: parsed.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ success: true, messages: payload }) }] },
      }];
    }
    if (toolName === 'acknowledge_channel_delivery') {
      return [{
        jsonrpc: '2.0',
        id: parsed.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ success: true, newlyDeliveredMessageIds: (parsed.params.arguments.messageIds || '').split(',') }) }] },
      }];
    }
    throw new Error(`unexpected internal tool call: ${toolName}`);
  };
}

test('pollRoom: every meta value of the emitted notification is a string, for a session-authored message in a non-home room', async () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('session-1');
  const sent = [];
  proxy.setSendForTest((obj) => sent.push(obj));
  proxy.setForwardForTest(forwardStub([{
    id: 'm-1',
    channelId: 'chan-room',
    content: 'hello',
    authorAgentSessionId: 'other-session', // an agent wrote this: no user id
    authorUserId: null,                     // the null Claude 2.1.277 rejected
    authorDisplayName: 'Reviewer',
    authorType: 'AgentSession',
    messageType: 'Chat',
    sentAt: new Date(Date.now() + 60_000).toISOString(),
  }]));
  proxy.subscribeRoom('chan-room', 'review-room', { home: false }); // the boolean it rejected

  await proxy.pollRoom('chan-room');

  const notifications = sent.filter((m) => m.method === 'notifications/claude/channel');
  assert.equal(notifications.length, 1);
  const { params } = notifications[0];
  assert.equal(typeof params.content, 'string');
  assert.deepEqual(Object.keys(params).sort(), ['content', 'meta']);
  for (const [key, value] of Object.entries(params.meta)) {
    assert.equal(typeof value, 'string', `meta.${key} must be a string, got ${value === null ? 'null' : typeof value}`);
    assert.match(key, /^[A-Za-z0-9_]+$/, `meta key ${key} must be an identifier (Claude drops others silently)`);
  }
  assert.equal('from_user' in params.meta, false); // dropped, not "null"
  assert.equal(params.meta.room_is_home, 'false');
  assert.equal(params.meta.from_session, 'other-session');

  proxy.__resetForTest(); // stops the inbox-poll interval subscribeRoom started; without it node never exits
});
