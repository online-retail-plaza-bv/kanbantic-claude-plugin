# Release Notes — v2.9.0 (KBT-F449 / KBT-E084)

## Process rules A–E enforcement in lane-skills

v2.9.0 aligns the plugin lane-skills with the backend process rules A–E
(KBT-E084) that were already enforced server-side but were previously absent
from the prepare / execute / review SKILL.md instructions. This closes the gap
that caused KBT-F443 to be cancelled: agents could write test cases on Epics,
skip per-issue test-policy, and pass review on missing coverage.

### Changes

#### `kanbantic-issue-prepare`

**Step 5E.4 — HARD-GATE (Regel A):**
`create_test_case` with the Epic's issueId is now explicitly blocked.
Test cases belong to child Features, not Epics. A HARD-GATE prevents any
agent from calling the MCP tool at Epic scope.

**Step 5F.5 — Test-policy declaration (Feature route, Regel E / KBT-F442):**
New step before the Decision entry. The agent declares a frozen test-policy
as a `Decision` discussion entry with the canonical header
`## Test-policy (bevroren bij claim_issue — KBT-F442 / Regel E)`.
Defaults: all three levels (Unit / Integration / E2E) → Vereist / minimum 1.
N.v.t. requires ≥20-char rationale; at least one level must remain Vereist.
Replaces KBT-TRUL013 (archived per KBT-F449).

**Step 5B.6 — Test-policy declaration (Bug route, Regel E / KBT-F442):**
Same as 5F.5 but in the Bug prepare path.

**Old 5F.5 → 5F.6 / Old 5B.6 → 5B.7:** Decision-entry steps renumbered.

#### `kanbantic-issue-execute`

**Step 3c — Load frozen test-policy:**
The agent locates the `## Test-policy (bevroren bij claim_issue…` Decision
entry in the discussion entries and parses the Markdown table into a
`frozenPolicy` struct per level (applicability, min, N.v.t.-rationale).
If the entry is absent, all levels default to Vereist/min=1 and a warning
Comment is added. The HARD-GATE makes frozenPolicy read-only for execute —
the agent must not loosen minima or flip a level to N.v.t. mid-flight.

**Step 7 — Coverage-aware HARD-GATE:**
Previously: "every test case has status Passed."
Now: per-level coverage check against frozenPolicy.
- Vereist level: Passed count ≥ frozenPolicy[level].min. A level with
  **zero** test cases fails this gate even if no tests have status Failed —
  missing coverage is a blocker, not just failing tests.
- N.v.t. level: no minimum count required; rationale must be non-empty.
- No test case at any level may have status Failed or Blocked.

#### `kanbantic-issue-review`

**Step 1b — Load frozen policy:**
`list_discussion_entries` is now called in Step 1b. The skill parses
frozenPolicy and counts actual Passed per level. Missing entry → treat as
Vereist/min=1 + flag as Critical.

**reviewer-prompt.md — Test-Policy Coverage Check (item 5):**
- Added `## Frozen Test-Policy (Regel E / KBT-F442)` table in the prompt
  template (filled per level by the skill).
- Item 5 now checks: Vereist levels → ONTBREKENDE COVERAGE if Passed < min;
  N.v.t. → missing rationale = Critical; any Failed/Blocked = Critical.
- Added `## Test-Policy Coverage (Regel E)` in output format.
- Hardcoded note: missing coverage on any Vereist level → always REJECT,
  no exceptions.

### Archived

**KBT-TRUL013** — superseded by the per-issue test-policy mechanism
introduced by KBT-F442 and now enforced in the plugin by KBT-F449. Any
reference to KBT-TRUL013 in prepare must note it is opgeheven/superseded.

### Test Coverage

18 automated tests added in `plugin/tests/lane-skill-process-rules.test.js`:
- Regel A: 5E.4 HARD-GATE present, no affirmative create_test_case on Epic
- Regel E: 5F.5 / 5B.6 declaration steps with canonical header and rationale
- Step renumbering: 5F.6 / 5B.7 Decision entries
- Execute Step 3c: frozenPolicy load + read-only HARD-GATE
- Execute Step 7: coverage-aware gate with per-level min + N.v.t. handling
- Review Step 1b: list_discussion_entries + frozenPolicy parsing
- Reviewer-prompt: Frozen Test-Policy table + ONTBREKENDE COVERAGE + REJECT note
- TRUL013 supersession check
- Lint integration: lint-skills.js passes with all invariants OK

All 18 tests pass (`node --test`).

### Target

- Version: v0.15.0 (KBT-INI041)
- Issue: KBT-F449
- Merged: 60f1341
