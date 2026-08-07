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
| **altijd** | [MCP-flakiness](#mcp-flakiness-retry-voor-je-concludeert) · [Partial update wist velden](#een-partial-update-kan-velden-wissen) · [Lege registry-sweep](#een-lege-registry-sweep-bewijst-niets) · [Tool-cache na deploy](#een-nieuwe-tool-verschijnt-pas-na-een-app-herstart) |

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

### InDeployment is niet Done

De review-lane zet een issue na de merge op **`InDeployment`**, niet op `Done`.
`Done` is een aparte stap ná deploy-verificatie (staging + productie).

Dat onderscheid is er niet voor de vorm: een issue op `InDeployment` is gemerged
maar nog niet aantoonbaar draaiend. Zet het pas op `Done` als je dat geverifieerd
hebt.

### `approve_review` checkt alleen dát er een rij bestaat

De gate `HasReviewApproval` controleert of er minstens één `ReviewApproval`-rij
is — **niet** of de approver iemand anders is dan de assignee. Voor een autonome
DoD-flow mag je dus zelf approven:

```
approve_review(issueId, verdict: "Approved", reason: "<≥20 tekens>")
```

Je hebt geen tweede principal nodig. (Op GitHub-niveau kan een aparte
review-eis gelden; dat staat hier los van.)

### De merge-step heeft een eigen worktree nodig

De review-lane doet `git checkout main && git merge --no-ff <feature>`. De
HARD-GATE eist dat dit vanuit een worktree gebeurt, maar de hoofd-clone heeft
`main` meestal al checked-out:

```
fatal: 'main' is already used by worktree at 'C:/GitHub/Kanbantic'
```

De feature-worktree kan het ook niet, want die houdt de feature-branch vast.
**Oplossing:** een tijdelijke worktree met detached HEAD voor de merge-stap.

---

## specialists

### Bij een specialist-run ben jíj de executor

Start je een specialist-run via MCP (`start_specialist_run`), dan **ben je al
Claude** en heb je alle tools die de specialist nodig heeft. Voer de analyse zelf
uit.

De backend-`SpecialistExecutionService` doet een aparte Claude-API-call en is
fragiel (API-key-config, HttpClient-timeouts, lange system prompts) — die faalt
regelmatig stil. Gebruik dat pad niet.

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
scheelt.

### Een partial update kan velden wissen

Een MCP-tool of API-endpoint die maar een **deel** van een update-DTO doorstuurt,
wist stilzwijgend de velden die het niet meestuurt. Wie "even de titel bijwerkt"
verliest ongemerkt andere velden.

**Doen:** fetch-merge-write. Haal het huidige item op, pas aan wat je wilt
wijzigen, en stuur het geheel terug. Ga er niet vanuit dat weglaten "ongewijzigd
laten" betekent — tenzij het tool expliciet patch-semantiek documenteert.

### Een lege registry-sweep bewijst niets

Je zoekt de MCP-registry af (`get_mcp_tool_registry`), vindt geen tool voor wat je
wilt, en concludeert dat de **capability** niet bestaat. Dat volgt niet.

Wat je hebt vastgesteld is dat er geen *tool met die naam* is — niet dat het niet
kan. De functionaliteit kan achter een ander toolnaam zitten, via een REST-endpoint
lopen, of in de UI zitten. Controleer minstens één alternatief kanaal voordat je
"kan niet" rapporteert.

Andersom geldt hetzelfde: de **clientlijst** van tools kan verouderd zijn terwijl
de server de tool wél heeft. Bevraag bij twijfel de live registry in plaats van de
lijst die je client toont.

### Een nieuwe tool verschijnt pas na een app-herstart

Na een MCP-server-deploy met een nieuwe tool verschijnt die soms niet in je
tool-lijst, terwijl de server hem wél aanbiedt in `tools/list`.

De plugin is een transparante stdio-proxy; de **client** cachet de tool-lijst per
MCP-verbinding. `/reload-plugins` herstart de skills maar niet altijd de
MCP-verbinding.

**Doen:** herstart de Claude-app volledig. Het ligt niet aan de plugin-code en
niet aan de registry.

---

## Herkomst

Samengesteld in **KBT-F623** (F7 van KBT-E114) uit 17 gotchas van de
Kanbantic-workspace-Toolkit: GTCH005, 007, 008, 011, 020, 025, 026, 027, 037,
065, 071, 089, 091, 094, 099, 102, 105.

Bij het migreren is verouderde inhoud gecorrigeerd in plaats van overgenomen:
de `Prepared` → `Ready`-hernoeming (KBT-E103) en het policy-gedrag van de
test-gates ná KBT-B512.

Niet meegenomen: **GTCH051** (Karma-suite van de Kanbantic-frontend) — dat is
BUILD-APP-kennis en blijft in de workspace-Toolkit.
