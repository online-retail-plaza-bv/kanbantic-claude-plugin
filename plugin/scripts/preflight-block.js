#!/usr/bin/env node
'use strict';

//
// preflight-block — KBT-B499 — generieke pre-flight-check declaratie-parser.
//
// De plugin droeg een workspace-SPECIFIEKE ABP-licentiecheck met zich mee: een
// harde, in de skill ingebakken aanname over één workspace. Dat hoort niet in een
// generieke plugin thuis (KBT-B499). In plaats daarvan declareert ELKE workspace
// zijn eigen pre-flight-checks in een AI Toolkit-item met de vaste titel
// `pre-flight-checks`, en voert de lane-skill `kanbantic-issue-execute` die uit
// vóór `claim_issue`.
//
// Dit bestand is de PURE parser + selector daarvoor — string in, gestructureerde
// data uit. Geen filesystem, geen MCP, geen netwerk, geen process-spawn, geen
// process.exit: het UITVOEREN van een check is expliciet niet onze taak, wij
// zeggen alleen WELKE checks er zijn en welke van toepassing zijn. Daardoor is de
// module triviaal unit-testbaar en kan hij vanuit de SKILL.md-prose als decision
// rule worden aangeroepen. Zelfde stijl als wireframe-block.js / gate-context.js:
// zero-deps, Node-builtins, CommonJS `module.exports`.
//
// Formaat (markdown-tabel in het Toolkit-item):
//
//   | Check           | Scope                          | Command                  | On fail |
//   |---|---|---|---|
//   | ABP Pro license | app:my-api, app:my-worker | pwsh -File .../abp.ps1   | stop    |
//   | Docker draait   | tag:live-stack                 | docker info              | stop    |
//   | VPN bereikbaar  | always                         | ping -n 1 10.0.0.1       | warn    |
//
// Kolommen worden op NAAM herkend (case-insensitief), niet op positie — een
// workspace mag de kolomvolgorde kiezen zonder de parser om te gooien. Tekst
// buiten de tabel wordt genegeerd; meerdere tabellen in één item zijn toegestaan.
//
// FAIL-NOT-SKIP (KBT-RL191, zelfde principe als wireframe-block.js): een rij die
// er als een check UITZIET maar ongeldig is, belandt in `errors` — nooit stil
// overgeslagen. Een stilzwijgend genegeerde licentiecheck is precies het soort
// bug dat deze parser moet voorkomen: de skill zou dan doorlopen in de valse
// veronderstelling dat er geen check gedeclareerd was.
//

// De vaste titel/slug van het Toolkit-item waar `kanbantic-issue-execute` naar
// zoekt. Eén constante, zodat skill en parser niet uit elkaar kunnen lopen.
const PREFLIGHT_ITEM_TITLE = 'pre-flight-checks';

// Toegestane `On fail`-waarden. `stop` = harde blokkade vóór claim_issue,
// `warn` = loggen en doorlopen.
const ON_FAIL_VALUES = new Set(['stop', 'warn']);

// Veilige standaard bij een leeg `On fail`-veld: liever ten onrechte stoppen dan
// ten onrechte doorlopen (KBT-B499 — een niet-uitgevoerde blokkerende check is
// erger dan een overbodige stop).
const DEFAULT_ON_FAIL = 'stop';

// Canonieke kolomnamen → de sleutel die wij intern gebruiken. De header wordt
// genormaliseerd door alles behalve [a-z0-9] weg te strippen, zodat `On fail`,
// `on-fail` en `onfail` allemaal op `onfail` uitkomen.
const COLUMN_ALIASES = {
  check: 'check',
  scope: 'scope',
  command: 'command',
  onfail: 'onFail',
};

// Kolommen zonder welke een rij geen betekenis heeft. `On fail` staat er
// bewust NIET bij: dat veld heeft een gedefinieerde default (zie
// DEFAULT_ON_FAIL), dus een tabel die de kolom weglaat is volledig leesbaar.
const REQUIRED_COLUMNS = ['check', 'scope', 'command'];

/** Een markdown-tabelregel: begint (na inspringen) met een pipe. */
function isTableLine(line) {
  return /^[ \t]{0,3}\|/.test(line);
}

