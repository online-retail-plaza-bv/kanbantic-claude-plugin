# Release v2.24.0

Workflow v3 canoniek in de plugin (KBT-INI044 / KBT-E106 · F592/F593).

## KBT-E106 — expliciete verwijzing + geverifieerde referentie
- **Lane-skills verwijzen naar "Kanbantic Workflow v3".** `kanbantic-orchestrate`, `kanbantic-issue-execute` en
  `kanbantic-issue-review` krijgen een canonieke-werkwijze-pointer naar het Library-document
  *"Kanbantic Workflow — Plan van Aanpak (v3)"* (§0.2 statuslevenscyclus / §0.3 roll-up / §7.1 multi-repo),
  met de nadruk: gebruik de **echte enum-namen** (`Ready`/`Blocked`/`OnHold`/…), geen "mentale mapping".
- **Nieuw referentie-bestand** `plugin/reference/kanbantic-workflow-v3.md` — een **pointer** (geen kopie) naar de
  live Library-doc, plus de kern + de `[OPEN]`-punten (KBT-F596 auto-advance; `update_task_status`-tool-drift).

## Geleverd via de live Library-doc + ClaudeMd (geen PR — MCP)
Het zwaartepunt van E106 (F592/F593) staat live in de canonieke bron:
- **§0.2 Statuslevenscyclus per entiteit** — Issue/Task/Phase/UserStory/TestCase/Specification/Initiative:
  enum-waarden, eigenaar + tool-call per status, overgangen — geverifieerd tegen `get_system_schema`.
- **§0.3 Roll-up-matrix** — de harde verticale roll-up (KBT-E105).
- **§0.1** herschreven naar echte enums (KBT-F590), **§2.1** Epic-DoD-E2E-attachment (KBT-F586),
  **§0.4** v4-reconciliatie (KBT-F593).
- **ClaudeMd (KBT-CLMD001)** bijgewerkt: lane-flow → `Ready`+`Blocked/OnHold`+`Review→InProgress`, harde roll-up,
  Task-flow → `Ready`, pointer naar §0.2/§0.3, en de agent-merge-recipe (credential-helper-PAT + Actions-API).

## Bevindingen (eerlijk gemarkeerd als [OPEN])
- **KBT-F596** aangemaakt: auto `InDeployment→Done` + parent auto-advance bovenop de GateEvaluationService
  (KBT-E041 is Done, maar promoot geen status automatisch). In te plannen zodra KBT-INI044 live is.
- `update_task_status`-MCP-tool loopt achter op de `TaskStatus`-enum (mist `Ready`/`Review`/`Blocked`).
