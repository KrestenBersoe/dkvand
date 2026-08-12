#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// calibrate-overflow-model.js — kør fra repo-roden:
//   node scripts/calibrate-overflow-model.js
// (kræver puls-data.json og puls-outlet-precip-history.json, se
//  scripts/fetch-puls-outlet-history.js, som skal køres først)
//
// Engangs-/periodisk ANALYSEOPGAVE — IKKE en del af runtime-serveren, IKKE
// kaldt fra update-all-data.sh. Fitter empirisk tærskel/multiplikator for
// risk-model.js' computeIntensityFactor()/computeRisk()/computeViralRisk()
// mod PULS' egne rapporterede årlige udledningstal, og skriver resultatet
// til en DATERET, navngiven fil (se bunden af main()) — overskriver ALDRIG
// risk-model.js' hardkodede standardværdier direkte. Gennemgang af
// resultatet er en manuel beslutning, ikke en automatisk konsekvens af at
// køre dette script.
//
// ═══════════════════════════════════════════════════════════════════════════
// VIGTIG PRÆMIS-KORREKTION (læs før brug af outputtet)
// ═══════════════════════════════════════════════════════════════════════════
// Den oprindelige opgaveformulering antog PULS-udløb med tidsstemplede
// start/slut-hændelser (~4.683 udløb, ~22%), til at bygge et hændelses-
// niveau labeldatasæt (positive/negative TIDSVINDUER) og måle precision/
// recall/AUC pr. hændelse. Det findes IKKE i PULS' data — bekræftet af
// update-puls.js's feltudtræk (kun ÉT årligt hændelsestal pr. udløb,
// LatestDischargeOverflows/LatestDischargeYear) og eksplicit dokumenteret
// af den allerede eksisterende scripts/compute-puls-udloeb-taerskler.js
// ("PULS indeholder INGEN tidsstemplede enkelthændelser") og
// PULS-TAERSKLER-RAPPORT.md ("opgavebeskrivelsens antagelse om '~22%
// gruppe 1' holder ikke — faktisk andel er 14,4%").
//
// Dette script kalibrerer derfor på UDLØBS-ÅR-niveau i stedet:
//   - POSITIV: qualityCode=0 (udløbet selv rapporterede ≥1 hændelse i sit
//     eget latestDischargeYear) — 3.106 udløb.
//   - NEGATIV: qualityCode=1 ("verificeret nul" — PULS bekræfter eksplicit
//     0 hændelser/0 volumen) — 6.912 udløb.
//   - UDELUKKET fra facit: qualityCode=2 (hændelsestal ESTIMERET fra
//     volumen via en log-log-regression, se update-puls.js's
//     imputeEvents()) — at bruge et imputeret tal som facit her ville være
//     cirkulært. qualityCode=3 (ingen data) er uden for scope.
// Se methodologyNote i outputrapportens JSON for den fulde begrundelse,
// inkl. hvorfor "sigmoid-midtpunkt" IKKE er en selvstændig frihedsgrad i
// den nuværende kode (identisk med tærsklen), og hvorfor multiplikatoren
// fittes UDEN overflowProbBase (cirkularitet — overflowProbBase er selv
// afledt af eventsYear, det felt der udgør selve facit).
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const fs        = require('fs');
const path      = require('path');
const riskModel = require('../risk-model');
const { collapsePeaks, sliceYear } = require('./compute-puls-udloeb-taerskler.js');

// ── Konfiguration ────────────────────────────────────────────────────────
const DP02_COLLAPSE_HOURS = 5;    // SAMME konvention som compute-puls-udloeb-taerskler.js — genbruges, ikke redefineres
const DECAY_TAU_DAYS      = 3.0;  // matcher risk-model.js/server.js' antecedentMM
const DECISION_CUTOFF     = 1.0;  // computeIntensityFactor() mætter ved 1 — score=intensityFactor*multiplier>=1 tolkes som "tydeligt overløbsudløsende intensitet"

