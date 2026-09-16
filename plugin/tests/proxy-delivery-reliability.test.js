'use strict';

//
// KBT-F719 (KBT-E134 action 3) — "Berichtbezorging naar agents zonder verlies of
// duplicaten". These tests pin the proxy-side half of the fix (the server-side
// composite-cursor fix lives in Kanbantic.Application/AgentSessions/
// AgentChannelAppService.cs, in the kanbantic repo):
//
//   - overlap guard: a single-flight poll loop, so a slow (up to 120s) call can never
//     let the next 1s tick start a second, overlapping round of the SAME channel.
//   - dedup on message id: a client-side backstop, independent of cause (overlap,
//     or the server's own >= widening around an exact-timestamp tie).
//   - composite cursor: (cursorAt, cursorId) is read from / written to the
//     subscription and threaded through to get_channel_messages(after, afterId).
//   - archived-channel handling: end_agent_session archives the channel server-side
//     (KBT-F721 finding) — that is a terminal condition, not a transient failure, and
//     must stop polling that room instead of retrying forever.
//   - backoff on transient failure: a failed poll must not retry on the very next
//     tick; it must wait out a computed backoff window first.
//   - cursor persistence/resume: a restarted proxy for the SAME logical Claude Code
//     session (same CLAUDE_CODE_SESSION_ID) resumes a channel from its last
//     persisted cursor instead of defaulting to 'now' (a gap).
//
// Style matches plugin/tests/proxy-multi-room.test.js (stubChannels/captureSends
// helpers, __resetForTest before/after) and plugin/tests/proxy-session-state.test.js
// (HOME/USERPROFILE + CLAUDE_CODE_SESSION_ID redirection for session-file tests).
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('pollInbox: overlap guard — a tick that is still in flight blocks a concurrent second tick', async () => {
  proxy.__resetForTest();
  let calls = 0;
  let releaseFirstCall;
  const firstCallGate = new Promise((resolve) => { releaseFirstCall = resolve; });
  proxy.setForwardForTest(async (body) => {
    calls++;
    // Only the FIRST call blocks — that is the one whose overlap the guard must catch.
    if (calls === 1) await firstCallGate;
    const parsed = JSON.parse(body);
    return [{
      jsonrpc: '2.0',
      id: parsed.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, messages: [] }) }] },
    }];
  });
  proxy.subscribeRoom('chan-a', 'room-a');

  const firstTick = proxy.pollInbox(); // not awaited — still in flight
  assert.equal(proxy.__isPollInFlightForTest(), true, 'the guard flag is set while a tick is running');
  await proxy.pollInbox(); // a second tick fired "on schedule" while the first is still running
  assert.equal(calls, 1, 'the overlapping tick must be a no-op, not a second round of calls');

  releaseFirstCall();
  await firstTick;
  assert.equal(proxy.__isPollInFlightForTest(), false, 'the guard is released once the tick completes');

  proxy.__resetForTest();
});

test('pollRoom: dedups an already-delivered message id even if the server re-sends it', async () => {
  proxy.__resetForTest();
  const sent = captureSends();
  const dup = message({ id: 'dup-1', sentAt: at(0) });
  let call = 0;
  proxy.setForwardForTest(async (body) => {
    call++;
    const parsed = JSON.parse(body);
    // The server re-sends the SAME message on both polls (e.g. the >= widening around
    // an exact-timestamp tie re-matching a row the caller already has).
    return [{
      jsonrpc: '2.0',
      id: parsed.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, messages: [dup] }) }] },
    }];
  });
  proxy.subscribeRoom('chan-a', 'room-a');

  await proxy.pollRoom('chan-a');
  await proxy.pollRoom('chan-a');

  assert.equal(call, 2, 'both polls actually ran');
  assert.equal(sent.length, 1, 'the second, duplicate delivery must never reach the host');
  proxy.__resetForTest();
});

