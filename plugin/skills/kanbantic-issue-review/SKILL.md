---
name: kanbantic-issue-review
description: "Use after kanbantic-issue-execute marks an issue Review (or to run an early per-Feature mini-review during Epic execution). Runs code review against Kanbantic specs + test cases. Auto-detects review level (Feature / Phase / Epic — KBT-PR200, KBT-F250 v2.4.0): per-Feature mini-review during Epic-walk, per-Phase coherence-review, whole-Epic final review. On Feature/Phase approve: records approval, returns control to executing flow. On Epic/standalone approve: merges the feature branch to main, pushes, cleans up, transitions the issue to InDeployment (KBT-F236), and records an optional knowledge-extractie. On reject: leaves the issue on Review/InProgress with fix tasks."
---

# Kanbantic Issue Review

> **Canonieke werkwijze — Kanbantic Workflow v3.** "De Kanbantic Workflow" verwijst naar het Library-document *"Kanbantic Workflow — Plan van Aanpak (v3)"* (slug `kanbantic-workflow--plan-van-aanpak-v3`), de bron-van-waarheid. De per-entiteit statuslevenscyclus (eigenaar + tool-call per status, geverifieerd tegen `get_system_schema`) staat in **§0.2**, de harde roll-up in **§0.3**. Lees bij twijfel via `read_library_document`. Gebruik de echte enum-namen (`Ready`/`Blocked`/`OnHold`/…), geen "mentale mapping". Zie ook `plugin/reference/kanbantic-workflow-v3.md`.

> **UI-contract & wireframe-getrouwheid (KBT-F627).** Voor UI-issues geldt het gedeelde referentiekader **Read and follow exactly**: `$CLAUDE_PLUGIN_ROOT/skills/lane-shared/ui-contract.md` — contract-formaat, attachment-conventies, conformiteitsregels (element-voor-element, nooit pixel-diff) en de `n.v.t. (geen UI)`-opt-out. Do not duplicate that logic here.

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

## Model-selectie — goedkoopste-capabele per rol (v3 §5.6)

**Kernprincipe:** gebruik altijd het **lichtste model dat de taak aankan**; escaleer pas als het lichtere **aantoonbaar tekortschiet**.

| Tier | Typische taken | Model (huidig) |
|---|---|---|
| **Licht** | lezen, samenvatten, status-updates, read-only onderzoek | **Haiku 4.5** |
| **Middel** | code/specs/tests schrijven, root-cause, de meeste bouw-tasks | **Sonnet 5** |
| **Zwaar** | complexe architectuur, tegenstrijdige specs, moeilijkste review | **Opus 4.8** |
| **Max** | de absolute moeilijkste redeneer-/lang-horizon-taken (zelden) | **Fable 5** |

Reviewer/adversariale verificatie moet altijd **gelijk of zwaarder** zijn dan het model dat de code bouwde (v3 §5.6) — een lichter model kan geen bugs vinden die het zelf niet had gezien. Voor de reviewer-subagent die Step 3 dispatcht betekent dit: **Zwaar (Opus 4.8)** als default (dit is letterlijk "moeilijkste review" uit de tabel), en nooit lichter dan de tier die `kanbantic-issue-execute` voor de betreffende Feature gebruikte. Voor eenvoudige Feature-level mini-reviews met een kleine diff mag **Middel (Sonnet 5)** volstaan, mits de bouwende Agent ook Middel was. Modelnamen/prijzen evolueren; het **principe** (lichtste-capabele-maar-nooit-lichter-dan-de-bouwer) is leidend — verifieer actuele model-ID's via de `claude-api`-referentie.

## Test-tiers in deze skill (v3 §6, AUD-11)

