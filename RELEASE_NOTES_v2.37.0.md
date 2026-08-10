# Release Notes — v2.37.0

**KBT-B545 — een release die zichzelf registreert, in plaats van een agent die eraan moet denken**

## Waarom

De Version-registratie van deze applicatie in Kanbantic liep negentien minors achter op de repo. Kanbantic kende plugin-Versions tot en met **v2.15.0** (3 juli); de repo stond op **v2.34.0** (3 augustus). `preview_next_version` rekent vanaf de laatst *geregistreerde* Version en stelde daardoor `v2.16.0` voor — een nummer dat al vier weken uit was. Bij KBT-B531 en KBT-F637 is die Version daadwerkelijk aangemaakt en achteraf hernoemd naar v2.35.0, nadat beide issues er al aan hingen.

De hernoeming loste het symptoom op. De oorzaak niet.

## Hoe de drift kon ontstaan

Twee processen op een andere cadans, met niets ertussen.

**De repo brengt een release uit per gemergede PR.** `git log` op `plugin/.claude-plugin/plugin.json` laat één bump per afgeronde issue zien: v2.16.0 (KBT-F382), v2.17.0 (KBT-B398), v2.18.0 (KBT-F488), v2.19.0 (KBT-B417) — negentien minors in vier weken.

**Kanbantic maakt een Version aan wanneer de claim-gate om een emmer vraagt.** KBT-RL145 eist één `Planned` Version per Application voordat er geclaimd mag worden, en één emmer bedient veel issues: `v2.15.0 — Workflow v3 canonisatie` telt er 26. De registratie sprong daarom van v2.15.0 rechtstreeks naar v2.35.0.

**Er was geen brug.** `mark_version_released` en `freeze_version` kwamen in nul skills voor. `create_version` kwam alleen voor als *voorwaarde om te mogen claimen*, nooit als *gevolg van een release*. De repo heeft geen release-workflow — `.github/workflows/` bevat alleen `ci.yml`. En `check-version-sync.js` bewaakt wel drift, maar alleen tussen `marketplace.json` en `plugin.json`; het derde register viel buiten zijn blikveld.

Drift was dus geen incident maar de verwachte uitkomst. Dezelfde vorm als **KBT-B548**: een gebeurtenis die plaatsvindt maar nergens wordt weggeschreven, waarna een afnemer op verouderde gegevens rekent.

## Wat er verandert

### `kanbantic-issue-review` — Step 8.5: Versie-registratie

Een merge die het **versienummer** van de repo wijzigt **is** een release, en wordt vanaf nu ook als zodanig afgehandeld voordat de skill terugkeert:

- **8.5a** — de trigger is de diff, niet het geheugen. En het is de *waarde*, niet of het bestand is aangeraakt: een bewerking die `version` ongemoeid laat (een npm-script erbij, een herschreven omschrijving) is geen release. De **versiedrager verschilt per repo** — voor de plugin is dat `plugin.json`, voor de monorepo de git-tagstroom, die per beleid ontkoppeld is en waar deze stap dus niet geldt. Dat staat nu in een tabel in de skill, want een generieke lane-skill die stilzwijgend maar in één repo werkt is een no-op met een geruststellende naam.

  De vergelijking gaat tegen de **eerste ouder** van HEAD, en dat detail is de hele stap waard. De eerste opzet vergeleek tegen `git merge-base origin/main HEAD` — maar Step 8.5 draait *nadat* Step 7 gemerged en `main` uitgecheckt heeft. HEAD ís dan `origin/main`, de merge-base is HEAD zelf, en het antwoord is altijd "geen release". Een HARD-GATE die nooit afgaat. Niets ving dat, want proza wordt niet uitgevoerd. Daarom zit de trigger nu in **`plugin/scripts/detect-release-bump.js`**, met `plugin/tests/detect-release-bump.test.js` eromheen die hem over echte synthetische merge-commits draait — inclusief precies dat geval. Een niet-nul exit betekent "kan het niet bepalen" en mag nooit als "geen release" gelezen worden.
