---
name: kanbantic-issue-execute
description: "Use when a Kanbantic issue needs to be implemented (status Prepared, or Triaged with isReadyToClaim for legacy issues that pre-date KBT-F235). Calls claim_issue which atomically promotes Prepared/Triaged → InProgress (KBT-RL052). For Epics: executes the Implementation Plan phase by phase with per-phase push. Per-Phase shape auto-detected (KBT-RL057, KBT-F250 v2.4.0): legacy Phase→Tasks vs new Phase→Features→Tasks. For Features/Bugs: executes tasks directly without phases. Ends at status Review — handoff to kanbantic-issue-review for merge/close."
---

# Kanbantic Issue Execute

## Overview

Execute implementation work for any issue type. Handles two modes:
- **Epics**: execute the Implementation Plan phase by phase, push after each phase, request per-phase review
- **Features / Bugs**: execute tasks directly without phases; single push + handoff at the end

**Principle:** Claim issue (InProgress) → Read tasks + knowledge from Kanbantic → Implement code → Push → Update status + knowledge in Kanbantic. Stop at Review.

**Announce at start:** "I'm using the kanbantic-issue-execute skill to implement this issue."

## Scope

This skill owns the **InProgress → Review** transition. It does NOT merge, close the issue, or finalize knowledge extraction — those belong to `kanbantic-issue-review` and run after a positive review verdict.

## Checklist

1. **Gate-check** — verify issue is `Prepared` (preferred) or `Triaged` + ready to claim (legacy) (HARD GATE)
2. **Claim issue** — atomically sets status to InProgress + records branch (single MCP call, KBT-RL052)
3. **Load plan + knowledge** — get phases/tasks AND project patterns from Kanbantic
4. **Execute** — depends on issue type:
   - **Epic** (has Implementation Plan): execute per phase with per-phase push + review gates
   - **Feature / Bug** (no Implementation Plan): execute tasks directly
5. **Update knowledge** — store corrections or new discoveries in Toolkit/Library
6. **Run E2E tests** — invoke /test-e2e-local before completing (auto-trigger)
7. **Verify pre-conditions + transition to Review** — all tasks Done/Cancelled, all test cases Passed
8. **Handoff** — instruct user/agent to invoke `kanbantic-issue-review`

<HARD-GATE>
Tasks can ONLY be started (set to InProgress) when the parent issue is in **InProgress** status. If the issue is not InProgress, you MUST claim it first (Step 2) before working on any task. NEVER start a task on an issue that is still in New, Triaged, Prepared, or any other non-InProgress status.
</HARD-GATE>

## Step 0: Ensure Repository Access

Before starting, verify you have local access to the workspace's code repository:

1. Run `git remote -v` to check if you're in a git repository
2. If already in the correct repository, skip to Step 1
3. If no repository or wrong repository:
   ```
   MCP: mcp__kanbantic__list_repositories(workspaceId)
   ```
   If the issue has an `applicationId`, choose the repository linked to that application. Otherwise use the first active repository.
   ```
   MCP: mcp__kanbantic__get_repository(repositoryId)  // → includes cloneUrl, gitAuthorName, gitAuthorEmail
   ```
   Then clone and configure git to obtain the PAT **just-in-time** via the bundled
   credential helper. Do **not** call `get_repository_credential` yourself and do
   **not** embed the token in the clone URL — either path persists the secret
   (into `.git/config`, shell history, the process list, or this transcript). The
   helper feeds the token to git over stdin; see KBT-B330. Clone the **clean** URL:
   ```bash
   # Configure once, reuse for clone + every later fetch/push in this clone.
   HELPER="!node \"$CLAUDE_PLUGIN_ROOT/scripts/kanbantic-git-credential-helper.js\""
   git clone \
     -c credential.helper="$HELPER" \
     -c kanbantic.repositoryId="<repositoryId>" \
     https://github.com/<org>/<repo>.git
   cd <repo>
   git config credential.helper "$HELPER"          # persist (remote URL stays clean — no token)
   git config kanbantic.repositoryId "<repositoryId>"
   git config user.name "<gitAuthorName>"
   git config user.email "<gitAuthorEmail>"
   ```
   (PowerShell: identical `git config` keys; only shell quoting differs.)

<IMPORTANT>
- If no repository is configured in the workspace, skip this step and proceed — not all work requires code access.
- If no credential is configured, tell the user: "No repository credential found. Configure a PAT token via Workspace → Repositories → Credentials in the Kanbantic UI."
- If the repo is already cloned, run `git pull` to get the latest code. Branch creation happens in Step 2.
</IMPORTANT>

## Step 0.5: Worktree HARD-GATE (context-aware)

<HARD-GATE>
This gate is **context-aware** per the decision rule `shouldEnforceWorktreeGate({ hasGitRepo, touchesFilesystem })` in `plugin/scripts/gate-context.js` (KBT-F447). Evaluate it first:

- **No git repository in this environment** (`hasGitRepo: false` — Cowork/desktop, MCP-only run, no repository configured per Step 0) → **skip the gate**. There is no main-tree/worktree distinction to protect.
- **In a git repo but this run is MCP-only** (`touchesFilesystem: false` — the issue requires no code reads/writes, only Kanbantic-artifact work via MCP) → **skip the gate**.
- **In a git repo AND the run touches the filesystem/code** (`hasGitRepo: true && touchesFilesystem: true`) → **enforce the gate** (below).

