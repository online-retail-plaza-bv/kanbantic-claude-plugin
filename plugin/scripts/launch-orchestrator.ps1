#requires -Version 5.1
<#
.SYNOPSIS
  Per-workstation launcher for the Kanbantic orchestrator (KBT-F438).

.DESCRIPTION
  Resolves the Kanbantic API key, then starts Claude Code with the channel flag
  the Agent Communication Hub requires and seeds the session with a
  `/kanbantic-orchestrate` invocation for the given workspace + initiative.

  This is a deliberate BRIDGE, not the end state. The full
  Workstation-Daemon `SpawnCommand` / Agent-Sessions integration (a daemon that
  spawns and supervises orchestrator sessions automatically) is intentionally
  DEFERRED until the v0.14.0 line is mature — see KBT-BD151 / KBT-BD154. Until
  then, an operator runs this script by hand on each workstation that should
  participate in an autonomous run.

.PARAMETER Workspace
  Workspace slug (e.g. "kanbantic"). Required.

.PARAMETER Initiative
  Initiative code or id (e.g. "KBT-INI033"). Required.

.PARAMETER Repos
  Optional comma-separated repository slugs/ids to constrain the run.

.PARAMETER ClaudeExe
  The Claude Code executable to launch. Default "claude".

.PARAMETER DryRun
  Resolve everything and print the launch plan as a single JSON line, then exit 0
  WITHOUT spawning Claude Code. The API key itself is never printed — only its
  presence and resolution source. Used by the test-suite and for operator
  dry-runs.

.PARAMETER SkipRegistryFallback
  Do not consult HKCU\Environment even when the env var is missing. Forces the
  env-only resolution path (used by the missing-key test so a real machine key
  cannot mask the fail-fast branch).

.PARAMETER RegistryValue
  Dependency-injection seam for tests: when supplied, this value is used INSTEAD
  of querying HKCU\Environment, so the registry-fallback branch can be exercised
  deterministically without touching the real registry. Production callers never
  pass this.

.EXAMPLE
  pwsh -File launch-orchestrator.ps1 -Workspace kanbantic -Initiative KBT-INI033

.EXAMPLE
  pwsh -File launch-orchestrator.ps1 -Workspace kanbantic -Initiative KBT-INI033 -Repos kanbantic,kanbantic-claude-plugin

.NOTES
  Exit codes:
    0 — launched (or dry-run completed).
    2 — missing required parameter (Workspace / Initiative).
    3 — API key could not be resolved (fail-fast; Claude Code is NOT spawned).
#>
[CmdletBinding()]
param(
  [string]$Workspace,
  [string]$Initiative,
  [string]$Repos,
  [string]$ClaudeExe = 'claude',
  [switch]$DryRun,
  [switch]$SkipRegistryFallback,
  [string]$RegistryValue
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# PS 5.1 (Windows PowerShell) has no $IsWindows automatic variable; it only ever
# runs on Windows, so treat an undefined $IsWindows as "on Windows".
$script:OnWindows = if (Test-Path Variable:\IsWindows) { [bool]$IsWindows } else { $true }

function Read-RegistryApiKey {
  # Mirrors the proxy + git-credential-helper: read KANBANTIC_API_KEY from the
  # HKCU\Environment User-scope so GUI-launched hosts that never inherited the
  # env var still resolve a key.
  try {
    $raw = & reg query 'HKCU\Environment' /v KANBANTIC_API_KEY 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    foreach ($line in $raw) {
      if ($line -match 'KANBANTIC_API_KEY\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$') {
        return $Matches[1].Trim()
      }
    }
  } catch {
    return $null
  }
  return $null
}

function Resolve-ApiKey {
  # 1) Environment (highest precedence — matches proxy + credential-helper order).
  if ($env:KANBANTIC_API_KEY) {
    return [pscustomobject]@{ Key = $env:KANBANTIC_API_KEY; Source = 'env' }
  }
  # 2) Registry fallback (HKCU\Environment), unless suppressed.
  if (-not $SkipRegistryFallback) {
    if ($RegistryValue) {
      # Test DI seam: a non-empty injected value stands in for the registry read
      # (production callers never pass -RegistryValue). Checked via the variable
      # value directly — $PSBoundParameters is function-scoped and empty here.
      return [pscustomobject]@{ Key = $RegistryValue; Source = 'registry(injected)' }
    } elseif ($script:OnWindows) {
      $regKey = Read-RegistryApiKey
      if ($regKey) {
        return [pscustomobject]@{ Key = $regKey; Source = 'registry(HKCU)' }
      }
    }
  }
  return $null
}

function Write-FailFast([string]$message, [int]$code) {
  [Console]::Error.WriteLine("launch-orchestrator: $message")
  exit $code
}

# --- Validate required parameters (fail-fast, no spawn) ----------------------
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  Write-FailFast 'missing -Workspace. Pass the workspace slug, e.g. -Workspace kanbantic.' 2
}
if ([string]::IsNullOrWhiteSpace($Initiative)) {
  Write-FailFast 'missing -Initiative. Pass the initiative code, e.g. -Initiative KBT-INI033.' 2
}

# --- Resolve the API key (fail-fast on miss, BEFORE spawning) ----------------
$resolved = Resolve-ApiKey
if ($null -eq $resolved) {
  Write-FailFast (
    'KANBANTIC_API_KEY not found in environment' +
    $(if ($SkipRegistryFallback) { '' } else { ' or HKCU\Environment' }) +
    '. Set it (User scope) with: ' +
    "[Environment]::SetEnvironmentVariable('KANBANTIC_API_KEY','ka_<agent>_<key>','User'). " +
    'Claude Code was NOT started.'
  ) 3
}

# --- Build the Claude Code invocation ----------------------------------------
$prompt = "/kanbantic-orchestrate workspace=$Workspace initiative=$Initiative"
if (-not [string]::IsNullOrWhiteSpace($Repos)) {
  $prompt += " repos=$Repos"
}

# The Agent Communication Hub channels are experimental — Claude Code needs this
# flag to accept channel push-notifications (see plugin/README.md).
$claudeArgs = @(
  '--dangerously-load-development-channels', 'server:kanbantic',
  $prompt
)

if ($DryRun) {
  # Never emit the key itself — only its presence + source.
  $plan = [pscustomobject]@{
    workspace      = $Workspace
    initiative     = $Initiative
    repos          = $(if ([string]::IsNullOrWhiteSpace($Repos)) { $null } else { $Repos })
    apiKeyPresent  = $true
    apiKeySource   = $resolved.Source
    claudeExe      = $ClaudeExe
    claudeArgs     = $claudeArgs
    prompt         = $prompt
    spawned        = $false
  }
  $plan | ConvertTo-Json -Compress -Depth 5
  exit 0
}

# Propagate the resolved key into the child environment so the bundled MCP proxy
# picks it up even when it came from the registry rather than the inherited env.
$env:KANBANTIC_API_KEY = $resolved.Key

Write-Host "launch-orchestrator: starting Claude Code for $Workspace / $Initiative (key source: $($resolved.Source))."
& $ClaudeExe @claudeArgs
exit $LASTEXITCODE
