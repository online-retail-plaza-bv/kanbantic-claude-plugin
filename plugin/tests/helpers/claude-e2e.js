'use strict';

//
// claude-e2e.js — KBT-F741 / KBT-F742
//
// Shared helpers for the real-session E2E tests that start a headless Claude
// Code (`claude -p`) with THIS checkout's plugin loaded via --plugin-dir. Node
// built-ins only. Extracted from hooks-session-state-e2e.test.js (KBT-TC4199) so
// decision-request-proxy-e2e.test.js (KBT-TC4207) reuses the exact same launch
// and "stripped plugin copy" mechanics.
//

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN_DIR = path.resolve(__dirname, '..', '..');

/** null when `claude` can run; otherwise the skip reason. */
function claudeAvailable() {
  if (process.env.KBT_E2E_CLAUDE === '0') return 'KBT_E2E_CLAUDE=0';
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (r.error || r.status !== 0) return 'the `claude` CLI is not on PATH';
  return null;
}

/** The `claude --version` line, for the report. */
function claudeVersion() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

/**
 * Copy of the plugin (without tests) at `dest`, with:
 *   - every hooks.json entry whose command matches `stripHooks` removed, and
 *   - every [from, to] of `proxyReplacements` applied to the proxy source
 *     (text substitution — used to switch a proxy feature off for a red-proof).
 */
function pluginCopy(dest, { stripHooks = null, proxyReplacements = [] } = {}) {
  fs.cpSync(PLUGIN_DIR, dest, {
    recursive: true,
    filter: (src) => !/[\\/]tests([\\/]|$)/.test(src.slice(PLUGIN_DIR.length)),
  });
  if (stripHooks) {
    const file = path.join(dest, 'hooks', 'hooks.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [event, entries] of Object.entries(json.hooks)) {
      json.hooks[event] = entries
        .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !stripHooks.test(h.command)) }))
        .filter((e) => e.hooks.length > 0);
      if (json.hooks[event].length === 0) delete json.hooks[event];
    }
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
  }
  if (proxyReplacements.length > 0) {
    const file = path.join(dest, 'proxy', 'kanbantic-mcp-proxy.js');
    let src = fs.readFileSync(file, 'utf8');
    for (const [from, to] of proxyReplacements) src = src.split(from).join(to);
    fs.writeFileSync(file, src);
  }
  return dest;
}

function runClaude({ cwd, pluginDir, prompt, env, timeoutMs }) {
  const childEnv = { ...process.env };
  // A nested session must not believe it is the outer one.
  for (const k of Object.keys(childEnv)) if (/^CLAUDE(CODE|_CODE)/i.test(k)) delete childEnv[k];
  for (const k of Object.keys(childEnv)) if (/^KANBANTIC_/.test(k)) delete childEnv[k];
  const args = [
    '-p', prompt,
    '--plugin-dir', pluginDir,
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'json',
    '--model', process.env.KBT_E2E_MODEL || 'haiku',
    '--max-budget-usd', '1',
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env: { ...childEnv, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
    child.stdin.end();
  });
}

module.exports = { PLUGIN_DIR, claudeAvailable, claudeVersion, pluginCopy, runClaude };
