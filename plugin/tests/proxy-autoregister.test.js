const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proxy = require('../proxy/kanbantic-mcp-proxy');

// KBT-E102 F2 — auto-register guard (backward-compat), correct register call, idempotency, failure handling.

test('shouldAutoRegister: false without KANBANTIC_WORKSPACE_ID (backward-compat)', () => {
  delete process.env.KANBANTIC_WORKSPACE_ID;
  process.env.KANBANTIC_API_KEY = 'ka_test';
  proxy.__resetForTest();
  assert.strictEqual(proxy.shouldAutoRegister(), false);
});

test('shouldAutoRegister: true with workspace-id + key when not started', () => {
  process.env.KANBANTIC_WORKSPACE_ID = 'ws-1';
  process.env.KANBANTIC_API_KEY = 'ka_test';
  proxy.__resetForTest();
  assert.strictEqual(proxy.shouldAutoRegister(), true);
});

// KBT-F551 review Minor (Axon 03): the `&& !!API_KEY` clause of shouldAutoRegister() was not
// mutation-covered — no test drove "workspace-id present + key absent → false". A keyless agent
// cannot authenticate, so it must never auto-register even with a workspace-id. Dropping the
// `&& !!API_KEY` term flips this to true, so this test now bites that mutation.
test('shouldAutoRegister: false with workspace-id but WITHOUT KANBANTIC_API_KEY (the key-guard)', () => {
  process.env.KANBANTIC_WORKSPACE_ID = 'ws-1';
  delete process.env.KANBANTIC_API_KEY;
  proxy.__resetForTest();
  assert.strictEqual(proxy.shouldAutoRegister(), false);
});

test('autoRegister: sends correct register call (workspace/workstation/spawnCommandId) + idempotent', async () => {
  process.env.KANBANTIC_WORKSPACE_ID = 'ws-1';
  process.env.KANBANTIC_API_KEY = 'ka_test';
  process.env.KANBANTIC_WORKSTATION_ID = 'st-1';
  process.env.KANBANTIC_SPAWN_COMMAND_ID = 'cmd-1';
  proxy.__resetForTest();

  const forwarded = [];
  proxy.setForwardForTest(async (body) => {
    const msg = JSON.parse(body);
    forwarded.push(msg);
    return [{
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: 's1', channelId: 'c1' }) }] },
    }];
  });

  await proxy.autoRegister();
  proxy.stopInboxPoll(); // clean the inbox timer before it can fire a real poll
  try { fs.unlinkSync(path.join(os.homedir(), '.claude-kanbantic-session.json')); } catch { /* may not exist */ }

  assert.strictEqual(forwarded.length, 1);
  assert.strictEqual(forwarded[0].params.name, 'register_agent_session');
  assert.strictEqual(forwarded[0].params.arguments.workspaceId, 'ws-1');
  assert.strictEqual(forwarded[0].params.arguments.workstationId, 'st-1');
  assert.strictEqual(forwarded[0].params.arguments.spawnCommandId, 'cmd-1');

  // Idempotent: a second call is a no-op (slot already claimed).
  forwarded.length = 0;
  await proxy.autoRegister();
  assert.strictEqual(forwarded.length, 0);
});

test('autoRegister: host falls back to os.hostname(); optional ids omitted when unset', async () => {
  process.env.KANBANTIC_WORKSPACE_ID = 'ws-1';
  process.env.KANBANTIC_API_KEY = 'ka_test';
  delete process.env.KANBANTIC_HOST;
  delete process.env.KANBANTIC_WORKSTATION_ID;
  delete process.env.KANBANTIC_SPAWN_COMMAND_ID;
  proxy.__resetForTest();

  const forwarded = [];
  proxy.setForwardForTest(async (body) => {
    const msg = JSON.parse(body);
    forwarded.push(msg);
    return [{
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: 's2', channelId: 'c2' }) }] },
    }];
  });

  await proxy.autoRegister();
  proxy.stopInboxPoll();
  try { fs.unlinkSync(path.join(os.homedir(), '.claude-kanbantic-session.json')); } catch { /* may not exist */ }

  const args = forwarded[0].params.arguments;
  assert.strictEqual(args.host, os.hostname());
  assert.strictEqual(args.cwd, process.cwd());
  assert.ok(!('workstationId' in args));
  assert.ok(!('spawnCommandId' in args));
});

test('autoRegister: 403 failure does not crash (finite retry, slot claimed)', async () => {
  process.env.KANBANTIC_WORKSPACE_ID = 'ws-1';
  process.env.KANBANTIC_API_KEY = 'ka_test';
  proxy.__resetForTest();
  proxy.setForwardForTest(async () => { throw new Error('HTTP 403: Forbidden'); });

  await proxy.autoRegister(); // must not throw
  assert.strictEqual(proxy.shouldAutoRegister(), false); // idempotent: slot claimed
});
