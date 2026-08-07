# Release Notes — v2.35.0

**KBT-B531 + KBT-F637 — de sync-mirrors: geldige model-aliassen, en de sync komt uit de plugin in plaats van uit elk werkstation**

## Waarom

Sinds de relaxatie van **KBT-TRUL014** zijn `.claude/commands/` en `.claude/agents/` gegenereerde, gitignorede mirrors van de Toolkit. Een verse clone heeft dus geen commands en geen subagents tot er een sync gedraaid heeft. Dat maakte de sync een opstartvoorziening — en precies daarom had elk werkstation er zelf een gebouwd, elk met zijn eigen fouten.

Eén van die fouten was al maanden actief zonder dat iemand het merkte: **geen enkele subagent draaide op het model dat in de Toolkit stond ingesteld.**

## KBT-B531 — de `model:`-frontmatter was ongeldig

`renderFile` nam de modelvoorkeur ongewijzigd over uit het toolkit-item:

```js
const model = item.model || item.Model || '';
const modelLine = model ? `model: ${String(model).toLowerCase()}\n` : '';
```

Twee onafhankelijke defecten in twee opeenvolgende regels, allebei zichtbaar zodra een aanroeper de enum als getal aanlevert — wat de REST-API doet:

1. **`||` in plaats van `??`.** Opus is enum `0`, falsy in JavaScript, dus niet te onderscheiden van "geen modelvoorkeur". De regel viel volledig weg.
2. **Geen normalisatie.** `String(1).toLowerCase()` levert `"1"` — geen geldige Claude Code model-alias.

Gemeten op één werkstation: 5 Sonnet-subagents op `model: 1`, 2 Haiku-subagents op `model: 2`, 2 Opus-subagents zonder model-regel. Geen crash, geen waarschuwing.

**De fix zit in de renderlaag, niet bij de aanroeper.** Er ís geen enkele aanroeper: elk werkstation brengt zijn eigen fetch-laag mee en zou de mapping opnieuw moeten bouwen. `MODEL_ALIASES` + `normalizeModel` accepteren zowel de enum-integer (REST) als de enum-naam (MCP), en een onbekende waarde levert géén regel op — beter geen `model:` dan een parseerfout in de frontmatter.

> **De integratietest verdiende zichzelf meteen terug.** Na de fix in `renderFile` waren alle unit-tests groen, maar de integratietest — die het volledige pad tot de bytes op schijf afloopt — faalde. `buildPlan` droeg exact dezelfde `||`-keten en platte enum `0` al af vóór de renderer hem zag. Zonder die test was de bug half gerepareerd gemerged, met groene tests als bewijs.

## KBT-F637 — de sync komt nu uit de plugin

Een handgeschreven SessionStart-hook draagt structureel drie gebreken, alle drie stil:

| Gebrek | Gevolg |
|---|---|
| Hardgecodeerde workspace-GUID | Niet overdraagbaar tussen werkstations of workspaces |
| Eigen REST-fetcher met eigen enum-mapping | De mapping werd voor `category` nagebouwd en voor `model` vergeten — dat ís KBT-B531 |
| `sort -V \| tail -1` over de plugin-cache | Kiest een versie die niet per se draait |

De plugin levert de sync nu zelf mee als tweede `SessionStart`-hook naast `check-update.sh`, aangeroepen via `${CLAUDE_PLUGIN_ROOT}` — waarmee het derde gebrek per definitie verdwijnt.

**Databron is MCP, niet REST.** MCP levert `category` en `model` als enum-namen waar REST integers geeft. Door de bron te kiezen die het contract al in de juiste vorm levert, bestaat de mappingstap niet meer — en dus ook niet de plek om hem te vergeten. Dat is een klasse sterker dan "deze keer wel de mapping doen".

**Workspace-detectie in vier lagen** (KBT-SR606), elk pas geraadpleegd als de vorige niets oplevert:

| # | Bron | Kosten |
|---|---|---|
| 1 | `KANBANTIC_WORKSPACE_ID` | gratis — expliciet wint |
| 2 | `workspace` uit een bestaande `.kanbantic-sync.json` | één bestandslezing |
| 3 | match van de git-remote tegen de bekende repositories | één netwerkronde, alleen bij een verse clone |
| 4 | geen match → stil overslaan | — |

Claimen twee workspaces dezelfde remote, dan kiest de hook **niet**: gokken zou deze repo tegen andermans workspace syncen en de mirrors met hun skills overschrijven.

**Fail-safe is de bovenliggende regel** (KBT-BD206). Geen API-key, geen git-repo, geen netwerk, een endpoint dat nooit antwoordt — alles eindigt op exit 0 met hooguit één regel uitvoer. Dat botst bewust met `fail-not-skip` (KBT-RL191): dat principe bewaakt gates die correctheid van wérk afdwingen, terwijl falen hier hooguit betekent dat de mirrors een sessie ouder zijn.

Nieuw: **`KANBANTIC_SYNC_DEBUG=1`** schrijft de reden van een skip naar stderr. Stille afhandeling is juist voor een operator en hinderlijk voor wie moet uitzoeken waarom er niets gesynchroniseerd is. De exit-code blijft 0, dus aanzetten verandert nooit gedrag — alleen zichtbaarheid.

### Migratie — had je een eigen hook?

**Verwijder die entry uit je lokale `.claude/settings*.json`.** Draaien beide, dan syncen ze bij elke sessiestart om beurten over elkaar heen. Dat is niet destructief — ze schrijven hetzelfde — maar het verdubbelt de opstarttijd en maakt de manifest-tijdstempels waardeloos als diagnose-signaal.

De hook detecteert zo'n entry en meldt hem één keer, met het pad erbij:

```
[kanbantic-toolkit-sync] a hand-written SessionStart sync is still configured in
<pad>/.claude/settings.local.json — remove that entry; this hook now ships with the plugin.
```

Hij past dat bestand **niet** zelf aan. Het zijn jouw instellingen; een hook die ongevraagd andermans configuratie herschrijft richt meer schade aan dan de dubbele sync die hij zou voorkomen.

## Verder in deze release

- **KBT-B538** — PR-titel en -body dragen de identiteit van de aanmakende agent; de idempotentie-guard hangt aan de werkelijke agent-naam in plaats van aan een vaste string.
- **KBT-B514** — `filePath`-adverteerteksten per `contentField`: de `filesJson`-tools eisen de JSON-array, niet rauwe bestanden.
- **CI** — de workflows draaien op de self-hosted baremetal-runnerpool in plaats van GitHub-hosted/Blacksmith.

## Tests

+29 tests ten opzichte van v2.34.0, verdeeld over drie niveaus.

| Suite | Dekking |
|---|---|
| `sync-workspace-skills.test.js` | negen model-invoervormen afzonderlijk, plus een sweep-assertie die vastlegt dat geen enkele invoer een kaal getal in de frontmatter kan zetten — die blijft gelden als de enum ooit hernummerd wordt |
| `workspace-detect.test.js` | de vier detectielagen, met een assertie op wélke laag antwoordde en niet alleen op de uitkomst |
| `session-start-toolkit-sync.test.js` | zeven faalcondities als los proces gespawned, plus real-proxy E2E tegen een stub-backend met asserties op de handshake, de headers en de bytes op schijf |

De faalconditie "server antwoordt nooit" verdient aparte vermelding: dat is de enige faalvorm die zichzelf niet meldt, en zonder request-time-out zou hij elke sessiestart ophouden. Een test die daarop blijft hangen ís het regressiesignaal.

## Bekende conditie

Zes tests in de git-identity-testbestanden falen op een werkstation met een globaal ingestelde git-identiteit; ze verwachten een lege of gefixeerde identiteit. Pre-existing, onveranderd aanwezig op `v2.34.0`, en vastgelegd als **KBT-B546**. Vergelijk bij twijfel tegen een schone baseline-worktree voordat je een rode test aan je eigen wijziging toeschrijft.
