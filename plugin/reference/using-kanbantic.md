# Kanbantic gebruiken — lessen die in élke workspace gelden

**Doelgroep-scheiding (KBT-F623 / KBT-TRUL014).** AI-kennis valt in twee soorten,
en ze horen op verschillende plekken:

| Soort | Wat | Waar |
|---|---|---|
| **USE-KANBANTIC** | Hoe je Kanbantic zelf *bedient*: MCP-tools, lane-workflow, readiness-gates | **De plugin** — dit document |
| **BUILD-APP** | Hoe je een specifieke app bouwt/deployt: deze API, dat frontend, die test-suite | De Toolkit van de betreffende workspace |

Dit document bevat uitsluitend **USE-KANBANTIC**-kennis. Die geldt in **elke
workspace** — AdminHub, ShopSentry, Kanbantic zelf — omdat het over het
gereedschap gaat, niet over het product.

**Twijfel je waar een nieuwe les hoort?** Stel de vraag: *zou een agent in een
andere workspace hier iets aan hebben?* Ja → USE-KANBANTIC, hierheen. Nee → het is
BUILD-APP en hoort in de workspace-Toolkit.

> **Dit bestand is een echte bron, geen pointer.** `kanbantic-workflow-v3.md`
> ernaast verwijst bewust naar een Library-document, omdat dat de bron-van-waarheid
> is. Dat kan hier niet: gotchas zijn **per-workspace data** die via
> `bootstrap_agent` alleen de eigen workspace bereiken. Een agent in AdminHub zou
> een pointer naar de Kanbantic-workspace niet kunnen volgen. Vandaar dat de
> inhoud hier staat (KBT-RL198).

**Onderhoud.** Wijzig een les hier, niet in een workspace-Toolkit. Twee kopieën
lopen gegarandeerd uit elkaar; dat is precies de drift die KBT-F623 opruimde.

---

## Inhoud per lane

