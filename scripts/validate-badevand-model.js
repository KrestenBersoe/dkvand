#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// validate-badevand-model.js — flertrådet historisk backtest af dkvand's
// EGEN badevands-bakterie-risikokaskade (rainfall decay → per-udløbs-
// tærskel → afstand/rejsetid-henfald → site-score) mod ægte historiske
// PULS-labprøver.
//
// Kør fra repo-roden:
//   node scripts/validate-badevand-model.js [--workers N] [--window-days N]
//     [--with-currents] [--out-dir DIR]
//
// Forudsætter, i denne rækkefølge:
//   1. badevand-proeve-historik.json — genereres af
//      scripts/build-badevand-analyseresultater.js mod en frisk PULS-CSV-
//      eksport ("Badevand: Analyse- og Måleresultater"), se dét scripts
//      filhoved for de to datakilder det selv kræver. IKKE en del af dette
//      repo (2,1 GB rå CSV, gitignoret) — kør build-scriptet lokalt først.
//   2. puls-data.json — udløbenes lokation/tærskel/volumen, allerede i
//      repoet.
//
// ── Hvorfor denne fil eksisterer (i stedet for bare at rette
// validate-predictions-historical.js på plads) ──────────────────────────
// Bruger-rapporteret: den tidligere, ÉNTRÅDEDE backtest tog ~14 timer.
// Læsning af badevand-risk.js afslørede to uafhængige årsager (se
// validate-badevand-model-worker.js's filhoved for den fulde teknisk
// begrundelse):
//   (a) computeBadevandRiskCascade() genindlæste/genopbyggede sine
//       statiske geometrifiler FRA BUNDEN ved hvert kald, uanset at
//       staticDir er uændret på tværs af ALLE historiske datoer i en
//       backtest — rettet ved at udtrække denne indlæsning til
//       badevand-risk.js's nye, eksporterede loadStaticCascadeData() og
//       genbruge den, én gang pr. tråd (se worker-filen).
//   (b) selve O(udløb × geometrier)-matchingen er ÆGTE CPU-arbejde
//       (45-57 sek./kald, målt i produktion — se badevand-risk-worker.js),
//       og derfor noget der RENT FAKTISK kan parallelliseres på tværs af
//       CPU-kerner via Node's worker_threads — hver historisk dato er en
//       fuldstændig uafhængig genberegning, ingen delt tilstand mellem
//       datoer. Denne fil partitionerer de distinkte prøvedatoer i N
//       KONTINUERTE blokke (N=--workers, standard = alle CPU-kerner) —
//       kontinuerte, ikke interleaved, så to nabo-datoer (fx to prøver en
//       enkelt dag fra hinanden) lander i SAMME tråd og kan udnytte
//       workerens interne per-dato-cache (D+1's "i går" == D's "i dag").
//
// ── Metodologi — se opgavebeskrivelsen for den fulde begrundelse ────────
// - INGEN look-ahead-lækage at rette her: PULS-udløbstærsklerne
//   (puls-udloeb-taerskler.json, scripts/compute-puls-udloeb-taerskler.js)
//   er allerede kalibreret med en RUMLIG train/test-split (hvert 5. udløb
//   til test), ikke en dato-baseret — PULS har ingen daterede
//   enkelthændelser at "walk-forward" over (kun ét årligt hændelsestal pr.
//   udløb, se PULS-TAERSKLER-RAPPORT.md's "Kendte begrænsninger" #1).
//   Denne backtest tester derfor selve SITE-SCORE-KASKADEN mod ægte
//   labprøver — en helt anden, uafhængig validering af samme model.
// - Trivial baseline: rå (ikke-henfaldet) nedbør over et fast 48-timers
//   vindue for badestedets dominerende udløbs vejrcelle, sammenlignet mod
//   BASELINE_MM (standard 25mm — samme konstant som risk-model.js's egen
//   DEFAULT_THRESHOLD_MM, dvs. "hvad hvis vi ALDRIG havde per-udløbs-
//   kalibrering, kun denne ene faste, generiske tærskel").
// - Tre lags (samme-dag/T-1/max-over-forrige-48t) — se
//   validate-badevand-model-worker.js.
// - Segmentering: waterType (soe/kystvand/vandlob — bemærk: TRE grupper i
//   denne kodebase, ikke kun sø/kyst, se badevand-risk.js's waterType-felt),
//   dataConfidence (hoej/middel/lav/ingen-data), sæson (badesæson maj-sep
//   vs. helår).
// - Wilson-CI på precision/recall/PPV/NPV, IKKE bare et punktestimat.
//
// ── UDELADT (bevidst, for at holde afhængigheder/kørselstid nede) ───────
// CMEMS-strømretning (validate-predictions-historical.js's nyeste
// tilføjelse) er UDELADT som standard her — kræver Python3 +
// CMEMS_USERNAME/PASSWORD, og narrower vinduet til CMEMS' ret korte
// reelle dækning (~1-1,5 år). Slå til med --with-currents hvis
// credentials findes; uden det falder kystvandsmodellen tilbage til sin
// eksisterende isotropiske (afstands-kun) matching, PRÆCIS samme fallback-
// sti computeBadevandRiskCascade() allerede tager live når getCurrentAt
// er null.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const riskModel = require('../risk-model');
const {
  isoDate, mapWithConcurrency, fetchArchive, toSharedCellSeries,
  wilsonInterval, confusionStats, precisionRecallCurve, calibrationCurve,
} = require('./lib/badevand-backtest-utils');

