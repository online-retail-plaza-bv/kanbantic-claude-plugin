---
description: "Manage Kanbantic CI/CD metadata via MCP: environments, pipelines, deployments and gates. Full CRUD is exposed as MCP tools (KBT-F473) so a deploy can be recorded end-to-end — including creating the target environment — without the web UI."
disable-model-invocation: true
---

Help the user manage the CI/CD deployment subsystem of a Kanbantic workspace using the MCP tools. All four entities support full CRUD via MCP.

## Entities & tools

**Environments** (a deploy target — Development / Staging / Acceptance / Production)
- `list_environments(workspaceId)`
- `create_environment(workspaceId, name, environmentType, url?, description?)`
- `update_environment(environmentId, name, environmentType, url?, description?, isActive?, order?)`
- `delete_environment(environmentId)`

**Pipelines** (build + deploy steps for an application)
- `list_pipelines(workspaceId?, status?, search?)`
- `create_pipeline(workspaceId, name, applicationId?, description?, buildSteps?, deploySteps?)`
- `update_pipeline(pipelineId, name, status, applicationId?, description?, buildSteps?, deploySteps?)`
- `delete_pipeline(pipelineId)`

**Deployments** (a version deployed to an environment; link an issue for a per-environment board badge)
- `list_deployments(workspaceId?, status?, environmentId?, VersionId?)`
- `create_deployment(workspaceId, version, environmentId, pipelineId?, VersionId?, issueId?, notes?)`
- `update_deployment_status(deploymentId, status)`
- `rollback_deployment(deploymentId, reason, targetDeploymentId?, triggeredByRunUrl?)`
- `delete_deployment(deploymentId)`

**Deployment gates** (checks that must pass before a deploy: Test / Coverage / Review / Conflict / ManualApproval)
- `list_deployment_gates(environmentId)`
- `create_deployment_gate(workspaceId, environmentId, gateType, configuration?, isEnabled?, order?)`
- `update_deployment_gate(gateId, gateType, configuration?, isEnabled?, order?)`
- `delete_deployment_gate(gateId)`
- `evaluate_deployment_gates(deploymentId)` · `get_deployment_gate_results(deploymentId)` · `override_gate_result(gateResultId, reason)`

## Typical flow

1. **First time:** create the environments the workspace needs — e.g. `create_environment(workspaceId, "Production", "Production")` and one for Staging. This is the prerequisite that `create_deployment` needs (without it, `create_deployment` fails with "Invalid environment ID").
2. Optionally attach gates to an environment with `create_deployment_gate`.
3. On each release: `create_deployment(...)`, link the issue via `issueId` so the board shows the per-environment deploy badge, then `update_deployment_status(deploymentId, "Succeeded")` (or `rollback_deployment` on failure).

Confirm the workspace first, then take the smallest action that satisfies the request. Deletes are soft-deletes but still destructive — confirm before deleting an environment that has deployments.
