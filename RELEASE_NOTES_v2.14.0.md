# Release Notes — v2.14.0 (KBT-F473)

Exposes the completed **CI/CD deployment-CRUD** surface (KBT-F473) on the plugin
side and re-syncs the curated `known-mcp-tools.json` snapshot to the live registry.

## New command — `/manage-cicd`

`plugin/commands/manage-cicd.md` — a guide/wrapper for managing a workspace's
CI/CD deployment subsystem via the MCP tools. Covers full CRUD for all four
entities:

- **Environments** — `create_environment`, `list_environments`, `update_environment`, `delete_environment` (previously **no** Environment MCP tools existed — the reason `create_deployment` used to fail with "Invalid environment ID").
- **Pipelines** — `create_pipeline`, `update_pipeline`, `delete_pipeline` (list already existed).
- **Deployments** — `delete_deployment` (create/list/update-status/rollback already existed).
- **Gates** — `delete_deployment_gate` (create/list/update/evaluate/override already existed).

Includes the typical first-time flow: create the workspace's environments →
optionally attach gates → record each release with `create_deployment` (link the
issue for a per-environment board badge) → `update_deployment_status` / `rollback_deployment`.

## Snapshot re-sync — `known-mcp-tools.json`

The curated bundle snapshot had drifted ~24 tools behind the live registry
(183 → **207**). Regenerated from the live `tools/list`, so it now includes the
nine KBT-F473 CI/CD-CRUD tools plus the other tools added since the last sync.
`check-bundle-tool-drift` stays green.

## Under the hood (Kanbantic repo, KBT-F473)

The nine new MCP tools wrap the existing `ICicdAppService` CRUD methods; the
backend and Angular CI/CD dashboard already had full CRUD. Covered by a metadata
test (registration of all nine) + integration round-trips (create_environment →
create_deployment; delete → soft-delete) against a Postgres testcontainer.

Part of **v0.6.0 — Execution Hardening (KBT-INI032)**.