const STATIC_DIR = path.join(__dirname, '..');
const SAMPLES_FILE = path.join(STATIC_DIR, 'badevand-proeve-historik.json');
const PULS_DATA_FILE = path.join(STATIC_DIR, 'puls-data.json');

// ── CLI ──────────────────────────────────────────────────────────────────
function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const NUM_WORKERS = Math.max(1, parseInt(argVal('--workers', String(os.cpus().length)), 10));
const WINDOW_DAYS = parseInt(argVal('--window-days', '730'), 10);
const WITH_CURRENTS = process.argv.includes('--with-currents');
const OUT_DIR = path.resolve(argVal('--out-dir', path.join(__dirname, 'validation-output')));
const FLAG_THRESHOLD = parseFloat(argVal('--flag-threshold', '0.2'));
const BASELINE_MM = parseFloat(argVal('--baseline-mm', String(riskModel.DEFAULT_THRESHOLD_MM)));
const MIN_POSITIVES_FOR_CI = 5; // under dette: rapporter tallet, men flag eksplicit som statistisk ubrugeligt

const CELL_CONCURRENCY = 4;
const BUFFER_DAYS = 8; // se validate-predictions-historical.js — samme grund (7-dages hourlyWeek-lookback for den tidligste dato)
const CURRENTS_CONCURRENCY = 3;
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const CURRENTS_SCRIPT = path.join(__dirname, 'fetch_currents_historical.py');
const CURRENTS_TIMEOUT_MS = 150 * 1000;

function fetchHistoricalCurrentsForCell(lat, lng, startDate) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON_BIN, [CURRENTS_SCRIPT],
      { timeout: CURRENTS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr && stderr.trim()) console.warn(`  [currents ${lat},${lng}] stderr:`, stderr.trim().slice(0, 300));
        let parsed;
        try { parsed = JSON.parse((stdout || '').trim()); }
        catch (parseErr) { return reject(new Error(`fetch_currents_historical.py gav ugyldig JSON: ${parseErr.message}`)); }
        if (parsed.error) return reject(new Error(parsed.error));
        resolve(parsed);
      },
    );
    child.stdin.write(JSON.stringify({ lat, lng, start: startDate }));
    child.stdin.end();
  });
}

