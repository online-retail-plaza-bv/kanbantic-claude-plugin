'use strict';

//
// filePath → content substitution + tools/list augmentation (KBT-F464).
//
// The kanbantic-mcp-proxy runs locally with filesystem access. When a tools/call
// carries a `filePath` argument, the proxy reads the file from disk and
// substitutes its contents into `content` before forwarding — so large files
// (e.g. a 154KB HTML wireframe for add_wireframe_version) never enter the model's
// context. The proxy also enriches the tools/list response so `filePath` shows up
// as an optional, documented alternative to `content` on every content-bearing
// tool.
//
// Two layers, mirroring the repo's existing proxy tests:
//   - Unit: require() the proxy module (pure helpers, no runtime side effects
//     thanks to the `require.main === module` guards) and exercise
//     resolveFilePathArgument / augmentToolsListResponse directly.
//   - Integration / E2E: spawn the REAL proxy against a stub HTTP backend and
//     assert the forwarded request / returned schema end-to-end.
//
// Zero deps — only node:test, node:assert/strict, node:fs, node:os, node:path,
// node:http, node:child_process. CommonJS to match the proxy's module system.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PROXY_PATH = path.resolve(__dirname, '..', 'proxy', 'kanbantic-mcp-proxy.js');
const proxy = require(PROXY_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpCounter = 0;
function writeTempFile(content) {
  const p = path.join(os.tmpdir(), `kbt-f464-${process.pid}-${tmpCounter++}.html`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ===========================================================================
// Unit tests — resolveFilePathArgument
// ===========================================================================

test('KBT-TC2813 (unit): filePath present → file read, content filled, filePath removed', () => {
  const body = '<html><body>154KB-worth of markup</body></html>';
  const file = writeTempFile(body);
  try {
    const msg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'add_wireframe_version', arguments: { wireframeId: 'wf-1', filePath: file, changesSummary: 'nav update' } },
    };

    const result = proxy.resolveFilePathArgument(msg);

    assert.deepEqual(result, { mutated: true }, 'reports a mutation');
    assert.equal(msg.params.arguments.content, body, 'content holds the file contents');
    assert.equal('filePath' in msg.params.arguments, false, 'filePath is removed');
    assert.equal(msg.params.arguments.wireframeId, 'wf-1', 'other args preserved');
    assert.equal(msg.params.arguments.changesSummary, 'nav update', 'other args preserved');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-TC2814 (unit): only content → unchanged; neither → unchanged', () => {
  // content only
  const m1 = { method: 'tools/call', params: { name: 'add_wireframe_version', arguments: { wireframeId: 'x', content: '<html>inline</html>' } } };
  const before1 = JSON.parse(JSON.stringify(m1));
  assert.deepEqual(proxy.resolveFilePathArgument(m1), {}, 'content-only is a no-op');
  assert.deepEqual(m1, before1, 'content-only message is byte-identical');
  assert.equal('filePath' in m1.params.arguments, false, 'no filePath injected');

  // neither filePath nor content
  const m2 = { method: 'tools/call', params: { name: 'add_wireframe_version', arguments: { wireframeId: 'x' } } };
  const before2 = JSON.parse(JSON.stringify(m2));
  assert.deepEqual(proxy.resolveFilePathArgument(m2), {}, 'neither is a no-op');
  assert.deepEqual(m2, before2, 'message left untouched (server validates)');

  // blank filePath is treated as absent
  const m3 = { method: 'tools/call', params: { name: 't', arguments: { filePath: '   ' } } };
  assert.deepEqual(proxy.resolveFilePathArgument(m3), {}, 'blank filePath is a no-op');

  // non tools/call messages are ignored
  const m4 = { method: 'initialize', params: { arguments: { filePath: '/whatever' } } };
  assert.deepEqual(proxy.resolveFilePathArgument(m4), {}, 'non tools/call ignored');
});

test('KBT-TC2815 (unit): filePath + content both present → ambiguity error, no mutation', () => {
  const file = writeTempFile('<html>file</html>');
  try {
    const msg = { method: 'tools/call', params: { name: 'add_wireframe_version', arguments: { wireframeId: 'x', filePath: file, content: '<html>inline</html>' } } };
    const result = proxy.resolveFilePathArgument(msg);

    assert.ok(result.error, 'returns an error');
    assert.equal(result.error.code, -32602, 'invalid-params code');
    assert.match(result.error.message, /filePath/, 'message names filePath');
    assert.match(result.error.message, /content/, 'message names content');
    // arguments untouched — content not overwritten, filePath retained.
    assert.equal(msg.params.arguments.content, '<html>inline</html>', 'content untouched');
    assert.equal(msg.params.arguments.filePath, file, 'filePath untouched');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-TC2818 (unit): filePath does not exist → clear error naming path + ENOENT, no throw', () => {
  const missing = path.join(os.tmpdir(), `kbt-f464-does-not-exist-${process.pid}-${Date.now()}.html`);
  const msg = { method: 'tools/call', params: { name: 'add_wireframe_version', arguments: { wireframeId: 'x', filePath: missing } } };

  // Must not throw — the failure is returned, not raised.
  const result = proxy.resolveFilePathArgument(msg);

  assert.ok(result.error, 'returns an error rather than throwing');
  assert.equal(result.error.code, -32603, 'internal-error code for a read failure');
  assert.match(result.error.message, /ENOENT/, 'message carries the OS reason');
  assert.ok(result.error.message.includes(missing), 'message carries the offending path');
});

// ===========================================================================
// Unit tests — augmentToolsListResponse (KBT-SR482)
// ===========================================================================

test('augmentToolsListResponse: content-bearing tool gains optional filePath; others untouched', () => {
  const response = {
    result: {
      tools: [
        { name: 'add_wireframe_version', description: 'Add a new wireframe version.', inputSchema: { type: 'object', properties: { wireframeId: { type: 'string' }, content: { type: 'string' } }, required: ['wireframeId', 'content'] } },
        { name: 'list_wireframes', description: 'List wireframes.', inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } } } },
      ],
    },
  };

  proxy.augmentToolsListResponse(response);

  const [withContent, withoutContent] = response.result.tools;
  assert.ok(withContent.inputSchema.properties.filePath, 'filePath added to content-bearing tool');
  assert.equal(withContent.inputSchema.properties.filePath.type, 'string', 'filePath is a string');
  assert.equal(withContent.inputSchema.required.includes('filePath'), false, 'filePath is NOT required');
  assert.match(withContent.description, /filePath/, 'description mentions filePath');

  assert.equal('filePath' in withoutContent.inputSchema.properties, false, 'tool without content is untouched');
  assert.equal(/filePath/.test(withoutContent.description), false, 'description of non-content tool untouched');
});

