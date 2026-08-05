'use strict';

//
// workspace-detect.test.js — KBT-F637 / KBT-TC3411 (Unit)
//
// Tests the four-layer workspace detection from KBT-SR606.
//
// Every case asserts on `source` as well as on `workspace`. That is the point
// of the test: asserting only the answer cannot distinguish "layer 2 answered"
// from "layer 2 answered but we consulted layer 3 first anyway" — and that
// wasted round-trip happens on every session start.
//
// Zero deps — node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectWorkspace, normalizeRemote } = require('../scripts/workspace-detect.js');

const REPOS = [
  { workspace: 'kanbantic', url: 'https://github.com/Online-Retail-Plaza-BV/kanbantic-claude-plugin.git' },
  { workspace: 'admin-hub', url: 'https://github.com/Online-Retail-Plaza-BV/admin-hub.git' },
];

const PLUGIN_REMOTE = 'https://github.com/Online-Retail-Plaza-BV/kanbantic-claude-plugin.git';

test('KBT-TC3411 stap 1: env wint van manifest en remote', () => {
  const r = detectWorkspace({
    env: { KANBANTIC_WORKSPACE_ID: 'explicit-ws' },
    manifest: { workspace: 'manifest-ws' },
    remoteUrl: PLUGIN_REMOTE,
    repositories: REPOS,
  });
  assert.equal(r.workspace, 'explicit-ws');
  assert.equal(r.source, 'env', 'layer 1 must answer even when 2 and 3 also could');
});

test('KBT-TC3411 stap 2: manifest wint van remote', () => {
  const r = detectWorkspace({
    env: {},
    manifest: { workspace: 'manifest-ws' },
    remoteUrl: PLUGIN_REMOTE,
    repositories: REPOS,
  });
  assert.equal(r.workspace, 'manifest-ws');
  assert.equal(r.source, 'manifest', 'a known manifest must not trigger a repository lookup');
});

test('KBT-TC3411 stap 3: remote-match levert de workspace', () => {
  const r = detectWorkspace({
    env: {},
    manifest: null,
    remoteUrl: PLUGIN_REMOTE,
    repositories: REPOS,
  });
  assert.equal(r.workspace, 'kanbantic');
  assert.equal(r.source, 'remote');
});

test('KBT-TC3411 stap 4: cosmetische verschillen in de remote breken de match niet', () => {
  const variants = [
    'https://github.com/online-retail-plaza-bv/kanbantic-claude-plugin',      // casing + no .git
    'git@github.com:Online-Retail-Plaza-BV/kanbantic-claude-plugin.git',      // scp-style ssh
    'ssh://git@github.com/Online-Retail-Plaza-BV/kanbantic-claude-plugin.git', // ssh:// URL
    'https://github.com/Online-Retail-Plaza-BV/kanbantic-claude-plugin.git/',  // trailing slash
  ];
  for (const remoteUrl of variants) {
    const r = detectWorkspace({ env: {}, manifest: null, remoteUrl, repositories: REPOS });
    assert.equal(r.workspace, 'kanbantic', `variant should still match: ${remoteUrl}`);
    assert.equal(r.source, 'remote');
  }
});

test('KBT-TC3411 stap 5: twee kandidaten → geen keuze, wel de lijst', () => {
  const repos = [
    { workspace: 'kanbantic', url: PLUGIN_REMOTE },
    { workspace: 'other-ws', url: PLUGIN_REMOTE },
  ];
  const r = detectWorkspace({ env: {}, manifest: null, remoteUrl: PLUGIN_REMOTE, repositories: repos });
  assert.equal(r.workspace, null, 'guessing would sync this repo against the wrong workspace');
  assert.equal(r.source, 'ambiguous');
  assert.deepEqual(r.candidates, ['kanbantic', 'other-ws']);
});

test('KBT-TC3411 stap 6: niets bruikbaars → onbepaald', () => {
  const r = detectWorkspace({
    env: {},
    manifest: null,
    remoteUrl: 'https://github.com/someone/unrelated.git',
    repositories: REPOS,
  });
  assert.equal(r.workspace, null);
  assert.equal(r.source, 'none');
});

test('KBT-TC3411: lege en ontbrekende invoer levert nooit een exception', () => {
  for (const input of [undefined, {}, { env: {}, manifest: null, remoteUrl: '', repositories: [] }]) {
    const r = detectWorkspace(input);
    assert.equal(r.workspace, null);
    assert.equal(r.source, 'none');
  }
});

test('KBT-TC3411: een lege string in env telt niet als expliciete keuze', () => {
  const r = detectWorkspace({
    env: { KANBANTIC_WORKSPACE_ID: '   ' },
    manifest: { workspace: 'manifest-ws' },
  });
  assert.equal(r.workspace, 'manifest-ws');
  assert.equal(r.source, 'manifest');
});

test('normalizeRemote: collapses every equivalent form to the same identity', () => {
  const expected = 'github.com/online-retail-plaza-bv/kanbantic-claude-plugin';
  assert.equal(normalizeRemote(PLUGIN_REMOTE), expected);
  assert.equal(normalizeRemote('git@github.com:Online-Retail-Plaza-BV/kanbantic-claude-plugin.git'), expected);
  assert.equal(normalizeRemote('ssh://git@github.com/Online-Retail-Plaza-BV/kanbantic-claude-plugin'), expected);
  // Unusable input never matches anything.
  assert.equal(normalizeRemote(''), '');
  assert.equal(normalizeRemote(null), '');
  assert.equal(normalizeRemote(undefined), '');
});
