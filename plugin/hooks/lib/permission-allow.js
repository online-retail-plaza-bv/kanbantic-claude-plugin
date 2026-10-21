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
// ── What can never be allowed (SEC063 §2, hardened in KBT-T5218) ───────────
// Rejected as a RULE, and refused as a COMMAND even when a broader rule would
// match it (`Bash(git push*)` does not allow `git push --force`):
//   rm with a recursive flag, Remove-Item … -Recurse, rmdir/rd /s, del /s,
//   git push --force / -f / --force-with-lease / +refspec, git reset --hard,
//   git clean -f…, `DROP ` and `TRUNCATE `;
//   git push -d / :<ref> (empty source = delete), git checkout/switch -f /
//   --force / --discard-changes, git branch -D, git -c <config override>,
//   and — in any command — --delete, --mirror, --upload-pack, --receive-pack,
//   --output[-dir], --exec[-path] / -exec[dir].
// Also rejected as a rule: Bash(*) / bare Bash, bare path tools, and path globs
// on the root (`/**`, `C:/**`, `*:/**`, `**/x`).
// A local-memory path (memory-path.js) never gets allow, under any rule, and
// neither does anything under a `.claude/` or `.git/` directory or a file named
// `.mcp.json` (settings, hooks, MCP config: the places a permission bypass or
// a token would be planted). `.claude/worktrees/<name>/…` is a checkout root,
// not config, and is exempt — its own `.claude/` and `.git` are not. The veto
// covers every path field, Glob patterns, Grep file globs and Bash commands
// that spell such a path.
//
// ── curl (KBT-T5218): a dedicated matcher on top of the prefix match ───────
// PO decision: curl may never send keys or data to another address. A
// `Bash(curl …)` rule therefore only allows a command that
//   - names exactly ONE URL (positional argument), which `new URL()` parses as
//     https:// without userinfo (`@`), whose host (incl. port) equals the host
//     of the rule's URL exactly; look-alikes (`staging.kanbantic.com.evil.example`)
//     and a second URL do not match;
//   - contains no shell expansion (`$`), no backslash and no curl URL globbing
//     (`{}` `[]`);
//   - uses only options from a positive list: the read-only flags
//     -s -S -i -I -f -v -g -N -4 -6 --compressed --fail-with-body
//     --no-progress-meter --http1.1 --http2 --tlsv1.2 --tlsv1.3 and the value
//     options -H/--header, -A/--user-agent, -X/--request (GET or HEAD only),
//     -m/--max-time, --connect-timeout, -w/--write-out, -e/--referer,
//     -u/--user, --retry, --retry-delay, --retry-max-time. A value may not
//     start with `@` (file reference) and a header may not set `Host:`.
//   Everything else — -d/--data*, --json, -T/--upload-file, -F/--form*,
//   -o/-O/--output*, -K/--config, --url, --resolve, --connect-to, -x/--proxy*,
//   -L/--location*, -c/--cookie-jar, -D/--dump-header, -k/--insecure and any
//   option the list does not know — leaves the decision to the human.
// The rule itself must pass the same parser (exactly one https URL with a
// host, listed options only, GET/HEAD), so a careless rule is refused at sync
// time. A non-curl rule (`Bash(cu*)`) never covers a curl command.
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
  // KBT-T5218 — destructive / code-executing git forms the reviewer reproduced
  ['git push -d / :<ref> (delete)', new RegExp(
    `\\bgit\\b${SEG}\\bpush\\b${SEG}(?:\\s-[a-z]*d[a-z]*(?=[\\s*]|$)|\\s:\\S)`, 'i')],
  ['git checkout/switch -f', new RegExp(
    `\\bgit\\b${SEG}\\b(?:checkout|switch)\\b${SEG}(?:\\s-[a-z]*f[a-z]*(?=[\\s*]|$)|\\s--(?:force|discard-changes)(?=[\\s=*]|$))`, 'i')],
  ['git branch -D', new RegExp(`\\bgit\\b${SEG}\\bbranch\\b${SEG}\\s-[a-zA-Z]*D[a-zA-Z]*(?=[\\s*]|$)`)],
  // `-c key=value` overrides any config (core.hooksPath, core.sshCommand, …).
  // Case-sensitive on purpose: `git -C <dir>` is harmless and common.
  ['git -c (config override)', new RegExp(`\\b[Gg]it\\b${SEG}\\s-c(?=\\s|$)`)],
  ['--delete', /\s--delete(?=[\s=*]|$)/i],
  ['--mirror', /\s--mirror(?=[\s=*]|$)/i],
  ['--upload-pack / --receive-pack', /\s--(?:upload|receive)-pack(?=[\s=*]|$)/i],
  ['--output', /\s--output(?:-dir)?(?=[\s=*]|$)/i],
  ['--exec / -exec', /\s--?exec(?:dir|-path)?(?=[\s=*]|$)/i],
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

