---
name: kanbantic-graduation
description: "Graduates a mature concept domain from Obsidian notes (kladblok) to structured Kanbantic entities: Initiative → Epic → Feature → User Story → Specification → Draft Test Cases. Agent-assisted via existing MCP tools only (no new tools). Enforces the 5-criteria ripeness checklist (KBT-TRUL018) as a HARD-GATE before creating anything. User stories and Draft Test Cases land on Feature level (Regel A / KBT-RL121). Closes with the one-way rule (KBT-TRUL019) + PO confirmation."
---

# Kanbantic Graduation Skill

## Overview

`kanbantic-graduation` promotes a **mature concept domain** from free-form Obsidian notes + wireframes to first-class Kanbantic entities, agent-assisted. The skill reads your kladnotities, validates ripeness (KBT-TRUL018), and creates the full entity tree via existing MCP tools. No new MCP tools are introduced.

**Announce at start:** "I'm using the kanbantic-graduation skill to graduate your concept to Kanbantic."

After graduation, **Kanbantic is the single source of truth** for that domain (KBT-TRUL019). The Obsidian notes remain as a scratchpad for future domains — not as a parallel authoritative copy.

## Scope

- Reads kladnotities: free prose **or** structured "Als X wil ik Y zodat Z" stories
- Fetches wireframe via `get_wireframe` (graceful skip if KBT-E086 unavailable)
- Enforces the 5-criteria ripeness gate (KBT-TRUL018) — HARD-GATE before any create calls
- Creates entities via existing MCP tools:
  `create_initiative` → `create_issue` (Epic) → `create_issue` (Feature) → `create_user_story` → `create_specification` → `create_test_case`
- Draft Test Cases land on the **Feature**, not the Epic (Regel A / KBT-RL121)
- Shows one-way rule (KBT-TRUL019) and records PO confirmation as a Decision entry

This skill does NOT:
- Introduce new MCP tools
- Graduate multiple Epics in one batch — one Epic per graduation session
- Merge or sync back to Obsidian after graduation

## Checklist

1. **Worktree gate** — verify not in main working tree (KBT-TRUL004)
2. **Read kladnotities** — paste or file path; extract epic, features, stories, ACs
3. **Fetch wireframe** — graceful skip if unavailable
4. **Ripeness gate** — evaluate 5 criteria (KBT-TRUL018); HARD-GATE on failure
5. **Create entities** — Initiative → Epic → Feature → UserStory → Specification
6. **Create Draft Test Cases** — one per AC, on the Feature (Regel A)
7. **One-way rule** — show KBT-TRUL019; PO confirms; log Decision entry on the Epic
8. **Summary** — print all created codes

---

## Step 0: Worktree HARD-GATE (KBT-TRUL004)

<HARD-GATE>
Before any status-mutating or artifact-creating step, verify you are **not** in the main working tree.

```bash
GIT_DIR=$(git rev-parse --git-dir)
GIT_COMMON=$(git rev-parse --git-common-dir)
if [ "$GIT_DIR" = "$GIT_COMMON" ]; then
  STOP. Report to user verbatim:
  "You are in the main working tree ($GIT_COMMON).
  Run EnterWorktree(name: 'kanbantic-graduation') first, then re-run this skill.
  See KBT-TRUL004 for the rationale."
fi
```

If the check passes (paths differ → you are in a worktree), continue silently.
</HARD-GATE>

---

## Step 1: Read Kladnotities

Ask the PO:

> "Plak je kladnotities hier (vrij proza of gestructureerde stories), of geef het pad naar een `.md`-bestand."

Accept two input modes:

**Mode A — Vrij proza:**
Claude extracts from unstructured text. For each paragraph or logical block, identify:
- Epic title and description
- Feature groupings (capability areas)
- Story intent ("Als X wil ik Y zodat Z")
- Acceptance criteria (numbered list items, bullet "−" markers, or sentences starting with "Gegeven/Als/Dan")

**Mode B — Gestructureerde stories:**
The input already contains "Als X wil ik Y zodat Z" stories with numbered ACs. Parse directly.

Build an internal schema:

```
{
  epic: { title, description },
  features: [
    {
      title,
      stories: [
        { title, body, acs: ["AC1 tekst", "AC2 tekst", ...] }
      ]
    }
  ]
}
```

Confirm the extracted schema with the PO before proceeding:
> "Ik heb het volgende schema uitgelezen: [toon Epic + Feature-titels + story-count per Feature]. Klopt dit?"

If the PO corrects anything, update the schema and re-confirm before moving to Step 2.

---

