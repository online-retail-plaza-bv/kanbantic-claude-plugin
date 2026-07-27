# Release v2.26.0

Kanbantic Claude Plugin en de skills geoptimaliseerd voor **Workflow v3**
(KBT-E108). Eerst een complete audit (F574), daarna drie fix-/uitbreidings-passes
(F575/F576/F577) over de vijf lane-skills — `kanbantic-issue-triage`,
`kanbantic-issue-prepare`, `kanbantic-issue-execute`, `kanbantic-issue-review`
en `kanbantic-orchestrate`.

## KBT-F574 — Audit (Fase 1, golf-barrière)
- Analyse-only, geen code. Leverde de gestructureerde bevindingen-inventaris
  (Library-doc `e108-audit--pluginskills-vs-workflow-v3-findings-inventory`) met
  **19 bevindingen AUD-01..AUD-19** verdeeld over vijf categorieën: (a) vocabulaire,
  (b) v3-werkwijze, (c) kennisborging, (d) verouderde/verwarrende teksten,
  (e) API/MCP-raakvlakken. De bevindingen bepaalden de scope van F575/F576/F577.

## KBT-F575 — Vocabulaire (AUD-01/02/03/04/05/06/08)
- Lane-naam **`Prepared` → `Ready`** in alle operationele skill-tekst (de
  historische `Prepared`-vermeldingen blijven enkel als rename-provenance-annotatie).
- Geen `Todo`-taakstatus meer (v3: `Ready`).
- **Blocked/OnHold** als side-states van InProgress, met verplichte reden (KBT-F561).
- Geen Task-direct-op-Epic: Epic → Phase → Features → Tasks (HARD-GATE in prepare
  verbiedt `create_user_story`/`create_test_case` op Epic-scope).
- Intake- + orchestrate-hand-off-prose op de live lane-namen.
- Guard: `plugin/tests/v3-vocabulary-alignment.test.js`.

## KBT-F576 — v3-werkwijze (AUD-09/10/11/12)
- **Model-selectie** — goedkoopste-capabele model per rol/taak, met de regel dat
  de reviewer-tier gelijk-of-zwaarder is dan de builder-tier (§5.6).
- **Twee-assen-parallellisme** (Agents + subagents) in alle vijf skills
  (prepare + triage waren de gaten).
- **Getrapte teststrategie T1/T2/T3** — T1 per task lokaal, T2 per feature lokaal,
  T3 volledige CI op de epic→main PR; execute scopet T3 expliciet out-of-scope,
  review is eigenaar.
- **Continue statusmelding** — de volledige call-tabel
  (claim/heartbeat/update_task_status/report_status) nu ook in prepare, triage en
  orchestrate.
- Guard: `plugin/tests/v3-werkwijze-alignment.test.js`.

## KBT-F577 — Kennisborging (AUD-13/14)
- Herbruikbare kennis gaat naar de **AI Toolkit van de workspace** (niet lokale
  memory), zodat andere agents/applicaties ervan profiteren (KBT-TRUL014).
- Verplichte **consistentie-check** vóór het schrijven van een Toolkit-item:
  eerst nagaan of het niet wordt tegengesproken door andere Toolkit-onderdelen;
  bij tegenspraak verzoenen (§5.7).
- Knowledge-recording-stap toegevoegd waar die ontbrak (triage, prepare, orchestrate).
- Guard: `plugin/tests/v3-kennisborging-alignment.test.js`.

## Buiten scope (aparte follow-up)
- Category-(e) MCP-bugs **AUD-15/16/17/19** raken de MCP/API-laag, niet de
  skill-teksten, en zijn bewust niet in deze release meegenomen.

## Tests
- Volledige suite: 251 pass / 4 skipped, plus de bekende pre-existing
  `git-credential-helper.test.js` env-leak-failure (niet gerelateerd aan E108).
- De drie nieuwe v3-alignment-guards zijn groen.

## Levering
Lockstep versie-bump 2.25.0 → 2.26.0 over `.claude-plugin/marketplace.json`,
`plugin/.claude-plugin/plugin.json` en `package.json` (version-sync-guard,
KBT-F454), zodat marketplace-consumenten de v3-geoptimaliseerde skills ophalen.
