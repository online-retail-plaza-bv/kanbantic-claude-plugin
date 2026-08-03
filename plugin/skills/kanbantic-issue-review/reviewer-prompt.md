# Code Reviewer Subagent Prompt Template

Use this template when dispatching a reviewer subagent for a Kanbantic issue phase.

```
Agent tool (superpowers:code-reviewer):
  description: "Review Phase: [phase name] for [issue code]"
  prompt: |
    You are reviewing a completed implementation phase for a Kanbantic issue.

    ## What Was Implemented
    [WHAT_WAS_IMPLEMENTED]

    ## Issue
    Code: [ISSUE_CODE]
    Title: [ISSUE_TITLE]
    Description: [ISSUE_DESCRIPTION]

    ## Requirements (from Kanbantic Specifications)
    [List each specification as a checklist item:]
    - [ ] KBT-PR001: [title] — [content summary]
    - [ ] KBT-SR001: [title] — [content summary]

    ## Test Cases (Acceptance Criteria)
    [List each test case:]
    - [ ] KBT-TC001: [title] — [expected result]
    - [ ] KBT-TC002: [title] — [expected result]

    ## Frozen Test-Policy (Regel E / KBT-F442)
    [PASTE the frozenPolicy table here, with actual Passed counts filled in:]

    | Niveau | Applicabiliteit | Minimum vereist | Passed (werkelijk) | Status |
    |---|---|---|---|---|
    | Unit | Vereist | N | M | ✓ Gedekt / ✗ ONTBREKENDE COVERAGE |
    | Integration | Vereist | N | M | ✓ Gedekt / ✗ ONTBREKENDE COVERAGE |
    | E2E | N.v.t. — [reden] | — | — | ✓ N.v.t. / ✗ Rationale ontbreekt |

    If no test-policy entry was found on the issue: treat all three levels as Vereist/min=1 and flag as Critical.

    ## UI-contract & Wireframe (KBT-F627)
    [PASTE for UI-issues (wireframe-blok aanwezig, geen opt-out):
     - the UI-contract Decision-entry ("## UI-contract (bevroren bij claim_issue — KBT-F627)")
     - the pinned wireframe reference: slug, versie, pagina('s) from the `## Wireframe`-blok
     - both attachment-sets: prepare-referentiecrops (wf-*) + resultaat-screenshots (result-*)
     - the "Afgeweken van het wireframe" section from the handoff-entry (or "geen")
     For non-UI issues write: n.v.t.]

    If no UI-contract entry was found on a UI-issue: flag as Critical (the prepare-step was incomplete).

    ## Project Rules & Patterns (from Kanbantic Toolkit)
    [PASTE relevant Rules, Patterns, and Gotchas from Toolkit.
     The reviewer should verify code adheres to these.]
    - Rule: [title] — [content summary]
    - Pattern: [title] — [content summary]
    - Gotcha: [title] — [content summary]

    ## Git Diff
    Base: [BASE_SHA]
    Head: [HEAD_SHA]

    Review the diff between these commits:
    ```bash
    git diff [BASE_SHA]..[HEAD_SHA]
    ```

    ## Your Review

    1. **Requirements Check**: Verify each specification is implemented. Check/uncheck the list.

    2. **Test Case Coverage**: Verify each test case has corresponding implementation.

    3. **Code Quality**:
       - Follows existing codebase patterns
       - Adheres to project Rules, Patterns, and Gotchas from the Toolkit
       - Proper error handling
       - No security vulnerabilities
       - Clean, maintainable code
       - YAGNI — no over-engineering

    4. **Architecture**:
       - Proper separation of concerns
       - Integrates well with existing code
       - No unnecessary coupling

    5. **Test-Policy Coverage Check** (Regel E / KBT-F442):
       - For each level with Applicability `Vereist`: verify `Passed count ≥ Minimum`. If count < minimum → **Critical** issue: "ONTBREKENDE COVERAGE: [level] heeft [M] Passed test cases maar vereist [N]. Voeg [N-M] test case(s) toe en markeer als Passed voor Review."
       - For each level with Applicability `N.v.t.`: verify the rationale is present and ≥20 chars. If missing or too short → **Critical** issue: "N.v.t.-rationale voor [level] ontbreekt of is onvoldoende (<20 chars)."
       - Any test case with status `Failed` or `Blocked` → **Critical** issue.
       - Missing coverage ALWAYS yields REJECT — it cannot be overridden by other strengths.

    6. **Wireframe Conformity Check** (KBT-F627):
       - UI-issues only (wireframe-blok aanwezig, geen opt-out); non-UI issues: mark `n.v.t.` and move on.
       - Verify **element-voor-element** against the UI-contract: knoppen/labels, tabelkolommen + volgorde, titels/breadcrumbs, menu-plaatsing, states. NEVER pixel-diff — wireframe and app are never pixel-identical (lane-shared/ui-contract.md §3).
       - Compare the prepare-referentiecrops (wf-*) with the resultaat-screenshots (result-*) per pagina/state.
       - Every deviation must be reported under "Afgeweken van het wireframe" in the handoff-entry. An **unreported deviation = Critical**.
       - Missing UI-contract, missing result-screenshots, or missing relationele pin → **Critical** (mirrors the deterministic Step 2.5 pre-gate).

    7. **Issues**: Categorize as:
       - **Critical**: Must fix (bugs, security, broken functionality, missing test-policy coverage)
       - **Important**: Should fix (missing requirements, poor patterns)
       - **Minor**: Nice to have (style, naming, minor improvements)

    ## Output Format

    ```markdown
    ## Strengths
    - [What was done well]

    ## Issues
    ### Critical
    - [Issue + file:line + fix recommendation]

    ### Important
    - [Issue + recommendation]

    ### Minor
    - [Suggestion]

    ## Requirements Checklist
    - [x/blank] KBT-PR001: ... — [status]

    ## Test Cases
    - [x/blank] KBT-TC001: ... — [status]

    ## Test-Policy Coverage (Regel E)
    - [x/blank] Unit: [M] Passed / [N] vereist — [Gedekt / ONTBREKENDE COVERAGE]
    - [x/blank] Integration: [M] Passed / [N] vereist — [Gedekt / ONTBREKENDE COVERAGE]
    - [x/blank] E2E: [M] Passed / [N] vereist — [Gedekt / ONTBREKENDE COVERAGE / N.v.t.: reden]

    ## Wireframe Conformity (KBT-F627)
    [For non-UI issues write a single line: n.v.t.]
    - [x/blank] Knoppen + labels — [conform / afwijking: ...]
    - [x/blank] Tabelkolommen + volgorde — [conform / afwijking: ...]
    - [x/blank] Titels / breadcrumbs — [conform / afwijking: ...]
    - [x/blank] Menu-plaatsing — [conform / afwijking: ...]
    - [x/blank] States — [conform / afwijking: ...]
    - Gemelde afwijkingen ("Afgeweken van het wireframe"): [lijst / geen]
    - Ongemelde afwijkingen (Critical): [lijst / geen]

    ## Verdict
    APPROVE / REJECT (with reason)
    Note: missing coverage on any Vereist level → always REJECT, no exceptions.
    Note: missing wireframe conformity on a UI-issue → always REJECT — it cannot be overridden by other strengths.
    ```
```

## Usage

1. Get specs: `mcp__kanbantic__list_specifications(workspaceId)`
2. Get test cases: `mcp__kanbantic__list_test_cases(workspaceId, issueId)`
3. Get git diff: `git diff <base>..<head>`
4. Fill in template placeholders
5. Dispatch via Agent tool
6. Use result to approve/reject phase in Kanbantic
