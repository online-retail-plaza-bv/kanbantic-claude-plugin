// epic-pane.test.ts — KBT-F743 / KBT-TC4214 (b) / KBT-T5185
//
// Runs under `claude plugin test plugin/` (Claude Code ≥ 2.1.287). Every $.mcp
// answer is stubbed: no session, no network, no API key. The mod under test is
// plugin/hooks/epic-pane.js, loaded through hooks/hooks.json `modules`.
//
//   - /epic KBT-E144 opens the pane; the drawing carries the epic code, the
//     progress bar `x/y Done`, the feature table (codes + agent names) and the
//     block "Wacht op jou" with the decision codes;
//   - a row is red when the agent isAttention (WaitingForInput) or waited longer
//     than `stillAfterMinutes`;
//   - /epic without an argument uses the epic kept in $.store;
//   - the Spinner gets the suffix ` · E144 x/y · n wachten op PO`;
//   - a surface without interactive drawing (a `-p` run, or a daemon-spawned VM
//     session) starts no timer and opens no pane;
//   - a failed $.mcp.call is fail-open: "niet bereikbaar", no turn is started.

import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'kanbantic-claude-plugin',
  component: 'Pane',
  requestId: 'kanbantic-epic',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'KBT-E144',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SPINNER = {
  plugin: 'kanbantic-claude-plugin',
  component: 'Spinner',
  requestId: 'main',
  viewport: { columns: 160, rows: 40 },
  props: { word: 'Denken', message: null, suffix: '…', mode: 'thinking' },
} as const

const STATUSES = [
  'Done', 'Done', 'Done', 'Done', 'Done',
  'InProgress', 'InProgress', 'Review', 'InDeployment',
  'Ready', 'Triaged', 'Triaged', 'New',
]

const EPIC_CHILDREN = {
  success: true,
  totalCount: 13,
  issues: STATUSES.map((status, i) => ({
    id: `3a24-child-${i}`,
    code: `KBT-F${741 + i}`,
    type: 'Feature',
    title: `Feature ${741 + i}`,
    status,
    priority: 'High',
  })),
}

const FLEET = {
  success: true,
  generatedAt: '2026-10-20T06:00:00Z',
  totals: { working: 2, silent: 0, waitingForHuman: 1, blocked: 0, idle: 1, total: 4 },
  truncated: false,
  agents: [
    { sessionId: 's1', agentName: 'Axon 04', role: 'Developer', modelId: 'claude-sonnet-5-5', status: 'Working', signal: 'None', isAttention: false, currentIssueCode: 'KBT-F746', currentIssueTitle: 'Feature 746', lastToolName: 'Bash', lastToolActivityAt: '2026-10-20T05:59:00Z', waitingMinutes: 0, openDecisions: 0 },
    { sessionId: 's2', agentName: 'Axon 07', role: 'Developer', modelId: 'claude-sonnet-5-5', status: 'WaitingForInput', signal: 'NoTurnAfterMessage', signalReason: 'wacht op mens sinds 05:15', isAttention: true, currentIssueCode: 'KBT-F747', currentIssueTitle: 'Feature 747', lastToolName: null, lastToolActivityAt: '2026-10-20T05:15:00Z', waitingMinutes: 45, openDecisions: 1 },
    { sessionId: 's3', agentName: 'Axon 09', role: 'Tester', modelId: 'claude-haiku-4-5', status: 'Working', signal: 'None', isAttention: false, currentIssueCode: 'KBT-F748', currentIssueTitle: 'Feature 748', lastToolName: 'Read', lastToolActivityAt: '2026-10-20T05:35:00Z', waitingMinutes: 25, openDecisions: 0 },
    { sessionId: 's4', agentName: 'Axon 11', role: 'Reviewer', modelId: 'claude-opus-4-1', status: 'Idle', signal: 'None', isAttention: false, currentIssueCode: null, currentIssueTitle: null, lastToolName: null, lastToolActivityAt: null, waitingMinutes: 0, openDecisions: 0 },
  ],
}

