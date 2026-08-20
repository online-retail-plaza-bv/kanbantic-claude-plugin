'use strict';

//
// sync-skill-doc-consistency.test.js
//   KBT-B556 / KBT-TC3513 — sourceHash definition
//   KBT-B491 / KBT-TC3516 — the two accepted `category` input shapes
//   KBT-B489 / KBT-TC3518 — the completeness warning in Step 2
//
// These three bugs share one root shape: SKILL.md is the document an agent
// actually follows, and when it describes behaviour the script does not have,
// the agent debugs in the wrong direction — or, worse, feeds the script input
// the document implied was safe.
//
// The artefact under test is therefore the DOCUMENT. A test that only exercised
// the code would be green for all three, because in every case the code is
// already right and the prose is what drifted.
//
// Where a documented claim is also checkable against behaviour, both halves are
// asserted. The behavioural half is the anchor: without it, someone could later
// "fix" the mismatch by changing the code to match stale prose — the same bug
// mirrored — and a docs-only assertion would stay green.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'sync-workspace-skills.js');
const sync = require(SCRIPT);

const SKILL_MD = path.resolve(
  __dirname, '..', 'skills', 'kanbantic-sync-workspace-skills', 'SKILL.md'
);

const FIXED_NOW = '2026-08-13T09:00:00.000Z';

function readSkillMd() {
  return fs.readFileSync(SKILL_MD, 'utf8');
}

function mkTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-docs-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// KBT-B556 — sourceHash is hashed over content AND model
// ---------------------------------------------------------------------------

test('KBT-TC3513: SKILL.md defines sourceHash over content AND model', () => {
  const md = readSkillMd();

  // Pull out the bullet that defines sourceHash, rather than searching the
  // whole document — a stray mention of "model" elsewhere must not satisfy this.
  const line = md.split(/\r?\n/).find(l => /^\s*[-*]\s*`sourceHash`/.test(l));
  assert.ok(line, 'No `sourceHash` definition bullet found in SKILL.md.');

  assert.match(
    line, /content/,
    `The sourceHash definition should still mention the content field. Got: ${line}`
  );
  assert.match(
    line, /model/,
    `SKILL.md documents sourceHash without mentioning \`model\`, but the script ` +
    `hashes content + model — so a model-only change re-renders the mirror while ` +
    `the document promises UNCHANGED. Got: ${line}`
  );
});

