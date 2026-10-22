---
name: kanbantic-disk-cleanup
description: "Reclaim disk space on the workstation without destroying work: measure first, verify per post that it is waste, record a fallback, delete, and report the measured gain. Reads the optional workspace Toolkit item `disk-cleanup-policy`, delegates to a workspace maintenance subagent when one exists, and hands the elevated part to a human as a script. Never touches Docker containers, volumes or images; never removes a worktree with uncommitted or unpushed work; never deletes node_modules/bin/obj of active repositories (KBT-F754)."
---

# Kanbantic Disk Cleanup

## Overview

A dev workstation fills up with build waste that nobody removes because nobody sees it: agent worktrees under `.claude/worktrees/`, a temp folder full of installers, package caches of three ecosystems, a Docker data disk that grows and never shrinks. A full disk does not announce itself politely — it shows up as a restore that dies halfway, a worktree checkout with half-written files, a test that cannot create its tmp-dir.

This skill reclaims that space **without destroying anything that is still needed**. Its one governing rule:

> **Measure, then delete.** Never remove a post on an assumption. Measure the free space and the candidates first, verify per post that it really is waste, record a fallback for anything that is not trivially reproducible, delete per post, and re-measure so you report the **measured** gain instead of the budgeted one.

**Announce at start:** "I'm using the kanbantic-disk-cleanup skill to reclaim disk space — measuring first, deleting only verified waste."

## Scope

This skill is **not** a lane-verwerker — it transitions no Kanbantic issue. It is a maintenance utility. It is generic (KBT-B499 / KBT-TRUL014): it knows *how* to clean safely, not how big your disk is, where your repositories live, or which folder you insist on keeping. Those come from the workspace (Step 1) or from the arguments.

The skill is for **the volume the session runs on**. Pass `--path` to the measurement script for another volume.

## Modes

| Invocation | Behaviour |
|---|---|
| `/kanbantic-disk-cleanup` | measure → verify → delete the safe posts → report |
| `/kanbantic-disk-cleanup --dry-run` | measure and report only; delete nothing |
| `/kanbantic-disk-cleanup --full` | as default, plus write the elevated script for a human (Step 7) |
| `--repos <root,root>` | extra repository roots, or folders full of repositories, for the worktree analysis |
| `--siblings` | also analyse the repositories next to the current one |

<HARD-GATE>
**Hard limits — these do not bend, whatever the free-space number says.**

1. **Docker: build cache only.** Never `docker system prune`, `docker container prune`, `docker volume prune`, `docker image prune`, `docker rm -f`, `docker rmi`. Several agents may share one Docker daemon that does not isolate with git worktrees; removing another agent's container has broken whole test suites. Never stop Docker Desktop or shut down WSL unless a human asks for exactly that.
2. **Worktrees: only verified-safe ones.** A worktree with uncommitted changes, with commits that are not on the remote, or with a lock from a living process stays. The measurement script computes this; you do not override it by eye.
3. **Never `git branch -D`.** Removing a worktree removes a folder; the branch and its commits stay in the object database for free. Deleting the branch is a separate decision that belongs to a human.
4. **Never `node_modules`, `bin`, `obj`, `dist` of active repositories.** They are needed again tomorrow; a rebuild costs more than the space is worth. Never `pagefile.sys` / `swapfile.sys`. Never the Windows component store by hand (only DISM, and only elevated — Step 7).
5. **Never elevate, never run the elevated script.** An agent cannot elevate. Anything that needs it (data-disk compaction, component-store cleanup, update cache) is written down as a script and handed to a human.
6. **Protected paths from the policy are untouchable** (Step 1), even when every other rule would allow them.
7. **Fail-not-skip (KBT-RL191).** A policy that does not parse, a `docker ps -a` that is not empty, a worktree whose state you cannot determine — each of these means *stop that post and say so*, never "probably fine".
</HARD-GATE>

