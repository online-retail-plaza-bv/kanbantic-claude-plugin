---
name: kanbantic-bug-autopilot
description: "Use to process one or more Kanbantic bug issues fully autonomously — from current status to Done — without manual intervention. Handles batches sequentially by priority. Fetches the live workflow at runtime; never hardcodes lane names. Reports per-bug result and token breakdown by model."
user_invocable: true
command: bug-autopilot
---

# Kanbantic Bug Autopilot

## Overview

Fully autonomous end-to-end processor for Kanbantic bug issues. Accepts one or more bug-issue IDs, detects their current status, and drives each one through the complete Kanbantic lane workflow until Done — or documents a blocker and continues to the next bug.

**Principle:** Bootstrap → detect workspace → fetch live workflow → process bugs sequentially → close with final report.

**Announce at start:** "I'm using the kanbantic-bug-autopilot skill."
For a batch: "Processing [n] bugs sequentially: [KBT-B001, KBT-B002, ...]"

## Scope

- Processes **bug issues only** (type: Bug). For Features or Epics, redirect to the appropriate lane skills.
- Fetches the workflow at runtime — never hardcodes lane names or transition rules.
- Detects the workspace automatically via `get_context()` and the issue prefix.
- Processes bugs **sequentially**: one bug fully completed before the next begins.
- On a blocker: documents the blocker, reports to the user, continues with the next bug.
- Closes with a per-bug summary and a token breakdown by model.

## Checklist

1. **Step 0** — Bootstrap: register session, detect workspace, load Toolkit, fetch live workflow, load all bug issues
2. **Step 1** — For each bug: determine entry point in the workflow (skip completed lanes)
3. **Step 2** — Drive the bug through the workflow lane by lane, with status updates and heartbeats
4. **Step 3** — Assess Library documentation needs after the execute phase
5. **Step 4** — Close session; report per-bug result + token breakdown

## Step 0: Bootstrap (ALWAYS FIRST — NO EXCEPTIONS)

<HARD-GATE>
Step 0 must complete fully before any workflow processing begins. Skipping any sub-step is not permitted.
</HARD-GATE>

### Step 0a: Register Agent Session

```
MCP: mcp__kanbantic__register_agent_session(workspaceId: <see 0b>, host: <hostname>, cwd: <working directory>)
```

Save the returned `sessionId` — used for heartbeats and session close.

### Step 0b: Determine Workspace

```
MCP: mcp__kanbantic__get_context()
```

Priority order:
1. If the user specified a workspace → use it.
2. If the issue code has a known prefix (e.g. `KBT-B001`) → match prefix to workspace via `get_context()`.
3. If ambiguous → ask via `AskUserQuestion` which workspace to use.

**Never hardcode a workspace ID.**

### Step 0c: Load the AI Toolkit — your work instructions

```
MCP: mcp__kanbantic__list_toolkit_items(workspaceId: <workspaceId>, category: "ClaudeMd")
```

Read **all** returned items fully and carefully. They contain conventions, rules, and decisions you **must** follow. Do not skip any item. Toolkit rules are law.

### Step 0d: Fetch the Live Workflow

```
MCP: mcp__kanbantic__get_documentation_section(workspaceId: <workspaceId>, section: "workflow")
```

If this returns empty, fall back to:

```
MCP: mcp__kanbantic__list_library_documents(workspaceId: <workspaceId>)
```

Open each document with "workflow", "lane", or "proces" in the name. The workflow you find here is **authoritative** — not what you know from training. If the workflow has changed since this skill was written, follow the changed version.

### Step 0e: Load All Bug Issues

For each provided issue ID:

```
MCP: mcp__kanbantic__get_issue(issueId: <issueId>)
```

Per issue: capture current status, specs, user stories, test cases, tasks, and discussion entries.

**Sort the batch by priority** (Critical → High → Medium → Low) unless the user specified an explicit order.

---

## Model Selection — Principles (no fixed model names)

Always use the **lightest model capable of the task**. Use heavier models only when lighter models demonstrably fall short.

| Complexity | When | Examples |
|---|---|---|
| **Light** | Reading, summarising, simple decisions, status updates | Context loading, heartbeat, simple triage |
| **Medium** | Writing (specs, code, tests), analysis, reasoning tasks | Root cause analysis, code writing, test cases |
| **Heavy** | Complex architecture decisions, deeply conflicting specs | Only when medium demonstrably falls short |

