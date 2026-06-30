---
description: "Generate Markdown release/version notes for a Version from its completed goals. Thin single-arg wrapper around the live get_version_notes MCP tool (KBT-SR513 / KBT-F319)."
argument-hint: <version-code>
---

Generate the version notes for **`$ARGUMENTS`**.

Single positional argument: `$ARGUMENTS` is the **version-code** (e.g. `KBT-V210`). If it is empty, ask the user for it before continuing.

Steps:

1. Resolve `$ARGUMENTS` to the Version id (`VersionId`) — call `mcp__kanbantic__list_versions(workspaceId)` and match on the code when `$ARGUMENTS` is not already an id.
2. Call `mcp__kanbantic__get_version_notes(VersionId)`.
3. Output the returned Markdown **verbatim** (it is already formatted version notes). Prefix it with a heading if the tool output has none:

   ```markdown
   ## Version notes — <version-code>

   <generated markdown>
   ```

This command is **read-only** — it never mutates a Version.
