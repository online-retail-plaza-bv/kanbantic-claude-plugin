#!/usr/bin/env node
'use strict';

//
// notification-session-state — KBT-F741 / KBT-T5188 (spec KBT-SR637)
//
// Notification hook. Claude Code fires it when it needs the user:
// `permission_prompt` (a permission dialog is open), `idle_prompt` (waiting for
// input) and `agent_needs_input`. hooks.json matches exactly those three; the
// script re-checks, so a wider matcher can never turn into noise.
//
// Action: POST /api/app/agent-session/{id}/wait-for-user
//         { prompt: "[<notification_type>] <title>: <message>" }  (max 2000)
//
// Payload fields used (Claude Code hooks reference): `notification_type`,
// `title` (optional), `message`, `session_id` (to find the session file).
// Nothing else is read, nothing else is sent. Title and message are redacted
// (SEC063 §1).
//
// Idempotence with the PermissionRequest router: for an unanswered permission
// question BOTH hooks fire. Sending the same text twice is harmless, but the
// router's prompt ("[permission] Bash: git push …") is more useful than this
// generic one, so a permission_prompt arriving within 60 s of a router report
// is skipped instead of overwriting it.
//
// Fail-open: no session file / key, network error, non-2xx, bad stdin → exit 0,
// no stdout. Hooks do not talk through the MCP proxy.
//

const api = require('./lib/session-api.js');
const state = require('./lib/tool-state.js');

const TYPES = new Set(['permission_prompt', 'idle_prompt', 'agent_needs_input']);
const MAX_PROMPT = 2000;

function buildPrompt(payload) {
  const type = payload.notification_type;
  const title = api.redactText(typeof payload.title === 'string' ? payload.title.trim() : '');
  const message = api.redactText(typeof payload.message === 'string' ? payload.message.trim() : '');
  const body = [title, message].filter(Boolean);
  const text = title && message ? `${title}: ${message}` : body.join('');
  return api.truncate(text ? `[${type}] ${text}` : `[${type}]`, MAX_PROMPT);
}

async function handle(payload, ctx) {
  const type = payload.notification_type;
  if (typeof type !== 'string' || !TYPES.has(type)) {
    api.debug('notification type is not one of ours');
    return;
  }
  const sid = api.claudeSessionId(payload) || ctx.sessionId;
  if (type === 'permission_prompt' && state.permissionRecentlyReported(process.env, sid)) {
    api.debug('permission router already reported this question');
    return;
  }
  await api.postQuietly(ctx, api.sessionRoute(ctx, 'wait-for-user'), { prompt: buildPrompt(payload) }, 'wait-for-user');
}

if (require.main === module) {
  api.runHook(handle);
}

module.exports = { buildPrompt };
