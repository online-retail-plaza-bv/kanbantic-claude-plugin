// epic-pane.js — KBT-F743 / KBT-T5185 — Claude Code-mod "kanbantic-epic-pane"
//
// Een dunne client in Claude Code (≥ 2.1.287) op dezelfde MCP-tools als de
// Vloot-pagina: `/epic [KBT-E###]` opent een paneel met de epic-voortgang
// (get_epic_children), de vloot (get_fleet_overview, KBT-SR648) en de open
// beslisverzoeken (list_decisions, KBT-F742). De Kanbantic-UI blijft de
// primaire bron; dit paneel is voor de PO/operator die al in Claude Code zit.
//
// Afspraken (KBT-T5185, aangescherpt in KBT-T5228 en KBT-T5230):
//   - alles via `$.mcp` → de proxy regelt auth; geen API-sleutel in de mod;
//   - ALLEEN LEZEN (KBT-SEC065 §1, KBT-T5228): de mod roept uitsluitend
//     get_epic_children, get_fleet_overview en list_decisions aan en muteert
//     nooit — een beslisverzoek wordt niet vanuit het paneel beantwoord (dat
//     zou onder de agent-identiteit gebeuren), het paneel toont per verzoek
//     een deep-link naar de Beslisbak: de `inboxUrl` die de API meegeeft,
//     anders `<appUrl>/workspace/<workspace>/decisions/<id>` (optie appUrl of
//     KANBANTIC_APP_URL), anders de tekst "Open de Beslisbak in Kanbantic";
//   - fail-open (KBT-T5230 punt 8): `session.start` wacht nooit op Kanbantic —
//     de eerste refresh draait in een eigen dispatch (`$.clock.after(0)`), elke
//     refresh is begrensd op REFRESH_TIMEOUT_MS en toont daarna "niet
//     bereikbaar"; `$.clock.every`, `$.ui.open` en elke handler slikken hun
//     eigen fouten (statusregel), er wordt nooit een beurt gestart;
//   - alleen tekenen in terminal, Desktop-app en VS Code; op een niet-
//     interactieve surface (`claude -p`, SDK) of een door de daemon gespawnde
//     VM-sessie (KANBANTIC_SPAWN_COMMAND_ID) geen timers en geen paneel;
//   - `$.store` bevat alleen de laatst gekozen epic en een samenvatting
//     (4 MiB-limiet), nooit de volledige antwoorden;
//   - labels in het Nederlands, statusmodel v3.
//
// Vorm: `claude plugin validate` eist dat `$` alleen aan functies op het
// hoogste niveau van dit bestand wordt doorgegeven — vandaar de `ctx`-stijl
// (state + opties als argument) in plaats van closures in `register`.
//
// Opties (plugin.json `userConfig`): defaultEpic, refreshSeconds (60),
// stillAfterMinutes (10), workspace ("kanbantic"), appUrl ("").
//
// Tests: plugin/hooks/epic-pane.test.ts via `claude plugin test plugin/`;
// statische alleen-lezen-scan in plugin/tests/epic-pane-readonly.test.js (npm test).

const PANE_ID = 'kanbantic-epic';
const MCP_SERVER = 'kanbantic';
const STORE_LAST_EPIC = 'epic-pane.lastEpic';
const STORE_SUMMARY = 'epic-pane.summary';
const DRAWABLE_SURFACES = new Set(['terminal', 'desktop', 'vscode']);
const EPIC_CODE = /^([A-Z][A-Z0-9]*)-E(\d+)$/i;
const BAR_WIDTH = 10;
// Statusmodel v3 — volgorde voor de uitsplitsing per status.
const STATUS_ORDER = ['New', 'Triaged', 'Ready', 'InProgress', 'Review', 'InDeployment', 'Done', 'Blocked', 'OnHold', 'WaitingForInput', 'Cancelled'];
const ROLE_LABEL = { Unspecified: 'rol?', Orchestrator: 'orchestr.', Developer: 'developer', Reviewer: 'reviewer', Tester: 'tester', Designer: 'designer', Operator: 'operator' };
const STATUS_LABEL = { Working: 'werkt', Silent: 'stil', WaitingForInput: 'wacht op mens', Blocked: 'geblokkeerd', Idle: 'idle', Done: 'klaar', Stale: 'verlopen' };
// KBT-T5230 (8): één refresh (verbinden + de drie leestools) mag zo lang duren;
// daarna meldt het paneel "niet bereikbaar" en blijft de vorige staat staan.
const REFRESH_TIMEOUT_MS = 5000;
const DECISIONS_FALLBACK_TEXT = 'Open de Beslisbak in Kanbantic';

