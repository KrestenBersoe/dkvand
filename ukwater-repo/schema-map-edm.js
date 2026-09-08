#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// schema-map-edm.js — schema-mapping pass for a Southern Water "release
// history" EDM export (raw CSV) into a clean, structured intermediate
// format for the UK bathing-water validation work (see the chat thread this
// was designed in: compares against dkvand's PULS-based validation, this is
// the UK equivalent's first stage — ingestion, not the backtest itself).
//
// Kør fra ukwater-repo/ (denne mappe):
//   node schema-map-edm.js --csv <path-to-release-history.csv> [--workers N] [--out-dir DIR]
//
// ── Why this exists as a separate first stage ────────────────────────────
// The raw export has TWO real shapes tangled into one flat table: an EVENT
// (one outfall, one start/end, one duration) can appear on MULTIPLE rows —
// once per bathing water it was assessed against — with every other field
// repeated identically. Deduplicating that here, once, means every later
// stage (the actual backtest, once EA lab data is available) works with a
// clean events table + a separate impacts table, not a flat CSV where
// "count of rows" and "count of discharge events" are different numbers
// (confirmed on the schema sample: 499 rows, 236 distinct Event IDs).
//
// ── Multi-threading design — carried over from dkvand's
// scripts/validate-badevand-model.js, adapted to this task ────────────────
// dkvand's threading paid off because a SINGLE cascade computation was
// measured at 45-57 seconds of real CPU work (badevand-risk-worker.js) —
// genuinely CPU-bound, genuinely worth spreading across cores. Plain CSV
// row-mapping is not that: parsing+transforming a row costs microseconds,
// not seconds. The honest case for threading THIS step is file size, not
// per-row cost — at true "large volume" (many millions of rows across
// years of a whole region's outfalls), splitting the file N ways still
// meaningfully cuts wall-clock time, and this same worker-per-shard
// structure is exactly what a future per-row-heavier stage (e.g.
// independently recomputing outfall-to-bathing-water geometry, rather than
// trusting Southern Water's own Impact Status column) would need anyway.
// Implemented as: one fast single-threaded BYTE-level pre-pass finds N
// row-aligned split points (see lib/csv-stream.js's
// findRowAlignedSplitPoints() — never splits a row, quote-aware, streamed
// rather than loading the whole file into memory), then N worker_threads
// each independently stream-parse and map their own contiguous byte range
// — same "contiguous shard per worker" shape as validate-badevand-model.js's
// chunkContiguous(), just sharding file bytes instead of calendar dates.
//
// ── Output ────────────────────────────────────────────────────────────────
// <out-dir>/edm-events.ndjson   — one JSON object per discharge event (deduplicated)
// <out-dir>/edm-impacts.ndjson  — one JSON object per (event, bathing water) assessment
// <out-dir>/edm-diagnostics.json — row/status/date-range counts, malformed-row examples
// NDJSON (one JSON object per line), not one giant array, so this stays
// streamable/greppable at real file sizes — same reasoning as why this
// script exists as a separate stage rather than holding everything in one
// in-memory structure through a later, heavier backtest step.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { findRowAlignedSplitPoints } = require('./lib/csv-stream');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CSV_PATH = argVal('--csv', null);
const NUM_WORKERS = Math.max(1, parseInt(argVal('--workers', String(os.cpus().length)), 10));
const OUT_DIR = path.resolve(argVal('--out-dir', path.join(__dirname, 'output')));

if (!CSV_PATH) {
  console.error('Angiv --csv <sti til release-history CSV-fil>.');
  process.exit(1);
}
if (!fs.existsSync(CSV_PATH)) {
  console.error(`Fil ikke fundet: ${CSV_PATH}`);
  process.exit(1);
}

const REQUIRED_COLUMNS = [
  'Outfall', 'Status', 'Start (Unix)', 'Start (Formatted)', 'End (Unix)', 'End (Formatted)',
  'Ended Status', 'Duration', 'Bathing Water', 'Impact Status', 'Event ID',
  'Tidal_Model_Version', 'Duration (Seconds)', 'Latitude', 'Longitude',
];

// En 15-kolonners header kan aldrig nærme sig 1MB — ingen løkke/retry
// nødvendig, kun én tilstrækkeligt stor engangslæsning.
function readHeaderLine(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const nl = text.indexOf('\n');
    if (nl === -1) throw new Error('Ingen linjeskift fundet i den første MB — er filen tom eller uden header?');
    let headerLine = text.slice(0, nl).replace(/\r$/, '');
    if (headerLine.charCodeAt(0) === 0xFEFF) headerLine = headerLine.slice(1);
    return headerLine.split(',').map((h) => h.trim());
  } finally {
    fs.closeSync(fd);
  }
}

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'schema-map-edm-worker.js'), { workerData });
    worker.on('message', (msg) => {
      if (msg.type === 'fatal') reject(new Error(`worker ${msg.workerIndex} fejlede: ${msg.error}\n${msg.stack || ''}`));
      else resolve(msg);
    });
    worker.on('error', reject);
  });
}

