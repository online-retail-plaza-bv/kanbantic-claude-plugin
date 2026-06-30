---
description: "Show which Version an issue belongs to — plus all AffectsVersions for Bugs. Thin single-arg wrapper around the live issue_version_lookup MCP tool (KBT-SR513 / KBT-F319)."
argument-hint: <issue-code>
---

Show the Version assignment for issue **`$ARGUMENTS`**.

Single positional argument: `$ARGUMENTS` is the **issue-code** (e.g. `KBT-F319` or `KBT-B250`). If it is empty, ask the user for it before continuing.

> Note (KBT-SR513): the scope originally named `get_issue_deployment_info`; that tool does not exist. The live tool is `issue_version_lookup`.

Steps:

1. Call `mcp__kanbantic__issue_version_lookup(...)` for `$ARGUMENTS`.
2. Render the result as human-readable Markdown:

   ```markdown
   ## Version — <issue-code>

   - **Type:** <Epic|Feature|Bug>
   - **Version:** <version-code — name> (or _backlog / unassigned_)
   ```

3. **For Bugs**, additionally list every **AffectsVersions** entry:

   ```markdown
   ### Affects versions
   - <version-code — name>
   - <version-code — name>
   ```

   If the Bug affects no versions, print `_none recorded_`.

This command is **read-only** — it never mutates an issue or Version.
