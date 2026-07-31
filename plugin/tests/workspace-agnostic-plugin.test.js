'use strict';

//
// workspace-agnostic-plugin.test.js — KBT-B499
//
// De plugin is bedoeld voor ELKE workspace. Werkwijzen, techstacks en
// omgevingsprecondities van één specifieke workspace horen in de AI Toolkit van
// díe workspace (KBT-TRUL014: "Platform-specifieke skills horen NIET in de
// plugin zelf"), niet in de bundel die iedereen installeert.
//
// Deze guard bewaakt dat. Hij bestaat omdat de regel in de praktijk stilletjes
// werd overtreden: de ABP Pro licentiecheck van het Kanbantic-productrepo zat
// ~400 regels diep in de plugin, compleet met env-var-namen, applicatie-slugs,
// .NET-projectnamen en Toolkit-codes die in geen enkele andere workspace
// resolven — en niets merkte dat op.
//
// SCOPE: de bundel die naar gebruikers gaat (skills, hooks, scripts, commands,
// reference, README). Nadrukkelijk NIET plugin/tests/ — dit bestand noemt de
// verboden termen zelf, en testfixtures mogen realistische voorbeeldwaarden
// gebruiken. RELEASE_NOTES_*.md staan buiten plugin/ en blijven dus vrij om de
// geschiedenis te beschrijven.
//
// FAALBAARHEID: deze guard faalt aantoonbaar op de bundel van vóór KBT-B499 —
// abp-license-check.ps1 alleen al levert tientallen treffers. Een guard die niet
// kan falen is geen guard (les uit KBT-B480/B483/B484).
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

// De mappen die daadwerkelijk naar de gebruiker gaan.
const SCANNED_DIRS = ['skills', 'hooks', 'scripts', 'commands', 'reference'];
const SCANNED_FILES = ['README.md'];

// Bestandsextensies waarin we zoeken. known-mcp-tools.json is een registry-dump
// met toolnamen, geen proza; die slaan we over.
const SCANNED_EXT = new Set(['.md', '.js', '.mjs', '.ps1', '.sh']);
const SKIPPED_BASENAMES = new Set(['known-mcp-tools.json']);

/**
 * Verboden termen: operationele details van één specifieke workspace.
 *
 * Bewust GEEN generieke woorden als "backend" of "test" — die zijn
 * workspace-onafhankelijk. En bewust geen issue-codes (KBT-xxx): die zijn
 * herkomstverwijzingen naar waar de plugin ontwikkeld wordt, geen werkwijze.
 */
const FORBIDDEN = [
  // Licentie-/toolingspecifiek voor één techstack
  { pattern: /ABP_LICENSE_CODE/, why: 'env-var van één workspace-techstack' },
  { pattern: /ABP_API_KEY/, why: 'env-var van één workspace-techstack' },
  { pattern: /KANBANTIC_SKIP_ABP_CHECK/, why: 'opt-out van een verwijderde workspace-specifieke check' },
  { pattern: /KANBANTIC_ABP_TOKEN_MAX_AGE_DAYS/, why: 'drempel van een verwijderde workspace-specifieke check' },
  { pattern: /abp-license-check/, why: 'verwijzing naar de verhuisde workspace-check' },
  { pattern: /\.abp[\\/]cli/, why: 'pad in de home-directory van één techstack' },
  { pattern: /\babp login\b/i, why: 'commando van één techstack' },

  // Applicatie-slugs en projectnamen van één workspace. De negatieve lookahead
  // houdt samengestelde namen als `kanbantic-mcp-proxy.js` buiten schot: dat is
  // een bestand van de plugin zelf, geen applicatie-slug van een workspace.
  { pattern: /\bkanbantic-api(?![-\w])/, why: 'applicatie-slug van één workspace' },
  { pattern: /\bkanbantic-mcp(?![-\w])/, why: 'applicatie-slug van één workspace' },
  { pattern: /Kanbantic\.HttpApi/, why: '.NET-projectnaam van één workspace' },
  { pattern: /Kanbantic\.Mcp\b/, why: '.NET-projectnaam van één workspace' },
  { pattern: /Kanbantic\.sln/, why: 'solution-bestand van één workspace' },

  // Buildcommando's van één techstack, voorgeschreven aan alle workspaces
  { pattern: /\bdotnet (build|test|run|ef)\b/, why: 'buildcommando van één techstack' },
];

function collectFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if (SKIPPED_BASENAMES.has(entry.name)) continue;
      if (!SCANNED_EXT.has(path.extname(entry.name))) continue;
      out.push(full);
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(PLUGIN_ROOT, dir));
  for (const file of SCANNED_FILES) {
    const full = path.join(PLUGIN_ROOT, file);
    if (fs.existsSync(full)) out.push(full);
  }
  return out;
}

test('KBT-B499: de plugin-bundel bevat geen workspace-specifieke werkwijzen', () => {
  const files = collectFiles();
  assert.ok(files.length > 20, `verwacht een substantiële bundel, kreeg ${files.length} bestanden`);

  const hits = [];
  for (const file of files) {
    const rel = path.relative(PLUGIN_ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(line)) {
          hits.push(`  ${rel}:${i + 1} — ${pattern} (${why})\n      ${line.trim().slice(0, 160)}`);
        }
      }
    });
  }

  assert.equal(hits.length, 0,
    'De plugin geldt voor elke workspace; deze termen horen in de AI Toolkit van de\n'
    + 'betreffende workspace (KBT-TRUL014 / KBT-B499). Gevonden:\n' + hits.join('\n'));
});

test('KBT-B499: de verhuisde workspace-hook zit niet meer in de bundel', () => {
  const gone = path.join(PLUGIN_ROOT, 'hooks', 'abp-license-check.ps1');
  assert.equal(fs.existsSync(gone), false,
    'hooks/abp-license-check.ps1 hoort in het repo van de workspace zelf te staan, niet in de plugin');
});

test('KBT-B499: het generieke uitbreidingspunt is aanwezig en gedocumenteerd', () => {
  // De check mag niet zomaar verdwijnen: er moet een generieke vervanging staan.
  const parser = path.join(PLUGIN_ROOT, 'scripts', 'preflight-block.js');
  assert.ok(fs.existsSync(parser), 'scripts/preflight-block.js moet bestaan');

  const { PREFLIGHT_ITEM_TITLE } = require(parser);
  assert.equal(PREFLIGHT_ITEM_TITLE, 'pre-flight-checks');

  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills', 'kanbantic-issue-execute', 'SKILL.md'), 'utf8');
  assert.match(skill, /## Step 0\.7: Workspace pre-flight checks/,
    'execute SKILL.md moet de generieke pre-flight-stap dragen');
  assert.match(skill, new RegExp(PREFLIGHT_ITEM_TITLE),
    'de skill moet naar het Toolkit-item met de vaste titel verwijzen');
  assert.match(skill, /KANBANTIC_SKIP_PREFLIGHT/,
    'de generieke opt-out moet gedocumenteerd zijn');
});