const DECISIONS = {
  success: true,
  totalCount: 2,
  truncated: false,
  items: [
    // DR042 carries the inbox deep-link the API builds (KBT-F742 `inboxUrl`); DR043 does not,
    // so the mod has to fall back on its own link (appUrl + workspace) or on plain text.
    { id: '3a24-dr-42', code: 'KBT-DR042', kind: 'Choice', status: 'Open', question: 'Spec A of spec B?', recipientRole: 'ProductOwner', issueCode: 'KBT-F747', epicCode: 'KBT-E144', requestedBy: 'Axon 07', deadlineAt: '2026-10-20T09:00:00Z', remainingMinutes: 180, recommendedOptionKey: 'a', options: [{ key: 'a', title: 'Spec A' }, { key: 'b', title: 'Spec B' }], inboxUrl: 'https://app.kanbantic.test/workspace/kanbantic/decisions/3a24-dr-42' },
    { id: '3a24-dr-43', code: 'KBT-DR043', kind: 'Approval', status: 'Open', question: 'Akkoord met de migratie?', recipientRole: 'ProductOwner', issueCode: 'KBT-F748', epicCode: 'KBT-E144', requestedBy: 'Axon 09', deadlineAt: null, remainingMinutes: null, recommendedOptionKey: 'yes', options: [{ key: 'yes', title: 'Ja' }, { key: 'no', title: 'Nee' }] },
  ],
}

// KBT-T5228 / KBT-SEC065 §1 — the mod is a thin READ client. Every $.mcp.call it
// makes, in any cycle, must name one of these tools; nothing else.
const READ_TOOLS = ['get_epic_children', 'get_fleet_overview', 'list_decisions', 'get_fleet_digest', 'get_issue']

type Recorder = {
  registered: Array<Record<string, unknown>>
  opened: Array<Record<string, unknown>>
  timers: number[]
  calls: Array<{ tool: string; args: Record<string, unknown> }>
  statuses: string[]
  toasts: string[]
  prompts: string[]
  sessionStarts: number
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
}

function mcpText(obj: unknown) {
  return { value: { content: [{ type: 'text', text: JSON.stringify(obj) }], isError: false } }
}

type ArrangeOptions = {
  answers?: (tool: string, args: Record<string, unknown>) => unknown
  env?: Record<string, string>
  store?: Map<string, unknown>
  clock?: boolean
  /** Refusals at the engine's side: `open` refuses $.ui.open, `every` refuses $.clock.every. */
  refuse?: { open?: string; every?: string }
}

/**
 * Every stub the mod can reach, registered before the test's first call on $.
 * `answers` decides what each $.mcp.call resolves to; `env` stands for the
 * process environment.
 */
function arrange(on: any, { answers = defaultAnswers, env = {} as Record<string, string>, store = new Map<string, unknown>(), clock = false, refuse = {} }: ArrangeOptions = {}): Recorder {
  const rec = { registered: [], opened: [], timers: [], calls: [], statuses: [], toasts: [], prompts: [], sessionStarts: 0, store } as Recorder
  on('session.start', (_: any, e: any) => { rec.sessionStarts += 1; return { cwd: e.cwd } })
  on('command.register', (_: any, e: any) => { rec.registered.push(e); return { value: undefined } })
  on('ui.open', (_: any, e: any) => { rec.opened.push(e); return refuse.open ? { deny: refuse.open } : { value: { isPlaced: true } } })
  on('ui.status', (_: any, e: any) => { if (e.text) rec.statuses.push(String(e.text)); return { value: undefined } })
  on('ui.toast', (_: any, e: any) => { rec.toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => { rec.prompts.push(e.text); return { text: e.text } })
  on('store.get', (_: any, e: any) => ({ value: rec.store.get(e.key) }))
  on('store.set', (_: any, e: any) => { rec.store.set(e.key, e.value); return { value: undefined } })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'kanbantic' } }))
  on('mcp.call', (_: any, e: any) => { rec.calls.push({ tool: e.tool, args: e.args }); return answers(e.tool, e.args) })
  // Either a clock the test advances (timer tests, the start-up time-out), or a
  // stub that only records which timers the mod starts — the kit allows one
  // `clock.every` answer.
  if (clock) rec.clock = mock.clock(on)
  else on('clock.every', (_: any, e: any) => { rec.timers.push(e.ms); return refuse.every ? { deny: refuse.every } : { value: undefined } })
  mock.env(on, env)
  return rec
}

function defaultAnswers(tool: string) {
  if (tool === 'get_epic_children') return mcpText(EPIC_CHILDREN)
  if (tool === 'get_fleet_overview') return mcpText(FLEET)
  if (tool === 'list_decisions') return mcpText(DECISIONS)
  return { deny: `unexpected tool ${tool}` }
}

/** A $.mcp.call that never settles: Kanbantic hangs instead of failing. */
function neverAnswers() {
  return new Promise(() => {})
}

const INTERACTIVE = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

