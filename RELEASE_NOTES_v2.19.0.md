# Release Notes — v2.19.0 (KBT-B417)

Extends the stdio-proxy `filePath` offload (KBT-F464) to cover
**`add_wireframe_version_files`** so large multi-file wireframe filesets can be
saved in a single call.

## Bug

`add_wireframe_version_files` (KBT-F487) carries its whole payload in a
**`filesJson`** argument (a JSON-array string). The proxy's `filePath` machinery
— built in v2.10.0 precisely because large wireframe HTML broke over MCP — only
covered a tool's **`content`/`initialContent`** field, never `filesJson`. So the
entire fileset travelled inside the MCP `tools/call` message and hit the
client-side message-size cap (~60–90 KB after JSON-escaping), failing with an
"internal error". Agents could save small filesets but not realistic ones.

Diagnosis (2026-07-07): the backend HTTP path handles ≥200 KB, and the MCP host
+ SDK processed a 400 KB `tools/call` fine in a local repro — so the limit is
the **client→proxy** message size, exactly what `filePath` avoids for `content`.

## Fix

One line in `plugin/proxy/kanbantic-mcp-proxy.js`: map
`add_wireframe_version_files → filesJson` in `CONTENT_FIELD_BY_TOOL`. This makes
the existing, generic machinery light up for the fileset tool:

- `augmentToolsListResponse` advertises an optional `filePath` on the tool and
  drops `filesJson` from `required` (so Claude uses one or the other).
- `resolveFilePathArgument` reads the file into `filesJson` and drops `filePath`
  before forwarding; the ambiguity guard (both provided) and the unreadable-path
  error apply as for `content`.

Agents can now call `add_wireframe_version_files(wireframeId, filePath: "<local
.json containing the files array>")` — the large payload never enters the MCP
message. 3 new unit tests cover substitution, the ambiguity guard, and the
tools/list augmentation (`plugin/tests/proxy-filepath.test.js`). Full suite green
(165 tests).

## Version bump

Lockstep `2.18.0 → 2.19.0` across `plugin/.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, and `package.json`. Minor — additive proxy
capability, no behavior change to existing calls.

Follow-up to **KBT-F487** (the fileset tool) and **KBT-F464** (the filePath
offload it should have covered).