// Grid-søgeområde — spænder bevidst bredt om BÅDE den nuværende hardkodede
// standard (5mm/×3) OG den eksisterende per-udløb empiriske tærskelfordeling
// (puls-udloeb-taerskler.json, gruppe 1: min 12,8mm, median 27mm, max 67mm —
// markant højere end 5mm-standarden, se rapportens "headline"-fund).
const THRESHOLD_CANDIDATES_MM = [2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40, 50, 60, 70, 80];
const MULTIPLIER_CANDIDATES   = [0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

const MIN_CLASS_COUNT      = 15;   // minimum pos/neg i BÅDE train og test for at en kloaktype-gruppe evalueres — ellers "insufficientData"
const BOOTSTRAP_ITERATIONS = 1000;
const BOOTSTRAP_SEED       = 42;   // deterministisk, ikke Math.random() — reproducerbare før/efter-sammenligninger på tværs af kørsler

const PULS_DATA_FILE      = path.join(__dirname, '..', 'puls-data.json');
const PRECIP_HISTORY_FILE = path.join(__dirname, '..', 'puls-outlet-precip-history.json');

// ── Rene, testbare funktioner ────────────────────────────────────────────

// PULS' Type-fritekstfelt (SewerStructure-koderne er udokumenterede, samme
// begrænsning som PULS-TAERSKLER-RAPPORT.md pkt. 3) — "Overløbsbygværk" er
// reelle fælleskloak-CSO-strukturer, "Separat regnvand" er rent regnvand
// (ingen spildevandskilde, se badevand-risk.js's isWastewater-filter, hvor
// SE/SF-udløb allerede nulstilles for bakteriel/viral risiko).
function classifySewerType(type) {
  if (!type) return 'andet_or_unknown';
  if (type.startsWith('Overløbsbygværk')) return 'combined_sewer_overflow';
  if (type.startsWith('Separat regnvand')) return 'separate_stormwater';
  return 'andet_or_unknown';
}

// FNV-1a — deterministisk strengehash, bruges KUN til den rumlige split
// (ikke kryptografisk formål). Samme cellenøgle giver altid samme resultat
// på tværs af kørsler, uden en gemt seed-tilstand.
function fnv1aHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Tildeler HELE 0,25°-nedbørsgitterceller (samme celle som allerede bruges
// til Open-Meteo-caching, se cellKey()) til train/test — ikke enkelte
// udløb. Sikrer at nærliggende udløb i samme kloaksystem/vejrcelle ALTID
// havner i samme partition, i stedet for en ID-sorteret modulo-split (som
// compute-puls-udloeb-taerskler.js bruger, men som ikke forhindrer at to
// geografisk nærliggende udløb med tilfældigvis forskellige outfallId'er
// havner på hver sin side).
function assignPartition(cellKeyStr) {
  return (fnv1aHash(cellKeyStr) % 100) < 20 ? 'test' : 'train';
}

// Mulberry32 — lille, deterministisk PRNG (IKKE Math.random()), til
// reproducerbar bootstrap på tværs af kørsler.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Beslutningsregel: genbruger risk-model.js' computeIntensityFactor()
// UÆNDRET (samme signatur, ingen parallel model) — peakMaxMm er den
// højeste DP02-kollapsede akkumulerede-nedbørs-peak i udløbets eget
// rapporteringsår. Multiplikator anvendes UDEN overflowProbBase, se
// filhovedets cirkularitets-begrundelse.
function predictPositive(peakMaxMm, thresholdMm, multiplier, cutoff) {
  return riskModel.computeIntensityFactor(peakMaxMm, thresholdMm) * multiplier >= cutoff;
}

function evaluateCombo(records, thresholdMm, multiplier, cutoff) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of records) {
    const predicted = predictPositive(r.peakMaxMm, thresholdMm, multiplier, cutoff) ? 1 : 0;
    if (predicted === 1 && r.label === 1) tp++;
    else if (predicted === 1 && r.label === 0) fp++;
    else if (predicted === 0 && r.label === 0) tn++;
    else fn++;
  }
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : null;
  const specificity = (tn + fp) > 0 ? tn / (tn + fp) : null;
  const f1 = (precision != null && recall != null && (precision + recall) > 0)
    ? 2 * precision * recall / (precision + recall) : null;
  const balancedAccuracy = (recall != null && specificity != null) ? (recall + specificity) / 2 : null;
  return { tp, fp, tn, fn, precision, recall, specificity, f1, balancedAccuracy };
}

