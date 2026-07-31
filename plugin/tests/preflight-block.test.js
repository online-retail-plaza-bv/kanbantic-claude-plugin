'use strict';

//
// preflight-block.test.js — KBT-B499
//
// Dekt de pure pre-flight-check declaratie-parser + selector die de
// workspace-specifieke ABP-licentiecheck vervangt door een generiek
// uitbreidingspunt:
//   - parsen van de markdown-tabel (kolommen op naam, niet op positie)
//   - scope-ontleding (app: / tag: / always) en de tegenstrijdigheids-regel
//   - onFail incl. de veilige default `stop`
//   - FAIL-NOT-SKIP: een ongeldige rij levert een error, nooit een stille skip
//   - selectApplicableChecks: app-, tag- en always-matching, case-insensitief
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePreflightChecks,
  selectApplicableChecks,
  PREFLIGHT_ITEM_TITLE,
} = require('../scripts/preflight-block.js');

// Het voorbeeld uit KBT-B499 — bewust workspace-specifieke namen, om te tonen
// dat de parser die ONVERANDERD doorgeeft en niets hardcodeert.
const SAMPLE = [
  '# Pre-flight checks',
  '',
  'Deze checks draaien vóór claim_issue.',
  '',
  '| Check | Scope | Command | On fail |',
  '|---|---|---|---|',
  '| ABP Pro license | app:kanbantic-api, app:kanbantic-mcp | pwsh -File .claude/preflight/abp-license-check.ps1 | stop |',
  '| Docker draait | tag:live-stack | docker info | stop |',
  '| VPN bereikbaar | always | ping -n 1 10.0.0.1 | warn |',
].join('\n');

// ---------------------------------------------------------------------------
// Constante
// ---------------------------------------------------------------------------

test('PREFLIGHT_ITEM_TITLE is de vaste Toolkit-item titel', () => {
  assert.equal(PREFLIGHT_ITEM_TITLE, 'pre-flight-checks');
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('voorbeeldtabel → 3 checks met correcte scope en onFail', () => {
  const { checks, errors } = parsePreflightChecks(SAMPLE);
  assert.deepEqual(errors, []);
  assert.equal(checks.length, 3);

  assert.deepEqual(checks[0], {
    name: 'ABP Pro license',
    scope: { always: false, apps: ['kanbantic-api', 'kanbantic-mcp'], tags: [] },
    command: 'pwsh -File .claude/preflight/abp-license-check.ps1',
    onFail: 'stop',
  });
  assert.deepEqual(checks[1], {
    name: 'Docker draait',
    scope: { always: false, apps: [], tags: ['live-stack'] },
    command: 'docker info',
    onFail: 'stop',
  });
  assert.deepEqual(checks[2], {
    name: 'VPN bereikbaar',
    scope: { always: true, apps: [], tags: [] },
    command: 'ping -n 1 10.0.0.1',
    onFail: 'warn',
  });
});

test('volgorde uit de tekst blijft behouden', () => {
  const { checks } = parsePreflightChecks(SAMPLE);
  assert.deepEqual(checks.map((c) => c.name), ['ABP Pro license', 'Docker draait', 'VPN bereikbaar']);
});

test('meerdere tabellen worden allemaal geparsed', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| A | always | a.sh | stop |',
    '',
    'Tussentekst.',
    '',
    '| Command | Check | Scope |',
    '|---|---|---|',
    '| b.sh | B | tag:x |',
  ].join('\n');

  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(errors, []);
  assert.deepEqual(checks.map((c) => c.name), ['A', 'B']);
  // Tweede tabel heeft een andere kolomVOLGORDE en geen On fail-kolom.
  assert.equal(checks[1].command, 'b.sh');
  assert.deepEqual(checks[1].scope, { always: false, apps: [], tags: ['x'] });
  assert.equal(checks[1].onFail, 'stop');
});

// ---------------------------------------------------------------------------
// Lege / afwezige input — "geen checks gedeclareerd" is geldig
// ---------------------------------------------------------------------------

test('lege / niet-string input → lege checks, lege errors', () => {
  for (const input of ['', '   \n  ', undefined, null, 42, {}, []]) {
    const r = parsePreflightChecks(input);
    assert.deepEqual(r.checks, [], `checks voor ${JSON.stringify(input)}`);
    assert.deepEqual(r.errors, [], `errors voor ${JSON.stringify(input)}`);
  }
});

