---
name: kanbantic-orchestrate
description: "Orchestration/sequencer skill (KBT-F436) — NOT a lane-skill. Given {workspace, initiative, repos}, decides WHICH issues to pick up (by initiative + priority), in WHICH order, and drives each one through the lane-skills (triage → prepare → execute → review) with explicit hand-offs. Owns sequencing only — it does NOT re-implement claim, per-phase push, or merge; those stay in kanbantic-issue-execute / kanbantic-issue-review."
user_invocable: true
command: kanbantic-orchestrate
---

# Kanbantic Orchestrate

> **Canonieke werkwijze — Kanbantic Workflow v3.** "De Kanbantic Workflow" verwijst naar het Library-document *"Kanbantic Workflow — Plan van Aanpak (v3)"* (slug `kanbantic-workflow--plan-van-aanpak-v3`), de bron-van-waarheid. De per-entiteit statuslevenscyclus (eigenaar + tool-call per status, geverifieerd tegen `get_system_schema`) staat in **§0.2**, de harde roll-up in **§0.3**, multi-repo in **§7.1**. Lees bij twijfel via `read_library_document`. Gebruik de echte enum-namen (`Ready`/`Blocked`/`OnHold`/…), geen "mentale mapping". Zie ook `plugin/reference/kanbantic-workflow-v3.md`.

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
- Mutate **Feature/Bug** status directly, or claim/push/test/merge child issues — all lane-skill responsibilities.
- Create issues, specs, user stories, or implementation plans.

