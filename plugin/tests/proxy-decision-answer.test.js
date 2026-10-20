'use strict';

//
// proxy-decision-answer.test.js — KBT-F742 / KBT-T5195 / KBT-TC4207 (a) (spec KBT-SR643 §Registry)
//
// Two proxy-side pieces of the Beslisbak:
//
//   1. `request_decision` gets this session's own id injected as `fromSessionId`,
//      exactly like `send_message` (KBT-F718 fast-follow). The server records it as
//      RequestedBySessionId, which is where the DecisionAnswer message comes back.
//   2. An inbound channel message with messageType DecisionAnswer (enum 6, or the
//      string "DecisionAnswer" as MCP responses serialise enums) carries a JSON
//      `payload` { decisionRequestId, code, optionKey, via }. The proxy lifts those
//      four fields into the notifications/claude/channel meta so the agent never
//      has to parse the Markdown body. DecisionExpired (7) gets the same treatment
//      (no optionKey).
//
// Unit-level: in-process proxy with stubbed forward/send. The real-process variant
// is decision-request-proxy-e2e.test.js.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const proxy = require('../proxy/kanbantic-mcp-proxy');

function toolCallMsg(name, args, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

const OPTIONS = JSON.stringify([
  { key: 'a', title: 'A', consequence: 'doe A' },
  { key: 'b', title: 'B', consequence: 'doe B' },
]);

// ── 1. fromSessionId injection ───────────────────────────────────────────────

test('request_decision: the registered session id is injected as fromSessionId', () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('sess-1');
  const msg = toolCallMsg('request_decision', { workspaceId: 'ws', question: 'A of B?', optionsJson: OPTIONS, recipientRole: 'ProductOwner', recommendedOptionKey: 'a', rationale: 'omdat' });
  const mutated = proxy.attachFromSessionIdToSendMessageCall(msg);
  assert.equal(mutated, true, 'must report the mutation so the re-serialised body is forwarded');
  assert.equal(msg.params.arguments.fromSessionId, 'sess-1');
  assert.equal(msg.params.arguments.optionsJson, OPTIONS, 'other arguments untouched');
  proxy.__resetForTest();
});

test('request_decision: a caller-supplied fromSessionId is never clobbered', () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('sess-1');
  const msg = toolCallMsg('request_decision', { workspaceId: 'ws', question: 'q', optionsJson: OPTIONS, recipientRole: 'Developer', fromSessionId: 'explicit-other' });
  assert.equal(proxy.attachFromSessionIdToSendMessageCall(msg), false);
  assert.equal(msg.params.arguments.fromSessionId, 'explicit-other');
  proxy.__resetForTest();
});

test('request_decision: no-op before this process has registered', () => {
  proxy.__resetForTest();
  const msg = toolCallMsg('request_decision', { workspaceId: 'ws', question: 'q', optionsJson: OPTIONS, recipientRole: 'Developer' });
  assert.equal(proxy.attachFromSessionIdToSendMessageCall(msg), false);
  assert.equal(msg.params.arguments.fromSessionId, undefined);
  proxy.__resetForTest();
});

test('answer_decision / list_decisions / withdraw_decision get NO fromSessionId (only the requester is attributed)', () => {
  proxy.__resetForTest();
  proxy.__setSessionForTest('sess-1');
  for (const name of ['answer_decision', 'list_decisions', 'withdraw_decision']) {
    const msg = toolCallMsg(name, { decisionRequestId: 'KBT-DR001', optionKey: 'a', reason: 'x'.repeat(12) });
    assert.equal(proxy.attachFromSessionIdToSendMessageCall(msg), false, name);
    assert.equal(msg.params.arguments.fromSessionId, undefined, name);
  }
  proxy.__resetForTest();
});

// ── 2. DecisionAnswer meta on inbound channel messages ───────────────────────

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

const DECISION_PAYLOAD = { decisionRequestId: '3a24-dr-0001', code: 'KBT-DR042', optionKey: 'allow-once', via: 'Inbox' };

