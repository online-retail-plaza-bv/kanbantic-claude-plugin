# Release Notes — v2.21.0

**KBT-E099 — Wireframe tooling for agents: one efficient fileset way + a Wireframe Subagent, single-content write methods removed**

Agents on other workstations (Claude Code, Cowork, MCP, REST) now have exactly **one** efficient,
context-free way to manage wireframes — and the misusable single-content write methods are gone.
This closes the two failure modes we kept hitting: whole files ending up in an agent's model
context (token waste) and multi-file wireframes rendering broken after a single-blob upload.

## F-A — atomic `create_wireframe` with a fileset (live in Kanbantic API v0.9.267)

`create_wireframe` builds **version 1 as the complete fileset** in one call, from `filesJson`
(a JSON array of `{path, content}`, 1..N files; a single-file wireframe is just a 1-element array).
There is no separate single-file create anymore — one method, so an agent can't grab the wrong one.

New universal uploader **`plugin/scripts/wireframe-upload.mjs`** (zero deps, Node + fetch):

```
# Create (version 1 = the fileset):
node wireframe-upload.mjs --dir <folder> --create --app <applicationId> --name "<name>" \
  [--entry index.html] --api <baseUrl> --token <token>
# Add a new version from a folder:
node wireframe-upload.mjs --dir <folder> --wireframe <id> [--entry index.html] --api ... --token ...
```

It reads the folder locally and POSTs straight to the REST API — the bytes go
folder → script → server, **never** through the model context or an MCP tools/call payload
(sidestepping the ~60–90 KB tools/call cap, KBT-B417). Text (`.html/.css/.js/.mjs/.json/.map/.svg/.txt`)
is sent as-is; everything else is base64 (server decodes byte-exact, KBT-SR526). base64 is never
applied to text — that would be pure inflation (KBT-RL161).

## F-B — the Wireframe Agent subagent + a context-free edit script

- **Wireframe Agent** subagent (Toolkit source-of-truth **KBT-SAGN009**, model Sonnet; disk-mirror
  `.claude/agents/wireframe-agent.md` via `/kanbantic-sync-workspace-skills`). It does all file
  handling in its **own isolated context** so the main agent's context stays clean, and it documents
  all six operations (create / replace-file / delete-file / edit-description / reorder-rename /
  delete), always context-free, respecting immutability (KBT-BD163) and VersionNumber-immutability
  (KBT-SR487).
- **`plugin/scripts/wireframe-edit.mjs`** (zero deps): replace/add or delete **one** file → a new
  immutable version. It fetches the current fileset from the server, applies exactly one change
  locally (rest carried over verbatim), and POSTs the new version. Bytes stream
  server → script → server; stdout is a one-line summary. Guards: the entry-point can't be deleted,
  and an empty fileset is refused.

```
node wireframe-edit.mjs --wireframe <id> --replace <path> --file <local> [--summary ...] --api ... --token ...
node wireframe-edit.mjs --wireframe <id> --delete  <path>                [--summary ...] --api ... --token ...
```

## F-C — steering so agents actually use it

A **Wireframes** section was added to the workspace ClaudeMd (**KBT-CLMD001**, auto-loaded via
`get_context` / `bootstrap_agent`): one fileset-create way; never put file content in your
context/tool-output; text as-is / binary base64; editing = a new version; and — for **every**
wireframe operation — delegate to the Wireframe Subagent. The subagent is registered in the
ClaudeMd Subagents table (KBT-SAGN009 → `.claude/agents/wireframe-agent.md`).

## F-D — BREAKING: the single-content write methods are removed

- **MCP tool `add_wireframe_version` (single content) is removed.** Use `add_wireframe_version_files`
  (fileset) or `wireframe-edit.mjs` instead.
- **`create_wireframe.initialContent` is removed** — `filesJson` is now **required**.
- `known-mcp-tools.json` is re-synced (the `add_wireframe_version` name is dropped; `add_wireframe_version_files`
  stays). The MUST-HAVE drift-check is unaffected.
- The local **filePath→content proxy** reroutes `create_wireframe` from the removed `initialContent`
  to `filesJson` (same offload as `add_wireframe_version_files`), and drops `add_wireframe_version`
  from the double-wrap guard set.

**Still present:** `update_wireframe_version` (single-content update based on a source version),
`add_wireframe_version_files`, the REST `POST .../version` add path, and the human wireframe editor
in the UI. The read-side **legacy single-blob projection (KBT-SR527)** is unchanged — existing
single-blob versions in the database keep rendering as a synthesized 1-file fileset.

## Lockstep

`plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `package.json` are all
bumped to **2.21.0** (check-version-sync green). Ships with the Kanbantic API/MCP F-D deploy.
