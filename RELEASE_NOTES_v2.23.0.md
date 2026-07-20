# Release v2.23.0

Workflow v3 — gap-closing tussen document, skills en statusmachine (KBT-INI044 / KBT-E110).
Kent aan élke eerder eigenaarloze statusovergang een benoemde eigenaar toe en verzoent de
lane-skills met het canonieke Workflow v3-document.

## KBT-F581 — wie claimt de Epic? (parallelle per-Feature-model)
- `kanbantic-orchestrate` claimt nu de **parent Epic** (`Ready → InProgress`) en maakt de
  epic-integratiebranch(es) aan **vóór** de fan-out naar child-Features (nieuwe Step 3.5).
- Enige carve-out op de "orchestrator muteert niet"-grens; zonder dit blijft de Epic op
  `Ready` staan en weigert `kanbantic-issue-review` Step 1.6 elke child-mini-review.

## KBT-F583 / KBT-F584 — epic-integratiebranch + merge-eigenaar
- `kanbantic-issue-review` Step 5a (Feature-approve) mergt de feature-branch nu naar de
  **epic-integratiebranch** (eigenaar = reviewer, met conflict-afhandeling), **niet** naar `main`.
- Step 7 verduidelijkt: de enige merge naar `main` is op Epic-niveau (de T3-CI-poort), en
  respecteert een beschermde `main` via een PR i.p.v. directe push.

## KBT-F587 — US/Spec-goedkeuring krijgt een eigenaar
- `kanbantic-issue-review` Step 5a keurt gelinkte User Stories + Specifications goed
  (`update_user_story` / `update_specification` → `Approved`) op de **normale route**, met de
  E2E-testvoorwaarde gekoppeld aan het test-policy `N.v.t.`-mechanisme (KBT-F591). Zo stapelen
  de `UserStoriesApproved` / `SpecificationsApproved`-gates niet langer stil op als overrides.

## KBT-F588 — multi-repo branch/PR-model
- `kanbantic-issue-review` Step 7 documenteert multi-repo Epics: één integratiebranch + PR
  **per geraakte repo**, allemaal met body `Closes KBT-Exxx`; Epic → `InDeployment` pas als
  álle PR's gemerged zijn. (Server-side repo-selectie-fix voor `register_issue_branch` op
  `applicationId` zit in de monorepo — Kanbantic API.)

## KBT-F582 — juiste PhaseStatus in README
- `plugin/README.md` roll-up-regel gebruikt de echte enum-waarde (`Review`, niet het
  niet-bestaande `ReadyForReview`).

## Nog niet in deze release (bewust)
- `known-mcp-tools.json` krijgt de nieuwe `get_test_policy` / `set_test_policy`-tools pas ná de
  monorepo-deploy (het bestand is een snapshot van de **live** MCP-registry). Zie KBT-F591.
- De canonieke Workflow v3-Library-doc (§0.1/§2.1/§5/§7) wordt via `update_library_document`
  bijgewerkt (live, geen PR) — KBT-F590 / KBT-F586.
