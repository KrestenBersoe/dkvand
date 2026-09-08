#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// edm-outlet-coverage-stats.js — read-only diagnostic answering three real
// questions about edm-events.ndjson before designing a shrinkage-based
// per-outlet threshold calibration: how many real events do we have, what
// date range do they span, and what does the per-outlet event-count
// distribution look like (how many outlets sit at n=1, the exact case a
// shrinkage estimator needs to handle well).
//
// IMPORTANT CAVEAT this script cannot resolve by itself, established by
// reading schema-map-edm.js's own header: the source data is a Southern
// Water "release HISTORY" export — an event log, not an annual EDM return
// that lists every monitored outfall regardless of whether it spilled. An
// outfall with ZERO releases in the whole period is structurally invisible
// to this data source — it never appears on any row. So "how many of the
// TOTAL outlets have >=1 event" is not answerable from this file: the
// outlets visible here ARE the entire population this project has any
// knowledge of. This script reports that plainly rather than computing a
// misleading percentage against an unknown or fabricated denominator.
//
// Kør fra ukwater-repo/:
//   node edm-outlet-coverage-stats.js [--events output/edm-events.ndjson]
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const EVENTS_PATH = path.resolve(argVal('--events', path.join(__dirname, 'output', 'edm-events.ndjson')));
if (!fs.existsSync(EVENTS_PATH)) {
  console.error(`Findes ikke: ${EVENTS_PATH}. Angiv --events /sti/til/edm-events.ndjson.`);
  process.exit(1);
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(EVENTS_PATH) });

  let totalRows = 0;
  let genuineEndedRows = 0;
  let ongoingOrNonGenuineRows = 0;
  let minStartTsMs = null, maxStartTsMs = null;
  const outletsAny = new Set(); // every outfall that appears at all, any status
  const eventCountByOutlet = new Map(); // outfall -> count of genuine Ended events (the population a shrinkage threshold would calibrate against)

  for await (const line of rl) {
    if (!line) continue;
    const ev = JSON.parse(line);
    totalRows++;
    if (ev.outfall) outletsAny.add(ev.outfall);
    if (!ev.genuine || ev.endedStatus !== 'Ended' || ev.startTsMs == null) {
      ongoingOrNonGenuineRows++;
      continue;
    }
    genuineEndedRows++;
    if (minStartTsMs == null || ev.startTsMs < minStartTsMs) minStartTsMs = ev.startTsMs;
    if (maxStartTsMs == null || ev.startTsMs > maxStartTsMs) maxStartTsMs = ev.startTsMs;
    if (ev.outfall) eventCountByOutlet.set(ev.outfall, (eventCountByOutlet.get(ev.outfall) || 0) + 1);
  }

  console.log(`Læst: ${EVENTS_PATH}`);
  console.log(`\n═══ Volumen ═══`);
  console.log(`Total rækker i edm-events.ndjson: ${totalRows.toLocaleString('en')}`);
  console.log(`  Heraf ægte, afsluttede (genuine && endedStatus==='Ended'): ${genuineEndedRows.toLocaleString('en')}`);
  console.log(`  Heraf Ongoing/ikke-ægte (ekskluderet fra kalibrering/live-status): ${ongoingOrNonGenuineRows.toLocaleString('en')}`);

  console.log(`\n═══ Tidsspænd (ægte, afsluttede hændelser, startTsMs) ═══`);
  if (minStartTsMs != null) {
    console.log(`Første: ${new Date(minStartTsMs).toISOString()}`);
    console.log(`Sidste: ${new Date(maxStartTsMs).toISOString()}`);
    const years = (maxStartTsMs - minStartTsMs) / (1000 * 60 * 60 * 24 * 365.25);
    console.log(`Spænd: ~${years.toFixed(1)} år`);
  } else {
    console.log('Ingen ægte, afsluttede hændelser fundet.');
  }

  console.log(`\n═══ Udløbs-dækning — VIGTIGT FORBEHOLD ═══`);
  console.log(`Distinkte udløb (outfall), uanset status: ${outletsAny.size.toLocaleString('en')}`);
  console.log(`Distinkte udløb med mindst én ægte, afsluttet hændelse: ${eventCountByOutlet.size.toLocaleString('en')}`);
  console.log(`Kilden er en Southern Water "release HISTORY"-eksport (se schema-map-edm.js's filehoved) —`);
  console.log(`en hændelseslog, ikke en årlig EDM-returopgørelse over ALLE overvågede udløb. Et udløb`);
  console.log(`med NUL udledninger i hele perioden optræder aldrig på nogen række — det er strukturelt`);
  console.log(`usynligt for denne datakilde. De ${outletsAny.size.toLocaleString('en')} udløb ovenfor er derfor HELE`);
  console.log(`populationen dette projekt har nogen viden om, ikke en delmængde af et kendt større total.`);
  console.log(`"Hvor stor en andel af de TOTALE udløb har mindst én hændelse" kan ikke besvares herfra —`);
  console.log(`det ville kræve en uafhængig liste over alle Southern Waters overvågede udløb (fx en årlig`);
  console.log(`EDM-returopgørelse), som ikke findes i dette projekt.`);

  console.log(`\n═══ Hændelser pr. udløb — fordeling (relevant for shrinkage-vægtning) ═══`);
  const buckets = new Map(); // count -> number of outlets with exactly that many events (capped display)
  for (const c of eventCountByOutlet.values()) {
    const key = c >= 10 ? '10+' : String(c);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const orderedKeys = [...Array(9).keys()].map((i) => String(i + 1)).concat(['10+']);
  for (const key of orderedKeys) {
    const n = buckets.get(key) || 0;
    if (n === 0 && key !== '1' && key !== '10+') continue;
    const pct = eventCountByOutlet.size > 0 ? ((n / eventCountByOutlet.size) * 100).toFixed(1) : '0.0';
    console.log(`  ${key.padStart(3)} hændelse(r): ${String(n).padStart(4)} udløb (${pct}%)`);
  }
  const n1 = buckets.get('1') || 0;
  const n1to2 = n1 + (buckets.get('2') || 0);
  console.log(`\n  Udløb med PRÆCIS 1 hændelse: ${n1} (${((n1 / eventCountByOutlet.size) * 100).toFixed(1)}% af alle med data) — dette er den population, hvor shrinkage-vægtningen (PSEUDO_COUNT) betyder mest.`);
  console.log(`  Udløb med 1-2 hændelser: ${n1to2} (${((n1to2 / eventCountByOutlet.size) * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error('edm-outlet-coverage-stats fejlede:', err);
  process.exit(1);
});