test('markdown zonder tabel → leeg, geen errors', () => {
  const r = parsePreflightChecks('# Pre-flight checks\n\nNog niets gedeclareerd.\n');
  assert.deepEqual(r.checks, []);
  assert.deepEqual(r.errors, []);
});

test('een niet-verwante tabel wordt genegeerd zonder valse error', () => {
  const md = ['| Naam | Waarde |', '|---|---|', '| foo | bar |'].join('\n');
  const r = parsePreflightChecks(md);
  assert.deepEqual(r.checks, []);
  assert.deepEqual(r.errors, []);
});

// ---------------------------------------------------------------------------
// Header-validatie
// ---------------------------------------------------------------------------

test('ontbrekende verplichte kolom → één error op de headerregel, geen checks', () => {
  const md = [
    '| Check | Scope | On fail |',
    '|---|---|---|',
    '| A | always | stop |',
    '| B | tag:x | warn |',
  ].join('\n');

  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(checks, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.match(errors[0].reason, /command/i);
});

test('kolomnamen zijn case-insensitief en tolerant voor on-fail/onfail schrijfwijzen', () => {
  for (const headerOnFail of ['On fail', 'ON FAIL', 'on-fail', 'onfail', 'On-Fail']) {
    const md = [
      `| CHECK | scope | CoMmAnD | ${headerOnFail} |`,
      '|---|---|---|---|',
      '| A | ALWAYS | a.sh | STOP |',
    ].join('\n');
    const { checks, errors } = parsePreflightChecks(md);
    assert.deepEqual(errors, [], `errors voor header "${headerOnFail}"`);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].onFail, 'stop');
    assert.equal(checks[0].scope.always, true);
  }
});

test('kolomvolgorde wordt door de header bepaald, niet door positie', () => {
  const md = [
    '| On fail | Command | Check | Scope |',
    '|---|---|---|---|',
    '| warn | ./run.sh | Mijn check | app:Shop |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(errors, []);
  assert.deepEqual(checks[0], {
    name: 'Mijn check',
    scope: { always: false, apps: ['shop'], tags: [] },
    command: './run.sh',
    onFail: 'warn',
  });
});

// ---------------------------------------------------------------------------
// Rij-validatie — FAIL-NOT-SKIP (KBT-RL191)
// ---------------------------------------------------------------------------

test('lege naam → error met het juiste regelnummer', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '|  | always | a.sh | stop |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(checks, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].reason, /naam/i);
});

test('leeg command → error met het juiste regelnummer', () => {
  const md = [
    'Inleiding.',
    '',
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| A | always |  | stop |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(checks, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 5);
  assert.match(errors[0].reason, /command/i);
});

test('ongeldig scope-token → error', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| A | foo:bar | a.sh | stop |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(checks, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].reason, /foo:bar/);
});

test('lege scope → error (minstens één token verplicht)', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| A |  | a.sh | stop |',
  ].join('\n');
  const { errors, checks } = parsePreflightChecks(md);
  assert.deepEqual(checks, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /scope/i);
});

test('always gecombineerd met app: → tegenstrijdige scope is een error', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| A | always, app:x | a.sh | stop |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(checks, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /tegenstrijdig/i);
});

test('ongeldige On fail-waarde → error', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| A | always | a.sh | explode |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(checks, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /explode/);
});

test('leeg On fail-veld → veilige default stop', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| A | always | a.sh |  |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(errors, []);
  assert.equal(checks[0].onFail, 'stop');
});

test('onFail en scope-tokens zijn case-insensitief en worden genormaliseerd', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| A | APP:Kanbantic-API, Tag:Live-Stack | a.sh | WaRn |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(errors, []);
  assert.deepEqual(checks[0].scope, {
    always: false,
    apps: ['kanbantic-api'],
    tags: ['live-stack'],
  });
  assert.equal(checks[0].onFail, 'warn');
});

test('één foute rij tussen twee goede: goede rijen komen eruit, precies één error', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| Goed 1 | always | one.sh | stop |',
    '| Fout | nonsense | two.sh | stop |',
    '| Goed 2 | tag:x | three.sh | warn |',
  ].join('\n');

  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(checks.map((c) => c.name), ['Goed 1', 'Goed 2']);
  assert.equal(errors.length, 1, 'fail-not-skip: precies één error, geen stille skip');
  assert.equal(errors[0].line, 4);
});

