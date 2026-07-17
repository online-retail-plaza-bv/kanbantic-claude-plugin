#!/usr/bin/env node
// KBT-F516 / KBT-E099 — universal, context-free wireframe fileset uploader.
//
// Reads a folder locally and POSTs it to the Kanbantic REST API as ONE wireframe
// version (a fileset). The file bytes flow folder -> this script -> server; they
// never pass through an agent's model context or a tool-call payload. Works from
// both Claude Code and Cowork (both can run node + fetch), and uses the REST API
// directly so it sidesteps the MCP tools/call size limit (KBT-B417).
//
// Text files (.html/.css/.js/.mjs/.json/.map/.svg/.txt) are sent as-is (UTF-8);
// every other extension is treated as binary and base64-encoded — matching the
// server's content-type derivation (WireframePathPolicy.DeriveContentType) +
// WireframeContentCodec.IsBinary, so the server decodes it back byte-exact
// (KBT-SR526). base64 is NOT applied to text (that would be pure inflation —
// KBT-RL161).
//
// Usage:
//   Create a new wireframe (version 1 = the fileset):
//     node wireframe-upload.mjs --dir <folder> --create \
//       --app <applicationId> --name "<name>" [--description "<desc>"] \
//       [--entry index.html] --api <baseUrl> --token <token>
//
//   Add a new version to an existing wireframe:
//     node wireframe-upload.mjs --dir <folder> --wireframe <wireframeId> \
//       [--entry index.html] [--summary "<changes>"] --api <baseUrl> --token <token>
//
// Auth/base-url may also come from env: KANBANTIC_API_BASE, KANBANTIC_API_TOKEN.
// The token is an agent API key (X-Api-Key) or a user JWT (Bearer, via --bearer).

import { promises as fs } from 'node:fs';
import path from 'node:path';

// Extensions whose content is stored as text (server IsBinary == false). Everything
// else is treated as binary and base64-encoded. Keep in lock-step with the server's
// WireframePathPolicy.DeriveContentType text set.
const TEXT_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.svg', '.txt']);
const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const flags = new Set(['create', 'bearer']);
    if (flags.has(key)) { args[key] = true; continue; }
    args[key] = argv[++i];
  }
  return args;
}

async function collectFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_NAMES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(rootDir, full).split(path.sep).join('/'); // POSIX
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT_EXTS.has(ext)) {
        out.push({ path: rel, content: await fs.readFile(full, 'utf8') });
      } else {
        const buf = await fs.readFile(full);
        out.push({ path: rel, content: buf.toString('base64') });
      }
    }
  }
  await walk(rootDir);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function post(url, token, bearer, body) {
  const headers = { 'Content-Type': 'application/json' };
  headers[bearer ? 'Authorization' : 'X-Api-Key'] = bearer ? `Bearer ${token}` : token;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return json ?? {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir;
  const apiBase = (args.api || process.env.KANBANTIC_API_BASE || '').replace(/\/+$/, '');
  const token = args.token || process.env.KANBANTIC_API_TOKEN;
  const bearer = !!args.bearer;
  const entry = args.entry || 'index.html';

  if (!dir) throw new Error('Missing --dir <folder>');
  if (!apiBase) throw new Error('Missing --api <baseUrl> (or KANBANTIC_API_BASE)');
  if (!token) throw new Error('Missing --token <token> (or KANBANTIC_API_TOKEN)');

  const stat = await fs.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`--dir is not a directory: ${dir}`);

  const files = await collectFiles(dir);
  if (files.length === 0) throw new Error(`No files found under ${dir}`);
  if (!files.some(f => f.path.toLowerCase() === entry.toLowerCase())) {
    throw new Error(`Entry-point '${entry}' not found among the ${files.length} files. Pass --entry <path>.`);
  }

  const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0);
  // Summary only — never dump file contents to stdout (keeps agent context clean).
  console.error(`[wireframe-upload] ${files.length} files, ~${Math.round(totalBytes / 1024)} KB payload, entry=${entry}`);

  let result;
  if (args.create) {
    if (!args.app || !args.name) throw new Error('--create requires --app <applicationId> and --name "<name>"');
    result = await post(`${apiBase}/api/app/wireframe`, token, bearer, {
      applicationId: args.app,
      name: args.name,
      description: args.description ?? null,
      files,
      entryPointPath: entry,
    });
  } else if (args.wireframe) {
    result = await post(`${apiBase}/api/app/wireframe/${args.wireframe}/version/files`, token, bearer, {
      files,
      entryPointPath: entry,
      changesSummary: args.summary ?? null,
    });
  } else {
    throw new Error('Provide either --create (with --app/--name) or --wireframe <id>');
  }

  const id = result.id ?? result.wireframeId ?? args.wireframe;
  const version = result.latestVersionNumber ?? result.versionNumber;
  console.log(JSON.stringify({ ok: true, wireframeId: id, versionNumber: version, fileCount: files.length }));
}

main().catch(err => {
  console.error(`[wireframe-upload] ERROR: ${err.message}`);
  process.exit(1);
});