export function register(on, options) {
  const ctx = {
    cfg: readOptions(options),
    state: {
      interactive: false,
      server: MCP_SERVER,
      connected: false,    // $.mcp.connect geslaagd (gebeurt lui, in de eerste refresh)
      epic: null,          // 'KBT-E144'
      data: null,          // { children, fleet, decisions } — laatste geslaagde refresh
      error: null,         // tekst bij een mislukte refresh
      refreshedAt: null,
      summary: null,       // uit $.store, tot de eerste refresh
      workspaceLabel: '',
      appUrl: '',          // basis voor de deep-link naar de Beslisbak (optie of KANBANTIC_APP_URL)
    },
  };

  // Sessiestart: alleen op een interactieve, tekenbare surface. Fail-open
  // (KBT-T5230 punt 8): hier wordt nergens op Kanbantic gewacht en een fout in
  // de opzet houdt de start niet tegen — `next(e)` volgt altijd.
  on('session.start', async ($, e, next) => {
    try {
      await startSession($, e, ctx);
    } catch (err) {
      safeStatus($, `epic-paneel: ${clip(messageOf(err), 100)}`);
    }
    return next(e);
  });

  // /epic [KBT-E###]
  on('command.run', { command: 'epic' }, async ($, e) => {
    try {
      return await runEpicCommand($, e, ctx);
    } catch (err) {
      return { text: `epic-paneel: ${clip(messageOf(err), 120)}` };
    }
  });

  // Het paneel.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => renderPane($, e, ctx));

  // Spinner-suffix: " · E144 5/13 · 2 wachten op PO".
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const s = currentSummary(ctx);
    if (!s) return next(e);
    const suffix = ` · ${shortEpic(s.code)} ${s.done}/${s.total} · ${s.waiting} wachten op PO${e.props.suffix || ''}`;
    return next({ ...e, props: { ...e.props, suffix } });
  });
}

// ── hooks, op het hoogste niveau zodat `$` doorgegeven mag worden ─────────

async function startSession($, e, ctx) {
  const { state, cfg } = ctx;
  state.interactive = await isDrawable($, e);
  if (!state.interactive) return;

  // Alleen lokale bronnen (store, opties): geen $.mcp.connect en geen $.mcp.call
  // vóór next(e) — die horen bij de eerste refresh, in een eigen dispatch.
  state.epic = parseEpicCode(await storeGet($, STORE_LAST_EPIC)) || parseEpicCode(cfg.defaultEpic);
  const summary = await storeGet($, STORE_SUMMARY);
  state.summary = summary && typeof summary === 'object' && summary.code === state.epic ? summary : null;

  try {
    $.clock.every(cfg.refreshSeconds * 1000, () => { refresh($, ctx).catch(() => {}); });
  } catch (err) {
    // Geen timers op deze surface: /epic blijft werken, alleen zonder automatische verversing.
    safeStatus($, `epic-paneel: geen verversing (${clip(messageOf(err), 80)})`);
  }

  // Het commando: een geweigerde naam mag de rest niet overslaan.
  try {
    await $.command.register({ name: 'epic', description: 'Toon epic-voortgang, vloot en beslisbak', argumentHint: '[KBT-E###]', immediate: true });
  } catch {
    // Naam bezet: het paneel blijft bereikbaar via de automatische open hieronder.
  }

  if (state.epic) {
    // Ongevraagd geopend: de engine plaatst het paneel pas vanaf 144 kolommen (110 na een eerdere /epic).
    await openPane($, state.epic);
    // De eerste refresh buiten deze dispatch, zodat een trage of hangende
    // Kanbantic de sessiestart nooit ophoudt; tot die tijd toont het paneel
    // "laden…" of de samenvatting uit de store.
    try {
      $.clock.after(0, () => { refresh($, ctx).catch(() => {}); });
    } catch (err) {
      safeStatus($, `epic-paneel: ${clip(messageOf(err), 100)}`);
    }
  }
}

