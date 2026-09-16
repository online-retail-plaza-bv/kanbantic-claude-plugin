#requires -Version 5.1
# Shared helper: read the Kanbantic-session-file written by the stdio proxy and
# POST a transcript-event to the Kanbantic API. Hooks dot-source this file.
#
# KBT-F717 — one session file PER Claude session
# (.claude-kanbantic-session-<CLAUDE_CODE_SESSION_ID>.json), not one global
# file. This hook is a separate subprocess from the proxy and cannot learn the
# proxy's PID, so resolution mirrors plugin/proxy/session-file.js's
# resolveExistingSessionFile — kept in sync BY HAND (PowerShell cannot
# require() the JS module):
#   - CLAUDE_CODE_SESSION_ID set  -> that exact file.
#   - unset, exactly 1 file found -> that file (single-session case).
#   - unset, 0 or >=2 files found -> $null. NEVER pick "the newest" -- with two
#     concurrent sessions that is precisely the cross-session bug this
#     Feature fixes.

function Get-KanbanticSessionFilePath {
    $prefix = ".claude-kanbantic-session-"
    $suffix = ".json"

    if ($env:CLAUDE_CODE_SESSION_ID) {
        return (Join-Path $env:USERPROFILE "$prefix$($env:CLAUDE_CODE_SESSION_ID)$suffix")
    }

    $candidates = @(Get-ChildItem -Path $env:USERPROFILE -Filter "$prefix*$suffix" -File -ErrorAction SilentlyContinue)
    if ($candidates.Count -eq 1) {
        return $candidates[0].FullName
    }
    if ($candidates.Count -ge 2) {
        Write-Warning "[kanbantic-hook] multiple session files found and CLAUDE_CODE_SESSION_ID is not set -- cannot tell which session is ours. Skipping rather than guessing."
    }
    return $null
}

function Get-KanbanticSession {
    $sessionFile = Get-KanbanticSessionFilePath
    if (-not $sessionFile -or -not (Test-Path $sessionFile)) {
        return $null
    }
    try {
        return Get-Content $sessionFile -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-KanbanticConfig {
    $apiUrl = $env:KANBANTIC_API_URL
    if (-not $apiUrl) { $apiUrl = "https://kanbantic.com" }

    $apiKey = $env:KANBANTIC_API_KEY
    if (-not $apiKey) {
        # Fall back to HKCU\Environment for parity with the stdio proxy.
        try {
            $apiKey = (Get-ItemProperty -Path 'HKCU:\Environment' -Name 'KANBANTIC_API_KEY' -ErrorAction Stop).KANBANTIC_API_KEY
        } catch { $apiKey = $null }
    }

    return @{ ApiUrl = $apiUrl.TrimEnd('/'); ApiKey = $apiKey }
}

function Send-TranscriptEvent {
    param(
        [Parameter(Mandatory)] [string] $MessageType,
        [Parameter(Mandatory)] [string] $Content,
        [string] $JsonlRecordUuid = $null,
        [byte[]] $Payload = $null,
        [int] $MaxRetries = 3
    )

    $session = Get-KanbanticSession
    if (-not $session -or -not $session.channelId) {
        # Silent skip — agent may not yet have registered a Kanbantic session.
        return
    }

    $config = Get-KanbanticConfig
    if (-not $config.ApiKey) {
        Write-Error "[kanbantic-hook] KANBANTIC_API_KEY not set"
        return
    }

    $body = @{
        messageType = $MessageType
        content = $Content
    }
    if ($JsonlRecordUuid) { $body.jsonlRecordUuid = $JsonlRecordUuid }
    if ($Payload) { $body.payload = [Convert]::ToBase64String($Payload) }

    $uri = "$($config.ApiUrl)/api/app/agent-channel/$($session.channelId)/ingest-transcript-event"
    $headers = @{
        'Authorization' = "Bearer $($config.ApiKey)"
        'Content-Type'  = 'application/json'
    }

    # Simple retry with exponential backoff. On final failure, log to stderr —
    # hook failures must NEVER block the user prompt. Hooks run async to Claude.
    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        try {
            $jsonBody = $body | ConvertTo-Json -Depth 10 -Compress
            Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $jsonBody -TimeoutSec 10 | Out-Null
            return
        } catch {
            if ($attempt -eq $MaxRetries) {
                Write-Error "[kanbantic-hook] failed after $MaxRetries attempts: $($_.Exception.Message)"
                return
            }
            Start-Sleep -Seconds ([math]::Pow(2, $attempt - 1))
        }
    }
}

function Read-HookInput {
    # Claude Code sends hook event JSON via stdin.
    $input = [Console]::In.ReadToEnd()
    if (-not $input) { return $null }
    try {
        return $input | ConvertFrom-Json
    } catch {
        return $null
    }
}
