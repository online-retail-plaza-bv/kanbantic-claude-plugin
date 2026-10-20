'use strict';

//
// decision-request-proxy-e2e.test.js — KBT-F742 / KBT-TC4207 (a) (real-proxy + real-session E2E)
//
// Startup artefacts (hooks.json, known-mcp-tools.json, the proxy) are only
// proven by a fresh process (ADM-TRUL015). Two parts, nothing talks to a real
// Kanbantic:
//
//   1. The REAL bundled MCP proxy (plugin/proxy/kanbantic-mcp-proxy.js) as a
//      child process against a stub MCP backend on 127.0.0.1:
//        - register_agent_session → the proxy learns its session, channel and
//          workspace, and writes the session file the hooks read (now with
//          `workspaceId`; `currentIssueId` after set_current_issue);
//        - request_decision → arrives at the backend with fromSessionId = the
//          registered session (KBT-SR643 §Registry, like send_message / KBT-F718);
//        - a DecisionAnswer message served by the inbox-poll → reaches the host as
//          notifications/claude/channel with meta decisionRequestId / code /
//          optionKey / via lifted from the message payload.
//
//   2. A REAL headless Claude Code session (`claude -p`, --plugin-dir this
//      checkout) that reads a file outside its cwd with NO allow-list rule: the
//      PermissionRequest router must POST /api/app/decision-request (kind
//      Permission, role Operator, three options with terminalInput, recommended
//      allow-once) on the API stub and then wait-for-user "Permissieverzoek
//      <code>"; it never allows. Skipped (with the reason) when `claude` is not
//      on PATH or KBT_E2E_CLAUDE=0.
//
// KBT_E2E_DECISIONS_DISABLED=1 runs both parts against a copy of the plugin with
// the decision features switched off (proxy: the request_decision injection and
// the DecisionAnswer detection renamed away; hooks.json: the router entry
// stripped). The assertions are unchanged, so the test MUST go red — the proof
// it detects a plugin without the feature.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { mkTmp, rmTmp, startApiStub } = require('./helpers/hook-harness.js');
const { PLUGIN_DIR, claudeAvailable, pluginCopy, runClaude } = require('./helpers/claude-e2e.js');

const DISABLED = process.env.KBT_E2E_DECISIONS_DISABLED === '1';
const INIT_PARAMS = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } };

/** The plugin dir to run: this checkout, or a copy with the decision features off. */
function pluginDirFor(root) {
  if (!DISABLED) return PLUGIN_DIR;
  return pluginCopy(path.join(root, 'plugin-without-decisions'), {
    stripHooks: /permission-request-router/,
    proxyReplacements: [
      ["'request_decision'", "'request_decision__disabled'"],
      ["'DecisionAnswer'", "'DecisionAnswer__disabled'"],
    ],
  });
}

// ── part 1: the real proxy ───────────────────────────────────────────────────

function jsonContent(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

const DECISION_PAYLOAD = { decisionRequestId: '3a24-dr-e2e', code: 'KBT-DR042', optionKey: 'allow-once', via: 'Inbox' };

/** Stub MCP backend. `state.answerReady` releases the DecisionAnswer message to the next poll. */
function startMcpStub() {
  const received = [];
  const state = { answerReady: false, answerServed: false };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.statusCode = 404; return res.end(); }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      received.push({ method: msg.method, name, args });
      res.setHeader('Mcp-Session-Id', req.headers['mcp-session-id'] || 'stub-session');
      res.setHeader('Content-Type', 'application/json');
      if (msg.method === 'initialize') {
        res.statusCode = 200;
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } } }));
      }
      if (msg.method === 'notifications/initialized') { res.statusCode = 202; return res.end(); }
      let result;
      if (msg.method === 'tools/list') result = { tools: [] };
      else if (name === 'register_agent_session') result = jsonContent({ success: true, sessionId: 'SESS-E2E-PROXY', channelId: 'CHAN-E2E-PROXY' });
      else if (name === 'request_decision') result = jsonContent({ success: true, decisionRequestId: DECISION_PAYLOAD.decisionRequestId, code: DECISION_PAYLOAD.code, status: 'Open', deadlineAt: null, inboxUrl: 'http://127.0.0.1/ws/decisions/3a24-dr-e2e' });
      else if (name === 'get_channel_messages') {
        const messages = [];
        if (state.answerReady && !state.answerServed) {
          state.answerServed = true;
          messages.push({
            id: 'm-dr-e2e', channelId: 'CHAN-E2E-PROXY',
            content: '**Besluit op KBT-DR042** — Permissie voor Bash?\nGekozen: **Eenmalig toestaan** (allow-once)\n— PO via Inbox',
            authorAgentSessionId: null, authorUserId: 'user-po', authorDisplayName: 'PO', authorType: 'User',
            messageType: 'DecisionAnswer', payload: JSON.stringify(DECISION_PAYLOAD),
            sentAt: new Date(Date.now() + 1000).toISOString(),
          });
        }
        result = jsonContent({ success: true, messages });
      }
      else if (name === 'acknowledge_channel_delivery') result = jsonContent({ success: true, newlyDeliveredMessageIds: String(args.messageIds || '').split(',') });
      else result = jsonContent({ success: true, echo: name || msg.method });
      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received, state }));
  });
}

