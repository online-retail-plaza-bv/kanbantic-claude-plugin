'use strict';

//
// fleet-proxy-e2e.test.js — KBT-F743 / KBT-TC4214 (a) (real-proxy E2E)
//
// Startup artefacts (the proxy, known-mcp-tools.json, the param-drift contract)
// are only proven by a fresh process (ADM-TRUL015). Nothing talks to a real
// Kanbantic: the REAL bundled MCP proxy (plugin/proxy/kanbantic-mcp-proxy.js)
// runs as a child process against a stub MCP backend on 127.0.0.1.
//
//   1. register_agent_session → arrives at the backend with `modelId` read from
//      `model` in `$CLAUDE_CONFIG_DIR/settings.json`; the lookup order of the
//      F743 contract is `$CLAUDE_CONFIG_DIR/settings.json` → `~/.claude/settings.json`
//      → `<cwd>/.claude/settings.local.json` → `<cwd>/.claude/settings.json` →
//      env `ANTHROPIC_MODEL`. Without any of them the argument is ABSENT (never
//      an empty string).
//   2. get_fleet_digest / get_fleet_overview pass through the proxy with exactly
//      the arguments the host sent (no fromSessionId or other injection).
//   3. Both tools are in known-mcp-tools.json and in the REQUIRED_PARAMS contract
//      of check-tool-param-drift.js (→ ["workspaceId"]).
//
// KBT_E2E_FLEET_DISABLED=1 runs the same assertions against a copy of the plugin
// with the fleet features switched off (proxy: the modelId injection renamed
// away; registry: the two tools removed; drift script: the two contract entries
// renamed). The test MUST go red then — the proof it detects a plugin without
// the feature.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { mkTmp, rmTmp } = require('./helpers/hook-harness.js');
const { PLUGIN_DIR, pluginCopy } = require('./helpers/claude-e2e.js');

const DISABLED = process.env.KBT_E2E_FLEET_DISABLED === '1';
const INIT_PARAMS = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } };
const FLEET_TOOLS = ['get_fleet_digest', 'get_fleet_overview'];

/** The plugin dir to run: this checkout, or a copy with the fleet features off. */
function pluginDirFor(root) {
  if (!DISABLED) return PLUGIN_DIR;
  const dir = pluginCopy(path.join(root, 'plugin-without-fleet'), {
    proxyReplacements: [["'modelId'", "'modelId__disabled'"]],
  });
  const registryFile = path.join(dir, 'scripts', 'known-mcp-tools.json');
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  registry.tools = registry.tools.filter((t) => !FLEET_TOOLS.includes(t));
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
  const driftFile = path.join(dir, 'scripts', 'check-tool-param-drift.js');
  let drift = fs.readFileSync(driftFile, 'utf8');
  for (const t of FLEET_TOOLS) drift = drift.split(`${t}:`).join(`${t}__disabled:`);
  fs.writeFileSync(driftFile, drift);
  return dir;
}

// ── stub MCP backend ─────────────────────────────────────────────────────────

