#!/usr/bin/env node
'use strict';

//
// pre-tool-use-ui-gate — KBT-F627 / KBT-RL200
//
// A PreToolUse hook that intercepts `update_issue_status` targeting status
// "Review" and BLOCKS it when the issue has a relationally-pinned wireframe
// (`list_issue_wireframes` non-empty) but shows NO evidence of UI-fidelity
// work: no "UI-UX review:" discussion entry AND no result-attachments. A
// UI-issue that reaches Review without either has skipped the wireframe-
// conformity flow (prepare 5F.3b/5W → execute 6e → review 2.5); letting it
// through silently defeats the KBT-F627 hele-lane-flow guarantee.
//
// Contract (Claude Code PreToolUse):
//   stdin  — JSON { tool_name, tool_input, ... }.
//   block  — write a structured `permissionDecision: "deny"` object to stdout,
//            the human-readable reason to stderr, and exit 2 (canonical block).
//   allow  — exit 0 silently.
//
// The hook is FAIL-OPEN: any infrastructure problem (no API key, network
// error, unparseable response, tool failure) results in `allow`. A hook must
// never wedge a session shut on its own malfunction — it only ever blocks on
// a positive, confirmed "pinned wireframe + zero fidelity evidence" signal.
//
// Config (env):
//   KANBANTIC_MCP_URL  — default https://kanbantic.com/mcp
//   KANBANTIC_API_KEY  — required to perform the lookups; absent ⇒ fail-open.
//
// Zero deps — Node built-ins only.
//

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const MCP_URL = process.env.KANBANTIC_MCP_URL || 'https://kanbantic.com/mcp';
const API_KEY = process.env.KANBANTIC_API_KEY;

// Marker an execute/review flow leaves in the discussion timeline once the
// UI-UX conformity review has actually been performed.
const UI_UX_REVIEW_MARKER = 'UI-UX review:';

function allow() {
  process.exit(0);
}

function block(message) {
  // Structured decision for Claude Code's permission engine ...
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: message,
        },
      }) + '\n'
    );
  } catch (_) {
    /* stdout best-effort */
  }
  // ... and a plain reason on stderr + exit 2 for the classic blocking contract.
  process.stderr.write(message + '\n');
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function isUpdateIssueStatus(toolName) {
  // Matches `mcp__kanbantic__update_issue_status`, the fully-qualified
  // `mcp__plugin_<...>__update_issue_status` proxy form, and a bare
  // `update_issue_status`.
  return typeof toolName === 'string' && /(^|_)update_issue_status$/.test(toolName);
}

function targetsReview(toolInput) {
  // Case-sensitive on purpose: "Review" is the exact IssueStatus enum value.
  return !!toolInput && toolInput.status === 'Review';
}

// Pure decision rule. Block only on the positive, confirmed signal:
// a relationally-pinned wireframe with neither a UI-UX review entry nor
// result-attachments. Any evidence of fidelity work ⇒ allow (fail-open
// philosophy extends to the decision itself).
function shouldBlock({ hasLinkedWireframe, hasUiUxReviewEntry, hasResultAttachments }) {
  return Boolean(hasLinkedWireframe) && !hasUiUxReviewEntry && !hasResultAttachments;
}