test('pollRoom: advances the composite cursor and sends afterId on the next poll', async () => {
  proxy.__resetForTest();
  captureSends();
  const seenArgs = [];
  const m1 = message({ id: 'm-1', sentAt: at(0) });
  let batch = [m1];
  proxy.setForwardForTest(async (body) => {
    const parsed = JSON.parse(body);
    seenArgs.push(parsed.params.arguments);
    const messages = batch;
    batch = [];
    return [{
      jsonrpc: '2.0',
      id: parsed.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, messages }) }] },
    }];
  });
  proxy.subscribeRoom('chan-a', 'room-a');

  await proxy.pollRoom('chan-a');
  const rooms1 = proxy.listRooms();
  assert.equal(rooms1[0].cursor, at(0), 'cursorAt advances to the last message it saw');

  await proxy.pollRoom('chan-a');
  assert.equal(seenArgs[1].after, at(0), 'the second poll asks after the advanced cursor');
  assert.equal(seenArgs[1].afterId, 'm-1', 'the second poll includes the composite-cursor tiebreak id');

  proxy.__resetForTest();
});

test('pollRoom: a same-timestamp tie spanning two pages advances by trusting server order, not by comparing ids', async () => {
  // hoofdagent-review (KBT-F719, PR #88 round 1) — the server's tiebreak is
  // Guid.CompareTo, which does NOT sort a GUID's string form lexicographically.
  // Deliberately pick ids whose STRING order is the *opposite* of the order the server
  // places them in, so a comparison-based (wrong) fix and a trust-the-order (correct) fix
  // disagree on the outcome, and this test can only pass with the latter.
  proxy.__resetForTest();
  captureSends();
  const tie = at(0);
  const first = message({ id: 'z-arrived-first', sentAt: tie });
  const second = message({ id: 'm-arrived-second', sentAt: tie });
  const third = message({ id: 'a-arrived-third', sentAt: tie }); // lexicographically smallest, but LAST in server order
  const seenArgs = [];
  let pageIndex = 0;
  const pages = [[first], [second, third], []];
  proxy.setForwardForTest(async (body) => {
    const parsed = JSON.parse(body);
    seenArgs.push(parsed.params.arguments);
    const batch = pages[pageIndex] || [];
    pageIndex++;
    return [{
      jsonrpc: '2.0',
      id: parsed.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, messages: batch }) }] },
    }];
  });
  proxy.subscribeRoom('chan-a', 'room-a');

  await proxy.pollRoom('chan-a'); // page 1: [first]
  await proxy.pollRoom('chan-a'); // page 2: [second, third] — third is server-last despite its id "looking" smallest
  await proxy.pollRoom('chan-a'); // page 3: empty — just to observe what afterId this poll sent

  assert.equal(seenArgs[2].afterId, 'a-arrived-third', 'the cursor lands on the LAST message the server returned, not the lexicographically-largest id');
  proxy.__resetForTest();
});

test('pollRoom: the next poll after a tied batch sends the LAST message of that batch as afterId, regardless of id string order', async () => {
  proxy.__resetForTest();
  captureSends();
  const tie = at(0);
  const second = message({ id: 'm-arrived-second', sentAt: tie });
  const third = message({ id: 'a-arrived-third', sentAt: tie }); // lexicographically smallest, but LAST in server order
  const seenArgs = [];
  let batch = [second, third];
  proxy.setForwardForTest(async (body) => {
    const parsed = JSON.parse(body);
    seenArgs.push(parsed.params.arguments);
    const out = batch;
    batch = [];
    return [{
      jsonrpc: '2.0',
      id: parsed.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, messages: out }) }] },
    }];
  });
  proxy.subscribeRoom('chan-a', 'room-a');

  await proxy.pollRoom('chan-a'); // delivers [second, third] in one page
  await proxy.pollRoom('chan-a'); // asks for what comes after them

  assert.equal(seenArgs[1].afterId, 'a-arrived-third', 'the cursor lands on the batch\'s last message, not the lexicographically-largest id');
  proxy.__resetForTest();
});