| Lane | Lessen |
|---|---|
| **prepare** | [Spec-update vereist content](#spec-update-vereist-altijd-content) · [User story approven](#user-story-approven-vereist-een-passed-e2e-op-de-story-zelf) · [Alleen Epics krijgen een plan](#alleen-epics-kunnen-een-implementation-plan-hebben) · [Test-policy ↔ diversity](#test-policy-vs-testleveldiversity) |
| **execute** | [isReadyToClaim is afgeleid](#isreadytoclaim-is-afgeleid-nooit-zelf-zetten) · [Claim gaat via Ready](#claimen-kan-alleen-vanuit-ready-niet-vanuit-triaged) · [Worktree in een subagent](#enterworktree-werkt-niet-in-een-subagent) |
| **review** | [Gate-overzicht](#welke-gate-blokkeert-wat) · [InDeployment ≠ Done](#indeployment-is-niet-done) · [Self-approve werkt](#approve_review-checkt-alleen-dat-er-een-rij-bestaat) · [Merge-step worktree](#de-merge-step-heeft-een-eigen-worktree-nodig) |
| **specialists** | [De agent is de executor](#bij-een-specialist-run-ben-jij-de-executor) |
| **altijd** | [MCP-flakiness](#mcp-flakiness-retry-voor-je-concludeert) · [Deterministische 500's](#niet-elke-500-is-transiënt--sommige-zijn-deterministisch) · [GUID-only tools](#verschillende-entity-tools-accepteren-alleen-een-guid-geen-code) · [Stille drops](#twee-tools-laten-stil-vallen-wat-je-meegeeft) · [Deployer 503](#als-de-deployer-503-geeft) · [Partial update wist velden](#een-partial-update-kan-velden-wissen) · [Lege registry-sweep](#een-lege-registry-sweep-bewijst-niets) · [Tool-cache na deploy](#een-nieuwe-tool-verschijnt-pas-na-een-app-herstart) · [Groene CI dekt niet alles](#een-groene-ci-dekt-niet-alles--weet-wat-er-draait) |

---

## prepare

### Spec-update vereist altijd `content`

`update_specification` faalt met een **generieke** fout (*"An error occurred
invoking 'update_specification'"*) wanneer je alleen `id` + `title` + `status`
meestuurt — bijvoorbeeld om Draft → Ready te zetten. Het tool-schema noemt
`content` optioneel; in de praktijk is het bij een update verplicht.

**Doen:** geef bij élke `update_specification` de `content` mee (herhaal de
bestaande tekst als je die niet wijzigt).

### User story approven vereist een Passed E2E op de story zélf

`update_user_story(status: "Approved")` eist minstens één test case die aan de
**user story** hangt — niet aan het issue — met `testLevel: "E2E"` en
`status: "Passed"`. User stories en test cases worden onafhankelijk gekoppeld, en
een testcase aan het issue plakken telt niet mee.

**Herkenning:** de story blijft op Draft staan, of je krijgt een readiness-fout
over een ontbrekende E2E, terwijl je "die test toch hebt aangemaakt".

**Fix — link de bestaande testcase alsnog aan de story:**

```
update_test_case(testCaseId: <GUID>, userStoryId: <GUID>, issueId: <GUID>)
update_user_story(userStoryId: <GUID>, status: "Approved")
```

Geef `issueId` expliciet mee: de koppeling aan het issue moet blijven bestaan
naast die aan de story. Let op dat deze tools **alleen GUIDs** accepteren, geen
`KBT-XX###`-codes — zie de cross-cutting sectie hieronder.

Controleer met `get_user_story_with_requirements(id)`: die toont de gekoppelde
testcases, zodat je ziet of de E2E aan de story hangt en niet alleen aan het issue.

### Alleen Epics kunnen een Implementation Plan hebben

Alleen `IssueType.Epic` mag een Implementation Plan met Phases hebben; Features
en Bugs niet. `ImplementationPlanAppService.CreateAsync()` gooit
`Kanbantic:OnlyEpicsCanHavePlans`.

Voor een Feature of Bug maak je dus **taken zonder phases**. De
`RequireImplementationPlan`-gate hoort alleen voor Epics te gelden.

### Test-policy vs. TestLevelDiversity

Met `set_test_policy` zet je een testniveau bewust op `NotApplicable` (Regel E /
KBT-F442). De per-niveau-poort `TestPolicy_<niveau>` verdwijnt dan uit
`readinessChecks`.

**Sinds KBT-B512 honoreren óók de diversiteits- en pre-deploy-gates die policy:**
`AllPreDeployTestsPassed`, `PreDeployTestLevelDiversity` en de Done-gate
`TestLevelDiversity`. Een niveau op N.v.t. eist geen testcases meer; alleen
`Required`-niveaus (of niveaus zónder policy-rij) doen dat.

> ⚠️ **Draait de server waar jij tegen praat al B512?** Vóór die fix bleef een
> issue met N.v.t.-niveaus permanent op `Review` hangen, en de gate is
> **non-overridable** — er was geen ontsnapping. Herken je dat gedrag
> (`missing: Pre-deploy Tests Passed` terwijl je policy klopt), dan draait er een
> oudere server. De toenmalige workaround was een override-met-reden op de
> *wel* overridebare `TestLevelDiversity`; die is niet meer nodig zodra B512 live is.

**N.v.t. is geen vrijbrief voor rood.** Een `Failed` testcase op een N.v.t.-niveau
blokkeert nog steeds. De policy zegt "dit niveau is niet van toepassing", niet
"negeer mislukte tests".

**Praktisch:** `notApplicableReason` mag hoogstens **500 tekens** zijn. Daarboven
krijg je een nietszeggende HTTP 500 in plaats van een validatiefout (KBT-B497).
Zet de uitgebreide onderbouwing in een Discussion-entry.

---

## execute

### `isReadyToClaim` is afgeleid — nooit zelf zetten

`IssueDto.IsReadyToClaim` is geen zelfstandig veld meer maar strikt afgeleid:

```csharp
dto.IsReadyToClaim = (issue.Status == IssueStatus.Ready);
```

`update_issue` weigert het als input. Wil je een issue claimbaar maken, dan zet je
de **status** op `Ready` — het vlaggetje volgt vanzelf.

### Claimen kan alleen vanuit `Ready`, niet vanuit `Triaged`

`claim_issue` accepteert `New`, `Ready` (preferred) en is idempotent op
`InProgress` wanneer dezelfde principal opnieuw claimt. Een `Triaged`-issue wordt
geweigerd: eerst door de prepare-lane naar `Ready`.

> **Terminologie.** Deze lane heette `Prepared` en is in KBT-E103 hernoemd naar
> **`Ready`**. De oude naam wordt gedurende één overgangscyclus nog als *input*
> geaccepteerd (KBT-SR570), maar output gebruikt uitsluitend `Ready`. Kom je nog
> ergens "Prepared" tegen, dan is die tekst verouderd.

`claim_issue` zet atomair assignee + status + branch. Doe het **niet** met een
losse `update_issue_status(...) → InProgress`: die draait vóór de readiness-gate
en faalt hard op `MissingAssignee`.

**Bekende flakiness:** `claim_issue` zónder expliciete `versionId` geeft soms een
HTTP 500 uit de auto-version-resolutie (KBT-B443, nog open). Het is
**conditioneel** — dezelfde call slaagt vaak wél. Moet de call niet kunnen falen,
geef dan een expliciete `versionId` mee (`issue_version_lookup` → `versionId`).

### `EnterWorktree` werkt niet in een subagent

De `EnterWorktree`-tool weigert wanneer hij vanuit een Claude Code **subagent**
(Agent-tool-invocatie) wordt aangeroepen. Wil je parallelle subagents elk in een
eigen worktree, gebruik dan de `isolation: "worktree"`-optie van de Agent-tool
zelf in plaats van `EnterWorktree` binnen de subagent.

Vanuit de hoofdsessie werkt `EnterWorktree` wel — en dan alleen vanuit de
hoofd-checkout (eerst `ExitWorktree` als je al in een worktree zit).

**Wat er misgaat als je het negeert.** Zonder isolatie vallen parallelle subagents
terug op een gewone feature-branch in de **gedeelde** working tree. Een `git
checkout` door agent B wist dan de uncommitted wijzigingen van agent A — stil, en
zonder dat een van beiden het merkt. Waargenomen bij een batch van vier: tijdens
een `npm install` van vier minuten switchte een sibling de tree en verdween het
werk van schijf.

**Werkt ook, en soms nodig:** maak de worktree zelf aan, buiten de tool om.

```bash
git worktree add -b KBT-FXXX C:/GitHub/Kanbantic-KBT-FXXX origin/main
```

Dat geeft dezelfde isolatie zonder de cwd-guard, werkt wél vanuit een subagent, en
is de route wanneer een skill een specifieke branch-naam nodig heeft — de harness-
isolatie gebruikt een willekeurige naam. Werk je aan een feature die in een andere
repo leeft, doe de `worktree add` dan in díé repo.

**Brief de subagent** dat `EnterWorktree` gaat weigeren en wat het alternatief is.
Zonder die hint kost het hem een hele ronde om dat zelf te ontdekken.

---

## review

### Welke gate blokkeert wat

De readiness-gates valideren elke statusovergang. Twee soorten:

- **Objectief / non-overridable** — `AllTestsPassed`, `TestLevelDiversity`,
  `HasReviewApproval`, `PrMerged`, `PrCiGreen`, `PrApprovedByOther`,
  `AllPreDeployTestsPassed`. Hier helpt géén `overrideReason`; je moet het bewijs
  leveren.
- **Judgement / proces** — specs- en stories-Ready, `TestPolicy_*`. Die accepteren
  een `overrideReason`, die als Decision-entry wordt vastgelegd.

Sinds KBT-F471 is er ook een **InDeployment-instap-gate** met de non-overridable
`AllPreDeployTestsPassed`.

**Het enforcement-niveau bepaalt wat een override kan.** Dat staat los van de
gate-soort hierboven en verschilt per aanroeppad:

| Niveau | `update_issue_status` | `bulk_update_status` | `claim_issue` |
|---|---|---|---|
| **Hard** | blokkeert | blokkeert | blokkeert, tenzij `overrideReason` |
| **Soft** | blokkeert, tenzij `overrideReason` | blokkeert — géén per-issue override | blokkeert, tenzij `overrideReason` |
| **Off** | geen check | geen check | geen check |

Twee dingen die hieruit volgen en die je makkelijk mist: een bulk-update kent
**geen** override, ook niet onder Soft. En `TestCoverageEnforcement` staat
**apart** van `ReadinessGateEnforcement` — staat de eerste op Hard en de tweede op
Off, dan draaien de test-coverage-checks bij Review en Done gewoon door.

Een override wordt altijd als Decision-entry op het issue vastgelegd. Dat is geen
formaliteit maar het punt: de afweging blijft leesbaar voor wie er later naar kijkt.

### InDeployment is niet Done

De review-lane zet een issue na de merge op **`InDeployment`**, niet op `Done`.
`Done` is een aparte stap ná deploy-verificatie (staging + productie).

Dat onderscheid is er niet voor de vorm: een issue op `InDeployment` is gemerged
maar nog niet aantoonbaar draaiend. Zet het pas op `Done` als je dat geverifieerd
hebt. De Done-gate kijkt namelijk **niet** naar de deploy-status — handmatig
doorklikken slaagt technisch en holt precies het onderscheid uit dat de lane maakt.

**De Domain blokkeert twee uitwegen.** Vanaf `InDeployment` kun je niet terug naar
`InProgress` en niet naar `Cancelled`; beide geven
`Kanbantic:InvalidTransitionFromInDeployment`. Mislukt de deploy, ga dan eerst
terug naar **`Review`** en pak daar de fix-taken op — dat is de enige route terug.

### `approve_review` controleert de approver niet — leun daar niet op

De gate `HasReviewApproval` controleert of er minstens één `ReviewApproval`-rij
is — **niet** of de approver iemand anders is dan de assignee. Technisch kun je
je eigen werk dus door de poort duwen.

> ⚠️ **Doe dat niet.** Die poort bestaat om een tweede paar ogen te garanderen,
> en hij is niet voor niets non-overridable. Dat de controle ontbreekt is een
> **bug** — **KBT-B579** — geen ontwerpkeuze om te benutten. Zodra die gefixt is
> wordt een goedkeuring door de assignee geweigerd, en elke flow die op
> zelf-approven leunde loopt vast.
>
> Er is een tweede reden om voorzichtig te zijn: `approve_review` legt de
> goedkeuring vast onder de **aanroepende principal**. Registreert een agent de
> goedkeuring namens een mens, dan staat er in de audit-trail alsnog de agent —
> dezelfde die het werk deed. Laat een menselijke reviewer daarom bij voorkeur
> zelf goedkeuren via de UI.

Wanneer je hem tóch aanroept — bijvoorbeeld om een goedkeuring vast te leggen die
een mens expliciet heeft gegeven — vermeld dan in `reason` wie hem gaf en waarop:

```
approve_review(issueId, verdict: "Approved", reason: "<≥20 tekens>")
```

(Op GitHub-niveau kan een aparte review-eis gelden; dat staat hier los van. Het
PR-pad kent wél een echte controle — `PrApprovedByOther` vangt zelfs merge-door-de-
implementeerder af. Alleen dit legacy-pad mist hem.)

### De merge-step heeft een eigen worktree nodig

De review-lane doet `git checkout main && git merge --no-ff <feature>`. De
HARD-GATE eist dat dit vanuit een worktree gebeurt, maar de hoofd-clone heeft
`main` meestal al checked-out:

```
fatal: 'main' is already used by worktree at 'C:/GitHub/Kanbantic'
```

De feature-worktree kan het ook niet, want die houdt de feature-branch vast.
**Oplossing:** een tijdelijke worktree met detached HEAD voor de merge-stap.

```bash
git worktree add <pad>/_merge-<ISSUE> origin/main      # detached: claimt geen branch-naam
cd <pad>/_merge-<ISSUE>
git merge --no-ff origin/<feature-branch> -m "Merge <ISSUE>: <samenvatting>"
git push origin HEAD:main                              # fast-forward, want vertrokken vanaf origin/main
cd .. && git worktree remove <pad>/_merge-<ISSUE>
git push origin --delete <feature-branch>
```

Een detached HEAD claimt geen branch-naam, dus er is geen conflict met de
hoofd-clone. Die blijft op de oude commit staan tot de eigenaar zelf `git pull`
doet — geen synchronisatie nodig, en je verstoort geen lopend werk.

Niet nodig wanneer de hoofd-clone op een andere branch staat; dan kan de merge
gewoon in de feature-worktree.

---

## specialists

### Bij een specialist-run ben jíj de executor

Start je een specialist-run via MCP (`start_specialist_run`), dan **ben je al
Claude** en heb je alle tools die de specialist nodig heeft. Voer de analyse zelf
uit.

De backend-`SpecialistExecutionService` doet een aparte Claude-API-call en is
fragiel (API-key-config, HttpClient-timeouts, lange system prompts) — die faalt
regelmatig stil. Gebruik dat pad niet.

**De veelgemaakte fout:** `start_specialist_run` aanroepen en dan wachten tot de
run "vanzelf" compleet wordt. Dat gebeurt niet betrouwbaar. Jij voert hem uit:

1. `start_specialist_run(workspaceSpecialistId, scope, triggerType: "Mcp")` → `runId`
2. Lees de system prompt van de specialist, of volg de bekende auditstappen
3. Voer de checks uit met de tools die je al hebt — `list_library_documents` /
   `read_library_document`, `list_toolkit_items`, `list_issues` / `get_issue` /
   `list_test_cases`, `get_mcp_tool_registry`, plus directe code-toegang
4. `add_finding(runId, title, description, severity, category)` per bevinding
5. `complete_specialist_run(runId, summary, healthScore)`

De run blijft op `New` staan voor menselijke beoordeling; converteer bevindingen
niet zelf naar issues.

---

## Altijd — cross-cutting

### MCP-flakiness: retry vóór je concludeert

Er is een bekend cluster transiënte HTTP 500's op MCP-writes. Ze zien er identiek
uit aan echte fouten, en dát is de valkuil: je gaat een verklaring zoeken voor
iets dat gewoon een hik was.

**Doen:** retry één keer voordat je een 500 als inhoudelijk signaal behandelt.
Faalt het reproduceerbaar, dan pas een oorzaak zoeken. Twee waargenomen
voorbeelden waar dit misging: een "charset-probleem" dat een transiënte 500 bleek,
en een `create_specification` die tweemaal "changed by another user" gaf terwijl
gewoon opnieuw proberen volstond.

Voor grote payloads: veel tools accepteren `filePath` in plaats van inline
`content` — de proxy leest het bestand lokaal, wat zowel de 500's als je context
scheelt. Blijft een lange `add_discussion_entry` ook na een retry 500'en, dan is
`filePath` de betrouwbare uitweg.

**Gelijktijdigheid verergert het meetbaar.** Bij tien parallelle calls op dezelfde
parent-issue is de faalkans ~50%, tegen ~17% voor één losse call. Serialiseer
schrijfacties die dezelfde issue raken — dat lost het niet volledig op, maar
scheelt de meeste ruis.

### Niet elke 500 is transiënt — sommige zijn deterministisch

Dit is de duurste verwarring op dit oppervlak: een deterministische fout ziet er
identiek uit als een transiënte, en de "retry één keer"-regel kost je dan alleen
een tweede fout. Vuistregel: **één retry helpt → transiënt, klaar. Drie keer
dezelfde fout op hetzelfde doel → er is iets structureels.**

Bekende deterministische gevallen:

- **`update_issue(applicationId + VersionId)` in één call** faalt zolang het issue
  nog géén Application heeft. De scope-controle "hoort deze Version bij deze
  Application" leest de *bestaande* `ApplicationId` (nog `null`) in plaats van de
  waarde uit dezelfde payload. **Doen:** twee aparte calls — eerst de Application,
  dan de Version. Daarna werkt de gecombineerde vorm wel.
- **`update_specification` zonder `content`** — zie de prepare-sectie hierboven.

### Verschillende entity-tools accepteren alleen een GUID, geen code

Bijna elk tool in het register documenteert *"ID (GUID) or code"*. Deze doen dat
niet en weigeren een `KBT-XX###`-code:

`get_test_case` · `update_test_case` · `update_specification` · `update_user_story`

**Doen:** haal eerst de GUID op (`list_specifications` / `list_user_stories` /
`list_test_cases` / `get_issue(..., include:"testCases")`) en geef nooit de code mee.

Let op de misleidende faalvolgorde: de eerste poging kan een generieke HTTP 500
geven en pas de retry het duidelijke `"Invalid item ID"` — de transiënte 500 uit
de vorige sectie kan de echte oorzaak maskeren.

### Twee tools laten stil vallen wat je meegeeft

Allebei melden ze succes, en allebei kost het je later tijd omdat het resultaat
niet is wat je denkt:

- **`add_discussion_entry(entryType: "KnowledgeExtraction")`** wordt opgeslagen als
  `Comment`. De response zegt letterlijk *"Added Comment entry"*. Filter dus niet
  op `entryType` om zulke entries terug te vinden; schrijf de inhoud zo dat een
  lezer hem aan de kop herkent (`## Knowledge Trace — …`).
- **`create_user_story(specificationItemIds: "KBT-SR601,…")`** met **codes** linkt
  niets. De story wordt aangemaakt met `success: true` en `linkedSpecifications`
  blijft leeg — zonder waarschuwing. **Doen:** link expliciet ná het aanmaken met
  `link_specification_to_user_story` op **GUIDs**, en verifieer met
  `list_user_stories` dat de lijst gevuld is.

Dit is dezelfde silent-drop-klasse: een kale `Guid.TryParse` op een code faalt
zonder iets te zeggen. Kom je hem elders tegen, verwacht dan hetzelfde patroon.

### Als de deployer 503 geeft

Bij gelijktijdigheid antwoordt de deployer met HTTP 503 en `Retry-After: 60`.
Dat is geen storing maar een wachtrij van één. `gh run rerun <id> --failed` lost
het op, soms na één of twee pogingen.

### Een partial update kan velden wissen

Een MCP-tool of API-endpoint die maar een **deel** van een update-DTO doorstuurt,
wist stilzwijgend de velden die het niet meestuurt. Wie "even de titel bijwerkt"
verliest ongemerkt andere velden.

**Doen:** fetch-merge-write. Haal het huidige item op, pas aan wat je wilt
wijzigen, en stuur het geheel terug. Ga er niet vanuit dat weglaten "ongewijzigd
laten" betekent — tenzij het tool expliciet patch-semantiek documenteert.

De oorzaak is een AppService die onvoorwaardelijk `item.SetX(input.X)` doet:
PUT-semantiek. Een surface die `X` niet meestuurt levert `null` aan, en dat wist.
De Angular-UI heeft er geen last van omdat die de volledige DTO stuurt; alleen het
MCP- en partial-pad verliest data.

> **Nuance sinds 2026-08.** Kanbantic kent inmiddels echte patch-semantiek
> (`Patch<T>`) die "niet meegestuurd" van "expliciet leegmaken" onderscheidt, óók
> over de HTTP-grens. Een tijd lang was dat kapot: een weggelaten veld stak de
> grens als `null` over en werd aan de ontvangkant als *wissen* gelezen. Dat is
> gefixt en uitgerold. Waar een DTO `Patch<T>` gebruikt is weglaten dus veilig.
>
> Het advies hierboven blijft staan voor alles wat dat **niet** doet — tools die
> maar een deel van de DTO doorsturen zijn er nog steeds. En één les blijft in elk
> geval geldig: **werk nooit om een foutmelding heen door er extra velden bij te
> gooien tot de call slaagt.** Precies die reflex ontkoppelde vijf testcases van
> hun issue; de fout was echt, alleen de oorzaak lag ergens anders.

### Een lege registry-sweep bewijst niets

Je zoekt de MCP-registry af (`get_mcp_tool_registry`), vindt geen tool voor wat je
wilt, en concludeert dat de **capability** niet bestaat. Dat volgt niet.

Wat je hebt vastgesteld is dat er geen *tool met die naam* is — niet dat het niet
kan. De functionaliteit kan achter een ander toolnaam zitten, via een REST-endpoint
lopen, of in de UI zitten. Voor een agent ís MCP het hele oppervlak, dus een
capability die in Domain, Application, REST en de UI bestaat maar geen MCP-tool
heeft, is onzichtbaar en lijkt onbestaand.

**Drie goedkope checks in de repo, vóór je "bestaat niet" opschrijft:**

1. `Grep` op de entiteitsnaam die je zou verwachten (`<X>Ref`, `Issue<X>`,
   `<X>Link`) in de domeinlaag.
2. `Grep` op `Link|Unlink|Get.*Async` in de bijbehorende application-service.
3. `Grep` op de routes in de bijbehorende controller.

Plus `list_specifications(search: "<onderwerp>")` — een Approved spec die de
relatie beschrijft is een sterk signaal dat hij gebouwd is.

Bestaat het daar wél? Dan is de bug **"geen MCP-oppervlak"**: een dunne toollaag,
geen nieuw datamodel. Dat is een fundamenteel kleinere en veiligere fix — en dat
verschil bepaalt of je een middag of een week kwijt bent.

**Ook `get_system_schema` misleidt.** Een relatie die in een junctie-entiteit
leeft (bijvoorbeeld `IssueWireframeRef`) verschijnt niet als kolom op `Issue`.
Afwezigheid in het schema is dus evenmin bewijs.

Andersom geldt hetzelfde: de **clientlijst** van tools kan verouderd zijn terwijl
de server de tool wél heeft. Bevraag bij twijfel de live registry in plaats van de
lijst die je client toont.

### Een nieuwe tool verschijnt pas na een app-herstart

Na een MCP-server-deploy met een nieuwe tool verschijnt die soms niet in je
tool-lijst, terwijl de server hem wél aanbiedt in `tools/list`.

De plugin is een transparante stdio-proxy; de **client** cachet de tool-lijst per
MCP-verbinding. `/reload-plugins` herstart de skills maar niet altijd de
MCP-verbinding.

**Doen:** herstart de Claude-app volledig — helemaal sluiten en heropenen. Bij het
opstarten doet de proxy een verse `initialize` + `tools/list` en verschijnt de tool.
`/mcp` reconnect of `/reload-plugins` is niet genoeg gebleken.

**Diagnostische drieslag** — voordat je in de code gaat zoeken:

| Verdachte | Uitsluiten door |
|---|---|
| De plugin-repo | De proxy heeft geen tool-filter: geen allow-list, en `known-mcp-tools.json` zit niet in het runtime-pad (dat is een CI-driftcheck) |
| De code | Staat `[McpServerTool]` op de methode op `main` én draait de actieve container die image? Dan biedt de server hem aan |
| De runtime | Bevraag de **live** registry met `get_mcp_tool_registry`. Staat de tool daar wél en in jouw lijst niet, dan is het client-caching — deze gotcha |

Die volgorde scheelt echt tijd: de registry bevragen kost één call en sluit
meteen de twee dure verdachten uit.

---

### Een groene CI dekt niet alles — weet wat er draait

Voor je een PR opent: draai zelf wat CI niet draait. De verdeling verschuift, dus
controleer hem als het ertoe doet in plaats van hem te onthouden.

Wat op dit moment geldt in de Kanbantic-monorepo:

- **Unit-tests draaien wél** in CI op elke PR. Dat is een verandering: een tijdlang
  stonden ze uit omdat de suite te traag was, en in die periode zei een groene CI
  niets over je tests.
- **Integratietests draaien niet op een PR** tenzij het label `run-integration-tests`
  erop zit. Op `main` en 's nachts draaien ze wel. Schrijf je een integratietest,
  dan is CI-groen op je PR dus geen bewijs dat hij slaagt.
- **Formatting is een aparte, verplichte check** (`dotnet format whitespace` én
  `style`, plus `ng lint --max-warnings=0`). Die laat build en tests ongemoeid en
  valt dus pas in CI om.

De algemene les: een groene CI betekent "de checks die draaiden zijn geslaagd",
niet "alles is getest". Kijk welke jobs daadwerkelijk liepen voordat je conclusies
trekt uit het vinkje.

## Herkomst

Samengesteld in **KBT-F623** (F7 van KBT-E114) uit 17 gotchas van de
Kanbantic-workspace-Toolkit: GTCH005, 007, 008, 011, 020, 025, 026, 027, 037,
065, 071, 089, 091, 094, 099, 102, 105.

Bij het migreren is verouderde inhoud gecorrigeerd in plaats van overgenomen:
de `Prepared` → `Ready`-hernoeming (KBT-E103) en het policy-gedrag van de
test-gates ná KBT-B512.

Niet meegenomen: **GTCH051** (Karma-suite van de Kanbantic-frontend) — dat is
BUILD-APP-kennis en blijft in de workspace-Toolkit.

## Aanvulling KBT-T4030 (2026-08-10)

Vóór het verwijderen van de bronitems is per les nagegaan of dit document de
inhoud daadwerkelijk dekt, zoals KBT-RL198 punt 2 vereist. Dat leverde meer op dan
een vinkje: bij tien van de zeventien lessen ontbrak de *actionable* kern, en drie
teksten waren inmiddels onjuist. Toegevoegd of gecorrigeerd:

| Onderwerp | Wat er ontbrak of fout was |
|---|---|
| `approve_review` | Stond hier als *"je mag zelf approven"*. Dat is een bug (**KBT-B579**), geen ontwerpkeuze — herschreven naar een waarschuwing |
| Partial update | De onderbouwing klopte niet meer sinds `Patch<T>` bestaat en werkt; de les zelf blijft |
| CI-dekking | De aanname dat unit-tests niet in CI draaien is achterhaald; integratietests zijn nu het label-geval |
| MCP-flakiness | Vijf van de zes bekende gevallen ontbraken, waaronder het onderscheid transiënt/deterministisch |
| Registry-sweep | De drie concrete greps die de vraag beslissen |
| Tool-cache | De diagnostische drieslag om plugin en code uit te sluiten |
| Worktree in subagent | Wat er misgaat als je het negeert: stil verlies van uncommitted werk |
| Merge-step | De commando's |
| Specialist-run | Het vijfstappenrecept |
| InDeployment | Welke transities de Domain blokkeert, en dat Review de enige weg terug is |
| Gate-overzicht | De enforcement-matrix, inclusief dat bulk géén override kent |
| User story approven | De fix, niet alleen het symptoom |

Dat een migratie de omhaal weglaat is normaal. Dat ze de handeling weglaat is dat
niet — en dat was hier bij tien lessen het geval. Wie een volgende les hierheen
verplaatst: neem de stappen mee, niet alleen de conclusie.
