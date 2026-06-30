---
name: kanbantic-issue-review
description: "Use after kanbantic-issue-execute marks an issue Review (or to run an early per-Feature mini-review during Epic execution). Runs code review against Kanbantic specs + test cases. Auto-detects review level (Feature / Phase / Epic — KBT-PR200, KBT-F250 v2.4.0): per-Feature mini-review during Epic-walk, per-Phase coherence-review, whole-Epic final review. On Feature/Phase approve: records approval, returns control to executing flow. On Epic/standalone approve: merges the feature branch to main, pushes, cleans up, transitions the issue to InDeployment (KBT-F236), and records an optional knowledge-extractie. On reject: leaves the issue on Review/InProgress with fix tasks."
---

# Kanbantic Issue Review

## Overview

Complete the Review → InDeployment lane transition (per KBT-RL053; backend auto-promotes to Done on merge or remains InDeployment until deploy-gate clears, KBT-F236). This skill:

1. Reviews completed implementation against Kanbantic specifications and test cases
2. Dispatches a reviewer subagent for categorized feedback
3. Approves or rejects the phase in Kanbantic
4. **On approve** — merges the feature branch to main, pushes, cleans up, transitions the issue to Done, and prompts for optional knowledge-extractie
5. **On reject** — records fix tasks and leaves the issue on Review for the implementer to iterate

**Principle:** Read specs from Kanbantic → Review code → Write feedback to Kanbantic → Merge / close / knowledge on positive verdict.

**Announce at start:** "I'm using the kanbantic-issue-review skill to review and close this issue."

## Checklist

1. **Load context** — issue, specifications, test cases, rules/patterns/gotchas
2. **Get diff** — what changed in this phase (or the whole issue for Feature/Bug)
3. **Dispatch reviewer** — subagent reviews against specs
4. **Record feedback** — discussion entry with categorized issues
5. **Decide** — approve or reject phase
6. **Verify final-approve gate** — merge only after last phase (Epic) or first approve (Feature/Bug)
7. **Merge** — `git merge --no-ff` to main, push, clean up feature branch
8. **Close issue** — transition to Done
9. **Knowledge-extractie (optional)** — toolkit items + document impacts + `KnowledgeExtraction` entry

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
   # Configure once, reuse for clone + the review's merge/push in this clone.
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
4. Ensure you're on the branch being reviewed (`git checkout <feature-branch>`)

<IMPORTANT>
- If no repository is configured in the workspace, the review still runs against the spec+diff artifacts in Kanbantic, but merge/close cannot execute. Warn the user and continue without Step 7–8.
- If no credential is configured, tell the user: "No repository credential found. Configure a PAT token via Workspace → Repositories → Credentials in the Kanbantic UI."
- If the repo is already cloned, ensure you're on the branch being reviewed before proceeding.
</IMPORTANT>

## Step 0.5: Worktree HARD-GATE (context-aware)

<HARD-GATE>
This gate is **context-aware** per the decision rule `shouldEnforceWorktreeGate({ hasGitRepo, touchesFilesystem })` in `plugin/scripts/gate-context.js` (KBT-F447). Evaluate it first:

- **No git repository in this environment** (`hasGitRepo: false` — Cowork/desktop, MCP-only run, or no repository configured per Step 0) → **skip the gate**. The review still runs against the spec + diff artifacts in Kanbantic; merge/push simply cannot and will not execute (warn the user, skip Step 7–8). There is no main-tree/worktree distinction to protect.
- **In a git repo but this run is MCP-only** (`touchesFilesystem: false` — an artifact-only review with no merge/push) → **skip the gate**.
- **In a git repo AND the run touches the filesystem/code** (`hasGitRepo: true && touchesFilesystem: true` — i.e. the review will `git merge --no-ff` / `git push origin main`) → **enforce the gate** (below).

When you **skip** the gate, log it as a Comment discussion-entry — a mirror of the existing `KANBANTIC_SKIP_GIT_SYNC` opt-out pattern (KBT-F238):

```
MCP: mcp__kanbantic__add_discussion_entry(issueId, entryType: "Comment",
  content: "Worktree HARD-GATE skipped: <no git repository in this environment | MCP-only review, no merge/push>. Decision per shouldEnforceWorktreeGate (gate-context.js, KBT-F447). Mirrors the KANBANTIC_SKIP_GIT_SYNC opt-out.")
```