// ── Kontinuert partitionering af KRONOLOGISK sorterede datoer i N blokke
// (ikke interleaved round-robin) — se filhoved for hvorfor: maksimerer
// worker-intern per-dato-cache-genbrug for nabo-prøvedatoer. ───────────────
function chunkContiguous(items, n) {
  const chunks = [];
  const base = Math.floor(items.length / n);
  const extra = items.length % n;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < extra ? 1 : 0);
    if (size === 0) continue;
    chunks.push(items.slice(idx, idx + size));
    idx += size;
  }
  return chunks;
}

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'validate-badevand-model-worker.js'), { workerData });
    let finalRecords = null;
    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        process.stdout.write(`\r  [worker ${workerData.workerIndex}] ${msg.processed}/${msg.total} datoer`.padEnd(60));
      } else if (msg.type === 'warn') {
        console.warn(`\n  [worker ${workerData.workerIndex}] ${msg.message}`);
      } else if (msg.type === 'fatal') {
        reject(new Error(`worker ${workerData.workerIndex} fejlede: ${msg.error}\n${msg.stack || ''}`));
      } else if (msg.type === 'done') {
        finalRecords = msg.records;
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (finalRecords) resolve(finalRecords);
      else if (code !== 0) reject(new Error(`worker ${workerData.workerIndex} afsluttede med kode ${code} uden resultat`));
      else resolve([]);
    });
  });
}