function jsonContent(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

const tool = (name, required) => ({ name, description: '', inputSchema: { type: 'object', properties: {}, required } });

/** Records every tools/call; answers tools/list with `tools`. */
function startMcpStub(tools = []) {
  const received = [];
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
      if (msg.method === 'tools/list') result = { tools };
      else if (name === 'register_agent_session') result = jsonContent({ success: true, sessionId: 'SESS-E2E-FLEET', channelId: 'CHAN-E2E-FLEET' });
      else if (name === 'get_fleet_digest') result = jsonContent({ success: true, window: { kind: 'Night', from: '2026-10-19T17:00:00Z', to: '2026-10-20T05:00:00Z', timeZone: 'Europe/Amsterdam' }, markdown: '# Digest\n— niets —' });
      else if (name === 'get_fleet_overview') result = jsonContent({ success: true, generatedAt: '2026-10-20T06:00:00Z', totals: { working: 0, silent: 0, waitingForHuman: 0, blocked: 0, idle: 0, total: 0 }, agents: [], truncated: false });
      else if (name === 'get_channel_messages') result = jsonContent({ success: true, messages: [] });
      else result = jsonContent({ success: true, echo: name || msg.method });
      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

// ── the real proxy as a child process ────────────────────────────────────────

/**
 * Spawns the proxy with a scrubbed environment: no Claude/Kanbantic context of
 * the developer's own session, no ANTHROPIC_MODEL, HOME/USERPROFILE and cwd in
 * the test's tmp root, and CLAUDE_CONFIG_DIR only when the test sets it.
 */
function spawnProxy(proxyPath, port, { home, cwd, configDir, extraEnv = {} }) {
  const env = { ...process.env, KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`, KANBANTIC_API_KEY: 'test-key', HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (/^CLAUDE(CODE|_CODE|_CONFIG_DIR)/i.test(k)) delete env[k];
  for (const k of ['KANBANTIC_WORKSPACE_ID', 'KANBANTIC_WORKSTATION_ID', 'KANBANTIC_HOST', 'KANBANTIC_SPAWN_COMMAND_ID', 'ANTHROPIC_MODEL']) delete env[k];
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [proxyPath], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

  const pending = new Map();
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
  async function shutdown() { child.stdin.end(); return exitPromise; }
  return { rpc, shutdown, getStderr: () => stderr };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** One proxy run: initialize + register_agent_session; returns the forwarded register arguments. */
async function registerThrough(pluginDir, stub, opts) {
  const proxy = spawnProxy(path.join(pluginDir, 'proxy', 'kanbantic-mcp-proxy.js'), stub.port, opts);
  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);
    const before = stub.received.length;
    const reg = await proxy.rpc('tools/call', { name: 'register_agent_session', arguments: { workspaceId: 'ws-e2e', claudeAgentId: 'agent-e2e' } }, 2);
    assert.equal(JSON.parse(reg.result.content[0].text).sessionId, 'SESS-E2E-FLEET', `register must round-trip. stderr: ${proxy.getStderr().slice(0, 500)}`);
    const forwarded = stub.received.slice(before).find((r) => r.name === 'register_agent_session');
    assert.ok(forwarded, 'register_agent_session must reach the backend');
    return { forwarded, proxy };
  } catch (e) {
    await proxy.shutdown();
    throw e;
  }
}

// ── 1 + 2: modelId from settings.json; fleet tools pass through unchanged ────

test('KBT-TC4214 (a) — the real proxy registers with modelId from $CLAUDE_CONFIG_DIR/settings.json and passes get_fleet_digest/get_fleet_overview through unchanged', { timeout: 60000 }, async () => {
  const root = mkTmp('kbt-f743-proxy-e2e-');
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const configDir = path.join(root, 'cfg');
  for (const d of [home, work, configDir]) fs.mkdirSync(d, { recursive: true });
  writeJson(path.join(configDir, 'settings.json'), { model: 'claude-sonnet-5-5' });
  // A project-level and an env-level model must LOSE against the config dir.
  writeJson(path.join(work, '.claude', 'settings.local.json'), { model: 'claude-haiku-4-5' });

  const stub = await startMcpStub();
  const pluginDir = pluginDirFor(root);
  let proxy;
  try {
    const r = await registerThrough(pluginDir, stub, { home, cwd: work, configDir, extraEnv: { ANTHROPIC_MODEL: 'claude-opus-4-1' } });
    proxy = r.proxy;
    assert.equal(r.forwarded.args.modelId, 'claude-sonnet-5-5', `modelId must come from $CLAUDE_CONFIG_DIR/settings.json; got ${JSON.stringify(r.forwarded.args)}`);
    assert.equal(r.forwarded.args.workspaceId, 'ws-e2e');

    // The two fleet tools: exactly the arguments the host sent, nothing injected.
    const digestArgs = { workspaceId: 'ws-e2e', window: 'night' };
    const digest = await proxy.rpc('tools/call', { name: 'get_fleet_digest', arguments: digestArgs }, 3);
    assert.match(JSON.parse(digest.result.content[0].text).markdown, /Digest/);
    const fwdDigest = stub.received.find((x) => x.name === 'get_fleet_digest');
    assert.ok(fwdDigest, 'get_fleet_digest must reach the backend');
    assert.deepEqual(fwdDigest.args, digestArgs, 'get_fleet_digest arguments must arrive unchanged');

    const overviewArgs = { workspaceId: 'ws-e2e' };
    const overview = await proxy.rpc('tools/call', { name: 'get_fleet_overview', arguments: overviewArgs }, 4);
    assert.equal(JSON.parse(overview.result.content[0].text).success, true);
    const fwdOverview = stub.received.find((x) => x.name === 'get_fleet_overview');
    assert.ok(fwdOverview, 'get_fleet_overview must reach the backend');
    assert.deepEqual(fwdOverview.args, overviewArgs, 'get_fleet_overview arguments must arrive unchanged');
  } finally {
    if (proxy) await proxy.shutdown();
    stub.server.close();
    rmTmp(root);
  }
});

test('KBT-TC4214 (a) — without any settings.json or ANTHROPIC_MODEL the proxy sends NO modelId', { timeout: 60000 }, async () => {
  const root = mkTmp('kbt-f743-proxy-nomodel-');
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const configDir = path.join(root, 'cfg-empty');
  for (const d of [home, work, configDir]) fs.mkdirSync(d, { recursive: true });

  const stub = await startMcpStub();
  const pluginDir = pluginDirFor(root);
  let proxy;
  try {
    const r = await registerThrough(pluginDir, stub, { home, cwd: work, configDir });
    proxy = r.proxy;
    assert.ok(!('modelId' in r.forwarded.args), `modelId must be absent, not empty; got ${JSON.stringify(r.forwarded.args)}`);
    assert.ok(!Object.keys(r.forwarded.args).some((k) => /^modelId/i.test(k)), 'no modelId-like key at all');
  } finally {
    if (proxy) await proxy.shutdown();
    stub.server.close();
    rmTmp(root);
  }
});

test('KBT-TC4214 (a) — lookup order: ~/.claude/settings.json, then <cwd>/.claude/settings.local.json, then <cwd>/.claude/settings.json, then ANTHROPIC_MODEL', { timeout: 120000 }, async () => {
  const root = mkTmp('kbt-f743-proxy-order-');
  const stub = await startMcpStub();
  const pluginDir = pluginDirFor(root);
  const cases = [
    {
      name: 'user settings beat project + env',
      setup: (home, work) => { writeJson(path.join(home, '.claude', 'settings.json'), { model: 'claude-sonnet-5-5' }); writeJson(path.join(work, '.claude', 'settings.local.json'), { model: 'claude-haiku-4-5' }); },
      env: { ANTHROPIC_MODEL: 'claude-opus-4-1' },
      expected: 'claude-sonnet-5-5',
    },
    {
      name: 'project settings.local.json beats project settings.json + env',
      setup: (home, work) => { writeJson(path.join(work, '.claude', 'settings.local.json'), { model: 'claude-haiku-4-5' }); writeJson(path.join(work, '.claude', 'settings.json'), { model: 'claude-sonnet-5-5' }); },
      env: { ANTHROPIC_MODEL: 'claude-opus-4-1' },
      expected: 'claude-haiku-4-5',
    },
    {
      name: 'project settings.json beats env',
      setup: (home, work) => { writeJson(path.join(work, '.claude', 'settings.json'), { model: 'claude-sonnet-5-5' }); },
      env: { ANTHROPIC_MODEL: 'claude-opus-4-1' },
      expected: 'claude-sonnet-5-5',
    },
    {
      name: 'ANTHROPIC_MODEL is the last resort',
      setup: () => {},
      env: { ANTHROPIC_MODEL: 'claude-opus-4-1' },
      expected: 'claude-opus-4-1',
    },
    {
      name: 'a settings.json without a string model is skipped',
      setup: (home) => { writeJson(path.join(home, '.claude', 'settings.json'), { model: 42 }); },
      env: { ANTHROPIC_MODEL: 'claude-opus-4-1' },
      expected: 'claude-opus-4-1',
    },
  ];
  try {
    for (const [i, c] of cases.entries()) {
      const home = path.join(root, `home-${i}`);
      const work = path.join(root, `work-${i}`);
      const configDir = path.join(root, `cfg-${i}`);
      for (const d of [home, work, configDir]) fs.mkdirSync(d, { recursive: true });
      c.setup(home, work);
      const r = await registerThrough(pluginDir, stub, { home, cwd: work, configDir, extraEnv: c.env });
      await r.proxy.shutdown();
      assert.equal(r.forwarded.args.modelId, c.expected, `${c.name}: got ${JSON.stringify(r.forwarded.args)}`);
    }
  } finally {
    stub.server.close();
    rmTmp(root);
  }
});

// ── 3: registry + param-drift contract ───────────────────────────────────────

test('KBT-TC4214 (a) — get_fleet_digest and get_fleet_overview are in known-mcp-tools.json (alphabetical, not curated out)', () => {
  const root = mkTmp('kbt-f743-registry-');
  try {
    const pluginDir = pluginDirFor(root);
    const snapshot = JSON.parse(fs.readFileSync(path.join(pluginDir, 'scripts', 'known-mcp-tools.json'), 'utf8'));
    for (const t of FLEET_TOOLS) {
      assert.ok(snapshot.tools.includes(t), `known-mcp-tools.json must list ${t}`);
      assert.ok(!snapshot.curatedOut.includes(t), `${t} must not be curated out`);
    }
    assert.deepEqual(snapshot.tools, [...snapshot.tools].sort(), 'tools must stay alphabetical');
  } finally {
    rmTmp(root);
  }
});

function runDrift(pluginDir, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(pluginDir, 'scripts', 'check-tool-param-drift.js')], {
      env: { ...process.env, KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`, KANBANTIC_API_KEY: 'test-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const CONTRACT_TOOLS = [
  tool('create_version', ['workspaceId', 'applicationId', 'name']),
  tool('report_tool_activity', ['sessionId', 'toolUseId']),
  tool('request_decision', ['workspaceId', 'question', 'optionsJson', 'recipientRole']),
  tool('answer_decision', ['decisionRequestId', 'optionKey']),
  tool('get_fleet_digest', ['workspaceId']),
  tool('get_fleet_overview', ['workspaceId']),
  // KBT-F745 — get_model_policy joined the required-parameter contract (KBT-SR652 §MCP);
  // every positive stub must expose it or the drift script reports it as missing.
  tool('get_model_policy', ['workspaceId']),
];

test('KBT-TC4214 (a) — check-tool-param-drift.js holds get_fleet_digest/get_fleet_overview to ["workspaceId"]', { timeout: 60000 }, async () => {
  const root = mkTmp('kbt-f743-drift-');
  const pluginDir = pluginDirFor(root);
  const ok = await startMcpStub(CONTRACT_TOOLS);
  const drifted = await startMcpStub([
    ...CONTRACT_TOOLS.filter((t) => t.name !== 'get_fleet_overview'),
    tool('get_fleet_overview', []),
  ]);
  const missing = await startMcpStub(CONTRACT_TOOLS.filter((t) => t.name !== 'get_fleet_digest'));
  try {
    const pass = await runDrift(pluginDir, ok.port);
    assert.equal(pass.code, 0, `expected exit 0; stdout: ${pass.stdout} stderr: ${pass.stderr}`);
    assert.match(pass.stdout, /get_fleet_digest/, 'the report names get_fleet_digest as a checked tool');
    assert.match(pass.stdout, /get_fleet_overview/, 'the report names get_fleet_overview as a checked tool');

    const fail = await runDrift(pluginDir, drifted.port);
    assert.equal(fail.code, 1, `expected exit 1 when get_fleet_overview drops workspaceId; stdout: ${fail.stdout} stderr: ${fail.stderr}`);
    assert.match(fail.stderr, /get_fleet_overview/);
    assert.match(fail.stderr, /workspaceId/);

    const gone = await runDrift(pluginDir, missing.port);
    assert.equal(gone.code, 1, `expected exit 1 when get_fleet_digest is missing; stdout: ${gone.stdout} stderr: ${gone.stderr}`);
    assert.match(gone.stderr, /get_fleet_digest/);
    assert.match(gone.stderr, /not exposed by the live registry/);
  } finally {
    ok.server.close();
    drifted.server.close();
    missing.server.close();
    rmTmp(root);
  }
});
