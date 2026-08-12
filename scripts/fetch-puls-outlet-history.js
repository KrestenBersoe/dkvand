#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// fetch-puls-outlet-history.js — kør fra repo-roden:
//   node scripts/fetch-puls-outlet-history.js
//   node scripts/fetch-puls-outlet-history.js --dry-run
//   node scripts/fetch-puls-outlet-history.js --out /sti
//
// Henter ~3 kalenderårs timeopløst historisk nedbør fra Open-Meteos
// ARCHIVE API (archive-api.open-meteo.com) — IKKE samme endpoint som
// server.js' fetchOpenMeteo() (forecast-endpointet, kun 7 dages bagudkig).
// Bruges som grundlag for den udløbs-specifikke tærskelberegning i
// scripts/compute-puls-udloeb-taerskler.js.
//
// Kun for udløb med qualityCode 0 (reelle hændelsestal) eller 2 (estimeret
// fra volumen) — de to grupper opgaven dækker. qualityCode 1
// (verificeret nul) og 3 (ingen data) er uden for scope, se
// PULS-TAERSKLER-RAPPORT.md.
//
// DEDUPLIKERING: 13.922 udløb (q0+q2) falder i kun 164 unikke 0,25°-
// gridceller (bekræftet ved optælling) — samme gitter/cellKey() som
// risk-model.js/server.js allerede bruger til vejr-caching
// (buildPulsGrid() i server.js). Henter derfor ÉN gang pr. celle, ikke pr.
// udløb, med præcis samme dedupliceringslogik.
//
// UTC, ikke Europe/Copenhagen: i modsætning til server.js' live-vejr (hvor
// lokal "i dag"-grænse betyder noget for brugeren) har denne historiske
// serie intet lokalt "nu" at forholde sig til — kun et rent, ensartet
// time-for-time gitter er nødvendigt til henfalds-/peak-beregningen i
// compute-puls-udloeb-taerskler.js. UTC undgår DST-betingede 23/25-timers
// døgn, som ellers ville forskyde det ensartede indeksgitter.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const riskModel  = require('../risk-model');

// ── Konfiguration ────────────────────────────────────────────────────────
const YEARS_BACK        = 3;   // hele kalenderår tilbage, inkl. indeværende
const ARCHIVE_LAG_DAYS  = 5;   // Open-Meteo archive-api har typisk nogle dages forsinkelse
const CONCURRENCY       = 4;   // Archive-API'et er strengere rate-begrænset end forecast-endpointet
                                // server.js' warmCache() bruger — 10 gav ~18% 429'ere i praksis, sat ned

const now       = new Date();
const endDate   = new Date(now.getTime() - ARCHIVE_LAG_DAYS * 86400 * 1000);
const startYear = now.getUTCFullYear() - YEARS_BACK;
const START_DATE = `${startYear}-01-01`;
const END_DATE    = endDate.toISOString().slice(0, 10);