async function main() {
  if (!fs.existsSync(SAMPLES_FILE)) {
    console.error(`${SAMPLES_FILE} findes ikke endnu.`);
    console.error('Kør scripts/build-badevand-analyseresultater.js --csv <sti til vBadevandsstationResultater.csv> lokalt først (se dets filhoved) — den 2,1 GB CSV forlader ALDRIG denne kørsel/dette repo, kun det afledte prøve-JSON-uddrag.');
    process.exit(1);
  }
  if (!fs.existsSync(PULS_DATA_FILE)) {
    console.error(`${PULS_DATA_FILE} findes ikke — nødvendig for udløbslokationer/tærskler.`);
    process.exit(1);
  }

  console.log(`Tråde: ${NUM_WORKERS} (os.cpus().length=${os.cpus().length}), vindue: ${WINDOW_DAYS} dage, valgt lag: samme-dag/T-1/max-48t, strøm-data: ${WITH_CURRENTS ? 'TIL' : 'FRA (isotropisk fallback for kystvande)'}`);

  const samplesData = JSON.parse(fs.readFileSync(SAMPLES_FILE, 'utf8'));
  const allSamples = samplesData.samples;
  if (allSamples.length === 0) { console.error('Ingen prøver i filen.'); process.exit(1); }
  const maxDate = allSamples.reduce((m, s) => (s.dateIso > m ? s.dateIso : m), allSamples[0].dateIso);
  const windowStart = isoDate(new Date(new Date(`${maxDate}T00:00:00Z`).getTime() - WINDOW_DAYS * 86400000));
  let samples = allSamples.filter((s) => s.dateIso >= windowStart);
  console.log(`${allSamples.length} prøver i alt, ${samples.length} i vinduet ${windowStart}..${maxDate} (dagens udløbsdata er ikke gyldigt for ældre prøver).`);
  if (samples.length === 0) { console.error('Intet i det nyeste vindue — intet at validere.'); process.exit(1); }

  const pulsRaw = JSON.parse(fs.readFileSync(PULS_DATA_FILE, 'utf8'));
  const rows = pulsRaw.d || pulsRaw;
  const outlets = rows
    .map((row, i) => ({ id: String(i), ...riskModel.derivePulsFields(row), viralScore: null, algaeScore: null, foreRisk: null }))
    .filter((o) => o.lat != null && o.lng != null);
  console.log(`${outlets.length} udløb indlæst.`);

  const cellOf = new Map();
  for (const o of outlets) {
    const key = riskModel.cellKey(o.lat, o.lng);
    if (!cellOf.has(key)) cellOf.set(key, { lat: o.lat, lng: o.lng });
  }
  console.log(`${cellOf.size} distinkte vejr-gitterceller.`);

  const fetchStart = isoDate(new Date(new Date(`${windowStart}T00:00:00Z`).getTime() - BUFFER_DAYS * 86400000));
  const cellEntries = [...cellOf.entries()];
  console.log('Henter historisk nedbørsarkiv (Open-Meteo)...');
  const cellResults = await mapWithConcurrency(
    cellEntries, CELL_CONCURRENCY,
    async ([key, { lat, lng }]) => ({ key, series: await fetchArchive(lat, lng, fetchStart, maxDate) }),
    300,
    (done, total) => { if (done % 20 === 0 || done === total) console.log(`  ...${done}/${total} celler hentet`); },
  );
  const cellFailures = cellResults.filter((r) => r.error);
  if (cellFailures.length > 0) console.warn(`⚠ ${cellFailures.length}/${cellEntries.length} celler fejlede — udløb i disse celler får ingen scoring (behandlet som manglende data, ikke nul-risiko).`);
  // NYT (bruger-rapporteret — 16-tråds kørsel OOM-dræbt): konverteret til
  // SharedArrayBuffer-baseret form HER, ÉN gang, før workerData sendes til
  // nogen tråd — se toSharedCellSeries()'s filhoved i den delte lib for
  // hvorfor (strukturkloning ville ellers kopiere hele nedbørsarkivet, ISO-
  // strenge og alt, ind i HVER ENESTE af N worker-tråde).
  const cellSeriesByKey = new Map(cellResults.filter((r) => !r.error).map((r) => [r.key, toSharedCellSeries(r.series)]));

  let currentSeriesByKey = new Map();
  if (WITH_CURRENTS) {
    console.log(`Henter historisk strømretning for ${cellEntries.length} celler (CMEMS, kan tage lang tid)...`);
    const currentResults = await mapWithConcurrency(
      cellEntries, CURRENTS_CONCURRENCY,
      async ([key, { lat, lng }]) => ({ key, series: await fetchHistoricalCurrentsForCell(lat, lng, fetchStart) }),
      500,
      (done, total) => { if (done % 20 === 0 || done === total) console.log(`  ...${done}/${total} celler`); },
    );
    let earliestCommonDate = null;
    for (const r of currentResults) {
      if (r.error || !r.series || r.series.dates.length === 0) continue;
      const byDate = new Map();
      for (let i = 0; i < r.series.dates.length; i++) byDate.set(r.series.dates[i], { uo: r.series.uo[i], vo: r.series.vo[i] });
      currentSeriesByKey.set(r.key, byDate);
      const cellEarliest = r.series.dates[0];
      if (earliestCommonDate === null || cellEarliest > earliestCommonDate) earliestCommonDate = cellEarliest;
    }
    console.log(`${currentSeriesByKey.size}/${cellEntries.length} celler har strømdata.`);
    if (earliestCommonDate) {
      const before = samples.length;
      samples = samples.filter((s) => s.dateIso >= earliestCommonDate);
      console.log(`Indsnævret til CMEMS' faktiske dækning: ${earliestCommonDate}..${maxDate} — ${samples.length}/${before} prøver tilbage.`);
    } else {
      console.warn('⚠ Ingen celler fik strømdata — fortsætter med isotropisk fallback, ingen prøver droppet.');
    }
  }

  const samplesByDate = new Map();
  for (const s of samples) {
    if (!samplesByDate.has(s.dateIso)) samplesByDate.set(s.dateIso, []);
    samplesByDate.get(s.dateIso).push(s);
  }
  const distinctDates = [...samplesByDate.keys()].sort();
  console.log(`${distinctDates.length} distinkte prøvedatoer at backteste, fordelt på ${NUM_WORKERS} tråde.\n`);

  const dateChunks = chunkContiguous(distinctDates, NUM_WORKERS);
  const cellSeriesEntries = [...cellSeriesByKey.entries()];
  const currentSeriesEntries = [...currentSeriesByKey.entries()].map(([k, m]) => [k, [...m.entries()]]);

  const t0 = Date.now();
  const workerPromises = dateChunks.map((chunk, i) => runWorker({
    workerIndex: i, staticDir: STATIC_DIR, outlets, cellSeriesEntries, currentSeriesEntries,
    dateShard: chunk.map((dateIso) => ({ dateIso, samples: samplesByDate.get(dateIso) })),
  }));
  const perWorkerRecords = await Promise.all(workerPromises);
  process.stdout.write('\n');
  const records = perWorkerRecords.flat();
  console.log(`Backtest færdig på ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min — ${records.length} (prøve × lag)-rekorder.\n`);

  analyzeAndReport(records, samples);
}

// ── Analyse ────────────────────────────────────────────────────────────
function segmentLabel(dim, value) { return `${dim}=${value ?? 'null'}`; }