test('pollRoom: a same-instant tie serialized with different fractional-second precision across polls does not stall the cursor', async () => {
  // hoofdagent-review (KBT-F719, PR #88 round 1) — SentAt.ToString("O")-style
  // serialization is not guaranteed to have fixed fractional-second precision; the exact
  // same instant can round-trip as "...T03:00:00Z" from one call and
  // "...T03:00:00.000Z" from another. A string comparison (`msg.sentAt > cursorAt`) can
  // disagree with the true chronological/tiebreak order on inputs like these:
  // ".000Z" < "Z" lexicographically ('.' sorts before 'Z'), so a message arriving in the
  // fractional-second form AFTER one that arrived in the bare-"Z" form would, under a
  // string comparison, look neither greater-than nor equal-to the current cursor — the
  // cursor would silently STALL instead of advancing, and every subsequent poll would
  // re-request (and, without the id-based dedup backstop, re-deliver) from that stale
  // point forever. Two SEPARATE polls (not one batch) is deliberate: this is a
  // cross-poll cursor-carry bug, not a same-batch ordering bug (see the two tests above
  // for that one).
  proxy.__resetForTest();
  captureSends();
  const withoutMillis = '2027-03-01T00:00:00Z'; // same instant, no fractional seconds
  const withMillis = '2027-03-01T00:00:00.000Z'; // same instant, ".000Z" form — server-later message
  const m1 = message({ id: 'm-1', sentAt: withoutMillis });
  const m2 = message({ id: 'm-2', sentAt: withMillis }); // server places this AFTER m1 despite the "smaller-looking" string
  const seenArgs = [];
  let pageIndex = 0;
  const pages = [[m1], [m2], []];
  proxy.setForwardForTest(async (body) => {
    const parsed = JSON.parse(body);
    seenArgs.push(parsed.params.arguments);
    const batch = pages[pageIndex] || [];
    pageIndex++;
    return [{
      jsonrpc: '2.0',
      id: parsed.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, messages: batch }) }] },
    }];
  });
  proxy.subscribeRoom('chan-a', 'room-a');

  await proxy.pollRoom('chan-a'); // page 1: [m1] — cursor becomes m1
  await proxy.pollRoom('chan-a'); // page 2: [m2] — cursor must become m2, not stall at m1
  await proxy.pollRoom('chan-a'); // page 3: empty — observe what afterId this poll sent

  assert.equal(seenArgs[2].afterId, 'm-2', 'the cursor advances past a differently-formatted same-instant message instead of stalling');
  proxy.__resetForTest();
});

// KBT-F726 — this is defensive-handling coverage, not a production-behavior proof. The real
// AgentChannelAppService.GetMessagesAsync never raises `AgentChannel.Archived` (only the write
// side, PostMessageAsync, does — see KBT-F722's Stale/Done distinction), so this exact response
// shape never comes from the live server today (KBT-T4610, cancelled — the read-side gap was
// deliberately left as-is). This test proves pollRoom stops polling correctly IF the server
// ever returns this error, via a mocked forward — it does not exercise the real read path.
test('pollRoom: a hypothetical AgentChannel.Archived error is handled as terminal — the room is marked archived and never polled again', async () => {
  proxy.__resetForTest();
  captureSends();
  let calls = 0;
  proxy.setForwardForTest(async (body) => {
    calls++;
    const parsed = JSON.parse(body);
    return [{
      jsonrpc: '2.0',
      id: parsed.id,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            errorMessage: 'Kanbantic:AgentChannel.Archived: This channel has been archived and no longer accepts messages.',
          }),
        }],
      },
    }];
  });
  proxy.subscribeRoom('chan-a', 'room-a');

  await proxy.pollRoom('chan-a');
  assert.equal(calls, 1);
  assert.equal(proxy.listRooms()[0].archived, true, 'the room is flagged archived, not silently ignored');

  await proxy.pollRoom('chan-a');
  await proxy.pollRoom('chan-a');
  assert.equal(calls, 1, 'an archived room must never be polled again — retrying forever would be pointless');

  proxy.__resetForTest();
});

test('pollRoom: a transient failure backs off instead of retrying on the very next tick', async () => {
  proxy.__resetForTest();
  captureSends();
  let calls = 0;
  proxy.setForwardForTest(async () => {
    calls++;
    throw new Error('ECONNRESET (simulated transient network failure)');
  });
  proxy.subscribeRoom('chan-a', 'room-a');

  await proxy.pollRoom('chan-a');
  assert.equal(calls, 1);

  // Immediately retrying (as the next 1s tick would) must be blocked by the backoff
  // window computeBackoffMs() just set — otherwise a persistent outage becomes a tight
  // retry loop instead of a backed-off one.
  await proxy.pollRoom('chan-a');
  assert.equal(calls, 1, 'a poll still inside its backoff window must not call out again');

  proxy.__resetForTest();
});