De getrapte teststrategie is verdeeld over de twee skills die samen een Feature/Epic afronden:
- **T1** (per-task, lokaal, alleen geraakte Unit-tests) en **T2** (per-Feature, lokaal Unit + Integration + lichte review, geen volledige CI) draaien al in `kanbantic-issue-execute` (Steps 4A/4B.2 resp. Step 6) **vóórdat** deze review start.
- Deze skill **herbevestigt T2** bij de Feature-level merge naar de epic-integratiebranch (Step 5a — de integratie-smoke) en is de **enige eigenaar van T3** — de volledige CI-suite (alle Unit/Integratie + Playwright-E2E + build-image) die één keer per Epic draait op de epic→main PR (Step 7).

## Step 0: Ensure Repository Access

**0a. Register the agent session (KBT-F614)** — this skill doesn't otherwise call
`register_agent_session` itself (a session usually already exists from the proxy's
silent auto-register at startup, or from `kanbantic-issue-execute` in the same
continuous run), so call it explicitly here for board presence. Safe to call even
when a session already exists:
```
MCP: mcp__kanbantic__register_agent_session(workspaceId, host: <hostname>, cwd: <current working directory>)
```

**0b. Verify local access to the workspace's code repository:**

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
   ```
   Then set the git commit identity by running the resolver script (KBT-F616) —
   it applies the full precedence deterministically (env var override →
   per-agent identity via the read-only `get_current_agent_identity` tool,
   KBT-F615 → the repository's `gitAuthorName`/`gitAuthorEmail`) and calls
   `git config` itself:
   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/kanbantic-git-identity.js"
   ```
   A `pre-tool-use-git-identity-gate.js` PreToolUse hook also self-heals this
   before every `git commit` (including the merge commit in Step 7) if it's
   somehow still unset by then.
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
- Phase must be on `Review` (set by `mark_phase_for_review`). *(PhaseStatus enum: `Locked` · `Active` · `Review` · `Approved` · `Rejected` — there is no `ReadyForReview`; verified against `get_system_schema`. F589 / F582.)*
- Other statuses → STOP. Report: "Phase-level review only valid when the Phase is on `Review` and its Epic is InProgress."

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

**UI-contract & wireframe (KBT-F627):** for UI-issues (geldig `## Wireframe`-blok, geen opt-out `n.v.t. (geen UI)`) also load:

- the `## Wireframe`-blok from the issue description, **geparsed** via `parseWireframeBlock` (`plugin/scripts/wireframe-block.js`) → `{ wireframe, versie, paginas }`;
- the UI-contract: the `Decision`-entry whose content starts with the prefix `## UI-contract` (canonical header `## UI-contract (bevroren bij claim_issue — KBT-F627)`);
- both attachment-sets via `mcp__kanbantic__list_issue_attachments(issueId)` — the prepare-referentiecrops (`wf-*`) and the resultaat-screenshots (`result-*`) — with `mcp__kanbantic__download_issue_attachment` where the reviewer needs the actual pixels side-by-side.

Store the parsed block + contract + attachment references as `uiContract`. If no UI-contract Decision-entry is found on a UI-issue, flag the absence as a Critical review issue (the prepare-step was incomplete).

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

## Step 2.5: UI-pre-gate-scan (deterministisch — KBT-F627)

Mechanische checks zonder subagent, naar het model van de Deferred-Cancel Scan (Step 6.5). **Alleen voor UI-issues** (wireframe-blok aanwezig, geen opt-out); **niet-UI-issues: continue silently.**

```
MCP: mcp__kanbantic__list_issue_wireframes(issueId)
MCP: mcp__kanbantic__list_issue_attachments(issueId)
```

Flag **automatisch Critical** in de revieweroutput wanneer één of meer van deze deterministische condities faalt:

