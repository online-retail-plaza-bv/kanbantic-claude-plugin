---
description: "Create a new app-scoped Version for an Application. Thin wrapper around the live app-scoped create_version MCP tool (KBT-SR517 / KBT-F470)."
argument-hint: <application-slug> <version-name> [description]
---

Create a new Version from **`$ARGUMENTS`**.

Positional arguments: `$ARGUMENTS` is `<application-slug> <version-name> [description]`.
- The **first** whitespace-separated token is the **application-slug** (e.g. `kanbantic-api`).
- The **next** token is the **version-name** (e.g. `v0.18.0` or `Q3 Hardening`). Quote it if it contains spaces.
- Anything after that is an optional free-text **description**.

If `$ARGUMENTS` is empty, or you cannot resolve both an application-slug and a version-name, ask the user for the missing part before continuing.

This command is **non-destructive** — it creates a brand-new Version and does not modify or delete any existing Version, so **no confirmation prompt is required**.

Steps:

1. Resolve the workspace and the owning **Application**: call `mcp__kanbantic__list_applications(workspaceId)` and match the first token to an Application by slug (fall back to name). If no Application matches, report the available slugs and stop — make no create call.
2. Call `mcp__kanbantic__create_version(...)` app-scoped with the resolved `workspaceId`, the Application's `applicationId`, the `name` (version-name), and the optional `description`.
3. Render the outcome as human-readable Markdown:

   ```markdown
   ## Version created — <code>
   - **Name:** <name>
   - **Application:** <application-slug>
   - **Status:** Planned
   ```
