#!/usr/bin/env node
'use strict';

//
// disk-space — KBT-F754 — meet de schijf, verwijder niets.
//
// Een dev-werkstation loopt vol met build-afval dat niemand opruimt omdat
// niemand het ziet: agent-worktrees onder `.claude/worktrees/`, een temp-map vol
// installers, package-caches van drie ecosystemen, een Docker-datadisk die wel
// groeit en nooit krimpt. De opruimskill `kanbantic-disk-cleanup` heeft als
// eerste regel "meten, dan pas verwijderen". Dit script is dat meten.
//
// Het script MEET ALLEEN. Het verwijdert niets, verplaatst niets, start geen
// docker, schrijft niets. Alles wat het teruggeeft is een inventaris waarop een
// agent (of mens) per post kan beslissen. De beslissing en de verwijdering
// horen in de skill, waar het terugvalpad en de harde grenzen staan.
//
// Generiek per KBT-B499 / KBT-TRUL014: geen workspace-specifieke paden,
// drempels of repo-namen. Wat per workspace verschilt komt uit het Toolkit-item
// `disk-cleanup-policy` (zie disk-cleanup-policy.js) en wordt als argument
// aangeleverd (`--repos`, `--temp-age-days`).
//
// CLI:
//   node disk-space.js                 leesbaar rapport van het volume van de cwd
//   node disk-space.js --json          dezelfde inventaris als JSON
//   node disk-space.js --path <p>      meet het volume waarop <p> staat
//   node disk-space.js --repos a,b     extra repo-roots voor de worktree-analyse
//   node disk-space.js --siblings      ook de buur-repo's van de cwd-repo
//   node disk-space.js --no-sizes      sla het (trage) meten van mapgroottes over
//   node disk-space.js --temp-age-days N   "oud" in de temp-map (standaard 2)
//
// Zero deps — Node-builtins, CommonJS `module.exports`, zelfde stijl als
// preflight-block.js / wireframe-block.js.
//

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GB = 1024 ** 3;
const DEFAULT_TEMP_AGE_DAYS = 2;
// Bovengrens voor de recursieve grootte-meting. Een temp-map met een half
// miljoen bestanden mag de sessiestart niet gijzelen; boven de grens stoppen we
// en markeren we het resultaat als `truncated` in plaats van door te ploegen.
const DEFAULT_MAX_ENTRIES = 250000;
// De map waarin Claude Code zijn worktrees voor subagents zet. Dit is de post
// die het snelst terugkomt — elke parallelle run laat er een paar achter.
const AGENT_WORKTREE_SEGMENT = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
// De scratchpad van een lopende Claude Code-sessie leeft in de temp-map en is
// per definitie in gebruik; die telt niet mee als "oud".
const TEMP_SKIP_NAMES = new Set(['claude']);

// ---------------------------------------------------------------------------
// Vrije ruimte
// ---------------------------------------------------------------------------

/**
 * Vrije en totale ruimte van het volume waarop `p` staat.
 * `null` als Node geen statfs heeft (< 18.15) of het pad niet bestaat —
 * de aanroeper beslist of dat een fout is; voor de SessionStart-hook is het
 * een reden om te zwijgen.
 */
function freeSpace(p = process.cwd()) {
  if (typeof fs.statfsSync !== 'function') return null;
  let s;
  try {
    s = fs.statfsSync(p);
  } catch {
    return null;
  }
  const freeBytes = Number(s.bavail) * Number(s.bsize);
  const totalBytes = Number(s.blocks) * Number(s.bsize);
  if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return {
    path: volumeLabel(p),
    freeBytes,
    totalBytes,
    usedBytes: totalBytes - freeBytes,
    freeGB: round(freeBytes / GB),
    totalGB: round(totalBytes / GB),
  };
}

