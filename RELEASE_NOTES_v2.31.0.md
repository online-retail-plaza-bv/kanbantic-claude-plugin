# Release Notes — v2.31.0

**KBT-F614 — Git commit identity: env var override + per-agent identity**

## Waarom
`kanbantic-issue-execute` en `kanbantic-issue-review` zetten de lokale git commit-identity tot nu toe altijd op een vaste per-repository waarde (`gitAuthorName`/`gitAuthorEmail` via `get_repository`). Dat werkt voor één vaste identity per repo, maar biedt geen manier om (a) een operator-override op workstation-niveau te forceren, of (b) meerdere agents die straks concurrent op één workstation draaien (Kanbantic Workstation Daemon, KBT-E046 Fase 5) elk onder hun eigen naam te laten committen.

## Plugin (deze repo)
- **`kanbantic-issue-execute/SKILL.md`** — `register_agent_session` verhuist naar het begin van Step 0 (was voorheen gekoppeld ná `claim_issue`), zodat de respons beschikbaar is vóórdat de git-identity wordt gezet. `set_current_issue` hergebruikt later dezelfde `sessionId` — geen dubbele registratie.
- **`kanbantic-issue-review/SKILL.md`** — riep `register_agent_session` voorheen nooit zelf aan (leunde op de proxy's stille auto-registratie of op een sessie van een voorgaande execute-run in hetzelfde proces). Krijgt nu een expliciete aanroep aan het begin van Step 0 — veilig/idempotent — zodat de identity ook hier in-context beschikbaar is.
- **Git-identity resolutie, meest specifiek wint (beide skills):**
  1. `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` env vars, indien gezet op het workstation — git honoreert deze al automatisch boven `git config`; de skill doet dan niets (geen `git config user.*`-aanroep).
  2. Anders: `claudeAgentName`/`claudeAgentEmail` uit de `register_agent_session`-respons (KBT-F613, companion Kanbantic API-wijziging — de display-name van de geauthenticeerde `ClaudeAgent`, met een synthetisch e-mailadres). Oudere backends laten deze velden weg; dat is verwacht, geen fout.
  3. Anders: de bestaande fallback — `gitAuthorName`/`gitAuthorEmail` uit `get_repository`.
- **`plugin/README.md`** — nieuwe sectie "Setup — optional: git commit identity override" met de env-var-stappen (mirrort de bestaande `KANBANTIC_API_KEY`-documentatie).

## Companion (Kanbantic API, aparte repo)
KBT-F613 voegt `ClaudeAgentName`/`ClaudeAgentEmail` toe aan `AgentSessionResponse` (`RegisterAgentSession`), afgeleid uit `ICurrentAgentContext` — puur additief, `null` wanneer niet geauthenticeerd. Deze plugin-wijziging valt zonder KBT-F613 gewoon terug op laag 3 (bestaand per-repo gedrag), dus de volgorde van deployen maakt niet uit.

## Grens
Geen Workstation Daemon-wijziging nodig: de per-agent identity komt al uit de API-key-gebonden `ClaudeAgent`, niet uit een toekomstige per-proces env-injectie door de daemon. Commit-*signing* (KBT-E038 Ed25519 signing keys) is een apart, ongerelateerd mechanisme en blijft ongemoeid.
