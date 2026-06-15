# Kanbantic Claude Code Plugin — v2.7.0

**Released:** 2026-06-15 · **Issue:** [KBT-B330](https://kanbantic.com/issues/KBT-B330)

## Summary

Ships a zero-dependency **git credential helper** so a repository PAT is fetched
**just-in-time** from Kanbantic and fed to git over stdin — never persisted. The
three lane-skills (`kanbantic-issue-execute`, `kanbantic-issue-review`,
`kanbantic-issue-prepare`) stop cloning with the token embedded in the URL.

## Why this exists

The lane-skills used to instruct agents to clone like this:

```bash
git clone https://<credential>@github.com/<org>/<repo>.git
```

Git writes the remote URL **verbatim** into `.git/config` (`remote.origin.url`),
so the plaintext PAT lived on disk for the lifetime of every clone — on every
workstation, in every workspace. The token also landed in shell history, the
process list, and the agent transcript.

This was not theoretical: on 2026-06-15 a PAT was found embedded in plaintext in
the `remote.origin.url` of a sibling repo (`adminhub-manifests`, AdminHub
workspace) on a developer workstation. The standing policy is that agents obtain
the Git PAT just-in-time from the repo in the Kanbantic workspace they are working
in — and nowhere else — and never persist it. A per-workspace memory / CLAUDE.md
note cannot enforce that: agents run on many machines across many workspaces, but
**always** through this plugin. The client-side choke-point is the right place for
the fix.

## What this adds

`plugin/scripts/kanbantic-git-credential-helper.js` — a git credential helper
(gitcredentials(7)) that:

- On `get`: resolves the repository id (env `KANBANTIC_REPOSITORY_ID`, else
  `git config --get kanbantic.repositoryId`), calls `get_repository_credential`
  against the Kanbantic MCP server (reusing the proxy's `KANBANTIC_API_KEY` +
  Bearer auth + `HKCU\Environment` fallback; the server is stateless so a single
  `tools/call` works), and emits `username` + `password` to git over stdout.
- On `store` / `erase`: no-op — nothing is ever persisted.
- On any failure (no key, no repo id, MCP error, `success:false`): emits nothing
  and exits 0, so git falls through to its normal flow instead of erroring/hanging.
  Diagnostics go to **stderr**; the token is only ever written to git over stdout.
- Zero dependencies — Node.js built-ins only.

The lane-skills now clone the **clean** `https://github.com/<org>/<repo>.git` URL
and configure the helper:

```bash
HELPER="!node \"$CLAUDE_PLUGIN_ROOT/scripts/kanbantic-git-credential-helper.js\""
git clone \
  -c credential.helper="$HELPER" \
  -c kanbantic.repositoryId="<repositoryId>" \
  https://github.com/<org>/<repo>.git
cd <repo>
git config credential.helper "$HELPER"
git config kanbantic.repositoryId "<repositoryId>"
```

`-c kanbantic.repositoryId=…` is propagated to the helper during the initial clone
via `GIT_CONFIG_PARAMETERS`; the persisted `git config` keys cover later
fetch/push. `kanbantic.repositoryId` is **not** a secret.

## Result: where the PAT no longer appears

| Surface | Before (token-in-URL) | After (credential helper) |
|---|---|---|
| `.git/config` (at rest) | ❌ persisted | ✅ never |
| clone/push URL, command line | ❌ present | ✅ never |
| shell history / process list | ❌ present | ✅ never |
| agent transcript | ❌ present | ✅ never (helper calls the MCP tool) |

## Files changed

### New
- `plugin/scripts/kanbantic-git-credential-helper.js` — the credential helper.
- `plugin/tests/git-credential-helper.test.js` — 6 spawn tests (token emit +
  repositoryId forward, GitLab username, `success:false` fall-through, missing
  repo id, `store`/`erase` no-op, token-absent-from-stderr).
- `RELEASE_NOTES_v2.7.0.md` (this file).

### Modified
- `plugin/skills/kanbantic-issue-execute/SKILL.md`
- `plugin/skills/kanbantic-issue-review/SKILL.md`
- `plugin/skills/kanbantic-issue-prepare/SKILL.md`
  — clone via the credential helper + clean URL; the skills no longer call
  `get_repository_credential` directly or embed the token in the URL.
- `plugin/.claude-plugin/plugin.json` — `version` 2.6.0 → 2.7.0; `description` extended.

## Verification

```
npm test
node plugin/scripts/lint-skills.js
```

Result on 2026-06-15 (Windows 11):

```
ℹ tests 55 / pass 53 / fail 0 / skipped 2   (2 skips = Windows signal-handling tests)
lint-skills: OK: all SKILL.md invariants pass
check-bundle-tool-drift: OK: all MUST-HAVE tools present
```

## References

- `KBT-B330` — this fix.
- Source incident: AdminHub `adminhub-manifests` plaintext-PAT in `remote.origin.url` (2026-06-15).