function volumeLabel(p) {
  const abs = path.resolve(p);
  const root = path.parse(abs).root;
  return root || abs;
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function formatGB(bytes) {
  if (bytes === null || bytes === undefined) return '?';
  return `${round(bytes / GB, 2).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Mapgrootte
// ---------------------------------------------------------------------------

/**
 * Recursieve grootte van een map. Volgt NOOIT symlinks of junctions: op Windows
 * is `node_modules` in een worktree vaak een junction naar de hoofd-checkout
 * (zie de monorepo-gotcha), en die zou anders dubbel geteld — of erger, door
 * een opruimer als "van de worktree" aangezien — worden.
 */
function dirSize(dir, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const out = { bytes: 0, files: 0, dirs: 0, truncated: false };
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return { ...out, symlink: true };
  if (st.isFile()) return { ...out, bytes: st.size, files: 1 };
  if (!st.isDirectory()) return out;

  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > maxEntries) {
        out.truncated = true;
        return out;
      }
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        out.dirs++;
        stack.push(full);
        continue;
      }
      if (e.isFile()) {
        try {
          out.bytes += fs.lstatSync(full).size;
          out.files++;
        } catch {
          // verdwenen tussen readdir en stat — hoort bij een temp-map
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bekende cache-locaties
// ---------------------------------------------------------------------------

/**
 * De bekende afval-posten per platform. Alleen paden die een package-manager
 * of tool zelf opnieuw opbouwt; een pad hier is nooit "werk". Elke entry is een
 * kandidaat, geen besluit — `exists` en de grootte beslissen samen met de
 * skill wat de moeite waard is.
 */
function cachePaths({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  tmpdir = os.tmpdir(),
} = {}) {
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const xdgCache = env.XDG_CACHE_HOME || path.join(home, '.cache');
  const macCache = path.join(home, 'Library', 'Caches');

  const list = [
    {
      key: 'temp',
      label: 'Temp-map',
      path: tmpdir,
      kind: 'dir',
      reclaim: 'entries ouder dan --temp-age-days; nooit de actieve Claude-scratchpad',
    },
    {
      key: 'npm',
      label: 'npm cache',
      path: env.npm_config_cache || env.NPM_CONFIG_CACHE
        || (win ? path.join(local, 'npm-cache') : path.join(home, '.npm')),
      kind: 'dir',
      reclaim: 'npm cache clean --force',
    },
    {
      key: 'nuget-packages',
      label: 'NuGet global packages',
      path: env.NUGET_PACKAGES || path.join(home, '.nuget', 'packages'),
      kind: 'dir',
      reclaim: 'dotnet nuget locals all --clear',
    },
    {
      key: 'nuget-http',
      label: 'NuGet http-cache',
      path: win
        ? path.join(local, 'NuGet', 'v3-cache')
        : path.join(home, '.local', 'share', 'NuGet', 'v3-cache'),
      kind: 'dir',
      reclaim: 'dotnet nuget locals all --clear',
    },
    {
      key: 'pip',
      label: 'pip cache',
      path: env.PIP_CACHE_DIR
        || (win ? path.join(local, 'pip', 'Cache') : mac ? path.join(macCache, 'pip') : path.join(xdgCache, 'pip')),
      kind: 'dir',
      reclaim: 'pip cache purge',
    },
    {
      key: 'playwright',
      label: 'Playwright browser-builds',
      path: env.PLAYWRIGHT_BROWSERS_PATH
        || (win ? path.join(local, 'ms-playwright') : mac ? path.join(macCache, 'ms-playwright') : path.join(xdgCache, 'ms-playwright')),
      kind: 'dir',
      reclaim: 'alleen revisies die geen package.json meer gebruikt (npx playwright uninstall --all is te grof)',
    },
  ];

  if (win) {
    list.push({
      key: 'docker-vhdx',
      label: 'Docker Desktop datadisk (WSL VHDX)',
      path: path.join(local, 'Docker', 'wsl', 'disk', 'docker_data.vhdx'),
      kind: 'file',
      reclaim: 'build cache prunen + fstrim; compacteren is elevated — nooit containers/volumes/images',
    });
    list.push({
      key: 'docker-vhdx-legacy',
      label: 'Docker Desktop datadisk (oude locatie)',
      path: path.join(local, 'Docker', 'wsl', 'data', 'ext4.vhdx'),
      kind: 'file',
      reclaim: 'zie docker-vhdx',
    });
  } else if (mac) {
    list.push({
      key: 'docker-raw',
      label: 'Docker Desktop datadisk',
      path: path.join(home, 'Library', 'Containers', 'com.docker.docker', 'Data', 'vms', '0', 'data', 'Docker.raw'),
      kind: 'file',
      reclaim: 'build cache prunen; nooit containers/volumes/images',
    });
  }

  return list;
}

function measureCache(entry, { sizes = true, maxEntries } = {}) {
  let exists = false;
  try {
    exists = fs.existsSync(entry.path);
  } catch {
    exists = false;
  }
  const out = { ...entry, exists, bytes: null, files: null, truncated: false };
  if (!exists || !sizes) return out;
  const m = dirSize(entry.path, { maxEntries });
  if (!m) return out;
  out.bytes = m.bytes;
  out.files = m.files;
  out.truncated = m.truncated;
  return out;
}

/**
 * De temp-map apart: hier gaat het niet om "hoe groot", maar om "hoeveel is
 * aantoonbaar oud". Alleen top-level entries worden beoordeeld — een map van
 * drie dagen oud met één bestand van gisteren erin is niet oud.
 */
function measureTemp(tmpdir, { ageDays = DEFAULT_TEMP_AGE_DAYS, sizes = true, maxEntries, now = Date.now() } = {}) {
  const out = { path: tmpdir, ageDays, exists: false, bytes: null, staleBytes: null, staleEntries: [], skipped: [] };
  let entries;
  try {
    entries = fs.readdirSync(tmpdir, { withFileTypes: true });
    out.exists = true;
  } catch {
    return out;
  }
  const cutoff = now - ageDays * 24 * 3600 * 1000;
  let bytes = 0;
  let staleBytes = 0;
  for (const e of entries) {
    const full = path.join(tmpdir, e.name);
    if (TEMP_SKIP_NAMES.has(e.name)) {
      out.skipped.push(e.name);
      continue;
    }
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const size = sizes ? (dirSize(full, { maxEntries }) || { bytes: 0 }).bytes : null;
    if (size !== null) bytes += size;
    // Op mtime (LastWriteTime), net als een opruimer met de hand zou doen. Een
    // map die net is aangeraakt is niet oud, ook al zijn de bestanden erin dat wel.
    const newest = st.mtimeMs;
    if (newest < cutoff) {
      if (size !== null) staleBytes += size;
      out.staleEntries.push({ name: e.name, bytes: size, ageDays: round((now - newest) / 86400000, 1) });
    }
  }
  if (sizes) {
    out.bytes = bytes;
    out.staleBytes = staleBytes;
  }
  out.staleEntries.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  return out;
}

// ---------------------------------------------------------------------------
// Git-worktrees
// ---------------------------------------------------------------------------

function runGit(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function gitToplevel(dir, git = runGit) {
  const out = git(dir, ['rev-parse', '--show-toplevel']);
  return out ? path.resolve(out.trim()) : null;
}

/** Parseert `git worktree list --porcelain` naar objecten. */
function parseWorktreePorcelain(text) {
  const blocks = String(text || '').split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const wt = { path: null, head: null, branch: null, bare: false, detached: false, locked: false, lockReason: null, prunable: false, prunableReason: null };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wt.path = path.resolve(line.slice(9));
      else if (line.startsWith('HEAD ')) wt.head = line.slice(5);
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'bare') wt.bare = true;
      else if (line === 'detached') wt.detached = true;
      else if (line.startsWith('locked')) { wt.locked = true; wt.lockReason = line.slice(6).trim() || null; }
      else if (line.startsWith('prunable')) { wt.prunable = true; wt.prunableReason = line.slice(8).trim() || null; }
    }
    return wt;
  }).filter((w) => w.path);
}

function isAgentWorktree(p) {
  return path.resolve(p).includes(AGENT_WORKTREE_SEGMENT);
}

/**
 * Hoeveel commits van HEAD staan nergens op de remote? De upstream als die er
 * is, anders de remote default branch. `null` = niet vast te stellen, en dat
 * telt als ONveilig: "ik weet niet of dit gepusht is" is geen reden om het
 * weg te gooien.
 */
function unpushedCount(wtPath, git = runGit) {
  // Lui geëvalueerd: elke git-aanroep kost op een volle, drukke schijf
  // seconden, en meestal beslist de eerste kandidaat al.
  const candidates = [
    () => trimOrNull(git(wtPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])),
    () => trimOrNull(git(wtPath, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])),
    () => 'origin/main',
    () => 'origin/master',
  ];
  for (const pick of candidates) {
    const ref = pick();
    if (!ref) continue;
    // Een ref die niet bestaat laat rev-list falen → null → volgende kandidaat.
    const out = git(wtPath, ['rev-list', '--count', `${ref}..HEAD`]);
    if (out === null) continue;
    const n = parseInt(out.trim(), 10);
    if (Number.isFinite(n)) return { count: n, comparedTo: ref };
  }
  return { count: null, comparedTo: null };
}

function trimOrNull(s) {
  return s && s.trim() ? s.trim() : null;
}

/**
 * Alle gekoppelde worktrees van een repo met hun veiligheidsanalyse. De
 * hoofd-checkout zit er NIET in — die ruim je nooit op.
 *
 * `safeToRemove` is bewust streng: alleen een agent-worktree (onder
 * `.claude/worktrees/`) die schoon is, waarvan elke commit op de remote staat
 * en die niet gelockt is. Alles anders krijgt `false` met de reden erbij, zodat
 * het rapport laat zien wat er op een mens wacht.
 */
function analyzeWorktrees(repoRoot, { git = runGit, sizes = true, maxEntries } = {}) {
  const porcelain = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return null;
  const all = parseWorktreePorcelain(porcelain);
  const main = all.length ? all[0].path : path.resolve(repoRoot);
  const out = [];
  for (const wt of all) {
    if (path.resolve(wt.path) === path.resolve(main)) continue;
    const row = {
      ...wt,
      agent: isAgentWorktree(wt.path),
      exists: fs.existsSync(wt.path),
      dirty: null,
      unpushed: null,
      comparedTo: null,
      bytes: null,
      safeToRemove: false,
      reasons: [],
    };
    if (row.exists) {
      const status = git(wt.path, ['status', '--porcelain', '--untracked-files=all']);
      row.dirty = status === null ? null : status.split(/\r?\n/).filter(Boolean).length;
      const up = unpushedCount(wt.path, git);
      row.unpushed = up.count;
      row.comparedTo = up.comparedTo;
      if (sizes) {
        const m = dirSize(wt.path, { maxEntries });
        row.bytes = m ? m.bytes : null;
      }
    }
    if (!row.agent) row.reasons.push('geen agent-worktree (staat niet onder .claude/worktrees/)');
    if (!row.exists) row.reasons.push('map ontbreekt — alleen `git worktree prune` nodig');
    if (row.locked) row.reasons.push(`gelockt${row.lockReason ? `: ${row.lockReason}` : ''}`);
    if (row.dirty === null && row.exists) row.reasons.push('git status niet leesbaar');
    if (row.dirty > 0) row.reasons.push(`${row.dirty} niet-gecommitte wijziging(en)`);
    if (row.unpushed === null && row.exists) row.reasons.push('geen remote-referentie om tegen te vergelijken');
    if (row.unpushed > 0) row.reasons.push(`${row.unpushed} commit(s) niet op de remote (t.o.v. ${row.comparedTo})`);
    row.safeToRemove = row.reasons.length === 0;
    out.push(row);
  }
  return out;
}

/**
 * Welke repo's analyseren we? De repo van de cwd, plus expliciete `--repos`,
 * plus (op verzoek) de buur-repo's in dezelfde bovenliggende map — dat is hoe
 * een `C:\github`-achtige werkmap eruitziet.
 */
function discoverRepos({ cwd = process.cwd(), repos = [], siblings = false, git = runGit } = {}) {
  const found = new Map();
  const add = (p) => {
    if (!p) return;
    const top = gitToplevel(p, git);
    if (top && !found.has(top)) found.set(top, true);
  };
  add(cwd);
  for (const r of repos) {
    const abs = path.resolve(r);
    if (!fs.existsSync(abs)) continue;
    if (fs.existsSync(path.join(abs, '.git'))) {
      add(abs);
      continue;
    }
    // Een root zonder .git: behandel als map vol repo's.
    for (const e of safeReaddir(abs)) {
      if (e.isDirectory() && fs.existsSync(path.join(abs, e.name, '.git'))) add(path.join(abs, e.name));
    }
  }
  if (siblings) {
    const own = gitToplevel(cwd, git);
    if (own) {
      const parent = path.dirname(own);
      for (const e of safeReaddir(parent)) {
        if (e.isDirectory() && fs.existsSync(path.join(parent, e.name, '.git'))) add(path.join(parent, e.name));
      }
    }
  }
  return [...found.keys()];
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Inventaris
// ---------------------------------------------------------------------------

function inventory({
  cwd = process.cwd(),
  measurePath = cwd,
  repos = [],
  siblings = false,
  sizes = true,
  tempAgeDays = DEFAULT_TEMP_AGE_DAYS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  tmpdir = os.tmpdir(),
  git = runGit,
  now = Date.now(),
} = {}) {
  const volume = freeSpace(measurePath);
  const repoRoots = discoverRepos({ cwd, repos, siblings, git });
  const repoRows = repoRoots.map((root) => ({
    root,
    worktrees: analyzeWorktrees(root, { git, sizes, maxEntries }) || [],
  }));
  const caches = cachePaths({ platform, env, home, tmpdir })
    .filter((c) => c.key !== 'temp')
    .map((c) => measureCache(c, { sizes, maxEntries }));
  const temp = measureTemp(tmpdir, { ageDays: tempAgeDays, sizes, maxEntries, now });

  const worktreeRows = repoRows.flatMap((r) => r.worktrees);
  // Zonder meting geen som: een "0.00 GB" die eigenlijk "niet gemeten" betekent
  // is precies het getal dat iemand overneemt in een rapport.
  const sum = (rows) => (sizes ? rows.reduce((a, r) => a + (r.bytes || 0), 0) : null);
  const summary = {
    worktreesTotal: worktreeRows.length,
    worktreesSafe: worktreeRows.filter((w) => w.safeToRemove).length,
    worktreesSafeBytes: sum(worktreeRows.filter((w) => w.safeToRemove)),
    worktreesWaitingBytes: sum(worktreeRows.filter((w) => !w.safeToRemove)),
    cachesBytes: sum(caches.filter((c) => c.kind === 'dir')),
    tempStaleBytes: temp.staleBytes,
  };
  summary.reclaimableEstimateBytes = sizes
    ? summary.worktreesSafeBytes + summary.cachesBytes + (temp.staleBytes || 0)
    : null;

  return {
    measuredAt: new Date(now).toISOString(),
    platform,
    volume,
    repos: repoRows,
    temp,
    caches,
    summary,
    sizesMeasured: sizes,
  };
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

function formatReport(inv) {
  const lines = [];
  const v = inv.volume;
  lines.push('# Schijfinventaris');
  lines.push('');
  if (v) {
    lines.push(`**Volume ${v.path}** — vrij ${formatGB(v.freeBytes)} van ${formatGB(v.totalBytes)} (${round((v.freeBytes / v.totalBytes) * 100, 1)}%)`);
  } else {
    lines.push('**Volume** — vrije ruimte niet meetbaar (fs.statfs ontbreekt of pad bestaat niet)');
  }
  lines.push('');
  lines.push('## Post 1 — agent-worktrees');
  lines.push('');
  if (!inv.repos.length) lines.push('_geen git-repo gevonden_');
  for (const r of inv.repos) {
    lines.push(`### ${r.root}`);
    if (!r.worktrees.length) {
      lines.push('_geen gekoppelde worktrees_');
      lines.push('');
      continue;
    }
    lines.push('');
    lines.push('| Worktree | Branch | Grootte | Dirty | Ongepusht | Veilig | Reden |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const w of r.worktrees) {
      lines.push(`| ${path.relative(r.root, w.path) || w.path} | ${w.branch || (w.detached ? '(detached)' : '?')} | ${formatGB(w.bytes)} | ${fmtNull(w.dirty)} | ${fmtNull(w.unpushed)} | ${w.safeToRemove ? 'ja' : 'NEE'} | ${w.reasons.join('; ') || '—'} |`);
    }
    lines.push('');
  }
  lines.push('## Post 2 — temp-map');
  lines.push('');
  const t = inv.temp;
  if (!t.exists) lines.push(`_${t.path} niet leesbaar_`);
  else {
    lines.push(`${t.path} — totaal ${formatGB(t.bytes)}, waarvan ${formatGB(t.staleBytes)} in ${t.staleEntries.length} entries ouder dan ${t.ageDays} dag(en)${t.skipped.length ? ` (overgeslagen: ${t.skipped.join(', ')})` : ''}`);
    for (const e of t.staleEntries.slice(0, 15)) lines.push(`- ${e.name} — ${formatGB(e.bytes)} — ${e.ageDays} dagen`);
    if (t.staleEntries.length > 15) lines.push(`- … en ${t.staleEntries.length - 15} meer`);
  }
  lines.push('');
  lines.push('## Post 3 — package-caches en datadisks');
  lines.push('');
  lines.push('| Post | Pad | Aanwezig | Grootte | Opruimen via |');
  lines.push('|---|---|---|---|---|');
  for (const c of inv.caches) {
    lines.push(`| ${c.label} | ${c.path} | ${c.exists ? 'ja' : 'nee'} | ${c.exists ? formatGB(c.bytes) + (c.truncated ? ' (afgekapt)' : '') : '—'} | ${c.reclaim} |`);
  }
  lines.push('');
  lines.push('## Samenvatting');
  lines.push('');
  const s = inv.summary;
  lines.push(`- Worktrees: ${s.worktreesSafe} van ${s.worktreesTotal} veilig te verwijderen (${formatGB(s.worktreesSafeBytes)}); ${formatGB(s.worktreesWaitingBytes)} wacht op een mens`);
  lines.push(`- Temp ouder dan ${t.ageDays} dag(en): ${formatGB(t.staleBytes)}`);
  lines.push(`- Package-caches (reproduceerbaar): ${formatGB(s.cachesBytes)}`);
  lines.push(`- Begrote winst zonder elevated stappen: **${formatGB(s.reclaimableEstimateBytes)}** — rapporteer na afloop de gemeten winst, niet dit getal`);
  if (!inv.sizesMeasured) lines.push('- _groottes niet gemeten (--no-sizes)_');
  return lines.join('\n');
}

