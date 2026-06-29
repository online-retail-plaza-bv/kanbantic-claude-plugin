# Kanbantic Claude Plugin

Claude plugin for Kanbantic issue lifecycle management. All artifacts are created and managed through Kanbantic MCP tools — no local file output.

## Skill ↔ Lane mapping (plugin v2.4.0)

Three intake-skills create issues; four lane-skills move them through the eight statuses; deploy webhooks complete the journey to production. An autopilot skill drives bugs end-to-end without manual handoffs.

| Source lane | Target lane | Skill | Command | Mode |
|-------------|-------------|-------|---------|------|
| — | **New** | `kanbantic-bug-report` | `/report-bug` | Intake (Bug) |
| — | **New** | `kanbantic-feature-request` | `/request-feature` | Intake (Feature) |
| — | **New** | `kanbantic-epic-proposal` | `/propose-epic` | Intake (Epic) |
| New | Triaged *or* Cancelled | `kanbantic-issue-triage` | `/triage-issue` | Lane-skill (go/no-go) |
| Triaged | **Prepared** | `kanbantic-issue-prepare` | `/prepare-issue` | Lane-skill (artifacts) |
| Prepared | **InProgress** | `kanbantic-issue-execute` | `/execute-issue` | Lane-skill (atomic claim) |
| InProgress | Review | `kanbantic-issue-execute` | (continues) | Lane-skill (implementation) |
| Review | **InDeployment** | `kanbantic-issue-review` | *(auto via /loop-style chain)* | Lane-skill (merge + transition) |
| InDeployment | Done | (deploy webhooks + manual `update_issue_status`) | — | Operational gate |
| New *or* any lane | Done (batch) | `kanbantic-bug-autopilot` | `/bug-autopilot` | Autopilot (Bug, end-to-end) |

**Lane-flow** (8 statuses; `Cancelled` is terminal from any non-Done, non-InDeployment status):

```
intake → New → triage → Triaged → prepare → Prepared → execute → InProgress → execute → Review → review → InDeployment → deploy → Done
```

**Key invariants** (since plugin v2.4.0 / KBT-F250):

- An Epic's Implementation Plan can take two shapes — auto-detected per Phase by `kanbantic-issue-execute` (KBT-RL057):
  - **New shape** (default for v2.4.0+ Epics): `Epic → Phase → Feature → Task`. Each Feature has its own audit-trail; Tasks attach to Features, not directly to Phases.
  - **Legacy shape** (existing Epics): `Epic → Phase → Task`. Continues to work without restructuring.
- `kanbantic-issue-review` works at three levels for new-shape Epics — Feature / Phase / Epic — auto-detected from the issue argument. Per-Feature mini-reviews keep deltas small; Epic-level review becomes a lightweight cross-Phase coherence check.
- Three new MCP tools: `assign_feature_to_phase`, `assign_features_to_phase` (bulk), `list_features_by_phase`. Together they let `kanbantic-issue-prepare` and `kanbantic-issue-execute` query and mutate the Phase ↔ Feature relation cleanly.
- `isReadyToClaim` is **derived** from status (`Prepared ⟺ true`) — it is no longer settable explicitly.
- Direct `Triaged → InProgress` is **blocked** (use `/prepare-issue` first).
- Direct `InDeployment → InProgress` and `InDeployment → Cancelled` are **blocked at the Domain layer** (use `Review` for rollback or `Done` for post-deploy completion).
- The `kanbantic-issue-review` skill transitions to `InDeployment` after merge — the Done-transition is a separate operational step (deploy webhooks + smoke + manual `update_issue_status(status: "Done")`). Auto-transition via `GateEvaluationService` is deferred to KBT-INI032 Epic D.
- Existing `Triaged-with-isReadyToClaim=true` and `Review-with-merged-branch` issues are migrated automatically by the backend `PreparedStatusBackfillSeeder` and `InDeploymentBackfillSeeder` on first post-deploy startup.

## Version history

