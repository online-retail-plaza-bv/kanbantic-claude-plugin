# Plugin v2.4.0 — Phase-of-Features-of-Tasks Epic shape (KBT-F250)

## What changed

Refactors the Epic Implementation Plan from **Phase → Tasks** (legacy) to **Phase → Features → Tasks** (new default). Each Feature now has its own audit-trail (status, specs, test cases, discussion-entries) instead of being administratively closed via `overrideReason` after its Tasks ship. The legacy shape continues to work without restructuring — `kanbantic-issue-execute` auto-detects per Phase which shape applies and walks accordingly.

### Why

During the AdminHub workspace's `ADM-INI002` (May 2026) all Features under the executed Epics had 0 Tasks because Tasks lived directly on Phase-level. Each Feature had to be administratively flipped to `Done` via `update_issue_status` with an `overrideReason` like *"implemented as part of parent Epic"*. That hides the actual capability-shipping moment, breaks audit, and conflicts with how Initiative → Epic → Feature → Task is used in Atlassian Jira / SAFe / Azure DevOps.

The new shape:

```
Initiative
└── Epic
      └── Implementation Plan
            ├── Phase 1 (groups Features)
            │     └── Feature → Tasks
            ├── Phase 2 (groups Features)
            │     └── Feature → Tasks
            └── ...
```

Roll-up: Tasks Done → Feature Done → Phase ReadyForReview → Phase Approved → Epic Review-ready.

## Skill updates

### `kanbantic-issue-prepare` — Step 5E rewritten

- New shape is the **default** for all v2.4.0+ Epics. Step 5E.6 designs Phases as groupings of Features (not Tasks); Step 5E.7 creates or assigns Features per Phase via `assign_feature_to_phase` / `assign_features_to_phase`; Step 5E.8 creates Tasks **on the Feature, not the Phase**.
- New "Foundation-Feature" recommendation: cross-cutting work (DI-wiring, DB-migrations, shared types) lives in a dedicated `<Epic-Code>-Foundation` Feature in Phase 1 — never as loose Tasks under a Phase in new-shape.
- HARD-GATE on `create_issue` relaxed for the Epic-route: prepare MAY mint child-Features within an Epic's already-defined scope. Outside that scope (unrelated new ideas), `create_issue` is still forbidden — point the user at the intake skills.
- Legacy-shape Epics keep working without restructuring; the new instructions only apply to v2.4.0+ Epics.

### `kanbantic-issue-execute` — Step 4A.0 added (auto-detection)

- New `Step 4A.0` auto-detects per Phase whether it's legacy (`Phase → Tasks direct`) or new (`Phase → Features → Tasks`) **without operator-input**, by combining `list_features_by_phase` and `list_tasks(phaseId)` results.
- Mixed-shape Phase (both directly-attached Tasks AND assigned Features) → STOP with actionable cleanup-error. Empty-shape Phase → STOP and redirect to prepare.
- New `Step 4A.2-new` flow walks Features per Phase: sub-claim each Feature with the Epic's branch, walk its Tasks, mark Feature Done, optionally invoke per-Feature mini-review.
- Legacy `Step 4A.2-legacy` flow preserved verbatim for backward compat.
- An Epic MAY mix legacy-shape Phases with new-shape Phases within the same plan, as long as no individual Phase is itself mixed.

### `kanbantic-issue-review` — three review levels (KBT-PR200)

- New `Step 1.5` review-level detection: `Feature` (child-Feature with `PhaseId != null` during Epic-walk) / `Phase` (`ReadyForReview` Phase, parent Epic on InProgress) / `Epic` (Epic on Review) / `Standalone` (Feature without PhaseId on Review) / `Bug` (Bug on Review).
- New `Step 1.6` per-level status HARD-GATE replaces the single-status legacy gate.
- Step 2 git-diff scope is per-level: Feature-level diff is scoped to the Feature's commits; Phase-level diff is scoped to the Phase; Epic / standalone / Bug diffs against main.
- Step 5 approve/reject branches per level: Feature-level uses `approve_review` + Feature → Done; Phase-level uses `approve_phase`; Epic-level continues with merge.
- Step 6 final-approve gate: Feature-level and Phase-level approvals always STOP (no merge); Epic / standalone / Bug levels proceed to merge as before.

## Backend (Kanbantic API) updates

These ship in tandem with the plugin and are required for the new flow:

- **`Issue.PhaseId Guid?`** — new nullable FK column on Issue, with `OnDelete.SetNull`, indexed. Domain-invariants: only Type==Feature may have PhaseId; Phase must belong to the same parent-Epic the Feature is a child of. EF migration: `Issue_PhaseId_ForFeaturePhaseAssignment`.
- **`assign_feature_to_phase(featureId, phaseId)`** — set `Issue.PhaseId`. Idempotent for same-phase re-assign.
- **`assign_features_to_phase(phaseId, featureIds[])`** — bulk variant, transactional (alle-of-niets).
- **`list_features_by_phase(phaseId)`** — list Features assigned to a Phase, sorted by Code.

All three exposed as MCP tools (`Kanbantic.Mcp/Tools/ImplementationPlanTools.cs`) and HTTP endpoints (`IssueController` PATCH/POST/GET via ABP convention).

## Backwards-compat

- **No data migration required.** `Issue.PhaseId` is nullable; existing Features stay at `null` and continue to roll up via the legacy Phase-of-Tasks model.
- **No breaking changes** for plugins, MCP consumers, or skill scripts that don't use the new tools.
- AdminHub's `ADM-INI001` / `ADM-INI002` (and any other workspaces with legacy Epics) keep working without restructuring. New Initiatives like AdminHub's `ADM-INI003` ship on the new shape from day one.

## Out of scope

- Multi-phase Features (one Feature with `PhaseId` set to multiple Phases) — single-Phase only for v1; split a Feature into multiple Features if it spans Phases.
- UI-rewrite of the Kanbantic-dashboard.
- Forced migration of legacy Epics.
- Auto-promotion of Feature → Done when all Tasks Done (skills handle that explicitly).

## References

- KBT-F250 — this Feature
- KBT-US532 — user story
- KBT-PR199 — Phase-of-Features-of-Tasks canonical shape
- KBT-PR200 — three-level review
- KBT-SR284 — `Issue.PhaseId` schema + invariants
- KBT-SR285 — three new MCP-tool API contracts
- KBT-RL057 — auto-detection rule (legacy / new / mixed / empty)
- KBT-BD080 — out-of-scope boundaries
- KBT-TC1818..1827 — test coverage (3 Unit, 3 Integration, 2 E2E)