function buildConfusion(recs, scoreField, threshold) {
  let tp = 0, fp = 0, tn = 0, fn = 0, noScore = 0;
  for (const r of recs) {
    const score = r[scoreField];
    if (score == null) { noScore++; continue; }
    const flagged = score >= threshold;
    if (r.failed && flagged) tp++;
    else if (!r.failed && flagged) fp++;
    else if (!r.failed && !flagged) tn++;
    else fn++;
  }
  return { ...confusionStats({ tp, fp, tn, fn }), noScore };
}

function summarizeSegment(recs, label) {
  const positives = recs.filter((r) => r.failed).length;
  const out = {
    segment: label, n: recs.length, positives,
    insufficientData: positives < MIN_POSITIVES_FOR_CI,
  };
  for (const lag of ['sameDay', 'tMinus1', 'max48h']) {
    const lagRecs = recs.filter((r) => r.lag === lag);
    const modelConfusion = buildConfusion(lagRecs, 'bact', FLAG_THRESHOLD);
    const baselineConfusion = buildConfusion(lagRecs, 'baselineMm', BASELINE_MM);
    const modelPr = precisionRecallCurve(lagRecs.map((r) => ({ score: r.bact, failed: r.failed })));
    const baselinePr = precisionRecallCurve(lagRecs.map((r) => ({ score: r.baselineMm, failed: r.failed })));
    out[lag] = {
      model: { confusion: modelConfusion, aucPr: modelPr.aucPr, prPoints: modelPr.n },
      baseline: { confusion: baselineConfusion, aucPr: baselinePr.aucPr, prPoints: baselinePr.n },
    };
  }
  return out;
}

