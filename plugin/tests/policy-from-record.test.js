'use strict';

//
// policy-from-record.test.js — KBT-B560 / KBT-TC3448..KBT-TC3452
//
// The mirror image of KBT-B551. That bug was `kanbantic-issue-prepare` WRITING
// the test-policy only as a `Decision`-entry and never to the policy record.
// This one is two other lane-skills still READING it back out of that entry:
//
//   - kanbantic-issue-execute §3c  — parsed the Markdown table into frozenPolicy
//   - kanbantic-issue-review Step 1b — did the same for the review-context
//
// Reachable without anything unusual happening: review Step 5a instructs the
// reviewer to call `set_test_policy` AFTER the claim (E2E → N.v.t. for a Feature
// with no E2E surface, so `update_user_story(Approved)` does not wedge). That
// call moves the RECORD and leaves the entry untouched. From then on both skills
// compute coverage from stale numbers while the gates use the live ones — the
// lane that changes the policy is the lane that cannot see its own change.
//
// Three layers, matching the frozen test-policy (KBT-F442 / Regel E):
//
//   - Unit (TC3448, TC3449, TC3450): structural assertions over the on-disk
//     skill files. Pure fs reads, no network, no mutation.
//   - Integration (TC3451): the shipped guard `lint-skills.js` spawned as a
//     fresh child process — positive over the real tree, a negative control
//     that must go red, and a marker case that must stay green. A guard that
//     cannot fail is not a guard (KBT-B483).
//   - E2E (TC3452): the real bundled proxy against a stub that keeps an actual
//     policy record with freeze semantics, replaying prepare → claim → the
//     Step 5a post-claim override → read-back.
//
// Deliberately NOT asserted anywhere: "a test-policy Decision-entry exists".
// That check was green for the entire lifetime of both bugs.
//
// Zero deps — node:test + node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'plugin', 'skills');
const LINT_SCRIPT = path.join(REPO_ROOT, 'plugin', 'scripts', 'lint-skills.js');
const SNAPSHOT = path.join(REPO_ROOT, 'plugin', 'scripts', 'known-mcp-tools.json');
const PROXY_PATH = path.join(REPO_ROOT, 'plugin', 'proxy', 'kanbantic-mcp-proxy.js');

const read = (...p) => fs.readFileSync(path.join(SKILLS_ROOT, ...p), 'utf8');

// Same over-match guard as prepare-test-policy-record.test.js: `assert.ok(m)`
// only catches "matched nothing"; the silent failure is a lazy match running on
// past a renamed heading and swallowing half the file, after which every
// includes() below passes on a span that proves nothing.
const MAX_SECTION_CHARS = 8000;

function section(label, content, re, nextHeading) {
  const m = content.match(re);
  assert.ok(m, `${label} section not found`);
  const s = m[0];
  assert.ok(
    s.length <= MAX_SECTION_CHARS,
    `${label} span is ${s.length} chars (> ${MAX_SECTION_CHARS}) — the regex over-matched past its section; assertions on it would be meaningless`
  );
  assert.ok(
    !s.includes(nextHeading),
    `${label} span must not contain ${nextHeading} — the lookahead failed to terminate the match at the section boundary`
  );
  return s;
}

// The response fields of the live get_test_policy tool. The whole bug class is
// a prescribed procedure that does not match reality, so the prescribed READ
// must be checked against the real response shape, not merely be present.
const POLICY_RESPONSE_FIELDS = ['applicability', 'minCount', 'notApplicableReason', 'isFrozen'];

// Phrasings that mean "derive the policy from the discussion entry". Any of
// these surviving in a policy section is the defect itself.
const PARSE_PHRASES = [
  'Parse the Markdown table',
  'Parse the table',
  'locate the entry whose content starts with',
];

// ─── KBT-TC3448 (unit) — execute §3c reads the record ─────────────────────────

const EXECUTE_3C = [
  'execute §3c',
  /### 3c: Load frozen test-policy[\s\S]*?(?=### 3b:|## Step 4)/,
  '### 3b:',
];