test('computeBackoffMs: grows with failCount, is capped, and always includes non-negative jitter', () => {
  const b1 = proxy.computeBackoffMs(1);
  const b2 = proxy.computeBackoffMs(2);
  const b3 = proxy.computeBackoffMs(3);
  assert.ok(b1 >= 1000 && b1 < 2000, `first failure backs off ~1 base interval (got ${b1})`);
  assert.ok(b2 >= 2000 && b2 < 3000, `second failure backs off further (got ${b2})`);
  assert.ok(b3 >= 4000 && b3 < 5000, `growth is exponential (got ${b3})`);
  const bHuge = proxy.computeBackoffMs(50);
  assert.ok(bHuge < 31_000, 'backoff is capped, not unbounded');
});

test('rememberMessageId: true exactly once per id, then false; bounded so it cannot leak memory forever', () => {
  proxy.__resetForTest();
  assert.equal(proxy.rememberMessageId('a'), true, 'first sighting is new');
  assert.equal(proxy.rememberMessageId('a'), false, 'second sighting of the same id is a dup');
  assert.equal(proxy.rememberMessageId('b'), true, 'a different id is independent');
  proxy.__resetForTest();
});

// --- cursor persistence / resume across a restart ---------------------------

async function withRedirectedHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f719-proxy-cursor-'));
  const savedUserProfile = process.env.USERPROFILE;
  const savedHomeEnv = process.env.HOME;
  const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.CLAUDE_CODE_SESSION_ID = 'kbt-f719-cursor-test';
  try {
    return await fn(home);
  } finally {
    process.env.USERPROFILE = savedUserProfile;
    process.env.HOME = savedHomeEnv;
    if (savedSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedSid;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('subscribeRoom: resumes a persisted cursor written by a PREVIOUS instance of this same session (no gap, no replay)', async () => {
  proxy.__resetForTest();
  await withRedirectedHome(async () => {
    proxy.__setFullSessionForTest('sess-1', 'chan-home');
    // Simulate a PREVIOUS proxy instance for this exact session having already advanced
    // the cursor for chan-a and persisted it before exiting/crashing.
    fs.writeFileSync(proxy.sessionFilePath(), JSON.stringify({
      sessionId: 'sess-1',
      channelId: 'chan-home',
      cursors: { 'chan-a': { at: at(500), id: 'previously-seen' } },
    }));

    const result = proxy.subscribeRoom('chan-a', 'room-a');
    assert.equal(result.ok, true);
    assert.equal(proxy.listRooms()[0].cursor, at(500), 'resumes from the persisted cursor, not "now"');
  });
  proxy.__resetForTest();
});

test('subscribeRoom: a persisted cursor for a DIFFERENT session id is never trusted', async () => {
  proxy.__resetForTest();
  await withRedirectedHome(async () => {
    proxy.__setFullSessionForTest('sess-current', 'chan-home');
    fs.writeFileSync(proxy.sessionFilePath(), JSON.stringify({
      sessionId: 'sess-OTHER', // a foreign/stale file
      channelId: 'chan-home',
      cursors: { 'chan-a': { at: at(500), id: 'previously-seen' } },
    }));

    const before = Date.now();
    proxy.subscribeRoom('chan-a', 'room-a');
    const cursor = Date.parse(proxy.listRooms()[0].cursor);
    assert.ok(cursor >= before, 'a foreign session id must never seed this session\'s cursor — falls back to now');
  });
  proxy.__resetForTest();
});

test('writeSessionFile: persists the current cursor of every subscribed room', async () => {
  proxy.__resetForTest();
  await withRedirectedHome(async () => {
    proxy.__setFullSessionForTest('sess-1', 'chan-home');
    captureSends();
    const m1 = message({ id: 'm-1', channelId: 'chan-a', sentAt: at(0) });
    proxy.setForwardForTest(async (body) => {
      const parsed = JSON.parse(body);
      return [{
        jsonrpc: '2.0',
        id: parsed.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ success: true, messages: [m1] }) }] },
      }];
    });
    proxy.subscribeRoom('chan-a', 'room-a');
    await proxy.pollRoom('chan-a');

    const written = JSON.parse(fs.readFileSync(proxy.sessionFilePath(), 'utf8'));
    assert.equal(written.cursors['chan-a'].at, at(0));
    assert.equal(written.cursors['chan-a'].id, 'm-1');
  });
  proxy.__resetForTest();
});
