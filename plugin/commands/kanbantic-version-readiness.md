---
description: "Evaluate rollout readiness for a Version: per-criterion pass/fail + overall AllMet. Thin single-arg wrapper around the live evaluate_rollout_readiness MCP tool (KBT-SR513 / KBT-F319)."
argument-hint: <version-code>
---

Evaluate the rollout readiness for Version **`$ARGUMENTS`**.

Single positional argument: `$ARGUMENTS` is the **version-code** (e.g. `KBT-V210`). If it is empty, ask the user for it before continuing.

> Note (KBT-SR513): the scope originally named `assess_version_readiness`; that tool does not exist. The live tool is `evaluate_rollout_readiness`.

Steps:

1. Resolve `$ARGUMENTS` to the readiness target id (via `mcp__kanbantic__list_versions` when the code is not already an id).
2. Call `mcp__kanbantic__evaluate_rollout_readiness(...)` for that target.
3. Render the result as human-readable Markdown:

   ```markdown
   ## Rollout readiness — <version-code>

   **Overall:** ✅ AllMet / ❌ Not ready · phase `<rollout-phase>`

   | Criterion | Result |
   |---|---|
   | Golden-set passed | ✅ / ❌ |
   | No infra failures | ✅ / ❌ |
   | Dry-run clean | ✅ / ❌ |
   ```

This command is **read-only** — it only evaluates, it never mutates a Version.