test('KBT-TC3448: execute §3c reads the policy via get_test_policy', () => {
  const s = section(EXECUTE_3C[0], read('kanbantic-issue-execute', 'SKILL.md'), EXECUTE_3C[1], EXECUTE_3C[2]);

  assert.ok(
    s.includes('mcp__kanbantic__get_test_policy(issueId)'),
    'execute §3c must call get_test_policy(issueId) — the tool exists for exactly this (KBT-F591)'
  );
  for (const field of POLICY_RESPONSE_FIELDS) {
    assert.ok(
      s.includes(field),
      `execute §3c must map the live response field "${field}" — a read that ignores the real shape is the same failure class`
    );
  }
  // The response is English, the skill reasons in Dutch labels. Leaving that
  // mapping implicit would reintroduce the class in a new place.
  assert.ok(
    /Required/.test(s) && /NotApplicable/.test(s) && /Vereist/.test(s) && /N\.v\.t\./.test(s),
    'execute §3c must state the Required/NotApplicable → Vereist/N.v.t. enum mapping explicitly'
  );
});

test('KBT-TC3448: execute §3c no longer prescribes parsing the Decision-entry', () => {
  const s = section(EXECUTE_3C[0], read('kanbantic-issue-execute', 'SKILL.md'), EXECUTE_3C[1], EXECUTE_3C[2]);

  for (const phrase of PARSE_PHRASES) {
    assert.ok(
      !s.includes(phrase),
      `execute §3c must not instruct "${phrase}" — the entry is a snapshot, the record is the truth (KBT-B560)`
    );
  }
  // The entry is kept, but demoted to motivering. Deleting it would lose the
  // *why*, which no record can carry (richting-punt 2 of the issue).
  assert.ok(
    s.includes('## Test-policy (bevroren bij claim_issue'),
    'execute §3c must still reference the Decision-entry as readable motivering'
  );
  assert.ok(
    /NOOIT uit de .?Decision.?-entry|NOOIT|nooit als (reken)?bron/i.test(s),
    'execute §3c must say in so many words that the entry is never the source of a calculation'
  );
  assert.ok(
    /momentopname|snapshot/i.test(s),
    'execute §3c must explain WHY the entry cannot be trusted (it is a snapshot), not merely forbid it'
  );
});

test('KBT-TC3448: the Step 7 coverage gate re-reads the record rather than trusting §3c', () => {
  const content = read('kanbantic-issue-execute', 'SKILL.md');
  const m = content.match(/2\. \*\*Test-policy coverage\*\*[\s\S]{0,900}/);
  assert.ok(m, 'Step 7 test-policy coverage condition not found');
  assert.ok(
    m[0].includes('get_test_policy'),
    'the Step 7 gate must re-read get_test_policy — it is the gate, and the record can have moved since the claim'
  );
});

// ─── KBT-TC3449 (unit) — review Step 1b + reviewer-prompt read the record ─────

const REVIEW_1B = [
  'review Step 1b',
  /## Step 1b: Load Review Context[\s\S]*?(?=## Step 2:)/,
  '## Step 2:',
];

test('KBT-TC3449: review Step 1b builds the policy-context via get_test_policy', () => {
  const s = section(REVIEW_1B[0], read('kanbantic-issue-review', 'SKILL.md'), REVIEW_1B[1], REVIEW_1B[2]);

  assert.ok(
    s.includes('mcp__kanbantic__get_test_policy(issueId)'),
    'review Step 1b must call get_test_policy(issueId)'
  );
  for (const phrase of PARSE_PHRASES) {
    assert.ok(
      !s.includes(phrase),
      `review Step 1b must not instruct "${phrase}" (KBT-B560)`
    );
  }
  for (const field of POLICY_RESPONSE_FIELDS) {
    assert.ok(s.includes(field), `review Step 1b must map the live response field "${field}"`);
  }
  // Review is the ONLY lane that mutates the policy after the freeze. If that
  // is not stated here, the instruction reads as arbitrary and gets "improved"
  // back into a parse the next time someone tidies the file.
  assert.ok(
    /Step 5a/.test(s),
    'review Step 1b must name Step 5a as the reason the record can diverge from the entry'
  );
});