## Step 2: Wireframe Ophalen (Graceful)

Scan the extracted schema for screen IDs (patterns: `SCR-\d+`, `[A-Z]{2,}-SCR-\d+`, or explicit scherm-ID references from KBT-F435 convention).

For each screen ID found:
```
// No dedicated get_wireframe MCP tool exists yet (KBT-E086 planned)
// Skip gracefully when unavailable
```

If no `get_wireframe` tool is registered in the current MCP session, log a warning to the PO:
> "⚠️ Wireframe-ophalen overgeslagen (KBT-E086 nog niet beschikbaar). Screen-ID's worden als vrije tekst bewaard in de User Story-beschrijvingen. De rijpheids-checklist vereist wel dat UI-stories een scherm-ID bevatten."

Then continue to Step 3. Do **not** block graduation on the absence of KBT-E086.

---

## Step 3: Rijpheids-checklist HARD-GATE (KBT-TRUL018)

Evaluate all **5 criteria** from KBT-TRUL018 against the extracted schema:

| # | Criterium | Check |
|---|---|---|
| 1 | **AC-volledigheid** | Every story has ≥1 AC |
| 2 | **AC-kwaliteit** | No AC contains vague terms: "snel", "makkelijk", "intuïtief", "gebruiksvriendelijk", "duidelijk", "goed", "beter", "soms", "vaak" |
| 3 | **Wireframe-koppeling** | Every UI-facing story has a screen ID in its text or ACs. Stories without a UI surface are exempt. |
| 4 | **Afhankelijkheden helder** | No story mentions "afhankelijk van [onbekend systeem]" or "TBD" or "nog nader te bepalen" in its description or ACs. No unknown external blockers. |
| 5 | **Geen open vragen** | No story, feature, or epic description contains "?", "TODO", "FIXME", "nader bepalen", "nog uit te zoeken", or similar markers. |

<HARD-GATE>
If **any** criterion is unmet, produce a structured report and **stop without creating any entities**:

```markdown
## Rijpheids-checklist — GEFAALD

De volgende criteria zijn niet voldaan:

| # | Criterium | Probleem |
|---|---|---|
| 2 | AC-kwaliteit | KBT-US-CONCEPT-3 AC2: "De pagina moet snel laden" — "snel" is niet falsifieerbaar |
| 5 | Geen open vragen | Feature "Betalingsoverzicht" bevat "TODO: afstemmen met finance" |

Verhelp deze punten en herstart de skill.
```

**Soft override**: If the PO provides an explicit reason (≥20 characters) to proceed despite failing criteria, record the override as a Decision entry on the Epic **after it is created** (Step 4b) and continue. The reason is mandatory and auditable.
</HARD-GATE>

---

## Step 4: Entiteiten Aanmaken

Create entities in strict top-down order. Each step depends on the ID returned by the previous call.

### Step 4a: Initiative (if not present)

First check whether an initiative already exists for this domain:
```
MCP: list_initiatives(workspaceId)
```

If not found, create one:
```
MCP: create_initiative(
  workspaceId,
  title: "<epic-domain name>",
  description: "<one-paragraph context>"
)
```

If found, use the existing initiative ID.

### Step 4b: Epic

```
MCP: create_issue(
  workspaceId,
  type: "Epic",
  title: <epic.title>,
  description: <epic.description>,
  initiativeId: <initiative GUID>
)
```

→ store `epicId`.

If a soft override was recorded in Step 3, add the Decision entry now:
```
MCP: add_discussion_entry(
  issueId: epicId,
  entryType: "Decision",
  content: "## Rijpheids-checklist soft override\n\n**Reden PO:** <reason>\n\n**Openstaande punten:** <list of failing criteria>"
)
```

### Step 4c: Features

For each feature in the schema:
```
MCP: create_issue(
  workspaceId,
  type: "Feature",
  title: <feature.title>,
  description: <feature description — derived from stories in this feature>,
  parentIssueId: epicId
)
```

→ store `featureId` per feature.

### Step 4d: User Stories

<IMPORTANT>
Per **Regel A (KBT-RL121)**: User stories are ALWAYS created on the **Feature** (`issueId: featureId`), never on the Epic. Placing user stories on the Epic bypasses the Feature-level test coverage gate and violates the DoD invariant.
</IMPORTANT>

For each story in a feature:
```
MCP: create_user_story(
  workspaceId,
  issueId: featureId,      // ← Feature GUID, NOT Epic GUID (Regel A)
  title: <story title>,
  description: <"Als X wil ik Y zodat Z\n\n## Acceptance Criteria\n1. ...">
)
```

