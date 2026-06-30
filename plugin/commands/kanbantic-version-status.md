---
description: "Show the current version picture for an Application: its Planned + InProgress + most recent Released Version. Thin single-arg wrapper around the live list_versions MCP tool (KBT-SR513 / KBT-F319)."
argument-hint: <application-slug>
---

Show the current Version status for the Application **`$ARGUMENTS`**.

Single positional argument: `$ARGUMENTS` is the **application-slug** (e.g. `kanbantic-api`). If it is empty, ask the user for it before continuing.

Steps:

1. Resolve the workspace and call `mcp__kanbantic__list_versions(workspaceId)`.
2. Filter the returned Versions to the ones whose Application matches `$ARGUMENTS`.
3. From that subset, select exactly three blocks:
   - the **Planned** Version (the next milestone, if any),
   - the **InProgress** Version (the one currently being built, if any),
   - the **most recent Released** Version (highest version / most recent release date).
4. Render the result as human-readable Markdown, one section per block:

   ```markdown
   ## Version status — <application-slug>

   ### Planned
   - **<code> — <name>** · status Planned · <target date or "no date">

   ### InProgress
   - **<code> — <name>** · status InProgress

   ### Latest Released
   - **<code> — <name>** · released <date>
   ```

   If a block has no matching Version, print `_none_` under that heading rather than omitting it.

This command is **read-only** — it never mutates a Version.
