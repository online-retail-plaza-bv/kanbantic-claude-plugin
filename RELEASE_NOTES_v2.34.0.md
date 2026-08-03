# Release Notes — v2.34.0

**KBT-B513 + KBT-F627 — wireframe-getrouwheid door de hele lane-flow: UI-contract + gates + hook**

## Waarom

UI-features werden functioneel correct gebouwd maar weken structureel af van het wireframe: knoppen toegevoegd, menu-items aangepast, tabellen, teksten, titels en pagina's verzonnen. Het bestaande KBT-RL191-mechanisme (`## Wireframe`-blok + `wireframe-block.js` + execute 3d "structure-faithful") stopte bij "markup geladen" — daarna dwong niets in de lane-flow de getrouwheid nog af.

Twee oorzaken, twee issues:

- **KBT-B513 (Bug, High):** de harde wireframe-validatie van prepare (Step 5W) was **onbereikbare tekst** — alle drie de type-routes (5F.6/5B.7/5E.9) eindigden met "Go to Step 6." en niets verwees ooit naar 5W. De fail-not-skip gate van KBT-RL191 draaide in de praktijk dus nooit.
- **KBT-F627 (Feature, High):** ook mét een werkende 5W ontbrak de keten erná: geen opsombare UI-acceptatiecriteria, geen screenshot-bewijs, geen review-check, geen gate vóór de Review-transitie.

## Wat er verandert

**Routing-fix (KBT-B513).** Elke prepare-route passeert nu Step 5W vóór Step 6; 5W staat in de Checklist (4.5) en de allowed-writes bevatten `link_wireframe_to_issue` + `add_issue_attachment`. Vier mutatie-geverifieerde regressie-assertions pinnen de routing (KBT-TC3368) zodat een herstructurering de gate niet opnieuw stilletjes kan onterven.

**UI-contract-keten (KBT-F627), per lane:**

| Lane | Nieuw |
|---|---|
| **prepare** | `5F.3b: UI-contract` — opsombare UI-acceptatiecriteria als parseerbare `Decision`-entry (naar het test-policy-5F.5-patroon); Step 5W pint de wireframe-versie relationeel en attacht `wf-*`-referentiecrops (1440px, Playwright); 6a rapporteert `Wireframe pinned / UI-contract` |
| **execute** | `implementer-prompt.md` krijgt de bindende sectie `## Wireframe (gepinde versie)` + conformiteits-checklist + screenshot-bewijs in het Report Format; Step 6e maakt `result-*`-screenshots op dezelfde uitsneden; Step 7 HARD-GATE-voorwaarde 4: afwijkingskopje in de handoff-entry + `result-*`-attachments + conformiteitsbevestiging als entry met prefix `UI-UX review:` — anders geen Review-transitie |
| **review** | Step 1b laadt wireframe + UI-contract + beide attachment-sets; Step 2.5 draait een deterministische UI-pre-gate-scan (4 mechanische condities → automatisch Critical); `reviewer-prompt.md` krijgt de Wireframe Conformity Check met de niet-overridebare noot: ontbrekende conformiteit → **altijd REJECT** |
| **hook** | `pre-tool-use-ui-gate.js` (PreToolUse, matcher `mcp__.*__update_issue_status`): blokkeert de overgang naar `Review` wanneer de issue een gekoppeld wireframe heeft maar geen `UI-UX review:`-entry en geen `result-*`-attachments. Fail-open bij elk infra-falen; short-circuit voor niet-UI-issues (1 call i.p.v. 3) |

**Architectuur.** De gedeelde regels leven in één include, `plugin/skills/lane-shared/ui-contract.md` (precedent: `specialist-run-shared/lifecycle-core.md`); prepare, execute, review én graduation verwijzen ernaar. Beleid blijft workspace-declareerbaar (KBT-BD202, model Step 0.7 pre-flight-checks; KBT-B499-lijn): de plugin levert mechaniek, de workspace bepaalt via een Toolkit-Rule wat UI-plichtig is. Conformiteit is element-voor-element — **nooit pixel-diff** (wireframe en app zijn nooit pixel-gelijk).

## Reviewproces als bewijs

De eerste reviewronde REJECTte op een echte Critical: de hook telde álle attachments in plaats van alleen `result-*`, waardoor hij — met prepare's `wf-*`-crops al aanwezig — in zijn kernscenario nooit kon vuren, terwijl alle tests groen waren. De ontbrekende regressietest ("alleen `wf-*` ⇒ block") was precies het gat. Ronde 2 verifieerde de fixes met mutatie-tests. Specs: KBT-SR598, KBT-RL200, KBT-BD202; user story KBT-US816.

## Verificatie

- `node --test plugin/tests/*.test.js` → 387 tests, 383 pass, 0 fail, 4 pre-existente sandbox-skips (nieuw: `ui-contract.test.js` + `pre-tool-use-ui-gate.test.js`)
- `node plugin/scripts/lint-skills.js` → OK: all SKILL.md invariants pass
- PR's: [#50](https://github.com/online-retail-plaza-bv/kanbantic-claude-plugin/pull/50) (KBT-B513), [#51](https://github.com/online-retail-plaza-bv/kanbantic-claude-plugin/pull/51) (KBT-F627); CI groen op beide

## Lockstep

`package.json` / `.claude-plugin/marketplace.json` / `plugin/.claude-plugin/plugin.json` → **2.34.0**; tag `v2.34.0`.