// Rang-baseret AUC (Mann-Whitney U) på RÅ peakMaxMm — threshold-/
// multiplikator-uafhængig, da computeIntensityFactor() er monotont
// ikke-aftagende i precipMM for enhver fast tærskel (sigmoid stigende ×
// ramp ikke-aftagende), så AUC er invariant under selve valget af
// kandidat-tærskel/multiplikator. Måler derfor separabiliteten i selve
// nedbørssignalet, ikke i én bestemt parametervalg.
function rankAUC(records) {
  const pos = records.filter(r => r.label === 1);
  const neg = records.filter(r => r.label === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  const sorted = [...records].sort((a, b) => a.peakMaxMm - b.peakMaxMm);
  const ranks = new Array(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].peakMaxMm === sorted[i].peakMaxMm) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let sumPosRanks = 0;
  sorted.forEach((r, idx) => { if (r.label === 1) sumPosRanks += ranks[idx]; });
  return (sumPosRanks - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}

// VIGTIGT: med decisionCutoff FAST på 1 er (thresholdMm, multiplier) IKKE
// uafhængigt identificerbare for selve ja/nej-klassifikationen — da
// computeIntensityFactor() er monoton i precipMM, svarer ethvert
// (thresholdMm, multiplier)-par til PRÆCIS én effektiv nedbørs-mm-grænse
// (peakMaxMm skal nå denne for at udløse "positiv"). Mange forskellige
// par kan derfor give IDENTISK klassifikationsadfærd — grid-søgningen kan
// derfor lande på et vilkårligt punkt langs denne "ækvivalens-ryg" (se
// f.eks. at multiplikatoren i praksis ofte rammer selve gittergrænsen).
// Beregner den effektive grænse ved binærsøgning, så selve DENNE ene,
// reelt identificerbare størrelse rapporteres eksplicit, i stedet for at
// (thresholdMm, multiplier)-parret alene fejlagtigt fremstår som to
// selvstændigt veltilpassede tal.
function effectivePeakCutoffMm(thresholdMm, multiplier, cutoff) {
  if (multiplier <= 0) return Infinity;
  const MAX_MM = 500; // langt over selv de mest ekstreme observerede peaks (se dataset.empiricalThresholdContext)
  if (riskModel.computeIntensityFactor(MAX_MM, thresholdMm) * multiplier < cutoff) return Infinity;
  let lo = 0, hi = MAX_MM;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (riskModel.computeIntensityFactor(mid, thresholdMm) * multiplier >= cutoff) hi = mid; else lo = mid;
  }
  return +hi.toFixed(2);
}

function gridSearch(trainRecords) {
  let best = null;
  for (const thresholdMm of THRESHOLD_CANDIDATES_MM) {
    for (const multiplier of MULTIPLIER_CANDIDATES) {
      const result = evaluateCombo(trainRecords, thresholdMm, multiplier, DECISION_CUTOFF);
      if (result.balancedAccuracy == null) continue;
      if (!best || result.balancedAccuracy > best.result.balancedAccuracy) best = { thresholdMm, multiplier, result };
    }
  }
  return best;
}

function percentileCI(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[Math.floor(0.025 * (sorted.length - 1))];
  const hi = sorted[Math.floor(0.975 * (sorted.length - 1))];
  return { lo: +lo.toFixed(4), hi: +hi.toFixed(4), n: values.length };
}

function bootstrapCI(testRecords, thresholdMm, multiplier, cutoff, iterations, rng) {
  const precisions = [], recalls = [], aucs = [];
  const n = testRecords.length;
  for (let b = 0; b < iterations; b++) {
    const sample = new Array(n);
    for (let k = 0; k < n; k++) sample[k] = testRecords[Math.floor(rng() * n)];
    const result = evaluateCombo(sample, thresholdMm, multiplier, cutoff);
    if (result.precision != null) precisions.push(result.precision);
    if (result.recall != null) recalls.push(result.recall);
    const auc = rankAUC(sample);
    if (auc != null) aucs.push(auc);
  }
  return { precision: percentileCI(precisions), recall: percentileCI(recalls), auc: percentileCI(aucs) };
}