- **v2.4.0** — Phase-of-Features-of-Tasks Epic shape (KBT-F250): new-shape Epics group Features into Phases instead of Tasks; dual-mode auto-detection in execute; three review levels (Feature / Phase / Epic); three new MCP tools (`assign_feature_to_phase`, `assign_features_to_phase`, `list_features_by_phase`).
- **v2.3.0** — InDeployment lane (KBT-F236): new status between Review and Done; `kanbantic-issue-review` transitions to InDeployment after merge.
- **v2.2.0** — Prepared lane (KBT-F235): new status between Triaged and InProgress; `kanbantic-issue-prepare` transitions to Prepared on green readiness.
- **v2.0.0** — Lane Workflow Skills (KBT-INI033): one skill per lane transition; consolidates the legacy `kanbantic-issue-design` + `kanbantic-issue-planning` + `kanbantic-debugging` into `kanbantic-issue-prepare`; renames `kanbantic-issue-executing` → `kanbantic-issue-execute` and `kanbantic-code-review` → `kanbantic-issue-review`.

## Epic shape examples (v2.4.0)

**New shape — Phase → Features → Tasks** (default for new Epics):

```
KBT-E060 — Add Workspace Search
  └─ Implementation Plan
        ├─ Phase 1 — Foundation
        │    ├─ KBT-F261 (E060-Foundation)
        │    │     ├─ KBT-T1801: add IndexBuilder service
        │    │     ├─ KBT-T1802: EF migration for SearchIndex table
        │    │     └─ KBT-T1803: DI wiring
        │    └─ KBT-F262 (Search index population)
        │          ├─ KBT-T1810: background job
        │          └─ KBT-T1811: change-history trigger
        └─ Phase 2 — Core capabilities
             ├─ KBT-F263 (Search REST endpoint)
             └─ KBT-F264 (Frontend search box)
```

Roll-up: Tasks Done → Feature Done → Phase ReadyForReview → Epic Review-ready.

**Legacy shape — Phase → Tasks** (existing Epics; still supported):

```
KBT-E045 — Older Epic (pre-v2.4.0)
  └─ Implementation Plan
        ├─ Phase 1
        │    ├─ KBT-T1500
        │    └─ KBT-T1501
        └─ Phase 2
             └─ KBT-T1502
```

`kanbantic-issue-execute` auto-detects which shape each Phase uses and walks accordingly — no operator input, no flag.

## Architecture

Since **v1.11.0**, the plugin connects to the Kanbantic MCP server through a local **stdio proxy** (`proxy/kanbantic-mcp-proxy.js`) instead of Claude's built‑in HTTP MCP transport.

```
Claude (Code or Desktop) ──stdio──► kanbantic-mcp-proxy.js ──HTTP+Bearer──► https://kanbantic.com/mcp
```

Why stdio and not HTTP:

- Claude's HTTP MCP client is **OAuth‑first**. One 401 response poisons `~/.claude/.credentials.json` with a cached `discoveryState`, and from that moment on the statically configured `Authorization: Bearer …` header is silently ignored — forever, or until the credentials file is cleaned.
- stdio transport has no OAuth flow, no discovery, and no credentials cache. The proxy handles HTTP + Bearer auth itself, and Claude never sees a 401.
- Zero npm dependencies (Node.js built‑ins only).

**Do not use** `"type": "http"` MCP configs for Kanbantic. They will break within hours or days.

## Agent Communication Hub (KBT-E046)

Sinds v2.2 ondersteunt de proxy de **Agent Communication Hub** — agents kunnen tijdens hun sessie chatten met users en met andere agents direct via Kanbantic, en de Kanbantic-UI toont een live presence + chat-overzicht voor elke draaiende agent.

Hoe het werkt:

1. Wanneer Claude `register_agent_session` aanroept, captured de proxy de `sessionId` + `channelId` uit de response.
2. De proxy declareert `experimental.claude/channel`-capability op de `initialize`-response zodat Claude Code inkomende channel-notificaties accepteert.
3. Vanaf dat moment polt de proxy elke 1s `get_channel_messages` met een `after`-cursor en pusht elke nieuwe message via `notifications/claude/channel` direct in de lopende Claude-sessie.
4. Bij SIGINT / SIGTERM stopt de proxy de poll-loop, roept `end_agent_session` aan, en exit clean.

