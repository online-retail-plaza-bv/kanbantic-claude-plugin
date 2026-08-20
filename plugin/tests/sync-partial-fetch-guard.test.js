'use strict';

//
// sync-partial-fetch-guard.test.js — KBT-B654
//
// On 2026-08-14 a SessionStart sync deleted all nine Subagent mirrors of the
// Kanbantic monorepo and stripped them from the manifest. Nothing was wrong
// with the Toolkit: the fetch came back with 17 Skills and 0 Subagents, no
// error, and the hook handed that half-list to a sync running with --force.
// `--force` waived the completeness guard, so the nine unaccounted-for entries
// read as deletions.
//
// These tests pin the two halves of the fix:
//   - `--force` keeps only its local-edit authority; waiving the completeness
//     guard now needs the separate `--prune`;
//   - `fetchToolkitItems` treats a malformed, truncated, or miscounted answer
//     as an error instead of an empty category.
//
// The last test is the regression proper: the real hook, against a stub that
// stops returning Subagents, must leave the existing mirrors alone.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const { runSync, SyncError } = require('../scripts/sync-workspace-skills.js');
const { fetchToolkitItems } = require('../scripts/mcp-toolkit-fetch.js');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'session-start-toolkit-sync.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-b654-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function item(overrides) {
  return Object.assign({
    id: '00000000-0000-0000-0000-000000000001',
    code: 'KBT-SAGN901',
    category: 'Subagent',
    title: 'Stub Agent',
    content: 'body\n',
    model: 'Sonnet',
    isActive: true,
  }, overrides);
}

const SKILL = item({
  id: '00000000-0000-0000-0000-000000000002',
  code: 'KBT-SKIL901',
  category: 'Skill',
  title: '/stub-skill — Stub',
  content: 'skill body\n',
  model: null,
});
const AGENT = item({});

const AGENT_PATH = '.claude/agents/stub-agent.md';
const SKILL_PATH = '.claude/commands/stub-skill.md';

/** A client whose single tool-call always answers with `payload`. */
function clientReturning(payload) {
  return { call: async () => payload };
}

// ---------------------------------------------------------------------------
// Unit — the completeness guard no longer hangs off --force
// ---------------------------------------------------------------------------

