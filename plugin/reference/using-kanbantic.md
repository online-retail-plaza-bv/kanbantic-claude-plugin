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
| **altijd** | [MCP-flakiness](#mcp-flakiness-retry-voor-je-concludeert) · [Deterministische 500's](#niet-elke-500-is-transiënt--sommige-zijn-deterministisch) · [GUID-only tools](#verschillende-entity-tools-accepteren-alleen-een-guid-geen-code) · [Stille drops](#twee-tools-laten-stil-vallen-wat-je-meegeeft) · [Deployer 503](#als-de-deployer-503-geeft) · [Weglaten is veilig](#weglaten-is-veilig--stuur-niet-meer-terug-dan-je-wilt-wijzigen) · [Lege registry-sweep](#een-lege-registry-sweep-bewijst-niets) · [Tool-cache na deploy](#een-nieuwe-tool-verschijnt-pas-na-een-app-herstart) · [Groene CI dekt niet alles](#een-groene-ci-dekt-niet-alles--weet-wat-er-draait) · [Hangdetectie-hooks](#hangdetectie-en-permissie-afhandeling-via-hooks-kbt-f741) |

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

### Weglaten is veilig — stuur niet meer terug dan je wilt wijzigen

**Doen:** stuur alleen de velden die je wilt wijzigen. Een veld dat je weglaat
blijft staan. Een veld dat je expliciet meestuurt als `null` — of als lege string,
waar de parameter een string is — wis je bewust.

**Niet doen:** fetch-merge-write. Het huidige item ophalen en integraal
terugsturen is sinds KBT-F626 niet alleen overbodig maar schadelijk: je
overschrijft er een gelijktijdige wijziging van iemand anders mee met de waarde
uit jouw eigen lees-actie. Dat is een lost update, en hij verloopt stil — er komt
geen conflict.

#### Waarom hier eerst het omgekeerde stond

Tot 2026-08 was `Update*Input` vol-vervangend: de AppService deed
onvoorwaardelijk `item.SetX(input.X)`, dus een surface die `X` niet meestuurde
leverde `null` aan en wiste het veld. De MCP-tools vingen dat op door alles wat je
niet noemde in te lezen en terug te echoën. Fetch-merge-write was toen het juiste
advies, en dit document gaf het.

KBT-F626 heeft de oorzaak weggenomen in plaats van het symptoom:

- Elke `Update*Input` draagt nu `Patch<T>`, dat "niet meegestuurd" van "expliciet
  leegmaken" onderscheidt — óók over de HTTP-grens, want daar zit het verschil.
- De read-then-merge in de MCP-tools is weg. Ze sturen door wat jij opgaf, niets
  meer.
- Een architectuurtest bewaakt het: een nieuw veld dat de twee niet kan
  onderscheiden laat de build vallen, met de naam van het type, het veld en de te
  nemen actie erbij.

#### Wat wél blijft gelden

**Collecties zijn vervangend, niet samenvoegend.** Stuur je `tagIds`,
`permissions` of een scorelijst mee, dan vervangt die de volledige set — een lege
lijst wist hem dus. Weglaten laat hem met rust. Dat is bedoeld gedrag, geen
uitzondering op het bovenstaande: je stuurt het veld immers mee.

**Wissen vraagt om een expliciet signaal.** Waar een MCP-parameter een string is,
kan een echte JSON-`null` niet worden onderscheiden van een weggelaten argument —
beide komen als `null` binnen. Daar geldt de lege string als wis-signaal. Zo haalt
`update_issue(VersionId: "")` een issue uit zijn Version; het weglaten van
`VersionId` laat hem staan. De tool-beschrijving zegt per parameter wat weglaten
en wat meesturen doet; lees die in plaats van te gokken.

**En de les die los staat van dit alles:** werk nooit om een foutmelding heen door
er extra velden bij te gooien tot de call slaagt. Precies die reflex ontkoppelde
vijf testcases van hun issue; de fout was echt, alleen de oorzaak lag ergens
anders.

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

### Hangdetectie en permissie-afhandeling via hooks (KBT-F741)

De plugin meldt via Claude Code-hooks aan Kanbantic wat een sessie op dit moment
doet, zodat een *hang* (wacht op een permissievraag, tool die nooit eindigt, stil
na een turn) te onderscheiden is van echt werk. De hooks praten rechtstreeks met
de REST-API (`X-Api-Key`), **niet** via de MCP-proxy: tijdens een permissievraag
is het model — en dus de proxy — niet aanspreekbaar.

| Event | Script | Meldt |
|---|---|---|
| `Notification` (`permission_prompt\|idle_prompt\|agent_needs_input`) | `notification-session-state.js` | `wait-for-user` met `[<type>] <titel>: <bericht>` (max 2000) |
| `PermissionRequest` | `permission-request-router.js` | allow-list-match → `allow` + tool-activity; anders eerst een `Permission`-beslisverzoek (KBT-F742, zie de sectie hierna) + `wait-for-user` `Permissieverzoek <code>`; mislukt dat → `wait-for-user` + kanaalbericht; **geen** beslissing |
| `PreToolUse` / `PostToolUse` | `tool-activity.js --pre` / `--post` | `tool-activity` `{toolName, toolUseId, startedAt}` / `{toolUseId, endedAt}` |
| `UserPromptSubmit` | `turn-start.js` | `turn-start` `{at}` |
| `Stop` | `stop-session-idle.js` | `heartbeat` `{status: Idle, summary (300, geredigeerd), activeBackgroundTasks}` |

Alle hooks zijn **fail-open**: geen sessiebestand, geen `KANBANTIC_API_KEY`,
netwerkfout, niet-2xx of 5 s time-out ⇒ exit 0 en lege stdout. Nooit een `deny`,
en bij een storing nooit een `allow`. `KANBANTIC_SYNC_DEBUG=1` schrijft de
skip-reden naar stderr (nooit de key, het sessiebestand of de payload). Vrije
tekst die de machine verlaat (commando's, notificatietekst, laatste
assistentbericht) wordt eerst geredigeerd: waarden van sleutels met
`token|secret|password|api[_-]?key|authorization|bearer` worden `***`, evenals
`Bearer <x>`, `--password=<x>` en `token=<x>` in tekst.

**De allow-list.** De workspace beheert hem als `Custom`-Toolkit-item met tag
`permission-allow`. Alleen het fenced codeblok met taal `allow` telt (tekst
eromheen is toelichting); lege regels en regels met `#` worden overgeslagen:

````
```allow
# MCP-tool-glob (alleen met servernaam; mcp__* is niet toegestaan)
mcp__kanbantic__*
# prefix-match op het getrimde commando
Bash(git status*)
# glob op file_path/filePath (ook Edit, Write, Glob, Grep)
Read(C:/GitHub/**)
# host van tool_input.url
WebFetch(domain:docs.anthropic.com)
```
````

Commentaar staat op een eigen regel; een `#` achter een regel hoort bij de regel
zelf en laat hem falen. Een `Bash`-regel zonder `*` is een exacte match. Pad-globs gebruiken `/`, `**`
(over mappen heen) en `*`; paden worden genormaliseerd (`\` → `/`, `..` weggewerkt)
en op Windows hoofdletterongevoelig vergeleken. Een samengesteld commando (`;`,
`&`, `|`, `` ` ``, `$(`, `<`, `>`, newline) valt nooit onder een prefix-regel.

**Wat nooit gaat** — als regel geweigerd *en* als commando, ook onder een bredere
regel (`Bash(git push*)` staat `git push --force` niet toe): `rm` met recursieve
vlag, `Remove-Item … -Recurse`, `rmdir`/`rd /s`, `del /s`, `git push --force`
(`-f`, `--force-with-lease`, `+refspec`), `git reset --hard`, `git clean -f…`,
`DROP `, `TRUNCATE `; verder `Bash(*)` / kale `Bash`, kale pad-tools en
pad-globs op de root (`/**`, `C:/**`, `*:/**`). Een lokaal memory-pad
(`memory-path.js`) krijgt nooit `allow`. Geweigerde regels meldt de
SessionStart-sync als `permission-allow-rejected: <regel>`.

**Waar de lijst staat.** `session-start-toolkit-sync.js` haalt het item op
(`list_toolkit_items`, `category: "Custom"`, `includeContent: true`, selectie op
tag) en schrijft `allowList` + `allowListFetchedAt` in het sessiebestand
(gemerged) **én** in `~/.claude-kanbantic-allowlist-<CLAUDE_CODE_SESSION_ID>.json`.
De dubbele plek is bewust: bij SessionStart bestaat het sessiebestand meestal nog
niet (de proxy schrijft het pas na `register_agent_session`) en de proxy
herschrijft het hele bestand bij elke `writeSessionFile()`. De router leest alleen
die cache — geen netwerk op het hete pad — en neemt de nieuwste van beide.

> **Valkuil.** `PermissionRequest` en `Notification(permission_prompt)` vuren
> allebei voor dezelfde vraag, en `PermissionRequest` heeft in de payload **geen
> `tool_use_id`**. De router haalt het id uit de bijbehorende `PreToolUse`
> (lokale scratch-state), anders een synthetische `<session_id>:<tool>:<ts>`.
> Het `timeout`-veld in `hooks.json` is volgens de Claude Code-docs in
> **seconden**; de bestaande hooks gebruiken `8000`/`20000` — de scripts begrenzen
> zichzelf (HTTP 5 s, stdin 3 s), dus de waarde is geen werkende bovengrens.

### Vraag een keuze met `request_decision`, niet met `wait_for_user` (KBT-F742)

Een vraag aan een mens **mét opties** is een beslisverzoek, geen vrije vraag.
`wait_for_user` blijft uitsluitend voor een vrije vraag zonder opties
(KBT-RL275 §5); een keuze, een akkoord of een permissie gaat via
`request_decision`, zodat hij met aanbeveling en onderbouwing in de Beslisbak
(en via Telegram/e-mail) bij de juiste rol landt. "Wat wil je?" zonder voorstel
weigert de API (`Kanbantic:DecisionRequest.RecommendationRequired` /
`.RationaleRequired`; minstens twee opties, `.OptionsRequired`).

| Situatie | Wat je gebruikt |
|---|---|
| Keuze tussen ≥ 2 opties, akkoord op een voorstel, informatie-besluit | `request_decision` (`kind`: `Choice` / `Approval` / `Information`) |
| Permissievraag van Claude Code (tool zonder allow-regel) | niets — de router maakt zelf een `Permission`-verzoek (hieronder) |
| Vrije vraag zonder opties ("hoe heet de klant?") | `wait_for_user` |

**Signature.** `request_decision(workspaceId, question, optionsJson,
recipientRole, recommendedOptionKey, rationale, kind?, issueId?, context?,
deadlineAt?, defaultOptionKey?, mandateRef?, priority?)` →
`{ success, decisionRequestId, code: "KBT-DR###", status, deadlineAt, inboxUrl }`.
`optionsJson` is een JSON-string van `[{ key, title, consequence, costOrRisk? }]`;
`recipientRole` is `ProductOwner | Developer | Designer | Tester | Operator`;
`issueId` accepteert GUID of code. `fromSessionId` hoef je niet mee te geven —
de proxy vult je eigen sessie in (zoals bij `send_message`). Een
`defaultOptionKey` (automatisch antwoord bij verlopen) kan alleen mét
`mandateRef`.

**Werkwijze.**

1. Post de vraag **niet** eerst in het kanaal: het verzoek ís de vraag.
2. `request_decision(...)` → noteer `code`.
3. `wait_for_user(sessionId, prompt: "Beslisverzoek <code>")` en beëindig je
   beurt (onbemand: KBT-TRUL041).
4. Het antwoord komt als `DecisionAnswer`-bericht in je **eigen** kanaal
   (`**Besluit op <code>** — … Gekozen: **<titel>** (<key>)`); de proxy zet
   `decisionRequestId`, `code`, `optionKey` en `via` in de meta van de
   notificatie, dus parsen hoeft niet. Het antwoord zet je sessie zelf weer op
   `Working` — geen `resume_working` nodig. Verloopt het verzoek zonder
   antwoord, dan komt een `DecisionExpired`-bericht en blijft de sessie
   `WaitingForInput`.
5. `list_decisions(workspaceId, status: "Open", onlyMine: true)` toont wat nog
   openstaat; `withdraw_decision(decisionRequestId, reason)` (≥ 10 tekens)
   trekt een achterhaalde vraag in. Andermans verzoek beantwoord je met
   `answer_decision(decisionRequestId, optionKey, note?)` — nooit je eigen
   (`.SelfAnswer`, 403), en afwijken van de aanbeveling vereist een notitie.

**Permissievragen gaan vanzelf.** Vraagt Claude Code om permissie voor een tool
die niet onder de allow-list valt, dan maakt `permission-request-router.js`
zelf een `Permission`-verzoek voor rol `Operator`:
`Permissie voor <tool_name>?`, context = de geredigeerde, ingekorte
tool-input (max 2000 tekens), opties `allow-once` (`y⏎`), `allow-always`
(`y⏎` + regel in het `permission-allow`-item) en `deny` (`n⏎`), aanbeveling
`allow-once`, deadline nu + `PERMISSION_DEADLINE_MINUTES` (env, standaard 120),
zonder standaardkeuze. `workspaceId` komt uit het sessiebestand (de proxy
schrijft het na `register_agent_session`) of uit `KANBANTIC_WORKSPACE_ID`;
`issueId` uit `currentIssueId` in het sessiebestand (`set_current_issue`).
De gekozen optie wordt als terminal-input naar de sessie gerelayed. Mislukt de
aanmaak (niet-2xx, 5 s time-out, geen workspace), dan geldt het oude pad:
`wait-for-user` `[permission] …` + kanaalbericht. Nooit `allow`.

### Overdracht uit het product (get_fleet_digest / get_fleet_overview) (KBT-F743)

Wat er gisteren gebeurd is en wie nu waarmee bezig is, staat in Kanbantic —
niet in een laptop-logboek, een chatgeschiedenis of je eigen geheugen. Twee
read-only tools (KBT-SR648) leveren de overdracht; ze vragen beide alleen
`workspaceId` (slug of GUID) en staan in `known-mcp-tools.json` en het
param-drift-contract.

| Tool | Geeft | Wanneer |
|---|---|---|
| `get_fleet_digest(workspaceId, window: "night" \| "day" \| "yesterday" \| "custom", from?, to?, format: "markdown" \| "json")` | `{ success, window: { kind, from, to, timeZone }, markdown?, digest?, errorMessage }` — secties *gemerged*, *gedeployed*, *besluiten* (onder mandaat apart gemarkeerd), *wacht op wie*, *stilstand*, *incidenten*; lege sectie = "— niets —" | Bij (her)start van een orchestrator-run (`kanbantic-orchestrate` Step 0), bij een hand-off tussen agents, en voor de PO die 's ochtends wil weten wat er 's nachts gebeurd is |
| `get_fleet_overview(workspaceId, onlyAttention?, role?, epicId?, maxResults?)` | `{ success, generatedAt, totals { working, silent, waitingForHuman, blocked, idle, total }, agents[], truncated }` — per agent `agentName`, `role`, `modelId`, `status`, `signal`, `signalReason`, `isAttention`, `currentIssueCode`, `lastToolName`, `lastToolActivityAt`, `waitingMinutes`, `openDecisions`, `health` | Vóór je een issue claimt (staat het al bij een werkende agent?), bij "wie wacht op wie", en als `list_agents` te mager is — `list_agents` blijft bestaan, `get_fleet_overview` is de verrijkte vorm |

**Lees de digest als bewijsstuk, niet als verhaal.** Elke regel draagt een
`evidence`-veld (PR-URL, deployment-code + sha, beslis-code, sessie-id). Een
"✅ gemerged" dat in het kanaal of op het issue staat maar níet in de digest,
is geen gemergede PR (KBT-RL276): controleer dan `get_issue` → `pullRequest`
voordat je erop voortbouwt. Omgekeerd: zet zelf geen afrondingsclaim op een
issue zonder de PR-URL of de deployment-code erbij, anders haalt de digest hem
niet op.

**Venster en tijdzone.** `night` = gisteren 19:00 tot vandaag 07:00, `day` =
vandaag 07:00–19:00, in de tijdzone van het gebruikersprofiel (val terug op
`Fleet:DefaultTimeZone`, standaard Europe/Amsterdam); een venster ligt nooit in
de toekomst. Een ongeldig venster geeft `Kanbantic:Fleet.InvalidWindow`; zonder
`Issues.View` + `AgentSessions.View` `Kanbantic:Fleet.Forbidden`. De digest is
rate-gelimiteerd (12/min per principal, 429): vraag hem één keer per (her)start,
niet in een lus.

**Het model dat je draait, meldt de proxy zelf.** Bij `register_agent_session`
voegt de proxy `modelId` toe uit `model` in Claude Code's `settings.json`
(volgorde: `$CLAUDE_CONFIG_DIR/settings.json` → `~/.claude/settings.json` →
`<cwd>/.claude/settings.local.json` → `<cwd>/.claude/settings.json` →
`ANTHROPIC_MODEL`); niets gevonden → geen `modelId` (de server zet dan
`ModelSource = Unknown`). Een `modelId` die je zelf meegeeft blijft staan. De
Vloot-pagina en `get_fleet_overview` tonen het als `modelId` / `modelSource`.

**Claude Code-paneel.** Op een laptop met Claude Code ≥ 2.1.287 toont de mod
`kanbantic-epic-pane` (`/epic KBT-E###`) dezelfde data als paneel naast de
chat: voortgang per status, feature-tabel met agent, laatste activiteit en
wachttijd (rood bij `isAttention` of wachttijd > `stillAfterMinutes`), "Wacht op
jou" met de open beslisverzoeken (knoppen roepen `answer_decision` aan) en de
vloot. Alles loopt via dezelfde MCP-proxy; op een `-p`-run of een door de
daemon gespawnde VM-sessie tekent de mod niets en start hij geen timer.

### Modelbeleid en preflight (KBT-F745)

Het model dat een agent mag draaien is geen afspraak in een briefing maar
beleid per workspace en per rol (`WorkspaceModelPolicy`, KBT-SR652): standaard
Orchestrator en Reviewer op Opus 5.5, Developer/Tester/Designer/Operator op
Sonnet 5.5, en **Fable voor geen enkele rol** — ook niet voor `Unspecified`
(KBT-RL277 §5). Lees het met `get_model_policy(workspaceId)` (read-only; een
schrijf-tool is er bewust niet — bewerken gaat via Instellingen → Modelbeleid,
alleen voor workspace-admins). De daemon start elke spawn met `--model`
volgens dat beleid; jij hoeft het model dus niet zelf te kiezen, wel de rol
mee te geven.

**Een sessie die `Blocked` staat met reden `model-policy: verwacht <X>,
gevonden <Y> (Settings|Transcript)`** is geen vastgelopen issue en geen
externe blokkade: de server heeft het model dat de sessie meldt (bij
`register_agent_session` uit `settings.json`, daarna elke minuut uit het
transcript door de daemon) vergeleken met het beleid voor de rol van de agent
en een afwijking gezien. Herstel is het model terugzetten — `model` in
`settings.json`/`settings.local.json` of `ANTHROPIC_MODEL` weghalen of op het
vereiste id zetten, of de sessie herstarten met `--model <vereist id>`. Zodra
een conform model gemeld wordt, zet de server de sessie **vanzelf** weer op
`Working` (de blokkade wordt alleen opgeheven als de reden met
`model-policy:` begint; een `Blocked` om een andere reden blijft staan). Roep
dus niet `resume_working` aan om eromheen te werken, en zet het issue niet
op `Blocked`/`OnHold` — het issue is niet geblokkeerd, de sessie is dat. De
bron tussen haakjes zegt waar het afwijkende id vandaan kwam: `Settings` is
een config-bestand, `Transcript` is het model waarmee de sessie daadwerkelijk
antwoordt.

**Een spawn die niet doorgaat** heeft de preflight (negen checks:
`trust-path`, `login`, `model-policy`, `claude-version`, `plugin`,
`credential-shim`, `disk`, `memory`, `single-daemon`; KBT-SR651) niet gehaald.
Eén `Fail` betekent geen proces, wél een leesbare reden op het SpawnCommand
(`preflight: <namen>`) en een **beslisverzoek in de Beslisbak** (KBT-F742,
kind `Operator`, opties `retry` en `cancel`, deadline 24 uur). `retry` kloont
het command als nieuw `Queued` Spawn met dezelfde cwd, briefing en rol —
zinvol als alleen `disk`/`memory` faalde en de hygiëne-run inmiddels ruimte
heeft gemaakt; `cancel` sluit het af. Een `Warn` (bijv. een afwijkende
`settings.json` die `--model` toch overschrijft, of een verouderde
pluginversie) laat de spawn doorgaan en staat alleen in de spawn-tabel van
het werkstation. Zoek dus niet naar een crash in de logs als een agent nooit
verschijnt: kijk in `list_decisions` naar het open verzoek en in de
Werkstations-pagina naar de gefaalde check.

**Worktrees.** Een gemergde issue-branch laat de review-skill zelf opruimen
(`scripts/remove-issue-worktree.js`, Step 7); de daemon ruimt 's nachts
alleen worktrees op van issues die `Done`/`Cancelled` zijn en zonder
uncommitted wijzigingen (KBT-SR653). Een worktree van een open issue blijft
staan — ook als het werkstation onder de schijfdrempel van 20 GB zit; dan
weigert de preflight nieuwe spawns tot er ruimte is, en staat er een
`disk-low`-waarschuwing op het bord.

### Accountpool (KBT-F753)

Een workspace kan meerdere Claude-abonnementsaccounts in een pool hebben die
dynamisch aan werkstations en agents worden toegewezen. Bij een usage-limit op
één account herstart Kanbantic de getroffen agent automatisch op een ander
ingelogd account met ruimte; is er geen, dan staat er een beslisverzoek in de
Beslisbak (uitkomst `DecisionRequested`). Een agent hoeft dus nooit zelf een
account te kiezen of zichzelf te herstarten.

Lees de stand met `get_account_pool` (read-only; geen verplichte parameters,
optioneel `workspaceId` — alleen mét `workspaceId` komen `policy` en
`recentEvents` van die workspace mee; zonder ontbreken ze). Het
antwoord is `{ accounts, assignments, loginStatus, policy?, recentEvents }`:
`accounts` zijn de poolaccounts met hun limietstatus, `assignments` welk
werkstation/agent op welk account draait, `loginStatus` per account en
werkstation of er een geldige login is, `policy` (alleen bij een
`workspaceId`) de balanceringsregels en `recentEvents` de laatste
balanceringsgebeurtenissen (herplaatsing, limiet bereikt, `DecisionRequested`).

**Wat dit voor de lokale sessie betekent.** De daemon start elke spawn met
`CLAUDE_CONFIG_DIR` op de configuratiemap van het toegewezen account. De
MCP-proxy respecteert die variabele al voor `settings.json` (zie de
volgorde onder "Het model dat je draait, meldt de proxy zelf"), dus het
model-id en de rest van de instellingen komen uit de map van dat account. De
sessie-administratie (transcripts, projecten, geschiedenis) blijft daarentegen
in `~/.claude`: wissel van account verandert dus niet waar je sessies terug te
vinden zijn, en een herstart op een ander account kan dezelfde sessie hervatten.

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