When you **skip** the gate, log it as a Comment discussion-entry — a mirror of the existing `KANBANTIC_SKIP_GIT_SYNC` opt-out pattern (KBT-F238):

```
MCP: mcp__kanbantic__add_discussion_entry(issueId, entryType: "Comment",
  content: "Worktree HARD-GATE skipped: <no git repository in this environment | MCP-only run, no filesystem/code work>. Decision per shouldEnforceWorktreeGate (gate-context.js, KBT-F447). Mirrors the KANBANTIC_SKIP_GIT_SYNC opt-out.")
```

<CRITICAL>
Execute almost always writes code. **Whenever this run touches the filesystem/code in a repo, the gate stays fully enforced — no opt-out, no override (KBT-BD155 scope boundary).** The relaxation above applies *only* to the no-repo / MCP-only paths; it must never weaken the code-in-a-repo path. The strict worktree gate is the load-bearing parallel-agent-safety guarantee (KBT-TRUL004): two agents committing on the same main working tree corrupt each other's branches. If in doubt, treat the run as code-touching and enforce.
</CRITICAL>

When the gate is **enforced**, verify you are **not** in the main working tree. Agents often run in parallel on the same clone; working in the main tree on a feature branch risks conflicts with other concurrent agents or manual commits.

```bash
GIT_DIR=$(git rev-parse --git-dir)
GIT_COMMON=$(git rev-parse --git-common-dir)
if [ "$GIT_DIR" = "$GIT_COMMON" ]; then
  STOP. Report to user verbatim:
  "You are in the main working tree ($GIT_COMMON).
  Run EnterWorktree(name: '<ISSUE-CODE>') first, then re-run this skill.
  See KBT-TRUL004 for the rationale."
fi
```

`<ISSUE-CODE>` is the code of the issue this skill is processing (e.g. `KBT-F123`).

**No opt-out, no override on the enforced path.** This is a working-tree safety check, not a readiness-artifact check. Working in the main tree is wrong even if the specific bullet reasons don't apply right now — parallel agents are the norm, not the exception.

If the gate is enforced and the check passes (paths differ → you are in a worktree), continue silently.
</HARD-GATE>

## Step 0.6: Sync check — base must not be stale vs origin (KBT-F238 / KBT-SR302)

Now that the worktree HARD-GATE has confirmed you are in a worktree (and **before** any status-mutating call), verify that the local base is **not behind `origin/<default-branch>`**. A stale base is the single biggest avoidable source of merge conflicts at review-time — especially when multiple parallel agents work on the same Epic.

```bash
pwsh -NoProfile -File "$CLAUDE_PLUGIN_ROOT/hooks/git-sync-check.ps1" Pull "$PWD"
```

The script emits a single-line JSON result. Possible `action` values:

| `action` | Meaning | Skill behavior |
|---|---|---|
| `up-to-date` | base is current with origin | continue silently |
| `pulled` | rebased feature-branch onto fresh origin | log a `Comment` discussion-entry summarising `behindCount` + new HEAD sha |
| `force-continue` | operator chose Force; base is still stale | log a `Decision` discussion-entry per KBT-RL063 |
| `rebase-conflict` | rebase produced conflicts; aborted | log a `Decision`-entry warning that manual merge may be needed later |
| `aborted` | operator chose Abort | STOP — do not call `claim_issue` |
| `skipped-env` | `KANBANTIC_SKIP_GIT_SYNC=1` set | log a `Comment` recording the opt-out |
| `no-origin` / `detached-head` / `fetch-failed` / `not-a-repo` | degenerate environment | log a `Comment`; continue (never block on environment) |

After the check (and any required discussion-entry has been added), proceed to Step 1.

### Opt-out

Set `KANBANTIC_SKIP_GIT_SYNC=1` to skip the comparison entirely. Intended for CI / headless contexts where the outer wrapper already guarantees a fresh fetch, or where interactive prompts are impossible. The skip is logged as a `Comment` discussion-entry so the audit trail stays complete.

### Default action (non-interactive)

`-DefaultAction Pull` is the default — when the local base is behind, the script rebases the feature-branch onto `origin/<default-branch>` automatically. Pass `Force` to log a Decision-entry and proceed without rebasing, or `Abort` to stop the skill. Interactive callers (a human running the skill from a terminal) should prompt the operator and pass the chosen action through.

## Step 0.7: ABP license pre-flight — backend issues only (KBT-F263 / KBT-SR307 / KBT-RL066)

For issues that touch the Kanbantic API or MCP host (anything that runs `dotnet run` on `Kanbantic.HttpApi.Host` or `Kanbantic.Mcp`), verify the ABP Pro license-runtime is satisfied **before** `claim_issue`. A stale `abp` CLI auth-token causes backend-startup to fail mid-flight with `ABP-LIC-ERROR — License check failed`, leaving an orphan `InProgress` claim that has to be cleaned up manually (see KBT-GTCH013, KBT-CMND007).

```bash
pwsh -NoProfile -File "$CLAUDE_PLUGIN_ROOT/hooks/abp-license-check.ps1" "<applicationSlug>" "<tagsCsv>" "$PWD"
```