// Bygger den udløbs-år-niveau labeldataset (Trin 1-2 i den omlagte
// tilgang, se filhoved) — kun qualityCode 0/1, med fuld, sammenhængende
// nedbørsdækning for udløbets EGET rapporteringsår.
function buildCandidates(pulsData, history) {
  const candidates = [];
  const excluded = [];
  const startYear = parseInt(history.meta.startDate.slice(0, 4), 10);
  const endYear = parseInt(history.meta.endDate.slice(0, 4), 10);

  for (const row of pulsData.d) {
    const [lat, lng, name, , , , eventsYear, quality, outfallId, reducedArea, type, sewerStructure, latestDischargeYear] = row;
    if (quality !== 0 && quality !== 1) continue; // q2=imputeret (cirkulært som facit), q3=ingen data — ude af scope

    if (isNaN(lat) || isNaN(lng)) { excluded.push({ outfallId, name, quality, reason: 'manglende_koordinater' }); continue; }
    if (latestDischargeYear == null) { excluded.push({ outfallId, name, quality, reason: 'intet_rapporteringsaar' }); continue; }

    const cellKeyStr = riskModel.cellKey(lat, lng);
    const cell = history.cells[cellKeyStr];
    if (!cell) { excluded.push({ outfallId, name, quality, reason: 'ingen_nedboersdata_for_celle', cellKey: cellKeyStr }); continue; }

    if (latestDischargeYear < startYear || latestDischargeYear > endYear) {
      excluded.push({ outfallId, name, quality, reason: 'rapporteringsaar_uden_for_nedboersvindue', latestDischargeYear });
      continue;
    }

    const yearData = sliceYear(cell.mm, cell.startTime, latestDischargeYear);
    if (!yearData || !yearData.complete) {
      excluded.push({ outfallId, name, quality, reason: 'ufuldstaendigt_nedboersaar', latestDischargeYear });
      continue;
    }

    const series = riskModel.accumulateDecayed(yearData.slice, DECAY_TAU_DAYS);
    const peaks = collapsePeaks(series, DP02_COLLAPSE_HOURS);
    const peakMaxMm = peaks.length ? peaks[0].value : 0;

    candidates.push({
      outfallId, name, lat, lng, cellKey: cellKeyStr,
      type, sewerStructure, reducedArea,
      sewerGroup: classifySewerType(type),
      label: quality === 0 ? 1 : 0,
      eventsYear, latestDischargeYear,
      peakMaxMm, peaksCount: peaks.length,
    });
  }
  return { candidates, excluded };
}

function countReasons(excluded) {
  const counts = {};
  for (const e of excluded) counts[e.reason] = (counts[e.reason] || 0) + 1;
  return counts;
}

