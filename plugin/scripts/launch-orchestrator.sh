#!/usr/bin/env bash
#
# launch-orchestrator.sh — per-workstation launcher for the Kanbantic
# orchestrator (KBT-F438), POSIX/macOS/Linux counterpart of
# launch-orchestrator.ps1.
#
# This is a deliberate manual BRIDGE, not a stand-in for missing functionality
# (KBT-F726 correction — this used to claim the daemon integration was DEFERRED;
# it is live: SpawnCommandPollingService spawns+supervises orchestrator sessions
# today, see KBT-B465/F722/F724). An operator runs this by hand on each
# workstation for a one-off run outside that daemon-managed flow.
#
# API key resolution: environment only. There is no HKCU\Environment fallback on
# non-Windows hosts (that branch is Windows-specific; see the .ps1 variant).
#
# Usage:
#   ./launch-orchestrator.sh --workspace kanbantic --initiative KBT-INI033 [--repos a,b] [--dry-run]
#
# Exit codes:
#   0 — launched (or dry-run completed).
#   2 — missing required parameter (--workspace / --initiative).
#   3 — KANBANTIC_API_KEY not set (fail-fast; Claude Code is NOT spawned).
#
set -euo pipefail

WORKSPACE=""
INITIATIVE=""
REPOS=""
CLAUDE_EXE="${CLAUDE_EXE:-claude}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace)  WORKSPACE="${2:-}"; shift 2 ;;
    --initiative) INITIATIVE="${2:-}"; shift 2 ;;
    --repos)      REPOS="${2:-}"; shift 2 ;;
    --claude-exe) CLAUDE_EXE="${2:-}"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *)
      echo "launch-orchestrator: unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail_fast() { echo "launch-orchestrator: $1" >&2; exit "$2"; }

[ -n "$WORKSPACE" ]  || fail_fast "missing --workspace (e.g. --workspace kanbantic)." 2
[ -n "$INITIATIVE" ] || fail_fast "missing --initiative (e.g. --initiative KBT-INI033)." 2

if [ -z "${KANBANTIC_API_KEY:-}" ]; then
  fail_fast "KANBANTIC_API_KEY not set. Export it before launching: export KANBANTIC_API_KEY=ka_<agent>_<key>. Claude Code was NOT started." 3
fi

PROMPT="/kanbantic-orchestrate workspace=$WORKSPACE initiative=$INITIATIVE"
[ -n "$REPOS" ] && PROMPT="$PROMPT repos=$REPOS"

if [ "$DRY_RUN" -eq 1 ]; then
  # Never print the key — only its presence + source.
  printf '{"workspace":"%s","initiative":"%s","repos":%s,"apiKeyPresent":true,"apiKeySource":"env","claudeExe":"%s","prompt":"%s","spawned":false}\n' \
    "$WORKSPACE" "$INITIATIVE" \
    "$([ -n "$REPOS" ] && printf '"%s"' "$REPOS" || printf 'null')" \
    "$CLAUDE_EXE" "$PROMPT"
  exit 0
fi

echo "launch-orchestrator: starting Claude Code for $WORKSPACE / $INITIATIVE (key source: env)."
# KBT-B976 / KBT-SR632 — MUST be the equals-form, ONE argv entry. The space-form
# lets the CLI parser swallow the following $PROMPT as an untagged channel
# entry, which Claude Code rejects with exit 1 (KBT-B242).
exec "$CLAUDE_EXE" --dangerously-load-development-channels=plugin:kanbantic-claude-plugin@kanbantic "$PROMPT"
