'use strict';

//
// hooks-session-state.test.js — KBT-F741 / KBT-T5188 (spec KBT-SR637, SEC063 §1/§5)
//
// The session-state hooks report what Claude Code is doing (waiting for the
// user, running a tool, starting a turn, going idle) to the Kanbantic API so a
// hang can be told apart from real work. Each script is spawned as a real child
// process with a stub stdin payload against a local http stub on 127.0.0.1.
//
// Every failure path must be fail-open: exit 0, empty stdout. A monitoring hook
// that can wedge a session on its own malfunction is worse than no monitoring.
//
// `require`s of the lib are lazy (inside the tests) so a missing module shows up
// as individually named failures, not as one crashed file.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  HOOKS_DIR, mkTmp, rmTmp, startApiStub, closedPort, runScript, writeSessionFile, hookEnv,
} = require('./helpers/hook-harness.js');

const lib = () => require('../hooks/lib/session-api.js');

const SID = 'SESS-1';
const base = `/api/app/agent-session/${SID}`;

async function withEnv(fn, { stubResponder, session = {} } = {}) {
  const dir = mkTmp();
  const stub = await startApiStub(stubResponder);
  writeSessionFile(dir, session);
  try {
    return await fn({ dir, stub, env: hookEnv(dir, stub) });
  } finally {
    await stub.close();
    rmTmp(dir);
  }
}

// ── Notification ─────────────────────────────────────────────────────────────

