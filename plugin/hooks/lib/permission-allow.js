'use strict';

//
// permission-allow.js — KBT-F741 / KBT-T5189 (spec KBT-SR638, SEC063 §2)
//
// The allow-list a workspace keeps in its Toolkit (Custom item, tag
// `permission-allow`): parsing, validation and matching. Used by the
// SessionStart sync (parse + validate + cache) and by the PermissionRequest
// router (re-validate + match). Pure — no I/O, no network — so both sides, and
// the tests, run the very same code.
//
// ── Rule format ────────────────────────────────────────────────────────────
// A subset of Claude Code's `permissions.allow` notation, one rule per line in
// a fenced code block whose info string is `allow`:
//
//   ```allow
//   # comment
//   mcp__kanbantic__*                       tool-name glob (MCP tools only)
//   Bash(git status*)                       prefix match on the trimmed command
//   Bash(git log -1)                        exact match when no trailing *
//   Read(C:/GitHub/**)                      glob on file_path/filePath
//   Edit|Write|Glob|Grep(<glob>)            same, other path tools
//   WebFetch(domain:docs.anthropic.com)     host of tool_input.url (or *.example.com)
//   ```
//
// Everything outside an `allow` block is prose and ignored.
//
// ── What can never be allowed (SEC063 §2) ──────────────────────────────────
// Rejected as a RULE, and refused as a COMMAND even when a broader rule would
// match it (`Bash(git push*)` does not allow `git push --force`):
//   rm with a recursive flag, Remove-Item … -Recurse, rmdir/rd /s, del /s,
//   git push --force / -f / --force-with-lease / +refspec, git reset --hard,
//   git clean -f…, `DROP ` and `TRUNCATE `.
// Also rejected as a rule: Bash(*) / bare Bash, bare path tools, and path globs
// on the root (`/**`, `C:/**`, `*:/**`, `**/x`).
// A local-memory path (memory-path.js) never gets allow, under any rule.
//
// ── Deliberate extras beyond the spec (all err towards "ask the human") ────
// - A Bash prefix rule never matches a compound command (`;` `&` `|` backtick
//   `$(` `<` `>` newline): `Bash(git *)` must not authorise `git x && curl … | sh`.
// - Paths are normalised (`..` collapsed) before matching; an escape from the
//   allowed tree does not match.
// - Glob/Grep patterns that are absolute or contain `..` do not match.
//
// A failed match is never an error and never a deny: the router simply leaves
// the decision to the user.
//

const path = require('node:path');
const { isLocalMemoryPath, normalizePath: normalizeMemoryPath, PROJECT_MEMORY_DIR } = require('../../scripts/memory-path.js');

const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep']);

// ── forbidden command patterns ──────────────────────────────────────────────

const SEG = '[^;&|\\n]*'; // stay inside one shell segment

const FORBIDDEN = [
  ['rm with a recursive flag', new RegExp(`\\brm\\b${SEG}\\s(?:-[a-z]*r[a-z]*|--recursive)(?=[\\s*]|$)`, 'i')],
  ['Remove-Item -Recurse', new RegExp(`remove-item\\b${SEG}-recurse`, 'i')],
  ['rmdir/rd /s', new RegExp(`\\b(?:rmdir|rd)\\b${SEG}\\s/s\\b`, 'i')],
  ['del /s', new RegExp(`\\bdel\\b${SEG}\\s/s\\b`, 'i')],
  ['git push --force', new RegExp(
    `\\bgit\\b${SEG}\\bpush\\b${SEG}(?:\\s-[a-z]*f[a-z]*(?=[\\s*]|$)|\\s--force(?:-with-lease)?(?=[\\s=*]|$)|\\s\\+\\S)`, 'i')],
  ['git reset --hard', new RegExp(`\\bgit\\b${SEG}\\breset\\b${SEG}--hard`, 'i')],
  ['git clean -f', new RegExp(`\\bgit\\b${SEG}\\bclean\\b${SEG}\\s-[a-z]*f`, 'i')],
  ['DROP / TRUNCATE', /\b(?:drop|truncate)\s/i],
];

/** Name of the forbidden pattern a command (or rule specifier) hits, or null. */
function forbiddenPattern(text) {
  if (typeof text !== 'string') return null;
  for (const [name, re] of FORBIDDEN) if (re.test(text)) return name;
  return null;
}

const isForbiddenCommand = (text) => forbiddenPattern(text) !== null;