<CRITICAL>
The merge/push path is real code work in a repo. **Whenever a merge or push will run, the gate stays fully enforced — no opt-out, no override (KBT-BD155 scope boundary).** The relaxation above applies *only* to the no-repo / MCP-only-review paths; it must never weaken the merge-in-a-repo path (parallel-agent safety, KBT-TRUL004). If in doubt about whether a merge will run, enforce.
</CRITICAL>

When the gate is **enforced**, verify you are **not** in the main working tree. Agents often run in parallel on the same clone; review performs `git merge --no-ff` and `git push origin main` — working in the main tree here risks overwriting concurrent changes or pushing unrelated state.

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

`<ISSUE-CODE>` is the code of the issue this skill is reviewing (e.g. `KBT-F123`).

**No opt-out, no override on the enforced path.** This is a working-tree safety check, not a readiness-artifact check. The merge step specifically re-enters the main branch to integrate; doing that from a worktree keeps the main clone untouched by the reviewer's local state.

If the gate is enforced and the check passes (paths differ → you are in a worktree), continue silently.
</HARD-GATE>

## Step 1: Load Context

```
MCP: mcp__kanbantic__get_issue(issueId)
```

Load the issue first so the status gate below can run on the actual current status, not a stale assumption.

## Step 1.5: Review-level detection (KBT-PR200, KBT-F250)

Before status-gating, decide which **review-level** this invocation is for. The skill supports three levels for new-shape Epics plus the legacy Phase + Epic levels:

