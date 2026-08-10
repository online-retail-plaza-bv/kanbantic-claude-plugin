#!/usr/bin/env node
'use strict';

//
// session-start-release-drift — KBT-B586 / KBT-TC3485
//
// A SessionStart hook that reports an unregistered release, e.g.:
//
//   [release-drift] de repo draagt 2.37.0, de registry staat op v2.36.0 —
//   een release is uitgebracht zonder geregistreerd te worden.
//
// Why a hook rather than CI — a cost decision, not a capability gap.
//
// The plugin repo's CI holds no Kanbantic credentials today: `.github/workflows/ci.yml`
// uses zero secrets and makes zero calls to Kanbantic, and says so in a comment. An agent
// session already holds KANBANTIC_API_KEY, so putting the invoker here costs nothing,
// while putting it in CI costs one provisioned secret.
//
// That is the whole of the argument. It is NOT that CI could not do this: agent API keys
// work against `POST /api/app/Version/{id}/freeze` and `.../mark-released`, and the
// monorepo's own CI already calls the Kanbantic API with a Bearer token. An earlier
// version of this comment claimed the CI route was closed off, on two counts that are
// simply untrue — that `/api/app/cicd/*` are the only anonymous endpoints (they are not),
// and that they carry no version-registration surface (`report-deploy` / `report-smoke`
// reach `VersionPromotionService` → `version.MarkReleased()`). Corrected here because a
// false impossibility in a comment gets quoted as settled fact. KBT-BD208 §3 has the
// reckoning.
//
// Why SessionStart specifically. The defect in KBT-B586 is that the registration
// hung off one merge route. A hook that runs when a session opens is bypassed by no
// merge route at all: whoever merged, however they merged, the next session in that
// repo asks the question. It reports after the fact rather than preventing — also
// recorded in KBT-BD208.
//
// Silent when there is nothing to say. A hook that prints on every session start
// gets ignored, and an ignored hook is the same as no hook. Only a real drift — or
// an honest "could not tell" — produces output.
//
// Fail-safe, exactly like the toolkit-sync SessionStart hook (KBT-BD206): every
// path exits 0. Breaking every session on a workstation is a far worse outcome than
// an unreported drift.
//
// Config (env):
//   KANBANTIC_SKIP_RELEASE_DRIFT   — set to 1 to skip entirely.
//   KANBANTIC_RELEASE_DRIFT_APPLICATION — Application GUID override; normally read
//                                   from `git config kanbantic.applicationId`.
//
// Zero deps — Node built-ins only.
//

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DRIFT_SCRIPT = path.join(__dirname, '..', 'scripts', 'detect-release-drift.js');

/**
 * Render the operator-facing line, or null when there is nothing worth saying.
 *
 * Pure so it can be unit-tested without a repo, a network, or a session — the same
 * split as stop-version-summary.js.
 */
function formatDriftNotice(result) {
  if (!result || typeof result !== 'object') return null;

  // KBT-B586 review blocker A2 — a non-event is silent, always.
  //
  // `applicable: false` means this repository carries no version number this check
  // understands (the monorepo versions by git tag). `optedIn: false` means no Application
  // is configured, so nothing was ever asked of us. Neither is a problem, and neither is
  // news. The first version reported both as "could not verify", so every session in every
  // repository opened with a line about a check nobody had requested — and a hook that
  // talks when nothing was asked of it is a hook that gets switched off, after which it is
  // not there for the case that matters.
  if (result.applicable === false || result.optedIn === false) return null;

  if (result.answerable === false) {
    // Configured, asked, and it did not work. This one IS worth a line, because otherwise a
    // broken check looks exactly like a clean repository — the confusion the whole family of
    // defects turns on (KBT-B545, KBT-B548, KBT-B586).
    return `[release-drift] kan de release-registratie niet controleren: ${result.reason}`;
  }

  // An in-step registry is not proof the Version was released (the row usually predates the
  // release), but that caveat belongs to the review-lane close-out, not to every session
  // start. Reporting it here would fire on every healthy session — see KBT-BD208 §7.
  if (result.drifted !== true) return null;

  const carried = result.repoVersion;
  const known = result.baselineNumber === null
    ? 'geen enkele Version'
    : result.baselineNumber;

  return `[release-drift] de repo draagt ${carried}, de registry staat op ${known} — `
    + `een release is uitgebracht zonder geregistreerd te worden. `
    + `Draai de release-registratie uit kanbantic-issue-review Step 8.5 `
    + `(idempotent, dus veilig als iemand het al deed).`;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** The repo to inspect: the session's cwd, which is where the work happens. */
function resolveRepoRoot(payload) {
  if (payload && typeof payload.cwd === 'string' && payload.cwd.trim()) {
    return payload.cwd.trim();
  }
  return process.cwd();
}

async function main() {
  const raw = await readStdin();

  if (process.env.KANBANTIC_SKIP_RELEASE_DRIFT === '1') {
    process.exit(0);
  }

  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (_) {
    payload = null; // an unreadable payload is not a reason to skip the check
  }

  const repoRoot = resolveRepoRoot(payload);

  const r = spawnSync(process.execPath, [DRIFT_SCRIPT, repoRoot, '--quiet'], {
    encoding: 'utf8',
    timeout: 15000,
  });

  let result = null;
  try {
    const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
    result = line ? JSON.parse(line) : null;
  } catch (_) {
    result = null;
  }

  const notice = formatDriftNotice(result);
  if (notice) process.stdout.write(`${notice}\n`);
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}

// Exported for unit-testing the pure renderer.
module.exports = { formatDriftNotice, resolveRepoRoot, DRIFT_SCRIPT };
