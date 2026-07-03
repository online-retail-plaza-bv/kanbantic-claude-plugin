# Release Notes — v2.17.0 (KBT-B398)

Fixes a **silent wireframe-corruption** bug in the stdio proxy's `filePath`
substitution (KBT-B398).

## The bug

`add_wireframe_version` / `create_wireframe` via `filePath` did a raw pass-through
of the file into the tool's content field. When the file was accidentally a saved
MCP **response** — `{"success":true,"version":{"content":"<!DOCTYPE html>…"}}` —
rather than raw HTML, the envelope was stored verbatim. The real HTML ended up
buried one level deep and the wireframe preview rendered JSON. No error was raised;
the corruption was silent.

Observed in production: wireframe *Adminmeester — SPA* (AdminHub → AdminDashboard)
v11 stored such a double-wrapped envelope.

## The fix

`resolveFilePathArgument` now detects the response fingerprint — a JSON object
whose `.version` carries a string `content` (or `initialContent`) — for the
wireframe-content tools (`add_wireframe_version`, `create_wireframe`) and refuses
with a clear `-32602` error instead of forwarding. This is consistent with the
existing "refuse rather than silently pick" ambiguity guard.

- Raw HTML (starts with `<`, not `{`) is never misdetected.
- The guard is scoped to the wireframe-content tools, so other tools may still
  upload JSON via `filePath`.
- Zero new dependencies.

## Tests

5 new regression tests in `plugin/tests/proxy-filepath.test.js` (unit + integration)
covering the reject path, the `create_wireframe` variant, the no-false-positive
case, and tool scoping. Full suite green.

## Follow-up

Server-side validation in the Kanbantic API (`add_wireframe_version` and siblings)
is tracked separately as **KBT-B399** — a second defence layer that also covers the
UI and direct-MCP write paths.

Part of **v0.6.0 — Execution Hardening (KBT-INI032)**.
