#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// compute-puls-udloeb-taerskler.js — kør fra repo-roden:
//   node scripts/compute-puls-udloeb-taerskler.js
// (kræver puls-data.json og puls-outlet-precip-history.json, se
//  scripts/fetch-puls-outlet-history.js, som skal køres først)
//
// Beregner en udløbs-specifik empirisk nedbørstærskel for PULS' regn-
// betingede udløb, i to grupper:
//   Gruppe 1 (qualityCode=0): udledt DIREKTE af udløbets eget, reelt
//     rapporterede årlige hændelsestal (LatestDischargeOverflows).
//   Gruppe 2 (qualityCode=2): LÅNT fra de mest lignende gruppe 1-udløb
//     (nærmeste ReducedArea), da årsvolumen alene ikke kan skelne mellem
//     "mange små" og "få store" hændelser.
//
// VIGTIGE, VERIFICEREDE BEGRÆNSNINGER (se PULS-TAERSKLER-RAPPORT.md for
// fuld udredning — opsummeret her, så de er synlige direkte i koden):
//   - PULS indeholder INGEN tidsstemplede enkelthændelser, kun ét årligt
//     hændelsestal pr. udløb (for udløbets eget latestDischargeYear). Der
//     findes derfor ingen datopræcisions-validering at lave — kun
//     årligt-niveau-validering (se validateInternalReproduction/
//     validateLending nedenfor).
//   - Kun ÉT reelt års hændelsestal findes pr. udløb (LatestNormalDischarge-
//     Year er samme kalenderår som LatestDischargeYear, ikke en 2. årgang).
//     Multi-års-robusthed opnås i stedet ved at anvende SAMME N (antal
//     hændelser) på hvert af de ≥2 tilgængelige HELE nedbørsår og
//     gennemsnitte de resulterende tærskler — se deriveThresholdForOutlet().
//   - Peak-kollaps sker på den AKKUMULEREDE (henfaldede) serie, ikke på rå
//     nedbør, som opgaven foreskriver. Kendt, accepteret bivirkning: en
//     meget kraftig regnhændelses langsomt henfaldende "hale" (τ=3 dage)
//     kan i sjældne tilfælde rage højt nok op til at blive talt som en
//     selvstændig "ny" peak mere end 5 timer efter selve hændelsen, hvis
//     ingen anden dag samme år har en højere værdi i den periode. Ikke
//     korrigeret her, da opgaven eksplicit foreskriver kollaps på netop
//     denne (den akkumulerede) serie.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const fs        = require('fs');
const path      = require('path');
const riskModel = require('../risk-model');

// ── Konfiguration (alle justerbare) ─────────────────────────────────────────
const DP02_COLLAPSE_HOURS = 5;    // Miljøstyrelsen/IDA Spildevandskomitéen 2022: "mere end 5 timer imellem overløbene"
const DECAY_TAU_DAYS      = 3.0;  // matcher risk-model.js/server.js' antecedentMM
const MIN_EVENTS_HIGH     = 10;   // N >= 10  -> høj tillidsgrad
const MIN_EVENTS_MEDIUM   = 5;    // N in 5-9 -> medium
const MIN_EVENTS_LOW      = 3;    // N in 3-4 -> lav; N < 3 -> udelades (falder tilbage til log-log-modellen)
const K_NEAREST           = 3;    // Opgave B: antal donor-udløb der lånes fra
const TEST_SPLIT_MODULO   = 5;    // hvert 5. udløb (index%5===0) i den outfallId-sorterede liste -> test (20%)

const PULS_DATA_FILE      = path.join(__dirname, '..', 'puls-data.json');
const PRECIP_HISTORY_FILE = path.join(__dirname, '..', 'puls-outlet-precip-history.json');
const OUT_FILE             = path.join(__dirname, '..', 'puls-udloeb-taerskler.json');
const REPORT_FILE          = path.join(__dirname, '..', 'PULS-TAERSKLER-RAPPORT.md');

// ── Rene, testbare funktioner ────────────────────────────────────────────────

