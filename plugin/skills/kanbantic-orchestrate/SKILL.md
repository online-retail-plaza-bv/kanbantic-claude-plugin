---
name: kanbantic-orchestrate
description: "Orchestration/sequencer skill (KBT-F436) — NOT a lane-skill. Given {workspace, initiative, repos}, decides WHICH issues to pick up (by initiative + priority), in WHICH order, and drives each one through the lane-skills (triage → prepare → execute → review) with explicit hand-offs. Owns sequencing only — it does NOT re-implement claim, per-phase push, or merge; those stay in kanbantic-issue-execute / kanbantic-issue-review."
user_invocable: true
command: kanbantic-orchestrate
---

# Kanbantic Orchestrate

## Parameters

This skill is parameterized. Resolve these three inputs first — from the
slash-command arguments, the launch-script (`launch-orchestrator.ps1`, KBT-F438),
or by asking the operator:

| Parameter | Required | Meaning |
|---|---|---|
| `workspace` | **yes** | Workspace slug (e.g. `kanbantic`). Scopes every MCP query. |
| `initiative` | **yes** | Initiative code or id (e.g. `KBT-INI033`). The orchestrator only picks up issues that roll up to this initiative. |
| `repos` | optional | One or more repository slugs/ids the work targets. When omitted, the lane-skills resolve the repo per-issue from `applicationId` (see `kanbantic-issue-execute` Step 0). Pass it to constrain a run to a subset of repos. |

If `workspace` or `initiative` is missing, STOP and ask — never guess the scope.

## Overview

`kanbantic-orchestrate` is the **top-of-funnel sequencer** for autonomous,
multi-issue runs. It answers three questions and nothing else:

1. **Which** issues in this initiative are actionable right now?
2. **In what order** should they be processed (priority + dependency + lane)?
3. **Which lane-skill** does each issue need next, and how is control handed off?

**Announce at start:** "I'm using the kanbantic-orchestrate skill to sequence work for `<initiative>`."

