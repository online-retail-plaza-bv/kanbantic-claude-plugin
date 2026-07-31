# Release Notes — v2.32.2

**KBT-B500 — bundle-snapshot bijgewerkt naar de live registry**

## Waarom
`npm run check:drift` waarschuwde sinds KBT-F615 live ging: `1 live tool(s) missing from the snapshot: get_current_agent_identity` (snapshot 218 + 4 curatedOut, live 223). Dit was de expliciet aangekondigde follow-up van v2.32.0 — die release-noot stelde de sync uit tot de tool in productie stond. Dat is nu zo.

Een openstaande advisory-waarschuwing is niet onschuldig: hij devalueert het signaal. Wie gewend raakt aan een gele regel bij elke `check:drift`, ziet de volgende, échte drift niet meer. Bovendien staat `get_current_agent_identity` niet zomaar ergens live — `plugin/scripts/kanbantic-git-identity.js` roept hem zelf aan, dus juist die tool hoorde in de snapshot te staan die zijn bestaan bewaakt.

## Wat er verandert
- `plugin/scripts/known-mcp-tools.json`: `get_current_agent_identity` toegevoegd op de alfabetische plek (tussen `get_context` en `get_deployment_gate_results`), `tools` 218 → 219, `generatedAt` → 2026-07-31. Chirurgische sync per de `regenerationCommand` in het bestand; de curatie is ongemoeid — de 4 legacy release-tools blijven er per `known-mcp-tools.test.js` buiten, en de live registry blijft bewust ruimer dan deze curated subset.
- `plugin/.claude-plugin/plugin.json`: het `description`-veld teruggebracht van 15.338 naar 342 tekens. Net als in marketplace.json (KBT-B495) was het uitgegroeid tot een opgestapelde changelog van elf releases in plaats van een beschrijving van de plugin. De changelog blijft integraal in de `RELEASE_NOTES_v*.md`-bestanden.

## Verificatie
Niet "de test is groen", maar "de melding is weg" — geverifieerd tegen de échte registry:

```
$ npm run check:drift
OK: all MUST-HAVE tools present (3 required, 223 total exposed at https://kanbantic.com/mcp)
```

Vóór deze wijziging stond daar de WARNING met de ontbrekende tool. Verder: `known-mcp-tools.test.js` en `check-drift.test.js` groen, volledige suite 319 tests / 0 fail, `check:version` groen.