→ store `storyId` and `storyCode` per story.

### Step 4e: Specifications (per AC)

For each AC of each story, create a ProductRequirement specification:
```
MCP: create_specification(
  workspaceId,
  category: "ProductRequirement",
  title: <AC title — first 80 chars of AC text>,
  content: <full AC text>,
  extractedFromIssueId: featureId
)
```

---

## Step 5: AC → Draft Test Cases (Regel A + KBT-RL123)

After creating each User Story, iterate over its ACs and create one Draft Test Case per AC on the **Feature**:

<IMPORTANT>
Per **Regel A**: `issueId` = Feature GUID. NOT the Epic GUID. Draft Test Cases on the Epic bypass the Feature-level DoD gate.
</IMPORTANT>

```
MCP: create_test_case(
  workspaceId,
  issueId: featureId,              // Feature — Regel A
  userStoryId: storyId,
  title: "<AC short label> — Draft",
  description: "Afgeleide van AC op [" + storyCode + "]:\n\"" + acText + "\"",
  testLevel: "None",               // set during Feature prepare
  priority: "Medium"
)
```

The description format (KBT-RL123) ensures traceability back to the source AC without needing external documentation.

Do NOT create test cases before the corresponding `create_user_story` call succeeds — the `storyCode` is needed for the traceable description.

---

## Step 6: Één-richting-regel + PO Confirmatie (KBT-TRUL019)

Before closing, show the one-way rule:

> **Na graduatie: Kanbantic is de enige bron.**
>
> Wat dit betekent:
> - Stories, AC's en afhankelijkheden voor dit domein worden voortaan in Kanbantic bijgewerkt — via `update_user_story`, `create_specification`, etc.
> - Je Obsidian-kladblok blijft bestaan als notitieruimte voor toekomstige domeinen, maar is niet langer gezaghebbend voor dit domein.
> - Kanbantic's ChangeHistory en Specification Conflict Detection zijn nu de versiebeheermechanismen voor dit domein.
>
> Bevestig dat je dit begrijpt en accepteert.

When the PO confirms, record the confirmation:
```
MCP: add_discussion_entry(
  issueId: epicId,
  entryType: "Decision",
  content: "## Graduatie bevestigd — één-richting-regel (KBT-TRUL019)\n\nPO heeft bevestigd dat Kanbantic de enige bron is voor dit domein na graduatie. Kladblok is voortaan alleen scratchpad.\n\nGegradueerd via `kanbantic-graduation` skill."
)
```

---

## Step 7: Eindsamenvatting

Print a complete summary of all created entities:

```markdown
## Graduatie voltooid ✓

**Epic:** KBT-E??? — <title>
**Initiative:** KBT-INI??? — <title>

**Features + stories:**
- KBT-F??? — <feature title>
  - KBT-US??? — <story title> (2 ACs → 2 Draft Test Cases)
  - KBT-US??? — <story title> (3 ACs → 3 Draft Test Cases)
- KBT-F??? — <feature title>
  - ...

**Specificaties aangemaakt:** N (ProductRequirement)
**Draft Test Cases aangemaakt:** N (op Feature-niveau)

Volgende stap: voer `kanbantic-issue-triage` + `kanbantic-issue-prepare` uit op elke Feature om ze klaar te stellen voor ontwikkeling.
```

---

## Error Handling

| Situatie | Actie |
|---|---|
| `create_user_story` faalt met "Invalid issueId" | Verifieer dat `featureId` (niet `epicId`) wordt doorgegeven. |
| `create_initiative` retourneert "already exists" | Gebruik de bestaande initiative ID uit de response. |
| Soft-override zonder reden van ≥20 tekens | Vraag opnieuw om een reden. Herhaal totdat voldaan. |
| PO bevestigt één-richting-regel niet | Stop. Geen Decision-entry. De graduatie is niet afgerond. |
| MCP call geeft 429 / rate-limit | Wacht 2 seconden, retry max 3 keer. Daarna log en stop. |

---

## Zie ook

- `KBT-TRUL018` — Rijpheids-checklist (5 criteria)
- `KBT-TRUL019` — Één-richting-regel na graduatie
- `KBT-RL121` — Regel A: user stories op Feature, nooit op Epic
- `KBT-RL123` — Traceerbare description-format voor Draft Test Cases
- Library-doc: "Graduation Workflow Guide — Concept-to-Build Pipeline (KBT-E085)"
- `kanbantic-issue-triage` + `kanbantic-issue-prepare` — volgende stap na graduatie per Feature
