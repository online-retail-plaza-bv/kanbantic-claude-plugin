'use strict';

//
// memory-guard.test.js — KBT-B492 / KBT-TC3583
//
// Integration-covers the chain AFTER a successful path match:
// workspace detection → Toolkit lookup → permissionDecision.
//
// The five negative cases matter more than the single positive one. KBT-SR611
// forbids a hard-coded rule text, so the hook depends on an external lookup
// that can fail; KBT-BD210 requires every one of those failures to fail OPEN.
// A hook that blocks every Write during a network blip would stop work in
// arbitrary repositories — a worse defect than the one it guards against.
//
// Runs against a real HTTP stub on 127.0.0.1, same approach as
// session-start-toolkit-sync.test.js. No network, no external deps.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'pre-tool-use-memory-guard.js');

const MEMORY_PATH = '/home/x/.claude/projects/some-slug/memory/fact.md';
const RULE_BODY =
  'Leg kennis vast in de AI Toolkit, nooit in ~/.claude/.../memory/ of MEMORY.md.\n';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b492-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run the hook as a child process with a PreToolUse payload on stdin.
 *
 * Async `spawn`, not `spawnSync`: the stub backend lives in this same process
 * and spawnSync would block the event loop, so the server would never accept
 * the connection and every request would "time out" against a stub that was
 * never listening.
 */
function runHook(cwd, filePath, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], {
      cwd,
      env: {
        ...process.env,
        // Default to "unconfigured" so each test opts in to what it needs.
        KANBANTIC_API_KEY: '',
        KANBANTIC_WORKSPACE_ID: '',
        KANBANTIC_MCP_URL: 'http://127.0.0.1:1/mcp',
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    const guard = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (status) => {
      clearTimeout(guard);
      resolve({ status, stdout, stderr, ms: Date.now() - started });
    });

    child.stdin.end(
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } })
    );
  });
}

function ruleItem(overrides) {
  return Object.assign(
    {
      id: '00000000-0000-0000-0000-000000000000',
      code: 'KBT-TRUL021',
      category: 'Rule',
      title: 'NOOIT lokale memory — kennis hoort in de AI Toolkit',
      content: RULE_BODY,
      isActive: true,
    },
    overrides
  );
}

/**
 * Stub MCP backend. Records every tools/call so a test can assert whether the
 * lookup happened at all — the assertion that distinguishes "read the rule from
 * the Toolkit" from "hard-coded the text and never called".
 */
async function startStub({ items = [], mode = 'ok' } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body); } catch (_) { /* recorded below */ }

      const send = (payload) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'stub-session-1',
        });
        res.end(JSON.stringify(payload));
      };

      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202); res.end();
        return;
      }
      if (msg.method === 'tools/call') {
        calls.push({
          name: msg.params?.name,
          args: msg.params?.arguments,
        });

        if (mode === 'hang') return; // never answer — exercises the timeout

        if (mode === 'garbage') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{ this is not json');
          return;
        }

        const payload = { success: true, items };
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        });
        return;
      }
      res.writeHead(400); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, calls, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

// ---------------------------------------------------------------------------
// Positive path
// ---------------------------------------------------------------------------