test('/epic KBT-E144 opens the pane with progress bar, feature table and "Wacht op jou"', { timeoutMs: 30_000 }, async ($, on) => {
  const rec = arrange(on)
  await $.session.start(INTERACTIVE)
  expect(rec.registered.map((r) => r.name)).toEqual(['epic'])

  const answer = await $.command.run({ command: 'epic', args: 'KBT-E144' })
  expect(answer).toEqual({})
  expect(rec.opened.length).toBe(1)
  expect(rec.opened[0].id).toBe('kanbantic-epic')
  expect(String(rec.opened[0].title)).toContain('KBT-E144')
  expect(rec.calls.map((c) => c.tool).sort()).toEqual(['get_epic_children', 'get_fleet_overview', 'list_decisions'])
  expect(rec.calls.find((c) => c.tool === 'get_epic_children')?.args).toEqual({ epicId: 'KBT-E144', maxResults: 100 })
  expect(rec.calls.find((c) => c.tool === 'list_decisions')?.args).toMatchObject({ status: 'Open' })
  expect(rec.store.get('epic-pane.lastEpic')).toBe('KBT-E144')

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /KBT-E144/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5\/13 Done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /█/ })).toBeDefined()
    // Feature table: code + agent name on one row.
    const f746 = await ui.find({ type: 'Text', text: /KBT-F746/ })
    expect(f746).toBeDefined()
    expect(f746?.text).toMatch(/Axon 04/)
    // "Wacht op jou": every open decision with its code.
    expect(await ui.find({ type: 'Text', text: /Wacht op jou/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /KBT-DR042/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /KBT-DR043/ })).toBeDefined()
    // Fleet block: agent, role, model.
    const axon11 = await ui.find({ type: 'Text', text: /Axon 11/ })
    expect(axon11?.text).toMatch(/reviewer/i)
    expect(axon11?.text).toMatch(/claude-opus-4-1/)
    expect(axon11?.text).toMatch(/idle/)
    await ui.unmount()
  }
})

