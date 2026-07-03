# Release Notes — v2.16.0 (KBT-F382)

Ships the **per-specialist run skills** with a shared lifecycle-core (KBT-F382) —
long-stranded on an unmerged feature branch (built 2026-06-15, never merged) and
now brought onto `main`.

## New skills — one per specialist

Four client-side run skills, each standardising the full run lifecycle for its
specialist on top of a single shared core:

- `plugin/skills/kanbantic-specialist-documentation/SKILL.md`
- `plugin/skills/kanbantic-specialist-project-manager/SKILL.md`
- `plugin/skills/kanbantic-specialist-security/SKILL.md`
- `plugin/skills/kanbantic-specialist-test-coverage/SKILL.md`

## Shared lifecycle-core

`plugin/skills/specialist-run-shared/lifecycle-core.md` — one place that defines
the run keten: resolve enabled workspace-specialist → `start_specialist_run` →
delegate analysis to the matching Subagent (KBT-SAGN003–006) → `add_finding` per
finding → deterministic health-score → `complete_specialist_run` (status New) →
review-handoff. Each skill refuses to run when its workspace-specialist is
disabled, and stops at `complete_specialist_run` (review stays a human gate).

## New commands

`plugin/commands/specialist-{documentation,project-manager,security,test-coverage}.md`
— thin invocable wrappers for the four skills.

## Note

These are the **client-side / agent-driven** run skills. They complement — and
partially overlap with — the server-side `SpecialistExecutionService` execution
path (KBT-E081) that also runs specialists autonomously.

Part of **v0.6.0 — Execution Hardening (KBT-INI032)**.
