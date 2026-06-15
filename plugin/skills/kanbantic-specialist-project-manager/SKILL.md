---
name: kanbantic-specialist-project-manager
description: "Run the Project Manager Specialist (SPEC004) against a Kanbantic workspace, release, issue, or application. Opens a specialist run, delegates the analysis to the project-manager-specialist subagent, records each finding, computes a deterministic health score, and completes the run at status New for human review. Does not auto-review or auto-convert findings."
user_invocable: true
command: specialist-project-manager
---

# Kanbantic Specialist Run — Project Manager

Thin wrapper around the shared specialist-run lifecycle. It runs the **Project Manager Specialist**.

**Announce at start:** "I'm using the kanbantic-specialist-project-manager skill to run the Project Manager Specialist."

## Identity (inputs to the shared core)

| Variable | Value |
|---|---|
| `SPECIALIST_CODE` | `SPEC004` |
| `SPECIALIST_NAME` | `Project Manager Specialist` |
| `SUBAGENT` | `project-manager-specialist` |
| `DEFAULT_SCOPE` | `Workspace` |

## What to do

1. Resolve the target `workspaceId` from the user's request (default to the active workspace). Resolve
   optional `scope` / `scopeEntityId`; if none given, use `DEFAULT_SCOPE`.
2. **Read and follow exactly** the shared lifecycle:
   `$CLAUDE_PLUGIN_ROOT/skills/specialist-run-shared/lifecycle-core.md`
   — using the Identity values above.

The shared core owns the full sequence: resolve enabled workspace specialist → `start_specialist_run`
→ delegate analysis to the subagent → `add_finding` per finding → deterministic health score →
`complete_specialist_run` (status New) → handoff. It also enforces the no-auto-review rule
(KBT-RL100) and the disabled-specialist refusal (KBT-RL101). Do not re-implement those here.