test('KBT-TC3583 #1: a memory write asks for confirmation, quoting the Toolkit rule', async () => {
  const stub = await startStub({ items: [ruleItem()] });
  const dir = tmpDir();
  try {
    const r = await runHook(dir, MEMORY_PATH, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: stub.url,
    });

    assert.equal(r.status, 0, 'ask must exit 0 — exit 2 is the deny contract');

    const decision = JSON.parse(r.stdout);
    assert.equal(decision.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(
      decision.hookSpecificOutput.permissionDecision,
      'ask',
      'KBT-RL212: ask, never deny and never a silent allow'
    );

    const reason = decision.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.includes(MEMORY_PATH), 'the offending path must be named');
    assert.ok(
      reason.includes(RULE_BODY.trim()),
      'the rule body must be reproduced verbatim from the Toolkit, not paraphrased'
    );
    assert.ok(reason.includes('create_toolkit_item'), 'must name the alternative');

    // The assertion that catches a hard-coded rule text (KBT-SR611): without
    // it, an implementation that never calls the Toolkit passes everything
    // above by simply embedding the same string.
    const lookups = stub.calls.filter((c) => c.name === 'list_toolkit_items');
    assert.equal(lookups.length, 1, 'the Toolkit must actually be consulted');
    assert.equal(lookups[0].args.category, 'Rule');
    assert.equal(
      lookups[0].args.includeContent,
      true,
      'Rule listings return summaries without a body unless includeContent is set — ' +
        'selecting on content against a body-less payload would silently match nothing'
    );
  } finally {
    stub.server.close();
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// The ordering guarantee (KBT-SR611)
// ---------------------------------------------------------------------------

test('KBT-TC3583: a non-matching path costs no network call at all', async () => {
  const stub = await startStub({ items: [ruleItem()] });
  const dir = tmpDir();
  try {
    const r = await runHook(dir, 'src/Kanbantic.Domain/Foo.cs', {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: stub.url,
    });

    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'no decision object for a miss');
    assert.equal(
      stub.calls.length,
      0,
      'the path match must short-circuit BEFORE any lookup — this runs on every ' +
        'Write and Edit in every repository'
    );
  } finally {
    stub.server.close();
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Fail-open paths (KBT-BD210) — the important half
// ---------------------------------------------------------------------------

test('KBT-TC3583 #2: no workspace detected ⇒ allow silently', async () => {
  const dir = tmpDir(); // plain temp dir: no git repo, no manifest
  try {
    const r = await runHook(dir, MEMORY_PATH, {
      KANBANTIC_API_KEY: 'test-key',
      // no KANBANTIC_WORKSPACE_ID, and layer 3 has nowhere to reach
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    cleanup(dir);
  }
});

test('KBT-TC3583 #3: Toolkit unreachable ⇒ allow silently', async () => {
  const dir = tmpDir();
  try {
    const r = await runHook(dir, MEMORY_PATH, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: 'http://127.0.0.1:1/mcp', // nothing listens on port 1
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    cleanup(dir);
  }
});

test('KBT-TC3583 #4: Toolkit hangs ⇒ times out and allows, without wedging the write', async () => {
  const stub = await startStub({ mode: 'hang' });
  const dir = tmpDir();
  try {
    const r = await runHook(dir, MEMORY_PATH, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: stub.url,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(
      r.ms < 20000,
      `must return on its own timeout, took ${r.ms}ms — a hook that hangs blocks the tool call`
    );
  } finally {
    stub.server.close();
    cleanup(dir);
  }
});

test('KBT-TC3583 #5: workspace declares no local-memory rule ⇒ allow silently', async () => {
  // A Rule list that is non-empty but says nothing about memory. The plugin has
  // no standing to impose one workspace's convention on another (KBT-TRUL028).
  const stub = await startStub({
    items: [
      ruleItem({
        code: 'KBT-TRUL099',
        title: 'Commit message convention',
        content: 'Use conventional commits: feat, fix, refactor.\n',
      }),
    ],
  });
  const dir = tmpDir();
  try {
    const r = await runHook(dir, MEMORY_PATH, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: stub.url,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(
      stub.calls.some((c) => c.name === 'list_toolkit_items'),
      'the lookup did happen — the silence is a decision, not a skipped step'
    );
  } finally {
    stub.server.close();
    cleanup(dir);
  }
});

test('KBT-TC3583 #6: unparseable Toolkit answer ⇒ allow silently', async () => {
  const stub = await startStub({ mode: 'garbage' });
  const dir = tmpDir();
  try {
    const r = await runHook(dir, MEMORY_PATH, {
      KANBANTIC_API_KEY: 'test-key',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: stub.url,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    stub.server.close();
    cleanup(dir);
  }
});

test('KBT-TC3583: no API key ⇒ allow silently, without contacting anything', async () => {
  const stub = await startStub({ items: [ruleItem()] });
  const dir = tmpDir();
  try {
    const r = await runHook(dir, MEMORY_PATH, {
      KANBANTIC_API_KEY: '',
      KANBANTIC_WORKSPACE_ID: 'kanbantic',
      KANBANTIC_MCP_URL: stub.url,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.server.close();
    cleanup(dir);
  }
});

test('KBT-TC3583: garbage stdin ⇒ allow silently', async () => {
  const dir = tmpDir();
  try {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK], {
        cwd: dir,
        env: { ...process.env, KANBANTIC_API_KEY: 'test-key' },
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => { stdout += c; });
      const guard = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.on('close', (status) => { clearTimeout(guard); resolve({ status, stdout }); });
      child.stdin.end('not json at all');
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    cleanup(dir);
  }
});
