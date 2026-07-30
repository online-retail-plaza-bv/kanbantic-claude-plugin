# Release Notes — v2.32.0

**KBT-F616 — Git commit identity: resolver script + self-healing PreToolUse gate**

## Waarom
KBT-F614 leverde de precedence (env var override > per-agent identity > per-repo fallback) af als **SKILL.md-proza**: de agent leest de `register_agent_session`-respons, redeneert zelf over de 3-weg precedence, en tikt dan handmatig twee `git config`-regels. Dat is inherent onbetrouwbaar — een model kan de stap overslaan, de precedence verkeerd toepassen, of 'm gewoon vergeten, en niets vangt dat op. Dezelfde les als KBT-B330 (de PAT verhuisde toen van SKILL.md-proza naar `kanbantic-git-credential-helper.js`): verplaats de logica uit agent-instructie-ruimte naar deterministische code.

## Plugin (deze repo)
- **`plugin/scripts/kanbantic-git-identity.js`** (nieuw) — zero-dependency resolver, spiegelt `kanbantic-git-credential-helper.js`'s auth/HTTP-patronen exact (`KANBANTIC_API_KEY` via env of `HKCU\Environment`, stateless `tools/call`-POST, geen initialize-handshake). Exporteert `resolveAndApplyIdentity({ cwd })` + een CLI-entrypoint. Precedence:
  1. `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` env vars beide gezet → no-op (git honoreert deze al boven `git config`).
  2. Anders: `get_current_agent_identity` (KBT-F615, Kanbantic API companion) — de eigen identity van de aanroepende agent, read-only en veilig om onbeperkt vaak aan te roepen (in tegenstelling tot `register_agent_session`, dat altijd een nieuwe `AgentSession`-rij aanmaakt — zie hieronder).
  3. Anders: `get_repository(repositoryId)` → de bestaande `gitAuthorName`/`gitAuthorEmail`-fallback.
- **`kanbantic-issue-execute`/`kanbantic-issue-review` Step 0b** — vervangt de handmatige precedence-proza + twee `git config`-regels door één scriptaanroep: `node "$CLAUDE_PLUGIN_ROOT/scripts/kanbantic-git-identity.js"`. Kleinere kans dat een agent het verkeerd doet — de logica staat in code, niet in proza dat gevolgd moet worden.
- **`plugin/hooks/pre-tool-use-git-identity-gate.js`** (nieuw) — een PreToolUse hook (matcher `Bash`, bedraad in `hooks.json`) die de identity zelf-heelt vlak vóór elke `git commit`. Dit is de daadwerkelijke handhavingslaag: hij werkt ook als de SKILL.md-stap hierboven is overgeslagen, door een mens buiten een lane-skill is gedraaid, of door een toekomstige/derde-partij-skill die `kanbantic-git-identity.js` nooit adopteert.
  - **Blokkeert nooit** — fail-open, net als elke andere hook in deze plugin (`pre-tool-use-locked-version-blocker.js`, de non-fatale paden van `abp-license-check.ps1`). Een niet-oplosbare identity is een kwaliteitsgat (de commit landt met wat git zelf raadt), nooit een reden om een commit te blokkeren.
  - Herkent zowel `git commit` als `git -C <dir> commit`; slaat de config-check + resolutie over als `GIT_AUTHOR_NAME`/`EMAIL` gezet zijn of `git config user.name`/`user.email` al beide non-empty zijn (geen onnodige netwerk-call per commit).

## Companion (Kanbantic API, aparte repo — KBT-F615)
Voegt een read-only `get_current_agent_identity`-tool toe (geen sessie/kanaal-side-effects). Nodig omdat `register_agent_session` altijd een nieuwe `AgentSession`-rij `InsertAsync`t — niet idempotent, dus onveilig om vóór elke commit aan te roepen (zou `/agent-sessions` vervuilen). Extraheert de naam/email-resolutielogica in een gedeelde `ClaudeAgentIdentityResolver`, gebruikt door zowel `register_agent_session` als deze nieuwe tool.

## Tests
`plugin/tests/kanbantic-git-identity.test.js` (8, spawn-based tegen een stub MCP-server + echte temp git-repo's — dezelfde techniek als `git-credential-helper.test.js`) en `plugin/tests/pre-tool-use-git-identity-gate.test.js` (11, integratie + pure-helper units — dezelfde techniek als `locked-version-blocker.test.js`). Alle 307 bestaande tests blijven groen.

## Bekende follow-up
`known-mcp-tools.json` wordt pas her-gesynced met `get_current_agent_identity` zodra KBT-F615 live is in productie (zelfde volgorde als eerdere tool-toevoegingen, bv. v2.13.0's `delete_version`).

## Grens
Geen Workstation Daemon-wijziging nodig: de per-agent identity komt uit de API-key-gebonden `ClaudeAgent`, niet uit een toekomstige per-proces env-injectie door de daemon. Commit-*signing* (KBT-E038 Ed25519 signing keys) is een apart, ongerelateerd mechanisme en blijft ongemoeid.