/** Shell constructs that chain or redirect: a prefix rule must not cover them. */
const COMPOUND_RE = /[;&|`<>\n\r]|\$\(|\$\{/;

// ── paths and globs ─────────────────────────────────────────────────────────

/** Backslashes → `/`, repeated `/` collapsed (a leading `//` UNC prefix is kept). */
function slashPath(p) {
  const s = String(p).trim().replace(/\\/g, '/');
  return s.startsWith('//') ? `//${s.slice(2).replace(/\/{2,}/g, '/')}` : s.replace(/\/{2,}/g, '/');
}

const isAbsolutePath = (p) => /^(?:[a-z]:)?\//i.test(p);

/** Absolute, `..`-collapsed, forward-slash path; null when it escapes the root. */
function resolveInputPath(raw, cwd) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let p = slashPath(raw);
  if (!isAbsolutePath(p)) {
    if (typeof cwd !== 'string' || !cwd) return null;
    p = `${slashPath(cwd).replace(/\/$/, '')}/${p}`;
  }
  const drive = /^[a-z]:/i.test(p) ? p.slice(0, 2) : '';
  const rest = path.posix.normalize(p.slice(drive.length));
  if (/(^|\/)\.\.(\/|$)/.test(rest)) return null;
  return drive + rest;
}

