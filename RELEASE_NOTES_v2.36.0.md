# Release Notes — v2.36.0

**Toolkit-sync hygiëne en werkstation-onafhankelijkheid — de nasleep van v2.35.0**

## Waarom

v2.35.0 repareerde de sync-mirrorketen. Het uitvoeren daarvan legde vier defecten bloot die er niet in zaten maar er wel omheen lagen, en die één ding gemeen hebben: **een aanname over het werkstation, of over waar iets vandaan komt.**

Alle vier zijn stille faalmodi. Niets crasht. Het verschil merk je pas als je ergens op vertrouwt dat er niet is — en drie van de vier kwamen aan het licht doordat er toevallig tegenaan werd gelopen, niet doordat iets zich meldde.

## KBT-B551 + KBT-B560 — de test-policy stond op de verkeerde plek, en werd van de verkeerde plek gelezen

Deze twee zijn één verhaal, en ze zijn apart gevonden.

De test-policy (Regel E / KBT-F442) legt per niveau vast of Unit, Integration en E2E `Vereist` of `N.v.t.` zijn. De Done-gates lezen daarvoor **uitsluitend het beleidsrecord** — nooit een discussion-entry.

- **KBT-B551** — `prepare` schreef de policy alleen als `Decision`-entry. Het record bleef daarmee op de standaardwaarden staan (alle drie `Vereist`, min 1), en `claim_issue` bevroor die standaardwaarden. Een `N.v.t.`-declaratie was dus onzichtbaar voor precies de poort waarvoor hij bedoeld was.
- **KBT-B560** — `execute` en `review` lazen de policy terug uit diezelfde entry, door de markdown-tabel te parsen. Ook zij zagen daarmee niet wat de gates zien.

Samen: de policy werd door niemand naar het gezaghebbende record geschreven, en door niemand eruit gelezen. De entry en het record konden onbeperkt uiteenlopen zonder dat iets dat opmerkte.

**Wat er nu gebeurt.** `prepare` roept `set_test_policy` per niveau aan — altijd alle drie, ook voor een niveau dat op de standaardwaarde uitkomt, want expliciet gezet is controleerbaar en impliciet overgeslagen niet. Step 6.1 toetst vóór de Ready-transitie dat record en declaratie werkelijk overeenkomen; divergentie is een readiness-tekortkoming, geen waarschuwing. `execute` §3c en `review` Step 1b lezen `get_test_policy`, met de veldmapping expliciet uitgeschreven.

De `Decision`-entry blijft bestaan, maar is gedegradeerd tot leesbare motivering. **Het record is het gezag.** Divergentie tussen de twee is voortaan een te melden signaal in plaats van een onzichtbaar verschil.

> **Een halve reparatie is even stil als geen reparatie.** De verificatie in Step 6.1 bestaat omdat een half-geslaagde reeks van drie `set_test_policy`-aanroepen precies zo geruisloos faalt als het defect dat hij vervangt.

**Nieuw in `lint-skills.js`:** een invariant tegen *bijna-juiste* toolnamen. Een skill die `update_test_policy` voorschrijft waar de tool `set_test_policy` heet, faalt bij de agent die hem volgt — en leest voor een mens volkomen plausibel. De regel is bewust tweezijdig (werkwoord-voorvoegsel én zelfstandig-naamwoord-achtervoegsel moeten allebei van bestaande tools geleend zijn terwijl de combinatie dat niet is), omdat een enkelzijdige verbprefix-variant in de meting 23 keer afvuurde op gewone proza-tokens als `read_only`, `version_id` en elke C#-aanroep `CreateAsync(`.

## KBT-B547 — de credential-helper overleeft nu een plugin-upgrade

`.git/config` droeg een **versie-gepind** pad naar de helper:

```
credential.helper = !node ".../plugins/cache/kanbantic/.../2.14.0/scripts/kanbantic-git-credential-helper.js"
```

Zodra die versie uit de cache verdwijnt, breekt elke `git push` in die clone met `could not read Username` — een foutmelding die naar authenticatie wijst terwijl het probleem een pad is. De gedocumenteerde snippet pinde hem ook, dus elke clone die volgens het boekje was opgezet droeg dezelfde tijdbom.

Nu versieloos, via `${CLAUDE_PLUGIN_ROOT}`. Bestaande clones met een gepind pad moeten éénmalig opnieuw geconfigureerd worden.

## KBT-B546 — de git-identity-tests draaiden op jouw `~/.gitconfig`