// Kollapser peaks i en time-for-time (akkumuleret) serie: vælger grådigt den
// højeste ukrævede værdi, "kræver" alle indeks inden for ±windowHours
// omkring den (ækvivalent med DP02's "separate hændelser hvis >X timer
// imellem"), gentager. Returnerer peaks sorteret faldende — allerede sorteret,
// da 'order' konsumeres i faldende rækkefølge.
function collapsePeaks(series, windowHours) {
  const n = series.length;
  const order = [];
  for (let i = 0; i < n; i++) if (series[i] > 0) order.push(i);
  order.sort((a, b) => series[b] - series[a]);

  const claimed = new Uint8Array(n);
  const peaks = [];
  for (const i of order) {
    if (claimed[i]) continue;
    peaks.push({ index: i, value: series[i] });
    const lo = Math.max(0, i - windowHours);
    const hi = Math.min(n - 1, i + windowHours);
    for (let j = lo; j <= hi; j++) claimed[j] = 1;
  }
  return peaks;
}

// Udskærer ét kalenderårs (UTC) timer fra en kontinuert mm-serie, givet
// seriens starttidspunkt (ISO-streng uden 'Z', som Open-Meteo leverer).
// Returnerer null hvis året slet ikke er dækket af data.
function sliceYear(mm, startTimeIso, year) {
  const startMs   = new Date(startTimeIso + 'Z').getTime();
  const yearStart = Date.UTC(year, 0, 1, 0, 0, 0);
  const yearEndEx = Date.UTC(year + 1, 0, 1, 0, 0, 0);
  const iStart = Math.round((yearStart - startMs) / 3600000);
  const iEnd   = Math.round((yearEndEx - startMs) / 3600000);
  const lo = Math.max(0, iStart);
  const hi = Math.min(mm.length, iEnd);
  if (lo >= hi) return null;
  return { slice: mm.slice(lo, hi), complete: lo === iStart && hi === iEnd };
}

// Beregner tærsklen for ét udløb: kører accumulateDecayed + collapsePeaks
// for hvert HELE tilgængelige nedbørsår, tager den N'te-højeste (laveste af
// de N højeste) peak som det årets tærskel, og gennemsnitter på tværs af
// årene (se filhovedets kommentar om hvorfor — kun ét reelt hændelsesår
// findes, så multi-års-robusthed opnås ved at genanvende samme N).
function deriveThresholdForOutlet(eventsYear, cellMm, cellStartTime, availableYears) {
  const N = Math.round(eventsYear);
  if (!Number.isFinite(N) || N < MIN_EVENTS_LOW) {
    return { excluded: true, reason: N < MIN_EVENTS_LOW ? 'for_faa_haendelser' : 'ugyldigt_haendelsestal' };
  }

  const yearlyThresholds = [];
  const yearsUsed = [];
  for (const year of availableYears) {
    const yearData = sliceYear(cellMm, cellStartTime, year);
    if (!yearData || !yearData.complete) continue; // kun HELE år bruges til robusthedsgennemsnittet
    const series = riskModel.accumulateDecayed(yearData.slice, DECAY_TAU_DAYS);
    const peaks  = collapsePeaks(series, DP02_COLLAPSE_HOURS);
    if (peaks.length === 0) continue;
    const usable = peaks.slice(0, Math.min(N, peaks.length));
    yearlyThresholds.push(usable[usable.length - 1].value);
    yearsUsed.push(year);
  }

  if (yearlyThresholds.length === 0) {
    return { excluded: true, reason: 'ingen_hele_nedboersaar_i_celledata' };
  }

  const thresholdMm = yearlyThresholds.reduce((a, b) => a + b, 0) / yearlyThresholds.length;
  const confidence =
    N >= MIN_EVENTS_HIGH ? 'high' :
    N >= MIN_EVENTS_MEDIUM ? 'medium' : 'low';

  return { excluded: false, thresholdMm, confidence, eventsUsed: N, yearsUsed };
}

