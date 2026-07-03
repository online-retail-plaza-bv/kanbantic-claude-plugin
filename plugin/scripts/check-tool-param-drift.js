#!/usr/bin/env node
'use strict';

//
// check-tool-param-drift — KBT-B392 / KBT-TC2940
//
// Queries a Kanbantic MCP server's `tools/list` and exits non-zero if a
// tool's REQUIRED-PARAMETER contract has drifted — i.e. a parameter the
// plugin's docs/wrappers depend on is no longer marked `required` in the
// live tool's `inputSchema.required`.
//
// This is the PARAMETER-level complement to `check-bundle-tool-drift.js`
// (KBT-B200), which only checks tool *names*. Neither `known-mcp-tools.json`
// (a name-only allow-list) nor `lint-skills.js` Invariant 3 (name resolution)
// can catch a signature change — a tool that silently drops a required param
// still "resolves" by name. That gap is exactly what KBT-B392 was filed for:
// `create_version` gained a mandatory `applicationId` (PR #242) and nothing
// in the bundle validated it.
//
// The contract lives in REQUIRED_PARAMS below. Extend it whenever a tool's
// required-parameter set is something the plugin docs/wrappers rely on.
//
// Usage:
//   KANBANTIC_API_KEY=... node plugin/scripts/check-tool-param-drift.js
//   KANBANTIC_API_KEY=... KANBANTIC_MCP_URL=https://kanbantic.com/mcp \
//     node plugin/scripts/check-tool-param-drift.js
//
// Exit codes (mirror check-bundle-tool-drift.js):
//   0 — every contract tool present with all its required params.
//   1 — drift: a contract tool is missing, or a required param is absent
//       from its live `inputSchema.required`.
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

// Required-parameter contract: tool-name → params that MUST be in the live
// tool's inputSchema.required. KBT-B392: create_version is app-scoped, so
// applicationId is mandatory (PR #242).
const REQUIRED_PARAMS = {
  create_version: ['applicationId'], // KBT-B392 / PR #242 — app-scoped Versions
};

function fatal(code, msg) {
  process.stderr.write(`check-tool-param-drift: ${msg}\n`);
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
        clientInfo: { name: 'check-tool-param-drift', version: '1.0.0' },
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

    const byName = new Map(tools.map((t) => [t && t.name, t]).filter(([n]) => n));
    const drift = [];

    for (const [toolName, requiredParams] of Object.entries(REQUIRED_PARAMS)) {
      const tool = byName.get(toolName);
      if (!tool) {
        drift.push(`tool \`${toolName}\` is not exposed by the live registry`);
        continue;
      }
      const required = (tool.inputSchema && Array.isArray(tool.inputSchema.required))
        ? tool.inputSchema.required
        : [];
      for (const param of requiredParams) {
        if (!required.includes(param)) {
          drift.push(
            `tool \`${toolName}\` no longer marks \`${param}\` as required ` +
              `(inputSchema.required = [${required.join(', ')}])`
          );
        }
      }
    }

    if (drift.length > 0) {
      process.stderr.write(
        `check-tool-param-drift: DRIFT — required-parameter contract violated:\n` +
          drift.map((d) => `  - ${d}`).join('\n') + '\n' +
          `MCP_URL=${MCP_URL}, total tools exposed: ${tools.length}\n`
      );
      process.exit(1);
    }

    const contractCount = Object.keys(REQUIRED_PARAMS).length;
    process.stdout.write(
      `OK: required-parameter contract satisfied ` +
        `(${contractCount} tool(s) checked, ${tools.length} total exposed at ${MCP_URL})\n`
    );
    process.exit(0);
  } catch (e) {
    fatal(e.code || 2, e.message);
  }
}

main();