// ── Hoved ─────────────────────────────────────────────────────────────────
function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('Overløbsmodel — empirisk kalibrering (udløbs-år-niveau)');
  console.log('═══════════════════════════════════════════════\n');

  const pulsData = JSON.parse(fs.readFileSync(PULS_DATA_FILE, 'utf8'));
  const history = JSON.parse(fs.readFileSync(PRECIP_HISTORY_FILE, 'utf8'));

  const totalOutlets = pulsData.d.length;
  const q0Total = pulsData.d.filter(r => r[7] === 0).length;
  const q1Total = pulsData.d.filter(r => r[7] === 1).length;
  const q2Total = pulsData.d.filter(r => r[7] === 2).length;
  const q3Total = pulsData.d.filter(r => r[7] === 3).length;

  const { candidates, excluded } = buildCandidates(pulsData, history);
  candidates.forEach(c => { c.partition = assignPartition(c.cellKey); });

  console.log(`Facit-pulje (qualityCode 0+1): ${q0Total + q1Total} udløb (${((q0Total + q1Total) / totalOutlets * 100).toFixed(1)}% af ${totalOutlets})`);
  console.log(`  Heraf med fuld nedbørsdækning for eget rapporteringsår: ${candidates.length}`);
  console.log(`  Udelukket (huller i sensor-/nedbørsdækning): ${excluded.length} (${(excluded.length / (q0Total + q1Total) * 100).toFixed(1)}%)`);
  console.log(`  Udelukkelsesårsager:`, countReasons(excluded));

  const trainCount0 = candidates.filter(c => c.partition === 'train').length;
  console.log(`\nRumlig split (pr. 0,25°-gittercelle): ${trainCount0} train / ${candidates.length - trainCount0} test\n`);

  const groups = ['combined_sewer_overflow', 'separate_stormwater', 'andet_or_unknown', 'all_combined'];
  const groupResults = {};

  for (const group of groups) {
    const groupCandidates = group === 'all_combined' ? candidates : candidates.filter(c => c.sewerGroup === group);
    const train = groupCandidates.filter(c => c.partition === 'train');
    const test = groupCandidates.filter(c => c.partition === 'test');
    const trainPos = train.filter(c => c.label === 1).length, trainNeg = train.length - trainPos;
    const testPos = test.filter(c => c.label === 1).length, testNeg = test.length - testPos;

    console.log(`── ${group} — train ${train.length} (pos ${trainPos}/neg ${trainNeg}), test ${test.length} (pos ${testPos}/neg ${testNeg})`);

    if (trainPos < MIN_CLASS_COUNT || trainNeg < MIN_CLASS_COUNT || testPos < MIN_CLASS_COUNT || testNeg < MIN_CLASS_COUNT) {
      groupResults[group] = { insufficientData: true, reason: `< ${MIN_CLASS_COUNT} eksempler i mindst én klasse/split`, trainCount: train.length, testCount: test.length, trainPos, trainNeg, testPos, testNeg };
      console.log(`  Utilstrækkeligt datagrundlag — udeladt fra fitting.\n`);
      continue;
    }

    const best = gridSearch(train);
    const testEval = evaluateCombo(test, best.thresholdMm, best.multiplier, DECISION_CUTOFF);
    const testAuc = rankAUC(test);
    const ci = bootstrapCI(test, best.thresholdMm, best.multiplier, DECISION_CUTOFF, BOOTSTRAP_ITERATIONS, mulberry32(BOOTSTRAP_SEED));

    // JSON.stringify serialiserer Infinity som null — utydeligt, adskilt derfor
    // eksplicit fra en reel manglende værdi via neverTriggersPositive-flaget.
    const rawCutoff = effectivePeakCutoffMm(best.thresholdMm, best.multiplier, DECISION_CUTOFF);
    groupResults[group] = {
      fittedParams: {
        thresholdMm: best.thresholdMm, multiplier: best.multiplier, decisionCutoff: DECISION_CUTOFF,
        effectivePeakCutoffMm: Number.isFinite(rawCutoff) ? rawCutoff : null,
        neverTriggersPositive: !Number.isFinite(rawCutoff),
      },
      trainSetSize: train.length, testSetSize: test.length,
      trainClassBalance: { positive: trainPos, negative: trainNeg },
      testClassBalance: { positive: testPos, negative: testNeg },
      trainBalancedAccuracy: +best.result.balancedAccuracy.toFixed(4),
      test: {
        precision: testEval.precision != null ? +testEval.precision.toFixed(4) : null,
        recall: testEval.recall != null ? +testEval.recall.toFixed(4) : null,
        specificity: testEval.specificity != null ? +testEval.specificity.toFixed(4) : null,
        f1: testEval.f1 != null ? +testEval.f1.toFixed(4) : null,
        balancedAccuracy: testEval.balancedAccuracy != null ? +testEval.balancedAccuracy.toFixed(4) : null,
        auc: testAuc != null ? +testAuc.toFixed(4) : null,
        confusionMatrix: { tp: testEval.tp, fp: testEval.fp, tn: testEval.tn, fn: testEval.fn },
      },
      confidenceIntervals95: ci,
    };

    console.log(`  Fittet: threshold=${best.thresholdMm}mm, multiplier=${best.multiplier} (train balancedAcc=${best.result.balancedAccuracy.toFixed(3)})`);
    console.log(`  Test: precision=${testEval.precision?.toFixed(3)}, recall=${testEval.recall?.toFixed(3)}, AUC=${testAuc?.toFixed(3)}\n`);
  }

  // ── Output ──────────────────────────────────────────────────────────────
  const dateStr = new Date().toISOString().slice(0, 10);
  const paramsFile = path.join(__dirname, '..', `overflow-model-params-calibrated-${dateStr}.json`);
  const reportFile = path.join(__dirname, '..', `overflow-model-calibration-report-${dateStr}.json`);

  fs.writeFileSync(paramsFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceScript: 'scripts/calibrate-overflow-model.js',
    decisionRule: 'predictedPositive = computeIntensityFactor(peakMaxMm, thresholdMm) * multiplier >= decisionCutoff, hvor peakMaxMm er den højeste DP02-kollapsede (5t), τ=3-dages-henfaldede nedbørs-peak i udløbets eget rapporteringsår (latestDischargeYear). computeIntensityFactor() er risk-model.js\' UÆNDREDE funktion.',
    currentProductionDefaults: {
      thresholdMm: 5, multiplier: 3,
      note: 'De nuværende hardkodede standardværdier i risk-model.js (computeIntensityFactor() fallback=5mm, ×3 i computeRisk()/computeViralRisk()) — IKKE ændret af dette script.',
    },
    perSewerGroup: Object.fromEntries(
      Object.entries(groupResults).filter(([, v]) => !v.insufficientData).map(([k, v]) => [k, v.fittedParams])
    ),
    productionApplicability: 'Kun combined_sewer_overflow-gruppens parametre er kandidat til direkte brug i risk-model.js\' bakterielle/virale model — separate_stormwater-udløb (SE/SF) har allerede riskScore/viralScore=null i badevand-risk.js\' isWastewater-filter, uafhængigt af tærskel/multiplikator.',
    note: 'IKKE sat i produktion automatisk — se overflow-model-calibration-report-*.json for evalueringsgrundlag før evt. ibrugtagning i risk-model.js. Multiplikatoren er fittet UDEN overflowProbBase (se rapportens methodologyNote.multiplierCircularityNote) — vurdér samspillet med overflowProbBase, før den erstatter den nuværende ×3 i computeRisk()/computeViralRisk().',
  }, null, 2), 'utf8');

  const labeledPoolShare = (q0Total + q1Total) / totalOutlets * 100;
  fs.writeFileSync(reportFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: {
      inScope: 'Ja/nej-klassifikation: opstod ≥1 overløbshændelse i udløbets eget PULS-rapporteringsår, givet nedbørssignal — på udløbs-år-niveau, IKKE hændelses-/tidsvindue-niveau.',
      outOfScope: ['volumenkalibrering (kræver forsyningsselskabernes SRO-data, separat opgave)', 'forureningsattribution til badevandskvalitet', 'algemodel'],
    },
    methodologyNote: {
      whyNotEventLevel: 'PULS indeholder ingen tidsstemplede enkelthændelser (bekræftet af update-puls.js\'s feltudtræk og eksplicit dokumenteret i compute-puls-udloeb-taerskler.js/PULS-TAERSKLER-RAPPORT.md), kun ét årligt hændelsestal pr. udløb. Oprindelig opgaveformulerings antagelse om ~4.683/~22% udløb med tidsstemplet sensordata holder derfor ikke — se dataset.correctionNote nedenfor.',
      labelDefinition: 'POSITIV=qualityCode0 (udløbet selv rapporterede ≥1 hændelse i eget latestDischargeYear). NEGATIV=qualityCode1 ("verificeret nul", PULS bekræfter eksplicit 0 hændelser/0 volumen). qualityCode2 (estimeret fra volumen) udelukket fra facit — cirkulært at validere imputerede tal mod sig selv.',
      dp02Reuse: `Genbruger collapsePeaks()/sliceYear() fra scripts/compute-puls-udloeb-taerskler.js UÆNDRET (${DP02_COLLAPSE_HOURS}t kollaps på den τ=${DECAY_TAU_DAYS}-dages-henfaldede akkumulerede serie) — samme konvention som allerede besluttet, ikke redefineret.`,
      sigmoidMidpointNote: 'risk-model.js\'s computeIntensityFactor(precipMM, thresholdMm) afleder sigmoidens midtpunkt OG hældning direkte og udelukkende af thresholdMm (scale=threshold/5) — der findes intet uafhængigt "sigmoid-midtpunkt"-frihedsgrad i den eksisterende kode, adskilt fra selve tærsklen. Denne kalibrering fitter derfor ÉT reelt frihedsgrad for tærskel/midtpunkt (matematisk identiske i nuværende kode), ikke to separate parametre.',
      multiplierCircularityNote: 'Den nuværende ×3-multiplikator indgår i pOverflow = overflowProbBase * intensityFactor * 3, hvor overflowProbBase = min(eventsYear/DK_RAINY_DAYS_YEAR, 1) — afledt DIREKTE af eventsYear, altså selve det felt der udgør facit her. At bruge overflowProbBase i en klassifikator, der forudsiger OM et udløb havde hændelser, ville være cirkulært (for qualityCode1-udløb er overflowProbBase pr. definition 0, hvilket giver triviel 100% klassifikation). Denne kalibrering udelader derfor overflowProbBase og fitter multiplikatoren direkte på intensityFactor()*multiplier>=1-grænsen (se decisionRule i parameterfilen) — IKKE direkte substituerbar for ×3 i den eksisterende pOverflow-formel uden yderligere vurdering.',
      identifiabilityNote: 'Med decisionCutoff fast på 1 er (thresholdMm, multiplier) IKKE uafhængigt identificerbare for selve ja/nej-klassifikationen — da computeIntensityFactor() er monoton i precipMM, svarer ethvert (thresholdMm, multiplier)-par til præcis én effektiv nedbørs-mm-grænse (fittedParams.effectivePeakCutoffMm). Mange par giver identisk klassifikationsadfærd, så grid-søgningen kan lande vilkårligt langs denne "ækvivalens-ryg" (se f.eks. at multiplier ofte rammer selve gittergrænsen). Den effektive mm-grænse er den reelt tolkbare, veltilpassede størrelse her — de to enkeltparametre (thresholdMm/multiplier) bør IKKE tolkes hver for sig som selvstændigt validerede, kun deres kombinerede effekt. En uafhængig multiplikator-vurdering kræver den KONTINUERLIGE risikoscore holdt op mod faktisk alvorlighed/volumen (uden for scope her, se scope.outOfScope).',
      spatialSplitMethod: 'Alle udløb i samme 0,25°-nedbørsgittercelle (samme celle som Open-Meteo-caching allerede bruger) tildeles samme train/test-partition via en deterministisk strengehash af cellenøglen — forhindrer at nærliggende udløb i samme kloaksystem/vejrcelle lækker information mellem train og test.',
    },
    dataset: {
      totalPulsOutlets: totalOutlets,
      qualityCodeBreakdown: {
        q0_realAnnualCount: q0Total,
        q1_verifiedZero: q1Total,
        q2_imputedFromVolume_excludedFromLabels: q2Total,
        q3_noData_outOfScope: q3Total,
      },
      labeledCandidatePool: q0Total + q1Total,
      labeledCandidatePoolShare: `${labeledPoolShare.toFixed(1)}%`,
      outletsActuallyUsedAfterQualityFilter: candidates.length,
      outletsExcludedForCoverageGaps: excluded.length,
      coverageGapShareOfLabeledPool: `${(excluded.length / (q0Total + q1Total) * 100).toFixed(1)}%`,
      exclusionReasons: countReasons(excluded),
      correctionNote: `Opgavebeskrivelsens antagelse om "~4.683 udløb / ~22%" med tidsstemplet sensordata holder IKKE (se methodologyNote.whyNotEventLevel). Faktisk andel med reelt/verificeret årligt facit (qualityCode 0+1) er ${labeledPoolShare.toFixed(1)}% (${q0Total + q1Total} af ${totalOutlets}), hvoraf ${candidates.length} (${(candidates.length / (q0Total + q1Total) * 100).toFixed(1)}%) reelt kunne matches til fuld, sammenhængende nedbørsdækning i det aktuelle datavindue (${history.meta.startDate} – ${history.meta.endDate}). Resultatet generaliseres IKKE til de resterende udløb uden reelt/verificeret facit (qualityCode 2+3, ${(100 - labeledPoolShare).toFixed(1)}%).`,
      empiricalThresholdContext: 'Til reference: de eksisterende PER-UDLØB empirisk udledte tærskler (puls-udloeb-taerskler.json, gruppe 1) spænder ca. 13-67mm, median ~27mm — markant højere end den nuværende globale 5mm-standardværdi i risk-model.js. Denne kalibrerings globale fit bør ses i lyset af den spredning, ikke som en enkelt "sand" værdi for alle udløb.',
    },
    spatialSplit: {
      method: 'Gittercelle-baseret (se methodologyNote.spatialSplitMethod), IKKE tidsbaseret, IKKE tilfældig på tværs af enkeltudløb.',
      targetTestShare: '~20%',
      actualTestShare: `${((candidates.length - trainCount0) / candidates.length * 100).toFixed(1)}%`,
    },
    perSewerType: groupResults,
    explicitLimitations: [
      'Volumen er IKKE valideret i denne kørsel — kun ja/nej-hændelse (opstod ≥1 overløb i rapporteringsåret). Volumenkalibrering kræver forsyningsselskabernes SRO-data og er en separat opgave (se scope.outOfScope).',
      `Resultatet dækker KUN udløb med reelt rapporteret/verificeret PULS-facit (qualityCode 0+1) — ${labeledPoolShare.toFixed(1)}% af det samlede udløbsantal. Generaliseres IKKE ubegrundet til de resterende ${(100 - labeledPoolShare).toFixed(1)}% (qualityCode 2 estimeret fra volumen, qualityCode 3 ingen data).`,
      'Års-opløsning, ikke hændelses-opløsning — PULS har ingen daterede enkelthændelser. Precision/recall/AUC måler "forudsagde modellen mindst ét kvalificerende regnpeak i det år udløbet selv rapporterede sit facit for", ikke tidspræcis hændelsesdetektion.',
      'Multiplikator-parameteren er fittet UDEN overflowProbBase (se methodologyNote.multiplierCircularityNote) — kræver yderligere vurdering før direkte substitution i produktionsformlen.',
      'thresholdMm og multiplier er IKKE uafhængigt identificerbare i denne ja/nej-klassifikation (se methodologyNote.identifiabilityNote) — kun deres kombinerede effekt (fittedParams.effectivePeakCutoffMm) er en pålideligt tilpasset, tolkbar størrelse.',
      '"Sigmoid-midtpunkt" er ikke en selvstændig frihedsgrad i den nuværende kode — identisk med tærsklen (se methodologyNote.sigmoidMidpointNote).',
      'Kloaktype-split er baseret på PULS\' Type-fritekstfelt (SewerStructure-koderne er udokumenterede, samme begrænsning som PULS-TAERSKLER-RAPPORT.md pkt. 3).',
      'separate_stormwater-gruppens fittede parametre er IKKE relevante for den bakterielle/virale badevandsrisiko i produktion — badevand-risk.js nulstiller allerede riskScore/viralScore for disse udløb (isWastewater===false), uafhængigt af tærskel/multiplikator. Vist her for fuldstændighed/sammenligning, ikke som produktionskandidat.',
    ],
  }, null, 2), 'utf8');

  console.log(`Skrevet: ${paramsFile}`);
  console.log(`Skrevet: ${reportFile}`);
}

module.exports = {
  classifySewerType, fnv1aHash, assignPartition, mulberry32,
  predictPositive, evaluateCombo, rankAUC, gridSearch, percentileCI, bootstrapCI,
  buildCandidates, countReasons, effectivePeakCutoffMm,
};

if (require.main === module) {
  main();
}
