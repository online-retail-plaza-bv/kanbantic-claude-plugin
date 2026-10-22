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
//       first a `Permission` decision request (KBT-F742, POST
//       /api/app/decision-request: kind Permission, recipient Operator, options
//       allow-once / allow-always / deny with terminalInput, recommended
//       allow-once) so the operator answers it from the Beslisbak and the answer
//       is relayed as terminal input; then wait-for-user "Permissieverzoek <code>".
//       allow-always is only offered with a `proposedAllowRule` that covers
//       exactly this call (KBT-T5224, see proposeAllowRule below); without a
//       valid rule the request carries allow-once + deny only.
//       When the create fails (non-2xx, 5 s time-out, no workspace known) the
//       KBT-SR638 fallback applies: wait-for-user "[permission] <tool_name>:
//       <input, redacted, ≤500>" and the same text as a message in the session's
//       own channel.
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
const { validateRule, resolveInputPath } = permissionAllow;
const { loadAllowList } = require('./lib/allow-cache.js');

const MAX_INPUT = 500;
const MAX_DECISION_TEXT = 2000; // CreateDecisionRequestInput: context ≤ 8000, rationale ≤ 2000 — both kept short
const MAX_RULE = 500;           // CreateDecisionRequestInput.ProposedAllowRule
const MAX_OPTION_TITLE = 120;   // DecisionRequestConsts.MaxOptionTitleLength (consequence ≤ 1000)

const DECISION_KIND_PERMISSION = 2;   // DecisionRequestKind.Permission
const DECISION_ROLE_OPERATOR = 4;     // DecisionRecipientRole.Operator
const OPTION_ALLOW_ONCE = { key: 'allow-once', title: 'Eenmalig toestaan', consequence: 'De tool draait nu één keer.', terminalInput: 'y\n' };
const OPTION_DENY = { key: 'deny', title: 'Weigeren', consequence: 'De tool draait niet; de agent kiest een andere weg.', terminalInput: 'n\n' };

/**
 * The allow-always option carries the proposed rule literally (KBT-T5224): the
 * operator must see exactly what "altijd" will mean. The title is capped at the
 * server's option-title limit; the consequence and `proposedAllowRule` hold the
 * full rule (the server may rewrite the title identically from that field).
 */
function allowAlwaysOption(rule) {
  const full = `Altijd toestaan: ${rule}`;
  return {
    key: 'allow-always',
    title: full.length <= MAX_OPTION_TITLE ? full : `${full.slice(0, MAX_OPTION_TITLE - 1)}…`,
    consequence: `Voegt ${rule} toe aan de allow-lijst van de workspace`,
    terminalInput: 'y\n',
  };
}

/** Without a valid rule there is no "altijd": the bare tool is never proposed. */
function decisionOptions(rule) {
  return rule ? [OPTION_ALLOW_ONCE, allowAlwaysOption(rule), OPTION_DENY] : [OPTION_ALLOW_ONCE, OPTION_DENY];
}

// ── proposedAllowRule (KBT-T5224, review fix Critical 2) ────────────────────
//
// The rule that "altijd toestaan" would add, in the allow-list's own syntax
// (permission-allow.js), covering exactly this call and nothing wider:
//   Bash(<exact command, trimmed>)       no `*` (it would become a prefix rule)
//   Read|Edit|Write|Glob|Grep(<path>)    absolute, forward slashes, `..` collapsed;
//                                        Glob/Grep on their `path` (or cwd)
//   WebFetch(domain:<host>)              host of tool_input.url, lower-cased
//   mcp__<server>__<tool>                the tool name itself
// Anything else (Task, WebSearch, MultiEdit, NotebookEdit, …) gets no rule:
// the matcher cannot express it, so the SessionStart sync would reject it.
//
// A candidate is proposed only when (1) redaction leaves it untouched — a
// masked rule would never match anything, and the secret must not leave the
// machine; (2) validateRule accepts it (bare tool, compound/forbidden Bash,
// wildcard and root globs are refused there); and (3) `decide([rule], payload)`
// allows this very payload — the same code path that will later honour the
// rule, including the local-memory veto and the compound-command refusal.
// Write-tools additionally never get a rule under a `.claude` or `.git`
// segment or for `.mcp.json`.
//

const PATH_RULE_TOOLS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Edit', 'Write']);
const PROTECTED_SEGMENTS = new Set(['.claude', '.git', '.mcp.json']);