/** De scheidingsrij onder de header: `|---|:--:|` etc. */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/**
 * Split één tabelregel in cellen.
 *
 * Splitst alleen op NIET-ge-escapete pipes en zet `\|` terug om naar `|`: het
 * Command-veld is een vrije shell-string en bevat in de praktijk pipes
 * (`docker info \| grep Server`). Zonder deze afhandeling zou zo'n commando in
 * stukken vallen en als kolom-mismatch worden afgekeurd.
 */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  // Sluit-pipe alleen strippen als hij niet ge-escaped is.
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** `On fail` → `onfail`, `Check ` → `check`. */
function normalizeHeaderCell(cell) {
  return String(cell).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Bouw de kolom-index uit een headerrij.
 *
 * @returns {{ map: object|null, recognised: number, missing: string[] }}
 *   `map` bevat interne sleutel → kolomindex. `recognised` telt hoeveel van onze
 *   kolommen überhaupt herkend zijn — daarmee onderscheiden we een KAPOTTE
 *   pre-flight-tabel (fout) van een willekeurige andere markdown-tabel in het
 *   item (negeren). Zonder dat onderscheid zou elke losse tabel in de
 *   documentatie een valse fout opleveren.
 */
function buildHeaderMap(cells) {
  const map = {};
  let recognised = 0;
  cells.forEach((cell, index) => {
    const key = COLUMN_ALIASES[normalizeHeaderCell(cell)];
    if (!key) return;
    // Eerste voorkomen wint — een dubbele kolom mag de index niet verschuiven.
    if (map[key] === undefined) {
      map[key] = index;
      recognised++;
    }
  });
  const missing = REQUIRED_COLUMNS.filter((k) => map[COLUMN_ALIASES[k]] === undefined);
  return { map, recognised, missing };
}

/**
 * Parse het Scope-veld naar `{ always, apps, tags }`.
 *
 * Geldige tokens: `app:<slug>`, `tag:<tag>`, `always`. Slugs/tags worden
 * lowercase genormaliseerd zodat de matching in selectApplicableChecks
 * case-insensitief kan zijn zonder daar nogmaals te normaliseren.
 *
 * @returns {{ scope: object }|{ error: string }}
 */
function parseScope(raw) {
  const tokens = String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return { error: 'Scope is leeg — verwacht minstens één van app:<slug>, tag:<tag>, always' };
  }

  const scope = { always: false, apps: [], tags: [] };
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'always') {
      scope.always = true;
      continue;
    }
    const m = lower.match(/^(app|tag):(.+)$/);
    if (!m || m[2].trim().length === 0) {
      return { error: `Ongeldig scope-token "${token}" — verwacht app:<slug>, tag:<tag> of always` };
    }
    if (m[1] === 'app') scope.apps.push(m[2].trim());
    else scope.tags.push(m[2].trim());
  }

  // `always` naast een gerichte scope is tegenstrijdig: het is niet te zeggen of
  // de auteur "overal" of "alleen daar" bedoelde. Raden zou óf een check te vaak
  // óf te weinig draaien — beide fout, dus dit is een expliciete fout.
  if (scope.always && (scope.apps.length > 0 || scope.tags.length > 0)) {
    return { error: 'Tegenstrijdige scope — "always" mag niet gecombineerd worden met app:/tag:-tokens' };
  }

  return { scope };
}

/**
 * Parse het `On fail`-veld. Leeg ⇒ de veilige default `stop`.
 * @returns {{ onFail: string }|{ error: string }}
 */
function parseOnFail(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (value.length === 0) return { onFail: DEFAULT_ON_FAIL };
  const lower = value.toLowerCase();
  if (!ON_FAIL_VALUES.has(lower)) {
    return { error: `Ongeldige "On fail"-waarde "${value}" — verwacht stop of warn` };
  }
  return { onFail: lower };
}

/**
 * Parse de pre-flight-check declaraties uit een Toolkit-item (KBT-B499).
 *
 * @param {string} markdown  De volledige body van het `pre-flight-checks` item.
 * @returns {{ checks: Array<{name:string, scope:{always:boolean, apps:string[], tags:string[]},
 *                            command:string, onFail:'stop'|'warn'}>,
 *             errors: Array<{line:number, reason:string}> }}
 *
 * "Geen checks gedeclareerd" is een volledig geldige toestand: lege of
 * niet-string input geeft `{ checks: [], errors: [] }` en nooit een throw. De
 * skill mag daarop gewoon doorlopen naar claim_issue.
 */
