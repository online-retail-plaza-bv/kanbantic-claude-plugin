---
description: "Orchestrate an initiative (KBT-F436): given {workspace, initiative, repos}, select actionable issues by priority, order them, and drive each through the lane-skills (triage → prepare → execute → review) with hand-offs. Sequencing only — claim, push, and merge stay in kanbantic-issue-execute / kanbantic-issue-review. Overridable per workspace via a Toolkit Skill item with slug kanbantic-orchestrate."
disable-model-invocation: true
---

Invoke the kanbantic-orchestrate skill and follow it exactly as presented to you.

Pass through any `workspace`, `initiative`, and `repos` arguments supplied with this command; if `workspace` or `initiative` is missing, ask before proceeding.
