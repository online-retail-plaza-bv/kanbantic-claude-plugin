#!/usr/bin/env node
'use strict';

//
// session-start-disk-space.js — KBT-F754
//
// SessionStart hook: meet de vrije ruimte van het volume waarop de sessie
// start en zegt één regel als die onder de drempel zit. Boven de drempel
// zwijgt hij volledig — een hook die elke sessie "alles in orde" meldt, leert
// iedereen om zijn uitvoer te negeren, en dan is de ene keer dat het ertoe
// doet ook onzichtbaar.
//
// Waarom een hook en niet alleen een skill: een volle schijf meldt zich niet
// netjes. Hij meldt zich als een `restore` die halverwege klapt, een
// worktree-checkout met halve bestanden, een test die een tmp-dir niet kan
// maken. Dan is het te laat om te meten. De meting hoort vóór het werk, en
// het enige moment dat vóór élk werk komt is de sessiestart.
//
// ── Fail-safe is de regel (KBT-BD206) ───────────────────────────────────────
// Elk foutpad eindigt in exit 0 met niets op stdout. Geen statfs (oude Node),
// een pad dat niet bestaat, een onleesbare payload — allemaal stil. De hook
// bewaakt een gemak, geen correctheid: een gemiste waarschuwing kost hooguit
// een mislukte build later; een sessiestart die blokkeert kost het hele
// werkstation.
//
// Drempels (GB, standaard 20 / 12):
//   KANBANTIC_DISK_WARN_GB       waarschuwen onder deze waarde; 0 schakelt uit
//   KANBANTIC_DISK_CRITICAL_GB   "kritiek" onder deze waarde
//   KANBANTIC_SKIP_DISK_CHECK=1  hook volledig overslaan
//
// Test-haak: KANBANTIC_DISK_SPACE_FIXTURE='{"freeBytes":..,"totalBytes":..,"path":".."}'
// vervangt de meting. fs.statfs is niet te mocken vanuit een child-process,
// en een hook die alleen op het werkstation van de auteur getest is, is niet
// getest.
//

const path = require('node:path');
const { freeSpace, formatGB, GB } = require('../scripts/disk-space.js');

const PREFIX = '[kanbantic-disk-space]';
const DEFAULT_WARN_GB = 20;
const DEFAULT_CRITICAL_GB = 12;
const CLEANUP_COMMAND = '/kanbantic-disk-cleanup';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // Een hook die op stdin blijft wachten is erger dan een hook die niets leest.
    setTimeout(() => resolve(data), 1500).unref();
  });
}

/**
 * Drempels uit de omgeving. Een onbruikbare waarde valt terug op de default
 * in plaats van de hook te laten crashen; `0` of `off` voor warn schakelt de
 * hele controle uit.
 */
function readThresholds(env = process.env) {
  const parse = (raw, fallback) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const s = String(raw).trim().toLowerCase();
    if (s === 'off' || s === 'false' || s === 'none') return 0;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const warnGb = parse(env.KANBANTIC_DISK_WARN_GB, DEFAULT_WARN_GB);
  let criticalGb = parse(env.KANBANTIC_DISK_CRITICAL_GB, DEFAULT_CRITICAL_GB);
  if (criticalGb > warnGb) criticalGb = warnGb;
  const skip = String(env.KANBANTIC_SKIP_DISK_CHECK || '').trim() === '1' || warnGb === 0;
  return { warnGb, criticalGb, skip };
}

/**
 * De regel die de hook zegt, of `null` als er niets te zeggen valt.
 * Puur, zodat de tekst getest kan worden zonder schijf.
 */
function formatNotice(volume, { warnGb, criticalGb }) {
  if (!volume || !Number.isFinite(volume.freeBytes) || !Number.isFinite(volume.totalBytes)) return null;
  const freeGb = volume.freeBytes / GB;
  if (freeGb >= warnGb) return null;
  const where = `${formatGB(volume.freeBytes)} vrij van ${formatGB(volume.totalBytes)} op ${volume.path}`;
  if (freeGb < criticalGb) {
    return `${PREFIX} KRITIEK: ${where} (grens ${criticalGb} GB). Builds, restores en worktree-checkouts gaan hierop stuk. `
      + `Ruim eerst op: ${CLEANUP_COMMAND}.`;
  }
  return `${PREFIX} ${where} — onder de drempel van ${warnGb} GB. `
    + `Draai ${CLEANUP_COMMAND} voordat je aan groot werk begint.`;
}

function measure(env, cwd) {
  const fixture = env.KANBANTIC_DISK_SPACE_FIXTURE;
  if (fixture) {
    try {
      const v = JSON.parse(fixture);
      if (v && Number.isFinite(Number(v.freeBytes)) && Number.isFinite(Number(v.totalBytes))) {
        return { path: v.path || '?', freeBytes: Number(v.freeBytes), totalBytes: Number(v.totalBytes) };
      }
    } catch {
      // onbruikbare fixture → doorvallen naar de echte meting
    }
    return null;
  }
  return freeSpace(cwd);
}

async function main() {
  try {
    const thresholds = readThresholds(process.env);
    if (thresholds.skip) return;

    let cwd = process.cwd();
    const raw = await readStdin();
    if (raw && raw.trim()) {
      try {
        const payload = JSON.parse(raw);
        if (payload && typeof payload.cwd === 'string' && payload.cwd.trim()) cwd = path.resolve(payload.cwd);
      } catch {
        // geen JSON op stdin — de cwd van het proces is dan de beste gok
      }
    }

    const notice = formatNotice(measure(process.env, cwd), thresholds);
    if (notice) process.stdout.write(`${notice}\n`);
  } catch {
    // fail-safe: nooit een sessiestart blokkeren
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), () => process.exit(0));
}

module.exports = {
  PREFIX,
  DEFAULT_WARN_GB,
  DEFAULT_CRITICAL_GB,
  CLEANUP_COMMAND,
  readThresholds,
  formatNotice,
};