// ── curl ────────────────────────────────────────────────────────────────────

const CURL_RE = /^curl(?:\.exe)?$/i;
const CURL_READ_METHODS = ['GET', 'HEAD'];

/** Options without a value that neither send data nor change the destination. */
const CURL_FLAGS = new Set([
  '-s', '--silent', '-S', '--show-error', '-i', '--include', '-I', '--head', '-f', '--fail', '--fail-with-body',
  '-v', '--verbose', '-g', '--globoff', '-N', '--no-buffer', '-4', '--ipv4', '-6', '--ipv6', '--compressed',
  '--no-progress-meter', '--http1.1', '--http2', '--tlsv1.2', '--tlsv1.3',
]);

/** Options with a value that are still read-only towards the rule host. */
const CURL_VALUE_OPTS = new Set([
  '-H', '--header', '-A', '--user-agent', '-X', '--request', '-m', '--max-time', '--connect-timeout',
  '-w', '--write-out', '-e', '--referer', '-u', '--user', '--retry', '--retry-delay', '--retry-max-time',
]);

/** Split a command into words, honouring '…' and "…"; null when a quote is left open. */
function shellWords(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === '\'') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) { out.push(cur); cur = ''; started = false; }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(cur);
  return out;
}

function curlValueError(opt, value) {
  if (value.startsWith('@')) return `@file reference in ${opt}`;
  if ((opt === '-X' || opt === '--request') && !CURL_READ_METHODS.includes(value.toUpperCase())) return `method ${value} is not read-only`;
  if ((opt === '-H' || opt === '--header') && /^\s*host\s*:/i.test(value)) return 'Host header override';
  return null;
}

/**
 * Walk a curl invocation (words[0] is curl). Every option must be on the
 * positive lists; everything else is a URL (positional).
 * @returns {{urls:string[]}|{error:string}}
 */
function parseCurl(words) {
  const urls = [];
  const fail = (error) => ({ error });
  let i = 1;
  while (i < words.length) {
    const w = words[i++];
    if (w === '--') { urls.push(...words.slice(i)); break; }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const opt = eq === -1 ? w : w.slice(0, eq);
      let value = eq === -1 ? undefined : w.slice(eq + 1);
      if (CURL_FLAGS.has(opt)) {
        if (value !== undefined) return fail(`${opt} takes no value`);
        continue;
      }
      if (!CURL_VALUE_OPTS.has(opt)) return fail(`option ${opt} is not auto-allowed`);
      if (value === undefined) {
        if (i >= words.length) return fail(`${opt} without a value`);
        value = words[i++];
      }
      const err = curlValueError(opt, value);
      if (err) return fail(err);
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      for (let j = 1; j < w.length; j++) { // bundled short options: -sS, -XGET, -H'…'
        const opt = `-${w[j]}`;
        if (CURL_FLAGS.has(opt)) continue;
        if (!CURL_VALUE_OPTS.has(opt)) return fail(`option ${opt} is not auto-allowed`);
        let value = w.slice(j + 1);
        if (!value) {
          if (i >= words.length) return fail(`${opt} without a value`);
          value = words[i++];
        }
        const err = curlValueError(opt, value);
        if (err) return fail(err);
        break;
      }
      continue;
    }
    urls.push(w);
  }
  return { urls };
}

