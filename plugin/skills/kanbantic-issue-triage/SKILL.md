---
name: kanbantic-issue-triage
description: "Use after an intake skill creates a new issue. Triage decides go / no-go: on go, sets priority / version / application / initiative / tags and moves the issue from New to Triaged. On no-go, records a ≥20-char reason as a Decision entry and moves the issue to Cancelled. Does not write specs, user stories, or test cases."
user_invocable: true
command: triage-issue
---

# Kanbantic Issue Triage

## Overview

Dedicated lane-skill for the **New → Triaged** (or **New → Cancelled**) transition. Short dialogue, fixed vocabulary, strict tool-set. Triage costs minuten, not uren — the full elaboration (specs / user stories / test cases / implementation plan) belongs to `kanbantic-issue-prepare`.

**Principle:** Read a New issue → duplicate check + go/no-go dialogue → update metadata + status in Kanbantic. Stop.

**Announce at start:** "I'm using the kanbantic-issue-triage skill to triage this issue."

## Scope

- Moves an issue from `New` to `Triaged` (go) or `Cancelled` (no-go).
- Sets/updates `priority`, `VersionId`, `applicationId`, `initiativeId`, and `tags` when the user decides go.
- Does **not** create specifications, user stories, test cases, phases, tasks, or implementation plans — those belong to `kanbantic-issue-prepare`.
- Does **not** call embeddings or vector-search endpoints. Duplicate check is a lightweight heuristic on `list_issues`.

## Allowed MCP Tool-Set

<HARD-GATE>
The triage skill uses **only** the following MCP tools. Any other MCP call is out of scope and must not be made:

- `get_issue`
- `list_issues` (for duplicate heuristic)
- `update_issue` (for metadata: priority, version, application, initiative, tags)
- `list_versions` (resolve + Application-scope-validate the chosen Version — KBT-RL144)
- `update_issue_status` (Triaged or Cancelled)
- `add_discussion_entry` (Decision entry for no-go reason)

Forbidden: `create_specification`, `create_test_case`, `create_user_story`, `create_phase`, `add_task`, `create_implementation_plan`, `create_issue`.
</HARD-GATE>

## Checklist

1. **Load issue** — `get_issue`
2. **Gate-check** — status must be `New` (HARD GATE)
3. **Duplicate heuristic** — top-3 recent issues on the same application
4. **Go / no-go dialogue** — single `AskUserQuestion` with two options
5. **If go** — collect metadata (priority / version / application / initiative / tags), update, transition to Triaged
6. **If no-go** — collect ≥20-char reason, record Decision entry, transition to Cancelled
7. **Handoff** — point at `kanbantic-issue-prepare` (go) or stop (no-go)

## Step 1: Load Issue

```
MCP: mcp__kanbantic__get_issue(issueId)
```

Capture existing metadata that the intake skill already filled in: title, description, `type`, `applicationId`, `VersionId`, `initiativeId`, `priority`, `tags`. These are shown back to the user in Step 4 and **not** re-prompted unless the user wants to change them (per the Decision: respect intake output).

## Step 2: Gate-check — status must be `New`

<HARD-GATE>
- If `status == "New"` → continue.
- If `status == "Triaged"` → stop and tell the user:
  > "Issue [CODE] is al Triaged. Gebruik `kanbantic-issue-prepare` om specs en test cases op te stellen."
- If `status == "InProgress"` → stop and redirect to `kanbantic-issue-execute`.
- If `status == "Review"` → stop and redirect to `kanbantic-issue-review`.
- If `status == "Done"` / `"Cancelled"` → stop with: "Triage is only valid on issues in status New. This issue is [status]."

Triage has exactly one bron and one bestemming per run.
</HARD-GATE>

## Step 3: Duplicate Heuristic (lightweight, no embeddings)

If the issue has an `applicationId`, query recent issues on the same application:

```
MCP: mcp__kanbantic__list_issues(
  workspaceId,
  applicationId: <from issue>,
  maxResults: 20
)
```

Show the user the **top 3** items sorted by `createdAt` descending, excluding the current issue and any `Cancelled` issues. Example output:

```
**Recente issues op dezelfde applicatie** (ter visuele duplicaat-check):
- KBT-F170 (Feature, New, 2 dagen geleden): "Readiness popover breedte"
- KBT-B168 (Bug, InProgress, 4 dagen geleden): "Login redirect loopt vast"
- KBT-F166 (Feature, Triaged, 5 dagen geleden): "Help pagina ai-collaboration"

Is het huidige issue een duplicaat van een van bovenstaande? (Ja → overweeg no-go en link het bestaande issue)
```

