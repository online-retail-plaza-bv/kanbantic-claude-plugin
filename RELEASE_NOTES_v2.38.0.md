# Release Notes — v2.38.0

**KBT-T4030 — het referentiedoc dekt de lessen die het vervangt** · **KBT-B585 — de versheidscheck weigert wat hij niet kan beantwoorden**

## Waarom deze release ertoe doet voor wie de plugin gebruikt

De grootste wijziging zit niet in code maar in `plugin/reference/using-kanbantic.md` — het document dat elke agent in élke workspace als USE-KANBANTIC-bron krijgt. Het is van ~12.700 naar ~28.000 tekens gegroeid, en drie passages die er stonden waren inmiddels **onjuist**. Wie op de vorige versie leunde, leunde op minstens één instructie die hem in de problemen bracht.

---

## KBT-T4030 — de migratie liet de handeling weg

KBT-F623 verplaatste zeventien USE-KANBANTIC-gotchas uit de Kanbantic-workspace-Toolkit naar dit referentiedoc, zodat ze ook AdminHub- en ShopSentry-agents bereiken. **KBT-RL198 punt 2** eist dat je vóór het verwijderen van een bronitem verifieert dat de plugin-versie de volledige inhoud bevat. Die verificatie is nu per les uitgevoerd, en dat was geen formaliteit.

De bronnen zijn samen ~48.200 tekens, het doc was er ~12.700. Een deel van dat verschil is terechte compressie. Maar bij **tien van de zeventien** lessen ontbrak niet de omhaal — het ontbrak de **handeling**:

| Les | Het doc had | Het doc miste |
|---|---|---|
| Merge-step | "gebruik een detached-HEAD worktree" | de commando's |
| Specialist-run | "voer de analyse zelf uit" | de vijf stappen |
| Registry-sweep | "controleer een alternatief kanaal" | wélke checks |
| User story approven | het symptoom | de fix |
| Worktree in subagent | "gebruik `isolation: worktree`" | wat er misgaat als je dat niet doet |
| Tool-cache | "herstart de app" | hoe je plugin en code uitsluit |
| InDeployment | het onderscheid met Done | welke transities de Domain blokkeert |
| Gate-overzicht | overridable vs objectief | de enforcement-matrix |
| MCP-flakiness | één van de zes gevallen | de andere vijf |
| Deployer-503 | — | alles |

Een conclusie zonder stappen leest als kennis en gedraagt zich als een hint. Wie een volgende les hierheen verplaatst: neem de handeling mee.

### Drie teksten waren onjuist geworden

**`approve_review`.** Het doc instrueerde: *"Voor een autonome DoD-flow mag je dus zelf approven. Je hebt geen tweede principal nodig."* Dat is feitelijk waar en precies daarom een probleem — het is het gat dat als **KBT-B579** is vastgelegd om te dichten. De poort `HasReviewApproval` is niet voor niets non-overridable; hij hoort een tweede paar ogen te garanderen. Zodra B579 landt wordt een goedkeuring door de assignee geweigerd en loopt elke flow die hierop bouwde vast.

Herschreven naar een waarschuwing, met een tweede punt erbij dat evenmin ergens stond: `approve_review` legt de goedkeuring vast onder de **aanroepende** principal. Registreert een agent er een namens een mens, dan staat er in de audit-trail alsnog die agent — dezelfde die het werk deed. Laat een menselijke reviewer daarom bij voorkeur zelf goedkeuren via de UI.

**Partial updates.** De les ("een tool die maar een deel van de DTO doorstuurt wist de rest") klopt nog, de onderbouwing niet. `Patch<T>` bestaat inmiddels en onderscheidt "niet meegestuurd" van "expliciet leegmaken", óók over de HTTP-grens — een tijd lang was juist dát kapot en werd een weggelaten veld als *wissen* gelezen. Toegevoegd is de waarschuwing die deze release aanleiding gaf: **werk nooit om een foutmelding heen door er velden bij te gooien tot de call slaagt.** Precies die reflex ontkoppelde vijf testcases van hun issue; de fout was echt, alleen de oorzaak lag elders.

**CI-dekking.** De aanname dat unit-tests niet in CI draaien is achterhaald. Ze draaien wél op elke PR; integratietests zijn nu het label-geval (`run-integration-tests`). De algemene les staat er nu bij: een groene CI betekent "de checks die draaiden zijn geslaagd", niet "alles is getest".

### De MCP-flakiness-sectie dekte één van zes gevallen

Toegevoegd:

- **Transiënt versus deterministisch.** Ze zien er identiek uit, en de "retry één keer"-regel kost je bij een deterministische fout alleen een tweede fout. Met het concrete geval: `update_issue(applicationId + VersionId)` in één call faalt zolang het issue nog geen Application heeft — splitsen is de fix, retryen niet.
- **GUID-only tools.** `get_test_case`, `update_test_case`, `update_specification` en `update_user_story` weigeren een `KBT-XX###`-code, terwijl bijna elk ander tool *"ID (GUID) or code"* documenteert. De eerste poging kan bovendien een generieke 500 geven en pas de retry het duidelijke `"Invalid item ID"`.
- **Twee stille drops.** `add_discussion_entry(entryType: "KnowledgeExtraction")` wordt opgeslagen als `Comment`; `create_user_story(specificationItemIds: <codes>)` linkt niets. Allebei met `success: true`.
- **Gelijktijdigheid verergert het meetbaar** — ~50% faalkans bij tien parallelle calls op dezelfde parent-issue, tegen ~17% los.
- **Deployer-503** met `Retry-After: 60`, en dat `gh run rerun --failed` de route is.

---

## KBT-B585 — de versheidscheck antwoordt niet meer uit de verkeerde lijn

`detect-release-bump.js` beantwoordt in Step 8.5a van `kanbantic-issue-review` de vraag *"heeft deze merge een versie uitgebracht?"*. Twee gaten uit de KBT-B545-review zijn nu gedicht:

- Een lokale `main` die is **afgeweken** van `origin/main` werd wél beantwoord — uit een lijn die niet die van upstream is. De check gebruikte `merge-base --is-ancestor`, wat alleen strikt achterlopen vangt. Divergentie is onbeantwoordbaar en wordt nu als zodanig geweigerd.
- Een **fast-forward-merge** waar de bump een of meer commits terug ligt gaf stil `released: false`. Dat ligt buiten het door Step 7 voorgeschreven `--no-ff`-pad, maar een stil verkeerd antwoord is erger dan een weigering.

Een niet-nul exit betekent nog steeds "kan het niet bepalen" en mag nooit als "geen release" gelezen worden.

---

## Upgrade

```
claude plugin install kanbantic-claude-plugin
```

Geen breaking changes. Het referentiedoc wordt bij de volgende sessiestart geladen; een lopende sessie ziet de nieuwe inhoud pas na een herstart van de Claude-app — zoals het doc zelf beschrijft.
