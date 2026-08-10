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

### `kanbantic-issue-review` — Step 8.5: Release-registratie

Een merge die de drie versiebestanden bumpt **is** een release, en wordt vanaf nu ook als zodanig afgehandeld voordat de skill terugkeert:

- **8.5a** — de trigger is de diff, niet het geheugen: raakte de merge `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` of `package.json`? Zo nee, stilzwijgend door naar Step 9. Dat is het normale geval.
- **8.5b** — het uitgebrachte nummer wordt uit de repo gelezen (nooit geraden), de bijbehorende Version gaat door `freeze_version` → `mark_version_released`. Bestaat hij nog niet, dan eerst `create_version` — app-scoped, en zonder `description` vanwege KBT-B557.
- **8.5c** — de volgende `Planned` Version wordt hier geopend in plaats van door de volgende agent onder tijdsdruk. `preview_next_version` blijft een *suggestie*: ligt zijn `baselineNumber` onder wat de repo draagt, dan is de registratie gedreven en wordt de repo als waarheid genomen, met de discrepantie als Decision-entry.

### `skill-docs-release-registration.test.js` — de stap kan niet meer stilletjes verdwijnen

Vier assertions in `npm test`, naar het model van `skill-docs-version-hint.test.js`: de sectie bestaat, hij noemt `freeze_version` én `mark_version_released`, hij triggert op de versiebestanden, en hij waarschuwt tegen het blind volgen van `preview_next_version`. Alle vier falen tegen `origin/main` — de guard kan aantoonbaar rood worden (KBT-B483).

## Wat er in de API-repo bij hoort

`preview_next_version` kreeg in dezelfde issue een monotonie-invariant (`VersionAppService.ComputeNextVersionAsync`): het voorstel ligt altijd strikt boven élke geregistreerde Version. Dat sluit twee bereikbare gaten — een naam-parser die `Plugin v2.36.0 — …` stil oversloeg, en een CalVer-teller die bij een periodewissel onder zijn eigen baseline kon zakken.

Die clamp voorkomt dat er een *fout nummer* wordt uitgedeeld. Hij kan niet voorkomen dat de registratie achter de repo aan gaat lopen — niets aan de serverkant kan dat. Alleen Step 8.5 kan dat, en daarom staat hij hier.

## Wat er bewust niet is gedaan

De negentien tussenliggende Versions zijn **niet** alsnog geregistreerd (productbeslissing 2026-08-10). De historie tussen v2.16.0 en v2.34.0 heeft geen lezer; het gat in het proces had er wel een. Dat de historie vóór v2.35.0 onvolledig is, staat vastgelegd in de AI Toolkit, zodat een latere versie-audit niet concludeert dat er in die maand niets is uitgebracht.
