#!/usr/bin/env node
'use strict';

//
// turn-start — KBT-F741 / KBT-T5188 (spec KBT-SR637)
//
// UserPromptSubmit hook: a new turn begins.
//
// Action: POST /api/app/agent-session/{id}/turn-start  { at: <ISO> }
//
// Payload fields used: `session_id` (to find the session file) only. The
// submitted `prompt` is deliberately NOT read — it can hold anything the user
// typed, and the server needs only the moment the turn started.
//
// Fail-open: any failure → exit 0, no stdout (UserPromptSubmit stdout would be
// injected into the model context, so silence matters here more than anywhere).
//

const api = require('./lib/session-api.js');

async function handle(_payload, ctx) {
  await api.postQuietly(ctx, api.sessionRoute(ctx, 'turn-start'), { at: new Date().toISOString() }, 'turn-start');
}

if (require.main === module) {
  api.runHook(handle);
}
