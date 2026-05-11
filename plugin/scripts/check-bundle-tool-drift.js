#!/usr/bin/env node
'use strict';

//
// check-bundle-tool-drift — KBT-B200 / KBT-SR298 / KBT-TC1856
//
// Queries a Kanbantic MCP server's `tools/list` and exits non-zero if a
// MUST-HAVE tool is missing. This is the "drift detector" the bug's
// "Suggestie voor preventie" section explicitly recommends — a check that
// surfaces bundle ↔ live registry drift before it costs an agent another
// stuck-on-Review incident (the original 2026-05-02 ADM-E008 case).
//
// Usage:
//   KANBANTIC_API_KEY=... node plugin/scripts/check-bundle-tool-drift.js
//   KANBANTIC_API_KEY=... KANBANTIC_MCP_URL=https://kanbantic.com/mcp \
//     node plugin/scripts/check-bundle-tool-drift.js
//
// Exit codes:
//   0 — all MUST-HAVE tools present.
//   1 — drift detected: one or more MUST-HAVE tools missing.
//   2 — infrastructure / auth failure (network, 401, parse error) —
//       distinguishes "I could not check" from "I checked and it drifted".
//
// Zero deps — Node built-ins only.
//

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const MCP_URL = process.env.KANBANTIC_MCP_URL || 'https://kanbantic.com/mcp';
const API_KEY = process.env.KANBANTIC_API_KEY;

// Tools that the kanbantic-issue-review skill (and other lane-flow skills)
// rely on. If the live MCP registers any of these but the bundle exposes
// none, that's the exact failure-mode KBT-B200 was filed for.
const MUST_HAVE = [
  'approve_review',     // KBT-F170 / KBT-PR191
  'start_run_review',   // KBT-F170 / KBT-PR191
  'complete_run_review' // KBT-F170 / KBT-PR191
];

function fatal(code, msg) {
  process.stderr.write(`check-bundle-tool-drift: ${msg}\n`);
  process.exit(code);
}

if (!API_KEY) {
  fatal(2, 'KANBANTIC_API_KEY is required (set it in the environment).');
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
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${API_KEY}`,
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
        if (res.statusCode === 401) {
          return reject(Object.assign(new Error('Authentication failed (401). Check KANBANTIC_API_KEY.'), { code: 2 }));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let d = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (d += c));
          res.on('end', () =>
            reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${d}`), { code: 2 }))
          );
          return;
        }
        const ct = (res.headers['content-type'] || '').toLowerCase();
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            let parsed;
            if (ct.includes('text/event-stream')) {
              // pick the first JSON message out of the SSE stream
              const m = data.match(/^data:\s*(.*)$/m);
              parsed = m ? JSON.parse(m[1]) : null;
            } else {
              parsed = JSON.parse(data);
            }
            resolve({ body: parsed, sessionId: captured });
          } catch (e) {
            reject(Object.assign(new Error(`Parse failure: ${e.message}`), { code: 2 }));
          }
        });
      }
    );
    req.on('error', (e) =>
      reject(Object.assign(new Error(`Connection failed: ${e.message}`), { code: 2 }))
    );
    req.setTimeout(60_000, () =>
      req.destroy(Object.assign(new Error('Request timeout (60s)'), { code: 2 }))
    );
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  try {
    // 1. initialize — opens an MCP session, captures Mcp-Session-Id.
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'check-bundle-tool-drift', version: '1.0.0' },
      },
    });

    if (!init.body || !init.body.result) {
      fatal(2, `initialize returned no result: ${JSON.stringify(init.body)}`);
    }

    // 2. tools/list — with the captured session-id.
    const list = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      init.sessionId
    );

    const tools = (list.body && list.body.result && list.body.result.tools) || [];
    if (!Array.isArray(tools) || tools.length === 0) {
      fatal(2, `tools/list returned empty or non-array: ${JSON.stringify(list.body)}`);
    }
    const names = new Set(tools.map((t) => t && t.name).filter(Boolean));
    const missing = MUST_HAVE.filter((n) => !names.has(n));

    if (missing.length > 0) {
      process.stderr.write(
        `check-bundle-tool-drift: DRIFT — missing tools: ${missing.join(', ')}\n` +
          `MCP_URL=${MCP_URL}, total tools exposed: ${tools.length}\n` +
          `MUST_HAVE: [${MUST_HAVE.join(', ')}]\n` +
          `present: [${[...names].sort().join(', ')}]\n`
      );
      process.exit(1);
    }

    process.stdout.write(
      `OK: all MUST-HAVE tools present ` +
        `(${MUST_HAVE.length} required, ${tools.length} total exposed at ${MCP_URL})\n`
    );
    process.exit(0);
  } catch (e) {
    fatal(e.code || 2, e.message);
  }
}

main();
