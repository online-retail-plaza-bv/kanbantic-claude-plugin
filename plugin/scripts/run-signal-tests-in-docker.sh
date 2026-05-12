#!/bin/sh
# KBT-B224 — Run plugin/tests/proxy-signal-cleanup.test.js inside node:lts-alpine
# so real POSIX signal semantics are honored on Windows hosts.
#
# Why this wrapper exists:
#   On Windows hosts, Node converts `child.kill('SIGTERM')` and
#   `child.kill('SIGINT')` to SIGKILL — the proxy's signal handlers never run.
#   `plugin/tests/proxy-signal-cleanup.test.js` self-skips when
#   `process.platform === 'win32'`. This script runs the same test inside an
#   alpine container where Linux signal semantics are honored end-to-end.
#
# Same pattern as KBT-B195's `deploy/scripts/test/sha-extraction.test.sh`
# docker-test approach (alpine + busybox).
#
# Usage on Windows (Git Bash / WSL / PowerShell):
#   MSYS_NO_PATHCONV=1 ./plugin/scripts/run-signal-tests-in-docker.sh
# Usage on POSIX hosts (macOS / Linux): not required — `npm test` covers it
# natively — but this script is still valid and useful as a CI step.
#
# Apply KBT-GTCH034 on Windows: prefix with MSYS_NO_PATHCONV=1 + use
# multi-letter mount destination (`/work`) so MSYS does not rewrite the path.

set -eu

# Resolve repo root (script lives at <repo>/plugin/scripts/).
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Pin to node:lts-alpine. The proxy supports Node >=18 (see package.json
# engines); LTS is currently >=20. Bumps to a newer LTS are safe.
IMAGE="node:lts-alpine"

echo "[KBT-B224] running proxy-signal-cleanup tests inside ${IMAGE}"
echo "[KBT-B224] mounting ${REPO_ROOT} → /work"

exec docker run --rm \
  -v "${REPO_ROOT}:/work" \
  -w /work \
  "${IMAGE}" \
  node --test plugin/tests/proxy-signal-cleanup.test.js