test('KBT-B654: --force alleen laat een onvolledige lijst NIET door', () => {
  const dir = mkRepo();
  try {
    runSync({ rootDir: dir, items: [SKILL, AGENT], workspace: 'kanbantic' });
    assert.ok(fs.existsSync(path.join(dir, AGENT_PATH)), 'setup: mirror moet bestaan');

    // Exact het incident: de Subagent-helft ontbreekt in de input.
    assert.throws(
      () => runSync({ rootDir: dir, items: [SKILL], workspace: 'kanbantic', force: true }),
      (err) => err instanceof SyncError && err.kind === 'INCOMPLETE_INPUT'
    );

    assert.ok(
      fs.existsSync(path.join(dir, AGENT_PATH)),
      'de mirror moet er nog staan — er mag niets geschreven of verwijderd zijn'
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.kanbantic-sync.json'), 'utf8'));
    assert.equal(manifest.items.length, 2, 'het manifest mag niet zijn uitgedund');
  } finally {
    cleanup(dir);
  }
});

test('KBT-B654: --prune laat de onvolledige lijst wél door en verwijdert de mirror', () => {
  const dir = mkRepo();
  try {
    runSync({ rootDir: dir, items: [SKILL, AGENT], workspace: 'kanbantic' });

    const summary = runSync({
      rootDir: dir, items: [SKILL], workspace: 'kanbantic', force: true, prune: true,
    });

    assert.equal(summary.deleted, 1);
    assert.ok(!fs.existsSync(path.join(dir, AGENT_PATH)), 'met --prune hoort de mirror weg te zijn');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.kanbantic-sync.json'), 'utf8'));
    assert.equal(manifest.items.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('KBT-B654: --force behoudt zijn eigen bevoegdheid — lokale bewerking wordt overschreven', () => {
  const dir = mkRepo();
  try {
    runSync({ rootDir: dir, items: [SKILL, AGENT], workspace: 'kanbantic' });
    fs.writeFileSync(path.join(dir, AGENT_PATH), 'met de hand aangepast\n', 'utf8');

    // Volledige lijst, dus de completeness-guard heeft niets te melden.
    const summary = runSync({ rootDir: dir, items: [SKILL, AGENT], workspace: 'kanbantic', force: true });

    assert.equal(summary.forced, 1, 'de lokale bewerking hoort overschreven te zijn');
    assert.match(fs.readFileSync(path.join(dir, AGENT_PATH), 'utf8'), /body/);
  } finally {
    cleanup(dir);
  }
});

test('KBT-B654: zonder --force blijft een lokale bewerking staan', () => {
  const dir = mkRepo();
  try {
    runSync({ rootDir: dir, items: [SKILL, AGENT], workspace: 'kanbantic' });
    fs.writeFileSync(path.join(dir, AGENT_PATH), 'met de hand aangepast\n', 'utf8');

    const summary = runSync({ rootDir: dir, items: [SKILL, AGENT], workspace: 'kanbantic' });

    assert.equal(summary.warnings, 1);
    assert.match(fs.readFileSync(path.join(dir, AGENT_PATH), 'utf8'), /met de hand/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Unit — de fetch mag een kapot antwoord niet als lege categorie doorgeven
// ---------------------------------------------------------------------------

test('KBT-B654: fetchToolkitItems werpt bij een payload zonder items-array', async () => {
  await assert.rejects(
    fetchToolkitItems({ workspace: 'kanbantic', client: clientReturning({ success: true }) }),
    /no items array/
  );
});

test('KBT-B654: fetchToolkitItems werpt bij truncated:true', async () => {
  await assert.rejects(
    fetchToolkitItems({
      workspace: 'kanbantic',
      client: clientReturning({ items: [SKILL], totalCount: 1, truncated: true }),
    }),
    /truncated/
  );
});

test('KBT-B654: fetchToolkitItems werpt wanneer totalCount niet klopt', async () => {
  await assert.rejects(
    fetchToolkitItems({
      workspace: 'kanbantic',
      client: clientReturning({ items: [SKILL], totalCount: 9 }),
    }),
    /totalCount 9/
  );
});

test('KBT-B654: een echt lege categorie is geen fout', async () => {
  const items = await fetchToolkitItems({
    workspace: 'kanbantic',
    client: clientReturning({ items: [], totalCount: 0 }),
  });
  assert.deepEqual(items, []);
});

// ---------------------------------------------------------------------------
// Integratie — de hook zelf, tegen een stub die stopt met Subagents
// ---------------------------------------------------------------------------

function runHook(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd,
      env: { ...process.env, KANBANTIC_API_KEY: 'test-key', KANBANTIC_WORKSPACE_ID: 'kanbantic', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const guard = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (status) => { clearTimeout(guard); resolve({ status, stdout, stderr }); });
  });
}

/**
 * Stub MCP backend. `state.dropSubagents` flips mid-test to reproduce the
 * fetch that answered "zero Subagents" without erroring.
 */
async function startStub(items, state) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body); } catch (_) { /* handled below */ }
      const send = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'stub-session-1' });
        res.end(JSON.stringify(payload));
      };
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
        return;
      }
      if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (msg.method === 'tools/call') {
        const category = msg.params?.arguments?.category;
        const matching = (state.dropSubagents && category === 'Subagent')
          ? []
          : items.filter((i) => i.category === category);
        const payload = { success: true, items: matching, totalCount: matching.length };
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
        return;
      }
      res.writeHead(400); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

test('KBT-B654 regressie: een fetch zonder Subagents laat de bestaande mirrors staan', async () => {
  const state = { dropSubagents: false };
  const stub = await startStub([SKILL, AGENT], state);
  const dir = mkRepo();
  try {
    const first = await runHook(dir, { KANBANTIC_MCP_URL: stub.url });
    assert.equal(first.status, 0);
    assert.ok(fs.existsSync(path.join(dir, AGENT_PATH)), 'setup: de hook hoort de mirror te schrijven');
    assert.ok(fs.existsSync(path.join(dir, SKILL_PATH)));

    // Vanaf hier gedraagt de backend zich als op 2026-08-14: Skills wel,
    // Subagents nul, geen foutmelding.
    state.dropSubagents = true;
    const second = await runHook(dir, { KANBANTIC_MCP_URL: stub.url });

    // De hook blijft stil en blokkeert de sessie niet (KBT-BD206).
    assert.equal(second.status, 0);

    assert.ok(
      fs.existsSync(path.join(dir, AGENT_PATH)),
      'de Subagent-mirror is verwijderd door een onvolledige fetch — dit is KBT-B654'
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.kanbantic-sync.json'), 'utf8'));
    assert.equal(manifest.items.length, 2, 'het manifest mag de Subagent-entry niet kwijtraken');
  } finally {
    cleanup(dir);
    stub.server.close();
  }
});