test('meerdere klachten over dezelfde rij worden tot één error samengevoegd', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '|  | foo:bar |  | maybe |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(checks, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /naam/i);
  assert.match(errors[0].reason, /command/i);
  assert.match(errors[0].reason, /foo:bar/);
  assert.match(errors[0].reason, /maybe/);
});

test('rij met te weinig kolommen wordt gemeld, niet geraden', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| A | always |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(checks, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
});

test('ge-escapete pipe in het commando blijft intact', () => {
  const md = [
    '| Check | Scope | Command | On fail |',
    '|---|---|---|---|',
    '| Docker | always | docker info \\| grep Server | stop |',
  ].join('\n');
  const { checks, errors } = parsePreflightChecks(md);
  assert.deepEqual(errors, []);
  assert.equal(checks[0].command, 'docker info | grep Server');
});

// ---------------------------------------------------------------------------
// selectApplicableChecks
// ---------------------------------------------------------------------------

const { checks: SAMPLE_CHECKS } = parsePreflightChecks(SAMPLE);
const names = (list) => list.map((c) => c.name);

test('match op applicationSlug', () => {
  const r = selectApplicableChecks(SAMPLE_CHECKS, { applicationSlugs: ['kanbantic-api'] });
  assert.deepEqual(names(r), ['ABP Pro license', 'VPN bereikbaar']);
});

test('match op tag', () => {
  const r = selectApplicableChecks(SAMPLE_CHECKS, { tags: ['live-stack'] });
  assert.deepEqual(names(r), ['Docker draait', 'VPN bereikbaar']);
});

test('app + tag samen → beide gerichte checks plus always', () => {
  const r = selectApplicableChecks(SAMPLE_CHECKS, {
    applicationSlugs: ['kanbantic-mcp'],
    tags: ['live-stack'],
  });
  assert.deepEqual(names(r), ['ABP Pro license', 'Docker draait', 'VPN bereikbaar']);
});

test('geen match → alleen de always-check', () => {
  const r = selectApplicableChecks(SAMPLE_CHECKS, { applicationSlugs: ['iets-anders'], tags: ['geen'] });
  assert.deepEqual(names(r), ['VPN bereikbaar']);
});

test('lege / ontbrekende context → alleen de always-checks', () => {
  assert.deepEqual(names(selectApplicableChecks(SAMPLE_CHECKS, {})), ['VPN bereikbaar']);
  assert.deepEqual(names(selectApplicableChecks(SAMPLE_CHECKS)), ['VPN bereikbaar']);
  assert.deepEqual(names(selectApplicableChecks(SAMPLE_CHECKS, null)), ['VPN bereikbaar']);
  assert.deepEqual(names(selectApplicableChecks(SAMPLE_CHECKS, { applicationSlugs: [], tags: [] })), [
    'VPN bereikbaar',
  ]);
});

test('matching is case-insensitief', () => {
  const r = selectApplicableChecks(SAMPLE_CHECKS, {
    applicationSlugs: ['KANBANTIC-API'],
    tags: ['Live-Stack'],
  });
  assert.deepEqual(names(r), ['ABP Pro license', 'Docker draait', 'VPN bereikbaar']);
});

test('volgorde van de selectie volgt de declaratie-volgorde', () => {
  const r = selectApplicableChecks(SAMPLE_CHECKS, {
    applicationSlugs: ['kanbantic-api'],
    tags: ['live-stack'],
  });
  assert.deepEqual(names(r), names(SAMPLE_CHECKS));
});

test('niet-array checks of rommel in de context geeft geen crash', () => {
  assert.deepEqual(selectApplicableChecks(undefined, { tags: ['x'] }), []);
  assert.deepEqual(selectApplicableChecks(null), []);
  assert.deepEqual(selectApplicableChecks('nope'), []);
  assert.deepEqual(
    names(selectApplicableChecks(SAMPLE_CHECKS, { applicationSlugs: 'kanbantic-api', tags: [null, 7] })),
    ['VPN bereikbaar'],
  );
});

test('een check zonder bruikbare scope wordt nooit geselecteerd', () => {
  assert.deepEqual(selectApplicableChecks([{ name: 'X' }, null], { tags: ['x'] }), []);
});
