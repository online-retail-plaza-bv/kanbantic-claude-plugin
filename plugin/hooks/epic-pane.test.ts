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
    { id: '3a24-dr-42', code: 'KBT-DR042', kind: 'Choice', status: 'Open', question: 'Spec A of spec B?', recipientRole: 'ProductOwner', issueCode: 'KBT-F747', epicCode: 'KBT-E144', requestedBy: 'Axon 07', deadlineAt: '2026-10-20T09:00:00Z', remainingMinutes: 180, recommendedOptionKey: 'a', options: [{ key: 'a', title: 'Spec A' }, { key: 'b', title: 'Spec B' }] },
    { id: '3a24-dr-43', code: 'KBT-DR043', kind: 'Approval', status: 'Open', question: 'Akkoord met de migratie?', recipientRole: 'ProductOwner', issueCode: 'KBT-F748', epicCode: 'KBT-E144', requestedBy: 'Axon 09', deadlineAt: null, remainingMinutes: null, recommendedOptionKey: 'yes', options: [{ key: 'yes', title: 'Ja' }, { key: 'no', title: 'Nee' }] },
  ],
}

type Recorder = {
  registered: Array<Record<string, unknown>>
  opened: Array<Record<string, unknown>>
  timers: number[]
  calls: Array<{ tool: string; args: Record<string, unknown> }>
  statuses: string[]
  toasts: string[]
  prompts: string[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
}

function mcpText(obj: unknown) {
  return { value: { content: [{ type: 'text', text: JSON.stringify(obj) }], isError: false } }
}

/**
 * Every stub the mod can reach, registered before the test's first call on $.
 * `answers` decides what each $.mcp.call resolves to; `env` stands for the
 * process environment.
 */
function arrange(on: any, { answers = defaultAnswers, env = {} as Record<string, string>, store = new Map<string, unknown>(), clock = false } = {}): Recorder {
  const rec = { registered: [], opened: [], timers: [], calls: [], statuses: [], toasts: [], prompts: [], store } as Recorder
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_: any, e: any) => { rec.registered.push(e); return { value: undefined } })
  on('ui.open', (_: any, e: any) => { rec.opened.push(e); return { value: { isPlaced: true } } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_: any, e: any) => { rec.toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => { rec.prompts.push(e.text); return { text: e.text } })
  on('store.get', (_: any, e: any) => ({ value: rec.store.get(e.key) }))
  on('store.set', (_: any, e: any) => { rec.store.set(e.key, e.value); return { value: undefined } })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'kanbantic' } }))
  on('mcp.call', (_: any, e: any) => { rec.calls.push({ tool: e.tool, args: e.args }); return answers(e.tool, e.args) })
  // Either a clock the test advances (timer test), or a stub that only records
  // which timers the mod starts — the kit allows one `clock.every` answer.
  if (clock) rec.clock = mock.clock(on)
  else on('clock.every', (_: any, e: any) => { rec.timers.push(e.ms); return { value: undefined } })
  mock.env(on, env)
  return rec
}

function defaultAnswers(tool: string) {
  if (tool === 'get_epic_children') return mcpText(EPIC_CHILDREN)
  if (tool === 'get_fleet_overview') return mcpText(FLEET)
  if (tool === 'list_decisions') return mcpText(DECISIONS)
  if (tool === 'answer_decision') return mcpText({ success: true })
  return { deny: `unexpected tool ${tool}` }
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

test('an option button answers the decision through answer_decision', async ($, on) => {
  const rec = arrange(on)
  await $.session.start(INTERACTIVE)
  await $.command.run({ command: 'epic', args: 'KBT-E144' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'decision-3a24-dr-42-b' })
  const call = rec.calls.find((c) => c.tool === 'answer_decision')
  expect(call?.args).toMatchObject({ decisionRequestId: '3a24-dr-42', optionKey: 'b' })
  await ui.unmount()
})
