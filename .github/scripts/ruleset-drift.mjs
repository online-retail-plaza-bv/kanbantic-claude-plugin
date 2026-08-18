#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  ruleset-drift.mjs
// -----------------------------------------------------------------------------
//  Compares the LIVE GitHub branch-protection ruleset against the committed
//  deploy/github/rulesets/main-protection.json and fails on any difference.
//
//  Ported verbatim (bar this header) from the monorepo — Online-Retail-Plaza-BV/
//  kanbantic, .github/scripts/ruleset-drift.mjs, KBT-B533 / KBT-F620. The script
//  itself is repo-agnostic: it takes two file paths and knows nothing about
//  which repository they describe. Keep it that way, and port fixes both ways.
//
//  Why this exists, in the monorepo's words: the committed file and the live
//  ruleset had diverged on EVERY setting — required checks (4 aggregator names
//  vs 10 job names, with zero overlap), approvals (1 vs 0), signatures, linear
//  history. Nobody noticed for months because nothing compared them. The README
//  even carried a manual "periodically diff these" procedure that was evidently
//  never run.
//
//  A stale config file is not merely untidy: `apply-ruleset.ps1` applies this
//  file VERBATIM, and agents/humans read it to decide whether a gate blocks.
//  Both were actively misled — see the KBT-B512 write-up on KBT-B533.
//
//  This repo starts in sync: main-protection.json was generated FROM the live
//  ruleset, not hand-written, so the first run compares clean by construction.
//
//  Usage:  node ruleset-drift.mjs <live.json> <committed.json>
//  Exit:   0 = in sync, 1 = drift, 2 = usage/parse error
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

// Fields GitHub manages itself — present in an API response, never in a payload.
const SERVER_ONLY = new Set([
  'id', 'node_id', 'source', 'source_type', 'created_at', 'updated_at',
  '_links', 'current_user_can_bypass', 'links',
]);

/** Recursively drop server-managed and `_`-prefixed (comment) keys, and sort object keys. */
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value === null || typeof value !== 'object') return value;

  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (SERVER_ONLY.has(key) || key.startsWith('_')) continue;
    out[key] = normalise(value[key]);
  }
  return out;
}

/**
 * Reduce a ruleset (live response or committed payload) to its comparable shape.
 *
 * Collections are keyed by their identity — rules by `type`, checks by `context`,
 * bypass actors by `actor_id` — never by array position. With positional keys a
 * single missing rule shifts every later index and the report becomes a wall of
 * phantom differences instead of pointing at the one setting that moved.
 */
function shape(raw) {
  const r = normalise(raw);

  const rules = {};
  for (const rule of r.rules ?? []) {
    const p = { ...(rule.parameters ?? {}) };
    if (rule.type === 'required_status_checks') {
      const checks = {};
      for (const c of p.required_status_checks ?? []) {
        checks[c.context] = c.integration_id ?? '(no integration_id)';
      }
      p.required_status_checks = checks;
    }
    rules[rule.type] = rule.parameters ? p : '(no parameters)';
  }

  const bypass = {};
  for (const a of r.bypass_actors ?? []) {
    bypass[`${a.actor_type}:${a.actor_id}`] = a.bypass_mode;
  }

  return {
    name: r.name,
    target: r.target,
    enforcement: r.enforcement,
    conditions: r.conditions ?? {},
    bypass_actors: bypass,
    rules,
  };
}

/** Flatten to dotted leaf paths so the report points at the exact setting. */
function leaves(value, prefix = '', acc = new Map()) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value);
    if (entries.length === 0) acc.set(prefix, Array.isArray(value) ? '[]' : '{}');
    for (const [k, v] of entries) leaves(v, prefix ? `${prefix}.${k}` : k, acc);
  } else {
    acc.set(prefix, JSON.stringify(value));
  }
  return acc;
}

function main() {
  const [livePath, filePath] = process.argv.slice(2);
  if (!livePath || !filePath) {
    console.error('usage: ruleset-drift.mjs <live.json> <committed.json>');
    process.exit(2);
  }

  let live;
  let file;
  try {
    live = shape(JSON.parse(readFileSync(livePath, 'utf8')));
    file = shape(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch (e) {
    console.error(`::error::Could not read/parse a ruleset: ${e.message}`);
    process.exit(2);
  }

  const a = leaves(live);
  const b = leaves(file);
  const diffs = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const l = a.get(key);
    const f = b.get(key);
    if (l !== f) diffs.push({ key, live: l ?? '(absent)', file: f ?? '(absent)' });
  }
  diffs.sort((x, y) => x.key.localeCompare(y.key));

  if (diffs.length === 0) {
    console.log('✅ Live ruleset and main-protection.json are in sync.');
    return;
  }

  console.log(`::group::Ruleset drift — ${diffs.length} difference(s)`);
  console.log('SETTING'.padEnd(58) + 'LIVE'.padEnd(34) + 'COMMITTED FILE');
  console.log('-'.repeat(120));
  for (const d of diffs) {
    console.log(d.key.padEnd(58) + String(d.live).slice(0, 32).padEnd(34) + String(d.file).slice(0, 40));
  }
  console.log('::endgroup::');
  console.error(
    '::error::deploy/github/rulesets/main-protection.json does not match the live ruleset. '
    + 'Either the ruleset was changed in the UI without checking it in, or the file was edited to '
    + 'describe a desired state. The file is applied VERBATIM by apply-ruleset.ps1 — do not leave it '
    + 'aspirational. Reconcile deliberately (see KBT-B533) and re-run.',
  );
  process.exit(1);
}

main();