function spawnProxy(proxyPath, port, home) {
  const env = { ...process.env, KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`, KANBANTIC_API_KEY: 'test-key', HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (/^CLAUDE(CODE|_CODE)/i.test(k)) delete env[k];
  for (const k of ['KANBANTIC_WORKSPACE_ID', 'KANBANTIC_WORKSTATION_ID', 'KANBANTIC_HOST', 'KANBANTIC_SPAWN_COMMAND_ID']) delete env[k];
  const child = spawn(process.execPath, [proxyPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const pending = new Map();
  const notifications = [];
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method === 'notifications/claude/channel') notifications.push(msg);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderr += c));
  const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  function rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const t = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC timeout ${method} (id=${id}). stderr: ${stderr}`)); }
      }, 10000);
      if (typeof t.unref === 'function') t.unref();
    });
  }
  async function waitForNotification(pred, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const hit = notifications.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
  async function shutdown() { child.stdin.end(); return exitPromise; }
  return { rpc, shutdown, waitForNotification, notifications, getStderr: () => stderr };
}

function sessionFileIn(home) {
  const files = fs.readdirSync(home).filter((f) => /kanbantic.*session/i.test(f) && f.endsWith('.json'));
  return files.length === 1 ? JSON.parse(fs.readFileSync(path.join(home, files[0]), 'utf8')) : null;
}

test('KBT-TC4207 (a) — the real proxy injects fromSessionId on request_decision, writes workspace/issue to the session file, and lifts DecisionAnswer meta', { timeout: 60000 }, async () => {
  const root = mkTmp('kbt-f742-proxy-e2e-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = await startMcpStub();
  const pluginDir = pluginDirFor(root);
  const proxy = spawnProxy(path.join(pluginDir, 'proxy', 'kanbantic-mcp-proxy.js'), stub.port, home);
  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);
    const reg = await proxy.rpc('tools/call', { name: 'register_agent_session', arguments: { workspaceId: 'ws-e2e', claudeAgentId: 'agent-e2e' } }, 2);
    assert.equal(JSON.parse(reg.result.content[0].text).sessionId, 'SESS-E2E-PROXY');

    // The hooks read the session file: it must now carry the workspace the router needs.
    let session = sessionFileIn(home);
    assert.ok(session, `the proxy must have written exactly one session file in ${home}`);
    assert.equal(session.sessionId, 'SESS-E2E-PROXY');
    assert.equal(session.channelId, 'CHAN-E2E-PROXY');
    assert.equal(session.workspaceId, 'ws-e2e', 'session file must carry workspaceId (router: decision-request.workspaceId)');

    await proxy.rpc('tools/call', { name: 'set_current_issue', arguments: { sessionId: 'SESS-E2E-PROXY', issueId: '3a24-issue-e2e' } }, 3);
    session = sessionFileIn(home);
    assert.equal(session.currentIssueId, '3a24-issue-e2e', 'session file must carry currentIssueId after set_current_issue (router: decision-request.issueId)');

    // request_decision through the proxy → fromSessionId attached, nothing else touched.
    const options = JSON.stringify([{ key: 'a', title: 'A', consequence: 'doe A' }, { key: 'b', title: 'B', consequence: 'doe B' }]);
    const resp = await proxy.rpc('tools/call', { name: 'request_decision', arguments: { workspaceId: 'ws-e2e', question: 'A of B?', optionsJson: options, recipientRole: 'ProductOwner', recommendedOptionKey: 'a', rationale: 'A is goedkoper' } }, 4);
    assert.equal(JSON.parse(resp.result.content[0].text).code, 'KBT-DR042');
    const forwarded = stub.received.find((r) => r.name === 'request_decision');
    assert.ok(forwarded, 'request_decision must reach the backend');
    assert.equal(forwarded.args.fromSessionId, 'SESS-E2E-PROXY', 'the proxy must inject its own session id as fromSessionId');
    assert.equal(forwarded.args.optionsJson, options);
    assert.equal(forwarded.args.recommendedOptionKey, 'a');

    // The answer comes back through the inbox-poll as a DecisionAnswer message.
    stub.state.answerReady = true;
    const note = await proxy.waitForNotification((m) => m.params && m.params.meta && m.params.meta.message_type === 'DecisionAnswer', 15000);
    assert.ok(note, `no DecisionAnswer channel notification. got: ${JSON.stringify(proxy.notifications.map((n) => n.params.meta))}\nstderr: ${proxy.getStderr().slice(0, 800)}`);
    assert.equal(note.params.meta.decisionRequestId, DECISION_PAYLOAD.decisionRequestId);
    assert.equal(note.params.meta.code, 'KBT-DR042');
    assert.equal(note.params.meta.optionKey, 'allow-once');
    assert.equal(note.params.meta.via, 'Inbox');
    for (const v of Object.values(note.params.meta)) assert.equal(typeof v, 'string');
    assert.match(note.params.content, /Besluit op KBT-DR042/);
  } finally {
    await proxy.shutdown();
    stub.server.close();
    rmTmp(root);
  }
});

