'use strict';

//
// KBT-F518 / KBT-E099 (F-C) — the Wireframe Agent subagent materialises to the
// right on-disk mirror and stays drift-free.
//
// TC3043 (Integration): verify the mirror-sync path for the Wireframe Agent
// Subagent toolkit item — it renders to `.claude/agents/wireframe-agent.md` with
// `model: sonnet` frontmatter and the context-free steering, and a second sync
// leaves it byte-identical (drift green / idempotent). This is the CI-safe half of
// TC3043; the "ClaudeMd contains the steering" half is verified live against the
// workspace ClaudeMd (KBT-CLMD001) — see the F-C Decision entry.
//
// Zero deps — node:test, node:assert/strict, node:fs, node:os, node:path, and the
// sync-workspace-skills module's pure helpers.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sync = require(path.join(__dirname, '..', 'scripts', 'sync-workspace-skills.js'));

// A stand-in for the live KBT-SAGN009 toolkit item (same category/title/model +
// the load-bearing context-free rule).
const WIREFRAME_SUBAGENT = {
  code: 'KBT-SAGN009',
  category: 'Subagent',
  title: 'Wireframe Agent',
  model: 'Sonnet',
  isActive: true,
  content: [
    '# Wireframe Agent',
    '',
    'Je enige taak is het beheren van wireframes. ALTIJD context-vrij (KBT-RL161):',
    'wireframe-bestanden mogen nooit in je modelcontext terechtkomen.',
    '',
    'Bewerken = nieuwe versie (immutability KBT-BD163).',
    '',
  ].join('\n'),
};

function mkTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-f518-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

test('targetPathFor: a Subagent maps to .claude/agents/<slug>.md', () => {
  assert.equal(sync.targetPathFor('Subagent', 'wireframe-agent'), '.claude/agents/wireframe-agent.md');
  assert.equal(sync.slugify('Wireframe Agent'), 'wireframe-agent');
});

test('renderFile: emits model:sonnet frontmatter + the context-free rule', () => {
  const body = sync.renderFile(WIREFRAME_SUBAGENT);
  assert.match(body, /^---\n/);
  assert.match(body, /\nmodel: sonnet\n/);      // KBT-F437 model line, lower-cased
  assert.match(body, /context-vrij \(KBT-RL161\)/);
  assert.match(body, /# Wireframe Agent/);
});

test('runSync materialises the mirror and is drift-free on a second run', () => {
  const root = mkTmpRoot();
  try {
    const mirror = path.join(root, '.claude', 'agents', 'wireframe-agent.md');

    // First sync — creates the mirror from the toolkit item.
    sync.runSync({ rootDir: root, items: [WIREFRAME_SUBAGENT], workspace: 'kanbantic', now: '2026-07-09T00:00:00.000Z' });
    assert.ok(fs.existsSync(mirror), 'wireframe-agent.md mirror was created');
    const first = fs.readFileSync(mirror, 'utf8');
    assert.match(first, /model: sonnet/);
    assert.match(first, /context-vrij \(KBT-RL161\)/);

    // Second sync — nothing changed upstream, so the mirror is byte-identical
    // (drift green / idempotent).
    sync.runSync({ rootDir: root, items: [WIREFRAME_SUBAGENT], workspace: 'kanbantic', now: '2026-07-09T00:05:00.000Z' });
    const second = fs.readFileSync(mirror, 'utf8');
    assert.equal(second, first, 'mirror is unchanged on re-sync (no drift)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