test('KBT-TC3513: a model-only change really does produce an UPDATE', () => {
  // The behavioural anchor for the assertion above. This is the fact the
  // document has to describe; if the code is ever changed to match the OLD
  // prose, this fails and the pair stays honest.
  const root = mkTmpRoot();
  try {
    const base = {
      id: '22222222-2222-2222-2222-222222222222',
      code: 'KBT-SAGN777',
      category: 'Subagent',
      title: 'doc-probe-agent — model drift probe',
      content: 'Identical body in both runs.\n',
      isActive: true,
    };

    const first = sync.runSync({
      rootDir: root, items: [Object.assign({}, base, { model: 'Sonnet' })],
      workspace: 'probe', now: FIXED_NOW,
    });
    assert.equal(first.created, 1, 'setup: first sync creates the mirror');

    const second = sync.runSync({
      rootDir: root, items: [Object.assign({}, base, { model: 'Opus' })],
      workspace: 'probe', now: FIXED_NOW,
    });

    assert.equal(second.updated, 1, 'a model-only change must re-render the mirror');
    assert.equal(second.unchanged, 0, 'it must NOT be reported as unchanged');
    assert.match(
      fs.readFileSync(path.join(root, '.claude', 'agents', 'doc-probe-agent.md'), 'utf8'),
      /^model: opus$/m,
      'the frontmatter is why model participates in the hash at all'
    );
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-B491 — both `category` input shapes are documented
// ---------------------------------------------------------------------------

test('KBT-TC3516: SKILL.md states that MCP yields enum names and REST yields integers', () => {
  const md = readSkillMd();

  assert.match(
    md, /integer/i,
    'SKILL.md never mentions the integer form of `category`. Raw REST output ' +
    'delivers it that way, and an agent that pastes REST output into the script ' +
    'needs to know it is accepted (KBT-B491).'
  );
  // Both producers have to be named, otherwise the reader cannot tell which
  // shape their own fetch layer hands them.
  assert.match(md, /\bMCP\b/, 'SKILL.md should name the MCP tool as a source shape.');
  assert.match(md, /\bREST\b/i, 'SKILL.md should name the REST API as a source shape.');
});

test('KBT-TC3516: both documented category shapes actually work', () => {
  // Anchor: the document promises both shapes are accepted. Prove it.
  const root = mkTmpRoot();
  try {
    const summary = sync.runSync({
      rootDir: root,
      items: [
        { id: 'a', code: 'KBT-SKIL001', category: 1, title: 'int-skill', content: 'x\n', isActive: true },
        { id: 'b', code: 'KBT-SAGN001', category: 'Subagent', title: 'name-agent', content: 'y\n', isActive: true },
      ],
      workspace: 'probe', now: FIXED_NOW,
    });
    assert.equal(summary.created, 2, 'a list mixing the integer and name shapes must sync both');
    assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', 'int-skill.md')));
    assert.ok(fs.existsSync(path.join(root, '.claude', 'agents', 'name-agent.md')));
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-B489 — Step 2 warns that an incomplete list is destructive
// ---------------------------------------------------------------------------

test('KBT-TC3518: SKILL.md Step 2 warns that an incomplete list is destructive', () => {
  const md = readSkillMd();

  // The failure mode is an agent assembling the list from separate
  // list_toolkit_items calls and under-fetching. The document has to say what
  // that costs and what the obligation is.
  assert.match(
    md, /totalCount/,
    'SKILL.md Step 2 should tell the agent to check `totalCount` — the truncation ' +
    'that nearly deleted two live subagent mirrors was visible there (KBT-B489).'
  );
  assert.match(
    md, /isActive:\s*false/,
    'SKILL.md must state that a deactivated item has to stay PRESENT in the list ' +
    'with isActive: false; omitting it entirely is what reads as a truncated fetch.'
  );
});

test('KBT-TC3518: an omitted manifest entry aborts rather than deleting', () => {
  // Anchor for the documented promise.
  const root = mkTmpRoot();
  try {
    const alpha = { id: 'a', code: 'KBT-SKIL001', category: 'Skill', title: 'alpha', content: 'a\n', isActive: true };
    const beta = { id: 'b', code: 'KBT-SAGN001', category: 'Subagent', title: 'beta', content: 'b\n', isActive: true };

    sync.runSync({ rootDir: root, items: [alpha, beta], workspace: 'probe', now: FIXED_NOW });
    const betaPath = path.join(root, '.claude', 'agents', 'beta.md');
    assert.ok(fs.existsSync(betaPath), 'setup: beta mirror should exist');

    assert.throws(
      () => sync.runSync({ rootDir: root, items: [alpha], workspace: 'probe', now: FIXED_NOW }),
      (e) => e && e.kind === 'INCOMPLETE_INPUT',
      'omitting beta entirely must abort, not delete its mirror'
    );
    assert.ok(fs.existsSync(betaPath), 'the mirror must survive the aborted run');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// KBT-B681 — the flag table itself
//
// The three checks above each guard one sentence somebody once thought to add.
// That is how KBT-B654 slipped through: it moved the completeness-guard waiver
// from `--force` to the new `--prune`, updated the script's own USAGE, and left
// SKILL.md claiming the old semantics. Nothing was watching the flag table.
//
// So this pair watches the table as a whole -- every flag it lists must exist,
// and the claim about WHICH flag waives the guard is measured against runSync
// rather than against prose.
// ---------------------------------------------------------------------------

/** Every `--flag` in the "Script flags" table of SKILL.md. */
function documentedFlags() {
  const md = readSkillMd();
  const start = md.indexOf('### Script flags');
  assert.notEqual(start, -1, 'SKILL.md must still have a "Script flags" section');
  const rest = md.slice(start);
  const end = rest.indexOf('\n### ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);

  const flags = new Set();
  for (const m of section.matchAll(/`(--[a-z-]+)/g)) flags.add(m[1]);
  return [...flags];
}

test('KBT-TC3592: every flag documented in SKILL.md is accepted by the CLI', () => {
  const flags = documentedFlags();
  assert.ok(flags.length >= 4, `expected the flag table to list flags, got ${flags.length}`);

  for (const flag of flags) {
    const root = mkTmpRoot();
    try {
      // Assert on `unknown flag: <this flag>` specifically, not on the phrase
      // alone. Value-taking flags swallow whatever follows them, so a generic
      // match would fail on the swallowed argument instead of on the flag --
      // which is exactly how this test failed on its first run.
      const r = spawnSync(process.execPath, [SCRIPT, flag, '--root', root], {
        input: '[]', encoding: 'utf8',
      });
      assert.doesNotMatch(
        `${r.stderr}`, new RegExp(`unknown flag: ${flag}\\b`),
        `SKILL.md documents ${flag}, but the script rejects it as unknown`
      );
    } finally {
      cleanup(root);
    }
  }
});

test('KBT-TC3593: --prune waives the completeness guard and --force does not', () => {
  // Measured, not read. Someone could "fix" a doc mismatch by moving the
  // behaviour back onto --force; a prose-only assertion would stay green.
  const alpha = { id: 'a', code: 'KBT-SKIL001', category: 'Skill', title: 'alpha', content: 'a\n', isActive: true };
  const beta = { id: 'b', code: 'KBT-SAGN001', category: 'Subagent', title: 'beta', content: 'b\n', isActive: true };

  const root = mkTmpRoot();
  try {
    sync.runSync({ rootDir: root, items: [alpha, beta], workspace: 'probe', now: FIXED_NOW });
    const betaPath = path.join(root, '.claude', 'agents', 'beta.md');

    assert.throws(
      () => sync.runSync({ rootDir: root, items: [alpha], workspace: 'probe', now: FIXED_NOW, force: true }),
      (e) => e && e.kind === 'INCOMPLETE_INPUT',
      '--force must NOT waive the completeness guard (KBT-B654)'
    );
    assert.ok(fs.existsSync(betaPath), '--force must leave the mirror alone');

    const s = sync.runSync({ rootDir: root, items: [alpha], workspace: 'probe', now: FIXED_NOW, prune: true });
    assert.equal(s.deleted, 1, '--prune must waive the guard and retire the mirror');
    assert.ok(!fs.existsSync(betaPath));
  } finally {
    cleanup(root);
  }

  // And the document must say so, in both places that describe it.
  const md = readSkillMd();
  assert.match(md, /`--prune`[^\n]*[Ww]aive/, 'SKILL.md must document --prune as the waiver');
  assert.doesNotMatch(
    md, /`--force`[^\n]*waives the completeness guard/,
    'SKILL.md still claims --force waives the completeness guard'
  );
});