/** The host (incl. port) of an https URL without userinfo or globbing; null otherwise. */
function curlHost(arg) {
  if (typeof arg !== 'string' || /[\\${}[\]]/.test(arg) || !/^https:\/\//i.test(arg)) return null;
  const authority = arg.slice(8).split(/[/?#]/)[0];
  if (!authority || authority.includes('@')) return null;
  let u;
  try { u = new URL(arg); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.host) return null;
  return u.host.toLowerCase();
}

/** Parse the curl part of a rule prefix. @returns {{host:string, methods:string[]}|{error:string}} */
function curlRule(prefix) {
  if (/[\\$]/.test(prefix)) return { error: 'shell expansion in a curl rule' };
  const words = shellWords(prefix);
  if (!words || !CURL_RE.test(words[0])) return { error: 'not a curl invocation' };
  const p = parseCurl(words);
  if (p.error) return { error: p.error };
  if (p.urls.length !== 1) return { error: 'needs exactly one https URL' };
  const host = curlHost(p.urls[0]);
  if (!host) return { error: 'needs exactly one https URL with a host (no userinfo, no http)' };
  return { host, methods: [...CURL_READ_METHODS] };
}

const firstWord = (cmd) => cmd.trim().split(/\s+/)[0] || '';

/** May this curl command run under `curl` (the rule's parsed curl part)? */
function curlCommandAllowed(curl, cmd) {
  if (!curl || /[\\$]/.test(cmd)) return false;
  const words = shellWords(cmd);
  if (!words || !CURL_RE.test(words[0])) return false;
  const p = parseCurl(words);
  if (p.error || p.urls.length !== 1) return false;
  return curlHost(p.urls[0]) === curl.host;
}

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
    let curl = null;
    if (CURL_RE.test(firstWord(prefix))) {
      curl = curlRule(prefix);
      if (curl.error) return reject(`curl rule: ${curl.error}`);
    }
    return { ok: true, rule, parsed: { kind: 'bash', prefix, exact, curl } };
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

// ── protected paths: .claude/, .git/, .mcp.json (KBT-T5218) ─────────────────

/** Any `.git` segment, any `.claude` segment that is not `.claude/worktrees/<name>`, or a `.mcp.json` file. */
function isProtectedPath(p) {
  const segs = slashPath(p).toLowerCase().split('/');
  if (segs[segs.length - 1] === '.mcp.json') return true;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '.git') return true;
    if (segs[i] !== '.claude') continue;
    if (segs[i + 1] === 'worktrees' && segs[i + 2]) continue; // a checkout root (Claude Code worktree)
    return true;
  }
  return false;
}

/** The same three, spelled inside a command line or a file glob. */
const PROTECTED_IN_TEXT = /(^|[\s"'=/\\])(?:\.git[/\\]|\.claude[/\\](?!worktrees[/\\][^\s"'/\\]+(?:[/\\\s"']|$))|\.mcp\.json(?=$|[\s"']))/i;

/** Would this call touch Claude Code / git / MCP configuration? Then it never gets allow. */
function touchesProtected(toolName, input, cwd) {
  if (pathFields(input).some((raw) => isProtectedPath(resolveInputPath(raw, cwd) || raw))) return true;
  const globs = [toolName === 'Glob' ? input.pattern : null, toolName === 'Grep' ? input.glob : null];
  if (globs.some((g) => typeof g === 'string' && PROTECTED_IN_TEXT.test(g))) return true;
  return toolName === 'Bash' && typeof input.command === 'string' && PROTECTED_IN_TEXT.test(input.command);
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
      const hit = parsed.exact ? cmd === parsed.prefix.trim() : cmd.startsWith(parsed.prefix);
      if (!hit) return false;
      // curl: the prefix is not enough — host, single URL and read-only options are checked too.
      if (parsed.curl || CURL_RE.test(firstWord(cmd))) return curlCommandAllowed(parsed.curl, cmd);
      return true;
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
  if (touchesProtected(toolName, input, cwd)) return { allow: false, reason: '.claude/, .git/ and .mcp.json are never auto-allowed' };
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
  isProtectedPath,
  shellWords,
};