function fmtNull(n) {
  return n === null || n === undefined ? '?' : String(n);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, path: null, repos: [], siblings: false, sizes: true, tempAgeDays: DEFAULT_TEMP_AGE_DAYS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--siblings') opts.siblings = true;
    else if (a === '--no-sizes') opts.sizes = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--path') opts.path = argv[++i] || null;
    else if (a.startsWith('--path=')) opts.path = a.slice(7);
    else if (a === '--repos') opts.repos.push(...splitList(argv[++i]));
    else if (a.startsWith('--repos=')) opts.repos.push(...splitList(a.slice(8)));
    else if (a === '--temp-age-days') opts.tempAgeDays = toDays(argv[++i]);
    else if (a.startsWith('--temp-age-days=')) opts.tempAgeDays = toDays(a.slice(16));
    else throw new Error(`onbekend argument: ${a}`);
  }
  return opts;
}

function splitList(s) {
  return String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

function toDays(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--temp-age-days verwacht een getal >= 0, kreeg: ${s}`);
  return n;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`disk-space: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write('node disk-space.js [--json] [--path <p>] [--repos a,b] [--siblings] [--no-sizes] [--temp-age-days N]\n');
    return;
  }
  const inv = inventory({
    measurePath: opts.path || process.cwd(),
    repos: opts.repos,
    siblings: opts.siblings,
    sizes: opts.sizes,
    tempAgeDays: opts.tempAgeDays,
  });
  process.stdout.write(opts.json ? JSON.stringify(inv, null, 2) + '\n' : formatReport(inv) + '\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  GB,
  DEFAULT_TEMP_AGE_DAYS,
  DEFAULT_MAX_ENTRIES,
  freeSpace,
  formatGB,
  dirSize,
  cachePaths,
  measureCache,
  measureTemp,
  parseWorktreePorcelain,
  isAgentWorktree,
  unpushedCount,
  analyzeWorktrees,
  discoverRepos,
  inventory,
  formatReport,
  parseArgs,
};
