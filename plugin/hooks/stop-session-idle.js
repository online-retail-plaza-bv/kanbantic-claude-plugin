#!/usr/bin/env node
'use strict';

//
// stop-session-idle — KBT-F741 / KBT-T5188 (spec KBT-SR637)
//
// Stop hook: Claude finished its turn and is idle. Runs next to
// stop-version-summary.js; it prints NOTHING (that script owns the Stop line).
//
// Action: POST /api/app/agent-session/{id}/heartbeat
//         { status: "Idle", summary, activeBackgroundTasks }
//
// Payload fields used: `last_assistant_message` (first 300 chars, redacted per
// SEC063 §1 — it may quote anything from the conversation), `background_tasks`
// (array of in-flight tasks → its length; absent → null so the server can tell
// "unknown" from "none"), `session_id`.
//
// Fail-open: any failure → exit 0, no stdout. Hooks do not talk through the
// MCP proxy.
//

const api = require('./lib/session-api.js');

const MAX_SUMMARY = 300;

function buildBody(payload) {
  const text = api.truncate(api.redactText(
    typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : ''
  ), MAX_SUMMARY);
  return {
    status: 'Idle',
    summary: text || null,
    activeBackgroundTasks: Array.isArray(payload.background_tasks) ? payload.background_tasks.length : null,
  };
}

async function handle(payload, ctx) {
  await api.postQuietly(ctx, api.sessionRoute(ctx, 'heartbeat'), buildBody(payload), 'heartbeat');
}

if (require.main === module) {
  api.runHook(handle);
}

module.exports = { buildBody };
