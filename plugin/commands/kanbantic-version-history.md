---
description: "Show the chronological Version history for an Application as a paginated Markdown list. Thin single-arg wrapper around the live list_versions MCP tool (KBT-SR513 / KBT-F319)."
argument-hint: <application-slug>
---

Show the chronological Version history for the Application **`$ARGUMENTS`**.

Single positional argument: `$ARGUMENTS` is the **application-slug** (e.g. `kanbantic-api`). If it is empty, ask the user for it before continuing.

Steps:

1. Resolve the workspace and call `mcp__kanbantic__list_versions(workspaceId)`.
2. Filter the returned Versions to the ones whose Application matches `$ARGUMENTS`.
3. Sort them **chronologically** (oldest → newest, by version order / release date).
4. Render as a paginated human-readable Markdown table, ~20 rows per page:

   ```markdown
   ## Version history — <application-slug> (page 1)

   | Version | Name | Status | Date |
   |---|---|---|---|
   | <code> | <name> | <status> | <date> |
   ```

5. If more rows remain, print a `_Showing 1–20 of N. Ask for the next page to continue._` footer and, on request, render the next slice.

This command is **read-only** — it never mutates a Version.