test('a row is red for WaitingForInput (isAttention) or a wait beyond stillAfterMinutes', { options: { stillAfterMinutes: 10 } }, async ($, on) => {
  arrange(on)
  await $.session.start(INTERACTIVE)
  await $.command.run({ command: 'epic', args: 'KBT-E144' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const working = await ui.find({ type: 'Text', text: /KBT-F746/ })
  const waiting = await ui.find({ type: 'Text', text: /KBT-F747/ })
  const still = await ui.find({ type: 'Text', text: /KBT-F748/ })
  expect(working?.props.color).not.toBe('red')
  expect(waiting?.props.color).toBe('red')   // isAttention / WaitingForInput, 45 min
  expect(still?.props.color).toBe('red')     // 25 min > stillAfterMinutes 10
  await ui.unmount()
})

test('a wait under stillAfterMinutes stays unmarked', { options: { stillAfterMinutes: 30 } }, async ($, on) => {
  arrange(on)
  await $.session.start(INTERACTIVE)
  await $.command.run({ command: 'epic', args: 'KBT-E144' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const still = await ui.find({ type: 'Text', text: /KBT-F748/ })
  expect(still?.props.color).not.toBe('red') // 25 min < 30
  const waiting = await ui.find({ type: 'Text', text: /KBT-F747/ })
  expect(waiting?.props.color).toBe('red')   // isAttention wins regardless of the threshold
  await ui.unmount()
})

test('/epic without an argument uses the epic kept in $.store', async ($, on) => {
  const rec = arrange(on, { store: new Map<string, unknown>([['epic-pane.lastEpic', 'KBT-E144']]) })
  await $.session.start(INTERACTIVE)
  // A stored epic is opened unasked at session start (the engine seats it from 144 columns)…
  const openedAtStart = rec.opened.length
  await $.command.run({ command: 'epic', args: '' })
  // …and /epic without an argument opens that same epic again, never asking for one.
  expect(rec.opened.length).toBe(openedAtStart + 1)
  for (const o of rec.opened) expect(String(o.title)).toContain('KBT-E144')
  expect(rec.calls.find((c) => c.tool === 'get_epic_children')?.args).toMatchObject({ epicId: 'KBT-E144' })
})

test('/epic without an argument and without a stored epic explains itself and opens nothing', async ($, on) => {
  const rec = arrange(on)
  await $.session.start(INTERACTIVE)
  const answer = await $.command.run({ command: 'epic', args: '' })
  expect(String((answer as any).text)).toMatch(/\/epic KBT-E/)
  expect(rec.opened.length).toBe(0)
  expect(rec.calls.length).toBe(0)
})

test('the Spinner gets the suffix " · E144 x/y · n wachten op PO"', async ($, on) => {
  arrange(on)
  // Stands for what Claude Code draws at the Spinner site, with the suffix the mod passed on.
  on('ui.render', (_: any, e: any) => ({ type: 'Text', props: {}, children: [String(e.props.word) + String(e.props.suffix)] }))
  await $.session.start(INTERACTIVE)
  await $.command.run({ command: 'epic', args: 'KBT-E144' })

  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const line = await ui.find({ type: 'Text', text: /Denken/ })
  expect(line?.text).toBe('Denken · E144 5/13 · 2 wachten op PO…')
  await ui.unmount()
})

test('the Spinner is left alone while no epic is loaded', async ($, on) => {
  arrange(on)
  on('ui.render', (_: any, e: any) => ({ type: 'Text', props: {}, children: [String(e.props.word) + String(e.props.suffix)] }))
  await $.session.start(INTERACTIVE)

  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const line = await ui.find({ type: 'Text', text: /Denken/ })
  expect(line?.text).toBe('Denken…')
  await ui.unmount()
})

test('session.start on an interactive surface starts exactly one timer of refreshSeconds', { options: { refreshSeconds: 90 } }, async ($, on) => {
  const rec = arrange(on)
  await $.session.start(INTERACTIVE)
  expect(rec.timers).toEqual([90_000])
})

test('the refresh timer runs every refreshSeconds and redraws from fresh MCP data', { options: { refreshSeconds: 60 } }, async ($, on) => {
  const rec = arrange(on, { clock: true })
  await $.session.start(INTERACTIVE)
  await $.command.run({ command: 'epic', args: 'KBT-E144' })
  const before = rec.calls.length
  expect(before).toBe(3)
  // Fire the timer twice: two more rounds of the three calls.
  await rec.clock.advance(60_000)
  await rec.clock.advance(60_000)
  expect(rec.calls.length).toBe(before + 6)
})

test('a -p run (no interactive surface) starts no timer, registers no command and opens no pane', async ($, on) => {
  const rec = arrange(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  expect(rec.timers).toEqual([])
  expect(rec.registered).toEqual([])
  expect(rec.opened).toEqual([])
  expect(rec.calls).toEqual([])

  // Even a Pane draw for our id draws nothing of substance: a one-line notice, no table.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /KBT-F746/ })).toBeUndefined()
  await ui.unmount()
})

test('a daemon-spawned VM session (KANBANTIC_SPAWN_COMMAND_ID set) draws nothing and starts no timer', async ($, on) => {
  const rec = arrange(on, { env: { KANBANTIC_SPAWN_COMMAND_ID: 'spawn-123' } })
  await $.session.start(INTERACTIVE)
  expect(rec.timers).toEqual([])
  expect(rec.registered).toEqual([])
  expect(rec.opened).toEqual([])
})

test('a failed $.mcp.call is fail-open: "niet bereikbaar" in the pane, no turn started', async ($, on) => {
  const rec = arrange(on, { answers: () => ({ deny: 'Kanbantic offline' }) })
  await $.session.start(INTERACTIVE)
  const answer = await $.command.run({ command: 'epic', args: 'KBT-E144' })
  expect(answer).toEqual({})
  expect(rec.opened.length).toBe(1)
  expect(rec.prompts).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /niet bereikbaar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /KBT-F746/ })).toBeUndefined()
  await ui.unmount()
})

// ── KBT-T5228 — read-only: no answering from the pane, deep-links instead ───

test('KBT-T5228 — "Wacht op jou" shows a deep-link to the Beslisbak per decision and no answer buttons', async ($, on) => {
  const rec = arrange(on)
  await $.session.start(INTERACTIVE)
  await $.command.run({ command: 'epic', args: 'KBT-E144' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // DR042: the inboxUrl the API gave, verbatim.
  expect(await ui.find({ type: 'Text', text: /app\.kanbantic\.test\/workspace\/kanbantic\/decisions\/3a24-dr-42/ })).toBeDefined()
  // DR043: no inboxUrl and no appUrl configured → the code plus the plain-text pointer.
  expect(await ui.find({ type: 'Text', text: /KBT-DR043/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Open de Beslisbak in Kanbantic/ })).toBeDefined()
  // No buttons at all: the pane never answers a decision under the agent identity.
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  expect(rec.calls.map((c) => c.tool).filter((t) => !READ_TOOLS.includes(t))).toEqual([])
  await ui.unmount()
})

test('KBT-T5228 — without inboxUrl the link is built from appUrl + workspace: <appUrl>/workspace/<workspace>/decisions/<id>', { options: { appUrl: 'https://kanbantic.example/', workspace: 'kanbantic' } }, async ($, on) => {
  arrange(on)
  await $.session.start(INTERACTIVE)
  await $.command.run({ command: 'epic', args: 'KBT-E144' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^https:\/\/kanbantic\.example\/workspace\/kanbantic\/decisions\/3a24-dr-43$/ })).toBeDefined()
  // The API's own inboxUrl still wins over the built one.
  expect(await ui.find({ type: 'Text', text: /app\.kanbantic\.test\/workspace\/kanbantic\/decisions\/3a24-dr-42/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Open de Beslisbak in Kanbantic/ })).toBeUndefined()
  await ui.unmount()
})

test('KBT-T5228 — a full start/command/refresh/press cycle calls only read tools', { options: { refreshSeconds: 60 } }, async ($, on) => {
  const rec = arrange(on, { clock: true, store: new Map<string, unknown>([['epic-pane.lastEpic', 'KBT-E144']]) })
  await $.session.start(INTERACTIVE)
  await rec.clock.advance(0)          // the start-up refresh
  await $.command.run({ command: 'epic', args: 'KBT-E144' })
  await rec.clock.advance(60_000)     // one timer round

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const b of await ui.findAll({ type: 'Button' })) await ui.press({ key: String(b.key) })
  await ui.unmount()

  expect(rec.calls.length > 0).toBe(true)
  expect(rec.calls.map((c) => c.tool).filter((t) => !READ_TOOLS.includes(t))).toEqual([])
  expect(rec.prompts).toEqual([])
})

// ── KBT-T5230 (8) — fail-open at session start ──────────────────────────────

test('KBT-T5230 (8) — a $.mcp.call that never settles does not block session.start; after the 5 s time-out the pane says "niet bereikbaar"', { timeoutMs: 8_000 }, async ($, on) => {
  const rec = arrange(on, { answers: neverAnswers, clock: true, store: new Map<string, unknown>([['epic-pane.lastEpic', 'KBT-E144']]) })
  await $.session.start(INTERACTIVE)
  // The start reached the engine (next(e)) and the command is there, MCP or not.
  expect(rec.sessionStarts).toBe(1)
  expect(rec.registered.map((r) => r.name)).toEqual(['epic'])
  expect(rec.opened.length).toBe(1)

  await rec.clock.advance(0)          // the start-up refresh is now in flight…
  expect(rec.calls.length).toBe(3)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /laden/ })).toBeDefined()
  await ui.unmount()

  await rec.clock.advance(5_000)      // …and gives up after the time-out, without throwing.
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /niet bereikbaar/ })).toBeDefined()
  await ui.unmount()
  expect(rec.prompts).toEqual([])
})

