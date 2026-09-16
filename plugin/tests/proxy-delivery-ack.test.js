'use strict';

//
// KBT-F723 (KBT-E134 action 7) — "Afleverbevestiging en luister-status zichtbaar in
// /agent-sessions", proxy-side half: after a poll-round successfully forwards one or more
// messages via notifications/claude/channel, pollRoom batches their id's into ONE
// acknowledge_channel_delivery call (not one call per message), and ONLY for the home
// channel (a room-channel message is never this session's own channel to ack for).
//
// Style matches plugin/tests/proxy-delivery-reliability.test.js (KBT-F719): captureSends +
// setForwardForTest, __resetForTest before/after, message() builder.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const proxy = require('../proxy/kanbantic-mcp-proxy');

function captureSends() {
  const sent = [];
  proxy.setSendForTest((obj) => sent.push(obj));
  return sent;
}

const T0 = Date.now() + 60_000;
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

function message(overrides) {
  return {
    id: 'msg-1',
    channelId: 'chan-home',
    content: 'hello',
    authorAgentSessionId: 'other-session',
    authorUserId: null,
    authorDisplayName: 'Reviewer',
    authorType: 'AgentSession',
    messageType: 'Chat',
    sentAt: at(0),
    ...overrides,
  };
}

/** Builds a setForwardForTest handler that answers get_channel_messages with `messages`
 *  once (subsequent polls return empty), and records every acknowledge_channel_delivery
 *  call into `ackCalls`. */
function forwardStub(messages, ackCalls) {
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
      ackCalls.push(parsed.params.arguments);
      return [{
        jsonrpc: '2.0',
        id: parsed.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ success: true, newlyDeliveredMessageIds: (parsed.params.arguments.messageIds || '').split(',') }) }] },
      }];
    }
    throw new Error(`unexpected internal tool call: ${toolName}`);
  };
}

test('pollRoom: batches ALL delivered message-ids from one poll-round into a SINGLE acknowledge_channel_delivery call', async () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('session-1');
  const sent = captureSends();
  const ackCalls = [];
  const msgs = [
    message({ id: 'm-1', sentAt: at(0) }),
    message({ id: 'm-2', sentAt: at(1) }),
  ];
  proxy.setForwardForTest(forwardStub(msgs, ackCalls));
  proxy.subscribeRoom('chan-home', 'home', { home: true });

  await proxy.pollRoom('chan-home');

  assert.equal(sent.length, 2, 'both messages were forwarded via notify');
  assert.equal(ackCalls.length, 1, 'exactly ONE ack call for the whole poll-round, not one per message');
  assert.equal(ackCalls[0].sessionId, 'session-1');
  const ackedIds = ackCalls[0].messageIds.split(',');
  assert.deepEqual(ackedIds.sort(), ['m-1', 'm-2'], 'both delivered message-ids are batched into the single ack');

  proxy.__resetForTest();
});

// MUTATION_CHECK — this test actually makes __sendImpl throw for one specific message and
// asserts that message's id is excluded from the ack. Removing the try/catch guard around
// __sendImpl in pollRoom (or the `if (current.home && msg.id) deliveredMessageIds.push(...)`
// placement inside the try-block) would let this failing message's id leak into the ack
// anyway, and this assertion would fail.
test('pollRoom: a message whose notify-send THROWS is never included in the delivery-ack', async () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('session-1');
  const ackCalls = [];
  const msgs = [
    message({ id: 'ok-1', sentAt: at(0) }),
    message({ id: 'fails-1', sentAt: at(1) }),
    message({ id: 'ok-2', sentAt: at(2) }),
  ];
  proxy.setForwardForTest(forwardStub(msgs, ackCalls));
  proxy.setSendForTest((obj) => {
    if (obj.params && obj.params.meta && obj.params.meta.message_id === 'fails-1') {
      throw new Error('stdout write failed (EPIPE)');
    }
  });
  proxy.subscribeRoom('chan-home', 'home', { home: true });

  await proxy.pollRoom('chan-home');

  assert.equal(ackCalls.length, 1);
  const ackedIds = ackCalls[0].messageIds.split(',');
  assert.deepEqual(ackedIds.sort(), ['ok-1', 'ok-2'], '"fails-1" must never be reported as delivered');
  assert.ok(!ackedIds.includes('fails-1'));

  proxy.__resetForTest();
});

test('pollRoom: a NON-home room never triggers an acknowledge_channel_delivery call', async () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('session-1');
  captureSends();
  const ackCalls = [];
  const msgs = [message({ id: 'room-msg-1', channelId: 'chan-room', sentAt: at(0) })];
  proxy.setForwardForTest(forwardStub(msgs, ackCalls));
  // Deliberately NOT home — a shared/room channel is never this session's OWN channel.
  proxy.subscribeRoom('chan-room', 'room-x', { home: false });

  await proxy.pollRoom('chan-room');

  assert.equal(ackCalls.length, 0, 'no ack call is made for a message delivered via a non-home room');

  proxy.__resetForTest();
});

test('pollRoom: no messages this round → no ack call at all (not even an empty one)', async () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('session-1');
  captureSends();
  const ackCalls = [];
  proxy.setForwardForTest(forwardStub([], ackCalls));
  proxy.subscribeRoom('chan-home', 'home', { home: true });

  await proxy.pollRoom('chan-home');

  assert.equal(ackCalls.length, 0);

  proxy.__resetForTest();
});