test('KBT-TC3449: review Step 5a flags that its own set_test_policy call moves only the record', () => {
  const content = read('kanbantic-issue-review', 'SKILL.md');
  const m = content.match(/### 5a: APPROVE[\s\S]*?(?=### 5b:)/);
  assert.ok(m, 'review Step 5a section not found');
  const s = m[0];

  assert.ok(s.includes('set_test_policy'), 'Step 5a must still prescribe set_test_policy for the E2E-N.v.t. route');
  assert.ok(
    /KBT-B560/.test(s),
    'Step 5a must cross-reference KBT-B560 — this call is the mechanism by which record and entry diverge'
  );
  assert.ok(
    /re-read|herlees|opnieuw/i.test(s),
    'Step 5a must impose a re-read obligation when the policy is changed after the review-context was built'
  );
});

test('KBT-TC3449: reviewer-prompt.md sources the policy table from the record', () => {
  const s = read('kanbantic-issue-review', 'reviewer-prompt.md');

  assert.ok(
    s.includes('get_test_policy'),
    'reviewer-prompt.md must name get_test_policy as the source of the pasted policy table'
  );
  assert.ok(
    /NOT from the test-policy Decision-entry|never as the source/i.test(s),
    'reviewer-prompt.md must rule out the Decision-entry as the source of the numbers'
  );
  assert.ok(
    !/If no test-policy entry was found on the issue/.test(s),
    'the old entry-based fallback wording must be gone — it re-anchors the reviewer on the entry'
  );
});

// ─── KBT-TC3450 (unit) — the three non-existent tool names are gone ───────────

const GHOST_TOOLS = ['update_test_policy', 'set_applicability', 'SetApplicability'];

test('KBT-TC3450: no skill file names a tool that does not exist in the registry', () => {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const known = new Set(snapshot.tools);

  // Guard the guard: if any of these ever ships for real, this test must be
  // rewritten rather than silently passing on a stale premise.
  for (const ghost of GHOST_TOOLS) {
    const snake = ghost.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    assert.ok(
      !known.has(snake),
      `${ghost} is now a REAL tool in known-mcp-tools.json — this test's premise no longer holds and it must be rewritten`
    );
  }

  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const body = fs.readFileSync(p, 'utf8');
        for (const ghost of GHOST_TOOLS) {
          if (body.includes(ghost)) offenders.push(`${path.relative(REPO_ROOT, p)} → ${ghost}`);
        }
      }
    }
  })(SKILLS_ROOT);

  assert.deepEqual(
    offenders, [],
    `skill files still name non-existent tools:\n  ${offenders.join('\n  ')}\nThe real tool is set_test_policy.`
  );
});

test('KBT-TC3450: the execute §3c HARD-GATE points at set_test_policy with overrideReason', () => {
  const s = section(EXECUTE_3C[0], read('kanbantic-issue-execute', 'SKILL.md'), EXECUTE_3C[1], EXECUTE_3C[2]);
  const gate = s.match(/<HARD-GATE>[\s\S]*?<\/HARD-GATE>/);
  assert.ok(gate, 'the read-only HARD-GATE under §3c must still exist');

  assert.ok(
    gate[0].includes('set_test_policy'),
    'the HARD-GATE must name the real tool — an agent told to avoid a non-existent tool learns nothing about the real one'
  );
  assert.ok(
    /overrideReason/.test(gate[0]),
    'the HARD-GATE must name overrideReason as the reviewer-akkoord route on a frozen policy'
  );
  assert.ok(
    /isFrozen/.test(gate[0]),
    'the HARD-GATE must tie the restriction to isFrozen, so the rule is checkable rather than folklore'
  );
});

// ─── KBT-TC3451 (integration) — lint-skills invariant 6 ──────────────────────

function runLint(env) {
  return spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8', env: { ...process.env, ...env } });
}

// Mirror the skill tree into a tmp dir so negative controls never touch the
// real one. Copies every .md (invariant 6 is tree-scoped, not lane-scoped).
function mirrorSkills(mutate) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt560-lint-'));
  (function walk(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) walk(s, d);
      else if (e.name.endsWith('.md')) {
        fs.writeFileSync(d, mutate(fs.readFileSync(s, 'utf8'), path.relative(SKILLS_ROOT, s)));
      }
    }
  })(SKILLS_ROOT, tmp);
  return tmp;
}

test('KBT-TC3451 (integration): lint-skills.js exits 0 on the repaired tree', () => {
  const r = runLint({});
  assert.equal(
    r.status, 0,
    `lint-skills.js must exit 0 on the repaired tree — got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`
  );
});

