#!/usr/bin/env node
'use strict';

//
// disk-cleanup-policy — KBT-F754 — parser voor het Toolkit-item `disk-cleanup-policy`.
//
// De skill `kanbantic-disk-cleanup` is generiek: hij weet hoe je veilig
// opruimt, niet hoe groot jouw schijf is, waar jouw repo's staan of welke map
// je per se wilt laten staan. Dat verschilt per workspace en hoort daarom in de
// AI Toolkit van die workspace (KBT-TRUL014 / KBT-B499), in een Custom-item met
// de vaste titel `disk-cleanup-policy` — zelfde patroon als `pre-flight-checks`
// (preflight-block.js).
//
// Dit bestand is de PURE parser: string in, gestructureerde policy uit. Geen
// filesystem, geen MCP, geen netwerk, geen process.exit. Het item is optioneel;
// zonder item gelden de defaults hieronder.
//
// Formaat (markdown-tabel in het Toolkit-item; kolommen op naam, niet op positie):
//
//   | Setting          | Value                                   |
//   |---|---|
//   | warn-gb          | 20                                      |
//   | critical-gb      | 12                                      |
//   | repo-roots       | C:\github, D:\work                      |
//   | protected-paths  | C:\github\big-repo\node_modules         |
//   | temp-age-days    | 2                                       |
//   | delegate-to      | maintenance-agent                       |
//   | elevated-script  | KBT-CUST002                             |
//   | docker           | build-cache-only                        |
//
// FAIL-NOT-SKIP (KBT-RL191): een rij die eruitziet als een setting maar
// ongeldig is — een onbekende sleutel, een getal dat geen getal is — belandt in
// `errors`. Een stil genegeerde `protected-paths` is precies de fout die een
// opruimer niet mag maken: de skill zou dan doorlopen in de veronderstelling
// dat er niets beschermd was.
//

const POLICY_ITEM_TITLE = 'disk-cleanup-policy';

const DEFAULTS = Object.freeze({
  warnGb: 20,
  criticalGb: 12,
  repoRoots: [],
  protectedPaths: [],
  tempAgeDays: 2,
  delegateTo: null,
  elevatedScript: null,
  docker: 'build-cache-only',
});

const DOCKER_VALUES = new Set(['build-cache-only', 'skip']);

// setting-sleutel (genormaliseerd: alleen [a-z0-9]) → { key, parse }
const SETTINGS = {
  warngb: { key: 'warnGb', parse: parseNonNegativeNumber },
  criticalgb: { key: 'criticalGb', parse: parseNonNegativeNumber },
  reporoots: { key: 'repoRoots', parse: parseList },
  protectedpaths: { key: 'protectedPaths', parse: parseList },
  tempagedays: { key: 'tempAgeDays', parse: parseNonNegativeNumber },
  delegateto: { key: 'delegateTo', parse: parseOptionalString },
  elevatedscript: { key: 'elevatedScript', parse: parseOptionalString },
  docker: { key: 'docker', parse: parseDocker },
};

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseNonNegativeNumber(raw) {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return { error: `verwacht een getal >= 0, kreeg "${raw}"` };
  return { value: n };
}

function parseList(raw) {
  return { value: String(raw).split(/[,;]/).map((x) => x.trim()).filter(Boolean) };
}

function parseOptionalString(raw) {
  const s = String(raw).trim();
  return { value: s === '' || s === '-' || s === '—' ? null : s };
}

function parseDocker(raw) {
  const s = String(raw).trim().toLowerCase();
  if (!DOCKER_VALUES.has(s)) return { error: `docker verwacht ${[...DOCKER_VALUES].join(' of ')}, kreeg "${raw}"` };
  return { value: s };
}

/** Splitst één markdown-tabelrij in cellen; buitenste pipes zijn optioneel. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * Parseert de body van het Toolkit-item. Tekst buiten tabellen wordt genegeerd;
 * meerdere tabellen zijn toegestaan; alleen tabellen met een `Setting`- én een
 * `Value`-kolom tellen mee.
 *
 * @returns {{ policy: object, errors: Array<{line:number, reason:string}>, seen: string[] }}
 */
function parseDiskCleanupPolicy(markdown) {
  const policy = { ...DEFAULTS, repoRoots: [], protectedPaths: [] };
  const errors = [];
  const seen = [];
  const lines = String(markdown || '').split(/\r?\n/);

  let header = null; // { settingIdx, valueIdx }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) {
      header = null;
      continue;
    }
    const cells = splitRow(line);
    if (header === null) {
      const norm = cells.map(normalizeKey);
      const settingIdx = norm.indexOf('setting');
      const valueIdx = norm.indexOf('value');
      if (settingIdx >= 0 && valueIdx >= 0) {
        header = { settingIdx, valueIdx, armed: false };
      } else {
        header = { skip: true };
      }
      continue;
    }
    if (header.skip) continue;
    if (!header.armed) {
      // de scheidingsrij direct onder de header
      if (isSeparatorRow(cells)) {
        header.armed = true;
        continue;
      }
      header.armed = true; // tabel zonder scheidingsrij: toch doorgaan
    }
    const rawKey = cells[header.settingIdx];
    const rawValue = cells[header.valueIdx];
    if (rawKey === undefined || rawKey === '') continue;
    const key = normalizeKey(rawKey);
    const spec = SETTINGS[key];
    if (!spec) {
      errors.push({ line: i + 1, reason: `onbekende setting "${rawKey}" — toegestaan: ${Object.keys(SETTINGS).join(', ')}` });
      continue;
    }
    const parsed = spec.parse(rawValue === undefined ? '' : rawValue);
    if (parsed.error) {
      errors.push({ line: i + 1, reason: `${rawKey}: ${parsed.error}` });
      continue;
    }
    policy[spec.key] = parsed.value;
    seen.push(spec.key);
  }

  if (policy.criticalGb > policy.warnGb) {
    errors.push({ line: 0, reason: `critical-gb (${policy.criticalGb}) hoort niet boven warn-gb (${policy.warnGb}) te liggen` });
  }

  return { policy, errors, seen };
}

/**
 * Is `candidate` gelijk aan of genest onder één van de beschermde paden?
 * Case-insensitief op Windows, scheidingstekens genormaliseerd.
 */
function isProtected(candidate, protectedPaths, { platform = process.platform } = {}) {
  const norm = (p) => {
    let s = String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    if (platform === 'win32') s = s.toLowerCase();
    return s;
  };
  const c = norm(candidate);
  return (protectedPaths || []).some((p) => {
    const q = norm(p);
    return q !== '' && (c === q || c.startsWith(q + '/'));
  });
}

module.exports = {
  POLICY_ITEM_TITLE,
  DEFAULTS,
  parseDiskCleanupPolicy,
  isProtected,
};