function post(body, sessionId) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(MCP_URL);
    } catch (e) {
      return reject(new Error(`Invalid KANBANTIC_MCP_URL: ${e.message}`));
    }
    const transport = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${API_KEY}`,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers,
      },
      (res) => {
        const captured = res.headers['mcp-session-id'] || sessionId || null;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const ct = (res.headers['content-type'] || '').toLowerCase();
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            let parsed;
            if (ct.includes('text/event-stream')) {
              const m = data.match(/^data:\s*(.*)$/m);
              parsed = m ? JSON.parse(m[1]) : null;
            } else {
              parsed = JSON.parse(data);
            }
            resolve({ body: parsed, sessionId: captured });
          } catch (e) {
            reject(new Error(`Parse failure: ${e.message}`));
          }
        });
      }
    );
    req.on('error', (e) => reject(new Error(`Connection failed: ${e.message}`)));
    req.setTimeout(4_000, () => req.destroy(new Error('Request timeout')));
    req.write(JSON.stringify(body));
    req.end();
  });
}

// Unwrap an MCP tools/call result: the tool's JSON payload is carried as a
// text content-block. Returns the parsed object/array, or null.
function unwrapToolResult(rpc) {
  if (!rpc || !rpc.result) return null;
  const result = rpc.result;
  const content = Array.isArray(result.content) ? result.content : null;
  if (content) {
    const textBlock = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    if (textBlock) {
      try {
        return JSON.parse(textBlock.text);
      } catch (_) {
        return null;
      }
    }
  }
  // Some transports forward the object directly — only accept shapes that
  // plausibly are a tool payload (mirrors the locked-version-blocker guard).
  if (
    typeof result === 'object' &&
    (result.success !== undefined ||
      Array.isArray(result.items) ||
      Array.isArray(result.wireframes) ||
      Array.isArray(result.entries) ||
      Array.isArray(result.attachments))
  ) {
    return result;
  }
  return null;
}

// A discussion entry counts as the UI-UX review record only when its content
// STARTS with the marker (after leading whitespace). A mere citation of the
// marker elsewhere in an entry (e.g. quoting this hook's block message) must
// not satisfy the gate.
function isUiUxReviewEntry(entry) {
  const content = entry && typeof entry.content === 'string' ? entry.content : '';
  return content.trimStart().startsWith(UI_UX_REVIEW_MARKER);
}

// Result-screenshot evidence per the lane-shared/ui-contract.md naming
// convention: only attachments whose file name starts with `result-` count.
// Prepare's Step 5W reference-crops are named `wf-*` and must NOT satisfy
// this signal (KBT-F627 review Critical #1).
function hasResultAttachment(attachments) {
  if (!Array.isArray(attachments)) return false;
  return attachments.some((a) => {
    const name = (a && (a.fileName || a.name)) || '';
    return /^result-/i.test(String(name));
  });
}

// Tool payloads vary in envelope shape (bare array vs { items: [...] } vs a
// named collection). Extract the first plausible array; null when none found.
function extractArray(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}

async function callTool(name, args, session) {
  const rpc = await post(
    {
      jsonrpc: '2.0',
      id: session.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    session.id
  );
  return unwrapToolResult(rpc.body);
}

async function gatherEvidence(issueId) {
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ui-gate', version: '1.0.0' },
    },
  });
  const session = { id: init.sessionId, nextId: 2 };

  const wireframes = extractArray(
    await callTool('list_issue_wireframes', { issueId }, session),
    ['wireframes', 'items', 'results']
  );
  if (wireframes === null) return null; // infra/shape failure ⇒ fail-open

  // Short-circuit: no linked wireframe ⇒ the gate can never block. Skip the
  // two remaining lookups so non-UI Review-transitions pay one call, not three
  // (also keeps the total well inside the hooks.json 20s budget).
  if (wireframes.length === 0) {
    return { hasLinkedWireframe: false, hasUiUxReviewEntry: false, hasResultAttachments: false };
  }

  // NOTE: both lists are read as a single page. An entry/attachment beyond the
  // first page is missed, which errs on the BLOCK side for extreme timelines;
  // acceptable for now because the marker-entry and result-* attachments are
  // written late in the flow (most-recent), and the operator can always re-run
  // after adding the missing evidence. Tracked as a known limitation.
  const entries = extractArray(
    await callTool('list_discussion_entries', { issueId }, session),
    ['entries', 'items', 'discussionEntries', 'results']
  );
  const attachments = extractArray(
    await callTool('list_issue_attachments', { issueId }, session),
    ['attachments', 'items', 'results']
  );

  // Any list we could not resolve to an array is an infra/shape failure for
  // that signal — treated as fail-open by the caller (null propagates).
  if (entries === null || attachments === null) return null;

  return {
    hasLinkedWireframe: true,
    hasUiUxReviewEntry: entries.some(isUiUxReviewEntry),
    hasResultAttachments: hasResultAttachment(attachments),
  };
}

async function main() {
  const raw = await readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch (_) {
    return allow(); // no/garbage payload ⇒ don't interfere
  }
  if (!event || !isUpdateIssueStatus(event.tool_name)) return allow();

  const input = event.tool_input || {};
  if (!targetsReview(input)) return allow(); // only the InProgress → Review hop is gated

  const issueId = input.issueId || input.issue_id;
  if (!issueId) return allow(); // can't resolve ⇒ fail-open

  if (!API_KEY) return allow(); // not configured ⇒ fail-open

  let evidence;
  try {
    evidence = await gatherEvidence(issueId);
  } catch (_) {
    return allow(); // any infra failure ⇒ fail-open
  }
  if (!evidence) return allow(); // unresolvable payload shape ⇒ fail-open

  if (shouldBlock(evidence)) {
    return block(
      `UI-gate (KBT-F627 / KBT-RL200): issue ${issueId} heeft een gepind wireframe ` +
        `(list_issue_wireframes) maar geen bewijs van wireframe-getrouwheid. ` +
        `Herstel vóór de Review-transitie: (1) voer de UI-UX conformiteitsreview uit en leg die ` +
        `vast als discussion-entry die begint met "${UI_UX_REVIEW_MARKER}" ` +
        `(element-voor-element tegen het UI-contract, lane-shared/ui-contract.md), en/of ` +
        `(2) attach de resultaat-screenshots via add_issue_attachment ` +
        `(kanbantic-issue-execute Step 6e, result-<versie>-<pagina>-<state>.png).`
    );
  }
  return allow();
}

// Only run the hook when executed directly (`node …ui-gate.js`). When the
// module is `require`d (e.g. by the unit-test to exercise the pure helpers)
// `main()` must NOT fire — it would read the test-runner's stdin and hang.
if (require.main === module) {
  main().catch(() => allow());
}

// Exported for unit-testing the pure helpers without spawning a process.
module.exports = {
  isUpdateIssueStatus,
  targetsReview,
  shouldBlock,
  unwrapToolResult,
  extractArray,
  isUiUxReviewEntry,
  hasResultAttachment,
  UI_UX_REVIEW_MARKER,
};