**Vereiste launch-flag voor Claude Code (channels zijn experimental):**

```bash
claude --dangerously-load-development-channels server:kanbantic
```

(Claude Code v2.1.80+ vereist; channels werken niet zonder deze flag.)

Zonder de flag werken `register_agent_session` / `send_message` / `get_channel_messages` etc. nog steeds als gewone tools — maar de **push-richting** (user → agent) verloopt niet realtime. Polling vanuit de agent zelf via `check_messages` is mogelijk maar niet aanbevolen.

## `filePath` — lokale bestandssubstitutie voor grote content (KBT-F464)

De proxy draait lokaal met filesystem-toegang. Voor tools met een grote `content`-parameter (bijv. `add_wireframe_version` met een 154KB HTML-wireframe) hoeft Claude de inhoud niet langer in zijn context te laden: geef in plaats van `content` een **`filePath`** mee en de proxy resolvet het bestand vóór doorsturen.

```jsonc
// Claude roept aan:
add_wireframe_version({
  wireframeId: "3a221d1f-…",
  filePath: "C:\\Users\\you\\Documents\\adminmeester-wireframes.html",
  changesSummary: "Update nav + BTW schermen"
})

// De proxy substitueert vóór doorsturen naar de API:
add_wireframe_version({
  wireframeId: "3a221d1f-…",
  content: "<html>…</html>",   // gelezen via fs.readFileSync(filePath, 'utf8')
  changesSummary: "Update nav + BTW schermen"
})
```

Gedrag (afgedwongen in `proxy/kanbantic-mcp-proxy.js`):

| Argumenten | Proxy-gedrag |
|---|---|
| alleen `content` | byte-identiek doorgestuurd (ongewijzigd t.o.v. vroeger) |
| `filePath` (geen `content`) | bestand lokaal gelezen → `content` gevuld, `filePath` verwijderd, dan doorgestuurd |
| `filePath` **en** `content` | JSON-RPC-fout `-32602` (ambiguïteit) — **niet** doorgestuurd; geef precies één op |
| `filePath` onleesbaar | JSON-RPC-fout `-32603` met pad + OS-reden (bijv. `ENOENT`) — **niet** doorgestuurd |
| geen van beide | ongewijzigd doorgestuurd; de server valideert zelf |

Het patroon is **generiek**: de substitutie geldt voor elke `tools/call` met een `filePath`-argument, niet alleen `add_wireframe_version`. De proxy verrijkt bovendien de `tools/list`-respons zodat `filePath` als optionele parameter (met beschrijving) verschijnt op elke tool die een `content`-property heeft — `filePath` wordt nooit aan `required` toegevoegd. Geen extra dependencies; alleen Node built-ins.

> **Trust boundary.** `filePath` laat een tool-aanroep elk lokaal bestand lezen waartoe het proxy-proces toegang heeft, en stuurt de inhoud naar de Kanbantic-server. Dat is exact het doel (de proxy draait lokaal met filesystem-rechten), maar het betekent dat een foutieve of kwaadaardige tool-aanroep in principe gevoelige bestanden zou kunnen inlezen. Geef alleen `filePath`-waarden door die je bedoelt te uploaden. De proxy legt bewust géén pad-allowlist of groottelimiet op — dat blijft een verantwoordelijkheid van de aanroeper. (Vergelijk de server-side `AddIssueAttachment`, KBT-SR224, die wél een 25MB-cap hanteert omdat die de payload base64 in het protocol stopt; de proxy-substitutie heeft die overhead niet.)

## Requirements