// K-nearest ved absolut ReducedArea-differens, med valgfrit type-tie-break:
// hvis MINDST k donorer deler targetType, indskrænkes donorpuljen til dem
// først (foretrækker samme kloaktype-kategori når muligt) — ellers falder
// tilbage til hele puljen. Vægtning: invers afstand (tættere donor vejer
// mere), normaliseret til sum=1.
function kNearestByArea(targetArea, targetType, donors, k) {
  let pool = donors.filter(d => d.reducedArea != null);
  if (targetType) {
    const sameType = pool.filter(d => d.type === targetType);
    if (sameType.length >= k) pool = sameType;
  }
  const withDist = pool
    .map(d => ({ donor: d, dist: Math.abs(d.reducedArea - targetArea) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, k);

  const EPS = 0.01; // ha — undgår division med 0 ved eksakt arealmatch
  const rawWeights = withDist.map(c => 1 / (c.dist + EPS));
  const sumW = rawWeights.reduce((a, b) => a + b, 0);
  return withDist.map((c, i) => ({ donor: c.donor, dist: c.dist, weight: sumW ? rawWeights[i] / sumW : 0 }));
}

// Simpel lineær regression (mindste kvadraters metode) med R².
function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
  const b = den === 0 ? 0 : num / den;
  const a = meanY - b * meanX;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) { const pred = a + b * xs[i]; ssRes += (ys[i] - pred) ** 2; ssTot += (ys[i] - meanY) ** 2; }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { a, b, r2, n };
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Hoved ─────────────────────────────────────────────────────────────────
function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('PULS-udløb — empirisk nedbørstærskel-beregning');
  console.log('═══════════════════════════════════════════════\n');

  const pulsData = JSON.parse(fs.readFileSync(PULS_DATA_FILE, 'utf8'));
  const history   = JSON.parse(fs.readFileSync(PRECIP_HISTORY_FILE, 'utf8'));
  const availableYears = [];
  for (let y = parseInt(history.meta.startDate.slice(0, 4), 10); y <= parseInt(history.meta.endDate.slice(0, 4), 10); y++) {
    availableYears.push(y);
  }
  console.log(`Nedbørsdata dækker: ${history.meta.startDate} – ${history.meta.endDate} (kalenderår kandidater: ${availableYears.join(', ')})`);
  console.log(`Celler hentet: ${Object.keys(history.cells).length}\n`);

  const excludedOutlets = [];
  const outletsById = new Map();

  // ── Opgave A: gruppe 1 (q0) ──────────────────────────────────────────────
  const q0Rows = pulsData.d.filter(r => r[7] === 0);
  q0Rows.sort((a, b) => (a[8] || '').localeCompare(b[8] || '')); // stabil sortering på outfallId, til den rumlige split

  const derivedResults = [];
  q0Rows.forEach((row, idx) => {
    const [lat, lng, name, , , , eventsYear, , outfallId, reducedArea, type] = row;
    const splitPartition = idx % TEST_SPLIT_MODULO === 0 ? 'test' : 'train';

    if (isNaN(lat) || isNaN(lng)) {
      excludedOutlets.push({ outfallId, name, reason: 'manglende_koordinater' });
      return;
    }
    const cellKey = riskModel.cellKey(lat, lng);
    const cell = history.cells[cellKey];
    if (!cell) {
      excludedOutlets.push({ outfallId, name, reason: 'ingen_nedboersdata_for_celle' });
      return;
    }

    const result = deriveThresholdForOutlet(eventsYear, cell.mm, cell.startTime, availableYears);
    if (result.excluded) {
      excludedOutlets.push({ outfallId, name, reason: result.reason, eventsYear });
      return;
    }

    const outlet = {
      outfallId, name, source: 'derived',
      thresholdMm: +result.thresholdMm.toFixed(2),
      confidence: result.confidence,
      eventsUsed: result.eventsUsed,
      yearsUsed: result.yearsUsed,
      reducedArea, type, splitPartition,
      volumeM3: row[5], eventsYear,
    };
    derivedResults.push(outlet);
    outletsById.set(outfallId, outlet);
  });

  console.log(`Opgave A (gruppe 1): ${derivedResults.length} udløb med udledt tærskel, ${excludedOutlets.length} udeladt.`);
  const trainSet = derivedResults.filter(o => o.splitPartition === 'train');
  const testSet  = derivedResults.filter(o => o.splitPartition === 'test');
  console.log(`  Rumlig split: ${trainSet.length} train / ${testSet.length} test.\n`);

  // ── Validering 1: intern reproduktion (Opgave A, IKKE prædiktiv — se filhoved) ──
  const reproductionDeviations = [];
  for (const outlet of testSet) {
    const row = q0Rows.find(r => r[8] === outlet.outfallId);
    const [lat, lng, , , , , , , , , , , latestDischargeYear] = row;
    const cell = history.cells[riskModel.cellKey(lat, lng)];
    const yearData = sliceYear(cell.mm, cell.startTime, latestDischargeYear);
    if (!yearData) continue;
    const series = riskModel.accumulateDecayed(yearData.slice, DECAY_TAU_DAYS);
    const peaks  = collapsePeaks(series, DP02_COLLAPSE_HOURS);
    const predictedCount = peaks.filter(p => p.value >= outlet.thresholdMm).length;
    reproductionDeviations.push(Math.abs(predictedCount - outlet.eventsUsed));
  }

  // ── Opgave B: gruppe 2 (q2) — lån fra train-delen af gruppe 1 ───────────
  const q2Rows = pulsData.d.filter(r => r[7] === 2);
  const borrowedResults = [];
  for (const row of q2Rows) {
    const [, , name, , , volumeM3, , , outfallId, reducedArea, type] = row;
    if (reducedArea == null) {
      excludedOutlets.push({ outfallId, name, reason: 'intet_reduceret_areal' });
      continue;
    }
    const donors = kNearestByArea(reducedArea, type, trainSet, K_NEAREST);
    if (donors.length === 0) {
      excludedOutlets.push({ outfallId, name, reason: 'ingen_donor_udloeb_fundet' });
      continue;
    }
    const thresholdMm = donors.reduce((sum, d) => sum + d.donor.thresholdMm * d.weight, 0);
    borrowedResults.push({
      outfallId, name, source: 'borrowed',
      thresholdMm: +thresholdMm.toFixed(2),
      confidence: 'borrowed',
      donorOutletIds: donors.map(d => d.donor.outfallId),
      reducedArea, type, volumeM3,
    });
  }
  console.log(`Opgave B (gruppe 2): ${borrowedResults.length} udløb med lånt tærskel, ${q2Rows.length - borrowedResults.length} udeladt herfra.\n`);

  // ── Validering 2: lånevalidering (den reelle, ærlige validering) ────────
  const lendingDeviationsPct = [];
  for (const outlet of testSet) {
    const otherTrain = trainSet; // testSet er allerede adskilt fra trainSet — intet leakage
    const donors = kNearestByArea(outlet.reducedArea, outlet.type, otherTrain, K_NEAREST);
    if (donors.length === 0 || outlet.reducedArea == null) continue;
    const borrowed = donors.reduce((sum, d) => sum + d.donor.thresholdMm * d.weight, 0);
    if (outlet.thresholdMm > 0) {
      lendingDeviationsPct.push(Math.abs(borrowed - outlet.thresholdMm) / outlet.thresholdMm * 100);
    }
  }

  // ── Volumen-skalerings-regression (separat outputfelt, se filhoved) ─────
  // Mål: gennemsnitlig volumen PR. HÆNDELSE (ikke årlig volumen alene) —
  // opgavens egen formulerede formål ("hvor meget udledes, GIVET en
  // hændelse") kræver dette, selvom opgaveteksten bogstaveligt nævner
  // "årlig volumen". For lånte udløb (ingen eget eventsUsed) bruges
  // donorernes gennemsnitlige eventsUsed som proxy-antal hændelser/år.
  function eventsForRegression(o, byId) {
    if (o.source === 'derived') return o.eventsUsed;
    const donorEvents = (o.donorOutletIds || []).map(id => byId.get(id)?.eventsUsed).filter(Boolean);
    return donorEvents.length ? donorEvents.reduce((a, b) => a + b, 0) / donorEvents.length : 1;
  }
  const regressionPoints = [...derivedResults, ...borrowedResults]
    .filter(o => o.volumeM3 > 0)
    .map(o => ({ x: o.thresholdMm, y: o.volumeM3 / Math.max(eventsForRegression(o, outletsById), 1) }));
  const regression = linearRegression(regressionPoints.map(p => p.x), regressionPoints.map(p => p.y));
  if (regression) {
    for (const outlet of [...derivedResults, ...borrowedResults]) {
      outlet.volumePerEventEstimate = +(regression.a + regression.b * outlet.thresholdMm).toFixed(1);
    }
  }

  // ── Output ────────────────────────────────────────────────────────────
  const groupCounts = { q0: q0Rows.length, q1: pulsData.d.filter(r => r[7] === 1).length, q2: q2Rows.length, q3: pulsData.d.filter(r => r[7] === 3).length };
  const total = pulsData.d.length;

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      dp02CollapseHours: DP02_COLLAPSE_HOURS,
      decayTauDays: DECAY_TAU_DAYS,
      dataWindow: { startDate: history.meta.startDate, endDate: history.meta.endDate, yearsAvailable: availableYears },
      groupDefinitions: {
        group1: `qualityCode=0 (reelle hændelsestal): ${groupCounts.q0} udløb (${(groupCounts.q0 / total * 100).toFixed(1)}%)`,
        group2: `qualityCode=2 (estimeret fra volumen): ${groupCounts.q2} udløb (${(groupCounts.q2 / total * 100).toFixed(1)}%)`,
        outOfScope: `qualityCode=1 (verificeret nul): ${groupCounts.q1} (${(groupCounts.q1 / total * 100).toFixed(1)}%); qualityCode=3 (ingen data): ${groupCounts.q3} (${(groupCounts.q3 / total * 100).toFixed(1)}%)`,
      },
      confidenceTiers: {
        high: `N >= ${MIN_EVENTS_HIGH}`, medium: `${MIN_EVENTS_MEDIUM}-${MIN_EVENTS_HIGH - 1}`,
        low: `${MIN_EVENTS_LOW}-${MIN_EVENTS_MEDIUM - 1}`, excluded: `N < ${MIN_EVENTS_LOW} (falder tilbage til eksisterende log-log-model, ikke beregnet her)`,
      },
      spatialSplit: { trainCount: trainSet.length, testCount: testSet.length, method: `stabil sortering på outfallId, hvert ${TEST_SPLIT_MODULO}. udløb -> test` },
      lendingMatch: { k: K_NEAREST, variable: 'reducedArea (ha)', weighting: 'invers afstand, normaliseret', secondaryTieBreak: 'type (fritekst kloaktype-beskrivelse), hvis >=k donorer deler samme type' },
      volumeRegression: regression
        ? { ...regression, target: 'meanVolumePerEvent (volumeM3/eventsAar) ~ thresholdMm', note: 'Selvstændigt felt (volumePerEventEstimate) — blandes ALDRIG med selve tærskelfeltet.' }
        : null,
      validation: {
        internalReproduction: {
          note: 'IKKE prædiktiv validering — PULS har ingen daterede enkelthændelser at holde tilbage. Genanvender den (fler-års-gennemsnittede) tærskel på udløbets eget rapporteringsår og sammenligner det genfundne antal peaks med det faktiske N. Delvist, men ikke fuldt, cirkulært (tærsklen er gennemsnittet af FLERE år, ikke kun dette).',
          n: reproductionDeviations.length,
          medianAbsCountDeviation: (m => m === null ? null : +m.toFixed(1))(median(reproductionDeviations)),
        },
        lendingValidation: {
          note: 'Den reelle, ærlige validering: test-partitionens gruppe-1-udløb midlertidigt behandlet som gruppe 2, lånt tærskel fra ØVRIGE train-udløb, sammenlignet med udløbets egen faktisk udledte tærskel.',
          n: lendingDeviationsPct.length,
          medianAbsPctDeviation: (m => m === null ? null : +m.toFixed(1))(median(lendingDeviationsPct)),
          meanAbsPctDeviation: lendingDeviationsPct.length ? +(lendingDeviationsPct.reduce((a, b) => a + b, 0) / lendingDeviationsPct.length).toFixed(1) : null,
        },
      },
      excludedOutlets,
    },
    outlets: [...derivedResults, ...borrowedResults],
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Skrevet: ${OUT_FILE}`);
  console.log(`  ${derivedResults.length} udledte + ${borrowedResults.length} lånte = ${output.outlets.length} udløb med tærskel.`);
  console.log(`  ${excludedOutlets.length} udløb udeladt (se meta.excludedOutlets for årsager).`);
  console.log(`\nValidering:`);
  console.log(`  Intern reproduktion (n=${reproductionDeviations.length}): median afvigelse ${median(reproductionDeviations)} hændelser`);
  console.log(`  Lånevalidering (n=${lendingDeviationsPct.length}): median afvigelse ${output.meta.validation.lendingValidation.medianAbsPctDeviation}%`);

  writeReport(output, groupCounts, total);
  console.log(`Skrevet: ${REPORT_FILE}`);
}

function writeReport(output, groupCounts, total) {
  const v = output.meta.validation;
  const md = `# PULS-udløb — empirisk nedbørstærskel-rapport