// ---- KBT-B417: filePath offload must cover add_wireframe_version_files (`filesJson`) ----

test('KBT-B417 (unit): filePath on add_wireframe_version_files → file read into filesJson, filePath removed', () => {
  const filesJson = JSON.stringify([
    { path: 'index.html', content: '<html><link href="style.css"></html>' },
    { path: 'style.css', content: 'body{margin:0}' },
  ]);
  const file = writeTempFile(filesJson);
  try {
    const msg = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'add_wireframe_version_files', arguments: { wireframeId: 'wf-1', filePath: file, changesSummary: 'big fileset' } },
    };
    const result = proxy.resolveFilePathArgument(msg);
    assert.deepEqual(result, { mutated: true }, 'reports a mutation');
    assert.equal(msg.params.arguments.filesJson, filesJson, 'filesJson holds the file contents');
    assert.equal('filePath' in msg.params.arguments, false, 'filePath is removed');
    assert.equal(msg.params.arguments.wireframeId, 'wf-1', 'other args preserved');
    assert.equal(msg.params.arguments.changesSummary, 'big fileset', 'other args preserved');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-B417 (unit): filePath + inline filesJson both present → ambiguity error naming filesJson', () => {
  const file = writeTempFile('[{"path":"index.html","content":"x"}]');
  try {
    const msg = { method: 'tools/call', params: { name: 'add_wireframe_version_files', arguments: { wireframeId: 'x', filePath: file, filesJson: '[{"path":"a.html","content":"y"}]' } } };
    const result = proxy.resolveFilePathArgument(msg);
    assert.ok(result.error, 'returns an error');
    assert.equal(result.error.code, -32602, 'invalid-params code');
    assert.match(result.error.message, /filesJson/, 'message names the filesJson field');
    assert.equal(msg.params.arguments.filePath, file, 'filePath untouched (not forwarded)');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-B417 (unit): augmentToolsListResponse advertises filePath on add_wireframe_version_files (filesJson)', () => {
  const response = { result: { tools: [
    { name: 'add_wireframe_version_files', description: 'Add a fileset version.', inputSchema: { type: 'object', properties: { wireframeId: { type: 'string' }, filesJson: { type: 'string' } }, required: ['wireframeId', 'filesJson'] } },
  ] } };
  proxy.augmentToolsListResponse(response);
  const t = response.result.tools[0];
  assert.ok(t.inputSchema.properties.filePath, 'filePath advertised');
  assert.equal(t.inputSchema.properties.filePath.type, 'string', 'filePath is a string');
  assert.equal(t.inputSchema.required.includes('filesJson'), false, 'filesJson removed from required');
  assert.equal(t.inputSchema.required.includes('filePath'), false, 'filePath is NOT required');
  assert.match(t.description, /filePath/, 'description mentions filePath');
});