If the issue has no `applicationId` (possible for an Epic from the epic-proposal intake), skip the duplicate check with a note: "Geen applicationId ingesteld — duplicate-check overgeslagen."

Do NOT call any embeddings, vector-search, or semantic-similarity endpoint.

## Step 4: Go / no-go Dialogue

Use `AskUserQuestion` with two options:

- **Go** — "Ja, dit Issue oppakken. Zet naar Triaged."
- **No-go** — "Nee, dit Issue cancelen."

Also show the metadata-summary from Step 1 so the user can see what intake already filled in.

## Step 5: Go Path

### 5a: Confirm or adjust metadata

For each field, show the current value and ask the user if it should change. Use `AskUserQuestion` (multiple choice where possible) for the ones where the user wants to adjust.

| Field | Required | Options |
|-------|----------|---------|
| Priority | Yes | Critical / High / Medium / Low |
| Version | No | Active Versions of the issue's Application, or `backlog` (null). Must belong to the issue's Application (KBT-RL144). Legacy `release` term accepted with a deprecation-warning (KBT-RL143) |
| Application | Yes for Feature/Bug; optional for Epic | Active applications in workspace |
| Initiative | No | Active initiatives, or none |
| Tags | No | Free-form, comma-separated |

Skip fields the intake already set correctly, unless the user explicitly wants to change them (per the Decision on respecting intake output).

### 5b: Validate Version scope + update metadata (single call)

**Version Application-scope validation (KBT-RL144):** if the user set/changed the Version, resolve it via `list_versions(workspaceId)` and confirm it belongs to the issue's Application. A Version of another Application is refused: `Version <code> hoort bij Application <X>, niet bij <issue.Application>. Kies een Version van de juiste Application.` Backward-compat: if the user used the legacy `release` term, accept it as `version` and emit `⚠️ 'release' is hernoemd naar 'version' en wordt volgende cyclus verwijderd.` (KBT-RL143, 1 cycle).

```
MCP: mcp__kanbantic__update_issue(
  issueId,
  priority: <priority>,
  VersionId: <validated version id or null>,
  applicationId: <application id>,
  initiativeId: <initiative id or null>,
  tags: <array of tags or omit>
)
```

### 5c: Transition to Triaged

```
MCP: mcp__kanbantic__update_issue_status(
  issueId,
  status: "Triaged"
)
```

### 5d: Handoff

Report:

**"Issue [CODE] is now Triaged. Metadata locked in:**
- Priority: [priority]
- Version: [version or backlog]
- Application: [application]
- Initiative: [initiative or —]

**Next step:** Invoke `kanbantic-issue-prepare` to add specs / user stories / test cases (Epic also: implementation plan). Once all readiness-checks are green, prepare transitions the issue to **`Prepared`** (KBT-F235), surfacing it in the Prepared kanban-column for `kanbantic-issue-execute` to claim. `readinessChecks` will stay red for Specifications / TestCases / UserStories and the issue will stay on `Triaged` until prepare has run — that is expected."

## Step 6: No-go Path

### 6a: Collect reason

Ask the user for a clear justification. The skill **refuses** to proceed unless the reason is **≥ 20 characters** (per KBT-SR237). This guards against "nvt" / "nope" / empty reasons and preserves audit-value.

### 6b: Record Decision entry BEFORE status transition

<HARD-GATE>
The Decision entry MUST be written **before** the status transition. Cancellation without a recorded reason is not allowed and would otherwise be unexplainable in the timeline.
</HARD-GATE>

```
MCP: mcp__kanbantic__add_discussion_entry(
  issueId,
  content: "**Triage no-go.** Reason: <user-supplied justification, verbatim>",
  entryType: "Decision"
)
```

### 6c: Transition to Cancelled

```
MCP: mcp__kanbantic__update_issue_status(
  issueId,
  status: "Cancelled",
  reason: "<same justification>"
)
```

The backend's cancellation reason is passed in addition to the Decision entry — both serve audit purposes.

### 6d: Stop

Report:

**"Issue [CODE] is Cancelled. Reason recorded as Decision entry. No further steps."**

No handoff to prepare or other skills.

## Key Principles

- **Minutes, not hours** — triage is fast; elaboration is `kanbantic-issue-prepare`'s job
- **One bron, one bestemming** — only accepts New, only leaves to Triaged or Cancelled
- **Go-path muteert metadata; no-go-path vereist ≥20-char reden**
- **Duplicate check is visual, not algorithmic** — top-3 from `list_issues`, user decides
- **Strict tool-set** — no specs, user stories, test cases, phases, tasks, or plans
- **Respect intake output** — do not re-prompt fields the intake skill already filled in correctly
- **Readiness stays red after triage** — that is the signal that `kanbantic-issue-prepare` still has work to do