Pass the issue's `applicationSlug` (from `get_issue`) and a comma-separated string of its `tags`. The hook's scope-gate runs the actual checks only for `kanbantic-api` / `kanbantic-mcp` or for any tags containing `backend` / `live-stack` — frontend-only and plugin-only work skips the check transparently.

The script emits a single-line JSON result. Possible `action` values:

| `action` | Meaning | Skill behavior |
|---|---|---|
| `ok` | env-var set, token present and fresh | continue silently |
| `out-of-scope` | issue's application / tags do not require the ABP Pro license-runtime | continue silently |
| `skipped-env` | `KANBANTIC_SKIP_ABP_CHECK=1` set | log a `Comment` discussion-entry recording the opt-out; continue |
| `missing-env-var` | `ABP_LICENSE_CODE` not set on Process / User / Machine scope | STOP — add a `Decision` entry with `[Environment]::SetEnvironmentVariable('ABP_LICENSE_CODE','<your-license>','User')` fix instruction; do not call `claim_issue` |
| `missing-token` | `$USERPROFILE\.abp\cli\access-token.bin` missing | STOP — Decision entry: run `abp login <username>` in a non-agent shell (interactive credentials) and restart |
| `stale-token` | token `LastWriteTime` exceeds threshold (default 7 days) | STOP — Decision entry: token is `tokenAgeDays` old (threshold `thresholdDays`), re-run `abp login <username>` to refresh |

After a FAIL (`missing-env-var` / `missing-token` / `stale-token`) the hook exits 1; the skill MUST stop here so the issue stays in `Prepared` / `Triaged`. Add the `Decision` discussion-entry from the rule-table above, then exit cleanly. The operator fixes the auth-state manually and re-invokes the skill.

### Opt-out