async function main() {
  console.log(`Læser header fra ${CSV_PATH}...`);
  const header = readHeaderLine(CSV_PATH);
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    console.error(`Påkrævede kolonner mangler: ${missing.join(', ')}`);
    console.error(`Fundne kolonner: ${header.join(', ')}`);
    process.exit(1);
  }
  console.log(`Header OK (${header.length} kolonner).`);

  console.log(`Finder ${NUM_WORKERS} række-justerede split-punkter (én hurtig byte-scanning-gennemgang)...`);
  const t0 = Date.now();
  const { totalDataRows, fileSize, ranges } = await findRowAlignedSplitPoints(CSV_PATH, NUM_WORKERS);
  console.log(`${totalDataRows.toLocaleString('en')} datarækker, ${(fileSize / 1024 / 1024).toFixed(1)}MB, ${ranges.length} skår fundet (${((Date.now() - t0) / 1000).toFixed(1)}s).`);

  console.log(`Behandler ${ranges.length} skår parallelt...`);
  const workerPromises = ranges.map((range, i) => runWorker({ filePath: CSV_PATH, range, header, workerIndex: i }));
  const results = await Promise.all(workerPromises);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const eventsPath = path.join(OUT_DIR, 'edm-events.ndjson');
  const impactsPath = path.join(OUT_DIR, 'edm-impacts.ndjson');
  const eventsStream = fs.createWriteStream(eventsPath);
  const impactsStream = fs.createWriteStream(impactsPath);

  // Dedup ACROSS workers too — a byte range boundary always falls on a row
  // start (see findRowAlignedSplitPoints()), but the SAME Event ID can
  // legitimately have its bathing-water rows land in different workers'
  // ranges if the source export doesn't group them contiguously. Re-dedup
  // here on the merge, keep the first-seen copy (all copies carry identical
  // outfall/start/end/duration fields per the source format).
  const seenEventIds = new Set();
  let totalRows = 0, totalEvents = 0, totalImpacts = 0;
  const merged = {
    statusCounts: { Genuine: 0, 'Not Genuine': 0, 'Under Review': 0, other: 0 },
    endedCounts: { Ended: 0, Ongoing: 0, other: 0 },
    malformedRowCount: 0, malformedExamples: [],
  };

  for (const r of results) {
    totalRows += r.diagnostics.rowCount;
    for (const k of Object.keys(merged.statusCounts)) merged.statusCounts[k] += r.diagnostics.statusCounts[k] || 0;
    for (const k of Object.keys(merged.endedCounts)) merged.endedCounts[k] += r.diagnostics.endedCounts[k] || 0;
    merged.malformedRowCount += r.diagnostics.malformedRowCount;
    if (merged.malformedExamples.length < 5) merged.malformedExamples.push(...r.diagnostics.malformedExamples.slice(0, 5 - merged.malformedExamples.length));

    for (const ev of r.events) {
      if (seenEventIds.has(ev.eventId)) continue;
      seenEventIds.add(ev.eventId);
      eventsStream.write(JSON.stringify(ev) + '\n');
      totalEvents++;
    }
    for (const im of r.impacts) {
      impactsStream.write(JSON.stringify(im) + '\n');
      totalImpacts++;
    }
  }
  eventsStream.end();
  impactsStream.end();

  const genuineEvents = [...seenEventIds].length > 0
    ? results.flatMap((r) => r.events).filter((e, i, arr) => arr.findIndex((x) => x.eventId === e.eventId) === i && e.genuine).length
    : 0;
  const startTimes = results.flatMap((r) => r.events).map((e) => e.startTsMs).filter((t) => t != null);
  const dateRange = startTimes.length
    ? { earliest: new Date(Math.min(...startTimes)).toISOString(), latest: new Date(Math.max(...startTimes)).toISOString() }
    : null;

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    sourceCsv: CSV_PATH,
    totalDataRowsInSource: totalDataRows,
    totalRowsParsed: totalRows,
    distinctEvents: totalEvents,
    genuineEvents,
    nonGenuineOrUnderReviewEvents: totalEvents - genuineEvents,
    impactAssessmentRows: totalImpacts,
    dateRange,
    statusCounts: merged.statusCounts,
    endedCounts: merged.endedCounts,
    malformedRowCount: merged.malformedRowCount,
    malformedExamples: merged.malformedExamples,
    workersUsed: ranges.length,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'edm-diagnostics.json'), JSON.stringify(diagnostics, null, 2), 'utf8');

  console.log('\n═══ Resultat ═══');
  console.log(`Rækker parset: ${totalRows.toLocaleString('en')} (kilde havde ${totalDataRows.toLocaleString('en')} datarækker — bør matche)`);
  console.log(`Distinkte hændelser: ${totalEvents.toLocaleString('en')} (${genuineEvents.toLocaleString('en')} Genuine, ${(totalEvents - genuineEvents).toLocaleString('en')} Not Genuine/Under Review — IKKE fjernet, kun talt, se edm-diagnostics.json)`);
  console.log(`Impact-vurderinger (hændelse × badevand): ${totalImpacts.toLocaleString('en')}`);
  if (dateRange) console.log(`Datointerval: ${dateRange.earliest} .. ${dateRange.latest}`);
  console.log(`Status-fordeling: ${JSON.stringify(merged.statusCounts)}`);
  console.log(`Ended/Ongoing: ${JSON.stringify(merged.endedCounts)}`);
  if (merged.malformedRowCount > 0) console.warn(`⚠ ${merged.malformedRowCount} misdannede rækker sprunget over — eksempler i edm-diagnostics.json.`);
  console.log(`\nSkrevet: ${eventsPath}`);
  console.log(`Skrevet: ${impactsPath}`);
  console.log(`Skrevet: ${path.join(OUT_DIR, 'edm-diagnostics.json')}`);
}

main().catch((err) => {
  console.error('schema-map-edm fejlede:', err);
  process.exit(1);
});