test('KBT-T5230 (8) — a refused $.ui.open and $.clock.every do not block session.start nor /epic', async ($, on) => {
  const rec = arrange(on, { refuse: { open: 'no surface', every: 'no timers' }, store: new Map<string, unknown>([['epic-pane.lastEpic', 'KBT-E144']]) })
  await $.session.start(INTERACTIVE)
  expect(rec.sessionStarts).toBe(1)
  expect(rec.registered.map((r) => r.name)).toEqual(['epic'])

  const answer = await $.command.run({ command: 'epic', args: 'KBT-E144' })
  expect(answer).toEqual({})
  // The refresh still ran even though the pane could not be opened.
  expect(rec.calls.map((c) => c.tool).sort()).toEqual(['get_epic_children', 'get_fleet_overview', 'list_decisions'])
  expect(rec.prompts).toEqual([])
})

test('KBT-T5230 (8) — a failed refresh keeps the previous state and sets a status line', { options: { refreshSeconds: 60 } }, async ($, on) => {
  let offline = false
  const rec = arrange(on, { clock: true, answers: (tool) => (offline ? { deny: 'Kanbantic offline' } : defaultAnswers(tool)) })
  await $.session.start(INTERACTIVE)
  await $.command.run({ command: 'epic', args: 'KBT-E144' })

  offline = true
  await rec.clock.advance(60_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /niet bereikbaar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /KBT-F746/ })).toBeDefined()   // the last good data stays
  expect(await ui.find({ type: 'Text', text: /5\/13 Done/ })).toBeDefined()
  await ui.unmount()
  expect(rec.statuses.some((s) => /niet bereikbaar/.test(s))).toBe(true)
  expect(rec.prompts).toEqual([])
})
