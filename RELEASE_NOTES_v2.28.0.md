# Release Notes — v2.28.0

**KBT-B470 — Idle gespawnde agent-sessies verdwijnen uit `/agent-sessions` (geen keep-alive heartbeat)**

## Waarom
De backend `AgentSessionStaleSweepService` markeert een sessie als **Stale** zodra `LastSeen` ouder is dan `HeartbeatTimeoutSeconds = 300` (5 min), met een sweep elke 30s. De MCP-proxy (`kanbantic-mcp-proxy.js`) registreerde de sessie wel bij startup, maar riep daarna **nooit** periodiek de `heartbeat`-tool aan. Een agent die idle is (geen tool-calls) refreshde `LastSeen` dus niet en werd na ~5 min als Stale opgeruimd — waardoor 'ie uit de actieve lijst in `/agent-sessions` verdween terwijl het proces gewoon nog leefde.

## Plugin (deze repo)
- **`plugin/proxy/kanbantic-mcp-proxy.js`** — een periodieke sessie-heartbeat:
  - `startHeartbeat()` / `stopHeartbeat()` / `sendHeartbeat()`, interval `HEARTBEAT_INTERVAL_MS = 90_000` (90s — ruim onder de 300s stale-drempel, met marge voor een gemiste tick).
  - De timer start bij `register_agent_session` (naast `startInboxPoll`) en stopt bij `end_agent_session` + bij graceful exit (SIGINT/SIGTERM) en `__resetForTest`.
  - **Best-effort**: `sendHeartbeat` is een no-op zonder actieve sessie of tijdens shutdown, en een gefaalde heartbeat wordt naar stderr gelogd zonder de proxy te laten crashen.
  - `callInternalTool` gaat nu via `__forwardImpl` (defaultet naar `forward`) zodat de tool-call unit-testbaar is; productie-gedrag is identiek.
- **Tests**: `plugin/tests/proxy-heartbeat.test.js` (3 unit) — heartbeat roept de `heartbeat`-tool aan met de actieve `sessionId`; no-op zonder sessie; `startHeartbeat`/`stopHeartbeat` idempotent + schone stop (geen dangling timer).

## Grens
Volledig client-side in de proxy — geen backend-wijziging nodig. De 90s-interval is bewust ruim onder de bestaande 300s-timeout; de backend-drempel blijft de source-of-truth voor stale-detectie.