async function runEpicCommand($, e, ctx) {
  const { state, cfg } = ctx;
  const typed = String(e.args || '').trim();
  if (typed && !parseEpicCode(typed)) {
    return { text: `"${typed}" is geen epic-code. Gebruik /epic KBT-E###.` };
  }
  const code = parseEpicCode(typed) || state.epic
    || parseEpicCode(await storeGet($, STORE_LAST_EPIC))
    || parseEpicCode(cfg.defaultEpic);
  if (!code) {
    return { text: 'Geen epic gekozen. Gebruik /epic KBT-E### (of zet defaultEpic in de plugin-instellingen).' };
  }
  if (code !== state.epic) {
    state.epic = code;
    state.data = null;
    state.error = null;
    state.summary = null;
  }
  await storeSet($, STORE_LAST_EPIC, code);
  await openPane($, code);
  await refresh($, ctx);
  return {};
}

async function renderPane($, e, ctx) {
  const { state, cfg } = ctx;
  const { Box, Text } = $.ui.resolve(e);
  const width = Math.max(40, Number(e.props && e.props.bodyColumns) || 80);
  const lines = [];

  if (!state.epic) {
    return Box({ flexDirection: 'column', children: [Text({ dimColor: true, children: ['Geen epic gekozen — /epic KBT-E###'] })] });
  }

  if (state.error) {
    lines.push(Text({ color: 'yellow', children: [`Kanbantic niet bereikbaar — ${state.error}`] }));
  }

  const view = state.data ? derive(state.data, cfg) : null;
  if (!view) {
    if (state.summary) {
      lines.push(Text({ weight: 'semibold', children: [`${state.epic}${state.summary.title ? ' — ' + state.summary.title : ''}`] }));
      lines.push(Text({ dimColor: true, children: [`${bar(state.summary.done, state.summary.total)} ${state.summary.done}/${state.summary.total} Done (uit cache, ${fmtTime(state.summary.refreshedAt)})`] }));
    } else if (!state.error) {
      lines.push(Text({ dimColor: true, children: [`${state.epic} — laden…`] }));
    }
    return Box({ flexDirection: 'column', children: lines });
  }

  // Kop + balk + uitsplitsing
  lines.push(Text({ weight: 'semibold', children: [`${state.epic}${view.title ? ' — ' + clip(view.title, width - state.epic.length - 3) : ''}`] }));
  lines.push(Text({ children: [`${bar(view.done, view.total)} ${view.done}/${view.total} Done`] }));
  lines.push(Text({ dimColor: true, children: [view.breakdown] }));
  lines.push(Text({ dimColor: true, children: [`bijgewerkt ${fmtTime(state.refreshedAt)} · ververst elke ${cfg.refreshSeconds} s`] }));

  // Features
  lines.push(Text({ children: [' '] }));
  lines.push(Text({ dimColor: true, children: [row(['feature', 'status', 'agent', 'activiteit', 'wacht'], width)] }));
  for (const f of view.features) {
    const text = row([f.code, f.status, f.agent || '—', f.lastActivity || '—', f.waitLabel], width);
    lines.push(f.attention ? Text({ color: 'red', children: [text] }) : Text({ children: [text] }));
  }

  // Wacht op jou
  lines.push(Text({ children: [' '] }));
  lines.push(Text({ weight: 'semibold', children: [`Wacht op jou (${view.decisions.length})`] }));
  if (view.decisions.length === 0) lines.push(Text({ dimColor: true, children: ['— niets —'] }));
  for (const d of view.decisions) {
    lines.push(Text({ color: 'yellow', children: [clip(`${d.code} · ${d.question} · ${d.role}${d.issueCode ? ' · ' + d.issueCode : ''}${d.remaining}${d.optionsLabel}`, width)] }));
    // KBT-T5228: geen knoppen — beantwoorden gebeurt in de Beslisbak onder de
    // eigen identiteit van de PO. Een link wordt niet afgekapt (een halve link is niets waard).
    const link = decisionLink(d, state);
    lines.push(Text({ dimColor: true, children: [link || `${d.code}: ${DECISIONS_FALLBACK_TEXT}`] }));
  }

  // Vloot
  lines.push(Text({ children: [' '] }));
  lines.push(Text({ weight: 'semibold', children: [`Vloot (${view.agents.length}) · ${view.fleetLine}`] }));
  if (view.agents.length === 0) lines.push(Text({ dimColor: true, children: ['— geen actieve agents —'] }));
  for (const a of view.agents) {
    const text = row([a.name, a.role, a.model, a.status, a.issue], width, FLEET_COLUMNS);
    lines.push(a.attention ? Text({ color: 'red', children: [text] }) : Text({ children: [text] }));
  }

  return Box({ flexDirection: 'column', children: lines });
}

