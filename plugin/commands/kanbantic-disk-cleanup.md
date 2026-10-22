---
description: "Reclaim disk space on this workstation without destroying work: measure first, verify each post is waste, record a fallback, delete per post, report the measured gain. Thin wrapper around the kanbantic-disk-cleanup skill (KBT-F754)."
argument-hint: [--dry-run] [--full] [--repos <root,root>] [--siblings]
---

Run the **kanbantic-disk-cleanup** skill with arguments **`$ARGUMENTS`**.

Arguments (all optional):

- `--dry-run` — measure and report only; delete nothing.
- `--full` — also produce the elevated script for the human to run (never run it yourself).
- `--repos <root,root>` — extra repository roots (or folders full of repositories) for the worktree analysis.
- `--siblings` — also analyse the sibling repositories next to the current one.

Follow the skill's steps in order: measure → workspace policy → delegate if the workspace has a maintenance subagent → per post verify, record a fallback, delete, re-measure → report measured gains. The hard limits in the skill are not negotiable: no Docker containers, volumes or images; no worktrees with uncommitted or unpushed work; no `node_modules`, `bin`, `obj` or `dist` of active repositories; nothing that needs elevation.
