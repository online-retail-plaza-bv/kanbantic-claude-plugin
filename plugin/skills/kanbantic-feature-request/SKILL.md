---
name: kanbantic-feature-request
description: "Use when the user wants to propose a new Feature. Lightweight intake: captures title, short description, application, version (optional), priority — then creates a Feature issue in status New. Does not create specs, user stories, or test cases; those come later via kanbantic-issue-prepare."
user_invocable: true
command: request-feature
---

# Kanbantic Feature Request

## Overview

Lightweight Feature intake. Capture the minimum needed to create a Feature issue in `New`, then hand off to the triage skill. No design phases, no approach comparison — just get the idea captured quickly.

**Principle:** Gather the essentials → Create Feature in Kanbantic (status `New`) → point at `kanbantic-issue-triage` for go/no-go.

**Announce at start:** "I'm using the kanbantic-feature-request skill to capture this Feature idea."

## Scope

- Creates exactly **one** issue via a single `create_issue` call with `type: "Feature"` and `status: "New"`.
- Does **not** create specifications, user stories, test cases, phases, or implementation plans — all of that is `kanbantic-issue-prepare`'s job after triage.
- Does **not** dispatch subagents. One short dialogue with the user, one MCP call.
- Does **not** touch existing issues.

## Checklist

1. **Orient** — load workspace context
2. **Gather** — max 5 short questions, one at a time
3. **Confirm** — show summary, get approval
4. **Persist** — one `create_issue` call
5. **Handoff** — point at `kanbantic-issue-triage` + `kanbantic-issue-prepare`

## Step 1: Orient

```
MCP: mcp__kanbantic__get_context
```

Note the workspace ID, active **versions** (per Application), and applications — needed for the `create_issue` call.

## Step 2: Gather

Ask **at most 5 questions**, one at a time, via `AskUserQuestion` with multiple-choice options where that helps. Skip questions the user already answered in their initial message.

| Field | Required | Notes |
|-------|----------|-------|
| Title | Yes | Short, action-oriented |
| Short description | Yes | 2–5 sentences on what + why |
| Application | **Yes** | Every Feature is scoped to an application (per the intake Decision) |
| Version | No | Target Version — must belong to the same Application (KBT-RL144); omit → backlog |
| Priority | No | Critical / High / Medium / Low — default Medium |

<HARD-GATE>
If Title, Short description, or Application is missing after the dialogue, the skill **refuses** to create the issue. Report which field is missing and ask the user to supply it.
</HARD-GATE>

<HARD-GATE>
The skill MUST NOT call `create_specification`, `create_test_case`, `create_user_story`, `create_phase`, `add_task`, or `create_implementation_plan`. Intake captures nothing but the issue itself — everything else is `kanbantic-issue-prepare`'s territory.
</HARD-GATE>

## Version handling (KBT-F318 / KBT-RL143–144)

- **Rename:** the parameter is now **`version`** (was `release`). If the user uses the legacy `release` term, accept it but emit the deprecation-warning: `⚠️ 'release' is hernoemd naar 'version' en wordt volgende cyclus verwijderd.` (KBT-RL143 — backward-compat, 1 cycle).
- **Application-scope validation (KBT-RL144):** resolve the chosen Version via `list_versions(workspaceId)` filtered to the Feature's Application. If the Version belongs to a different Application, refuse: `Version <code> hoort bij Application <X>, niet bij <Feature.Application>. Kies een Version van de juiste Application.`
- Pass the validated Version as `VersionId` on `create_issue` (null → backlog).

## Step 3: Confirm

Present a short summary:

```
**Feature:** [title]
**Application:** [application name]
**Version:** [version name or "backlog"]
**Priority:** [priority]

[description]

Zal ik dit Feature-issue aanmaken in status New?
```

Wait for confirmation before Step 4.

## Step 4: Persist

Exactly **one** MCP call:

```
MCP: mcp__kanbantic__create_issue(
  workspaceId: <workspace ID>,
  VersionId: <validated version id or null for backlog>,
  type: "Feature",
  title: <title>,
  description: <description>,
  priority: <priority>,
  applicationId: <application id>
)
```

The issue lands in status `New` — that is Kanbantic's default for newly created issues, and intake does not override it (per the Decision that intake never auto-triages).

## Step 5: Handoff

Report:

**"Feature [CODE] has been created in status New. Next steps in the v0.10.0 lane-flow (8 statuses, 4 lane-skills):**

1. **Triage** — run `kanbantic-issue-triage` for the go / no-go decision (`New → Triaged`); sets priority / version / application details.
2. **Prepare** — once Triaged, run `kanbantic-issue-prepare` to work out specs, user stories, and test cases (`Triaged → Prepared` on green readiness — Prepared is the dedicated ready-to-claim status since plugin v2.2.0 / KBT-F235).
3. **Execute** — finally `kanbantic-issue-execute` claims the Prepared issue (atomic `Prepared → InProgress`) and drives it through to `Review` when all tasks are Done and tests Passed.
4. **Review + Deploy** — `kanbantic-issue-review` reviews + merges + transitions to `InDeployment` (since plugin v2.3.0 / KBT-F236); the operational deploy webhooks + manual `update_issue_status(status: \"Done\")` complete the journey to `Done`."

No other MCP calls. Stop after printing the handoff.

## Key Principles

- **Fast** — max 5 questions, no design phases, no subagents
- **One create_issue call** — never more, never anything else
- **Issue lands in New** — triage is a separate lane, do not skip it
- **Noun-phrase skill name** — consistent with `kanbantic-bug-report` / `kanbantic-epic-proposal` for the intake trio
- **Never creates specs, user stories, test cases, phases, plans** — those belong to `kanbantic-issue-prepare`