| Argument resolves to | Level | Where it fires |
|---|---|---|
| `Issue` with `Type == Feature` AND `PhaseId != null` (child-Feature under an Epic's Phase) | **Feature** | During Epic-walk, after a child-Feature's Tasks are all Done. Status: `InProgress` of the Feature. |
| `Phase` ID (resolves to an `IssuePhase`, not an `Issue`) | **Phase** | After all Features in the Phase are Done. Status: parent Epic on `InProgress`. |
| `Issue` with `Type == Epic` | **Epic** | At the end of the whole Epic walk. Status: `Review`. |
| `Issue` with `Type == Feature` AND `PhaseId == null` (standalone Feature) | **Standalone** | Status: `Review`. Acts like an Epic-level review for a single-Feature issue. |
| `Issue` with `Type == Bug` | **Bug** | Status: `Review`. Acts like an Epic-level review for the bug. |

Set `reviewLevel` from this lookup. Each level has different gating, different mutations, and different terminal behavior — annotated `(Feature)`, `(Phase)`, `(Epic / standalone / Bug)` in subsequent steps.

For backward compatibility with **legacy-shape Epics** (Phase → Tasks direct, no intermediate Features): only Phase-level and Epic-level levels apply. Feature-level review is meaningless for legacy Epics because there are no child-Features.

## Step 1.6: Status HARD-GATE (per level)

<HARD-GATE>
The review skill's scope is per-level:

**Feature-level review:**
- Required status: Feature is on `InProgress` (sub-claimed during Epic-walk) **OR** `Review` (rare; only if execute already promoted it).
- Parent Epic is on `InProgress` (the Epic-walk is in progress).
- Other statuses → STOP. Report: "Feature-level review only valid while the Feature is being walked (InProgress) or just after (Review)."

**Phase-level review:**
- Parent Epic must be on `InProgress`.
- Phase must be on `ReadyForReview` (set by `mark_phase_for_review`).
- Other statuses → STOP. Report: "Phase-level review only valid when the Phase is ReadyForReview and its Epic is InProgress."

**Epic / standalone-Feature / Bug review:**
- Required status: `Review`.
- Other statuses → STOP per the legacy gate below.
</HARD-GATE>

For Epic / standalone-Feature / Bug review, the legacy gate applies:

- If `status == "Review"` → continue silently.
- If `status == "New"` → STOP. Report: "Issue [CODE] is still in status `New`. Run `kanbantic-issue-triage [CODE]` first to move it to Triaged."
- If `status == "Triaged"` → STOP. Report: "Issue [CODE] is Triaged but not yet executed. Run `kanbantic-issue-prepare [CODE]` (if artifacts missing) and `kanbantic-issue-execute [CODE]` before review can run."
- If `status == "InProgress"` → STOP. Report: "Issue [CODE] is still `InProgress`. `kanbantic-issue-execute` must transition it to Review before review can run."
- If `status == "Done"` → STOP. Report: "Issue [CODE] is already `Done`. No review needed — this skill is an idempotent no-op here."
- If `status == "Cancelled"` → STOP. Report: "Issue [CODE] was `Cancelled`. Nothing to review."

**On any STOP**: exit the skill immediately. Do **NOT** dispatch the reviewer subagent (Step 3), do **NOT** create discussion entries (Step 4), do **NOT** attempt a status transition. This gate prevents resource-waste and misleading audit-trail entries on issues that are not in the right lane.

No opt-out, no override — the skill's scope is by definition Review → InDeployment (Epic / standalone / Bug) or per-level intermediate review for Epic-walks.

## Step 1b: Load Review Context

```
MCP: mcp__kanbantic__list_specifications(workspaceId)
MCP: mcp__kanbantic__list_test_cases(workspaceId, issueId)
MCP: mcp__kanbantic__list_discussion_entries(issueId)
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, category: "Rule")
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, category: "Pattern")
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, category: "Gotcha")
```

Build a requirements checklist from specifications and test cases.

**Version context (KBT-F318):** capture the issue's assigned Version so it can be surfaced in the merge-summary. From the `get_issue` response (Step 1) read `VersionId`; resolve its name + status via `list_versions(workspaceId)` (or `issue_version_lookup`). Store as `versionContext = { name, status, applicationName }`. If the issue has no Version, record `versionContext = "—"` (backlog). The Version name is shown in the merge commit message (Step 7) and the final report (Step 10).

**Test-policy (Regel E / KBT-F442):** From the discussion entries, locate the entry whose content starts with `## Test-policy (bevroren bij claim_issue — KBT-F442 / Regel E)`. Parse the table to extract, per level (Unit / Integration / E2E): Applicability (`Vereist` / `N.v.t.`) + Minimum count + N.v.t.-rationale. Also count the actual `Passed` test cases per level from `list_test_cases`. Store as `frozenPolicy` with actual counts.

If no test-policy entry is found for a Feature / Bug issue, treat all three levels as Vereist/min=1 and flag the absence as a Critical review issue (the prepare-step was incomplete).

Include Rules, Patterns, and Gotchas in the review context — the reviewer should verify code adheres to project rules and follows established patterns.

## Step 2: Get Git Diff (scope by review-level)

The diff scope depends on `reviewLevel`:

**Feature-level** — diff scoped to the Feature's commits only:
```bash
# Find the SHA where this Feature's first Task moved to InProgress (commit prefix matches Feature-Code)
FEATURE_FIRST=$(git log --oneline | grep -E "\(<FEATURE-CODE>\)" | tail -1 | awk '{print $1}')^
git diff $FEATURE_FIRST..HEAD --stat
git diff $FEATURE_FIRST..HEAD
```

If commits are not consistently prefixed, fall back to the diff between the parent-Epic-branch's previous-Feature endpoint and current HEAD.

**Phase-level** — diff for this phase (from phase start to current HEAD):
```bash
git log --oneline -20
git diff <phase-start-sha>..HEAD --stat
git diff <phase-start-sha>..HEAD
```

**Epic / standalone-Feature / Bug review** — diff against main:
```bash
git diff main..HEAD --stat
git diff main..HEAD
```

For new-shape Epics where each Feature was already mini-reviewed at Feature-level, the Epic-level review is a **lightweight cross-Phase coherence check** — focus on integration points between Phases, not per-Task code-walk.

## Step 3: Dispatch Reviewer Subagent

Use the reviewer template at `reviewer-prompt.md` in this directory.

Dispatch via Agent tool with `subagent_type: "general-purpose"`:
- Fill in the issue details, specifications, test cases, and diff
- The reviewer returns categorized feedback

## Step 4: Record Feedback in Kanbantic

```
MCP: mcp__kanbantic__add_discussion_entry(
  issueId,
  content: <review feedback in Markdown>,
  entryType: "Comment"
)
```

Feedback format:
```markdown
## Code Review — Phase: [Phase Name]

### Strengths
- [What was done well]

### Issues

**Critical** (must fix before approval):
- [Issue description + file:line + recommendation]

**Important** (should fix):
- [Issue description + recommendation]

**Minor** (suggestions):
- [Nice-to-have improvements]

### Requirements Checklist
- [x] KBT-PR001: [requirement title] — implemented
- [ ] KBT-PR002: [requirement title] — not found
- [x] KBT-TC001: [test case title] — covered

### Verdict: APPROVE / REJECT
```

## Step 5: Approve or Reject (per level)

The approve/reject mechanism depends on `reviewLevel`:

### 5a: APPROVE — if no Critical or Important issues

**Feature-level (KBT-PR200):** No `approve_phase` call (that mechanism is Phase-scoped). Instead, record an `ApprovedWithComments` / `Approved` ReviewApproval scoped to the Feature **and** transition the Feature back to `Done`:
```
MCP: mcp__kanbantic__approve_review(
  issueId: <FeatureId>,
  verdict: "Approved" | "ApprovedWithComments",
  reason: <≥20-char Feature-review summary>
)
MCP: mcp__kanbantic__update_issue_status(issueId: <FeatureId>, status: "Done")
```
Then **STOP** — no merge, no further steps. Control returns to the executing skill, which continues with the next Feature in the Phase.

**Phase-level:**
```
MCP: mcp__kanbantic__approve_phase(issueId: <EpicId>, phaseId)
```
Then **STOP** unless this was the last Phase of the Epic; the executing skill unlocks the next Phase. Whole-Epic merge happens in a separate review-invocation at Epic-level.

**Epic / standalone-Feature / Bug:**
```
MCP: mcp__kanbantic__approve_phase(issueId, phaseId)   // for Epics with phases
```
Or — for standalone Features and Bugs where there is no phase — skip directly to Step 6 (final-approve gate).

Proceed to Step 6 (which routes Phase-level back to STOP and Epic/standalone/Bug to Step 7).

### 5b: REJECT — if Critical or Important issues found

<IMPORTANT>
Rejection MUST always include a clear justification. The reason is recorded as a discussion entry and must explain what failed and what needs to change.
</IMPORTANT>

Create fix tasks **on the right entity**:

- **Feature-level reject**: fix-tasks on the Feature; transition Feature back to `InProgress`:
  ```
  MCP: mcp__kanbantic__add_task(issueId: <FeatureId>, title: "Fix: ...", priority: "High")
  MCP: mcp__kanbantic__update_issue_status(issueId: <FeatureId>, status: "InProgress")
  ```
- **Phase-level reject**: fix-tasks on the Epic (or on individual Features in the Phase if the issue is per-Feature), then `reject_phase`:
  ```
  MCP: mcp__kanbantic__add_task(issueId: <EpicId or FeatureId>, title: "Fix: ...", priority: "High")
  MCP: mcp__kanbantic__reject_phase(issueId: <EpicId>, phaseId, reason: "...")
  ```
- **Epic / standalone-Feature / Bug reject**: fix-tasks on the issue, then `reject_phase` on the issue's main phase:
  ```
  MCP: mcp__kanbantic__add_task(issueId, title: "Fix: ...", priority: "High")
  MCP: mcp__kanbantic__reject_phase(issueId, phaseId, reason: "...")
  ```

<HARD-GATE>
On REJECT the skill stops here. Do NOT proceed to Step 6/7/8/9. No merge, no Done-transition, no knowledge-extractie. The issue (or Feature) stays on `Review` / `InProgress`, and the implementer runs `kanbantic-issue-execute` again to pick up the fix tasks.
</HARD-GATE>

Report:
**"Review rejected for [ISSUE CODE / FEATURE CODE]. [N] fix tasks created. Implementer can resume via `kanbantic-issue-execute` to address them."**

## Step 6: Verify Final-Approve Gate (per level)

<HARD-GATE>
The merge step only runs at the **final** approval of the whole issue. Intermediate per-Feature and per-Phase approvals show progress but never trigger a merge.

- **Feature-level**: STOP after Step 5a — no merge, no status-transition past `Done` for this Feature. Control returns to the executing skill.
- **Phase-level**: STOP after Step 5a `approve_phase` unless ALL phases of the Epic are now `Approved`. If so, the next review-invocation at Epic-level handles the merge — do not merge from this Phase-level invocation.
- **Epic**: merge only when **every** phase in the implementation plan has status `Approved`. Re-run `get_implementation_plan(issueId)` and verify all phases are approved.
- **Standalone Feature / Bug**: the first `approve_phase` on the issue-level is also the final approve — proceed to merge.

If this is **not** the final approve, report:
> "Approval recorded for [LEVEL]: [CODE]. Remaining: [list]. No merge yet."

Then STOP. Do NOT proceed to Step 7/8/9.
</HARD-GATE>

## Step 6.5: Deferred-Cancel Scan (Epic final-approve only — KBT-F450)

**Only runs when this is the final Epic-level approve (Step 6 → "Epic" path).** Skip for Feature-level, Phase-level, and Standalone-Feature/Bug reviews.

Scan for cancelled child Features/Bugs that have deferred work without a tracked follow-up issue:

```
MCP: mcp__kanbantic__list_issues(workspaceId, parentIssueId: <epicId>, status: "Cancelled")
```

For each cancelled child where `followUpIssueId` is null:

```
MCP: mcp__kanbantic__list_discussion_entries(issueId: <childId>)
```

Look for a Decision-entry whose content contains any of these keywords (case-insensitive):  
`deferred`, `vervolgwerk`, `follow-up`, `followup`, `uitgesteld`, `later`, `postponed`

If a deferral keyword is found AND `followUpIssueId` is null → flag as a **Critical issue** in the reviewer output:

```
⚠️ UITGESTELD WERK ZONDER FOLLOW-UP — KBT-F450
[childCode] ([childTitle]): geannuleerd met reden die uitstel aangeeft maar heeft geen follow-up issue gelinkt.
Actie vereist (kies één):
  A) Link een follow-up issue: update_issue_status(issueId: "[childCode]", status: "Cancelled", reason: "<reden>", followUpIssueId: "<id van follow-up issue>")
  B) Override NoUntrackedDeferrals gate bij Epic-Done: update_issue_status(issueId: "[epicCode]", status: "Done", overrideReason: "<≥20-char reden waarom geen follow-up nodig is>")
```

This check mirrors the `NoUntrackedDeferrals` server-side readiness gate (KBT-F450). Surfacing it here before merge prevents the Done transition from failing after an otherwise-successful review.

If no untracked deferrals are found → continue silently.

## Step 7: Merge + Push + Cleanup

Execute the merge to main with a no-ff merge commit so the merge-historie zichtbaar blijft:

```bash
git checkout main
git pull origin main
git merge --no-ff <feature-branch> -m "Merge <ISSUE-CODE> (<versionContext.name>): <short summary>"
git push origin main
```

Include the Version name (`versionContext` from Step 1b) in the merge commit summary so the merge-historie ties the change to its version-milestone (KBT-F318). For a backlog issue (`versionContext == "—"`) omit the parenthetical.

Then clean up the feature branch:

```bash
git branch -d <feature-branch>           # local delete (blocking if it fails)
git push origin --delete <feature-branch> # remote delete (warning on failure, not blocker)
```

**Foutgevallen:**
- **Merge-conflict** → skill stops, lists the conflicting files, adds a Comment discussion entry to the issue explaining which files conflicted and that the issue stays on `Review`. The implementer resolves conflicts manually on the feature branch, pushes, and re-runs `kanbantic-issue-review`.
- **Push rejection** (branch protection, non-fast-forward, permissions) → skill reports the exact git error, adds a Comment discussion entry, and does **not** transition the issue to Done. No status change until merge + push both succeed.
- **Local branch delete failure** → blocker; investigate (usually uncommitted changes). Do not proceed.
- **Remote branch delete failure** → warning only (someone else may have deleted it, or branch protection prevents it). Log the warning in the issue and proceed to Step 8.

Use `--no-ff` as the default merge strategy. Do NOT use `--squash` or `--rebase` unless the workspace explicitly opts in via a Toolkit rule (auto-merge-beleid valt onder Execution Hardening, v0.6.0).

## Step 7.5: Record Review Approval

Before transitioning to Done, persist a `ReviewApproval` row so the
`HasReviewApproval` readiness-gate flips green. The approval captures the
reviewer-principal, verdict, and a written summary (≥20 chars) — the
audit-trail that KBT-F170 / KBT-PR191 made mechanically required after the
KBT-F156 / KBT-B175 incidents. Without this row the next step's
`update_issue_status(Done)` will fail with `ReadinessGateBlocked` /
`HasReviewApproval not met`.

```
MCP: mcp__kanbantic__approve_review(
  issueId,
  verdict: "Approved" | "ApprovedWithComments",
  reason: <≥20-char review summary — usually the body of the Decision entry from Step 4>
)
```

- Pick `Approved` for clean reviews, `ApprovedWithComments` when nits or
  follow-up tasks were noted but the issue is still ready for Done.
- Reuse the review-summary written in Step 4 (the Critical/Important/Minor
  verdict block) so the approval row and the discussion-entry stay in sync.
- The reason is required and validated to ≥20 characters after trim.

If `approve_review` fails (e.g. the issue is no longer in `Review` status
because someone bounced it back), stop the skill and report the error. Do
NOT proceed to Step 8 — the gate cannot clear without a successful approval.

### Step 7.5b: Promote linked user stories to `Validated` (KBT-RL064 Invariant 1)

After a successful `approve_review` on the **Epic / standalone-Feature / Bug**
final-approve path (this Step 7.5), promote every user story linked to the
issue from `Implemented` to `Validated`. This is the second half of the
`update_validation_status` lifecycle — the first half runs in
`kanbantic-issue-execute` Step 7d (NotImplemented → Implemented).

Do **NOT** call this from the Feature-level mini-review approve in Step 5a
(line ≈239) — per-Feature mini-approves are not the canonical promotion
point. Validation cascades up to the final Epic / standalone approve only.

```
# Skip silently if the issue has no linked user stories.
MCP: mcp__kanbantic__get_user_story_with_requirements  // per linked story
MCP: mcp__kanbantic__update_validation_status(
  userStoryId,
  status: "Validated"
)
```

Failure of `update_validation_status` is logged as a `Comment` discussion
entry on the issue and does NOT block the merge in Step 7 — the data-integrity
fix is best-effort at this stage and a follow-up issue captures any failures.

### Fallback if `approve_review` is unavailable (KBT-B200)

If `tools/list` does NOT include `approve_review` in this MCP session (e.g.
because the plugin proxy is connected to a stale or partial backend bundle),
do **not** silently leave the issue on Review. The original failure mode
(2026-05-02, KBT-B200) was an agent stuck on Review with no automated path
forward. Required actions:

1. **Confirm drift** — run `npm run check:drift --prefix C:/GitHub/kanbantic-claude-plugin`
   (or invoke `node plugin/scripts/check-bundle-tool-drift.js` directly with
   `KANBANTIC_MCP_URL` + `KANBANTIC_API_KEY` set). The script exits non-zero
   and names the missing tool if drift is real.
2. **Escalate** — either (a) ask the operator to restart the host so the
   plugin re-fetches `tools/list`, or (b) log a new Bug referencing KBT-B200
   and the missing tool. Do not invent a workaround that bypasses
   `approve_review`; that defeats the KBT-F170 / KBT-PR191 audit-trail
   intent.
3. **Stop the skill** at this step — leave the issue on Review, record a
   `Comment` discussion entry with the drift evidence and the escalation
   chosen, and exit.

The drift detector is also runnable on demand against any backend by setting
`KANBANTIC_MCP_URL` (defaults to `https://kanbantic.com/mcp`).

## Step 8: Transition to InDeployment

<IMPORTANT>
Step 8 runs only after Step 7 completed successfully (merge **and** push both succeeded; local branch delete succeeded; remote delete is a warning-only) **and** Step 7.5 recorded a ReviewApproval row.
</IMPORTANT>

Since plugin **v2.3.0** (KBT-F236) the review-skill transitions the issue to `InDeployment`, not directly to `Done`. The Done-transition is a separate operational step that runs after staging+production deploy verification.

```
MCP: mcp__kanbantic__update_issue_status(issueId, status: "InDeployment")
```

`Review → InDeployment` has no readiness-gate at the issue layer (KBT-RL053): the merge to main itself is the implicit gate, and Step 7 already verified both the merge and the push succeeded. The transition should always succeed unless the issue was bounced back to a different status by another agent in parallel.

After this transition, surface the deploy-instructions to the caller:

> **Issue [CODE] merged + transitioned to `InDeployment`.**
> Next operational steps (manual until KBT-INI032 Epic D ships `GateEvaluationService`):
> 1. Trigger the staging deploy webhook for the workspace.
> 2. Smoke-test against `https://staging.<domain>` to verify the change is live and behaves correctly.
> 3. Trigger the production deploy webhook.
> 4. Smoke-test against production.
> 5. Manually transition the issue to `Done` via `update_issue_status(status: "Done")` — the standard Done-readiness gate (all test cases Passed, all specs Approved, no pending Document Impacts, etc.) still applies.

If the deploy fails: transition back to `Review` (`update_issue_status(status: "Review")`) so the implementer can pick up fix-tasks. **Do NOT** transition `InDeployment → Cancelled` directly — the Domain layer blocks that transition (KBT-RL053); cancel from Review (pre-deploy rollback) or from Done (post-deploy hotfix-rollback).

## Step 9: Knowledge-Extractie (optional)

After the issue is Done, prompt the reviewer for knowledge to capture. This step is **optional** — if the reviewer has nothing to add, skip the MCP calls.

### 9a: Toolkit items

Ask: **"Heb je patterns, gotchas of rules geleerd die de moeite waard zijn om vast te leggen?"**

If yes, per item collect:
- `title` (descriptive)
- `category` — `Pattern` | `Gotcha` | `Rule`
- `content` — Markdown with file paths, code example, when to use

Then:
```
MCP: mcp__kanbantic__create_toolkit_item(
  workspaceId: <id>,
  category: "Pattern" | "Gotcha" | "Rule",
  title: <title>,
  content: <content>
)
```

If a pattern already exists but is outdated, prefer `update_toolkit_item` (search first with `list_toolkit_items(search: ...)`).

### 9b: Document impacts

Ask: **"Zijn er Library-docs die door dit werk stale zijn geworden?"**

If yes, collect the document IDs (or names → look up via `list_library_documents`) and a short reason per doc:

```
MCP: mcp__kanbantic__register_document_impact(
  workspaceId: <id>,
  issueId: <issue ID>,
  documentIds: "<id1>,<id2>",
  reason: "<why these docs need review>"
)
```

### 9c: KnowledgeExtraction discussion entry

Summarize what was captured (or note "nothing captured" if both 9a and 9b were skipped):

```
MCP: mcp__kanbantic__add_discussion_entry(
  issueId,
  content: <summary>,
  entryType: "KnowledgeExtraction"
)
```

Template:

```markdown
## Knowledge Trace — Review

### Toolkit items added
- `KBT-PATN012` — <title> (new)
- `KBT-GTCH008` — <title> (updated)

### Document impacts registered
- `<document name>` — <reason>

### Nothing new to capture
(Use this line when both 9a and 9b were skipped)
```

## Step 10: Final Report

Report:
**"Review + merge + close complete for [ISSUE CODE]. Status: Done.**

**Summary:**
- Verdict: APPROVE
- Version: `<versionContext.name>` (`<versionContext.status>`) — or "— (backlog)"
- Merged: `<feature-branch>` → `main` (`<merge commit sha>`)
- Feature branch deleted (local + remote)
- Knowledge: [N] toolkit items, [N] document impacts (or "none")

**Issue closed."**

## Key Principles

- **Specs are the checklist** — review against Kanbantic specifications, not just "does it look good"
- **Categorize issues** — Critical / Important / Minor
- **Auto-detect review-level** — Feature / Phase / Epic / Standalone-Feature / Bug — no operator-input needed (KBT-PR200)
- **Create fix tasks on reject** — don't just reject, tell them what to fix; fix-tasks land on the **right** entity (Feature for Feature-level, Epic for Phase/Epic-level)
- **Justify rejections** — always provide a clear, detailed reason explaining what failed
- **Push back if wrong** — if reviewer feedback is incorrect, explain why with evidence
- **Merge only after final approve** — no half-merged Epics; Feature-level and Phase-level approvals never merge
- **InDeployment-transitie alleen na merge + push** — never set `InDeployment` on a local-only merge
- **Approval before Done** — every Review→InDeployment→Done flow is preceded by a `ReviewApproval` row via `approve_review` (KBT-F170 / KBT-PR191)
- **Per-Feature mini-review keeps deltas small** — review-skill is meant to be re-invoked at multiple levels during a single Epic-walk, not just once at the end
- **Knowledge is optional, not forced** — "nothing to capture" is a valid answer
- **Record everything** — all feedback and decisions go to Kanbantic discussion