Zes tests verwachtten een lege of gefixeerde git-identiteit en faalden dus op elk werkstation met een globaal ingestelde identiteit — wat elk werkstation is waar ooit een commit is gemaakt.

Ze lezen nu een **geïnjecteerde** configuratiebron in plaats van de echte globale config. Daarmee sluit dit de *bekende conditie* uit de v2.35.0-notes: die zes rode tests waren geen defect in het werk maar in de testopzet, en zijn nu groen op een werkstation waar ze dat nooit waren.

De les eromheen blijft staan: **vergelijk een rode test eerst tegen een schone baseline-worktree** voordat je hem aan je eigen wijziging toeschrijft.

## Verder in deze release

- **KBT-F622** — `issue-execute` Step 0 ververst de Toolkit-mirrors ook zelf. De SessionStart-hook uit v2.35.0 dekt het begin van een sessie; een langlopende sessie waarin de Toolkit ondertussen wijzigt, dekte hij niet.
- **KBT-F623** — de USE-KANBANTIC-kennis is naar de plugin verhuisd als referentiedocument met lane-wiring, in plaats van als losse kennis per werkstation.
- **KBT-B489 / KBT-B491** — de sync valideert de itemlijst **voordat** hij iets verwijdert. Een lege of mislukte fetch mocht niet langer als "alle items zijn weg" gelezen worden.
- **KBT-B540** — de gitignore-dekking wordt getoetst met `git` zelf in plaats van door letterlijk naar patronen te zoeken. Een `.gitignore` die het doel op een andere manier bereikt, is geen fout.

## Tests

Gemeten op hetzelfde werkstation, tegen tag `v2.35.0` en tegen deze release:

| | tests | geslaagd | **gefaald** | overgeslagen |
|---|---|---|---|---|
| `v2.35.0` | 428 | 418 | **6** | 4 |
| `v2.36.0` | 516 | 512 | **0** | 4 |

**+88 tests, en de zes rode zijn weg.** Die zes waren de git-identity-tests uit de *bekende conditie* van de vorige release — geen defect in het werk, maar in de testopzet (KBT-B546). Dat ze nu groen zijn ís de verificatie van die fix, op precies het soort werkstation waar ze faalden.

De vier overgeslagen tests zijn de bestaande sandbox-gated gevallen, onveranderd.

Zwaartepunt van de aanwas ligt bij **KBT-B560**: 19 nieuwe testgevallen over drie niveaus (unit, `lint-skills.js` als kindproces, en real-proxy E2E tegen een stub mét freeze-semantiek), waarvan er **14 aantoonbaar rood zijn tegen ongewijzigde `main`** — gemeten in een aparte worktree, conform KBT-B483. De vijf die groen blijven zijn dat om een verklaarbare reden: op `main` bestaat de nieuwe invariant nog niet, dus die controles zijn daar vacuous groen.

## Bekende conditie — de Version-registratie loopt nog achter

**KBT-B545** staat open: de Version-registratie van deze applicatie in Kanbantic liep ~19 minors achter op de repo. Zolang die drift bestaat, is `preview_next_version` voor deze applicatie **onbetrouwbaar** — hij rekent vanaf de laatst geregistreerde Version, niet vanaf wat er daadwerkelijk is uitgebracht.

Het versienummer van deze release is daarom met de hand geverifieerd tegen `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` en `package.json` op `main`, niet overgenomen uit een voorstel. Doe dat bij de volgende release opnieuw, tot KBT-B545 gesloten is.

Dat is precies het patroon waar deze hele release over gaat: een bron die gezaghebbend lijkt en het niet is.

## Bekende conditie — de tool-snapshot loopt vijf tools achter

`check-bundle-tool-drift.js` meldt bij deze release een **advisory** afwijking: de snapshot kent 219 tools, de live registry 228. De vijf die ontbreken zijn `delete_library_document`, `get_library_category`, `move_library_document`, `reorder_library_categories` en `reorder_library_documents`.

Bewust **niet** in deze release meegenomen: het hersynchroniseren van `known-mcp-tools.json` is eigen werk met een eigen risico, en het mengen daarvan in een release-PR maakt allebei moeilijker te beoordelen. De check is advisory en blokkeert niets; de MUST-HAVE-tools zijn alle drie aanwezig.

Wie dit oppakt: het regeneratiecommando staat in `plugin/scripts/known-mcp-tools.json` zelf.
