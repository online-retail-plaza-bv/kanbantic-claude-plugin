'use strict';

//
// wireframe-block.test.js — KBT-F605 / KBT-TC3275 (+ KBT-TC3280 gedrags-guard)
//
// Dekt de pure `## Wireframe`-blok parser (KBT-SR578):
//   - gestructureerde vorm (velden wireframe/versie/pagina('s) incl. #anker)
//   - legacy vrije-tekst-vorm (genormaliseerd)
//   - opt-out `## Wireframe — n.v.t. (geen UI)`
//   - geen blok aanwezig
//   - workspace-agnostisch: de slug/versie/pagina komen UIT het blok (KBT-BD191)
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWireframeBlock } = require('../scripts/wireframe-block.js');

// ---------------------------------------------------------------------------
// Case 1 — gestructureerde vorm (KBT-TC3275, case 1)
// ---------------------------------------------------------------------------

test('structured block → wireframe/versie/paginas incl. #anker', () => {
  const desc = [
    '## Doel',
    'Iets bouwen.',
    '',
    '## Wireframe',
    '- wireframe: adminmeester--spa',
    '- versie:    v23',
    "- pagina('s): s-ai-bulk, s-ai-hist#anker",
    '',
    '## Acceptatiecriteria',
    '1. ...',
  ].join('\n');

  const r = parseWireframeBlock(desc);
  assert.equal(r.present, true);
  assert.equal(r.optOut, false);
  assert.equal(r.wireframe, 'adminmeester--spa');
  assert.equal(r.versie, 'v23');
  assert.deepEqual(r.paginas, ['s-ai-bulk', 's-ai-hist#anker']);
});

// ---------------------------------------------------------------------------
// Case 2 — legacy vrije-tekst (KBT-TC3275, case 2)
// ---------------------------------------------------------------------------

test('legacy free-text block → normalised versie + paginas', () => {
  const desc = [
    '## Wireframe',
    'Adminmeester — SPA, v23, pagina s-ai-bulk',
  ].join('\n');

  const r = parseWireframeBlock(desc);
  assert.equal(r.present, true);
  assert.equal(r.optOut, false);
  assert.equal(r.versie, 'v23');
  assert.deepEqual(r.paginas, ['s-ai-bulk']);
  assert.ok(/Adminmeester/i.test(r.wireframe));
});

// ---------------------------------------------------------------------------
// Case 3 — opt-out (KBT-TC3275, case 3)
// ---------------------------------------------------------------------------

test('opt-out heading → { optOut: true }', () => {
  const desc = '## Wireframe — n.v.t. (geen UI)';
  const r = parseWireframeBlock(desc);
  assert.equal(r.present, true);
  assert.equal(r.optOut, true);
});

test('opt-out variant "nvt" on its own line', () => {
  const r = parseWireframeBlock('## Wireframe\nn.v.t. (geen UI)');
  assert.equal(r.optOut, true);
});

// ---------------------------------------------------------------------------
// Case 4 — geen blok
// ---------------------------------------------------------------------------

test('no wireframe heading → { present: false }', () => {
  const r = parseWireframeBlock('## Doel\nGeen UI-blok hier.\n');
  assert.equal(r.present, false);
});

test('empty / non-string input → { present: false }', () => {
  assert.equal(parseWireframeBlock('').present, false);
  assert.equal(parseWireframeBlock(undefined).present, false);
  assert.equal(parseWireframeBlock(null).present, false);
});

// ---------------------------------------------------------------------------
// Case 5 — workspace-agnostisch gedrag (KBT-TC3280 / KBT-BD191)
// De parser mag NIETS hardcoden — een andere workspace/slug/versie/pagina
// komt onveranderd terug.
// ---------------------------------------------------------------------------

test('workspace-agnostic: an entirely different wireframe parses through unchanged', () => {
  const desc = [
    '## Wireframe',
    '- wireframe: shopsentry--dashboard',
    '- versie: v7',
    '- pagina: p-orders#totals',
  ].join('\n');

  const r = parseWireframeBlock(desc);
  assert.equal(r.wireframe, 'shopsentry--dashboard');
  assert.equal(r.versie, 'v7');
  assert.deepEqual(r.paginas, ['p-orders#totals']);
});

test('multiple pages split on comma, anchors preserved', () => {
  const desc = '## Wireframe\n- wireframe: w--x\n- versie: v2\n- pagina: a, b#c, d';
  const r = parseWireframeBlock(desc);
  assert.deepEqual(r.paginas, ['a', 'b#c', 'd']);
});

// ---------------------------------------------------------------------------
// Review-fixes KBT-F605 — adversariële randgevallen (PR #39 findings 1-3, 5)
// ---------------------------------------------------------------------------

test('opt-out does NOT false-positive on the word "na" in a sentence (finding 1)', () => {
  const r = parseWireframeBlock('## Wireframe\nWireframe volgt na afstemming met de PO');
  assert.equal(r.present, true);
  assert.equal(r.optOut, false);
});

test('legacy name containing a vN token is preserved, not dropped (finding 2a)', () => {
  const r = parseWireframeBlock('## Wireframe\nCheckout v2 Hub, v23, pagina s-ai-checkout');
  assert.equal(r.wireframe, 'Checkout v2 Hub');
  assert.equal(r.versie, 'v23');
  assert.deepEqual(r.paginas, ['s-ai-checkout']);
});

test('legacy name with vN but no explicit version → version undefined, not misread (finding 2b)', () => {
  const r = parseWireframeBlock('## Wireframe\nCheckout v2 Hub, pagina s-ai-checkout');
  assert.equal(r.wireframe, 'Checkout v2 Hub');
  assert.equal(r.versie, undefined);
  assert.equal(r.incomplete, true);
});

test('block with wireframe+versie but no pagina is marked incomplete (finding 3)', () => {
  const r = parseWireframeBlock('## Wireframe\n- wireframe: adminmeester--spa\n- versie: v23');
  assert.equal(r.optOut, false);
  assert.deepEqual(r.paginas, []);
  assert.equal(r.incomplete, true);
});

test('a complete block is not marked incomplete', () => {
  const r = parseWireframeBlock('## Wireframe\n- wireframe: w--x\n- versie: v2\n- pagina: a');
  assert.equal(r.incomplete, false);
});

test('uppercase heading is recognised (finding 5)', () => {
  const r = parseWireframeBlock('## WIREFRAME\n- wireframe: w--x\n- versie: v2\n- pagina: a');
  assert.equal(r.present, true);
  assert.equal(r.wireframe, 'w--x');
});

test('non-first ## Wireframe section is still found (finding 5)', () => {
  const desc = '## Intro\ntext\n\n## Details\nmore\n\n## Wireframe\n- wireframe: w--x\n- versie: v9\n- pagina: p1';
  const r = parseWireframeBlock(desc);
  assert.equal(r.versie, 'v9');
  assert.deepEqual(r.paginas, ['p1']);
  assert.equal(r.incomplete, false);
});

test('canonical opt-out variants still work after the anchor fix', () => {
  assert.equal(parseWireframeBlock('## Wireframe — n.v.t. (geen UI)').optOut, true);
  assert.equal(parseWireframeBlock('## Wireframe\nn.v.t. (geen UI)').optOut, true);
  assert.equal(parseWireframeBlock('## Wireframe — n/a').optOut, true);
});