test('KBT-TC3451 (integration, negative control): a bare non-existent tool-name in prose makes lint-skills exit 1', () => {
  // Without this the run above only proves the script executed. `set_bogus_thing`
  // has the exact shape the real defect had: a real verb-prefix (`set_`), a
  // name that is not in the snapshot, written as inline code in prose — and
  // NOT in the `mcp__kanbantic__` form invariant 3 looks for.
  const tmp = mirrorSkills((body, rel) =>
    rel.replace(/\\/g, '/') === 'kanbantic-issue-execute/SKILL.md'
      ? body.replace('## Step 2: Claim Issue and Create Branch',
          'Call `set_bogus_thing` before claiming.\n\n## Step 2: Claim Issue and Create Branch')
      : body);
  try {
    const r = runLint({ SKILLS_DIR: tmp, SNAPSHOT });
    assert.equal(
      r.status, 1,
      `lint-skills.js must exit 1 for a bare unresolvable tool-name — got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`
    );
    assert.ok(
      /invariant 6/.test(r.stdout) && /set_bogus_thing/.test(r.stdout),
      `the failure must be attributed to invariant 6 and name the offending token\nSTDOUT: ${r.stdout}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('KBT-TC3451 (integration, negative control): the PascalCase call-form is caught too', () => {
  // `SetApplicability(...)` was one of the three real offenders and is invisible
  // to a snake_case-only rule.
  const tmp = mirrorSkills((body, rel) =>
    rel.replace(/\\/g, '/') === 'kanbantic-issue-review/reviewer-prompt.md'
      ? `${body}\n\nEscalate via \`SetApplicability(overrideReason)\`.\n`
      : body);
  try {
    const r = runLint({ SKILLS_DIR: tmp, SNAPSHOT });
    assert.equal(r.status, 1, `PascalCase call-form must be caught — got ${r.status}\nSTDOUT: ${r.stdout}`);
    assert.ok(
      /SetApplicability/.test(r.stdout),
      `the report must name SetApplicability\nSTDOUT: ${r.stdout}`
    );
    // Proves the tree-walk really covers the sibling prompt files, not just the
    // four lane SKILL.md that invariants 1-5 load.
    assert.ok(
      /reviewer-prompt\.md/.test(r.stdout),
      `invariant 6 must cover non-SKILL.md skill files too\nSTDOUT: ${r.stdout}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('KBT-TC3451 (integration): the lint-skills-allow-tool marker exempts a deliberate mention', () => {
  // The escape hatch has to work, or the first legitimate negative example
  // turns the guard off for everyone — the failure mode the issue warned about.
  const tmp = mirrorSkills((body, rel) =>
    rel.replace(/\\/g, '/') === 'kanbantic-issue-execute/SKILL.md'
      ? body.replace('## Step 2: Claim Issue and Create Branch',
          'Never call `set_bogus_thing`. <!-- lint-skills-allow-tool: deliberate negative example -->\n\n## Step 2: Claim Issue and Create Branch')
      : body);
  try {
    const r = runLint({ SKILLS_DIR: tmp, SNAPSHOT });
    assert.equal(
      r.status, 0,
      `a line carrying the marker must not be a violation — got ${r.status}\nSTDOUT: ${r.stdout}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('KBT-TC3451 (integration): invariant 6 does not fire on legitimate snake_case prose', () => {
  // The false-positive rate is the whole ballgame: a lint that cries wolf gets
  // switched off and is then worse than nothing. These four are the shapes that
  // occur constantly in the real skill files.
  const tmp = mirrorSkills((body, rel) =>
    rel.replace(/\\/g, '/') === 'kanbantic-issue-execute/SKILL.md'
      ? body.replace('## Step 2: Claim Issue and Create Branch',
          'Use `feature_branch` on `some_helper`, read `notApplicableReason`, run `npm run test:unit`.\n\n## Step 2: Claim Issue and Create Branch')
      : body);
  try {
    const r = runLint({ SKILLS_DIR: tmp, SNAPSHOT });
    assert.equal(
      r.status, 0,
      `non-tool snake_case must not trip invariant 6 — got ${r.status}\nSTDOUT: ${r.stdout}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── KBT-TC3452 (E2E) — the read-path sees what the entry cannot ─────────────
//
// Why E2E is Required here — the third E2E condition (ADM-TRUL015). A SKILL.md
// is runtime-loaded configuration: a file Claude Code reads at startup. No UI
// surface, no public API surface, but that third condition alone keeps the level
// Required. What is automatable is not "the agent follows the prose" but the
// tool contract the prose leans on — and that is precisely the layer where this
// bug is fatal.

const INIT_PARAMS = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } };
const jsonContent = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

// A policy surface with freeze semantics, because the freeze is what makes the
// divergence permanent: after claim_issue the entry can never catch up.
function makePolicyBackend() {
  const records = new Map();
  const defaults = () => ({
    Unit: { level: 'Unit', applicability: 'Required', minCount: 1, isFrozen: false },
    Integration: { level: 'Integration', applicability: 'Required', minCount: 1, isFrozen: false },
    E2E: { level: 'E2E', applicability: 'Required', minCount: 1, isFrozen: false },
  });

  return {
    set(args) {
      const { issueId, level, applicability, minimumCount, notApplicableReason, overrideReason } = args || {};
      if (!issueId || !level || !applicability) return { success: false, error: 'issueId, level and applicability are required' };
      if (applicability === 'NotApplicable' && !notApplicableReason) return { success: false, error: 'notApplicableReason is required for NotApplicable' };
      if (!records.has(issueId)) records.set(issueId, defaults());
      const prev = records.get(issueId)[level];
      const loosening = applicability === 'NotApplicable' || (minimumCount != null && minimumCount < prev.minCount);
      if (prev.isFrozen && loosening && !(overrideReason && overrideReason.trim().length >= 20)) {
        return { success: false, error: 'frozen policy: lowering or exempting requires overrideReason (>=20 chars)' };
      }
      const rec = {
        level,
        applicability,
        minCount: applicability === 'NotApplicable' ? 0 : (minimumCount == null ? 1 : minimumCount),
        isFrozen: prev.isFrozen,
      };
      if (notApplicableReason) rec.notApplicableReason = notApplicableReason;
      records.get(issueId)[level] = rec;
      return { success: true, policies: [rec] };
    },
    claim(args) {
      const issueId = args && args.issueId;
      if (!records.has(issueId)) records.set(issueId, defaults());
      for (const l of ['Unit', 'Integration', 'E2E']) records.get(issueId)[l].isFrozen = true;
      return { success: true, issueCode: issueId };
    },
    get(args) {
      const byLevel = records.get(args && args.issueId) || defaults();
      return { success: true, policies: ['Unit', 'Integration', 'E2E'].map(l => byLevel[l]) };
    },
  };
}

function startStub(backend) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.statusCode = 404; res.end('not found'); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      const name = msg.params && msg.params.name;
      const args = msg.params && msg.params.arguments;
      received.push({ method: msg.method, name, args });

      res.setHeader('Mcp-Session-Id', req.headers['mcp-session-id'] || 'stub-session');
      res.setHeader('Content-Type', 'application/json');

      if (msg.method === 'initialize') {
        res.statusCode = 200;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } } }));
        return;
      }
      if (msg.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }

      let result;
      if (name === 'set_test_policy') result = jsonContent(backend.set(args));
      else if (name === 'get_test_policy') result = jsonContent(backend.get(args));
      else if (name === 'claim_issue') result = jsonContent(backend.claim(args));
      else result = jsonContent({ success: true, echo: name || msg.method });

      res.statusCode = 200;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })));
}

function spawnProxy(port) {
  const env = { ...process.env, KANBANTIC_MCP_URL: `http://127.0.0.1:${port}/mcp`, KANBANTIC_API_KEY: 'test-key' };
  for (const k of ['KANBANTIC_WORKSPACE_ID', 'KANBANTIC_WORKSTATION_ID', 'KANBANTIC_HOST', 'KANBANTIC_SPAWN_COMMAND_ID']) delete env[k];
  const child = spawn(process.execPath, [PROXY_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const pending = new Map();
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
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
  child.stderr.on('data', c => (stderr += c));
  const exitPromise = new Promise(resolve => child.on('exit', code => resolve(code)));

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
  return { rpc, shutdown: async () => { child.stdin.end(); return exitPromise; } };
}

const parseToolResult = resp => JSON.parse(resp.result.content[0].text);

test('KBT-TC3452 (E2E): a post-claim policy change is visible through get_test_policy and invisible in the entry', async () => {
  const backend = makePolicyBackend();
  const stub = await startStub(backend);
  const proxy = spawnProxy(stub.port);
  const ISSUE = 'KBT-B560';
  const NA_REASON = 'Deze Feature heeft geen UI- en geen publiek API-oppervlak, dus er is niets om end-to-end te doorlopen.';

  // The prepare-time Decision-entry, frozen verbatim at the moment prepare wrote
  // it. Nothing in the flow below ever rewrites it — that is the point.
  const DECISION_ENTRY = [
    '## Test-policy (bevroren bij claim_issue — KBT-F442 / Regel E)',
    '',
    '| Niveau | Applicabiliteit | Minimum |',
    '|---|---|---|',
    '| Unit | Vereist | 1 |',
    '| Integration | Vereist | 1 |',
    '| E2E | Vereist | 1 |',
  ].join('\n');

  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);

    // prepare 5F.5/5B.6 → claim (freeze) → review Step 5a override.
    for (const level of ['Unit', 'Integration', 'E2E']) {
      const r = parseToolResult(await proxy.rpc('tools/call', {
        name: 'set_test_policy', arguments: { issueId: ISSUE, level, applicability: 'Required', minimumCount: 1 },
      }, 10));
      assert.equal(r.success, true, `prepare-time set_test_policy(${level}) failed: ${JSON.stringify(r)}`);
    }
    parseToolResult(await proxy.rpc('tools/call', { name: 'claim_issue', arguments: { issueId: ISSUE, branch: 'fix/KBT-B560' } }, 20));

    const override = parseToolResult(await proxy.rpc('tools/call', {
      name: 'set_test_policy',
      arguments: { issueId: ISSUE, level: 'E2E', applicability: 'NotApplicable', notApplicableReason: NA_REASON, overrideReason: 'Reviewer-akkoord: geen E2E-oppervlak op deze Feature, vastgelegd bij de approve.' },
    }, 30));
    assert.equal(override.success, true, `the Step 5a post-claim override must succeed with a reviewer-akkoord: ${JSON.stringify(override)}`);

    // ── the record read-path sees the change ────────────────────────────────
    const policy = parseToolResult(await proxy.rpc('tools/call', { name: 'get_test_policy', arguments: { issueId: ISSUE } }, 40));
    assert.equal(policy.success, true);
    const byLevel = Object.fromEntries(policy.policies.map(p => [p.level, p]));

    assert.equal(byLevel.E2E.applicability, 'NotApplicable', 'get_test_policy must report the post-claim change — this is the value the gates use');
    assert.equal(byLevel.E2E.notApplicableReason, NA_REASON, 'the N.v.t. reason must survive the proxy unmodified');
    assert.equal(byLevel.E2E.isFrozen, true, 'the record stays frozen after the override — the override is audited, not an unfreeze');
    assert.equal(byLevel.Unit.applicability, 'Required', 'untouched levels keep their declared value');

    // ── the entry does not, and never will ─────────────────────────────────
    assert.ok(
      /\| E2E \| Vereist \| 1 \|/.test(DECISION_ENTRY),
      'the frozen Decision-entry still says E2E/Vereist — an execute or review step parsing it would demand E2E coverage the policy no longer requires'
    );
    assert.ok(
      !DECISION_ENTRY.includes(NA_REASON),
      'nothing in the flow rewrote the entry: the divergence is structural, not a timing accident'
    );

    // ── the proxy is a conduit, not an author ───────────────────────────────
    const writes = stub.received.filter(r => r.name === 'set_test_policy');
    assert.equal(writes.length, 4, 'three prepare-time writes plus one post-claim override must reach the backend, nothing dropped or invented');
    const reads = stub.received.filter(r => r.name === 'get_test_policy');
    assert.equal(reads.length, 1, 'the read-back must be forwarded exactly once');
    assert.equal(reads[0].args.issueId, ISSUE, 'issueId must arrive intact');
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});

test('KBT-TC3452 (E2E, counterfactual): without the override the frozen record refuses to loosen', async () => {
  // Confirms the freeze is real in this harness. If it were not, the test above
  // would prove nothing about *why* the entry can never catch up.
  const backend = makePolicyBackend();
  const stub = await startStub(backend);
  const proxy = spawnProxy(stub.port);

  try {
    await proxy.rpc('initialize', INIT_PARAMS, 1);
    await proxy.rpc('tools/call', { name: 'claim_issue', arguments: { issueId: 'KBT-B999' } }, 10);

    const r = parseToolResult(await proxy.rpc('tools/call', {
      name: 'set_test_policy',
      arguments: { issueId: 'KBT-B999', level: 'E2E', applicability: 'NotApplicable', notApplicableReason: 'Geen E2E-oppervlak op dit issue, dus niets om te doorlopen.' },
    }, 20));

    assert.equal(r.success, false, 'lowering a frozen policy without an overrideReason must fail');
    assert.match(r.error, /overrideReason/, 'the error must point at the reviewer-akkoord route');

    const policy = parseToolResult(await proxy.rpc('tools/call', { name: 'get_test_policy', arguments: { issueId: 'KBT-B999' } }, 30));
    assert.equal(policy.policies.find(p => p.level === 'E2E').applicability, 'Required', 'the rejected write must leave the record untouched');
  } finally {
    await proxy.shutdown();
    stub.server.close();
  }
});
