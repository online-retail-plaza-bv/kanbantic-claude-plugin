---
description: "Freeze a Version (lock scope) after an explicit confirmation prompt. Thin single-arg wrapper around the live freeze_version MCP tool — the ONLY mutating Version command (KBT-SR513 / KBT-F319)."
argument-hint: <version-code>
---

Freeze the Version **`$ARGUMENTS`**.

Single positional argument: `$ARGUMENTS` is the **version-code** (e.g. `KBT-V210`). If it is empty, ask the user for it before continuing.

⚠️ **This is the only mutating Version command.** It locks the Version's scope. You MUST confirm before mutating.

Steps:

1. Resolve `$ARGUMENTS` to the Version id (via `mcp__kanbantic__list_versions` when the code is not already an id) and show the user the Version's `code`, `name`, and current `status`.
2. **Confirmation prompt** — ask explicitly:

   > You are about to **freeze** `<code> — <name>`. This locks its scope. Type `yes` to proceed, anything else to abort.

3. **Abort path:** if the user does not confirm with an affirmative (`yes` / `y` / `confirm`), do **nothing** — make no MCP call, and report `Aborted — Version <code> was not frozen.`
4. **Proceed path:** only on explicit confirmation, call `mcp__kanbantic__freeze_version(...)` for the resolved Version.
5. Render the outcome as human-readable Markdown:

   ```markdown
   ## Version frozen — <version-code>
   - **Status:** Frozen
   - **Frozen at:** <timestamp>
   ```