Switch models per subtask — not every step carries the same weight.

---

## Step 1: Determine Entry Point in the Workflow

Read the current status of each bug issue and match it against the workflow fetched in Step 0d. Jump in at the right lane — skip completed lanes, do not restart from the beginning.

**Ask yourself:** "Which lane transition is due next for this bug?" That is your entry point.

---

## Step 2: Drive the Workflow — Per Bug

Process bugs **one at a time**. Start the next bug only after the current one has reached its terminal status or is explicitly documented as blocked.

**On a blocked bug:**
- Document the blocker as a Discussion entry on that issue
- Report the blocker briefly to the user
- **Continue with the next bug in the batch** — do not block the whole batch
- Note the blocked issue for the final report
- Reset the issue status to the previous stable lane if the current lane could not be completed

### Rules that always apply, regardless of the workflow

**Status tracking:**
- Update the issue status in Kanbantic **before** beginning a new lane
- Add a Discussion entry for every significant decision or finding

**Send heartbeats** during long-running tasks (at minimum every 60 seconds):

```
MCP: mcp__kanbantic__heartbeat(sessionId: <sessionId>)
```

<HARD-GATE>
Never skip a lane or step based on assumption — even if the current issue content looks sufficient for the next lane. Every lane skill performs its own checks. When in doubt about the workflow, re-read what you fetched in Step 0d and consult the Toolkit before proceeding.
</HARD-GATE>

---

## Step 3: Library Documentation

After completing the execute phase (or equivalent): assess whether documentation should be created or updated.

Criteria:
- Is there a new pattern or decision others need to know?
- Does the implementation change existing behaviour described in the Library?
- Does the Toolkit require certain things to be documented?

If yes:

```
MCP: mcp__kanbantic__list_library_documents(workspaceId: <workspaceId>)
MCP: mcp__kanbantic__create_library_document(...)   // new document
MCP: mcp__kanbantic__update_library_document(...)   // update existing
MCP: mcp__kanbantic__publish_library_document(...)  // always publish after writing
```

---

## Step 4: Close Session + Final Report

```
MCP: mcp__kanbantic__end_agent_session(sessionId: <sessionId>)
```

Report a **per-bug summary** to the user:

| Issue | Title | Lanes traversed | Result |
|-------|-------|-----------------|--------|
| KBT-B001 | ... | Triage → Prepare → Execute → Review | ✓ Done |
| KBT-B002 | ... | Execute → Review | ✓ Done |
| KBT-B003 | ... | Triage → Prepare | ✗ Blocked: [reason] |

Followed by:
- Library documents created or updated
- Any open issues or follow-ups

Close with a **token breakdown** by model and by bug:

| Bug | Model | Input tokens | Output tokens | Total |
|-----|-------|-------------|---------------|-------|
| KBT-B001 | [light] | [n] | [n] | [n] |
| KBT-B001 | [medium] | [n] | [n] | [n] |
| KBT-B002 | [light] | [n] | [n] | [n] |
| **Total** | | | | [n] |

Track token counts by accumulating the `usage` fields after each API call (`input_tokens` + `output_tokens` per model per bug). Report cache tokens (`cache_read_input_tokens`, `cache_creation_input_tokens`) separately if they exceed 10% of total input.

---

## Absolute Prohibitions

- Never skip a lane based on assumption
- Never hardcode the workflow — always fetch it
- Never use a heavier model when a lighter one suffices
- Never close the session without `end_agent_session`
- Never push commits without passing tests (unless the Toolkit explicitly permits it)

## Key Principles

- **Workflow is always live** — fetch it at runtime; never trust what the skill itself says about lane names
- **Sequential, one bug at a time** — complete or document-as-blocked before starting the next
- **Lightest model that fits** — switch per subtask; never lock in a heavy model for the whole run
- **Blockers skip, not stop** — one blocked bug never halts the batch
- **Kanbantic is source of truth** — status updates and Discussion entries before and after every lane transition
- **Heartbeat keeps the session alive** — minimum every 60 seconds during long-running work
- **Bootstrap before everything** — Step 0 is non-negotiable; no sub-step may be skipped