function analyzeAndReport(records, allSamplesInWindow) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const segments = [];
  segments.push(summarizeSegment(records, 'ALLE (helår, alle vandtyper, alle tillidsniveauer)'));

  const bathingRecs = records.filter((r) => r.bathingSeason);
  segments.push(summarizeSegment(bathingRecs, 'ALLE (kun badesæson maj-sep)'));

  for (const wt of ['soe', 'kystvand', 'vandlob', null]) {
    const subset = records.filter((r) => r.waterType === wt);
    if (subset.length === 0) continue;
    segments.push(summarizeSegment(subset, segmentLabel('waterType', wt)));
    const subsetBathing = subset.filter((r) => r.bathingSeason);
    if (subsetBathing.length > 0) segments.push(summarizeSegment(subsetBathing, segmentLabel('waterType(badesæson)', wt)));
  }

  for (const tier of ['hoej', 'middel', 'lav', 'ingen-data', null]) {
    const subset = records.filter((r) => r.dataConfidence === tier);
    if (subset.length === 0) continue;
    segments.push(summarizeSegment(subset, segmentLabel('dataConfidence', tier)));
  }

  // ── Kalibreringskurve (kun modellen — baseline's rå mm-tal har ingen
  // naturlig 0..1-sandsynlighedsfortolkning, se filhoved). Pr. lag,
  // pooled over alle segmenter (nok datapunkter til stabile deciler). ────
  const calibrationByLag = {};
  const prCurveByLag = {};
  for (const lag of ['sameDay', 'tMinus1', 'max48h']) {
    const lagRecs = records.filter((r) => r.lag === lag);
    calibrationByLag[lag] = calibrationCurve(lagRecs.map((r) => ({ score: r.bact, failed: r.failed })), 10);
    prCurveByLag[lag] = {
      model: precisionRecallCurve(lagRecs.map((r) => ({ score: r.bact, failed: r.failed }))),
      baseline: precisionRecallCurve(lagRecs.map((r) => ({ score: r.baselineMm, failed: r.failed }))),
    };
  }

  // Bedste lag = højeste AUC-PR for modellen, pooled over ALLE segmenter.
  const lagRanking = ['sameDay', 'tMinus1', 'max48h']
    .map((lag) => ({ lag, aucPr: prCurveByLag[lag].model.aucPr }))
    .sort((a, b) => (b.aucPr ?? -1) - (a.aucPr ?? -1));

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      flagThreshold: FLAG_THRESHOLD,
      baselineMm: BASELINE_MM,
      windowDays: WINDOW_DAYS,
      totalSamplesInWindow: allSamplesInWindow.length,
      totalPredictionRecords: records.length,
      minPositivesForCi: MIN_POSITIVES_FOR_CI,
      lagRanking,
      note: 'Segmenter med færre end minPositivesForCi POSITIVE (fejlede) prøver har insufficientData:true — tallene er stadig med, men bør IKKE citeres som et pålideligt punktestimat.',
    },
    segments,
    prCurveByLag,
    calibrationByLag,
  };

  const jsonPath = path.join(OUT_DIR, `badevand-model-validation-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2), 'utf8');

  // ── Flad CSV af segment-metrikkerne (én række pr. segment × lag × model/baseline) ──
  const csvRows = ['segment,n,positives,insufficientData,lag,variant,tp,fp,tn,fn,precision,precisionLo,precisionHi,recall,recallLo,recallHi,ppv,npv,npvLo,npvHi,falseAlarmRate,aucPr'];
  for (const seg of segments) {
    for (const lag of ['sameDay', 'tMinus1', 'max48h']) {
      for (const variant of ['model', 'baseline']) {
        const v = seg[lag][variant];
        const c = v.confusion;
        csvRows.push([
          `"${seg.segment}"`, seg.n, seg.positives, seg.insufficientData, lag, variant,
          c.tp, c.fp, c.tn, c.fn,
          c.precision.p, c.precision.lo, c.precision.hi,
          c.recall.p, c.recall.lo, c.recall.hi,
          c.ppv.p, c.npv.p, c.npv.lo, c.npv.hi,
          c.falseAlarmRate.p, v.aucPr,
        ].map((x) => (x == null ? '' : x)).join(','));
      }
    }
  }
  const csvPath = path.join(OUT_DIR, `badevand-model-validation-${timestamp}.csv`);
  fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');

  console.log(`Skrevet: ${jsonPath}`);
  console.log(`Skrevet: ${csvPath}\n`);

  // ── Konsol-opsummering ─────────────────────────────────────────────
  console.log('═══ Opsummering ═══');
  console.log(`Bedste lag (højeste AUC-PR, model, pooled): ${lagRanking[0].lag} (AUC-PR=${lagRanking[0].aucPr?.toFixed(3) ?? 'n/a'})`);
  for (const r of lagRanking) console.log(`  ${r.lag}: AUC-PR=${r.aucPr == null ? 'n/a (for få positive)' : r.aucPr.toFixed(3)}`);
  console.log('');
  const overall = segments[0];
  for (const lag of ['sameDay', 'tMinus1', 'max48h']) {
    const m = overall[lag].model, b = overall[lag].baseline;
    console.log(`[${lag}] Model  — precision ${fmtPct(m.confusion.precision)}, recall ${fmtPct(m.confusion.recall)}, AUC-PR=${m.aucPr?.toFixed(3) ?? 'n/a'} (n=${overall.n}, positive=${overall.positives}${overall.insufficientData ? ' — FOR FÅ TIL AT VÆRE STATISTISK PÅLIDELIG' : ''})`);
    console.log(`[${lag}] Baseline (${BASELINE_MM}mm/48t, ingen kalibrering) — precision ${fmtPct(b.confusion.precision)}, recall ${fmtPct(b.confusion.recall)}, AUC-PR=${b.aucPr?.toFixed(3) ?? 'n/a'}`);
    const verdict = (m.aucPr ?? -1) > (b.aucPr ?? -1) ? 'Modellen slår baseline' : 'Modellen slår IKKE tydeligt baseline';
    console.log(`  → ${verdict} på AUC-PR for dette lag.\n`);
  }
  console.log('Se JSON-filen for fuld segmentering (waterType/dataConfidence/sæson) og kalibreringskurven (decil-bøtter, observeret fejlrate).');
}

function fmtPct(wilson) {
  if (wilson.p == null) return 'n/a';
  return `${(wilson.p * 100).toFixed(1)}% [${(wilson.lo * 100).toFixed(1)}-${(wilson.hi * 100).toFixed(1)}%] (n=${wilson.n})`;
}

main().catch((err) => {
  console.error('validate-badevand-model fejlede:', err);
  process.exit(1);
});