Set `KANBANTIC_SKIP_ABP_CHECK=1` to skip the check entirely. Intended for CI / headless contexts where backend startup is mocked, or for explicit operator override during incident-recovery. The skip is logged as a `Comment` discussion-entry so the audit trail stays complete (mirrors KBT-F238's `KANBANTIC_SKIP_GIT_SYNC` pattern).

### Token-age threshold

Default is 7 days. Override per session via env-var `KANBANTIC_ABP_TOKEN_MAX_AGE_DAYS=<int>`. Empirically a 10-day-old token is already enough to fail `dotnet run` (KBT-F257 incident, 2026-05-12); 7d gives a safety margin without being aggressive.

## Step 1: Gate-check — Prepared (preferred) or Triaged (legacy) + Ready to Claim

Before claiming, verify the issue is in the right state and has the required artifacts:

```
MCP: mcp__kanbantic__get_issue(issueId)
```

Inspect the response:

<HARD-GATE>
- **`status`**: accepted bron-statuses for execute are:
  - `Prepared` ← **preferred path**, the kanbantic-issue-prepare skill transitions here once readiness is green (KBT-F235).
  - `Triaged` ← legacy bron — accepted only when `isReadyToClaim == true`. Used by issues that pre-date the data-migration to Prepared, or by single-session intake → triage → prepare → execute runs that did not yet take the Triaged → Prepared transition.
  - `InProgress` ← already claimed by you in a previous session that crashed; resume execution from Step 3.
  - Any other status (`New`, `Review`, `Done`, `Cancelled`) → STOP and redirect to the appropriate skill (triage / review / etc.).
- **`isReadyToClaim`**: derived from `Status == Prepared` (KBT-SR266). For Prepared-status issues this is always `true`. For legacy Triaged-status issues, must be backed by green readiness-checks for the `Triaged → InProgress` gate. If `false` and the issue is on `Triaged`:
  - **Hard enforcement**: STOP and redirect to `kanbantic-issue-prepare` to supply missing artifacts and transition to `Prepared`.
  - **Soft enforcement**: warn which checks failed; collect an `overrideReason` to pass in Step 2.
</HARD-GATE>

This gate prevents execution of half-designed issues and couples this skill to the output of `kanbantic-issue-triage` + `kanbantic-issue-prepare`.

## Step 2: Claim Issue and Create Branch

<HARD-GATE>
**`claim_issue` is the FIRST state-mutating MCP call of execute, before any other `update_issue_*` call.** Per `KBT-RL048` + `KBT-RL052`, calling `update_issue_status(InProgress)` before `claim_issue` is forbidden — `claim_issue` atomically:

1. Validates the readiness gate (with optional `overrideReason` for Soft enforcement).
2. Sets the assignee to the current agent.
3. Records the branch on the issue.
4. **Promotes the issue from `New`/`Triaged`/`Prepared` to `InProgress` in the same call** (KBT-RL052).

Do **not** split this into `claim_issue` + a separate `update_issue_status(InProgress)` — the second call is unnecessary and historically the source of `MissingAssignee` errors when agents accidentally reversed the order.
</HARD-GATE>

```
MCP: mcp__kanbantic__claim_issue(issueId, branch: "<branch-name>", overrideReason: "<if soft override>")
```

Branch naming convention: `feature/<issue-code>-<short-slug>` for Features/Epics, `fix/<issue-code>-<short-slug>` for Bugs. The slug is a lowercase, hyphen-separated summary (max ~40 chars).

Examples:
- `feature/KBT-F163-issue-execute-rename`
- `fix/KBT-B170-popover-width`

Create the branch locally:
```bash
git checkout -b feature/<issue-code>-<slug>
```

### Step 2 — Idempotent claim-or-resume (after a crashed earlier session)

Per `KBT-SR258`, `claim_issue` is **idempotent for the same principal**: if you (the same agent) already claimed this issue in a previous session that crashed, re-calling `claim_issue` is safe and acts as a resume. The Domain-level `Issue.Claim()` only blocks when the *current* assignee differs from the calling principal — same-principal re-claim updates `claimedAt` + `branch` and ensures `status == InProgress`.

This means the execute-skill's claim step is **always one tool call**, regardless of whether the previous session crashed mid-flight:

| Pre-state of the issue | Behavior of `claim_issue` |
|---|---|
| `Prepared`, no assignee | **Preferred path.** Fresh claim. Sets assignee, branch, status → `InProgress`. |
| `Prepared`, assignee = self | Resume. Updates `claimedAt`+`branch`, promotes → `InProgress`. |
| `Triaged`, no assignee | Legacy claim (pre-F2 issues). Sets assignee, branch, status → `InProgress`. |
| `Triaged`, assignee = self | Legacy resume. Updates `claimedAt`+`branch`, promotes → `InProgress`. |
| `InProgress`, assignee = self | Resume. Updates `claimedAt`+`branch`, status unchanged. |
| `Prepared`/`Triaged`/`InProgress`, assignee = other principal | Fails with structured `Kanbantic:IssueAlreadyAssigned` (see error handling below). |

### Step 2 — Handling structured error responses

When `claim_issue` or any `update_issue_*` MCP tool fails, the backend (per `KBT-SR259` / `KBT-SR260`) inlines structured fields into the error message via `(key: value)` pairs — `ExceptionHelper.FormatErrorMessage` flattens them into the `errorMessage` string. Pattern-match on these to act without an extra `get_issue` call:

- `(currentAssignee: <name>)` — when `IssueAlreadyAssigned`. Honor handover etiquette before re-attempting.
- `(missingCondition: MissingAssignee)` — call `claim_issue` first (you skipped it).
- `(missingCondition: ReadinessGateFailed)` + `(missing: <list>)` + `(enforcement: Hard|Soft)` — Hard requires the missing artifacts; Soft accepts an `overrideReason`.
- `(missingCondition: OpenTasks)` + `(openTaskCodes: KBT-T..., KBT-T...)` — close those tasks before retrying `Done`.
- `(recommendation: <text>)` — the backend's suggested next action; follow it before retrying.

Do not retry the same call without addressing the structured cause; the error is deterministic and will repeat.

## Workflow by Issue Type

Not all issues follow the full phase workflow:

- **Bug**: Simplified workflow — NO implementation plan or phases. Load tasks directly, execute all fix tasks, then transition to Review.
- **Feature**: Optional plan. If an implementation plan exists, follow the full phase workflow. If no plan exists, load tasks directly and execute them (skip phase-related steps 4A.1, 4A.3, 4A.4).
- **Epic**: Full workflow required — implementation plan with phases, per-phase review.

## Step 3: Load Tasks + Project Knowledge

### 3a: Load from Kanbantic

First, determine the issue type:
```
MCP: mcp__kanbantic__get_issue(issueId)
```

**If Epic** (has Implementation Plan):
```
MCP: mcp__kanbantic__get_implementation_plan(issueId)
MCP: mcp__kanbantic__list_tasks(issueId)
MCP: mcp__kanbantic__list_discussion_entries(issueId)
```

Read:
- **Phases**: ordered list of work phases
- **Tasks**: per phase, what to implement
- **Discussion entries** (KnowledgeExtraction): code instructions with file paths, snippets, line numbers

The KnowledgeExtraction entries contain the detailed code — use these as your implementation guide.

**If Feature / Bug** (no Implementation Plan):
```
MCP: mcp__kanbantic__list_tasks(issueId)
MCP: mcp__kanbantic__list_discussion_entries(issueId)
```

Read existing tasks and discussion context. If no tasks exist yet, you'll create them during execution (Step 4B.1).

### 3c: Load frozen test-policy (Feature / Bug only — Regel E / KBT-F442)

From the discussion entries loaded in 3a, locate the entry whose content starts with:
```
## Test-policy (bevroren bij claim_issue — KBT-F442 / Regel E)
```

Parse the Markdown table to extract, per level (Unit / Integration / E2E):
- **Applicability**: `Vereist` or `N.v.t.`
- **Minimum**: integer (only meaningful when Vereist)
- **N.v.t.-rationale**: the rationale text (only when N.v.t.)

Store as `frozenPolicy`:
```
frozenPolicy = {
  Unit:        { applicability: "Vereist"|"N.v.t.", min: N, reason: "..." },
  Integration: { applicability: "Vereist"|"N.v.t.", min: N, reason: "..." },
  E2E:         { applicability: "Vereist"|"N.v.t.", min: N, reason: "..." }
}
```

**If no test-policy entry is found:**
- Add a `Comment` discussion entry:
  ```
  MCP: mcp__kanbantic__add_discussion_entry(
    issueId,
    content: "⚠️ Geen test-policy Decision-entry gevonden op dit issue. Standaard: alle niveaus Vereist / minimum 1. Voeg een test-policy toe via kanbantic-issue-prepare (stap 5F.5 / 5B.6) om dit te corrigeren.",
    entryType: "Comment"
  )
  ```
- Default `frozenPolicy` to all three levels Vereist/min=1.

<HARD-GATE>
The `frozenPolicy` is **read-only** for execute. Do NOT call `update_test_policy` or `set_applicability` to loosen minima or switch a level to N.v.t. mid-flight. Any policy change requires reviewer approval via `SetApplicability(overrideReason: ≥20 chars)` — this is out of scope for the execute-skill.
</HARD-GATE>

### 3b: Load Project Knowledge from Kanbantic

```
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, category: "ClaudeMd")
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, category: "Pattern")
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, category: "Gotcha")
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, category: "Rule")
```

Load project-specific development guidance (ClaudeMd) first — these contain CLAUDE.md-style instructions that apply to all work in this workspace.

Optionally, if this issue touches architectural areas, read relevant Library documents:
```
MCP: mcp__kanbantic__list_library_documents(workspaceId, categoryType: "Architecture")
MCP: mcp__kanbantic__read_library_document(documentId)  // for relevant docs
```

This gives you codebase patterns, known pitfalls, and architecture context.

<IMPORTANT>
Do NOT launch Explore agents or do broad codebase exploration. The plan (tasks + KnowledgeExtraction entries) combined with Toolkit patterns and Library docs contain everything needed. Only do targeted file reads (Read tool) for specific files referenced in task descriptions when you need to see current line numbers or verify context.
</IMPORTANT>

## Step 4A: Execute Per Phase (Epics only)

Use this step for **Epics** that have an Implementation Plan with phases.

### 4A.0: Auto-detect Phase shape per Phase (KBT-RL057, KBT-F250)

A Phase can hold work in one of two shapes. The skill **auto-detects** per Phase, **without operator input**:

| Detection | Shape | Flow |
|---|---|---|
| `featureCount > 0 && taskCount == 0` | **New shape** (Phase → Features → Tasks) | Use 4A.2-new |
| `featureCount == 0 && taskCount > 0` | **Legacy shape** (Phase → Tasks direct) | Use 4A.2-legacy |
| `featureCount > 0 && taskCount > 0` | **Mixed — ERROR** | STOP, report to operator |
| `featureCount == 0 && taskCount == 0` | **Empty — ERROR** | STOP, redirect to `kanbantic-issue-prepare` |

For each unlocked Phase, before executing:

```
MCP: mcp__kanbantic__list_features_by_phase(phaseId)   // → featureCount + features[]
MCP: mcp__kanbantic__list_tasks(phaseId)               // → tasks where Task.PhaseId == phaseId; legacy-shape Tasks
```

Then decide:

```text
if featureCount > 0 && taskCount == 0:
    Report: "Phase {code} — detected new shape (Phase → Features → Tasks). N features."
    Continue with 4A.2-new
elif featureCount == 0 && taskCount > 0:
    Report: "Phase {code} — detected legacy shape (Phase → Tasks direct). N tasks."
    Continue with 4A.2-legacy
elif featureCount > 0 && taskCount > 0:
    STOP with error:
      "Phase {code} has BOTH directly-attached Tasks AND assigned Features.
       Mixed shape is not supported. Cleanup required:
       - Either move the directly-attached Tasks under one of the assigned Features
         (set IssueTask.IssueId to the Feature's id and clear PhaseId), or
       - Remove the Feature assignment from this Phase (assign_feature_to_phase null).
       Re-run kanbantic-issue-execute after cleanup."
else:
    STOP with error:
      "Phase {code} has neither Tasks nor Features. The Implementation Plan
       is incomplete. Run kanbantic-issue-prepare to add work."
```

This detection is per-Phase: an Epic MAY mix legacy-shape Phases (older work) with new-shape Phases (newer work) within the same plan, as long as no individual Phase is itself mixed.

### 4A.1: Unlock Phase (if needed)

First phase is auto-unlocked. Subsequent phases unlock after the previous is approved:
```
MCP: mcp__kanbantic__unlock_phase(issueId, phaseId)
```

### 4A.2-legacy: Execute Tasks directly (legacy shape)

Use this when 4A.0 detected `legacy shape` for the current Phase.

<IMPORTANT>
Before starting any task, verify the parent Epic-issue is **InProgress**. If not, go back to Step 2 and claim it first.
</IMPORTANT>

For each task in the Phase (where `IssueTask.IssueId == EpicId` and `IssueTask.PhaseId == phaseId`):

**Start:**
```
MCP: mcp__kanbantic__update_task_status(issueId: <EpicId>, taskId, status: "InProgress")
```

**Implement:** Read the task description and the KnowledgeExtraction discussion entry for this phase. Write the code, run build/tests, fix issues.

**Complete:**
```
MCP: mcp__kanbantic__update_task_status(issueId: <EpicId>, taskId, status: "Done")
MCP: mcp__kanbantic__add_discussion_entry(
  issueId: <EpicId>,
  content: "**Task [title] completed.**\n\nChanges:\n- [files changed]\n\nVerification:\n- [build/test results]",
  entryType: "Comment"
)
```

**Commit after each task or logical group** (conventional commits — see types below).

When all Tasks in the Phase are `Done` or `Cancelled`, continue to 4A.3 (push + mark phase for review).

### 4A.2-new: Execute Features → Tasks (new shape, KBT-F250)

Use this when 4A.0 detected `new shape` for the current Phase.

<IMPORTANT>
Before starting any Feature, verify the parent Epic-issue is **InProgress**. The child Features stay on `Prepared` (or `Triaged` for legacy intake) until each is sub-claimed below.
</IMPORTANT>

For each Feature in `list_features_by_phase(phaseId)` (in their `order` / Code order):

**Skip already-finished Features.** When resuming after a crashed session, the
`list_features_by_phase` response may include Features that are already `Done`
or `Cancelled` from a prior walk. Skip those — `claim_issue` is idempotent and
would not break, but re-walking completed work is a waste. Only walk Features
whose status is `Prepared`, `InProgress`, or `Triaged` (legacy intake).

#### 4A.2-new.a: Sub-claim the Feature

Each Feature is claimed and walked individually so it gets its own audit-trail. The same agent claims the parent Epic and each child Feature — `claim_issue` is idempotent for same-principal (KBT-SR258).

```
MCP: mcp__kanbantic__claim_issue(
  issueId: <FeatureId>,
  branch: "<same branch as the Epic — feature/KBT-Exxx-...>"
)
```

The Feature's `branch` field is set to the same branch as the parent Epic — there is **one branch per Epic-execution**, regardless of how many child Features it contains. This keeps the diff cohesive for review.

#### 4A.2-new.b: Walk the Feature's Tasks

For each Task on the Feature (where `IssueTask.IssueId == FeatureId`):

**Start:**
```
MCP: mcp__kanbantic__update_task_status(issueId: <FeatureId>, taskId, status: "InProgress")
```

**Implement:** Read task + Feature description + Epic's KnowledgeExtraction entry for this Phase. Write the code.

**Complete:**
```
MCP: mcp__kanbantic__update_task_status(issueId: <FeatureId>, taskId, status: "Done")
MCP: mcp__kanbantic__add_discussion_entry(
  issueId: <FeatureId>,
  content: "**Task [title] completed.**\n\nChanges:\n- [files changed]\n\nVerification:\n- [build/test results]",
  entryType: "Comment"
)
```

Commit per Task or per logical group, attributed to the Feature in the commit message:

```bash
git add <files>
git commit -m "<type>(<Feature-Code>): <task description>"
```

#### 4A.2-new.c: Mark Feature as Done

When all Tasks of the Feature are `Done` or `Cancelled`:

```
MCP: mcp__kanbantic__update_issue_status(issueId: <FeatureId>, status: "Done")
```

The backend's `OpenTasks` readiness check accepts `Done` and `Cancelled` per KBT-TRUL011. If a Cancelled Task lacks its Decision-justification, fix that first.

#### 4A.2-new.d: Per-Feature mini-review (KBT-PR200)

Optionally invoke `kanbantic-issue-review` scoped to this Feature for an early per-Feature code review:

```
Skill: kanbantic-issue-review
arg:   <FeatureId>
```

The review-skill auto-detects Feature-level (vs Phase-level / Epic-level) from the issue argument. Critical/Important findings → reviewer creates fix-tasks on the Feature and the skill rolls the Feature back to `InProgress`; once fixed, mark Done again.

This step is **recommended for Phases with ≥3 Features** to keep review-deltas small. For Phases with 1–2 Features, defer review to the Phase-level review in 4A.4.

When all Features in the Phase are `Done`, continue to 4A.3.

### 4A.3: Push Phase + Mark for Review

After all Tasks (legacy shape) or all Features (new shape) in the Phase are Done, **push the branch** so the reviewer can fetch it:

```bash
git push origin <branch>
```

Then mark the Phase ready for review:
```
MCP: mcp__kanbantic__mark_phase_for_review(issueId: <EpicId>, phaseId)
```

### 4A.4: Request Code Review

Invoke `kanbantic-issue-review` to review the Phase (which also handles merge/close on the final approve):
```
Skill: kanbantic-issue-review
arg:   <PhaseId>  (or <EpicId> for the final whole-Epic review)
```

For new-shape Phases where each Feature was already mini-reviewed in 4A.2-new.d, the Phase-level review is a **lightweight coherence check** — the reviewer verifies that the Features in this Phase work together (no integration-gaps) and skips per-Task code-walk.

### 4A.5: Handle Review Result

- **Approved**: proceed to next Phase (unlock via 4A.1, repeat 4A.0–4A.4)
- **Rejected**: read rejection reason, pick up the fix-tasks the reviewer added (on the Phase or on individual Features), fix, commit, push, re-submit

### 4A.6: Conventional commits

Use conventional-commit types in commit messages:
- `feat` — new functionality
- `fix` — bug fix (use for Bug issues)
- `refactor` — refactor without behavior change
- `docs` — documentation only
- `test` — tests only
- `chore` — infrastructure / tooling

For new-shape Epics, attribute commits to the Feature whose Task is being implemented:
```
git commit -m "feat(KBT-F262): add Issue.PhaseId column + EF migration"
```
For legacy-shape Epics, attribute to the Epic:
```
git commit -m "feat(KBT-E059): add Prepared status to IssueStatus enum"
```

## Step 4B: Execute Tasks Directly (Features / Bugs)

Use this step for **Features** and **Bugs** that do NOT have an Implementation Plan.

<IMPORTANT>
Before starting any task, verify the issue is **InProgress**. If not, go back to Step 2 and claim it first.
</IMPORTANT>

### 4B.1: Create Tasks (if none exist)

If the issue has no tasks yet, analyze the issue description, specifications, and discussion entries, then create tasks:

```
MCP: mcp__kanbantic__add_task(
  issueId: <id>,
  title: "<action-oriented task title>",
  description: "<what to do>",
  priority: "High" | "Medium" | "Low"
)
```

### 4B.2: Execute Tasks

For each task:

**Start:**
```
MCP: mcp__kanbantic__update_task_status(issueId, taskId, status: "InProgress")
```

**Implement:**
- Read the task description and relevant discussion entries
- Write the code
- Run build/test commands to verify

**Complete:**
```
MCP: mcp__kanbantic__update_task_status(issueId, taskId, status: "Done")
MCP: mcp__kanbantic__add_discussion_entry(
  issueId,
  content: "**Task [title] completed.**\n\nChanges:\n- [files changed]\n\nVerification:\n- [build/test results]",
  entryType: "Comment"
)
```

**Commit after each task or logical group (conventional commits):**
```bash
git add <specific files>
git commit -m "<type>(<issue-code>): <task description>"
```

### 4B.3: Push Branch

After all tasks are Done, push the branch so the reviewer can fetch it:
```bash
git push origin <branch>
```

## Step 5: Update Knowledge Base

After all phases are implemented (before Step 6), update the project knowledge:

### 5a: Correct Outdated Patterns

If any Toolkit pattern was incorrect or outdated during implementation:
```
MCP: mcp__kanbantic__update_toolkit_item(id, title, content: "<corrected pattern>")
```

### 5b: Add New Discoveries

If you discovered new reusable patterns, gotchas, or rules during implementation:
```
MCP: mcp__kanbantic__create_toolkit_item(
  workspaceId: <id>,
  category: "Pattern" | "Gotcha" | "Rule",
  title: "<descriptive name>",
  content: "<pattern with file paths, code example, when to use>"
)
```

### 5c: Deactivate Obsolete Knowledge

If a pattern no longer applies:
```
MCP: mcp__kanbantic__update_toolkit_item(id, title, content, isActive: false)
```

**Guidelines:**
- Only store patterns reusable across multiple issues
- Include file paths and code examples in every Toolkit item
- Update rather than duplicate — search existing items first
- Skip this step if nothing new was discovered (don't force it)

### 5d: Record Knowledge Traceability

Add a discussion entry documenting which Toolkit/Library items were consumed during execution and any changes made:

```
MCP: mcp__kanbantic__add_discussion_entry(
  issueId: <id>,
  content: <knowledge summary>,
  entryType: "KnowledgeExtraction"
)
```

Use this template:

```markdown
## Knowledge Trace — Execution

### Consumed (knowledge used during implementation)
- `KBT-PATN001` — ABP AppService pattern (Phase 1, 2)
- `KBT-GTCH003` — DI scoping in MCP tools (Phase 2)

### Produced (new discoveries during implementation)
- `KBT-PATN008` — SignalR hub registration pattern (new)

### Corrected
- `KBT-PATN002` — File path was outdated, updated to new location

### No knowledge changes
(Use this line instead if nothing was consumed, produced, or corrected)
```

This creates traceability between the issue and knowledge base — visible in the issue's discussion timeline in the Kanbantic UI.

## Step 6: Run Local E2E Tests (auto-trigger)

After all tasks are Done and knowledge is updated, run the local E2E test suite before transitioning to Review.

### 6a: Check if skill exists

```
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, category: "Skill", search: "test-e2e-local")
```

If no `/test-e2e-local` Toolkit Skill exists in the workspace, **skip this step** and proceed to Step 7.

### 6b: Invoke the skill

Load the Toolkit Skill content and execute the flow it describes:
- Issue code: use the current issue code (e.g., `KBT-F122`)
- Default test suite: `e2e/crud-functional.spec.ts`
- No `--with-mcp` unless the issue touches MCP tools

### 6c: Handle results

**If E2E tests pass:**
- Add discussion entry: "Local E2E tests passed — proceeding to Review pre-conditions."
- Continue to Step 7

**If E2E tests fail:**
- Issue remains **InProgress** (do NOT transition to Review)
- Add discussion entry with failure details
- Create fix tasks based on the failure details:
  ```
  MCP: mcp__kanbantic__add_task(issueId, title: "Fix E2E failure: {test name}", description: "{error details}", priority: "High")
  ```
- Report to user: "E2E tests failed. Created fix tasks. Issue remains InProgress."
- After fix tasks are completed, re-run this step

**If E2E infrastructure is unavailable** (PostgreSQL not installed, ports permanently occupied):
- Add discussion entry: "Local E2E tests skipped — {reason}"
- Warn the user and proceed to Step 7 (do not block the workflow)

## Step 7: Verify Review Pre-conditions + Transition

<HARD-GATE>
Review transition is allowed **only** when all of the following are true. If any condition fails, the issue stays `InProgress`, and the skill reports the failing condition to the user. NO "door-drukken".

1. Every task on the issue has status `Done` or `Cancelled`.
2. **Test-policy coverage** (Regel E / KBT-F442) — per the `frozenPolicy` loaded in Step 3c:
   a. For each level with `Applicability = Vereist`: the count of test cases with status `Passed` at that level must be **≥ `frozenPolicy[level].min`**. A level with zero test cases fails this check even if no test cases have status `Failed` — missing coverage is a blocker, not just failing tests.
   b. For each level with `Applicability = N.v.t.`: no minimum count is required; the N.v.t.-rationale in `frozenPolicy[level].reason` must be non-empty (verified at prepare time; warn if missing).
   c. No test case at any level may have status `Failed` or `Blocked`.
3. Readiness checks on the issue still pass (`isReadyToClaim` was true at claim time; re-check in case specs/test cases were added mid-flight).
</HARD-GATE>

### 7a: Verify tasks

```
MCP: mcp__kanbantic__list_tasks(issueId)
```

Every task must be `Done` or `Cancelled`. For every `Cancelled` task, verify a Decision discussion entry recorded the justification (required per Cancelling section below).

### 7b: Verify test cases

```
MCP: mcp__kanbantic__list_test_cases(issueId)
```

Every returned test case must have `status: "Passed"`. If any are in `Draft`, `Ready`, `Failed`, `Blocked`, or `Skipped`, stop and report:

> "Cannot transition to Review. Test cases still missing a `Passed` status:
> - `KBT-TC1234` — Draft
> - `KBT-TC1235` — Failed
>
> Run the test cases (manually or via the E2E skill), record results via `update_test_case(status: \"Passed\")` after verification, then re-run this step."

### 7c: Re-check readiness

```
MCP: mcp__kanbantic__get_issue(issueId)
```

Confirm `isReadyToClaim` is still true (or that soft-override is acceptable). Report to the user if checks degraded.

### 7d: Promote linked user stories to `Implemented` (KBT-RL064 Invariant 1)

Every user story linked to this issue (via `userStoryId` or the issue's
`linkedUserStories` collection) MUST flip from `NotImplemented` to
`Implemented` here — after tasks are Done and tests Passed but **before** the
Review transition. This is the first half of the `update_validation_status`
lifecycle; the second half (`Implemented → Validated`) runs in
`kanbantic-issue-review` Step 7.5b after final-approve.

```
# Skip silently if the issue has no linked user stories.
MCP: mcp__kanbantic__get_user_story_with_requirements  // per linked story
MCP: mcp__kanbantic__update_validation_status(
  userStoryId,
  status: "Implemented"
)
```

Failure of `update_validation_status` here is logged as a `Comment`
discussion entry on the issue and does NOT block the Review transition — the
data-integrity fix is best-effort and a follow-up Bug captures any failures.

### 7e: Transition

```
MCP: mcp__kanbantic__update_issue_status(issueId, status: "Review")
```

## Step 8: Final Report + Handoff

Report:
**"Implementation complete for [ISSUE CODE]. Status: Review.**

**Summary:**
- [N] tasks completed ([M] cancelled with justification)
- [N] commits on `feature/<issue-code>-<slug>`
- [N] test cases Passed
- Knowledge: [N] Toolkit items created/updated (if any)

**Next step:** Invoke `kanbantic-issue-review` to run code review, merge, close, and extract final knowledge."

Do **not** merge, do **not** set the issue to Done, do **not** create a PR — those are `kanbantic-issue-review`'s responsibilities.

## Subagent Mode

For large plans, you can dispatch implementer subagents per task. Use the template at `implementer-prompt.md` in this directory.

When using subagents:
1. Dispatch one subagent per task using the Agent tool
2. Review the subagent's output
3. Update task status in Kanbantic based on results
4. Commit + (for Epics) request review via 4A.3/4A.4

## Cancelling Tasks or Issues

<HARD-GATE>
When cancelling a task or issue, you MUST record the justification in a discussion entry BEFORE changing the status. Cancellation without recorded justification is NOT allowed.
</HARD-GATE>

**Cancelling a task:**
```
MCP: mcp__kanbantic__add_discussion_entry(
  issueId,
  content: "**Task [title] cancelled.** Reason: [clear justification why this task is no longer needed]",
  entryType: "Decision"
)
MCP: mcp__kanbantic__update_task_status(issueId, taskId, status: "Cancelled")
```

**Cancelling an issue:**
```
MCP: mcp__kanbantic__add_discussion_entry(
  issueId,
  content: "**Issue [code] cancelled.** Reason: [clear justification — e.g. superseded by X, no longer relevant because Y, duplicate of Z]",
  entryType: "Decision"
)
MCP: mcp__kanbantic__update_issue_status(issueId, status: "Cancelled")
```

## Key Principles

- **Follow the plan** — implement exactly what's specified
- **One task at a time** — don't skip ahead
- **Verify before completing** — build and test after each task
- **Commit frequently** — one commit per task or logical unit, conventional commits
- **Push per phase (Epics) or at end (Feature/Bug)** — never leave work only local
- **Update Kanbantic** — status changes and discussion entries for visibility
- **Justify cancellations** — always record why in a Decision discussion entry
- **Stop at Review** — merge/close/knowledge-finalize is `kanbantic-issue-review`'s job
- **Stop when blocked** — ask questions, don't guess
