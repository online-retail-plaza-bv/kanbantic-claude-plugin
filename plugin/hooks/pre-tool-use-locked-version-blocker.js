#!/usr/bin/env node
'use strict';

//
// pre-tool-use-locked-version-blocker — KBT-F320 / KBT-T2421 / KBT-TC2362
//
// A PreToolUse hook that intercepts `claim_issue` and BLOCKS it when the
// issue's delivered-in Version is locked-on-deploy (lifecycleStatus is at or
// past `StagingDeployed`). Once a Version has shipped to staging it is frozen
// for that release-train; claiming new work against it would silently scope-
// creep a locked Version (KBT-F458 lock-on-deploy semantics).
//
// Contract (Claude Code PreToolUse):
//   stdin  — JSON { tool_name, tool_input, ... }.
//   block  — write a structured `permissionDecision: "deny"` object to stdout,
//            the human-readable reason to stderr, and exit 2 (canonical block).
//   allow  — exit 0 silently.
//
// The hook is FAIL-OPEN: any infrastructure problem (no API key, network
// error, unparseable response, missing version link) results in `allow`. A
// hook must never wedge a session shut on its own malfunction — it only ever
// blocks on a positive, confirmed "this Version is locked" signal.
//
// Version resolution uses the live `issue_version_lookup` MCP tool (KBT-F463),
// which returns each linked Version's `lifecycleStatus` + `relation`.
//
// Config (env):
//   KANBANTIC_MCP_URL  — default https://kanbantic.com/mcp
//   KANBANTIC_API_KEY  — required to perform the lookup; absent ⇒ fail-open.
//
// Zero deps — Node built-ins only.
//

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const MCP_URL = process.env.KANBANTIC_MCP_URL || 'https://kanbantic.com/mcp';
const API_KEY = process.env.KANBANTIC_API_KEY;

// Version lifecycle order. Lock-on-deploy: everything at-or-past StagingDeployed
// is locked (KBT-F458: freeze Planned|InProgress→Frozen; release
// Frozen|StagingDeployed→Released). StagingDeployed is the lock threshold.
const LIFECYCLE_ORDER = [
  'Planned',
  'InProgress',
  'Frozen',
  'StagingDeployed',
  'ProductionDeployed',
  'Released',
  'Archived',
];
const LOCK_AT = 'StagingDeployed';

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

function isClaimIssue(toolName) {
  // Matches both `mcp__kanbantic__claim_issue` and the fully-qualified
  // `mcp__plugin_<...>__claim_issue` proxy form, and a bare `claim_issue`.
  return typeof toolName === 'string' && /(^|_)claim_issue$/.test(toolName);
}

function lockThresholdIndex() {
  return LIFECYCLE_ORDER.indexOf(LOCK_AT);
}

function isLockedStatus(status) {
  const idx = LIFECYCLE_ORDER.indexOf(status);
  if (idx === -1) return false; // unknown status ⇒ fail-open
  return idx >= lockThresholdIndex();
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
    req.setTimeout(15_000, () => req.destroy(new Error('Request timeout')));
    req.write(JSON.stringify(body));
    req.end();
  });
}

// Unwrap an MCP tools/call result: the tool's JSON payload is carried as a
// text content-block. Returns the parsed object, or null.
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
  // Some transports forward the object directly.
  if (typeof result === 'object' && (result.versions || result.success !== undefined)) {
    return result;
  }
  return null;
}

async function resolveDeliveredVersion(issueId) {
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'locked-version-blocker', version: '1.0.0' },
    },
  });
  const lookup = await post(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'issue_version_lookup', arguments: { issueId } },
    },
    init.sessionId
  );
  const payload = unwrapToolResult(lookup.body);
  if (!payload || !Array.isArray(payload.versions) || payload.versions.length === 0) {
    return null;
  }
  // The Version the issue is *delivered in* is the one a claim would extend.
  return (
    payload.versions.find((v) => v && v.relation === 'DeliveredIn') ||
    payload.versions[0]
  );
}

async function main() {
  const raw = await readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch (_) {
    return allow(); // no/garbage payload ⇒ don't interfere
  }
  if (!event || !isClaimIssue(event.tool_name)) return allow();

  const input = event.tool_input || {};
  const issueId = input.issueId || input.issue_id;
  if (!issueId) return allow(); // can't resolve ⇒ fail-open

  if (!API_KEY) return allow(); // not configured ⇒ fail-open

  let version;
  try {
    version = await resolveDeliveredVersion(issueId);
  } catch (_) {
    return allow(); // any infra failure ⇒ fail-open
  }
  if (!version || !version.lifecycleStatus) return allow();

  if (isLockedStatus(version.lifecycleStatus)) {
    const name = version.name || version.versionName || '(unknown)';
    return block(
      `Locked Version ${name} (status ${version.lifecycleStatus}); ` +
        `klaim niet toegestaan na lock-on-deploy`
    );
  }
  return allow();
}

// Only run the hook when executed directly (`node …blocker.js`). When the
// module is `require`d (e.g. by the unit-test to exercise the pure helpers)
// `main()` must NOT fire — it would read the test-runner's stdin and hang.
if (require.main === module) {
  main().catch(() => allow());
}

// Exported for unit-testing the pure helpers without spawning a process.
module.exports = {
  isClaimIssue,
  isLockedStatus,
  unwrapToolResult,
  LIFECYCLE_ORDER,
  LOCK_AT,
};
