# Release Notes — v2.32.1

**KBT-B495 — `name:` in de agent-frontmatter: gesyncte Subagents worden eindelijk geladen**

## Waarom
`kanbantic-sync-workspace-skills` schreef Toolkit-items van categorie `Subagent` keurig weg naar `.claude/agents/<slug>.md`, maar **Claude Code laadde er geen enkele**. In de `admin-hub`-workspace stonden 11 correct gegenereerde agent-bestanden op schijf terwijl de beschikbare agent-types uitsluitend de zes ingebouwde waren; een aanroep faalde met `Agent type 'ui-ux-specialist' not found.`

Oorzaak: `renderFile` in `plugin/scripts/sync-workspace-skills.js` emitteerde alleen `description`, `source` en (sinds KBT-F437) `model`. Claude Code registreert een **subagent** onder het frontmatter-veld `name:` en leidt die naam **niet** af van de bestandsnaam. Skills/commands ontsnappen daaraan — hún naam komt wél uit de bestandsnaam — en daarom werkte de `.claude/commands/`-mirror al die tijd wel en was de agents-mirror stil dood. Geen regressie: de tak heeft nooit bestaan, in geen enkele versie sinds de mirror in v2.5.0 (KBT-F265) landde.

Het faalde bovendien **stil**: de sync meldde `created/updated/unchanged` zonder waarschuwing, dus alles zag er geslaagd uit terwijl het resultaat onbruikbaar was.

## Wat er verandert
- **`renderFile` schrijft `name: <slug>` als eerste frontmatter-regel — uitsluitend voor `category === 'Subagent'`.** De waarde is dezelfde slug die het bestandspad bepaalt, dus naam en bestandsnaam zijn per constructie gelijk en de bestaande slug-collision-check fungeert meteen als uniciteitscontrole op agent-namen. Commands krijgen géén `name:`-regel: daar is hij ongebruikt en vervuilt hij alleen de frontmatter.
- **`deriveDescription` slaat een leidende `name:`-regel in de item-content over.** Tweede symptoom van dezelfde ontbrekende ondersteuning: een auteur die de naam via de content probeerde mee te geven (ADM-SKIL003 begint met `name: adminhub-ui-ux`) kreeg letterlijk `description: "name: adminhub-ui-ux"` op schijf. Bewust nauw — alleen de sleutel `name:` — zodat geen bestaande description verschuift.
- **SKILL.md** documenteert nu het frontmatter-contract per veld, waarom `name` voor subagents verplicht is, en het migratiepad.

## Upgrade — geen `--force` nodig
De bugmelding vermoedde dat alle bestaande mirrors na deze wijziging als lokaal-bewerkt zouden gelden. Dat is niet zo, en het staat nu vast in een test: drift-detectie vergelijkt de on-disk hash met de `targetHash` uit `.kanbantic-sync.json`, **niet** met een vers gerenderde file. Een onaangeroerde mirror matcht dus nog steeds, valt door naar de `unchanged`-vergelijking, en eindigt — omdat `targetHash` wél wijzigt — als een schone **UPDATE**. Alleen mirrors die je zelf hebt bewerkt blijven waarschuwen, precies zoals voorheen.

**Wat je wél moet doen:** na het her-syncen de Claude Code-sessie herstarten. De agent-registry wordt bij het opstarten van de sessie ingelezen; een lopende sessie pikt nieuw geschreven `.claude/agents/`-bestanden niet op.

## Tests
Zeven nieuwe regressietests in `plugin/tests/sync-workspace-skills.test.js` (33 in dat bestand totaal, alle groen):

| Niveau | Test case | Dekking |
|---|---|---|
| Unit | KBT-TC3320 | `name:` aanwezig voor Subagent / afwezig voor Skill; expliciete `slug` wint van her-slugificatie; `deriveDescription` negeert een leidende `name:`-regel maar niet een regel die "name:" slechts bevat. |
| Integration | KBT-TC3321 | `runSync` schrijft `name` == basename; een pre-fix mirror (oude render + matchende manifest-hash) hersynct als `update` met `warnings=0` en lege `localEdits`; een écht handbewerkt bestand waarschuwt nog steeds. |
| E2E | KBT-TC3322 | CLI-proces over een fixture met de echte Toolkit-titelvormen (em-dashes, Nederlandse titels, `(KBT-Fxxx)`-suffixen): elk gegenereerd agent-bestand parseert, `name` == basename, name is een schone slug, description niet leeg en niet de `name:`-regel. |

De guards kunnen falen: met de fix teruggedraaid vallen 6 van de 7 om (de twee negatieve controles blijven terecht groen).

**Nog handmatig te doen, eenmalig:** de live laadcontrole — sync draaien, sessie herstarten, en controleren dat een gesyncte subagent in de lijst met agent-types staat. Die stap is niet in-sessie te automatiseren, juist omdat de registry alleen bij sessiestart wordt gelezen.

## Ook in deze release
`.claude-plugin/marketplace.json` is teruggebracht van ~14,6 KB naar 758 bytes: `metadata.description` en `plugins[].description` waren uitgegroeid tot een opgestapelde changelog van elf releases in plaats van een beschrijving van de plugin. De changelog blijft integraal bewaard in de `RELEASE_NOTES_v*.md`-bestanden, waar hij thuishoort.

> Aandachtspunt: `plugin/.claude-plugin/plugin.json` draagt dezelfde opgestapelde changelog (~15 KB) en is in deze release bewust ongemoeid gelaten (buiten de gevraagde scope).