// ── acties ─────────────────────────────────────────────────────────────────

/** Opent het paneel; een geweigerde open (geen surface, te smal) houdt niets tegen. */
async function openPane($, code) {
  try {
    await $.ui.open({ id: PANE_ID, title: code, closeOnEscape: true });
  } catch (err) {
    safeStatus($, `${shortEpic(code)}: paneel niet geopend (${clip(messageOf(err), 80)})`);
  }
}

/**
 * Eén verversing: verbinden (lui, eenmalig) + de drie leestools, samen begrensd
 * op REFRESH_TIMEOUT_MS. Een fout of time-out laat de vorige staat staan, zet
 * `state.error` en een statusregel, en gooit nooit (KBT-T5230 punt 8).
 */
async function refresh($, ctx) {
  const { state, cfg } = ctx;
  const code = state.epic;
  if (!code) return;
  try {
    const workspaceId = cfg.workspace || (await envWorkspaceId($)) || 'kanbantic';
    state.workspaceLabel = workspaceId;
    state.appUrl = cfg.appUrl || (await envAppUrl($)) || '';
    const [children, fleet, decisions] = await withTimeout($, fetchAll($, ctx, code, workspaceId), REFRESH_TIMEOUT_MS);
    if (state.epic !== code) return; // intussen van epic gewisseld
    state.data = { children, fleet, decisions };
    state.error = null;
    state.refreshedAt = new Date().toISOString();
    const s = currentSummary(ctx);
    state.summary = s;
    await storeSet($, STORE_SUMMARY, s);
    safeStatus($, statusLine(s, derive(state.data, cfg)));
  } catch (err) {
    if (state.epic === code) state.error = clip(messageOf(err), 160);
    safeStatus($, `${shortEpic(code)}: Kanbantic niet bereikbaar`);
  }
  try {
    $.ui.invalidate('ui.render');
  } catch {
    // Niets om te hertekenen (geen surface): de volgende render leest de staat toch.
  }
}

async function fetchAll($, ctx, code, workspaceId) {
  await ensureConnected($, ctx);
  return Promise.all([
    callTool($, ctx, 'get_epic_children', { epicId: code, maxResults: 100 }),
    callTool($, ctx, 'get_fleet_overview', { workspaceId, maxResults: 100 }),
    callTool($, ctx, 'list_decisions', { workspaceId, status: 'Open', maxResults: 50 }),
  ]);
}