1. **Geen relationele pin** — `list_issue_wireframes` is leeg (prepare Step 5W heeft `link_wireframe_to_issue` niet uitgevoerd);
2. **Geen UI-contract-entry** — geen Decision-entry met prefix `## UI-contract` gevonden (Step 1b);
3. **Geen resultaat-attachments** — `list_issue_attachments` bevat geen `result-*`-set (execute Step 6e is overgeslagen).
4. **Geen "UI-UX review:"-entry** — geen discussion-entry waarvan de content begint met `UI-UX review:` (de conformiteitsbevestiging die execute Step 7-conditie 4c vóór de Review-transitie schrijft; ook het positieve bewijs voor de `pre-tool-use-ui-gate`-hook).

Per falende conditie neem dit ⚠️-blok op in de revieweroutput, met de concrete herstelactie:

```
⚠️ WIREFRAME-GETROUWHEID NIET VERIFIEERBAAR — KBT-F627
[issueCode]: <falende conditie 1/2/3/4>.
Actie vereist (herstel en re-run review):
  1) Relationele pin ontbreekt → link_wireframe_to_issue(wireframeId, issueId) (kanbantic-issue-prepare Step 5W)
  2) UI-contract ontbreekt → schrijf de Decision-entry per kanbantic-issue-prepare 5F.3b (lane-shared/ui-contract.md §1)
  3) Resultaat-attachments ontbreken → kanbantic-issue-execute Step 6e (add_issue_attachment, result-<versie>-<pagina>-<state>.png)
  4) "UI-UX review:"-entry ontbreekt → kanbantic-issue-execute Step 7-conditie 4c (add_discussion_entry met prefix "UI-UX review:")
```

Deze scan is de deterministische voorpost van de inhoudelijke Wireframe Conformity Check die de reviewer-subagent in Step 3 uitvoert — hij vangt de mechanisch-controleerbare omissies af vóórdat er een subagent aan te pas komt.

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

**First — approve the linked User Stories & Specifications (KBT-F587).** The reviewer is the named owner of User-Story / Specification approval. Do this whenever you record an `Approved` verdict for a Feature/Bug (Feature-level **or** standalone), so the `UserStoriesApproved` / `SpecificationsApproved` readiness-gates flip green on the **normal route** instead of accumulating as silent overrides:
```
# per linked User Story:
MCP: mcp__kanbantic__update_user_story(userStoryId: <id>, status: "Approved")
# per linked Specification (title is required — pass the existing title unchanged):
MCP: mcp__kanbantic__update_specification(id: <specId>, title: <existing title>, status: "Approved")
```
- `update_user_story(..., "Approved")` requires **≥1 linked E2E test case with status `Passed`** — a User-Story-level precondition that is **independent of the issue test-policy**. So for a Feature with genuinely no E2E surface you cannot approve the US this way, and leaving it at `Ready` keeps `UserStoriesApproved` red. In that specific case the **documented override-with-reason is the correct route** (not a sluiproute): set the E2E level to `N.v.t.` via `set_test_policy`, then waive `UserStoriesApproved` with an `overrideReason` that cites the E2E-`N.v.t.` policy as the rationale — the override is audited (KBT-F170 / KBT-PR191). Closing this coupling (so `update_user_story` honours a `N.v.t.` E2E policy and no override is needed) is a server-side follow-up on KBT-F591/KBT-F587. For a Feature that *does* have a Passed E2E case, approve the US directly with no override.

**Feature-level (KBT-PR200):** No `approve_phase` call (that mechanism is Phase-scoped). Record an `ApprovedWithComments` / `Approved` ReviewApproval scoped to the Feature, **then merge to the epic-integration branch**, **then** transition the Feature to `Done`:
```
MCP: mcp__kanbantic__approve_review(
  issueId: <FeatureId>,
  verdict: "Approved" | "ApprovedWithComments",
  reason: <≥20-char Feature-review summary>
)
```

