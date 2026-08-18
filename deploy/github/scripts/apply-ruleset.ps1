#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Past deploy/github/rulesets/main-protection.json toe op GitHub via de REST API.

.DESCRIPTION
    Source of truth: deploy/github/rulesets/main-protection.json.

    Het bestand wordt LETTERLIJK verstuurd. Alles wat erin staat wordt afgedwongen;
    alles wat eruit ontbreekt verdwijnt uit de live ruleset. Bewerk het dus nooit om
    een gewenste toestand te beschrijven zonder die ook echt te willen toepassen.

    Het script is idempotent: het zoekt de bestaande ruleset op NAAM en doet een PUT.
    Vindt het geen ruleset met die naam, dan STOPT het — tenzij -AllowCreate is
    meegegeven.

    Waarom die weigering: GitHub dwingt de UNIE van alle matchende rulesets af. Een
    naam die niet matcht laat het script een TWEEDE ruleset aanmaken naast de eerste,
    waardoor regels erbij komen in plaats van vervangen worden. In de monorepo stond
    die val open (KBT-B533): de default-naam was 'Kanbantic main protection' terwijl
    de live ruleset 'Protect Branch' heet. Hier is de default gelijk aan de naam in
    het JSON-bestand, dus het bedoelde PUT-pad wordt genomen.

    Vereist een token met Administration:Read+Write op deze repo — via `gh auth login`
    of de omgevingsvariabele GH_TOKEN.

.PARAMETER DryRun
    Toon de payload die verstuurd zou worden, zonder API-call.

.PARAMETER AllowCreate
    Sta toe dat er een nieuwe ruleset wordt aangemaakt als er geen met deze naam
    bestaat. Standaard uit; zie de KBT-B533-noot hierboven.

.PARAMETER Owner
    GitHub-organisatie. Default: Online-Retail-Plaza-BV.

.PARAMETER Repo
    Repo-naam. Default: kanbantic-claude-plugin.

.EXAMPLE
    # Bekijk wat er zou gebeuren:
    pwsh -File deploy/github/scripts/apply-ruleset.ps1 -DryRun

.EXAMPLE
    # Pas het gecommitte bestand toe op de live ruleset:
    pwsh -File deploy/github/scripts/apply-ruleset.ps1

.NOTES
    Na een wijziging: laat .github/workflows/ruleset-drift.yml draaien
    (workflow_dispatch) om te bevestigen dat live en bestand weer gelijk zijn.
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$AllowCreate,
    [string]$Owner = 'Online-Retail-Plaza-BV',
    [string]$Repo  = 'kanbantic-claude-plugin'
)

$ErrorActionPreference = 'Stop'

$repoRoot    = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$rulesetPath = Join-Path $repoRoot 'deploy/github/rulesets/main-protection.json'

if (-not (Test-Path $rulesetPath)) {
    throw "Ruleset-bestand niet gevonden: $rulesetPath"
}

# Het _comment-veld is documentatie voor de lezer; de API kent het niet en zou het
# als onbekende property afwijzen. Strippen vóór verzending.
$raw     = Get-Content $rulesetPath -Raw
$ruleset = $raw | ConvertFrom-Json
$ruleset.PSObject.Properties.Remove('_comment')

$name = $ruleset.name
if ([string]::IsNullOrWhiteSpace($name)) {
    throw "Het ruleset-bestand heeft geen 'name'. Die naam is de opzoeksleutel — zonder naam kan dit script niet weten wat het moet bijwerken."
}

Write-Host "Repo:            $Owner/$Repo"
Write-Host "Ruleset-naam:    $name"
Write-Host "Bronbestand:     $rulesetPath"

$payload = $ruleset | ConvertTo-Json -Depth 20

if ($DryRun) {
    Write-Host ''
    Write-Host '--- payload (dry run, niets verstuurd) ---'
    Write-Host $payload
    exit 0
}

Write-Host ''
Write-Host 'Live rulesets ophalen...'
$existing = gh api "repos/$Owner/$Repo/rulesets" | ConvertFrom-Json
$match    = $existing | Where-Object { $_.name -eq $name }

if ($match.Count -gt 1) {
    throw "Meerdere live rulesets heten '$name' (ids: $($match.id -join ', ')). GitHub dwingt de unie af; ruim dit eerst handmatig op."
}

$tmp = New-TemporaryFile
try {
    $payload | Set-Content -Path $tmp -Encoding utf8

    if ($match) {
        $id = $match.id
        Write-Host "Bestaande ruleset gevonden (id $id) — PUT (bijwerken)."
        gh api --method PUT "repos/$Owner/$Repo/rulesets/$id" --input $tmp | Out-Null
        Write-Host "Ruleset $id bijgewerkt."
    }
    elseif ($AllowCreate) {
        Write-Warning "Geen ruleset met naam '$name'. -AllowCreate is meegegeven — POST (aanmaken)."
        gh api --method POST "repos/$Owner/$Repo/rulesets" --input $tmp | Out-Null
        Write-Host 'Nieuwe ruleset aangemaakt.'
    }
    else {
        $namen = ($existing | ForEach-Object { "  id=$($_.id)  $($_.enforcement)  $($_.name)" }) -join "`n"
        throw @"
Geen live ruleset met de naam '$name'.

Aanmaken zou een TWEEDE ruleset naast de bestaande zetten en GitHub dwingt de unie
van alle matchende rulesets af — regels komen er dan bij in plaats van dat ze vervangen
worden. Meestal betekent dit dat de naam in het JSON-bestand niet meer klopt.

Live rulesets:
$namen

Is aanmaken echt de bedoeling, geef dan -AllowCreate mee.
"@
    }
}
finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Klaar. Draai .github/workflows/ruleset-drift.yml (workflow_dispatch) om te bevestigen dat live en bestand gelijk zijn.'
