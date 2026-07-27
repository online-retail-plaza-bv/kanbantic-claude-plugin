#!/usr/bin/env node
// KBT-F517 / KBT-E099 — context-free wireframe file edit (replace/add or delete ONE
// file → a new immutable version).
//
// Fetches the current latest fileset from the server, applies exactly ONE change
// locally (replace/add a single file, or delete a single file), and POSTs the
// modified fileset as a NEW version. Versions are immutable (KBT-BD163): editing a
// file never mutates an existing version — it creates the next one. The bytes flow
// server -> this script -> server; they never enter an agent's model context
// (KBT-RL161), and the script prints only a one-line summary.
//
// Text files (.html/.css/.js/.mjs/.json/.map/.svg/.txt) are sent as-is; every other
// extension is base64-encoded — matching the server (WireframeContentCodec.IsBinary /
// WireframePathPolicy) so binary round-trips byte-exact (KBT-SR526). The fetched
// fileset already carries text as raw and binary as base64, so untouched files are
// re-posted verbatim; only the replaced file is (re-)encoded from local disk.
//
// Usage:
//   Replace (or add) one file:
//     node wireframe-edit.mjs --wireframe <id> --replace <fileset-path> --file <local-file> \
//       [--summary "..."] --api <baseUrl> --token <token> [--bearer]
//   Delete one file:
//     node wireframe-edit.mjs --wireframe <id> --delete <fileset-path> \
//       [--summary "..."] --api <baseUrl> --token <token> [--bearer]
//
// Auth/base-url may also come from env: KANBANTIC_API_BASE, KANBANTIC_API_TOKEN.
// The token is an agent API key (X-Api-Key) or a user JWT (Bearer, via --bearer).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in lock-step with the server's text set + wireframe-upload.mjs.
const TEXT_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.svg', '.txt']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'bearer') { args[key] = true; continue; }
    args[key] = argv[++i];
  }
  return args;
}

// POSIX-normalise a fileset path (mirror the server's normalisation intent).
export function normalizeFilesetPath(p) {
  return String(p).split('\\').join('/').replace(/^\/+/, '');
}

// Encode a local file for upload: text as-is (UTF-8), everything else base64.
export function encodeLocalFile(localPath, buf) {
  const ext = path.extname(localPath).toLowerCase();
  return TEXT_EXTS.has(ext) ? buf.toString('utf8') : buf.toString('base64');
}

// Pure fileset transform — exported so tests can exercise the replace/add/delete
// logic without a live server. Returns { files, summary }.
export function applyEdit({ files, entryPointPath, op, targetPath, newContent, summary }) {
  const target = normalizeFilesetPath(targetPath);
  if (op === 'replace') {
    const existing = files.find(f => f.path === target);
    if (existing) {
      const next = files.map(f => (f.path === target ? { path: f.path, content: newContent } : f));
      return { files: next, summary: summary || `Replace ${target}` };
    }
    return { files: [...files, { path: target, content: newContent }], summary: summary || `Add ${target}` };
  }
  if (op === 'delete') {
    if (target === normalizeFilesetPath(entryPointPath)) {
      throw new Error(`Cannot delete the entry-point '${entryPointPath}'. Change the entry-point first.`);
    }
    if (!files.some(f => f.path === target)) {
      throw new Error(`File '${target}' not found in the current version (${files.length} files).`);
    }
    const next = files.filter(f => f.path !== target);
    if (next.length === 0) {
      throw new Error('Refusing to create an empty fileset. Delete the whole wireframe instead.');
    }
    return { files: next, summary: summary || `Delete ${target}` };
  }
  throw new Error(`Unknown op '${op}'`);
}

function authHeaders(token, bearer) {
  const h = { 'Content-Type': 'application/json' };
  h[bearer ? 'Authorization' : 'X-Api-Key'] = bearer ? `Bearer ${token}` : token;
  return h;
}

async function getJson(url, token, bearer) {
  const res = await fetch(url, { headers: authHeaders(token, bearer) });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function postJson(url, token, bearer, body) {
  const res = await fetch(url, { method: 'POST', headers: authHeaders(token, bearer), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiBase = (args.api || process.env.KANBANTIC_API_BASE || '').replace(/\/+$/, '');
  const token = args.token || process.env.KANBANTIC_API_TOKEN;
  const bearer = !!args.bearer;
  const id = args.wireframe;

  if (!id) throw new Error('Missing --wireframe <id>');
  if (!apiBase) throw new Error('Missing --api <baseUrl> (or KANBANTIC_API_BASE)');
  if (!token) throw new Error('Missing --token <token> (or KANBANTIC_API_TOKEN)');

  const isReplace = args.replace != null;
  const isDelete = args.delete != null;
  if (isReplace === isDelete) {
    throw new Error('Provide exactly one of: --replace <path> --file <local>  OR  --delete <path>');
  }

  // 1. Fetch current latest version fileset (server -> script; never into model context).
  const wf = await getJson(`${apiBase}/api/app/wireframe/${id}`, token, bearer);
  const latest = wf.latestVersionNumber;
  if (!latest) throw new Error(`Wireframe ${id} has no versions to edit.`);
  const cur = await getJson(`${apiBase}/api/app/wireframe/${id}/version/${latest}`, token, bearer);
  const files = (cur.files || []).map(f => ({ path: f.path, content: f.content }));
  const entry = cur.entryPointPath || 'index.html';

  // 2. Apply exactly one change locally.
  let newContent;
  if (isReplace) {
    if (!args.file) throw new Error('--replace requires --file <local-file>');
    const buf = await fs.readFile(args.file);
    newContent = encodeLocalFile(args.file, buf);
  }
  const { files: newFiles, summary } = applyEdit({
    files,
    entryPointPath: entry,
    op: isReplace ? 'replace' : 'delete',
    targetPath: isReplace ? args.replace : args.delete,
    newContent,
    summary: args.summary,
  });

  console.error(`[wireframe-edit] base v${latest} (${files.length} files) -> new version (${newFiles.length} files), entry=${entry}`);

  // 3. POST the modified fileset as a new immutable version.
  const result = await postJson(`${apiBase}/api/app/wireframe/${id}/version/files`, token, bearer, {
    files: newFiles,
    entryPointPath: entry,
    changesSummary: summary,
  });
  console.log(JSON.stringify({
    ok: true,
    wireframeId: id,
    versionNumber: result.versionNumber,
    fileCount: newFiles.length,
  }));
}

// Only run when invoked directly (so tests can import the pure helpers).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch(err => { console.error(`[wireframe-edit] ERROR: ${err.message}`); process.exit(1); });
}