Genereret: ${output.meta.generatedAt}

## Metode

- **Akkumuleringsmodel**: samme rullende, eksponentielt henfald som resten af
  appen (τ=${output.meta.decayTauDays} dage, \`riskModel.accumulateDecayed()\`, delt med \`server.js\`'
  \`antecedentMM\`).
- **Hændelseskollaps**: ${output.meta.dp02CollapseHours} timer (Miljøstyrelsen/IDA
  Spildevandskomitéen 2022-materiale), anvendt direkte på den akkumulerede serie.
- **Datavindue**: ${output.meta.dataWindow.startDate} – ${output.meta.dataWindow.endDate}.

## Faktiske gruppeandele (${total.toLocaleString('da')} udløb i alt)

| Gruppe | Andel | Antal |
|---|---|---|
| Gruppe 1 (qualityCode=0, reelle hændelsestal) | ${(groupCounts.q0/total*100).toFixed(1)}% | ${groupCounts.q0.toLocaleString('da')} |
| Gruppe 2 (qualityCode=2, estimeret fra volumen) | ${(groupCounts.q2/total*100).toFixed(1)}% | ${groupCounts.q2.toLocaleString('da')} |
| Uden for scope: qualityCode=1 (verificeret nul) | ${(groupCounts.q1/total*100).toFixed(1)}% | ${groupCounts.q1.toLocaleString('da')} |
| Uden for scope: qualityCode=3 (ingen data) | ${(groupCounts.q3/total*100).toFixed(1)}% | ${groupCounts.q3.toLocaleString('da')} |

Bemærk: opgavebeskrivelsens antagelse om "~22% gruppe 1" holder ikke —
faktisk andel er ${(groupCounts.q0/total*100).toFixed(1)}%.

## Resultat

- ${output.outlets.filter(o=>o.source==='derived').length} udløb fik en DIREKTE udledt tærskel (Opgave A).
- ${output.outlets.filter(o=>o.source==='borrowed').length} udløb fik en LÅNT tærskel (Opgave B) — sporbar via \`donorOutletIds\`.
- ${output.meta.excludedOutlets.length} udløb blev udeladt (se \`meta.excludedOutlets\` for navngivne årsager pr. udløb — ingen stille fald-tilbage).

## Integration i den live risikomodel

Disse tærskler bruges rent faktisk af appen, ikke kun en stående beregning:
\`scripts/merge-puls-thresholds.js\` (Trin 4 i \`update-all-data.sh\`) fletter
tærsklen ind som \`puls-data.json\`'s \`row[13]\`, for udløb med tillidsgrad
\`high\`, \`medium\` eller \`borrowed\` (IKKE \`low\` — kun 3-4 hændelser bag
tallet er for usikkert til produktion). \`risk-model.js\`' og
\`dansk-overloeb-kort.html\`'s \`computeIntensityFactor()\` centrerer derefter
den bakterielle/virale risikosigmoide på udløbets EGEN tærskel i stedet for
den tidligere generiske, flade 5mm-antagelse — udløb uden en tilstrækkeligt
sikker tærskel (\`low\`-tillidsgrad eller slet ingen) falder fortsat tilbage
til den generiske 5mm-model, uændret.

## Validering

**Intern reproduktion** (Opgave A — IKKE prædiktiv, se begrundelse i output-metadata):
median afvigelse ${v.internalReproduction.medianAbsCountDeviation} hændelser (n=${v.internalReproduction.n}).

**Lånevalidering** (Opgave B — den reelle, ærlige måling): median afvigelse
${v.lendingValidation.medianAbsPctDeviation}%, gennemsnit ${v.lendingValidation.meanAbsPctDeviation}%
(n=${v.lendingValidation.n}).

## Kendte begrænsninger

1. **Ingen daterede enkelthændelser findes i PULS** — kun ét årligt
   hændelsestal pr. udløb. Al validering er derfor på årligt niveau, ikke
   datopræcision.
2. **Kun ét reelt hændelsesår pr. udløb** — "LatestNormalDischargeYear" er
   samme kalenderår som "LatestDischargeYear", ikke en uafhængig 2. årgang.
   Multi-års-robusthed opnås ved at genanvende samme N på flere års
   nedbørsdata, ikke ved at poole flere års reelle hændelsestal.
3. **SewerStructure-koderne (SE/OS/OF m.fl.) er udokumenterede** — det
   selvforklarende \`Type\`-fritekstfelt bruges i stedet til
   kloaktype-tie-break.
4. **Peak-kollaps på den akkumulerede (henfaldede) serie** kan i sjældne
   tilfælde tælle en kraftig hændelses langsomt henfaldende hale som en
   selvstændig "ny" peak mere end ${output.meta.dp02CollapseHours} timer
   efter selve hændelsen — se kommentar i toppen af
   \`compute-puls-udloeb-taerskler.js\`.
`;
  fs.writeFileSync(REPORT_FILE, md, 'utf8');
}

module.exports = { collapsePeaks, sliceYear, deriveThresholdForOutlet, kNearestByArea, linearRegression, median };

if (require.main === module) {
  main();
}