- **8.5b** — het uitgebrachte nummer wordt uit de repo gelezen (nooit geraden), de bijbehorende Version gaat door `freeze_version` → `mark_version_released`. Bestaat hij nog niet, dan eerst `create_version` — app-scoped, en zonder `description` vanwege KBT-B557.
- **8.5c** — de volgende `Planned` Version wordt hier geopend in plaats van door de volgende agent onder tijdsdruk. `preview_next_version` blijft een *suggestie*: ligt zijn `baselineNumber` onder wat de repo draagt, dan is de registratie gedreven en wordt de repo als waarheid genomen, met de discrepantie als Decision-entry.

### Twee guards, en het eerlijke onderscheid ertussen

**`skill-docs-release-registration.test.js`** houdt de stap op zijn plek: vijf assertions, gescoped op de sectie zelf in plaats van op het hele bestand, zodat een herschrijving die de kop laat staan maar de tool-calls verplaatst er niet doorheen glipt. Alle vijf falen tegen `origin/main` (KBT-B483). Maar dit blijft een *aanwezigheidstest*: hij bewijst dat de instructie er staat, niet dat een agent hem uitvoert.

**`check-release-notes.js`** is het deel dat een machine wél kan afdwingen, en draait mee in CI: een versienummer in `plugin.json` zonder bijbehorende `RELEASE_NOTES_v<versie>.md` is een harde faal — een leeg bestand ook, want een guard die met een leeg bestand tevreden is kan niet falen. Dat registreert de Kanbantic-Version niet (daarvoor heeft deze CI geen API-sleutel), maar het maakt de helft die checkbaar is machinaal. Dat die helft de moeite waard is, laat de repo zelf zien: **19 release-notes-bestanden zonder tag, en 4 tags zonder release-notes.**

## Wat er in de API-repo bij hoort

`preview_next_version` kreeg in dezelfde issue een monotonie-invariant (`VersionAppService.ComputeNextVersionAsync`). Twee samenwerkende delen, met een duidelijke taakverdeling:

- **De naam-parser draagt het SemVer-pad.** `CreateAsync` zet `Number` nooit, dus élke Version wordt uit zijn naam teruggelezen. Twee regels: een `v`-prefix is een expliciete claim dat een token een versie is en wint dus van een kaal getal, en noemt een naam er meerdere, dan staat de rij voor de **eerste**. Zonder de eerste regel leest "Angular 18.2 — v2.36.0" als versie 18.2. Zonder de tweede wint het commentaar van het onderwerp: elke Version in het register heet `v<nummer> — <proza>`, dus "v2.37.0 — Angular v18.2.1 ondersteuning" zou als 18.2.1 gelezen worden, en geciteerde toolchain-versies (Node v20, PostgreSQL v16) verslaan een 2.x-product structureel. Een naam die zijn versie *achter* proza zet blijft een bekende grens — die staat als zodanig in de tests, niet verstopt.
- **De clamp is de CalVer-backstop, niet de invariant.** Op het SemVer-pad hoogt `ComputeSemVer` altijd de baseline op die hij kreeg, dus daar vuurt de clamp nooit. Waar hij wél telt is CalVer: de periodeteller reset, en `VersionController` laat de aanroeper de timestamp bepalen. Hij heeft nu ook een postconditie, want een guard die "opgehoogd" meldt zonder iets te hebben opgehoogd is precies het anti-patroon dat KBT-B483 moet uitsluiten.

Samen voorkomen ze dat er een *fout nummer* wordt uitgedeeld. Ze kunnen niet voorkomen dat de registratie achter de repo aan gaat lopen — niets aan de serverkant kan dat. Alleen Step 8.5 kan dat, en daarom staat hij hier.

## Wat er bewust niet is gedaan

De negentien tussenliggende Versions zijn **niet** alsnog geregistreerd (productbeslissing 2026-08-10). De historie tussen v2.16.0 en v2.34.0 heeft geen lezer; het gat in het proces had er wel een. Dat de historie vóór v2.35.0 onvolledig is, staat vastgelegd in de AI Toolkit, zodat een latere versie-audit niet concludeert dat er in die maand niets is uitgebracht.
