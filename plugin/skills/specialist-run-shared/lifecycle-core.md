# Specialist Run — Shared Lifecycle Core

This document is the **single canonical definition** of a Kanbantic specialist run. The four
per-specialist run-skills (`kanbantic-specialist-test-coverage`, `kanbantic-specialist-documentation`,
`kanbantic-specialist-security`, `kanbantic-specialist-project-manager`) are thin wrappers that set
their identity and then follow the steps below. Do not duplicate this logic into the wrappers — they
reference this file via `$CLAUDE_PLUGIN_ROOT/skills/specialist-run-shared/lifecycle-core.md`.

Implements: KBT-PR255, KBT-SR418, KBT-SR419, KBT-RL100, KBT-RL101, KBT-BD125 (Issue KBT-F382).

## Inputs the wrapper supplies

Each wrapper provides four values before invoking this core:

| Variable | Meaning | Example |
|---|---|---|
| `SPECIALIST_CODE` | The global specialist definition code | `SPEC002` |
| `SPECIALIST_NAME` | Human name (for messages) | `Documentation Specialist` |
| `SUBAGENT` | The subagent that performs the analysis | `documentation-specialist` |
| `DEFAULT_SCOPE` | Default run scope when the user gives none | `Workspace` |

The wrapper also resolves the target `workspaceId` (slug or GUID) and an optional `scope` /
`scopeEntityId` from the user's request.

## Allowed MCP tool-set

<HARD-GATE>
A specialist run uses **only** these MCP tools. Any other write is out of scope:

- `list_workspace_specialists` — resolve the activated specialist (Step 1)
- `start_specialist_run` — open the run (Step 2)
- `add_finding` — record each finding (Step 4)
- `complete_specialist_run` — close the run with summary + health score (Step 6)
- `fail_specialist_run` — close the run as failed on an unrecoverable error
- `add_discussion_entry` — optional context note

**Forbidden:** `start_run_review`, `complete_run_review`, `convert_finding`, `acknowledge_finding`,
`dismiss_finding`. The run-skill stops at status New and hands off to the human review gate
(KBT-RL100). Auto-review / auto-convert is out of scope (KBT-F389).
</HARD-GATE>

## Step 1: Resolve the enabled workspace specialist

```
MCP: mcp__kanbantic__list_workspace_specialists(workspaceId)
```

Find the entry whose `specialistCode == SPECIALIST_CODE`.

<HARD-GATE>
- If no entry exists, or its `isEnabled == false` → **STOP**. Report verbatim:
  > "`SPECIALIST_NAME` (`SPECIALIST_CODE`) is niet geactiveerd in workspace `<workspaceId>`. Activeer
  > de specialist (of zet de kill-switch uit) en probeer opnieuw."
  Do **not** call `start_specialist_run`. (KBT-RL101 — respects the KBT-F380 kill-switch.)
- If enabled → capture its `id` as `workspaceSpecialistId` and continue.
</HARD-GATE>

## Step 2: Start the run

```
MCP: mcp__kanbantic__start_specialist_run(
  workspaceSpecialistId: <from Step 1>,
  scope: <user scope or DEFAULT_SCOPE>,
  scopeEntityId: <optional — only for Release/Issue/Application scope>,
  triggerType: "Mcp"
)
```

Capture the returned run `id` as `runId`. The run is now in status **Running**.

## Step 3: Analyse — delegate to the specialist subagent

Dispatch the matching subagent with the Agent tool, passing the scope context. The subagent owns the
domain logic (what to inspect, which finding categories, severity criteria) — this core only wraps the
lifecycle.

```
Agent(subagent_type: SUBAGENT, prompt: <see below>)
```

Prompt template:

> You are running as the `SPECIALIST_NAME`. Analyse the `<scope>` of Kanbantic workspace
> `<workspaceId>` (`scopeEntityId` = `<...>` if set). Use the Kanbantic MCP read tools to gather
> what you need. Return a JSON array of findings; each finding has: `title`, `description`
> (Markdown), `severity` (Info|Low|Medium|High|Critical), `category`, `recommendation`, and
> optionally `affectedEntityCode` + `affectedEntityType`. Return `[]` if nothing is wrong. Do NOT
> create, complete, or review any specialist run — only return findings.

If the workspace has no `SUBAGENT` available on disk (it has not been synced via
`/kanbantic-sync-workspace-skills`), fall back to performing the analysis inline according to the
specialist definition's responsibilities, producing the same finding shape. Note the fallback in the
run summary.

## Step 4: Persist each finding

For every finding the subagent returned, in order:

```
MCP: mcp__kanbantic__add_finding(
  runId: <runId>,
  title: <finding.title>,
  description: <finding.description>,
  severity: <finding.severity>,
  category: <finding.category>,
  recommendation: <finding.recommendation>,
  affectedEntityCode: <finding.affectedEntityCode or omit>,
  affectedEntityType: <finding.affectedEntityType or omit>
)
```

Persist findings 1:1 — never drop, merge, or invent. The count of `add_finding` calls must equal the
count of subagent findings (KBT-SR418).

## Step 5: Compute the health score (deterministic)

<HARD-GATE>
The health score is computed, never estimated by the model (KBT-SR419). Start at 100 and subtract per
finding by severity:

| Severity | Deduction |
|---|---|
| Critical | −25 |
| High | −10 |
| Medium | −4 |
| Low | −2 |
| Info | 0 |

`healthScore = clamp(100 − Σ deductions, 0, 100)`.

The same set of findings always yields the same score. Examples: `{1 High, 2 Medium}` → 82;
`{5 Critical}` → 0 (clamped); `{}` → 100.
</HARD-GATE>

## Step 6: Complete the run

```
MCP: mcp__kanbantic__complete_specialist_run(
  runId: <runId>,
  healthScore: <computed score>,
  summary: <Markdown summary, see below>,
  tokensUsed: <approx tokens if known, else omit>
)
```

The run transitions **Running → New** (awaiting human review).

Summary format (mirrors KBT-SRUN013):

```markdown
## SPECIALIST_NAME Run — <run code>
**Scope:** <scope> (<workspaceId>)
**Audited:** <what was inspected>

### Findings: <n> total (<c> Critical, <h> High, <m> Medium, <l> Low)
- <one bullet per finding, highest severity first, with finding code>

### Health Score: <score>/100
Deductions: <per-severity breakdown, e.g. -10 (1 High), -8 (2 Medium)>
```

## Step 7: Handoff (no auto-review)

Report to the user:

> "Run `<run code>` voltooid voor `SPECIALIST_NAME` — status **New**, health **<score>/100**,
> **<n>** findings (<c> Critical / <h> High / <m> Medium / <l> Low). Klaar voor review: open de run in
> Kanbantic of gebruik de review-tools om findings te beoordelen, te dismissen of te converteren."

Do **not** call any review/convert tool (KBT-RL100). The human review gate is the only path from
finding to issue until a specialist is proven reliable (KBT-E078).

## Failure handling

If analysis or persistence fails unrecoverably, close the run cleanly instead of leaving it stuck in
Running:

```
MCP: mcp__kanbantic__fail_specialist_run(runId: <runId>, reason: "<what failed>")
```

Then report the failure to the user. Never leave a run silently in Running.

## Out of scope (other features)

- Dry-run / read-only enforcement → KBT-F378 (this core is written so a future `dryRun` flag fits at
  Step 4/6).
- Per-specialist playbook stored in the definition → KBT-F383 (this core uses the subagent as source).
- Autonomous scheduling → KBT-F385 / KBT-E080.
- Auto-convert findings → KBT-F389.