test('augmentToolsListResponse: idempotent + tolerant of malformed responses', () => {
  // Idempotent: pre-existing filePath property is not clobbered.
  const custom = { type: 'string', description: 'custom' };
  const response = { result: { tools: [{ name: 't', description: 'd', inputSchema: { properties: { content: { type: 'string' }, filePath: custom } } }] } };
  proxy.augmentToolsListResponse(response);
  assert.equal(response.result.tools[0].inputSchema.properties.filePath, custom, 'existing filePath preserved');

  // Tolerant: no tools array / no result → no throw.
  assert.doesNotThrow(() => proxy.augmentToolsListResponse({}));
  assert.doesNotThrow(() => proxy.augmentToolsListResponse({ result: {} }));
  assert.doesNotThrow(() => proxy.augmentToolsListResponse({ result: { tools: [{ name: 'x' }] } }));
});

// ===========================================================================
// Integration / E2E — spawn the real proxy against a stub backend
// ===========================================================================

function startStubBackend() {
  const received = [];
  let toolsListPayload = null; // set per-test

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
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end('bad json');
        return;
      }
      received.push({ method: msg.method, params: msg.params, id: msg.id });

      const sid = req.headers['mcp-session-id'] || `stub-${Math.random().toString(36).slice(2, 10)}`;
      res.setHeader('Mcp-Session-Id', sid);
      res.setHeader('Content-Type', 'application/json');

      if (msg.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }

      let result;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } };
      } else if (msg.method === 'tools/list') {
        result = toolsListPayload;
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      } else {
        result = { content: [{ type: 'text', text: JSON.stringify({ success: false }) }] };
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        received,
        setToolsList: (p) => { toolsListPayload = p; },
      });
    });
  });
}

function spawnProxy(port) {
  const child = spawn(process.execPath, [PROXY_PATH], {
    env: { ...process.env, KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`, KANBANTIC_API_KEY: 'test-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
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
      if (msg.id != null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderr += c));

  function rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const t = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout (10s): ${method} (id=${id}). stderr: ${stderr}`));
        }
      }, 10000);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  return { child, rpc, getStderr: () => stderr };
}

async function initProxy(p) {
  await p.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'filepath-test', version: '1.0.0' } }, 1);
}

function teardown(p, stub) {
  p.child.stdin.end();
  if (p.child.exitCode == null && !p.child.killed) p.child.kill('SIGKILL');
  stub.server.close();
}

test('KBT-TC2816 (integration): filePath read end-to-end → backend receives content, not filePath', async () => {
  const stub = await startStubBackend();
  const p = spawnProxy(stub.port);
  const body = '<html><body>real proxy round-trip</body></html>';
  const file = writeTempFile(body);

  try {
    await initProxy(p);

    const resp = await p.rpc('tools/call', { name: 'add_wireframe_version', arguments: { wireframeId: 'wf-9', filePath: file, changesSummary: 'e2e' } }, 2);
    assert.equal(JSON.parse(resp.result.content[0].text).success, true, 'proxy returns the backend success result');

    const call = stub.received.find((r) => r.method === 'tools/call' && r.params && r.params.name === 'add_wireframe_version');
    assert.ok(call, 'backend received the tools/call');
    assert.equal(call.params.arguments.content, body, 'backend received content read from disk');
    assert.equal('filePath' in call.params.arguments, false, 'backend never sees filePath');
    assert.equal(call.params.arguments.wireframeId, 'wf-9', 'other args forwarded intact');
  } finally {
    fs.unlinkSync(file);
    teardown(p, stub);
  }
});