It is deliberately **thin**. Everything below the sequencing layer — claiming an
issue, per-phase push, test gates, merge, status transitions — is owned by the
lane-skills and is NOT duplicated here (see [Boundary](#boundary--what-this-skill-does-not-do)).

## Scope

- Reads the initiative's issue set, filters to actionable issues, orders them.
- For each issue, determines the **next lane** from its `status` and invokes the
  matching lane-skill, then waits for that skill's hand-off before moving on.
- Records a short orchestration log (Comment discussion-entries) so the run is auditable.

It does **not**:
- Mutate issue status directly (the lane-skills own every transition).
- Claim issues, push branches, run tests, or merge — all lane-skill responsibilities.
- Create issues, specs, user stories, or implementation plans.

## Lane routing table

The orchestrator maps each issue's current `status` to the lane-skill that owns
its next transition. This mirrors the Skill ↔ Lane table in `plugin/README.md`.

| Issue `status` | Next lane-skill | Hand-off back to orchestrator when |
|---|---|---|
| `New` | `kanbantic-issue-triage` | issue reaches `Triaged` (go) or `Cancelled` (no-go) |
| `Triaged` | `kanbantic-issue-prepare` | issue reaches `Prepared` |
| `Prepared` | `kanbantic-issue-execute` | issue reaches `Review` |
| `InProgress` | `kanbantic-issue-execute` (resume) | issue reaches `Review` |
| `Review` | `kanbantic-issue-review` | issue reaches `InDeployment` (or back to `InProgress` on reject) |
| `InDeployment` / `Done` / `Cancelled` | — (terminal for this run) | skip |

A single issue may traverse several lanes in one orchestration pass: triage →
prepare → execute → review. The orchestrator re-reads `status` after each
lane-skill returns and routes again until the issue is terminal for this run or
the lane-skill reports a blocker.

## Checklist

1. **Resolve parameters** — `{workspace, initiative, repos}` (HARD GATE on workspace + initiative).
2. **Load knowledge** — call `bootstrap_agent` / `get_context` so ClaudeMd + patterns are in context (the lane-skills assume this).
3. **Select issues** — list the initiative's issues, filter to actionable, order by priority + lane.
4. **Sequence** — for each issue, route to the next lane-skill, wait for hand-off, re-route until terminal.
5. **Log** — record a Comment per issue-completion and a run-summary at the end.

## Step 1: Resolve parameters

Bind `{workspace, initiative, repos}` as described in [Parameters](#parameters).
HARD GATE: stop if `workspace` or `initiative` is unresolved.

## Step 2: Load workspace knowledge

The lane-skills assume project knowledge (ClaudeMd, patterns, rules) is already
loaded. Prime it once at the top so every downstream lane benefits:

```
MCP: mcp__kanbantic__bootstrap_agent(workspace)          // or get_context(...)
```

Do not re-implement the per-skill knowledge loads — just ensure the context exists.

## Step 3: Select + order issues

```
MCP: mcp__kanbantic__list_issues(workspaceId, initiativeId: <initiative>)
```

Filter to **actionable** issues:

- Keep issues whose `status` is `New`, `Triaged`, `Prepared`, `InProgress`, or `Review`.
- Drop `InDeployment`, `Done`, and `Cancelled` (terminal — nothing to sequence).
- When `repos` is set, keep only issues whose `applicationId` maps to one of those repos.

Order the survivors:

1. **Priority** first — `Critical` → `High` → `Medium` → `Low`.
2. Within a priority, **issues already in flight** (`InProgress`, `Review`) before fresh ones (`Prepared`, `Triaged`, `New`) — finish what is started before opening new work.
3. Respect declared dependencies — if issue B lists A as a blocker, process A first regardless of priority.

Report the ordered worklist to the operator before starting (issue code, type,
status, priority) so an autonomous run is auditable from the first message.

## Step 4: Sequence each issue through its lanes

For each issue in worklist order:

1. Re-read `status` (`get_issue`) — another agent may have advanced it.
2. Look up the next lane-skill in the [routing table](#lane-routing-table).
3. **Invoke that lane-skill**, passing the issue code as its argument:
   ```
   Skill: <lane-skill>
   arg:   <ISSUE-CODE>
   ```
   The lane-skill owns its own HARD-GATES (worktree check, sync check, readiness
   gate, claim, push, tests, merge). The orchestrator does **not** pre-empt or
   re-run any of them.
4. When the lane-skill hands control back, re-read `status` and route again:
   - advanced but not terminal → invoke the next lane-skill (e.g. `Triaged` → prepare).
   - terminal for this run (`InDeployment`, `Done`, `Cancelled`) → log and move to the next issue.
   - rejected back to `InProgress` (from review) → re-invoke execute, then review again.
   - **blocked** (a lane-skill reported a blocker / left a Decision entry) → do
     NOT force it. Log the blocker, leave the issue where it is, and move on to
     the next issue. Document, never guess.

One issue at a time. Do not start the next issue until the current one is either
terminal for this run or explicitly parked as blocked.

## Step 5: Log + run summary

- After each issue reaches a terminal-for-run state, add a Comment discussion-entry
  on that issue: `Orchestration: <issue> advanced <fromStatus> → <toStatus> via <lanes walked>.`
- At the end, report a run summary to the operator: issues processed, final status
  per issue, and any parked/blocked issues with their reasons.

The orchestrator records **Comment** entries only. Decision/KnowledgeExtraction
entries are written by the lane-skills that own the corresponding transition.

## Boundary — what this skill does NOT do

<HARD-GATE>
This skill is the orchestration layer **only**. The following are owned by the
lane-skills and MUST NOT be duplicated, re-implemented, or pre-run here:

- **Claim flow** (`claim_issue`, readiness gate, branch creation) → `kanbantic-issue-execute` Step 2.
- **Worktree + sync + ABP pre-flight HARD-GATES** → `kanbantic-issue-execute` Steps 0.5–0.7.
- **Per-phase / per-feature push and review gates** → `kanbantic-issue-execute` Step 4A.
- **Local E2E test gate + Review pre-conditions** → `kanbantic-issue-execute` Steps 6–7.
- **Code review, merge, branch cleanup, `Review → InDeployment`** → `kanbantic-issue-review`.
- **`update_validation_status` lifecycle** → execute (`Implemented`) + review (`Validated`).

If you find yourself about to call `claim_issue`, `git push`, `update_issue_status`,
or a merge command from this skill, STOP — you are in the wrong layer. Invoke the
lane-skill instead.
</HARD-GATE>

## Workspace override

The plugin ships this skill as the **baseline** orchestration prompt. A workspace
can override it without touching the plugin:

1. Create a Toolkit **Skill** item in the workspace with slug `kanbantic-orchestrate`
   (the slug is derived from the title's prefix before the first em-dash — see
   `slugify` in `plugin/scripts/sync-workspace-skills.js`). Title it e.g.
   `/kanbantic-orchestrate — <workspace> orchestration prompt`.
2. Run `kanbantic-sync-workspace-skills` (or `node plugin/scripts/sync-workspace-skills.js`).
   The sync mirrors every Skill item to `.claude/commands/<slug>.md` via
   `targetPathFor('Skill', slug)` → `.claude/commands/kanbantic-orchestrate.md`.

**Precedence: the workspace override is intended to win over the plugin baseline.** Both
register the command name `kanbantic-orchestrate`; the override mechanism *assumes* Claude
Code resolves the workspace-local `.claude/commands/kanbantic-orchestrate.md` ahead of the
plugin-bundled skill of the same command name. **This resolution order is assumed, not yet
verified** — confirm against the running Claude Code version before relying on the override
in production; if CC does not shadow a plugin skill with a same-named project command, the
override will silently no-op and the baseline must instead be edited (or the plugin skill
renamed). No new sync logic is required — the existing `sync-workspace-skills.js` already
materializes Skill items by slug.

To revert to the baseline, set the Toolkit Skill item `isActive: false` and re-run
the sync (which deletes the mirror file), or delete the mirror and re-sync.

## Key principles

- **Sequence, don't implement** — route to lane-skills; never do their work.
- **One issue at a time** — finish or park before advancing.
- **Priority + in-flight first** — drain started work before opening new work.
- **Document blockers, don't guess** — park blocked issues with a logged reason.
- **Stay in your layer** — no claim, no push, no merge, no status mutation here.