**Merge to the epic-integration branch — NOT to `main` (KBT-F583 / KBT-F584).** This is the named owner and moment of the per-Feature merge that §5.4 of the Workflow doc requires; it was previously nobody's job. The reviewer performs it here, before marking the Feature `Done`:
- If the Feature was built on its **own** branch/worktree (parallel per-Feature model), merge that branch into `feature/KBT-E<epic>-integratie` and run the light integration-smoke — this is **T2** (Feature-level, local Unit+Integration, no full CI; v3 §6, mirrors the T2 tier `kanbantic-issue-execute` Step 6 already ran before handing off to this review). One merge-to-integration at a time per repo (serialise via the orchestrator):
  ```bash
  git checkout feature/KBT-E<epic>-integratie
  git pull --ff-only
  git merge --no-ff <feature-branch> -m "Merge <FeatureCode> into KBT-E<epic> integration"
  # run the integration-smoke, then:
  git push origin feature/KBT-E<epic>-integratie
  ```
  On **conflict**: `git merge --abort`, add a fix-task on the Feature, and leave it on `Review` (the `Review → InProgress` return-path is tracked in E104 / KBT-F589). Its owner re-runs `kanbantic-issue-execute` to resolve on the feature branch, then review is re-run. Do **not** mark the Feature `Done`.
- If the Feature shared the **epic-integration branch** directly (single-branch execute model — one branch per Epic-execution), it is already integrated; skip the merge.

Only after a clean integration (or when no merge was needed):
```
MCP: mcp__kanbantic__update_issue_status(issueId: <FeatureId>, status: "Done")
```
Then **STOP** — the **only** merge to `main` happens once, at Epic-level (Step 7). Control returns to the executing skill, which continues with the next Feature in the Phase.

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

