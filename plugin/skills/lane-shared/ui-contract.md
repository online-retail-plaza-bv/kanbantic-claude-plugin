# UI-Contract — Shared Wireframe-Fidelity Core (KBT-F627)

This document is the **single canonical definition** of the UI-contract mechanism that enforces
wireframe-fidelity across the whole lane-flow. The four lane-skills (`kanbantic-issue-prepare`,
`kanbantic-issue-execute`, `kanbantic-issue-review`, `kanbantic-graduation`) are wrappers that keep
their own steps but follow the shared rules below. Do not duplicate this logic into the wrappers —
reference this file via `$CLAUDE_PLUGIN_ROOT/skills/lane-shared/ui-contract.md`.

Implements: KBT-F627. Bouwt voort op KBT-RL191 (fail-not-skip wireframe-gate), KBT-BD191
(slug/versie/pagina komen uitsluitend uit het `## Wireframe`-blok) en KBT-SR578
(`parseWireframeBlock`, `plugin/scripts/wireframe-block.js`).

## 1. Het UI-contract-formaat (Decision-entry)

Het UI-contract is een `Decision`-discussion-entry op het issue waarvan de content begint met:

```
## UI-contract (bevroren bij claim_issue — KBT-F627)
```

gevolgd door een **opsombare lijst per element-categorie**, afgeleid van de gepinde
wireframe-pagina('s) uit het `## Wireframe`-blok van het issue (exact de gepinde `versie` —
nooit "latest"):

| Element-categorie | Wat het contract vastlegt |
|---|---|
| **Knoppen + labels** | welke knoppen er zijn, hun exacte labels, primair/secundair |
| **Tabelkolommen + volgorde** | welke kolommen, in welke volgorde, met welke koppen |
| **Titels / breadcrumbs** | paginatitels, sectiekoppen, breadcrumb-pad |
| **Menu-plaatsing** | waar het scherm in de navigatie hangt (menu-item, groep, volgorde) |
| **States** | de zichtbare toestanden per pagina (empty/loading/error/filled, modals, toggles) |

Sjabloon voor de entry (het `add_discussion_entry`-codeblok staat in prepare 5F.3b):

```markdown
## UI-contract (bevroren bij claim_issue — KBT-F627)

### Knoppen + labels
- ...

### Tabelkolommen + volgorde
- ...

### Titels / breadcrumbs
- ...

### Menu-plaatsing
- ...

### States
- ...

_Bron: wireframe `<slug>` v<versie>, pagina('s): <pagina-id's> (uit het `## Wireframe`-blok)._
```

Het contract is **bevroren bij `claim_issue`** — net als de test-policy (Regel E / KBT-F442) wordt
het in prepare gedeclareerd en mag execute het niet mid-flight versoepelen.

## 2. Attachment-conventies

Beide attachment-sets worden toegevoegd via `add_issue_attachment` en zijn **afgeleiden** — de
states en de waarheid leven in het wireframe (en het eindresultaat in de app), niet in de PNG's:

- **Prepare — referentiecrops:** per gepinde pagina een Playwright-screenshot-crop van de
  wireframe-pagina op **1440px breedte**, benoemd:
  ```
  wf-<versie>-<pagina>-<state>.png      (bv. wf-v3-detail-empty.png)
  ```
- **Execute — resultaat-screenshots (bij de handoff):** Playwright-screenshots van het
  eindresultaat op **dezelfde uitsneden en breedtes** (1440px, zelfde pagina's/states), benoemd:
  ```
  result-<versie>-<pagina>-<state>.png  (bv. result-v3-detail-empty.png)
  ```

Zo kan de reviewer beide sets zij-aan-zij leggen (`list_issue_attachments` +
`download_issue_attachment`) zonder zelf een browser te hoeven starten.

## 3. Conformiteitsregels

- **Element-voor-element vergelijken.** Elk element uit het UI-contract (knoppen/labels,
  tabelkolommen + volgorde, titels/breadcrumbs, menu-plaatsing, states) is normatief: aanwezig,
  juist gelabeld, op de juiste plek. Pixel-spacing, fonts en exacte kleuren zijn vrij.
- **NOOIT pixel-diff.** Wireframe en app zijn per definitie nooit pixel-gelijk; een pixel-diff
  produceert alleen ruis. Conformiteit is een element-checklist, geen beeldvergelijking.
- **Afwijkingen expliciet melden.** Elke bewuste afwijking hoort onder het kopje
  `Afgeweken van het wireframe` in de handoff-entry van execute. Een afwijking die dáár niet
  gemeld is = **fix-vereist** (Critical in review). Een nieuw element dat niet in het wireframe
  staat wordt niet gebouwd maar gemeld (structure-faithful, KBT-RL191).

## 4. Opt-out

Het expliciete opt-out-blok in de issue-beschrijving:

```
## Wireframe — n.v.t. (geen UI)
```

stelt het issue vrij van het **hele** UI-contract-mechanisme: geen contract-entry, geen
attachments, geen conformiteitscheck. Afwezigheid van het blok op een niet-UI-issue is eveneens
vrijstelling, maar voeg bij twijfel de opt-out expliciet toe zodat afwezigheid een keuze is,
geen omissie (zelfde regel als prepare Step 5W).

## 5. Beleid hoort in de workspace (Toolkit-Rule)

**Mechaniek in de plugin, beleid in de workspace** (model: execute Step 0.7 pre-flight-checks;
KBT-B499 / KBT-BD202). Dit bestand definieert de mechaniek. *Welke* issues UI-plichtig zijn
(bv. "alle Features op applications met een SPA") en eventuele **extra eisen** (extra breedtes,
donker-thema-screenshots, toegankelijkheidschecks) declareert elke workspace zelf in een
**Toolkit-Rule-item**; de lane-skills lezen dat item via `list_toolkit_items(category: "Rule")`
in hun bestaande knowledge-load-stappen. Geen workspace-specifieke UI-eisen hardcoden in de
plugin of in deze include.
