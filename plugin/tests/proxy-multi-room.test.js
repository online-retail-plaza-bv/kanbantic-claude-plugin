// SPIKE (multi-room) — an agent listens to N channels instead of exactly one.
//
// The question the spike asks is whether one agent can hold several concurrent rooms
// without losing the thread. These tests pin the mechanics that have to be right before
// that question can even be asked: per-room cursor isolation, no backlog replay on join,
// no echo of the agent's own posts, and join/leave that survives a drain in flight.
const test = require('node:test');
const assert = require('node:assert/strict');
const proxy = require('../proxy/kanbantic-mcp-proxy');

// Builds a forward-stub that answers get_channel_messages from a per-channel script.
// Each channel's entry is consumed once per poll, so a second poll sees an empty inbox
// unless the script supplies another batch.
function stubChannels(batchesByChannel, seen) {
  proxy.setForwardForTest(async (body) => {
    const parsed = JSON.parse(body);
    const { channelId, after } = parsed.params.arguments;
    if (seen) seen.push({ channelId, after });
    const queue = batchesByChannel[channelId] || [];
    const messages = queue.shift() || [];
    return [{
      jsonrpc: '2.0',
      id: parsed.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, messages }) }] },
    }];
  });
}

function captureSends() {
  const sent = [];
  proxy.setSendForTest((obj) => sent.push(obj));
  return sent;
}

// Joining a room sets its cursor to 'now', so fixtures must be dated after the join —
// exactly like real traffic, which only ever arrives once you are listening.
const T0 = Date.now() + 60_000;
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

