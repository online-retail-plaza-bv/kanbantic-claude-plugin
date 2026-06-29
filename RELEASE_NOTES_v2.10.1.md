# Release Notes v2.10.1 — filePath ambiguity-guard bugfix (KBT-B349)

## Bug fixed

**KBT-B349** — `filePath` calls were silently rejected by the proxy's own ambiguity guard.

### Root cause

`augmentToolsListResponse` (introduced in v2.10.0 / KBT-F464) adds `filePath` as an
optional property to every tool schema that carries a `content` parameter. However, it
did **not** remove `content` from `schema.required`.

Because `content` remained required, Claude always filled it in alongside `filePath` to
satisfy the schema constraint. The proxy's `resolveFilePathArgument` then detected both
a non-empty `content` and a `filePath`, treated this as an ambiguous call, and returned
a `-32602` error without forwarding — every `filePath` invocation failed silently.

### Fix

`augmentToolsListResponse` now filters `content` out of `schema.required` at the same
time it adds `filePath` to `properties`:

```js
if (Array.isArray(schema.required)) {
  schema.required = schema.required.filter(r => r !== 'content');
}
```

With `content` no longer required, Claude provides **either** `filePath` **or** `content`
— never both — and the substitution path in `resolveFilePathArgument` runs as intended.

### Affected tools

All MCP tools with a `content` parameter (e.g. `add_wireframe_version`,
`update_wireframe_version`). No server-side changes; proxy only.

### No breaking changes

- `content`-only calls are unaffected (ambiguity guard still absent; proxy forwards verbatim).
- `filePath`-only calls now work as designed.
- Explicit `filePath` + `content` is still rejected with `-32602` (correct behaviour).
