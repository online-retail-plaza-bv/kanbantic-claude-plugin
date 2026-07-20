# Release v2.25.0

Agent-sessions verschijnen betrouwbaar in `/agent-sessions` na spawn via de Workstation Daemon
(KBT-E102 · plugin-aandeel F2/KBT-F551 + F5/KBT-F554).

## KBT-F551 (F2) — proxy registreert de agent-sessie automatisch bij startup
- **Auto-registratie via het echte `initialize`-pad.** De MCP-proxy (`plugin/proxy/kanbantic-mcp-proxy.js`)
  registreert de gespawnde agent nu zelf als `AgentSession` bij het opstarten — het interactieve SpawnCommand-pad
  hoefde daarvoor niet langer een expliciete registratie-instructie in de prompt te krijgen.
- **Key-guard.** Registratie gebeurt alleen wanneer `KANBANTIC_API_KEY` aanwezig is; zonder key registreert de
  proxy niet (en breekt niet). De Workstation Daemon rust de agent met die key + context uit (F1).
- **Correlatie.** De proxy geeft `spawnCommandId` mee zodat de backend de `SpawnCommand` aan de nieuwe
  `AgentSession` koppelt (`TargetSessionId`) — dit voedt de spawn→sessie-deeplink in `/agent-sessions`.

## KBT-F554 (F5) — documentatie
- Proxy-auto-register-gedrag gedocumenteerd in `plugin/README.md` (trigger, key-guard, correlatie).

## Tests
- `plugin/tests/proxy-autoregister.test.js` + `plugin/tests/proxy-autoregister-integration.test.js` dekken
  het auto-register-pad (inclusief de key-guard, mutation-covered).

## Levering
Lockstep versie-bump 2.24.0 → 2.25.0 over `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`
en `package.json` (version-sync-guard, KBT-TC2770), zodat marketplace-consumenten de F2-proxy daadwerkelijk
ophalen. Onderdeel van de KBT-E102-keten (Workstation Daemon → Kanbantic API/UI → plugin).