function decisionMessage(over = {}) {
  return {
    id: 'm-dr-1',
    channelId: 'chan-home',
    content: '**Besluit op KBT-DR042** — Permissie voor Bash?\nGekozen: **Eenmalig toestaan** (allow-once)\n— PO, 2026-10-20 12:00Z via Inbox',
    authorAgentSessionId: null,
    authorUserId: 'user-po',
    authorDisplayName: 'PO',
    authorType: 'User',
    messageType: 'DecisionAnswer',
    payload: JSON.stringify(DECISION_PAYLOAD),
    sentAt: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
}

async function pollOnce(message) {
  proxy.__resetForTest();
  proxy.__setSessionForTest('session-1');
  const sent = [];
  proxy.setSendForTest((obj) => sent.push(obj));
  proxy.setForwardForTest(forwardStub([message]));
  proxy.subscribeRoom('chan-home', 'home', { home: true });
  try {
    await proxy.pollRoom('chan-home');
  } finally {
    proxy.__resetForTest(); // stops the inbox-poll interval subscribeRoom started
  }
  return sent.filter((m) => m.method === 'notifications/claude/channel');
}

test('DecisionAnswer (string messageType): meta carries decisionRequestId, code, optionKey, via', async () => {
  const notifications = await pollOnce(decisionMessage());
  assert.equal(notifications.length, 1);
  const { params } = notifications[0];
  assert.equal(params.content, decisionMessage().content, 'home channel keeps the exact wire content');
  assert.equal(params.meta.message_type, 'DecisionAnswer');
  assert.equal(params.meta.decisionRequestId, '3a24-dr-0001');
  assert.equal(params.meta.code, 'KBT-DR042');
  assert.equal(params.meta.optionKey, 'allow-once');
  assert.equal(params.meta.via, 'Inbox');
  for (const [key, value] of Object.entries(params.meta)) {
    assert.equal(typeof value, 'string', `meta.${key} must be a string (KBT-B1012)`);
    assert.match(key, /^[A-Za-z0-9_]+$/);
  }
});

test('DecisionAnswer (numeric messageType 6, payload as object): same meta', async () => {
  const notifications = await pollOnce(decisionMessage({ messageType: 6, payload: { ...DECISION_PAYLOAD, via: 'Telegram' } }));
  assert.equal(notifications.length, 1);
  const { meta } = notifications[0].params;
  assert.equal(meta.message_type, '6');
  assert.equal(meta.decisionRequestId, '3a24-dr-0001');
  assert.equal(meta.code, 'KBT-DR042');
  assert.equal(meta.optionKey, 'allow-once');
  assert.equal(meta.via, 'Telegram');
});

test('DecisionExpired (7 / "DecisionExpired"): decisionRequestId and code, no optionKey', async () => {
  for (const messageType of ['DecisionExpired', 7]) {
    const notifications = await pollOnce(decisionMessage({
      id: `m-exp-${messageType}`,
      messageType,
      content: 'Beslisverzoek KBT-DR042 is verlopen zonder antwoord — Permissie voor Bash?',
      payload: JSON.stringify({ decisionRequestId: '3a24-dr-0001', code: 'KBT-DR042', via: 'Mandate' }),
    }));
    assert.equal(notifications.length, 1, String(messageType));
    const { meta } = notifications[0].params;
    assert.equal(meta.decisionRequestId, '3a24-dr-0001');
    assert.equal(meta.code, 'KBT-DR042');
    assert.equal('optionKey' in meta, false, 'no optionKey on an expiry');
  }
});

test('a Chat message gets none of the decision meta keys; a DecisionAnswer with a broken payload is still delivered', async () => {
  const chat = await pollOnce(decisionMessage({ id: 'm-chat', messageType: 'Chat', payload: undefined }));
  assert.equal(chat.length, 1);
  for (const k of ['decisionRequestId', 'code', 'optionKey', 'via']) assert.equal(k in chat[0].params.meta, false, k);

  const broken = await pollOnce(decisionMessage({ id: 'm-broken', payload: '{not json' }));
  assert.equal(broken.length, 1, 'an unparseable payload never drops the message');
  assert.equal(broken[0].params.meta.message_type, 'DecisionAnswer');
  assert.equal('decisionRequestId' in broken[0].params.meta, false);
});

test('a Chat message whose payload happens to be decision-shaped is NOT lifted (only decision message types are)', async () => {
  const chat = await pollOnce(decisionMessage({ id: 'm-chat-2', messageType: 'Chat' }));
  assert.equal(chat.length, 1);
  assert.equal('decisionRequestId' in chat[0].params.meta, false);
});