function parsePreflightChecks(markdown) {
  const checks = [];
  const errors = [];
  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    return { checks, errors };
  }

  const lines = markdown.split(/\r?\n/);

  // Per tabel bijgehouden state. Een niet-tabelregel sluit de huidige tabel af,
  // zodat een tweede tabel opnieuw zijn eigen header krijgt.
  let header = null; // { map, columnCount }
  let tableIgnored = false; // header hoort niet bij ons (andere tabel)
  let tableBroken = false; // header mist een verplichte kolom → hele tabel fout

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (!isTableLine(line)) {
      header = null;
      tableIgnored = false;
      tableBroken = false;
      continue;
    }

    const cells = splitRow(line);

    // Eerste tabelregel = headerrij.
    if (header === null && !tableIgnored && !tableBroken) {
      const { map, recognised, missing } = buildHeaderMap(cells);
      if (recognised === 0) {
        // Volstrekt andere tabel (bijv. uitleg-tabel in hetzelfde item): negeren,
        // geen fout — "tekst buiten de tabel wordt genegeerd" geldt hier net zo.
        tableIgnored = true;
        continue;
      }
      if (missing.length > 0) {
        errors.push({
          line: lineNo,
          reason: `Tabel-header mist verplichte kolom(men): ${missing.join(', ')} — verwacht Check, Scope, Command (+ optioneel On fail)`,
        });
        tableBroken = true;
        continue;
      }
      header = { map, columnCount: cells.length };
      continue;
    }

    // Rest van een genegeerde/kapotte tabel: niets meer over te zeggen. De fout
    // is één keer gemeld op de headerregel (fout "over de hele tabel").
    if (header === null) continue;

    // De scheidingsrij `|---|---|` hoort bij het formaat, geen check.
    if (isSeparatorRow(cells)) continue;

    const reasons = [];

    // Een rij met een ander aantal kolommen dan de header is niet betrouwbaar te
    // interpreteren (welke cel is het commando?). Fail-not-skip: melden, niet raden.
    if (cells.length !== header.columnCount) {
      reasons.push(`Rij heeft ${cells.length} kolom(men), header heeft er ${header.columnCount}`);
      errors.push({ line: lineNo, reason: reasons.join('; ') });
      continue;
    }

    const cellAt = (key) => {
      const index = header.map[key];
      return index === undefined ? '' : cells[index];
    };

    const name = cellAt('check');
    const command = cellAt('command');

    if (name.length === 0) reasons.push('Check-naam ontbreekt');
    if (command.length === 0) reasons.push('Command ontbreekt');

    const scopeResult = parseScope(cellAt('scope'));
    if (scopeResult.error) reasons.push(scopeResult.error);

    const onFailResult = parseOnFail(cellAt('onFail'));
    if (onFailResult.error) reasons.push(onFailResult.error);

    // Precies één error-entry per rij: alle klachten over dezelfde rij worden
    // samengevoegd, zodat de skill niet dezelfde regel meermaals rapporteert
    // maar de auteur wél alles in één keer ziet.
    if (reasons.length > 0) {
      errors.push({ line: lineNo, reason: reasons.join('; ') });
      continue;
    }

    checks.push({
      name,
      scope: scopeResult.scope,
      command,
      onFail: onFailResult.onFail,
    });
  }

  return { checks, errors };
}

/** Normaliseer een context-lijst naar een lowercase Set (tolerant voor rommel). */
function toLowerSet(values) {
  const set = new Set();
  if (!Array.isArray(values)) return set;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) set.add(trimmed.toLowerCase());
  }
  return set;
}

/**
 * Selecteer de checks die voor DEZE issue-context gelden (KBT-B499).
 *
 * @param {Array} checks   Uitvoer van parsePreflightChecks().checks.
 * @param {{applicationSlugs?:string[], tags?:string[]}} [context]
 * @returns {Array} subset van `checks`, oorspronkelijke volgorde behouden.
 *
 * Een check geldt als `scope.always`, óf als één van zijn apps/tags in de
 * context voorkomt. Ontbrekende of lege context ⇒ alleen de `always`-checks:
 * die zijn per definitie niet afhankelijk van de issue en moeten dus ook zonder
 * bekende app/tags draaien.
 */
function selectApplicableChecks(checks, context) {
  if (!Array.isArray(checks)) return [];
  const ctx = context && typeof context === 'object' ? context : {};
  const apps = toLowerSet(ctx.applicationSlugs);
  const tags = toLowerSet(ctx.tags);

  return checks.filter((check) => {
    const scope = check && check.scope;
    if (!scope || typeof scope !== 'object') return false;
    if (scope.always === true) return true;
    if (Array.isArray(scope.apps) && scope.apps.some((a) => apps.has(String(a).toLowerCase()))) return true;
    if (Array.isArray(scope.tags) && scope.tags.some((t) => tags.has(String(t).toLowerCase()))) return true;
    return false;
  });
}

module.exports = { parsePreflightChecks, selectApplicableChecks, PREFLIGHT_ITEM_TITLE };