- [Claude Code](https://claude.ai/code) **or** Claude Desktop (Windows App)
- [Node.js](https://nodejs.org) — the stdio proxy runs as `node …`
- A Kanbantic API key (format: `ka_{agent-name}_{random}`) — request one from your workspace admin

## Setup — shared step: set the API key

The proxy authenticates with `KANBANTIC_API_KEY`. On Windows, set it **once** as a persistent User Environment Variable:

1. Open **Control Panel → System → Advanced system settings → Environment Variables**
2. Under **User variables**, click **New**
3. Variable name: `KANBANTIC_API_KEY`
4. Variable value: your API key (e.g. `ka_dev-yourname_abc123...`)
5. Click **OK**
6. **Sign out of Windows and sign back in** (or reboot)

> **Why sign out / in is required:** Windows GUI apps (Claude Desktop, Cowork) inherit their environment from `explorer.exe`, which is started at sign‑in. When you edit a User Environment Variable, Windows broadcasts a `WM_SETTINGCHANGE` message — new PowerShell and cmd sessions pick it up, but most GUI apps (including Claude Desktop) do not. Until you sign out and back in, those apps still see the old environment.

Verify in a **new** terminal:

```powershell
echo $env:KANBANTIC_API_KEY
# should print your key
```

## Setup — Claude Code

Claude Code is supported out of the box. The bundled `plugin/.mcp.json` registers the stdio proxy automatically when the plugin is enabled:

```jsonc
{
  "kanbantic": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/proxy/kanbantic-mcp-proxy.js"],
    "env": { "KANBANTIC_API_KEY": "${KANBANTIC_API_KEY}" }
  }
}
```

Claude Code expands both `${CLAUDE_PLUGIN_ROOT}` and `${KANBANTIC_API_KEY}` correctly. Nothing else is required.

**Installation** — run the hosted installer (one‑liner, no clone required):

```powershell
irm https://kanbantic.com/install.ps1 | iex
```

Or via the marketplace directly:

```bash
claude plugin install kanbantic-claude-plugin@kanbantic
```

> **Important:** Do **not** add a `.mcp.json` at the project root or in `.claude/mcp.json` with a Kanbantic entry. The plugin‑bundled config is authoritative. A duplicate HTTP entry will re‑introduce OAuth cache poisoning.

## Setup — Claude Desktop (Windows App)

Claude Desktop does not honor Claude Code's plugin system, so it cannot use the bundled `plugin/.mcp.json` and the `${CLAUDE_PLUGIN_ROOT}` placeholder. You must register an stdio bridge manually in `%APPDATA%\Claude\claude_desktop_config.json`.

> **Do not** use "Add Custom Connector" in the Desktop UI. That flow routes through claude.ai's OAuth broker, which requires OAuth 2.1 / DCR discovery endpoints — these are intentionally absent on the Kanbantic MCP server (see Architecture). You will get "Couldn't reach the MCP server", and each attempt can leave stale entries in `%APPDATA%\Claude\.credentials.json` that later interfere with the stdio routes below.

**Recommended approach: bundled proxy with the `KANBANTIC_API_KEY` User env var.** Since v1.14.0 the proxy reads the key from `HKCU\Environment` as a fallback, so Desktop no longer needs to inherit the env var from `explorer.exe` and you do **not** need to embed the key literally in the config.

### 1. Set the User environment variable

Follow the "Setup — shared step: set the API key" section above. A full sign‑out is **no longer required** for Desktop — the proxy reads directly from the registry if the variable isn't in the inherited environment.

### 2. Edit `claude_desktop_config.json`

Open (or create) `%APPDATA%\Claude\claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "kanbantic": {
      "command": "node",
      "args": [
        "C:\\Users\\<YourUsername>\\.claude\\plugins\\cache\\kanbantic\\kanbantic-claude-plugin\\<version>\\proxy\\kanbantic-mcp-proxy.js"
      ]
    }
  }
}
```

Notes:

- The server **name** must be `kanbantic` (not `framework` or anything else). The plugin skills reference tools as `mcp__kanbantic__*`; any other name causes "tool not found" errors.
- Replace `<YourUsername>` with your Windows user name and `<version>` with the currently installed plugin version (e.g. `1.14.0`). You'll need to update `<version>` whenever the plugin updates — or switch to the `mcp-remote` alternative below if you'd rather not.
- No `env` block is needed: the proxy picks up `KANBANTIC_API_KEY` from the inherited environment, and falls back to `HKCU\Environment` on Windows.
- Do **not** add a `"type": "http"` entry for Kanbantic. It hits the OAuth cache poisoning bug described in the Architecture section.

### 3. Restart Claude Desktop

Close the app completely (including the system tray icon) and relaunch.

### 4. Verify

Ask Claude Desktop: *"List my Kanbantic issues."* You should see tools named `mcp__kanbantic__list_issues`, `mcp__kanbantic__get_issue`, etc. being invoked. If you see a 401 or "KANBANTIC_API_KEY not found", re‑check that the User env var is set correctly: `reg query HKCU\Environment /v KANBANTIC_API_KEY` in a PowerShell window must return your key.

### Alternative: `mcp-remote` with literal API key

If you'd rather avoid the hardcoded plugin-cache path (which changes with each plugin update), point Claude Desktop at `mcp-remote` instead:

```json
{
  "mcpServers": {
    "kanbantic": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "mcp-remote@latest",
        "https://kanbantic.com/mcp",
        "--header",
        "Authorization: Bearer ka_your-agent_your-key"
      ]
    }
  }
}
```

Caveats: the API key is embedded **literally** in the config (treat the file as a secret — don't commit or share it), and `cmd /c` is required on Windows so `npx.cmd` resolves correctly.

## Troubleshooting

When the MCP server doesn't respond, check in this order:

1. **Server name is `kanbantic`** (Desktop) — in `claude_desktop_config.json` the `mcpServers` key must be exactly `kanbantic`. Other names (e.g. `framework`) register tools under the wrong prefix and every skill fails with "tool not found".
2. **API key resolution** — the proxy reads `KANBANTIC_API_KEY` from (a) `process.env`, (b) `HKCU\Environment` on Windows as fallback. Verify with `reg query HKCU\Environment /v KANBANTIC_API_KEY` — the value must start with `ka_`. If you're using the `mcp-remote` alternative, the key must instead appear literally in the `--header` argument and no `${...}` placeholders are allowed.
3. **Claude Code env var flow** — Code expands `${KANBANTIC_API_KEY}` from the inherited environment. Verify in a **new** PowerShell window: `echo $env:KANBANTIC_API_KEY`.
4. **Sign‑out/sign‑in is no longer required for Desktop** (v1.14.0+). The proxy reads the registry directly, bypassing explorer.exe's env inheritance. For Claude Code, a new terminal window is still enough; GUI apps launched from an old explorer.exe session may still need sign‑out if they relied on `${KANBANTIC_API_KEY}` expansion at config time.
5. **Node.js is installed** — `node --version` returns a version. `npx` must be on PATH for the Desktop `mcp-remote` route.
6. **Plugin is enabled** (Claude Code) — `.claude/settings.json` has `enabledPlugins` with `kanbantic-claude-plugin@kanbantic: true`.
7. **No stale HTTP config** — no `.mcp.json` at any project root with a Kanbantic entry that uses `"type": "http"`. Remove any such entries.
8. **No stale OAuth** — inspect `~/.claude/.credentials.json` (Claude Code) and `%APPDATA%\Claude\.credentials.json` (Claude Desktop) and remove any `mcpOAuth` entries matching `*kanbantic*` or `plugin:*kanbantic*`.
9. **Server reachable** — `curl -X POST https://kanbantic.com/mcp -H "Authorization: Bearer <your-key>" -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'` should return 200 with capabilities.
10. **Restart the host** — Claude Code: close and reopen. Claude Desktop: close (incl. system tray) and relaunch.

## Principle

**Read from Kanbantic → Do the work → Write to Kanbantic**

All artifacts (issues, specifications, test cases, implementation plans, discussion entries) live in Kanbantic, not in local files. A developer with only Kanbantic access has everything needed to understand and implement any issue.

## Coexistence with Superpowers

This plugin replaces superpowers for Kanbantic‑specific workflows:

- `brainstorming` → `kanbantic-issue-prepare` (Feature / Epic routing)
- `writing-plans` → `kanbantic-issue-prepare` (Epic routing)
- `executing-plans` → `kanbantic-issue-execute`
- `requesting-code-review` → `kanbantic-issue-review`
- `systematic-debugging` → `kanbantic-issue-prepare` (Bug routing)

Generic superpowers skills (TDD, verification, git worktrees) remain available if superpowers is also installed.

## License

MIT