- **Feature-level reject**: fix-tasks on the Feature; the Feature **stays on `Review`**. There is **no `Review → InProgress` transition** in the Domain (verified against `get_system_schema`, F589); the wanted return-path is tracked in **[OPEN: KBT-F562 / E104]**. The implementer re-runs `kanbantic-issue-execute` to pick up the fix-tasks from `Review`:
  ```
  MCP: mcp__kanbantic__add_task(issueId: <FeatureId>, title: "Fix: ...", priority: "High")
  # Do NOT call update_issue_status(<FeatureId>, "InProgress") — Review → InProgress does not exist (F589).
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

<HARD-GATE>
This is the **only** merge to `main`, and it runs **only at Epic-level / standalone-Feature / Bug** final approve (Step 6). The merge **source is the epic-integration branch** `feature/KBT-E<epic>-integratie` (into which every Feature was merged in Step 5a), not an individual feature branch — so the full CI suite (T3) runs once per Epic, not once per Feature (Workflow doc §6–§7). For a standalone Feature/Bug the "integration branch" is simply its own branch.
</HARD-GATE>

Execute the merge to main with a no-ff merge commit so the merge-historie zichtbaar blijft:

```bash
git checkout main
git pull origin main
git merge --no-ff <epic-integration-branch> -m "Merge <ISSUE-CODE> (<versionContext.name>): <short summary>"
git push origin main
```

**Where `main` is protected** (push-to-main blocked — check the repository's own branch-protection settings): do **not** push to `main` directly. Open a PR `<epic-integration-branch> → main` with title and body stamped with the creating agent's identity (see below), let CI (T3) run, and merge the PR. (For a standalone Feature/Bug the source is simply its own branch, not an epic-integration branch.) The rest of this step (cleanup, Step 7.5, Step 8) proceeds after the PR merges.

**PR-identity stamp (KBT-B538).** GitHub attributes PR authorship to whichever shared, per-repository PAT authenticated the `gh pr create` call (KBT-GTCH086) — it cannot be overridden per-call, and per-agent GitHub accounts don't scale as the agent fleet grows. To make the creating agent visible on GitHub's own PR list anyway, stamp the title and body via `kanbantic-pr-identity-stamp.js` before calling `gh pr create` — do **not** hand-format the `[AgentName]` prefix / `Created by:` footer yourself, the script is the single source of truth for the exact format (and safely no-ops, passing text through unstamped, if identity resolution fails):

```bash
TITLE="<PR title>"
BODY="Closes <ISSUE-CODE>"
STAMPED_TITLE=$(printf '%s' "$TITLE" | node "$CLAUDE_PLUGIN_ROOT/scripts/kanbantic-pr-identity-stamp.js" title)
STAMPED_BODY=$(printf '%s' "$BODY" | node "$CLAUDE_PLUGIN_ROOT/scripts/kanbantic-pr-identity-stamp.js" body)
gh pr create --title "$STAMPED_TITLE" --body "$STAMPED_BODY"
```

**Multi-repo Epics (KBT-F588):** when an Epic touches several repos (e.g. KBT-E102 spans 4), there is one epic-integration branch **per touched repo** and therefore **N PRs**, each stamped and with body `Closes <ISSUE-CODE>`. T3-CI runs per repo-PR; the Epic reaches `InDeployment` only when **all** N PRs are merged. The golf-barrier (§5.1) is defined on Feature-dependencies regardless of which repo each Feature lives in.

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
`kanbantic-issue-execute` Step 7d (`Approved → Implemented`).

Do **NOT** call this from the Feature-level mini-review approve in Step 5a
(line ≈239) — per-Feature mini-approves are not the canonical promotion
point. Validation cascades up to the final Epic / standalone approve only.

```
# Skip silently if the issue has no linked user stories.
MCP: mcp__kanbantic__get_user_story_with_requirements  // per linked story
# Signature is (linkId, validationStatus) — linkId is the Specification↔UserStory link
# from the user story's linkedSpecifications, NOT the userStoryId (F589).
MCP: mcp__kanbantic__update_validation_status(
  linkId,                        // from get_user_story_with_requirements → linkedSpecifications[].linkId
  validationStatus: "Validated"
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

If the deploy fails: **there is no legal `InDeployment → Review` transition** — the Domain layer allows only `InDeployment → Done` (KBT-RL053, verified against `get_system_schema`; `InDeployment → Cancelled` is likewise blocked). Do **NOT** attempt an illegal transition. Instead: `report_status` + an `add_discussion_entry` documenting the failed deploy, leave the issue on `InDeployment`, and escalate to the PO for a hotfix-forward or a manual recovery decision. A proper failed-deploy return-path is tracked in **[OPEN: KBT-F589 / E104]**.

## Step 9: Knowledge-Extractie (optional)

After the issue is Done, prompt the reviewer for knowledge to capture. This step is **optional** — if the reviewer has nothing to add, skip the MCP calls.

### 9a: Toolkit items

Ask: **"Heb je patterns, gotchas of rules geleerd die de moeite waard zijn om vast te leggen?"**

This knowledge goes to the workspace-wide **AI Toolkit** (Kanbantic), **not** local memory — other agents on other applications in this workspace rely on it (KBT-TRUL014, v3 §5.7 *"Kennisborging"*).

If yes, per item collect:
- `title` (descriptive)
- `category` — `Pattern` | `Gotcha` | `Rule`
- `content` — Markdown with file paths, code example, when to use

**Consistentie-check (verplicht — v3 §5.7).** Before calling `create_toolkit_item`/`update_toolkit_item`: search existing Toolkit items first and verify the new/changed content is not **contradicted** by other Toolkit items (ClaudeMd, Rules, Patterns, Gotchas) — this is a stronger check than "does a duplicate already exist", it is "does this contradict something else". If it does, reconcile — update the existing item so there are no two contradictory pieces of guidance side by side.

```
MCP: mcp__kanbantic__list_toolkit_items(workspaceId, search: "<keyword>")
```

Then, once the consistentie-check is clean:
```
MCP: mcp__kanbantic__create_toolkit_item(
  workspaceId: <id>,
  category: "Pattern" | "Gotcha" | "Rule",
  title: <title>,
  content: <content>
)
```

If a pattern already exists but is outdated, prefer `update_toolkit_item` (this is the same search-first call as the consistentie-check above).

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