## Step 0: Measure

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/disk-space.js" [--repos <root,root>] [--siblings] [--temp-age-days <N>]
```

The script **measures only** — it never deletes. It prints a readable report; add `--json` for the structured inventory. Measuring folder sizes on a full, busy disk is slow; use `--no-sizes` for a quick first look and measure the posts you intend to touch afterwards.

Record the **free space before** from the first line of the report. Every later step compares against it.

The inventory has one block per post:

- **Post 1 — agent worktrees**, per repository: branch, size, uncommitted changes (`Dirty`), commits not on the remote (`Ongepusht`), lock state, and `Veilig` (`ja` only when *all* of agent-worktree + clean + fully pushed + unlocked hold). The `Reden` column says what is waiting on a human.
- **Post 2 — temp folder**: total size and the entries older than `--temp-age-days` (default 2). The running Claude Code scratchpad (`<temp>/claude`) is always skipped.
- **Post 3 — package caches and data disks**: npm, NuGet, pip, Playwright browser builds, the Docker Desktop data disk — with the command that reclaims each.

## Step 1: Workspace policy (Toolkit item `disk-cleanup-policy`)

```
MCP: mcp__kanbantic__list_toolkit_items(workspaceId: "<slug>", category: "Custom", search: "disk-cleanup-policy")
```

Look for the item titled exactly **`disk-cleanup-policy`**. **No such item ⇒ the defaults apply (warn 20 GB, critical 12 GB, temp age 2 days, Docker build-cache only, no protected paths, no delegate). That is the normal case and not a warning.**

The item body holds a markdown table, columns recognised by name:

| Setting | Value |
|---|---|
| warn-gb | 20 |
| critical-gb | 12 |
| repo-roots | C:\github, D:\work |
| protected-paths | C:\github\big-repo\node_modules |
| temp-age-days | 2 |
| delegate-to | maintenance-agent |
| elevated-script | KBT-CUST002 |
| docker | build-cache-only |

Parse it with the bundled parser — never by eye:

```bash
node -e "const p=require('$CLAUDE_PLUGIN_ROOT/scripts/disk-cleanup-policy.js');console.log(JSON.stringify(p.parseDiskCleanupPolicy(require('fs').readFileSync(process.argv[1],'utf8'))))" <path-to-item-body>
```

If `errors` is non-empty: **STOP**. Do not delete anything. A policy you cannot read may name a protected path you would otherwise remove. Report each `{line, reason}` so the item can be fixed, then exit cleanly. `repo-roots` feeds `--repos` of Step 0 — re-run the measurement with them if you measured before reading the policy.

## Step 2: Delegate when the workspace has its own maintenance subagent

Workspace knowledge beats generic knowledge. If the policy names a `delegate-to`, or — without a policy — the file `.claude/agents/maintenance-agent.md` exists in the repository (a Toolkit `Subagent` mirror, see `kanbantic-sync-workspace-skills`), **delegate the whole cleanup to that subagent** via the Agent tool, passing:

- the inventory from Step 0 (the `--json` output, or its path),
- the parsed policy from Step 1,
- the mode (`--dry-run` / `--full`),
- the hard limits above, verbatim.

Relay its report as your own (Step 8) and stop here. The subagent carries the workstation-specific protocol (disk size, incident history, elevated script source); this skill only guarantees that it is invoked with a measurement in hand.

No delegate ⇒ continue with Steps 3–7 yourself.

## Step 3: Post 1 — stale agent worktrees

Usually the largest and fastest win, and the post that comes back first: every parallel agent run leaves a few behind, and nothing removes them automatically.

Only rows with `Veilig = ja` are candidates. For each candidate, in order:

1. **Protected?** Skip anything under a protected path (Step 1).
2. **Record the fallback** — the branch name and SHA of every worktree, plus every local branch, into the repository's `.git/` folder (not into the temp folder you are about to clean):

   ```bash
   git -C <repo> worktree list --porcelain > "<repo>/.git/worktree-backup-<yyyy-mm-dd>.txt"
   git -C <repo> for-each-ref --format='%(objectname)  %(refname:short)' refs/heads >> "<repo>/.git/worktree-backup-<yyyy-mm-dd>.txt"
   ```

3. **Detach shared junctions first.** In a monorepo, `node_modules` inside a worktree is often a junction (Windows) or symlink to the main checkout's install. Removing the worktree recursively would follow it and wipe the shared install. Detach the link itself first — `[System.IO.Directory]::Delete("<worktree>\node_modules")` (non-recursive) on Windows, `rm <worktree>/node_modules` (the link, no `-r`) elsewhere — and only then remove the worktree.
4. **Remove and prune:**

   ```bash
   git -C <repo> worktree remove --force "<worktree>"
   git -C <repo> worktree prune -v
   ```

   `--force` is needed because of untracked files (Playwright dumps, screenshots) — that is all that is lost. Branches and commits stay.
5. **Stale locks:** a worktree may be `locked` by an agent pid that no longer lives. Check the pid; if it is gone, `git worktree unlock <path>` and treat it as a candidate again. If the pid lives, it stays.

Rows with `Veilig = NEE` are **reported, not removed** — with their `Reden`, so a human can decide (push the commits, or confirm they may go).

Re-measure the free space after this post.

## Step 4: Post 2 — temp folder

Delete only the entries the inventory lists as older than the temp age. Never the Claude Code scratchpad (`<temp>/claude`), never anything touched today. Entries that fail to delete (in use) are skipped and reported, not retried with force.

```powershell
# Windows — entries the inventory listed as stale
foreach ($t in $stale) { try { Remove-Item $t -Recurse -Force -ErrorAction Stop } catch { "in gebruik: $t" } }
```

Empty the recycle bin only after looking at what is in it (`Clear-RecycleBin -DriveLetter C -Force` on Windows). Re-measure.

## Step 5: Post 3 — package caches

All reproducible; the cost is a slower first restore. Run only the ones whose tool is installed and whose cache the inventory shows as present:

```bash
npm cache clean --force
dotnet nuget locals all --clear
pip cache purge
```

**Playwright browser builds** stack up per revision under the inventory's Playwright path. Determine the revision in use from the `@playwright/test` version in the repositories' `package.json` files, and remove only **older** revisions plus orphaned `mcp-chrome-*` folders. Never the revision in use — the next E2E run would re-download it.

Re-measure.

## Step 6: Post 4 — Docker build cache (and nothing else)

Skip this post entirely when the policy says `docker: skip`.

**Mandatory pre-check:**

```bash
docker ps -a
docker system df
docker buildx du
```

If `docker ps -a` lists **any** container — running or stopped — another agent or a test run may be active. **Skip Docker completely and say so in the report.** The few GB are not worth someone else's test run.

With an empty `docker ps -a`, prune the **build cache only** — it belongs to nobody and rebuilds itself:

```bash
docker buildx prune -af
docker buildx du        # expect "Reclaimable: 0B"
```

> Pitfall on Docker Desktop: `docker builder prune -af` may fail with `No such container: buildx_buildkit_desktop-linux` and then reclaim nothing while exiting 0. Use the `buildx` form and verify with `docker buildx du`.

On Windows and macOS the Docker data disk only shrinks when the daemon trims and compacts it; after a prune, `wsl -d docker-desktop -e sh -c "fstrim -av"` (Docker Desktop must be running) zeroes the freed blocks so a later compaction wins more. The compaction itself is elevated — Step 7. Re-measure.

## Step 7: The elevated part (`--full` only) — write, never run

An agent cannot elevate. If the policy names an `elevated-script` Toolkit item, **take the script from there verbatim** — do not regenerate it from memory; a regenerated version once dropped a detach verification and left a workstation's Docker unusable for two hours. Without such an item, write a script that does, with explicit before/after measurements:

- **Data-disk compaction** (Windows: `Optimize-VHD -Mode Full` with Hyper-V, else `diskpart` `compact vdisk` — Docker and WSL fully down first, and **verify the detach afterwards** with `(Get-DiskImage -ImagePath "<vhdx>").Attached` = `False`; an attached disk makes Docker refuse to start).
- **Component store** (`Dism /Online /Cleanup-Image /AnalyzeComponentStore`, then `/StartComponentCleanup`; warn that `/ResetBase` makes installed updates unremovable).
- **Update download cache** (stop `wuauserv` + `bits`, empty `SoftwareDistribution\Download`, restart the services).

Save it under the session scratchpad, print the full path and the one-liner to start it elevated, and state that the first build afterwards reuses no cache. **Do not execute it.**

## Step 8: Report

Report per post the **measured** gain, never the budgeted one, plus:

- free space **before** and **after** (from Step 0 and the last re-measurement);
- what you deliberately left alone and why — unsafe worktrees with their reasons, protected paths, Docker skipped because containers existed;
- which posts are waiting on a human (unpushed worktrees, the elevated script);
- structural leaks you ran into (a folder that fills up and is in no `.gitignore`, a cache nobody ever clears).

When the skill runs in the context of a Kanbantic issue, record the report as a `Comment` discussion entry on that issue (`mcp__kanbantic__add_discussion_entry`); otherwise the report is your reply. A structural leak worth remembering belongs in the workspace Toolkit as a Gotcha (`mcp__kanbantic__create_toolkit_item`), not in local memory (KBT-TRUL021).

## The SessionStart warning

The plugin ships `hooks/session-start-disk-space.js`: at every session start it measures the free space of the volume the session runs on and prints **one line** when it is below the warn threshold (default 20 GB; "critical" below 12 GB). Above the threshold it is silent. It never blocks a session: every failure path exits 0 without output.

| Variable | Effect |
|---|---|
| `KANBANTIC_DISK_WARN_GB` | warn below this many GB (default 20); `0` disables the hook |
| `KANBANTIC_DISK_CRITICAL_GB` | "critical" wording below this many GB (default 12) |
| `KANBANTIC_SKIP_DISK_CHECK=1` | skip the hook entirely |

The hook's thresholds are environment-level; the policy item's `warn-gb` / `critical-gb` are what *this skill* reports against. Keep them aligned per workstation.

## Filesystem footprint

| Path | Purpose |
|---|---|
| `<repo>/.git/worktree-backup-<date>.txt` | fallback record before removing worktrees (Step 3) |
| session scratchpad | the elevated script (Step 7), when `--full` |

Nothing else is written. Everything else is deleted — per post, after verification, with a measurement after.