/** $.mcp.connect, eenmalig en lui: een mislukking is geen fout — de eerste $.mcp.call meldt dat dan. */
async function ensureConnected($, ctx) {
  const { state } = ctx;
  if (state.connected) return;
  try {
    const c = await $.mcp.connect(MCP_SERVER);
    if (c && c.isConnected) {
      state.connected = true;
      if (c.server) state.server = c.server;
    }
  } catch {
    // Zie boven.
  }
}

/**
 * Begrenst `work` op `ms` via `$.clock.after`; de timer wordt geannuleerd zodra
 * `work` klaar is. Zonder klok (de dispatch geweigerd) loopt de timer nooit af
 * en geldt alleen de eigen afloop van `work`.
 */
function withTimeout($, work, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    try {
      timer = $.clock.after(ms, () => reject(new Error(`geen antwoord binnen ${Math.round(ms / 1000)} s`)));
    } catch {
      timer = null;
    }
  });
  const settle = () => { if (timer && typeof timer.cancel === 'function') try { timer.cancel(); } catch { /* al afgelopen */ } };
  return Promise.race([work, timeout]).finally(settle);
}

async function callTool($, ctx, tool, args) {
  const result = await $.mcp.call(ctx.state.server, tool, args);
  return parseToolResult(tool, result);
}

/**
 * De deep-link naar het beslisverzoek in de Beslisbak (KBT-T5228): de `inboxUrl`
 * van de API (altijd op basis van de workspace-slug) wint; anders bouwt de mod
 * `<appUrl>/workspace/<workspace>/decisions/<id>` — dezelfde Angular-route als
 * de Telegram-/e-mailmeldingen van KBT-F742. Geen van beide → null (de aanroeper
 * toont dan de tekst "Open de Beslisbak in Kanbantic").
 */
function decisionLink(decision, state) {
  if (decision.inboxUrl) return decision.inboxUrl;
  const base = String(state.appUrl || '').trim().replace(/\/+$/, '');
  if (!base || !state.workspaceLabel || !decision.id) return null;
  return `${base}/workspace/${encodeURIComponent(state.workspaceLabel)}/decisions/${encodeURIComponent(decision.id)}`;
}

function safeStatus($, text) {
  try {
    $.ui.status(text);
  } catch {
    // De statusregel is bijzaak; nooit een reden om een handler te laten falen.
  }
}

async function isDrawable($, e) {
  if (!e || e.isInteractive !== true) return false;
  if (!DRAWABLE_SURFACES.has(e.surface)) return false;
  // Door de Workstation Daemon gespawnde VM-sessie (ConPTY): niets tekenen, geen timers.
  const spawned = await envSpawnCommandId($);
  return !spawned;
}

async function storeGet($, key) {
  try {
    return await $.store.get(key);
  } catch {
    return undefined;
  }
}

async function storeSet($, key, value) {
  try {
    await $.store.set(key, value);
  } catch {
    // De store is een cache: een mislukte schrijfactie mag niets blokkeren.
  }
}

// `$.env.get` takes a literal name (claude plugin validate lists the variables a
// module reads), so each variable gets its own reader.
async function envWorkspaceId($) {
  try {
    return nonEmpty(await $.env.get('KANBANTIC_WORKSPACE_ID'));
  } catch {
    return undefined;
  }
}

async function envSpawnCommandId($) {
  try {
    return nonEmpty(await $.env.get('KANBANTIC_SPAWN_COMMAND_ID'));
  } catch {
    return undefined;
  }
}