function candidateRule(payload) {
  const tool = payload.tool_name;
  const input = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input) ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

  if (tool === 'Bash') {
    if (typeof input.command !== 'string') return null;
    const cmd = input.command.trim();
    if (!cmd || cmd.includes('*')) return null;
    return `Bash(${cmd})`;
  }
  if (PATH_RULE_TOOLS.has(tool)) {
    const raw = input.file_path || input.filePath || (tool === 'Glob' || tool === 'Grep' ? input.path || cwd : null);
    const p = resolveInputPath(raw, cwd);
    if (!p || /[*?]/.test(p)) return null;
    if (WRITE_TOOLS.has(tool) && p.split('/').some((seg) => PROTECTED_SEGMENTS.has(seg.toLowerCase()))) return null;
    return `${tool}(${p})`;
  }
  if (tool === 'WebFetch') {
    if (typeof input.url !== 'string') return null;
    let host;
    try { host = new URL(input.url).hostname.toLowerCase(); } catch (_) { return null; }
    return host ? `WebFetch(domain:${host})` : null;
  }
  if (tool.startsWith('mcp__') && !tool.includes('*')) return tool;
  return null;
}

/** The rule to propose for this payload, or null when none is safe and exact. Never throws. */
function proposeAllowRule(payload) {
  try {
    if (!payload || typeof payload.tool_name !== 'string' || !payload.tool_name) return null;
    const rule = candidateRule(payload);
    if (!rule || rule.length > MAX_RULE) return null;
    if (api.redactText(rule) !== rule) return null;
    if (!validateRule(rule).ok) return null;
    const v = permissionAllow.decide([rule], payload); // the real matcher, never the injected test seam
    return v.allow && v.rule === rule ? rule : null;
  } catch (_) {
    return null;
  }
}

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

/**
 * The Permission decision request for this tool call (KBT-SR642 §koppeling).
 * Redaction happens inside summarizeToolInput, BEFORE truncation (SEC064 §4):
 * the request carries only tool_name and the shortened, redacted input.
 */
function buildDecisionRequest(payload, ctx, env = process.env) {
  const workspaceId = api.workspaceIdOf(ctx, env);
  if (!workspaceId) return null;
  const input = api.summarizeToolInput(payload.tool_name, payload.tool_input, MAX_DECISION_TEXT);
  const rule = proposeAllowRule(payload);
  const body = {
    workspaceId,
    kind: DECISION_KIND_PERMISSION,
    recipientRole: DECISION_ROLE_OPERATOR,
    question: `Permissie voor ${payload.tool_name}?`,
    context: input,
    options: decisionOptions(rule),
    recommendedOptionKey: 'allow-once',
    rationale: api.truncate(`${payload.tool_name}: ${input}`, MAX_DECISION_TEXT),
    priority: api.priorityOf(ctx),
    deadlineAt: new Date(Date.now() + api.permissionDeadlineMinutes(env) * 60_000).toISOString(),
    fromSessionId: ctx.sessionId,
  };
  if (rule) body.proposedAllowRule = rule;
  const issueId = api.currentIssueIdOf(ctx);
  if (issueId) body.issueId = issueId;
  return body;
}

/** Resolves the created request's code (or null when the create did not succeed). */
async function createPermissionDecision(payload, ctx) {
  const input = buildDecisionRequest(payload, ctx);
  if (!input) {
    api.debug('no workspaceId in the session file or KANBANTIC_WORKSPACE_ID — no decision request, channel fallback');
    return null;
  }
  try {
    const dto = await api.createDecisionRequest(ctx, input);
    const code = dto && typeof dto.code === 'string' && dto.code ? dto.code : null;
    if (!code) api.debug('decision-request created but the response carries no code — using the tool prompt');
    return code;
  } catch (err) {
    api.debug('decision-request failed — channel fallback', err);
    return null;
  }
}

async function reportWaiting(payload, ctx) {
  // 1. The decision request IS the question (KBT-F742). Sequential on purpose:
  //    the wait-for-user prompt names the code it returns.
  const code = await createPermissionDecision(payload, ctx);
  // 2. Session state. With a code there is no separate channel message — the
  //    answer comes back as a DecisionAnswer message in this channel anyway.
  const prompt = code ? `Permissieverzoek ${code}` : buildPrompt(payload);
  state.markPermissionReported(process.env, api.claudeSessionId(payload) || ctx.sessionId);
  const posts = [api.postQuietly(ctx, api.sessionRoute(ctx, 'wait-for-user'), { prompt }, 'wait-for-user')];
  if (!code && ctx.channelId) {
    posts.push(api.postQuietly(ctx, api.channelMessageRoute(ctx), { content: prompt, fromSessionId: ctx.sessionId }, 'channel message'));
  } else if (!code) {
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

module.exports = { buildPrompt, buildDecisionRequest, proposeAllowRule, decisionOptions, main };
