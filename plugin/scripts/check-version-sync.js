#!/usr/bin/env node
'use strict';

//
// KBT-F454 (KBT-E089) — plugin version-sync guard.
//
// Fails (exit 1) when the plugin version in `.claude-plugin/marketplace.json`
// (plugins[].version) does not match `plugin/.claude-plugin/plugin.json` (version).
//
// Why: the Claude app reads marketplace.json for update detection. When a bump
// touches only plugin.json (as in commit 51d7743 — plugin.json=2.8.0 while
// marketplace.json stayed 2.3.0), the app does not detect the update. This guard
// makes that drift a hard failure instead of a silently-shipped inconsistency.
//
// package.json is intentionally EXCLUDED: it is the test-harness package
// (`kanbantic-claude-plugin-tests`, version 0.0.0), not the plugin version carrier.
//
// Paths can be overridden via env vars (used by the test fixture):
//   VERSION_SYNC_MARKETPLACE, VERSION_SYNC_PLUGIN
//
// Zero deps — only node built-ins.
//

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const marketplacePath =
  process.env.VERSION_SYNC_MARKETPLACE
  || path.join(repoRoot, '.claude-plugin', 'marketplace.json');
const pluginManifestPath =
  process.env.VERSION_SYNC_PLUGIN
  || path.join(repoRoot, 'plugin', '.claude-plugin', 'plugin.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function resolveVersions() {
  const marketplace = readJson(marketplacePath);
  const plugin = readJson(pluginManifestPath);

  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const entry = plugins.find((p) => p.name === plugin.name) || plugins[0];

  return {
    pluginName: plugin.name,
    marketplaceVersion: entry ? entry.version : undefined,
    pluginVersion: plugin.version,
  };
}

function main() {
  const { pluginName, marketplaceVersion, pluginVersion } = resolveVersions();

  if (!marketplaceVersion || !pluginVersion) {
    console.error(
      `[version-sync] Could not read versions (plugin '${pluginName}'): `
      + `marketplace=${marketplaceVersion}, plugin=${pluginVersion}.`);
    process.exit(1);
  }

  if (marketplaceVersion !== pluginVersion) {
    console.error(
      `[version-sync] DRIFT: marketplace.json (${marketplaceVersion}) != `
      + `plugin.json (${pluginVersion}).\n`
      + `Bump both in lockstep — the Claude app reads marketplace.json for update detection.`);
    process.exit(1);
  }

  console.log(`[version-sync] OK — marketplace.json and plugin.json both at ${pluginVersion}.`);
}

if (require.main === module) {
  main();
}

module.exports = { resolveVersions };
