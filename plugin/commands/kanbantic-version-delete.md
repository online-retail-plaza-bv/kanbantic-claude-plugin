---
description: "Delete a Version after an explicit confirmation prompt. WARNS that delete cascades to the Version's associated issues. Thin single-arg wrapper around the live delete_version MCP tool (KBT-SR517 / KBT-F470 / KBT-BD158)."
argument-hint: <version-code>
---

Delete the Version **`$ARGUMENTS`**.

Single positional argument: `$ARGUMENTS` is the **version-code** (e.g. `KBT-V210`). If it is empty, ask the user for it before continuing.

⚠️ **This is a destructive, non-recoverable mutating command.** Deleting a Version **cascades**: the backend deletes **every Issue whose `VersionId` is this Version** *before* deleting the Version itself (KBT-BD158). You MUST confirm — naming the cascade and the concrete associated-issue count — before mutating.

Steps:

1. Resolve `$ARGUMENTS` to the Version id (via `mcp__kanbantic__list_versions(workspaceId)` when the code is not already an id) and show the user the Version's `code`, `name`, and current `status`.
2. Determine the **associated-issue count** — call `mcp__kanbantic__list_issues(VersionId: <resolved id>)` and count the returned issues. This is the number of issues that will be **permanently deleted** by the cascade.
3. **Confirmation prompt** — ask explicitly:

   > You are about to **delete** `<code> — <name>`. This is **non-recoverable** and will also **permanently delete the <n> issue(s) associated with this Version** (cascade). Type `yes` to proceed, anything else to abort.

4. **Abort path:** if the user does not confirm with an affirmative (`yes` / `y` / `confirm`), do **nothing** — make no MCP call, and report `Aborted — Version <code> was not deleted.`
5. **Proceed path:** only on explicit confirmation, call `mcp__kanbantic__delete_version(...)` for the resolved Version.
6. Render the outcome as human-readable Markdown:

   ```markdown
   ## Version deleted — <version-code>
   - **Name:** <name>
   - **Cascade:** <n> associated issue(s) deleted
   ```