// Basis-URL van de Kanbantic-UI voor de deep-link naar de Beslisbak (KBT-T5228),
// als de API geen `inboxUrl` meegeeft en de optie appUrl leeg is.
async function envAppUrl($) {
  try {
    return nonEmpty(await $.env.get('KANBANTIC_APP_URL'));
  } catch {
    return undefined;
  }
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// ── afleidingen ────────────────────────────────────────────────────────────

function currentSummary(ctx) {
  const { state, cfg } = ctx;
  if (!state.epic) return null;
  if (state.data) {
    const v = derive(state.data, cfg);
    return { code: state.epic, title: v.title, done: v.done, total: v.total, waiting: v.decisions.length, refreshedAt: state.refreshedAt };
  }
  return state.summary && state.summary.code === state.epic ? state.summary : null;
}

function readOptions(options) {
  const o = options && typeof options === 'object' ? options : {};
  const num = (v, fallback, min) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    defaultEpic: typeof o.defaultEpic === 'string' ? o.defaultEpic.trim() : '',
    refreshSeconds: num(o.refreshSeconds, 60, 10),
    stillAfterMinutes: num(o.stillAfterMinutes, 10, 1),
    workspace: typeof o.workspace === 'string' ? o.workspace.trim() : '',
    appUrl: typeof o.appUrl === 'string' ? o.appUrl.trim() : '',
  };
}

function parseEpicCode(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(EPIC_CODE);
  return m ? `${m[1].toUpperCase()}-E${m[2]}` : null;
}

function shortEpic(code) {
  const m = parseEpicCode(code);
  return m ? m.slice(m.indexOf('-') + 1) : String(code || '');
}

/** MCP-resultaat → JSON; gooit bij isError, niet-JSON of success:false. */
function parseToolResult(tool, result) {
  if (!result || typeof result !== 'object') throw new Error(`${tool}: leeg antwoord`);
  if (result.structuredContent && typeof result.structuredContent === 'object' && !result.isError) {
    const sc = result.structuredContent;
    if (sc.success === false) throw new Error(`${tool}: ${sc.errorMessage || 'mislukt'}`);
    return sc;
  }
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (result.isError) throw new Error(`${tool}: ${clip(text || 'fout', 120)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${tool}: geen JSON-antwoord`);
  }
  if (parsed && parsed.success === false) throw new Error(`${tool}: ${parsed.errorMessage || 'mislukt'}`);
  return parsed;
}

function derive(data, cfg) {
  const issues = listOf(data.children, ['issues', 'items', 'children']);
  const agents = listOf(data.fleet, ['agents', 'items']);
  const decisions = listOf(data.decisions, ['items', 'decisions']).filter((d) => !d.status || d.status === 'Open');

  const counts = new Map();
  for (const i of issues) counts.set(i.status || '?', (counts.get(i.status || '?') || 0) + 1);
  const total = issues.length;
  const done = counts.get('Done') || 0;
  const order = [...STATUS_ORDER, ...[...counts.keys()].filter((k) => !STATUS_ORDER.includes(k))];
  const breakdown = order.filter((s) => counts.has(s)).map((s) => `${s} ${counts.get(s)}`).join(' · ') || '— geen features —';

  const byIssue = new Map();
  for (const a of agents) if (a.currentIssueCode) byIssue.set(String(a.currentIssueCode).toUpperCase(), a);

  const features = issues.map((i) => {
    const a = byIssue.get(String(i.code || '').toUpperCase());
    const waiting = a ? Number(a.waitingMinutes) || 0 : 0;
    const attention = !!a && (a.isAttention === true || a.status === 'WaitingForInput' || a.status === 'Blocked' || waiting > cfg.stillAfterMinutes);
    return {
      code: String(i.code || '?'),
      status: String(i.status || '?'),
      agent: a ? String(a.agentName || a.sessionId || '?') : '',
      lastActivity: a ? fmtTime(a.lastToolActivityAt || a.lastTurnStartedAt || a.lastSeen) : '',
      waitLabel: a ? (waiting > 0 ? `${waiting} min` : '—') : '',
      attention,
    };
  });

  const totals = (data.fleet && data.fleet.totals) || {};
  const fleetLine = `${totals.working || 0} werkend · ${totals.silent || 0} stil · ${totals.waitingForHuman || 0} wachten · ${totals.blocked || 0} geblokkeerd · ${totals.idle || 0} idle`;
  const agentRows = agents.map((a) => {
    const waiting = Number(a.waitingMinutes) || 0;
    return {
      name: String(a.agentName || a.sessionId || '?'),
      role: ROLE_LABEL[a.role] || String(a.role || 'rol?'),
      model: String(a.modelId || 'model?'),
      status: (STATUS_LABEL[a.status] || String(a.status || '?')) + (a.signal && a.signal !== 'None' ? ` (${a.signal})` : ''),
      issue: a.currentIssueCode ? `${a.currentIssueCode}${a.currentTaskCode ? ' / ' + a.currentTaskCode : ''}` : '—',
      attention: a.isAttention === true || a.status === 'WaitingForInput' || waiting > cfg.stillAfterMinutes,
    };
  });

  const decisionRows = decisions.map((d) => ({
    id: String(d.id || d.decisionRequestId || d.code),
    code: String(d.code || '?'),
    question: clip(String(d.question || ''), 120),
    role: roleShort(d.recipientRole),
    issueCode: d.issueCode || '',
    requestedBy: String(d.requestedBy || '?'),
    remaining: d.remainingMinutes != null && Number.isFinite(Number(d.remainingMinutes)) ? ` · nog ${d.remainingMinutes} min` : '',
    // Alleen ter informatie (de aanbevolen optie met ✓); kiezen gebeurt in de Beslisbak.
    optionsLabel: optionsLabel(d),
    inboxUrl: typeof d.inboxUrl === 'string' && d.inboxUrl.trim() ? d.inboxUrl.trim() : null,
  }));

  const first = issues.find((i) => i.parentTitle || i.epicTitle);
  const title = (data.children && (data.children.epicTitle || data.children.title)) || (first && (first.parentTitle || first.epicTitle)) || '';

  return { title, total, done, breakdown, features, agents: agentRows, fleetLine, decisions: decisionRows };
}

