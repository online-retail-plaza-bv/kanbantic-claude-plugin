'use strict';

//
// wireframe-proxy-e2e.test.js — KBT-F605 / KBT-TC3278 + KBT-TC3279 (real-proxy E2E)
//
// Drijft de ECHTE plugin-parser (parseWireframeBlock) + de ECHTE MCP-proxy-binary aan tegen een
// stub-backend die het API-contract van get_wireframe(page) nabootst (KBT-SR579). Verifieert de
// plugin-kant-orkestratie die de prepare/execute-skills voorschrijven, end-to-end óver de proxy:
//   - TC3278 (prepare-beslissing): een geldig blok → proceed; een bogus/ambigue pagina → fail-not-skip
//     (PageNotFoundInVersion / AmbiguousPage → STOP); een n.v.t.-blok → skip zónder tool-call.
//   - TC3279 (execute bindende context): een geldige pagina levert de markup van DÍE pagina
//     (ResolvedPage + content), nooit de entry-point.
//
// De stap "de agent volgt de SKILL.md-prose" is inherent niet automatiseerbaar; dit dekt het
// automatiseerbare tool-contract waar die skills op leunen. Zero deps — node built-ins.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { parseWireframeBlock } = require('../scripts/wireframe-block.js');
const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');

function jsonContent(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// Bootst het API-get_wireframe(page)-contract na voor de fileset
// {index.html (entry), s-ai-bulk.html, docs/index.html}.
function getWireframeStub(page) {
  if (!page) return { success: true, version: { content: 'ENTRY' } };
  if (page === 's-ai-bulk') return { success: true, resolvedPage: 's-ai-bulk.html', version: { content: 'BULK' } };
  if (page === 's-nope') return { success: false, notFoundKind: 'PageNotFoundInVersion', availablePages: ['index.html', 's-ai-bulk.html', 'docs/index.html'] };
  if (page === 'index') return { success: false, notFoundKind: 'AmbiguousPage', availablePages: ['index.html', 'docs/index.html'] };
  return { success: false, notFoundKind: 'PageNotFoundInVersion', availablePages: [] };
}

function startStub() {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      received.push({ method: msg.method, name: msg.params && msg.params.name, args: msg.params && msg.params.arguments });
      res.setHeader('Mcp-Session-Id', req.headers['mcp-session-id'] || 'stub-session');
      res.setHeader('Content-Type', 'application/json');

      if (msg.method === 'initialize') {
        res.statusCode = 200;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } } }));
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }

      const name = msg.params && msg.params.name;
      const result = name === 'get_wireframe'
        ? jsonContent(getWireframeStub(msg.params.arguments && msg.params.arguments.page))
        : jsonContent({ success: true, echo: name || msg.method });

      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

function spawnProxy(port) {
  const env = { ...process.env, KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`, KANBANTIC_API_KEY: 'test-key' };
  for (const k of ['KANBANTIC_WORKSPACE_ID', 'KANBANTIC_WORKSTATION_ID', 'KANBANTIC_HOST', 'KANBANTIC_SPAWN_COMMAND_ID']) delete env[k];
  const child = spawn(process.execPath, [PROXY_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
      const t = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC timeout ${method} (id=${id}). stderr: ${stderr}`)); } }, 10000);
      if (typeof t.unref === 'function') t.unref();
    });
  }
  async function shutdown() { child.stdin.end(); await exitPromise; }
  return { rpc, shutdown, getStderr: () => stderr };
}

const INIT_PARAMS = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } };

// Parseert het get_wireframe-resultaat uit een tools/call-respons die door de proxy is doorgezet.
function parseToolResult(resp) {
  const text = resp.result.content[0].text;
  return JSON.parse(text);
}

// Spiegelt de skill-beslissing (prepare/execute) op basis van de ECHTE parser + de proxy-tool-call.
async function decide(description, rpc, idBase) {
  const parsed = parseWireframeBlock(description);
  if (!parsed.present) return { action: 'no-block' };
  if (parsed.optOut) return { action: 'skip' };
  if (parsed.incomplete) return { action: 'stop', reason: 'incomplete' };

  const pages = [];
  let id = idBase;
  for (const pagina of parsed.paginas) {
    const resp = await rpc('tools/call', { name: 'get_wireframe', arguments: { wireframeId: parsed.wireframe, versionNumber: parsed.versie, page: pagina } }, id++);
    const wf = parseToolResult(resp);
    if (!wf.success) return { action: 'stop', reason: wf.notFoundKind, available: wf.availablePages };
    pages.push({ pagina, resolvedPage: wf.resolvedPage, content: wf.version && wf.version.content });
  }
  return { action: 'proceed', pages };
}

// ---------------------------------------------------------------------------
// TC3278 — prepare-beslissing: proceed / STOP (fail-not-skip) / skip
// ---------------------------------------------------------------------------

test('TC3278: prepare decisions flow end-to-end through the real proxy', async () => {
  const stub = await startStub();
  const proxy = spawnProxy(stub.port);
  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);

    const valid = await decide('## Wireframe\n- wireframe: adminmeester--spa\n- versie: v23\n- pagina: s-ai-bulk', proxy.rpc, 10);
    assert.equal(valid.action, 'proceed');

    const bogus = await decide('## Wireframe\n- wireframe: adminmeester--spa\n- versie: v23\n- pagina: s-nope', proxy.rpc, 20);
    assert.equal(bogus.action, 'stop');
    assert.equal(bogus.reason, 'PageNotFoundInVersion');

    const ambiguous = await decide('## Wireframe\n- wireframe: adminmeester--spa\n- versie: v23\n- pagina: index', proxy.rpc, 30);
    assert.equal(ambiguous.action, 'stop');
    assert.equal(ambiguous.reason, 'AmbiguousPage');

    const optOut = await decide('## Wireframe — n.v.t. (geen UI)', proxy.rpc, 40);
    assert.equal(optOut.action, 'skip');

    // n.v.t. mag GEEN get_wireframe-call hebben afgevuurd.
    assert.equal(stub.received.filter((r) => r.name === 'get_wireframe' && r.args && r.args.page === undefined).length, 0);
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});

// ---------------------------------------------------------------------------
// TC3279 — execute: de gepinde pagina levert DÍE markup als bindende context
// ---------------------------------------------------------------------------

test('TC3279: execute binds the pinned page markup (not the entry-point) through the real proxy', async () => {
  const stub = await startStub();
  const proxy = spawnProxy(stub.port);
  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);

    const result = await decide('## Wireframe\n- wireframe: adminmeester--spa\n- versie: v23\n- pagina: s-ai-bulk', proxy.rpc, 50);
    assert.equal(result.action, 'proceed');
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].resolvedPage, 's-ai-bulk.html');
    assert.equal(result.pages[0].content, 'BULK'); // de pagina-content, NIET 'ENTRY'
    assert.notEqual(result.pages[0].content, 'ENTRY');
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});