test('KBT-TC2817 (e2e): tools/list response is augmented with an optional filePath parameter', async () => {
  const stub = await startStubBackend();
  stub.setToolsList({
    tools: [
      { name: 'add_wireframe_version', description: 'Add a new wireframe version.', inputSchema: { type: 'object', properties: { wireframeId: { type: 'string' }, content: { type: 'string' } }, required: ['wireframeId', 'content'] } },
      { name: 'list_wireframes', description: 'List wireframes.', inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } } } },
    ],
  });
  const p = spawnProxy(stub.port);

  try {
    await initProxy(p);

    const resp = await p.rpc('tools/list', {}, 2);
    const tools = resp.result.tools;
    const withContent = tools.find((t) => t.name === 'add_wireframe_version');
    const withoutContent = tools.find((t) => t.name === 'list_wireframes');

    assert.ok(withContent.inputSchema.properties.filePath, 'content-bearing tool advertises filePath');
    assert.equal(withContent.inputSchema.properties.filePath.type, 'string');
    assert.equal(withContent.inputSchema.required.includes('filePath'), false, 'filePath is optional');
    assert.match(withContent.description, /filePath/, 'description documents filePath');

    assert.equal('filePath' in withoutContent.inputSchema.properties, false, 'tool without content is untouched');
  } finally {
    teardown(p, stub);
  }
});

test('KBT-TC2815 (integration): ambiguity error round-trips through the real proxy and is NOT forwarded', async () => {
  const stub = await startStubBackend();
  const p = spawnProxy(stub.port);
  const file = writeTempFile('<html>file</html>');

  try {
    await initProxy(p);

    const resp = await p.rpc('tools/call', { name: 'add_wireframe_version', arguments: { wireframeId: 'x', filePath: file, content: '<html>inline</html>' } }, 2);
    assert.ok(resp.error, 'proxy returns a JSON-RPC error');
    assert.equal(resp.error.code, -32602);

    // Give any (erroneous) forward time to land, then assert the backend saw nothing.
    await new Promise((r) => setTimeout(r, 200));
    const forwarded = stub.received.some((r) => r.method === 'tools/call');
    assert.equal(forwarded, false, 'ambiguous call was not forwarded to the backend');
  } finally {
    fs.unlinkSync(file);
    teardown(p, stub);
  }
});

// ===========================================================================
// create_wireframe uses `initialContent`, not `content` (KBT-B390 / KBT-TC2871)
//
// The filePath machinery must target whichever field a tool actually uses for its
// inline body. create_wireframe seeds version 1 from `initialContent`, so the proxy
// must (a) read filePath into `initialContent` (not `content`) at call-time, and
// (b) advertise filePath + drop `initialContent` from required in tools/list.
// ===========================================================================

test('KBT-B390 (unit): create_wireframe filePath → read into initialContent, filePath removed', () => {
  const body = '<html><body>~130KB self-contained wireframe</body></html>';
  const file = writeTempFile(body);
  try {
    const msg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_wireframe', arguments: { applicationId: 'app-1', name: 'Storefront', filePath: file } },
    };

    const result = proxy.resolveFilePathArgument(msg);

    assert.deepEqual(result, { mutated: true }, 'reports a mutation');
    assert.equal(msg.params.arguments.initialContent, body, 'initialContent holds the file contents');
    assert.equal('content' in msg.params.arguments, false, 'content field is NOT populated for create_wireframe');
    assert.equal('filePath' in msg.params.arguments, false, 'filePath is removed');
    assert.equal(msg.params.arguments.applicationId, 'app-1', 'other args preserved');
    assert.equal(msg.params.arguments.name, 'Storefront', 'other args preserved');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-B390 (unit): create_wireframe filePath + initialContent both → ambiguity error naming initialContent', () => {
  const file = writeTempFile('<html>file</html>');
  try {
    const msg = { method: 'tools/call', params: { name: 'create_wireframe', arguments: { applicationId: 'app-1', name: 'x', filePath: file, initialContent: '<html>inline</html>' } } };
    const result = proxy.resolveFilePathArgument(msg);

    assert.ok(result.error, 'returns an error');
    assert.equal(result.error.code, -32602, 'invalid-params code');
    assert.match(result.error.message, /filePath/, 'message names filePath');
    assert.match(result.error.message, /initialContent/, 'message names initialContent (not content)');
    // arguments untouched — initialContent not overwritten, filePath retained.
    assert.equal(msg.params.arguments.initialContent, '<html>inline</html>', 'initialContent untouched');
    assert.equal(msg.params.arguments.filePath, file, 'filePath untouched');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-B390 (unit): augmentToolsListResponse advertises filePath on create_wireframe + drops initialContent from required', () => {
  const response = {
    result: {
      tools: [
        { name: 'create_wireframe', description: 'Create a wireframe with its first version.', inputSchema: { type: 'object', properties: { applicationId: { type: 'string' }, name: { type: 'string' }, initialContent: { type: 'string' } }, required: ['applicationId', 'name', 'initialContent'] } },
        { name: 'list_wireframes', description: 'List wireframes.', inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } } } },
      ],
    },
  };

  proxy.augmentToolsListResponse(response);

  const [createWf, listWf] = response.result.tools;
  assert.ok(createWf.inputSchema.properties.filePath, 'filePath added to create_wireframe');
  assert.equal(createWf.inputSchema.properties.filePath.type, 'string', 'filePath is a string');
  assert.equal(createWf.inputSchema.required.includes('filePath'), false, 'filePath is NOT required');
  assert.equal(createWf.inputSchema.required.includes('initialContent'), false, 'initialContent dropped from required');
  assert.deepEqual(createWf.inputSchema.required, ['applicationId', 'name'], 'other required fields preserved');
  assert.match(createWf.description, /filePath/, 'description mentions filePath');

  assert.equal('filePath' in listWf.inputSchema.properties, false, 'tool without a content field is untouched');
});