const OUT_FILE = path.resolve(process.argv.find(a => a === '--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(__dirname, '..', 'puls-outlet-precip-history.json'));
const DRY_RUN = process.argv.includes('--dry-run');
const PULS_DATA_FILE = path.join(__dirname, '..', 'puls-data.json');

// ── Archive API-hentning (samme retry-idiom som server.js' fetchOpenMeteo/fetchOpenMeteoWithRetry) ──
function fetchArchive(lat, lng) {
  return new Promise((resolve, reject) => {
    const url = `https://archive-api.open-meteo.com/v1/archive` +
      `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&start_date=${START_DATE}&end_date=${END_DATE}` +
      `&hourly=precipitation&timezone=UTC`;
    const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: 60000 }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Archive-API HTTP ${res.statusCode} for ${lat},${lng}`));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error(`JSON-parse fejl (${lat},${lng}): ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout for ${lat},${lng}`)); });
    req.on('error', reject);
  });
}

function isTransientError(err) {
  return /HTTP (429|502|503|504)/.test(err.message || '');
}

async function fetchArchiveWithRetry(lat, lng, retries = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchArchive(lat, lng);
    } catch(e) {
      if (attempt >= retries || !isTransientError(e)) throw e;
      // Eskalerende ventetid ved 429 (5s, 10s, 20s, 40s) — den faste 5s var
      // ikke nok til at komme igennem Archive-API'ets rate-limit-vindue i
      // praksis (bekræftet: 30/164 celler fejlede stadig efter 2 forsøg).
      const waitMs = e.message.includes('429') ? 5000 * Math.pow(2, attempt) : 1500 * (attempt + 1);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// ── Udled unikke gridceller fra puls-data.json (qualityCode 0/2 kun) ────────
function buildOutletGrid() {
  const raw  = fs.readFileSync(PULS_DATA_FILE, 'utf8');
  const data = JSON.parse(raw);
  const rows = data.d || [];

  const seen = new Map(); // cellKey -> { lat, lng }
  let skippedNoCoords = 0, skippedOutOfScope = 0;

  for (const r of rows) {
    const [lat, lng, , , , , , quality] = r;
    if (quality !== 0 && quality !== 2) { skippedOutOfScope++; continue; }
    if (isNaN(lat) || isNaN(lng)) { skippedNoCoords++; continue; }
    const key = riskModel.cellKey(lat, lng);
    if (!seen.has(key)) {
      const [clatStr, clngStr] = key.split(':');
      seen.set(key, { lat: parseFloat(clatStr), lng: parseFloat(clngStr) });
    }
  }

  console.log(`Udløb i scope (qualityCode 0/2): ${rows.length - skippedOutOfScope - skippedNoCoords}`);
  console.log(`  udeladt (uden for scope, q1/q3): ${skippedOutOfScope}`);
  console.log(`  udeladt (manglende/ugyldige koordinater): ${skippedNoCoords}`);
  console.log(`Unikke 0,25°-gridceller: ${seen.size}`);

  return [...seen.entries()].map(([key, c]) => ({ key, lat: c.lat, lng: c.lng }));
}

// ── Hoved ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('PULS-udløb — historisk nedbørshentning');
  console.log(`Periode: ${START_DATE} til ${END_DATE} (${YEARS_BACK} år, UTC)`);
  console.log('═══════════════════════════════════════════════\n');

  const cells = buildOutletGrid();
  if (cells.length === 0) throw new Error('Ingen gridceller at hente — tjek puls-data.json');

  if (DRY_RUN) {
    console.log('\n--dry-run: ingen kald foretaget, ingen filer skrevet.');
    console.log(`Ville have hentet ${cells.length} celler til: ${OUT_FILE}`);
    return;
  }

  // Genoptagelig: en tidligere delvis kørsel (fx afbrudt af rate-limits) kan
  // allerede have hentet nogle celler korrekt — dem springes der over, kun
  // manglende/tidligere fejlede celler hentes.
  let results = {};
  if (fs.existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      results = prev.cells || {};
      console.log(`Genoptager: ${Object.keys(results).length} celler allerede hentet fra tidligere kørsel.`);
    } catch(e) { console.warn('Kunne ikke læse eksisterende outputfil, starter forfra:', e.message); }
  }
  const cellsToFetch = cells.filter(c => !results[c.key]);
  console.log(`Mangler at hente: ${cellsToFetch.length} celler.\n`);

  const errors  = [];
  let idx = 0, fetched = 0, failed = 0;
  const t0 = Date.now();

  async function worker(workerIdx) {
    await new Promise(r => setTimeout(r, workerIdx * 200)); // stagger, samme som warmCache()
    while (idx < cellsToFetch.length) {
      const cell = cellsToFetch[idx++];
      try {
        const raw = await fetchArchiveWithRetry(cell.lat, cell.lng);
        const mm  = (raw?.hourly?.precipitation || []).map(v => Math.max(Number(v) || 0, 0));
        const startTime = raw?.hourly?.time?.[0] || `${START_DATE}T00:00`;
        results[cell.key] = { lat: cell.lat, lng: cell.lng, startTime, mm };
        fetched++;
        if (fetched % 20 === 0) console.log(`  ${fetched}/${cellsToFetch.length} celler hentet…`);
      } catch(e) {
        failed++;
        console.warn(`  Fejl for celle ${cell.key}: ${e.message}`);
        errors.push({ key: cell.key, lat: cell.lat, lng: cell.lng, error: e.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cellsToFetch.length) }, (_, i) => worker(i)));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nFærdig: ${fetched} hentet, ${failed} fejlet, ${elapsed}s.`);

  const output = {
    meta: {
      startDate: START_DATE, endDate: END_DATE, timezone: 'UTC',
      fetchedAt: new Date().toISOString(),
      cellCount: cells.length, fetchedCount: fetched, failedCount: failed,
      errors,
    },
    cells: results,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output), 'utf8');
  const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`Skrevet: ${OUT_FILE} (${sizeMB} MB)`);

  if (failed > 0) {
    console.warn(`\nAdvarsel: ${failed} celle(r) kunne ikke hentes — se meta.errors i outputfilen.`);
    console.warn('Udløb i disse celler får INGEN tærskel beregnet (logges eksplicit, ikke stille sprunget over) i compute-puls-udloeb-taerskler.js.');
  }
}

main().catch(err => {
  console.error('\nFEJL:', err.message);
  process.exit(1);
});
