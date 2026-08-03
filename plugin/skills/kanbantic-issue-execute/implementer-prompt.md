# Implementer Subagent Prompt Template

Use this template when dispatching a subagent to implement a single task from a Kanbantic implementation plan.

```
Agent tool (general-purpose):
  description: "Implement Task: [task title]"
  prompt: |
    You are implementing a task from a Kanbantic issue.

    ## Issue
    Code: [ISSUE CODE]
    Title: [ISSUE TITLE]

    ## Task
    Title: [TASK TITLE]
    Phase: [PHASE NAME]

    ## Code Instructions

    [PASTE the relevant section from the KnowledgeExtraction discussion entry.
     Include: file paths, code snippets, line numbers, build/test commands.]

    ## Wireframe (bindend — gepinde versie)

    [PASTE for UI-tasks: the pinned wireframe markup for the page(s) this task
     touches (exact pinned versie — never "latest") + the UI-contract
     Decision-entry ("## UI-contract (bevroren bij claim_issue — KBT-F627)").
     For non-UI tasks write: n.v.t. (geen UI).]

    Regels (KBT-F627, structure-faithful — KBT-RL191):
    - Elk element is normatief: knoppen/labels, tabelkolommen + volgorde,
      titels/breadcrumbs, menu-plaatsing, states. Pixel-spacing is vrij.
    - Een element dat niet in het wireframe staat? NIET bouwen — meld het
      in je rapport onder "Afgeweken van het wireframe".

    ## Project Patterns (from Kanbantic Toolkit)

    [PASTE relevant Toolkit items (patterns, gotchas, rules) from Step 2b.
     Include items relevant to this task's domain (backend/frontend/MCP).
     The workspace's own Toolkit defines what those are — service-layer patterns,
     UI component conventions, database-migration gotchas, and so on.]

    ## Context

    [Brief architectural context: what this component does, how it fits,
     what other phases depend on this work.]

    ## Before You Begin

    If anything is unclear — requirements, file locations, approach — ask now.
    Do not guess or make assumptions.

    ## Your Job

    1. Implement exactly what the code instructions specify
    2. Run build/test commands to verify
    3. Commit your work with message: "feat([ISSUE CODE]): [task description]"
    4. Self-review (see below)
    5. Report back

    Work from: [repository root directory]

    ## Self-Review Checklist

    Before reporting, verify:
    - [ ] All specified changes implemented
    - [ ] Build succeeds (the repo's own build command)
    - [ ] Tests pass (the repo's own test command)
    - [ ] No unrelated changes included
    - [ ] Code follows existing codebase patterns
    - [ ] UI matches the pinned wireframe element-for-element (or the deviation is reported below)
    - [ ] YAGNI — only what was requested

    Fix any issues found before reporting.

    ## Report Format

    When done, report:
    - What you implemented (files changed)
    - Build/test results
    - Self-review findings (if any)
    - Wireframe deviations ("Afgeweken van het wireframe"): <lijst of "geen">
    - Result screenshots: <paden>
    - Issues or concerns
```

## Usage

When using this template:

1. Get task details from Kanbantic: `mcp__kanbantic__list_tasks(issueId)`
2. Get code instructions from discussion: `mcp__kanbantic__list_discussion_entries(issueId)`
3. Find the KnowledgeExtraction entry matching the current phase
4. For UI-tasks: the **parent** calls `get_wireframe(<slug>, <versie>, <pagina>)` (exact the pinned versie from the `## Wireframe`-blok) to fill the "## Wireframe (bindend — gepinde versie)" placeholder, plus the UI-contract Decision-entry (KBT-F627); non-UI tasks get `n.v.t. (geen UI)`
5. Fill in the remaining template placeholders
6. Dispatch via Agent tool with `subagent_type: "general-purpose"`
7. Review the subagent's report
8. Update task status: `mcp__kanbantic__update_task_status(issueId, taskId, status: "Done")`