test('KBT-B390 (integration): create_wireframe filePath read end-to-end → backend receives initialContent, not content/filePath', async () => {
  const stub = await startStubBackend();
  const p = spawnProxy(stub.port);
  const body = '<html><body>real proxy round-trip for v1</body></html>';
  const file = writeTempFile(body);

  try {
    await initProxy(p);

    const resp = await p.rpc('tools/call', { name: 'create_wireframe', arguments: { applicationId: 'app-9', name: 'PIM', filePath: file } }, 2);
    assert.equal(JSON.parse(resp.result.content[0].text).success, true, 'proxy returns the backend success result');

    const call = stub.received.find((r) => r.method === 'tools/call' && r.params && r.params.name === 'create_wireframe');
    assert.ok(call, 'backend received the tools/call');
    assert.equal(call.params.arguments.initialContent, body, 'backend received initialContent read from disk');
    assert.equal('content' in call.params.arguments, false, 'backend never sees a content field');
    assert.equal('filePath' in call.params.arguments, false, 'backend never sees filePath');
    assert.equal(call.params.arguments.applicationId, 'app-9', 'other args forwarded intact');
  } finally {
    fs.unlinkSync(file);
    teardown(p, stub);
  }
});

test('KBT-B390 (e2e): tools/list augments create_wireframe with optional filePath; initialContent no longer required', async () => {
  const stub = await startStubBackend();
  stub.setToolsList({
    tools: [
      { name: 'create_wireframe', description: 'Create a wireframe with its first version.', inputSchema: { type: 'object', properties: { applicationId: { type: 'string' }, name: { type: 'string' }, initialContent: { type: 'string' } }, required: ['applicationId', 'name', 'initialContent'] } },
      { name: 'list_wireframes', description: 'List wireframes.', inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } } } },
    ],
  });
  const p = spawnProxy(stub.port);

  try {
    await initProxy(p);

    const resp = await p.rpc('tools/list', {}, 2);
    const tools = resp.result.tools;
    const createWf = tools.find((t) => t.name === 'create_wireframe');
    const listWf = tools.find((t) => t.name === 'list_wireframes');

    assert.ok(createWf.inputSchema.properties.filePath, 'create_wireframe advertises filePath');
    assert.equal(createWf.inputSchema.properties.filePath.type, 'string');
    assert.equal(createWf.inputSchema.required.includes('filePath'), false, 'filePath is optional');
    assert.equal(createWf.inputSchema.required.includes('initialContent'), false, 'initialContent no longer required');
    assert.match(createWf.description, /filePath/, 'description documents filePath');

    assert.equal('filePath' in listWf.inputSchema.properties, false, 'tool without a content field is untouched');
  } finally {
    teardown(p, stub);
  }
});

