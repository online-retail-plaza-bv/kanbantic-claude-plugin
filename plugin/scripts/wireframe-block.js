#!/usr/bin/env node
'use strict';

//
// wireframe-block — KBT-F605 (KBT-SR578) — canonieke `## Wireframe`-blok parser.
//
// De lane-skills (prepare / graduation / execute) moeten het `## Wireframe`-blok
// uit een issue-beschrijving lezen en dereferencen (KBT-RL191). Dit is de PURE,
// workspace-agnostische parser die daarvoor de bron-van-waarheid is — geen
// filesystem, geen MCP, geen process.exit, zodat hij triviaal unit-testbaar is
// en vanuit de SKILL.md-prose kan worden aangeroepen (decision rule
// `parseWireframeBlock`). Zelfde stijl als gate-context.js: zero-deps,
// Node-builtins, CommonJS `module.exports`.
//
// Grammatica (KBT-SR578):
//
//   Gestructureerd:
//     ## Wireframe
//     - wireframe: adminmeester--spa
//     - versie:    v23
//     - pagina('s): s-ai-bulk, s-ai-hist#anker
//
//   Legacy vrije-tekst (tolerant genormaliseerd):
//     ## Wireframe
//     Adminmeester — SPA, v23, pagina s-ai-bulk
//
//   Opt-out (geen UI):
//     ## Wireframe — n.v.t. (geen UI)
//
// Retour-shape:
//   - geen `## Wireframe`-heading         → { present: false }
//   - opt-out-vorm                        → { present: true, optOut: true }
//   - anders                              → { present: true, optOut: false,
//                                             wireframe, versie, paginas: string[] }
//
// De slug/versie/pagina komen UITSLUITEND uit het blok — nooit hardcoded
// (KBT-BD191). `paginas` behoudt een eventuele `#anker`-suffix per pagina.
//

// Matcht een `## Wireframe`-heading-regel; capture-groep 1 = de rest van de
// heading-regel (voor de opt-out-vorm `## Wireframe — n.v.t. (geen UI)`).
const HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+wireframe\b[ \t]*(.*)$/im;

// Herkent de opt-out: "n.v.t." / "nvt" / "n/a" (met of zonder "(geen UI)"),
// zowel op de heading-regel als op een losse regel eronder.
const OPTOUT_RE = /\bn\.?\s*v\.?\s*t\.?\b|\bn\/?a\b/i;

// Een exact-gepind versienummer: v gevolgd door 1+ cijfers (optioneel .x.y).
const VERSION_TOKEN_RE = /\bv\d+(?:\.\d+)*\b/i;

/**
 * Split de beschrijving in het blok-lichaam onder de eerste `## Wireframe`.
 * @returns {{ headingRest: string, body: string } | null}
 */
function extractSection(description) {
  if (typeof description !== 'string' || description.length === 0) return null;
  const lines = description.split(/\r?\n/);
  let start = -1;
  let headingRest = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]{0,3}(#{1,6})[ \t]+wireframe\b[ \t]*(.*)$/i);
    if (m) {
      start = i;
      headingRest = (m[2] || '').trim();
      // strip een leidend em-dash/hyphen scheidingsteken van de heading-rest
      headingRest = headingRest.replace(/^[—\-–:]\s*/, '').trim();
      break;
    }
  }
  if (start === -1) return null;

  // Verzamel het lichaam tot de volgende heading (## ...) of einde.
  const bodyLines = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[ \t]{0,3}#{1,6}[ \t]+\S/.test(lines[i])) break;
    bodyLines.push(lines[i]);
  }
  return { headingRest, body: bodyLines.join('\n').trim() };
}

/**
 * Normaliseer een pagina-lijst-string naar losse scherm-id's (incl. #anker).
 * "s-ai-bulk, s-ai-hist#anker" → ["s-ai-bulk", "s-ai-hist#anker"]
 */
function splitPages(raw) {
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    // strip een leidend "pagina('s)"/"pagina"/"paginas"/"page(s)" woord + separator
    .map((s) => s.replace(/^pagina(?:\('?s'?\)|['’]?s)?\b[\s:]*/i, '').replace(/^pages?\b[\s:]*/i, '').trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse één "veld: waarde"-regel (met of zonder leidend "- "/"* ").
 * @returns {[string, string] | null}
 */
function parseFieldLine(line) {
  const m = line.match(/^[ \t]*[-*]?[ \t]*([a-z][a-z '’()\/]*?)[ \t]*:[ \t]*(.*)$/i);
  if (!m) return null;
  return [m[1].trim().toLowerCase(), m[2].trim()];
}

/**
 * Parse het `## Wireframe`-blok uit een issue-beschrijving (KBT-SR578).
 *
 * @param {string} description  De volledige issue-beschrijving (Markdown).
 * @returns {{present:boolean, optOut?:boolean, wireframe?:string,
 *            versie?:string, paginas?:string[]}}
 */
function parseWireframeBlock(description) {
  const section = extractSection(description);
  if (!section) return { present: false };

  const { headingRest, body } = section;

  // Opt-out: n.v.t. op de heading-regel of ergens in het (korte) lichaam.
  const optOutHeading = headingRest.length > 0 && OPTOUT_RE.test(headingRest);
  const optOutBody = body.length > 0 && body.length < 80 && OPTOUT_RE.test(body) && VERSION_TOKEN_RE.test(body) === false;
  if (optOutHeading || optOutBody) {
    return { present: true, optOut: true };
  }

  // Probeer eerst de gestructureerde velden-vorm.
  const fields = {};
  for (const line of body.split(/\r?\n/)) {
    const kv = parseFieldLine(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (/^wireframe$/.test(key)) fields.wireframe = value;
    else if (/^versie$|^version$/.test(key)) fields.versie = value;
    else if (/^pagina/.test(key) || /^pages?$/.test(key)) fields.paginas = value;
  }

  let wireframe = fields.wireframe;
  let versie = fields.versie;
  let paginas = fields.paginas != null ? splitPages(fields.paginas) : undefined;

  // Legacy vrije-tekst-vorm: "Naam, v23, pagina s-ai-bulk".
  if (!wireframe || !versie || !paginas) {
    const flat = body.replace(/\n+/g, ' ').trim();
    const parts = flat.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (!versie) {
        const vm = part.match(VERSION_TOKEN_RE);
        if (vm && /^v\d/i.test(part.trim())) {
          versie = vm[0];
          continue;
        }
      }
      if (!paginas && /pagina|pages?\b/i.test(part)) {
        paginas = splitPages(part);
        continue;
      }
      if (!wireframe && !VERSION_TOKEN_RE.test(part) && !/pagina|pages?\b/i.test(part)) {
        wireframe = part;
      }
    }
    // versie kan ook los in de tekst staan zonder eigen segment
    if (!versie) {
      const vm = flat.match(VERSION_TOKEN_RE);
      if (vm) versie = vm[0];
    }
  }

  // Normaliseer versie naar de "vNN"-vorm (behoud gepinde exactheid).
  if (versie) {
    const vm = String(versie).match(VERSION_TOKEN_RE);
    versie = vm ? vm[0].toLowerCase() : String(versie).trim();
  }

  return {
    present: true,
    optOut: false,
    wireframe: wireframe ? wireframe.trim() : undefined,
    versie: versie || undefined,
    paginas: paginas && paginas.length ? paginas : [],
  };
}

module.exports = { parseWireframeBlock };