// ── part 2: the real session + router ────────────────────────────────────────

const skipReason = claudeAvailable();

test('KBT-TC4207 (a) — a real headless session turns an unmatched permission question into a Permission decision request', { skip: skipReason || false, timeout: 240000 }, async () => {
  const root = mkTmp('kbt-f742-session-e2e-');
  const stub = await startApiStub((call) => (call.url === '/api/app/decision-request'
    ? { status: 200, body: { id: '3a24-dr-e2e', code: 'KBT-DR042', status: 0 } }
    : undefined));
  try {
    const work = path.join(root, 'work');
    const other = path.join(root, 'other');
    for (const d of [work, other]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(other, 'b.txt'), 'BBB-content\n');

    const sessionFile = path.join(root, 'session.json');
    fs.writeFileSync(sessionFile, JSON.stringify({
      sessionId: 'SESS-E2E', channelId: 'CHAN-E2E', claudeCliSessionId: null, workspaceId: 'ws-e2e', currentIssueId: '3a24-issue-e2e',
      apiUrl: stub.url, writtenAt: new Date().toISOString(), pid: process.pid, cursors: {},
    }));
    const allowFile = path.join(root, 'allow.json');
    fs.writeFileSync(allowFile, JSON.stringify({ allowList: ['Bash(git status*)'], allowListFetchedAt: new Date().toISOString() }));

    const b = path.join(other, 'b.txt');
    const r = await runClaude({
      cwd: work,
      pluginDir: pluginDirFor(root),
      prompt: `Use the Read tool on ${b}. Use no other tool. Then say whether you could read it.`,
      timeoutMs: 200000,
      env: {
        KANBANTIC_API_URL: stub.url,
        KANBANTIC_API_KEY: 'test',
        KANBANTIC_MCP_URL: 'http://127.0.0.1:1/mcp',
        KANBANTIC_SESSION_FILE: sessionFile,
        KANBANTIC_ALLOWLIST_FILE: allowFile,
        KANBANTIC_HOOK_STATE_DIR: path.join(root, 'state'),
        KANBANTIC_SYNC_DEBUG: '1',
      },
    });

    assert.ok(!r.timedOut, `claude timed out. stderr: ${r.stderr.slice(0, 500)}`);
    const diag = () => `claude exit=${r.status}\nstdout=${r.stdout.slice(0, 1500)}\nstderr=${r.stderr.slice(0, 800)}\ncalls=${JSON.stringify(stub.calls.map((c) => [c.url, c.body]))}`;

    const dr = stub.calls.find((c) => c.url === '/api/app/decision-request');
    assert.ok(dr, `no POST /api/app/decision-request\n${diag()}`);
    assert.equal(dr.method, 'POST');
    assert.equal(dr.headers['x-api-key'], 'test');
    assert.equal(dr.body.workspaceId, 'ws-e2e');
    assert.equal(dr.body.kind, 2);
    assert.equal(dr.body.recipientRole, 4);
    assert.equal(dr.body.question, 'Permissie voor Read?');
    assert.ok(dr.body.context.includes('b.txt'), dr.body.context);
    assert.equal(dr.body.issueId, '3a24-issue-e2e');
    assert.equal(dr.body.fromSessionId, 'SESS-E2E');
    assert.equal(dr.body.recommendedOptionKey, 'allow-once');
    assert.deepEqual(dr.body.options.map((o) => [o.key, o.terminalInput]), [['allow-once', 'y\n'], ['allow-always', 'y\n'], ['deny', 'n\n']]);
    assert.ok(Date.parse(dr.body.deadlineAt) > Date.now(), 'deadline in the future');

    const waits = stub.calls.filter((c) => c.url === '/api/app/agent-session/SESS-E2E/wait-for-user').map((c) => c.body);
    assert.ok(waits.some((w) => w.prompt === 'Permissieverzoek KBT-DR042'), `no wait-for-user "Permissieverzoek KBT-DR042"\n${diag()}`);
    assert.ok(!stub.calls.some((c) => c.body && typeof c.body.permissionDecision === 'string' && c.body.permissionDecision.startsWith('allow-list:')), `nothing may have been allowed\n${diag()}`);
    assert.ok(!r.stdout.includes('BBB-content'), `b.txt content must not have been readable\n${diag()}`);
  } finally {
    await stub.close();
    rmTmp(root);
  }
});