function statusLine(s, view) {
  const parts = [`${shortEpic(s.code)} ${s.done}/${s.total} Done`, `${s.waiting} wachten op PO`];
  if (view) parts.push(`vloot: ${view.fleetLine}`);
  return parts.join(' · ');
}

function listOf(obj, keys) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k];
  return [];
}

function roleShort(role) {
  if (role === 'ProductOwner') return 'PO';
  return String(role || '?');
}

/** " · opties: Spec A ✓ / Spec B" — de aanbevolen optie gemarkeerd, niets om te drukken. */
function optionsLabel(d) {
  const options = (Array.isArray(d.options) ? d.options : [])
    .map((o) => `${String(o.title || o.key)}${d.recommendedOptionKey && o.key === d.recommendedOptionKey ? ' ✓' : ''}`);
  return options.length ? ` · opties: ${options.join(' / ')}` : '';
}

function bar(done, total) {
  const n = total > 0 ? Math.round((Math.min(done, total) / total) * BAR_WIDTH) : 0;
  return '█'.repeat(n) + '░'.repeat(BAR_WIDTH - n);
}

const FEATURE_COLUMNS = [12, 14, 11, 11, 8];   // feature, status, agent, activiteit, wacht
const FLEET_COLUMNS = [12, 11, 22, 16, 14];     // agent, rol, model, status, issue

function row(cells, width, widths = FEATURE_COLUMNS) {
  let out = '';
  cells.forEach((c, i) => {
    const w = widths[i] || 10;
    const s = String(c == null ? '' : c);
    out += (i === cells.length - 1 ? s : pad(s, w)) + ' ';
  });
  return clip(out.trimEnd(), width);
}

function pad(s, w) {
  return s.length >= w ? s.slice(0, w - 1) + '…' : s + ' '.repeat(w - s.length);
}

function clip(s, max) {
  const str = String(s == null ? '' : s);
  return str.length > max ? str.slice(0, Math.max(0, max - 1)) + '…' : str;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function messageOf(err) {
  if (!err) return 'onbekende fout';
  if (typeof err === 'string') return err;
  return String(err.message || err.reason || err);
}