It **does** own exactly one status-mutation (KBT-F581): when it runs an **Epic** in the parallel per-Feature model, it claims the **Epic itself** (`Ready → InProgress`) and creates the epic-integration branch(es) **before** fanning out to the child Features — see [Step 3.5](#step-35-epic-bootstrap-parallel-fan-out-kbt-f581). Without this, nobody owns the Epic's status in the parallel model and it sits misleadingly on `Ready` while N agents build its children (and `kanbantic-issue-review` Step 1.6 rejects every child mini-review because the parent Epic is not `InProgress`).

## Model-selectie — goedkoopste-capabele per rol (v3 §5.6)

**Kernprincipe:** gebruik altijd het **lichtste model dat de taak aankan**; escaleer pas als het lichtere **aantoonbaar tekortschiet**. Wissel per subtaak/rol.

| Tier | Typische taken | Model (huidig) |
|---|---|---|
| **Licht** | lezen, samenvatten, status-updates, triage, read-only onderzoek | **Haiku 4.5** |
| **Middel** | code/specs/tests schrijven, root-cause, de meeste bouw-tasks | **Sonnet 5** |
| **Zwaar** | complexe architectuur, tegenstrijdige specs, moeilijkste review | **Opus 4.8** |
| **Max** | de absolute moeilijkste redeneer-/lang-horizon-taken (zelden) | **Fable 5** |

Toepassing binnen deze skill:
- **De orchestrator zelf** → **Middel (Sonnet 5)** naar complexity — sequencing/ordering-beslissingen zijn meestal Middel; escaleer naar **Zwaar (Opus 4.8)** voor lastige golf-barrière- of dependency-afwegingen (bv. Epic-bootstrap fan-out, Step 3.5).
- **Elke lane-skill die de orchestrator invoceert** kiest zijn **eigen** modeltier — zie de Model-selectie-sectie in `kanbantic-issue-triage` (Licht), `kanbantic-issue-prepare` (Middel/Zwaar), `kanbantic-issue-execute` (Middel/Zwaar), `kanbantic-issue-review` (Zwaar). De orchestrator dicteert dit niet, maar moet consistent zijn met diezelfde tabel wanneer het zelf een Agent voor een lane-skill spawnt (bv. via parallelle `Agent`-dispatch per Feature in de fan-out).
- **Read-only fan-out-subagents** (bv. status-verzameling over meerdere issues) → **Licht (Haiku 4.5)**.

Modelnamen/prijzen evolueren; het **principe** (lichtste-capabele, escaleren-op-bewijs) is leidend — verifieer actuele model-ID's via de `claude-api`-referentie, niet uit geheugen.

## Continue statusmelding (v3 §5.3)

De orchestrator is vaak een lang-lopende, multi-issue sessie — precies het soort run waarbij een levend "wie werkt waaraan"-signaal op het bord waardevol is. Emit deze calls **naast** (niet in plaats van) de calls die elke lane-skill zelf al doet voor het issue dat het op dat moment bewerkt:

| Moment | Call | Effect |
|---|---|---|
| Start van de sequencer-run | `register_agent_session` + `set_current_issue` | Bord toont dat de orchestrator actief is en (optioneel) welk issue net gestart is |
| Doorlopend, tijdens lange runs | `heartbeat` (periodiek) | Toont dat de orchestrator leeft/actief is tussen lane-skill-invocaties door |
| Na elk issue-hand-off | `report_status` + de Comment-entry uit Step 5 | Samenvatting van voortgang zichtbaar buiten alleen de discussion-timeline |
| Bij een geparkeerd/geblokkeerd issue | `report_status(status: "Blocked")` + Decision/Comment-entry | Board-signaal dat de sequencer bewust wacht, niet hangt |
| Einde van de run | `end_agent_session` | Sessie netjes afgesloten |

Dit is een **aanvullende** laag bovenop de per-issue statusmelding die elke lane-skill al eigenaar van is (`kanbantic-issue-execute` / `kanbantic-issue-review` §Mandatory calls) — de orchestrator herimplementeert die niet, maar rapporteert wél zijn eigen sequencer-niveau voortgang.

## Lane routing table

The orchestrator maps each issue's current `status` to the lane-skill that owns
its next transition. This mirrors the Skill ↔ Lane table in `plugin/README.md`.

| Issue `status` | Next lane-skill | Hand-off back to orchestrator when |
|---|---|---|
| `New` | `kanbantic-issue-triage` | issue reaches `Triaged` (go) or `Cancelled` (no-go) |
| `Triaged` | `kanbantic-issue-prepare` | issue reaches `Ready` |
| `Ready` | `kanbantic-issue-execute` | issue reaches `Review` |
| `InProgress` | `kanbantic-issue-execute` (resume) | issue reaches `Review` |
| `Review` | `kanbantic-issue-review` | issue reaches `InDeployment` (or back to `InProgress` on reject) |
| `InDeployment` / `Done` / `Cancelled` | — (terminal for this run) | skip |

A single issue may traverse several lanes in one orchestration pass: triage →
prepare → execute → review. The orchestrator re-reads `status` after each
lane-skill returns and routes again until the issue is terminal for this run or
the lane-skill reports a blocker.

### Step 3.5: Epic bootstrap (parallel fan-out) — KBT-F581

When the actionable issue is an **Epic** that will be built in the parallel
per-Feature model (its child Features are each independently claimable), the
orchestrator bootstraps the Epic **once**, before routing any child:

1. **Claim the Epic** to promote it `Ready → InProgress` and take ownership on the
   board (so `HasAssignee` is met and the Epic no longer lies on `Ready`):
   ```
   MCP: mcp__kanbantic__claim_issue(issueId: <EpicCode>, branch: "feature/<EpicCode>-integratie", versionId: <explicit Version GUID>)
   ```
   Pass an **explicit `versionId`** (auto-version can 500 — KBT-B443). Note: `claim_issue`
   records **one** branch on the Epic record — for a multi-repo Epic that is the coordinating
   repo's integration branch; the other repos' integration branches are resolved per-repo via
   `register_issue_branch` (by the Feature's `applicationId`, KBT-F588).
2. **Create the epic-integration branch** off `main` in **each touched repo**
   (multi-repo Epics, KBT-F588) — `feature/<EpicCode>-integratie`. Child Features
   branch from it and merge back into it (`kanbantic-issue-review` Step 5a); the
   single merge to `main` per repo happens at Epic-level review (Step 7).
3. **Then fan out**: route each child Feature/Bug through prepare → execute →
   review as usual. The Epic advances to `InDeployment`/`Done` only after its
   children roll up (the harde verticale roll-up, Workflow doc §0.1).

This is the **only** claim/branch action the orchestrator performs; child
Feature/Bug claims + branches remain owned by `kanbantic-issue-execute`.

## Checklist

1. **Resolve parameters** — `{workspace, initiative, repos}` (HARD GATE on workspace + initiative).
2. **Load knowledge** — call `bootstrap_agent` / `get_context` so ClaudeMd + patterns are in context (the lane-skills assume this).
3. **Select issues** — list the initiative's issues, filter to actionable, order by priority + lane.
4. **Sequence** — for each issue, route to the next lane-skill, wait for hand-off, re-route until terminal.
5. **Log** — record a Comment per issue-completion and a run-summary at the end.
5.5. **Record reusable knowledge (v3 §5.7, optional)** — consistentie-check, then AI Toolkit (not local memory) for any orchestration-level pattern/gotcha/rule discovered this run

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

- Keep issues whose `status` is `New`, `Triaged`, `Ready`, `InProgress`, or `Review`.
- Drop `InDeployment`, `Done`, and `Cancelled` (terminal — nothing to sequence).
- When `repos` is set, keep only issues whose `applicationId` maps to one of those repos.

Order the survivors:

1. **Priority** first — `Critical` → `High` → `Medium` → `Low`.
2. Within a priority, **issues already in flight** (`InProgress`, `Review`) before fresh ones (`Ready`, `Triaged`, `New`) — finish what is started before opening new work.
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

## Step 5.5: Record Reusable Knowledge (v3 §5.7, optional)

Orchestration-level findings are distinct from the per-issue Decision/KnowledgeExtraction
entries above (those stay owned by the lane-skill that made the transition). A
sequencing pattern, a golf-barrière gotcha, or an MCP-tool quirk hit while routing
issues through the lane-skills is reusable, workspace-wide knowledge — it goes to the
**AI Toolkit** (Kanbantic), **not** local memory (KBT-TRUL014, v3 §5.7 *"Kennisborging"*).
Skip this step entirely if nothing reusable was discovered this run — it is optional,
not forced.

**Consistentie-check (verplicht — v3 §5.7).** Before writing: search existing Toolkit
items and verify the new/changed content is not **contradicted** by other Toolkit items
(ClaudeMd, Rules, Patterns, Gotchas) — the same mechanism `kanbantic-issue-review` Step 9a
and `kanbantic-issue-execute` Step 5 use. If it does, reconcile via `update_toolkit_item`
rather than letting contradictory guidance coexist.

```
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, search: "<keyword>")
```

If genuinely new and non-contradictory:
```
MCP: mcp__kanbantic__create_toolkit_item(
  workspaceId: <id>,
  category: "Pattern" | "Gotcha" | "Rule",
  title: "<descriptive name>",
  content: "<orchestration-level finding: which MCP tool/sequencing quirk, when it applies>"
)
```

## Boundary — what this skill does NOT do

<HARD-GATE>
This skill is the orchestration layer **only**. The following are owned by the
lane-skills and MUST NOT be duplicated, re-implemented, or pre-run here:

- **Child Feature/Bug claim flow** (`claim_issue`, readiness gate, branch creation) → `kanbantic-issue-execute` Step 2.
- **Worktree + sync + ABP pre-flight HARD-GATES** → `kanbantic-issue-execute` Steps 0.5–0.7.
- **Per-phase / per-feature push and review gates** → `kanbantic-issue-execute` Step 4A.
- **Local E2E test gate + Review pre-conditions** → `kanbantic-issue-execute` Steps 6–7.
- **Code review, merge, branch cleanup, `Review → InDeployment`** → `kanbantic-issue-review`.
- **`update_validation_status` lifecycle** → execute (`Implemented`) + review (`Validated`).

**Sole exception (KBT-F581):** the orchestrator claims the **parent Epic** once and
creates the epic-integration branch(es) in [Step 3.5](#step-35-epic-bootstrap-parallel-fan-out-kbt-f581).
That is the only `claim_issue` / branch-create / `update_issue_status` it performs.

If you find yourself about to call `claim_issue`, `git push`, `update_issue_status`,
or a merge command from this skill on a **child Feature/Bug**, STOP — you are in the
wrong layer. Invoke the lane-skill instead.
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
