# Kanbantic Workflow v3 — canonieke werkwijze (pointer)

**"De Kanbantic Workflow" = het Library-document *"Kanbantic Workflow — Plan van Aanpak (v3)"***
in de Kanbantic-workspace (Developer Docs → How-to Guides, slug `kanbantic-workflow--plan-van-aanpak-v3`).
Dat document is de **bron-van-waarheid** (KBT-TRUL014). Dit bestand is bewust een **pointer**, geen kopie —
zo ontstaat er geen drift met de live Library-doc.

Lees het via de plugin-MCP:

```
read_library_document(document: "kanbantic-workflow--plan-van-aanpak-v3", workspaceId: "kanbantic")
```

## Kern

- Lane-workflow + parallelle multi-agent uitvoering, granulaire ~15-min tasks, getrapte tests (T1/T2/T3), golf = Phase.
- **§0.2 Statuslevenscyclus per entiteit** — Issue / Task / Phase / User Story / Test Case / Specification / Initiative:
  enum-waarden, **eigenaar + tool-call per status**, en de toegestane overgangen — geverifieerd tegen `get_system_schema`.
- **§0.3 Roll-up-matrix** — de **harde verticale roll-up** (KBT-E105): een parent kan niet vooruitlopen op zijn children
  (Feature/Bug←Tasks+Tests, Epic←Features, Initiative←Epics; child-gates zijn non-overridable).
- **§7.1 Multi-repo** — één epic-integratiebranch + één PR per geraakte repo (gedeelde `Closes KBT-Exxx`).

## Statusmodel v3 (live) — gebruik de echte enum-namen, niet een "mentale mapping"

- **E103:** Issue `Prepared→Ready`, Task `Todo→Ready`, Initiative `Active→InProgress`.
- **E104:** Issue `Blocked` / `OnHold`, Initiative `OnHold`, terugweg `Review→InProgress` (reject).
- **E105:** harde verticale roll-up.

## [OPEN] — nog niet live, volg de werkelijkheid (§0.2/§0.3)

- **Auto `InDeployment→Done` + parent auto-advance → KBT-F596.** De GateEvaluationService (KBT-E041) *is* Done en
  evalueert de gates, maar promoot geen status automatisch. In te plannen zodra KBT-INI044 live is.
- **`update_task_status`-tool** adverteert nog `Todo/InProgress/Done/Cancelled` (mist `Ready`/`Review`/`Blocked`) —
  volg de enum, niet de tool-omschrijving.