/** True when the literal part before the first wildcard is a filesystem root. */
function isRootGlob(glob) {
  const star = glob.indexOf('*');
  if (star === -1) return false;
  return /^(?:[a-z*]:)?\/*$/i.test(glob.slice(0, star)) || /^~\/*$/.test(glob.slice(0, star));
}

/** `**` crosses directories, `*` and `?` do not. `x/**` also matches `x` itself. */
function globToRegExp(glob, caseInsensitive) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else if (re.endsWith('/')) { re = `${re.slice(0, -1)}(?:/.*)?`; i += 1; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

// ── rule validation ─────────────────────────────────────────────────────────

const RULE_SHAPE = /^([A-Za-z_][\w.*-]*)(?:\(([\s\S]*)\))?$/;
const HOST_RE = /^(?:\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

const reject = (reason) => ({ ok: false, reason });

/**
 * Validate one rule line.
 * @returns {{ok:true, rule:string, parsed:object}|{ok:false, reason:string}}
 */
function validateRule(raw, { caseInsensitive = process.platform === 'win32' } = {}) {
  if (typeof raw !== 'string') return reject('not a string');
  const rule = raw.trim();
  const m = RULE_SHAPE.exec(rule);
  if (!m) return reject('not a rule: expected Tool or Tool(specifier)');
  const tool = m[1];
  const spec = m[2];

  if (tool === 'Bash') {
    if (spec === undefined || !spec.trim()) return reject('bare Bash would allow every command');
    let s = spec.trim().replace(/:\*$/, '*'); // legacy `Bash(git status:*)`
    if (/^\*+$/.test(s)) return reject('Bash(*) would allow every command');
    const hit = forbiddenPattern(s);
    if (hit) return reject(`forbidden pattern: ${hit}`);
    const stars = (s.match(/\*/g) || []).length;
    if (stars > 1 || (stars === 1 && !s.endsWith('*'))) return reject('only a single trailing * is supported for Bash');
    const exact = stars === 0;
    const prefix = exact ? s : s.slice(0, -1);
    if (!prefix.trim()) return reject('empty Bash prefix');
    return { ok: true, rule, parsed: { kind: 'bash', prefix, exact } };
  }

  if (PATH_TOOLS.has(tool)) {
    if (spec === undefined || !spec.trim()) return reject(`bare ${tool} would allow every path`);
    const glob = slashPath(spec);
    if (/(^|\/)\.\.(\/|$)/.test(glob)) return reject('path glob must not contain ..');
    if (isRootGlob(glob)) return reject('path glob on the filesystem root');
    return { ok: true, rule, parsed: { kind: 'path', tool, glob, re: globToRegExp(glob, caseInsensitive) } };
  }

  if (tool === 'WebFetch') {
    const dm = spec === undefined ? null : /^domain:\s*(\S+)$/i.exec(spec.trim());
    if (!dm || !HOST_RE.test(dm[1])) return reject('WebFetch needs (domain:<host>)');
    return { ok: true, rule, parsed: { kind: 'domain', host: dm[1].toLowerCase() } };
  }

  if (spec === undefined && tool.startsWith('mcp__')) {
    const server = tool.slice(5).split('__')[0];
    if (!server || server.includes('*')) return reject('MCP rule must name its server (mcp__<server>__…)');
    const re = new RegExp(`^${tool.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return { ok: true, rule, parsed: { kind: 'tool', re } };
  }

  return reject('unsupported rule form');
}

// ── parsing the Toolkit item ────────────────────────────────────────────────

/**
 * Pull the rules out of a Toolkit item body. Only fenced blocks whose info
 * string is exactly `allow` count; `#` comments and blank lines are skipped;
 * every other line is validated.
 * @returns {{rules:string[], rejected:{rule:string, reason:string}[]}}
 */
function parseAllowBlock(markdown) {
  const rules = [];
  const rejected = [];
  if (typeof markdown !== 'string') return { rules, rejected };
  let fence = null; // { ch, len } while inside an allow block
  let other = null; // fence of a non-allow block (its closing line must not open anything)
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) { fence = null; continue; }
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const v = validateRule(t);
      if (v.ok) rules.push(v.rule);
      else rejected.push({ rule: t, reason: v.reason });
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
    if (other) {
      if (open && !open[2] && open[1][0] === other.ch && open[1].length >= other.len) other = null;
      continue;
    }
    if (!open) continue;
    if (open[2] === 'allow') fence = { ch: open[1][0], len: open[1].length };
    else other = { ch: open[1][0], len: open[1].length };
  }
  return { rules, rejected };
}

// ── matching ────────────────────────────────────────────────────────────────

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** Every path-like field of a tool_input (for the memory veto). */
function pathFields(input) {
  return ['file_path', 'filePath', 'path', 'notebook_path']
    .map((k) => input[k])
    .filter((v) => typeof v === 'string' && v);
}

const MEMORY_MD_IN_COMMAND = /(^|[\s"'/\\])memory\.md(?=$|[\s"'])/i;

/** Would this call touch local memory? Then it never gets allow. */
function touchesLocalMemory(toolName, input) {
  if (pathFields(input).some((p) => isLocalMemoryPath(p))) return true;
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return PROJECT_MEMORY_DIR.test(normalizeMemoryPath(input.command)) || MEMORY_MD_IN_COMMAND.test(input.command);
  }
  return false;
}

function inputPath(toolName, input, cwd) {
  const raw = input.file_path || input.filePath || (toolName === 'Glob' || toolName === 'Grep' ? input.path || cwd : null);
  return resolveInputPath(raw, cwd);
}

function matches(parsed, toolName, input, cwd) {
  switch (parsed.kind) {
    case 'tool':
      return parsed.re.test(toolName);
    case 'bash': {
      if (toolName !== 'Bash' || typeof input.command !== 'string') return false;
      const cmd = input.command.trim();
      if (!cmd || COMPOUND_RE.test(cmd)) return false;
      return parsed.exact ? cmd === parsed.prefix.trim() : cmd.startsWith(parsed.prefix);
    }
    case 'path': {
      if (toolName !== parsed.tool) return false;
      if (toolName === 'Glob' && typeof input.pattern === 'string' &&
          (isAbsolutePath(slashPath(input.pattern)) || /(^|[\\/])\.\.([\\/]|$)/.test(input.pattern))) return false;
      const p = inputPath(toolName, input, cwd);
      return p !== null && parsed.re.test(p);
    }
    case 'domain': {
      if (toolName !== 'WebFetch' || typeof input.url !== 'string') return false;
      let host;
      try { host = new URL(input.url).hostname.toLowerCase(); } catch (_) { return false; }
      return host === parsed.host || (parsed.host.startsWith('*.') && host.endsWith(parsed.host.slice(1)));
    }
    default:
      return false;
  }
}

/**
 * Decide a PermissionRequest against an allow-list.
 * Re-validates every rule: a forbidden rule in the cache counts as absent.
 * @returns {{allow:true, rule:string}|{allow:false, reason:string}}
 */
function decide(rules, payload, { caseInsensitive = process.platform === 'win32' } = {}) {
  const toolName = payload && payload.tool_name;
  if (typeof toolName !== 'string' || !toolName) return { allow: false, reason: 'no tool_name' };
  const input = asObject(payload.tool_input);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

  if (touchesLocalMemory(toolName, input)) return { allow: false, reason: 'local memory path is never auto-allowed' };
  if (toolName === 'Bash' && isForbiddenCommand(input.command)) {
    return { allow: false, reason: `forbidden command pattern: ${forbiddenPattern(input.command)}` };
  }
  for (const raw of Array.isArray(rules) ? rules : []) {
    const v = validateRule(raw, { caseInsensitive });
    if (v.ok && matches(v.parsed, toolName, input, cwd)) return { allow: true, rule: v.rule };
  }
  return { allow: false, reason: 'no rule matched' };
}

module.exports = {
  parseAllowBlock,
  validateRule,
  decide,
  isForbiddenCommand,
  forbiddenPattern,
  globToRegExp,
  resolveInputPath,
};
