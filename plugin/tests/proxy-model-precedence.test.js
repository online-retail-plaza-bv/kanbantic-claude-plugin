'use strict';

//
// proxy-model-precedence.test.js — KBT-F743 / KBT-T5230 (9) / KBT-SR646
//
// The proxy attaches `modelId` to a forwarded register_agent_session from the
// `model` setting, so the Vloot page can show "bron: settings". The reviewer
// caught the lookup running user → project, which is the reverse of what Claude
// Code itself applies, so the Vloot could show a model the session does not run.
//
// The precedence decided here, highest first, mirroring Claude Code's own
// settings precedence (command line / env > local project > project > user):
//
//   1. env ANTHROPIC_MODEL
//   2. <cwd>/.claude/settings.local.json
//   3. <cwd>/.claude/settings.json
//   4. $CLAUDE_CONFIG_DIR/settings.json
//   5. ~/.claude/settings.json
//
// Aliases (`opus`, `sonnet`, `haiku`, `opusplan`) are sent AS-IS: the proxy
// resolves nothing (the wire contract stays `modelId` only); the F745 transcript
// watch fills in the real id later.
//
// In-process over the exported `readConfiguredModelId`; the real-proxy E2E of the
// same order is in fleet-proxy-e2e.test.js.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmp, rmTmp } = require('./helpers/hook-harness.js');
const proxy = require('../proxy/kanbantic-mcp-proxy');

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/**
 * Runs `fn` with HOME/USERPROFILE, CLAUDE_CONFIG_DIR, ANTHROPIC_MODEL and cwd
 * pointed at a scratch layout; every layer in `layers` that is set gets written.
 *   layers: { env, local, project, configDir, home } → the `model` for that layer.
 */
function withLayers(layers, fn) {
  const root = mkTmp('kbt-t5230-model-');
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const cfg = path.join(root, 'cfg');
  for (const d of [home, work, cfg]) fs.mkdirSync(d, { recursive: true });
  if (layers.home !== undefined) writeJson(path.join(home, '.claude', 'settings.json'), { model: layers.home });
  if (layers.configDir !== undefined) writeJson(path.join(cfg, 'settings.json'), { model: layers.configDir });
  if (layers.project !== undefined) writeJson(path.join(work, '.claude', 'settings.json'), { model: layers.project });
  if (layers.local !== undefined) writeJson(path.join(work, '.claude', 'settings.local.json'), { model: layers.local });

  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL };
  const cwd = process.cwd();
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    if (layers.env !== undefined) process.env.ANTHROPIC_MODEL = layers.env; else delete process.env.ANTHROPIC_MODEL;
    process.chdir(work);
    return fn();
  } finally {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmTmp(root);
  }
}

const ALL = { env: 'from-env', local: 'from-local', project: 'from-project', configDir: 'from-config-dir', home: 'from-home' };

test('KBT-T5230 (9) — env ANTHROPIC_MODEL beats every settings file', () => {
  withLayers(ALL, () => assert.equal(proxy.readConfiguredModelId(), 'from-env'));
});

test('KBT-T5230 (9) — <cwd>/.claude/settings.local.json beats project, config-dir and user settings', () => {
  withLayers({ ...ALL, env: undefined }, () => assert.equal(proxy.readConfiguredModelId(), 'from-local'));
});

test('KBT-T5230 (9) — <cwd>/.claude/settings.json beats config-dir and user settings', () => {
  withLayers({ ...ALL, env: undefined, local: undefined }, () => assert.equal(proxy.readConfiguredModelId(), 'from-project'));
});

test('KBT-T5230 (9) — $CLAUDE_CONFIG_DIR/settings.json beats ~/.claude/settings.json', () => {
  withLayers({ configDir: 'from-config-dir', home: 'from-home' }, () => assert.equal(proxy.readConfiguredModelId(), 'from-config-dir'));
});

test('KBT-T5230 (9) — ~/.claude/settings.json is the last resort; nothing at all → undefined (argument omitted)', () => {
  withLayers({ home: 'from-home' }, () => assert.equal(proxy.readConfiguredModelId(), 'from-home'));
  withLayers({}, () => assert.equal(proxy.readConfiguredModelId(), undefined));
});

test('KBT-T5230 (9) — an empty or whitespace ANTHROPIC_MODEL does not count; the next layer decides', () => {
  withLayers({ env: '', local: 'from-local' }, () => assert.equal(proxy.readConfiguredModelId(), 'from-local'));
  withLayers({ env: '   ', project: 'from-project' }, () => assert.equal(proxy.readConfiguredModelId(), 'from-project'));
});

test('KBT-T5230 (9) — a settings file whose model is not a non-empty string is skipped, not fatal', () => {
  withLayers({ local: 42, project: '', home: 'from-home' }, () => assert.equal(proxy.readConfiguredModelId(), 'from-home'));
});

test('KBT-T5230 (9) — aliases are passed through unchanged, never resolved (opus, sonnet, haiku, opusplan)', () => {
  // Documented limitation: the proxy sends the alias as `modelId`; the F745
  // transcript watch resolves the real model id later. No `modelSource` on the wire.
  withLayers({ env: 'opusplan', local: 'claude-sonnet-5-5' }, () => assert.equal(proxy.readConfiguredModelId(), 'opusplan'));
  withLayers({ local: 'opus' }, () => assert.equal(proxy.readConfiguredModelId(), 'opus'));
  withLayers({ project: 'sonnet' }, () => assert.equal(proxy.readConfiguredModelId(), 'sonnet'));
  withLayers({ home: 'haiku' }, () => assert.equal(proxy.readConfiguredModelId(), 'haiku'));
});

test('KBT-T5230 (9) — attachModelIdToRegisterCall injects the precedence winner and never clobbers a caller-set modelId', () => {
  withLayers({ env: 'from-env', home: 'from-home' }, () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'register_agent_session', arguments: { workspaceId: 'ws' } } };
    assert.equal(proxy.attachModelIdToRegisterCall(msg), true);
    assert.equal(msg.params.arguments.modelId, 'from-env');

    const preset = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'register_agent_session', arguments: { workspaceId: 'ws', modelId: 'caller-said-so' } } };
    assert.equal(proxy.attachModelIdToRegisterCall(preset), false);
    assert.equal(preset.params.arguments.modelId, 'caller-said-so');
  });
});
