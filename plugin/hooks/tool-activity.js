#!/usr/bin/env node
'use strict';

//
// tool-activity — KBT-F741 / KBT-T5188 (spec KBT-SR637)
//
// One script for two events, selected by flag:
//
//   --pre   PreToolUse   → POST /api/app/agent-session/{id}/tool-activity
//                          { toolName, toolUseId, startedAt }
//   --post  PostToolUse  → POST /api/app/agent-session/{id}/tool-activity
//                          { toolUseId, endedAt }
//
// A tool that started but never ended is the signal for "this tool call is
// hanging"; the server pairs the two events on `toolUseId`.
//
// Payload fields used: `tool_name`, `tool_use_id`, `session_id`; `tool_input` is
// read ONLY by --pre to remember the id locally for the PermissionRequest router
// (tool-state.js) and is never sent. `tool_response` is not read at all.
//
// `tool_use_id` is present on PreToolUse/PostToolUse in current Claude Code. If
// it is ever missing the script falls back to `<session_id>:<tool_name>:<ts>`
// and says so under KANBANTIC_SYNC_DEBUG (a fallback id cannot pair a pre with
// its post — better a visible gap than a wrong pairing).
//
// Fail-open: any failure → exit 0, no stdout. Without --pre/--post nothing is
// sent. Hooks do not talk through the MCP proxy.
//

const api = require('./lib/session-api.js');
const state = require('./lib/tool-state.js');

async function handle(payload, ctx) {
  const mode = process.argv.includes('--pre') ? 'pre' : process.argv.includes('--post') ? 'post' : null;
  if (!mode) { api.debug('neither --pre nor --post given'); return; }

  const sid = api.claudeSessionId(payload) || ctx.sessionId;
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
  let toolUseId = typeof payload.tool_use_id === 'string' && payload.tool_use_id ? payload.tool_use_id : null;
  const hadId = Boolean(toolUseId);
  if (!hadId) {
    toolUseId = state.fallbackToolUseId(sid, toolName);
    api.debug('payload has no tool_use_id — using a synthetic <session_id>:<tool_name>:<ts> id');
  }

  if (mode === 'pre') {
    if (hadId) state.rememberPre(process.env, sid, toolUseId, toolName, payload.tool_input);
    await api.postQuietly(ctx, api.sessionRoute(ctx, 'tool-activity'), {
      toolName,
      toolUseId,
      startedAt: new Date().toISOString(),
    }, 'tool-activity (pre)');
    return;
  }

  if (hadId) state.forgetPre(process.env, sid, toolUseId);
  await api.postQuietly(ctx, api.sessionRoute(ctx, 'tool-activity'), {
    toolUseId,
    endedAt: new Date().toISOString(),
  }, 'tool-activity (post)');
}

if (require.main === module) {
  api.runHook(handle);
}