function message(overrides) {
  return {
    id: 'msg-1',
    channelId: 'chan-a',
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

test('join_room: subscribes, is idempotent, and refuses beyond the spike cap', () => {
  proxy.__resetForTest();

  const first = proxy.subscribeRoom('chan-a', 'KBT-B123');
  assert.equal(first.ok, true);
  assert.equal(first.alreadyJoined, false);
  assert.equal(first.label, 'KBT-B123');

  const again = proxy.subscribeRoom('chan-a', 'renamed');
  assert.equal(again.alreadyJoined, true, 'second join is a no-op, not a duplicate');
  assert.equal(again.label, 'renamed', 'a re-join may relabel');
  assert.equal(proxy.listRooms().length, 1);

  for (let i = 1; i < proxy.MAX_ROOM_SUBSCRIPTIONS; i++) {
    assert.equal(proxy.subscribeRoom(`chan-${i}`).ok, true);
  }
  const overflow = proxy.subscribeRoom('one-too-many');
  assert.equal(overflow.ok, false, 'the cap is enforced, not silently exceeded');
  assert.match(overflow.reason, /spike cap/);

  assert.equal(proxy.subscribeRoom('').ok, false, 'a missing channelId is rejected');
  proxy.__resetForTest();
});

test('leave_room: removes a room but never the home channel', () => {
  proxy.__resetForTest();
  proxy.subscribeRoom('chan-home', 'home', { home: true });
  proxy.subscribeRoom('chan-guest', 'guest');

  assert.equal(proxy.unsubscribeRoom('chan-guest').ok, true);
  assert.equal(proxy.listRooms().length, 1);

  const leaveHome = proxy.unsubscribeRoom('chan-home');
  assert.equal(leaveHome.ok, false, 'the session channel is not leavable');
  assert.match(leaveHome.reason, /home channel/);

  assert.equal(proxy.unsubscribeRoom('never-joined').ok, false);
  proxy.__resetForTest();
});

test('pollInbox: polls every subscribed room and keeps cursors independent', async () => {
  proxy.__resetForTest();
  const sent = captureSends();
  const seen = [];
  stubChannels({
    'chan-a': [[message({ id: 'a1', channelId: 'chan-a', sentAt: at(0) })]],
    'chan-b': [[message({ id: 'b1', channelId: 'chan-b', sentAt: at(7_200_000) })]],
  }, seen);

  proxy.subscribeRoom('chan-a', 'room-a');
  proxy.subscribeRoom('chan-b', 'room-b');
  await proxy.pollInbox();

  assert.equal(seen.length, 2, 'both rooms are polled in one tick');
  assert.equal(sent.length, 2, 'both messages reach the host');

  const rooms = Object.fromEntries(proxy.listRooms().map((r) => [r.channelId, r.cursor]));
  assert.equal(rooms['chan-a'], at(0));
  assert.equal(rooms['chan-b'], at(7_200_000));
  assert.notEqual(rooms['chan-a'], rooms['chan-b'], 'one room may not advance another');

  // A second tick must ask each room only for what came after its own cursor.
  seen.length = 0;
  await proxy.pollInbox();
  const asked = Object.fromEntries(seen.map((s) => [s.channelId, s.after]));
  assert.equal(asked['chan-a'], at(0));
  assert.equal(asked['chan-b'], at(7_200_000));

  proxy.__resetForTest();
});

test('pollInbox: labels non-home rooms in the content, leaves the home channel verbatim', async () => {
  proxy.__resetForTest();
  const sent = captureSends();
  stubChannels({
    'chan-home': [[message({ id: 'h1', channelId: 'chan-home', content: 'from the operator' })]],
    'chan-bug': [[message({ id: 'g1', channelId: 'chan-bug', content: 'build is red' })]],
  });

  proxy.subscribeRoom('chan-home', 'home', { home: true });
  proxy.subscribeRoom('chan-bug', 'KBT-B123');
  await proxy.pollInbox();

  const byId = Object.fromEntries(sent.map((s) => [s.params.meta.message_id, s.params]));
  assert.equal(byId.h1.content, 'from the operator', 'home keeps its exact wire format');
  assert.equal(byId.h1.meta.room_is_home, true);
  assert.equal(byId.g1.content, '[KBT-B123] build is red', 'a room announces itself in-band');
  assert.equal(byId.g1.meta.room_label, 'KBT-B123');
  assert.equal(byId.g1.meta.from_display_name, 'Reviewer');

  proxy.__resetForTest();
});

test('pollInbox: does not echo the agent\'s own posts, but still advances the cursor', async () => {
  proxy.__resetForTest();
  const sent = captureSends();
  stubChannels({
    'chan-a': [[
      message({ id: 'mine', authorAgentSessionId: 'me', sentAt: at(0) }),
      message({ id: 'theirs', authorAgentSessionId: 'them', sentAt: at(1000) }),
    ]],
  });
  proxy.__setSessionForTest('me');
  proxy.subscribeRoom('chan-a', 'room-a');

  await proxy.pollInbox();

  assert.equal(sent.length, 1, 'only the other participant is pushed into context');
  assert.equal(sent[0].params.meta.message_id, 'theirs');
  assert.equal(
    proxy.listRooms()[0].cursor,
    at(1000),
    'a skipped own-message must not be re-fetched forever',
  );

  proxy.__resetForTest();
});

test('joining a room starts at now, so no backlog is replayed into context', () => {
  proxy.__resetForTest();
  const before = Date.now();
  proxy.subscribeRoom('chan-a', 'room-a');
  const cursor = Date.parse(proxy.listRooms()[0].cursor);
  assert.ok(cursor >= before && cursor <= Date.now(), 'cursor is initialized at join time');
  proxy.__resetForTest();
});

test('handleLocalRoomTool: answers the room tools locally and passes everything else through', () => {
  proxy.__resetForTest();

  const join = proxy.handleLocalRoomTool({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'join_room', arguments: { channelId: 'chan-a', label: 'KBT-B123' } },
  });
  assert.equal(join.id, 7);
  assert.deepEqual(JSON.parse(join.result.content[0].text), {
    success: true, alreadyJoined: false, channelId: 'chan-a', label: 'KBT-B123',
  });

  const list = proxy.handleLocalRoomTool({
    jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'list_rooms' },
  });
  const listed = JSON.parse(list.result.content[0].text);
  assert.equal(listed.success, true);
  assert.equal(listed.rooms.length, 1);
  assert.equal(listed.rooms[0].channelId, 'chan-a');

  const leave = proxy.handleLocalRoomTool({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'leave_room', arguments: { channelId: 'chan-a' } },
  });
  assert.equal(JSON.parse(leave.result.content[0].text).success, true);
  assert.equal(proxy.listRooms().length, 0);

  // A server tool must fall through to the normal forward path.
  assert.equal(
    proxy.handleLocalRoomTool({
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'send_message', arguments: { channelId: 'chan-a', content: 'hi' } },
    }),
    null,
  );
  assert.equal(proxy.handleLocalRoomTool({ jsonrpc: '2.0', id: 11, method: 'initialize' }), null);

  proxy.__resetForTest();
});

test('injectRoomToolsIntoList: advertises the room tools exactly once', () => {
  const response = { result: { tools: [{ name: 'send_message', description: 'x' }] } };
  proxy.injectRoomToolsIntoList(response);
  proxy.injectRoomToolsIntoList(response); // second tools/list must not duplicate

  const names = response.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['send_message', 'join_room', 'leave_room', 'list_rooms']);
  for (const t of response.result.tools.slice(1)) {
    assert.ok(t.description, 'each injected tool carries a description');
    assert.equal(t.inputSchema.type, 'object');
  }

  // A malformed response must be tolerated, not thrown on.
  proxy.injectRoomToolsIntoList({ result: {} });
  proxy.injectRoomToolsIntoList(null);
});
