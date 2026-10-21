#!/usr/bin/env node
'use strict';

//
// permission-request-router — KBT-F741 / KBT-T5189 (spec KBT-SR638, SEC063 §2)
//
// PermissionRequest hook: Claude Code is about to ask the user for permission.
//
//   match in the workspace allow-list  → stdout
//       {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
//         "decision":{"behavior":"allow"}}}
//       and a tool-activity row with permissionDecision "allow-list: <rule>"
//   no match                           → NO decision on stdout (the user decides),
//       wait-for-user "[permission] <tool_name>: <input, redacted, ≤500>" and the
//       same text as a message in the session's own channel
//
// It NEVER emits `deny`, and NEVER emits `allow` unless a validated rule from
// the cache matched locally. API failures change nothing about the decision:
// a match still allows (the decision is local), a non-match stays silent.
//
// Payload fields used (Claude Code hooks reference): `tool_name`, `tool_input`,
// `cwd`, `session_id`. `permission_suggestions`/`permission_mode` are ignored.
// PermissionRequest carries NO `tool_use_id`: the id is taken from the matching
// PreToolUse record (tool-state.js), else a synthetic
// `<session_id>:<tool_name>:<ts>`. `updatedInput` is not needed for a plain allow.
//
// Reads ONLY the cache written by session-start-toolkit-sync.js (allow-cache.js)
// — no Toolkit/MCP call and no other network on the hot path beyond the two
// short REST posts above.
//
// Fail-open: unparseable stdin, missing/corrupt cache, anything thrown → exit 0,
// empty stdout. (Unlike most hooks, "open" here means "ask the user as usual".)
//
// No environment switch changes the decision (KBT-T5219): a bypass that can
// be enabled from `.claude/settings.local.json` has no place in production
// code. The mutation run of KBT-TC4195 stap 6 instead starts this very script
// through `main({ decide })` with an injected decide() (tests/helpers/
// router-mutant.js); the default is the real matcher.
//

const api = require('./lib/session-api.js');
const state = require('./lib/tool-state.js');
const permissionAllow = require('./lib/permission-allow.js');
const { loadAllowList } = require('./lib/allow-cache.js');

const MAX_INPUT = 500;

const ALLOW_OUTPUT = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' },
  },
};

function emitAllow() {
  try {
    process.stdout.write(`${JSON.stringify(ALLOW_OUTPUT)}\n`, () => process.exit(0));
  } catch (_) {
    process.exit(0);
  }
}

function buildPrompt(payload) {
  return `[permission] ${payload.tool_name}: ${api.summarizeToolInput(payload.tool_name, payload.tool_input, MAX_INPUT)}`;
}

async function reportAllow(payload, ctx, rule) {
  const sid = api.claudeSessionId(payload) || ctx.sessionId;
  let toolUseId = typeof payload.tool_use_id === 'string' && payload.tool_use_id ? payload.tool_use_id : null;
  if (!toolUseId) toolUseId = state.findPre(process.env, sid, payload.tool_name, payload.tool_input);
  if (!toolUseId) {
    toolUseId = state.fallbackToolUseId(sid, payload.tool_name);
    api.debug('no tool_use_id for this permission request — using a synthetic id');
  }
  await api.postQuietly(ctx, api.sessionRoute(ctx, 'tool-activity'), {
    toolName: payload.tool_name,
    toolUseId,
    permissionDecision: `allow-list: ${rule}`,
  }, 'tool-activity (allow)');
}

async function reportWaiting(payload, ctx) {
  const prompt = buildPrompt(payload);
  state.markPermissionReported(process.env, api.claudeSessionId(payload) || ctx.sessionId);
  const posts = [api.postQuietly(ctx, api.sessionRoute(ctx, 'wait-for-user'), { prompt }, 'wait-for-user')];
  if (ctx.channelId) {
    posts.push(api.postQuietly(ctx, api.channelMessageRoute(ctx), { content: prompt, fromSessionId: ctx.sessionId }, 'channel message'));
  } else {
    api.debug('session file has no channelId — skipping the channel message');
  }
  await Promise.all(posts);
}

/**
 * @param {{decide?: function(string[], object): {allow:boolean, rule?:string, reason?:string}}} [deps]
 *   Injection seam for tests; production (hooks.json) runs with the defaults.
 */
async function main(deps = {}) {
  const decide = typeof deps.decide === 'function' ? deps.decide : permissionAllow.decide;
  const payload = api.parsePayload(await api.readStdin());
  if (!payload || typeof payload.tool_name !== 'string' || !payload.tool_name) {
    api.debug('empty or unparseable PermissionRequest payload');
    return process.exit(0);
  }

  const verdict = decide(loadAllowList(payload), payload);
  const ctx = api.loadContext(payload);

  if (verdict.allow) {
    if (ctx) await reportAllow(payload, ctx, verdict.rule);
    return emitAllow();
  }

  api.debug(`no allow decision (${verdict.reason})`);
  if (ctx) await reportWaiting(payload, ctx);
  return process.exit(0);
}

process.on('unhandledRejection', () => process.exit(0));
process.on('uncaughtException', () => process.exit(0));

if (require.main === module) {
  main().catch((err) => { api.debug('unexpected error', err); process.exit(0); });
}

module.exports = { buildPrompt, main };