test('notification-session-state: posts wait-for-user with "[type] title: message"', async () => {
  await withEnv(async ({ stub, env }) => {
    const r = await runScript('notification-session-state.js', {
      env,
      stdin: {
        hook_event_name: 'Notification', session_id: 's1',
        notification_type: 'permission_prompt', title: 'Permission needed',
        message: 'Claude needs your permission to use Bash',
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(stub.calls.length, 1);
    const c = stub.calls[0];
    assert.equal(c.method, 'POST');
    assert.equal(c.url, `${base}/wait-for-user`);
    assert.equal(c.headers['x-api-key'], 'test');
    assert.match(c.headers['content-type'], /application\/json/);
    assert.deepEqual(c.body, {
      prompt: '[permission_prompt] Permission needed: Claude needs your permission to use Bash',
    });
  });
});

test('notification-session-state: without title the prompt is "[type] message"', async () => {
  await withEnv(async ({ stub, env }) => {
    await runScript('notification-session-state.js', {
      env,
      stdin: { hook_event_name: 'Notification', session_id: 's1', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
    });
    assert.equal(stub.calls[0].body.prompt, '[idle_prompt] Claude is waiting for your input');
  });
});

test('notification-session-state: prompt is capped at 2000 chars', async () => {
  await withEnv(async ({ stub, env }) => {
    await runScript('notification-session-state.js', {
      env,
      stdin: { hook_event_name: 'Notification', session_id: 's1', notification_type: 'agent_needs_input', title: 'T', message: 'x'.repeat(5000) },
    });
    assert.ok(stub.calls[0].body.prompt.length <= 2000);
    assert.ok(stub.calls[0].body.prompt.startsWith('[agent_needs_input] T: xxx'));
  });
});

test('notification-session-state: secrets in the message are redacted (SEC063 §1)', async () => {
  await withEnv(async ({ stub, env }) => {
    await runScript('notification-session-state.js', {
      env,
      stdin: { hook_event_name: 'Notification', session_id: 's1', notification_type: 'permission_prompt', title: 'T', message: 'run curl -H "Authorization: Bearer abc123def" --password=hunter2' },
    });
    const p = stub.calls[0].body.prompt;
    assert.ok(p.includes('***'));
    assert.ok(!p.includes('abc123def'));
    assert.ok(!p.includes('hunter2'));
  });
});

test('notification-session-state: other notification types are ignored', async () => {
  await withEnv(async ({ stub, env }) => {
    const r = await runScript('notification-session-state.js', {
      env,
      stdin: { hook_event_name: 'Notification', session_id: 's1', notification_type: 'auth_success', message: 'ok' },
    });
    assert.equal(r.status, 0);
    assert.equal(stub.calls.length, 0);
  });
});

// ── tool-activity ────────────────────────────────────────────────────────────

test('tool-activity --pre: posts { toolName, toolUseId, startedAt } and nothing else', async () => {
  await withEnv(async ({ stub, env }) => {
    const before = Date.now();
    const r = await runScript('tool-activity.js', {
      args: ['--pre'], env,
      stdin: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'C:/secret/x.txt' }, tool_use_id: 'toolu_01' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const c = stub.calls[0];
    assert.equal(c.url, `${base}/tool-activity`);
    assert.deepEqual(Object.keys(c.body).sort(), ['startedAt', 'toolName', 'toolUseId']);
    assert.equal(c.body.toolName, 'Read');
    assert.equal(c.body.toolUseId, 'toolu_01');
    const t = Date.parse(c.body.startedAt);
    assert.ok(t >= before - 1000 && t <= Date.now() + 1000, 'startedAt must be a current ISO timestamp');
    assert.ok(!c.raw.includes('secret'), 'tool_input must never be forwarded by tool-activity');
  });
});

test('tool-activity --post: posts { toolUseId, endedAt }', async () => {
  await withEnv(async ({ stub, env }) => {
    const r = await runScript('tool-activity.js', {
      args: ['--post'], env,
      stdin: { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Read', tool_input: {}, tool_response: { big: 'x'.repeat(100) }, tool_use_id: 'toolu_01' },
    });
    assert.equal(r.status, 0, r.stderr);
    const c = stub.calls[0];
    assert.equal(c.url, `${base}/tool-activity`);
    assert.deepEqual(Object.keys(c.body).sort(), ['endedAt', 'toolUseId']);
    assert.equal(c.body.toolUseId, 'toolu_01');
    assert.ok(!Number.isNaN(Date.parse(c.body.endedAt)));
  });
});

test('tool-activity: missing tool_use_id falls back to <session_id>:<tool_name>:<ts> and says so in debug', async () => {
  await withEnv(async ({ stub, env }) => {
    const r = await runScript('tool-activity.js', {
      args: ['--pre'], env: { ...env, KANBANTIC_SYNC_DEBUG: '1' },
      stdin: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } },
    });
    assert.equal(r.status, 0);
    assert.match(stub.calls[0].body.toolUseId, /^s1:Bash:\d+/);
    assert.match(r.stderr, /tool_use_id/);
  });
});

test('tool-activity: without --pre/--post nothing is sent', async () => {
  await withEnv(async ({ stub, env }) => {
    const r = await runScript('tool-activity.js', {
      env, stdin: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'x' },
    });
    assert.equal(r.status, 0);
    assert.equal(stub.calls.length, 0);
  });
});

// ── turn-start ───────────────────────────────────────────────────────────────

test('turn-start: posts { at } as ISO timestamp, never the prompt', async () => {
  await withEnv(async ({ stub, env }) => {
    const r = await runScript('turn-start.js', {
      env, stdin: { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'my password=hunter2 please' },
    });
    assert.equal(r.status, 0, r.stderr);
    const c = stub.calls[0];
    assert.equal(c.url, `${base}/turn-start`);
    assert.deepEqual(Object.keys(c.body), ['at']);
    assert.ok(!Number.isNaN(Date.parse(c.body.at)));
    assert.ok(!c.raw.includes('hunter2'));
  });
});

// ── stop-session-idle ────────────────────────────────────────────────────────

test('stop-session-idle: heartbeat Idle with 300-char summary and background task count', async () => {
  await withEnv(async ({ stub, env }) => {
    const r = await runScript('stop-session-idle.js', {
      env,
      stdin: {
        hook_event_name: 'Stop', session_id: 's1', stop_hook_active: false,
        last_assistant_message: 'a'.repeat(1000),
        background_tasks: [{ id: 't1', type: 'shell', status: 'running' }, { id: 't2', type: 'subagent', status: 'running' }],
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const c = stub.calls[0];
    assert.equal(c.url, `${base}/heartbeat`);
    assert.equal(c.body.status, 'Idle');
    assert.equal(c.body.summary, 'a'.repeat(300));
    assert.equal(c.body.activeBackgroundTasks, 2);
  });
});

test('stop-session-idle: no background_tasks field → activeBackgroundTasks null; empty list → 0', async () => {
  await withEnv(async ({ stub, env }) => {
    await runScript('stop-session-idle.js', { env, stdin: { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'klaar' } });
    await runScript('stop-session-idle.js', { env, stdin: { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'klaar', background_tasks: [] } });
    assert.equal(stub.calls[0].body.activeBackgroundTasks, null);
    assert.equal(stub.calls[1].body.activeBackgroundTasks, 0);
    assert.equal(stub.calls[0].body.summary, 'klaar');
  });
});

test('stop-session-idle: the summary is redacted before it leaves the machine', async () => {
  await withEnv(async ({ stub, env }) => {
    await runScript('stop-session-idle.js', {
      env,
      stdin: { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Done. Used Bearer eyJabc.def.ghi and token=sup3rsecret in the call.' },
    });
    const s = stub.calls[0].body.summary;
    assert.ok(s.includes('Bearer ***'), s);
    assert.ok(!s.includes('sup3rsecret'));
    assert.ok(!s.includes('eyJabc'));
  });
});

test('stop-session-idle: still silent on stdout so it never perturbs stop-version-summary', async () => {
  await withEnv(async ({ env }) => {
    const r = await runScript('stop-session-idle.js', { env, stdin: { hook_event_name: 'Stop', session_id: 's1' } });
    assert.equal(r.stdout, '');
  });
});

// ── fail-open matrix ─────────────────────────────────────────────────────────

const SCRIPTS = [
  ['notification-session-state.js', [], { hook_event_name: 'Notification', session_id: 's1', notification_type: 'permission_prompt', title: 'T', message: 'm' }],
  ['tool-activity.js', ['--pre'], { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: {}, tool_use_id: 't1' }],
  ['tool-activity.js', ['--post'], { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Read', tool_use_id: 't1' }],
  ['turn-start.js', [], { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' }],
  ['stop-session-idle.js', [], { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'x' }],
];

for (const [script, args, payload] of SCRIPTS) {
  const label = `${script} ${args.join(' ')}`.trim();

  test(`fail-open ${label}: no session file → exit 0, empty stdout, no request`, async () => {
    await withEnv(async ({ dir, stub, env }) => {
      const r = await runScript(script, { args, stdin: payload, env: { ...env, KANBANTIC_SESSION_FILE: path.join(dir, 'does-not-exist.json') } });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(stub.calls.length, 0);
    });
  });

  test(`fail-open ${label}: no API key → exit 0, empty stdout, no request`, async () => {
    await withEnv(async ({ stub, env }) => {
      const r = await runScript(script, { args, stdin: payload, env: { ...env, KANBANTIC_API_KEY: '' } });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(stub.calls.length, 0);
    });
  });

  test(`fail-open ${label}: server down → exit 0, empty stdout`, async () => {
    const port = await closedPort();
    await withEnv(async ({ env }) => {
      const r = await runScript(script, { args, stdin: payload, env: { ...env, KANBANTIC_API_URL: `http://127.0.0.1:${port}` } });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    });
  });

  test(`fail-open ${label}: HTTP 500 → exit 0, empty stdout`, async () => {
    await withEnv(async ({ stub, env }) => {
      const r = await runScript(script, { args, stdin: payload, env });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.ok(stub.calls.length >= 1, 'the request must actually have been attempted');
    }, { stubResponder: () => ({ status: 500, body: { error: 'boom' } }) });
  });

  test(`fail-open ${label}: broken or empty stdin → exit 0, empty stdout`, async () => {
    await withEnv(async ({ env }) => {
      for (const stdin of ['{not json', '', undefined, '[]', 'null']) {
        const r = await runScript(script, { args, stdin, env });
        assert.equal(r.status, 0, `stdin=${JSON.stringify(stdin)} stderr=${r.stderr}`);
        assert.equal(r.stdout, '');
      }
    });
  });

  test(`fail-open ${label}: debug output never contains the API key or the payload text (SEC063 §5)`, async () => {
    await withEnv(async ({ env }) => {
      const noisy = { ...payload, message: 'PAYLOAD-MARKER-9f3', prompt: 'PAYLOAD-MARKER-9f3', last_assistant_message: 'PAYLOAD-MARKER-9f3' };
      const r = await runScript(script, {
        args, stdin: noisy,
        env: { ...env, KANBANTIC_API_KEY: 'sekrit-key-123', KANBANTIC_SYNC_DEBUG: '1' },
      });
      assert.equal(r.status, 0);
      const all = r.stdout + r.stderr;
      assert.ok(!all.includes('sekrit-key-123'), 'API key leaked');
      assert.ok(!all.includes('PAYLOAD-MARKER-9f3'), 'payload leaked');
      assert.ok(!all.includes(path.join(env.HOME, 'session.json')), 'session file path leaked');
    }, { stubResponder: () => ({ status: 500 }) });
  });
}

// ── base URL handling ────────────────────────────────────────────────────────

test('normalizeBaseUrl strips a trailing slash and a trailing /api', () => {
  const { normalizeBaseUrl } = lib();
  assert.equal(normalizeBaseUrl('https://kanbantic.com/api'), 'https://kanbantic.com');
  assert.equal(normalizeBaseUrl('https://kanbantic.com/api/'), 'https://kanbantic.com');
  assert.equal(normalizeBaseUrl('https://kanbantic.com/'), 'https://kanbantic.com');
  assert.equal(normalizeBaseUrl('https://kanbantic.com'), 'https://kanbantic.com');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:5000/api'), 'http://127.0.0.1:5000');
  assert.equal(normalizeBaseUrl('https://host/prefix/api'), 'https://host/prefix');
  assert.equal(normalizeBaseUrl(''), 'https://kanbantic.com');
  assert.equal(normalizeBaseUrl(undefined), 'https://kanbantic.com');
});

test('KANBANTIC_API_URL ending in /api does not produce /api/api/...', async () => {
  await withEnv(async ({ stub, env }) => {
    await runScript('turn-start.js', { env: { ...env, KANBANTIC_API_URL: `${stub.url}/api` }, stdin: { hook_event_name: 'UserPromptSubmit', session_id: 's1' } });
    assert.equal(stub.calls[0].url, `${base}/turn-start`);
  });
});

test('without KANBANTIC_API_URL the apiUrl from the session file is used', async () => {
  const dir = mkTmp();
  const stub = await startApiStub();
  try {
    writeSessionFile(dir, { apiUrl: `${stub.url}/api/` });
    const env = hookEnv(dir, stub);
    delete env.KANBANTIC_API_URL;
    const r = await runScript('turn-start.js', { env, stdin: { hook_event_name: 'UserPromptSubmit', session_id: 's1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(stub.calls[0].url, `${base}/turn-start`);
  } finally {
    await stub.close();
    rmTmp(dir);
  }
});

test('the session file is resolved via CLAUDE_CODE_SESSION_ID / payload session_id when no override is set', async () => {
  const dir = mkTmp();
  const stub = await startApiStub();
  try {
    fs.writeFileSync(path.join(dir, '.claude-kanbantic-session-abc.json'), JSON.stringify({ sessionId: 'FROM-HOME', channelId: 'c' }));
    const env = hookEnv(dir, stub);
    delete env.KANBANTIC_SESSION_FILE;
    // no CLAUDE_CODE_SESSION_ID in env → the payload's session_id picks the file
    await runScript('turn-start.js', { env, stdin: { hook_event_name: 'UserPromptSubmit', session_id: 'abc' } });
    assert.equal(stub.calls[0].url, '/api/app/agent-session/FROM-HOME/turn-start');
  } finally {
    await stub.close();
    rmTmp(dir);
  }
});

// ── redaction (SEC063 §1) ────────────────────────────────────────────────────

test('redactText: Bearer tokens, --password=, token=, Authorization headers', () => {
  const { redactText } = lib();
  assert.equal(redactText('Authorization: Bearer abc.def'), 'Authorization: ***');
  assert.ok(redactText('curl -H "Authorization: Bearer abc"').includes('***'));
  assert.ok(!redactText('curl -H "Authorization: Bearer abc"').includes('abc'));
  assert.equal(redactText('use Bearer abc123 here'), 'use Bearer *** here');
  assert.equal(redactText('mysql --password=hunter2 -u root'), 'mysql --password=*** -u root');
  assert.equal(redactText('mysql --password hunter2 -u root'), 'mysql --password *** -u root');
  assert.equal(redactText('run with token=abcdef now'), 'run with token=*** now');
  assert.equal(redactText('API_KEY=xyz npm test'), 'API_KEY=*** npm test');
  assert.equal(redactText('export KANBANTIC_API_KEY="k-123"'), 'export KANBANTIC_API_KEY=***');
  assert.ok(!redactText('{"password": "p4ss", "user": "u"}').includes('p4ss'));
  assert.ok(redactText('{"password": "p4ss", "user": "u"}').includes('"user": "u"'));
  assert.ok(!redactText('ghp_abcdefghijklmnopqrstuvwxyz0123456789').includes('abcdefghij'));
  assert.ok(!redactText('client_secret: s3cr3t!').includes('s3cr3t'));
});

test('redactText: leaves ordinary text and commands untouched', () => {
  const { redactText } = lib();
  for (const s of [
    'git status', 'ls -la /tmp', 'npm test -- --grep "tokenizer"', 'Read C:/GitHub/kanbantic/x.cs',
    'The token count is 5 and the secretary left.', 'Claude needs your permission to use Bash',
    'git push origin feature/KBT-F741-hang-detection',
  ]) {
    assert.equal(redactText(s), s);
  }
  assert.equal(redactText(''), '');
  assert.equal(redactText(null), '');
  assert.equal(redactText(undefined), '');
});

test('redactObject: values of sensitive keys become ***, others are kept (deep)', () => {
  const { redactObject } = lib();
  const out = redactObject({
    command: 'ls', apiKey: 'k', api_key: 'k2', 'x-api-key': 'k3', Authorization: 'Bearer z',
    nested: { password: 'p', safe: 'ok', list: [{ token: 't' }, 'plain'] }, secret: 1, bearer: 'b',
  });
  assert.equal(out.command, 'ls');
  assert.equal(out.apiKey, '***');
  assert.equal(out.api_key, '***');
  assert.equal(out['x-api-key'], '***');
  assert.equal(out.Authorization, '***');
  assert.equal(out.nested.password, '***');
  assert.equal(out.nested.safe, 'ok');
  assert.equal(out.nested.list[0].token, '***');
  assert.equal(out.nested.list[1], 'plain');
  assert.equal(out.secret, '***');
  assert.equal(out.bearer, '***');
});

test('summarizeToolInput: redacts first, then caps at the limit', () => {
  const { summarizeToolInput } = lib();
  const s = summarizeToolInput('Bash', { command: `curl -H "Authorization: Bearer abc" ${'x'.repeat(2000)}` }, 500);
  assert.ok(s.length <= 500);
  assert.ok(!s.includes('abc'));
  assert.ok(s.includes('***'));
  assert.equal(summarizeToolInput('Read', { file_path: 'C:/a/b.txt' }, 500).includes('C:/a/b.txt'), true);
});

// ── registration in hooks.json ───────────────────────────────────────────────

const hooksJson = () => JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8'));
const cmdsOf = (entry) => (entry.hooks || []).map((h) => h.command);

test('hooks.json registers the session-state hooks with the agreed matchers and timeout 8000', () => {
  const h = hooksJson().hooks;

  const notif = (h.Notification || []).find((e) => cmdsOf(e).some((c) => /notification-session-state\.js/.test(c)));
  assert.ok(notif, 'Notification entry missing');
  assert.equal(notif.matcher, 'permission_prompt|idle_prompt|agent_needs_input');

  const perm = (h.PermissionRequest || []).find((e) => cmdsOf(e).some((c) => /permission-request-router\.js/.test(c)));
  assert.ok(perm, 'PermissionRequest entry missing');

  const pre = (h.PreToolUse || []).find((e) => cmdsOf(e).some((c) => /tool-activity\.js --pre/.test(c)));
  assert.ok(pre, 'PreToolUse tool-activity entry missing');
  assert.ok(!pre.matcher || pre.matcher === '.*' || pre.matcher === '*', 'tool-activity must see all tools');

  const post = (h.PostToolUse || []).find((e) => cmdsOf(e).some((c) => /tool-activity\.js --post/.test(c)));
  assert.ok(post, 'PostToolUse entry missing');

  const ups = (h.UserPromptSubmit || []).find((e) => cmdsOf(e).some((c) => /turn-start\.js/.test(c)));
  assert.ok(ups, 'UserPromptSubmit entry missing');

  const stop = (h.Stop || []).flatMap(cmdsOf);
  assert.ok(stop.some((c) => /stop-version-summary\.js/.test(c)), 'existing Stop hook must stay');
  assert.ok(stop.some((c) => /stop-session-idle\.js/.test(c)), 'Stop idle hook missing');

  for (const entry of [notif, perm, pre, post, ups, ...(h.Stop || [])]) {
    for (const hook of entry.hooks) {
      assert.equal(hook.type, 'command');
      assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
      assert.equal(hook.timeout, 8000);
    }
  }
});

test('hooks.json keeps the four pre-existing PreToolUse matchers', () => {
  const pre = hooksJson().hooks.PreToolUse;
  for (const m of ['mcp__.*__claim_issue', 'mcp__.*__update_issue_status', 'Bash', 'Write|Edit']) {
    assert.ok(pre.some((e) => e.matcher === m), `matcher ${m} must remain`);
  }
});

test('every script referenced from hooks.json exists', () => {
  const h = hooksJson().hooks;
  for (const entries of Object.values(h)) {
    for (const e of entries) {
      for (const hook of e.hooks) {
        const m = hook.command.match(/hooks\/([\w.-]+\.(?:js|sh|ps1))/);
        if (!m) continue;
        assert.ok(fs.existsSync(path.join(HOOKS_DIR, m[1])), `${m[1]} referenced but missing`);
      }
    }
  }
});

test('the session-state hooks never talk through the MCP proxy', () => {
  for (const f of ['notification-session-state.js', 'tool-activity.js', 'turn-start.js', 'stop-session-idle.js', 'permission-request-router.js', 'lib/session-api.js']) {
    const src = fs.readFileSync(path.join(HOOKS_DIR, f), 'utf8');
    assert.ok(!/kanbantic-mcp-proxy/.test(src), `${f} must not depend on the proxy`);
    assert.ok(!/tools\/call/.test(src), `${f} must use the REST API, not MCP tools/call`);
  }
});