// ===========================================================================
// KBT-B398 — double-wrap guard.
//
// A wireframe upload via filePath must never store a serialized MCP *response*
// that was saved to disk by mistake ({"success":...,"version":{"content":...}}).
// Storing it verbatim buries the real HTML one level deep and the preview renders
// JSON. The proxy detects the response fingerprint and refuses (‑32602, not
// forwarded) instead of silently corrupting the wireframe. Raw HTML — which starts
// with `<`, not `{` — is never misdetected, and the guard is scoped to the
// wireframe-content tools so other tools may still upload JSON via filePath.
// ===========================================================================

const SAVED_ENVELOPE = JSON.stringify({
  success: true,
  version: { versionNumber: 11, content: '<!DOCTYPE html>\n<html lang="nl"><body>real</body></html>' },
});

test('KBT-TC2937 (unit): add_wireframe_version filePath pointing at a saved API envelope → -32602, no mutation', () => {
  const file = writeTempFile(SAVED_ENVELOPE);
  try {
    const msg = { method: 'tools/call', params: { name: 'add_wireframe_version', arguments: { wireframeId: 'wf-1', filePath: file } } };
    const result = proxy.resolveFilePathArgument(msg);

    assert.ok(result.error, 'returns an error rather than mutating');
    assert.equal(result.error.code, -32602, 'invalid-params code');
    assert.match(result.error.message, /saved/i, 'message flags a saved API response');
    assert.match(result.error.message, /\.version\.content/, 'message points at the real HTML field');
    assert.equal('content' in msg.params.arguments, false, 'content not filled from the envelope');
    assert.equal(msg.params.arguments.filePath, file, 'filePath retained (call not forwarded)');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-TC2937 (unit): create_wireframe filePath pointing at a saved envelope → -32602 (initialContent not filled)', () => {
  const file = writeTempFile(SAVED_ENVELOPE);
  try {
    const msg = { method: 'tools/call', params: { name: 'create_wireframe', arguments: { applicationId: 'app-1', name: 'x', filePath: file } } };
    const result = proxy.resolveFilePathArgument(msg);

    assert.ok(result.error, 'returns an error');
    assert.equal(result.error.code, -32602);
    assert.equal('initialContent' in msg.params.arguments, false, 'initialContent not filled from the envelope');
    assert.equal(msg.params.arguments.filePath, file, 'filePath retained');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-TC2937 (unit): raw HTML containing JSON-like text still uploads (no false positive)', () => {
  const html = '<!DOCTYPE html>\n<html><body><pre>{"success":true,"version":{"content":"x"}}</pre></body></html>';
  const file = writeTempFile(html);
  try {
    const msg = { method: 'tools/call', params: { name: 'add_wireframe_version', arguments: { wireframeId: 'wf-1', filePath: file } } };
    const result = proxy.resolveFilePathArgument(msg);
    assert.deepEqual(result, { mutated: true }, 'raw HTML is not misdetected as an envelope');
    assert.equal(msg.params.arguments.content, html, 'content holds the raw HTML');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-TC2937 (unit): envelope guard is scoped to wireframe tools — other tools may upload JSON via filePath', () => {
  const file = writeTempFile(SAVED_ENVELOPE);
  try {
    const msg = { method: 'tools/call', params: { name: 'add_discussion_entry', arguments: { issueId: 'x', filePath: file } } };
    const result = proxy.resolveFilePathArgument(msg);
    assert.deepEqual(result, { mutated: true }, 'non-wireframe tool is not subject to the guard');
    assert.equal(msg.params.arguments.content, SAVED_ENVELOPE, 'content forwarded verbatim for non-wireframe tools');
  } finally {
    fs.unlinkSync(file);
  }
});

test('KBT-TC2938 (integration): a saved-envelope filePath is rejected by the real proxy and NOT forwarded', async () => {
  const stub = await startStubBackend();
  const p = spawnProxy(stub.port);
  const file = writeTempFile(SAVED_ENVELOPE);

  try {
    await initProxy(p);

    const resp = await p.rpc('tools/call', { name: 'add_wireframe_version', arguments: { wireframeId: 'wf-1', filePath: file } }, 2);
    assert.ok(resp.error, 'proxy returns a JSON-RPC error');
    assert.equal(resp.error.code, -32602);

    // Give any (erroneous) forward time to land, then assert the backend saw nothing.
    await new Promise((r) => setTimeout(r, 200));
    const forwarded = stub.received.some((r) => r.method === 'tools/call');
    assert.equal(forwarded, false, 'envelope upload was not forwarded to the backend');
  } finally {
    fs.unlinkSync(file);
    teardown(p, stub);
  }
});
