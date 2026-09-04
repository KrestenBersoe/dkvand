'use strict';
const assert = require('assert');
const {
  sigmoid, seasonalTau, cellKey, computeRisk, computeForecastRisk, derivePulsFields, estimateLastEventAge, GRID_DEG,
  computeIntensityFactor, riskBucket, shouldLogTransition,
} = require('./risk-model');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

test('cellKey: matcher kendt gitter-celle-eksempel (0,25° grid, celle-centrum)', () => {
  // København centrum: 55.6761, 12.5683 -> celle (55.5-55.75, 12.5-12.75) -> centrum (55.625, 12.625)
  const key = cellKey(55.6761, 12.5683);
  assert.strictEqual(key, '55.6250:12.6250');
});

test('cellKey: to punkter i samme 0,25°-celle giver samme nøgle', () => {
  const k1 = cellKey(55.61, 12.51);
  const k2 = cellKey(55.74, 12.74);
  assert.strictEqual(k1, k2);
});

test('cellKey: punkter i nabo-celler giver forskellig nøgle', () => {
  const k1 = cellKey(55.60, 12.60);
  const k2 = cellKey(55.90, 12.60); // 0.3° forskel, over cellegrænsen
  assert.notStrictEqual(k1, k2);
});

test('seasonalTau: giver en positiv, endelig værdi', () => {
  const tau = seasonalTau();
  assert.ok(tau > 0 && Number.isFinite(tau), `tau=${tau} er ikke en gyldig positiv værdi`);
});

test('computeRisk: intet vejrdata giver null-risiko (aldrig et gættet tal)', () => {
  const result = computeRisk({ overflowProbBase: 0.5, meanVolumePerEvent: 1000, precipMM: null, lastEventAge: null });
  assert.strictEqual(result.risk, null);
  assert.strictEqual(result.noData, true);
});

test('computeRisk: ingen nedbør (0mm) giver ~0 risiko', () => {
  const result = computeRisk({ overflowProbBase: 0.5, meanVolumePerEvent: 1000, precipMM: 0, lastEventAge: null });
  assert.ok(result.risk < 0.01, `forventede tæt på 0, fik ${result.risk}`);
});

test('computeRisk: kraftig nedbør (20mm) giver markant højere risiko end let regn (2mm)', () => {
  const light  = computeRisk({ overflowProbBase: 0.5, meanVolumePerEvent: 1000, precipMM: 2, lastEventAge: null });
  const heavy  = computeRisk({ overflowProbBase: 0.5, meanVolumePerEvent: 1000, precipMM: 20, lastEventAge: null });
  assert.ok(heavy.risk > light.risk, `forventede kraftig regn (${heavy.risk}) > let regn (${light.risk})`);
});

test('computeRisk: højere overflowProbBase (hyppigere historiske hændelser) giver højere risiko', () => {
  const rare    = computeRisk({ overflowProbBase: 0.1, meanVolumePerEvent: 1000, precipMM: 10, lastEventAge: null });
  const common  = computeRisk({ overflowProbBase: 0.9, meanVolumePerEvent: 1000, precipMM: 10, lastEventAge: null });
  assert.ok(common.risk > rare.risk);
});

test('computeRisk: lastEventAge tilføjer et residual-tillæg (frisk hændelse giver højere risiko)', () => {
  const noEvent    = computeRisk({ overflowProbBase: 0.3, meanVolumePerEvent: 500, precipMM: 3, lastEventAge: null });
  const freshEvent = computeRisk({ overflowProbBase: 0.3, meanVolumePerEvent: 500, precipMM: 3, lastEventAge: 0.1 });
  assert.ok(freshEvent.risk > noEvent.risk, 'en frisk hændelse burde give højere risiko end ingen kendt hændelse');
});

test('computeRisk: risiko er altid mellem 0 og 1, selv ved ekstreme input', () => {
  const extreme = computeRisk({ overflowProbBase: 1, meanVolumePerEvent: 1e9, precipMM: 500, lastEventAge: 0 });
  assert.ok(extreme.risk >= 0 && extreme.risk <= 1, `risk=${extreme.risk} uden for [0,1]`);
});

// ── computeIntensityFactor — udløbs-specifik tærskel (thresholdMm) ──────────
test('computeIntensityFactor: uden thresholdMm (null/undefined) matcher PRÆCIS den empirisk kalibrerede 25mm-fallback (RETTET 2026-07-30, se risk-model.js filhoved — tidligere 5mm, domæneskøn)', () => {
  for (const precipMM of [0, 1, 2, 5, 9, 15, 30, 60]) {
    const withoutThreshold = computeIntensityFactor(precipMM, null);
    const legacyRamp       = Math.min(Math.max(precipMM - 5, 0) / 30, 1);
    const legacyIntensity  = sigmoid((precipMM - 25) / 20) * legacyRamp;
    assert.strictEqual(withoutThreshold, legacyIntensity, `precipMM=${precipMM}: ${withoutThreshold} !== ${legacyIntensity}`);
    assert.strictEqual(computeIntensityFactor(precipMM, undefined), legacyIntensity);
  }
});

test('computeIntensityFactor: lav udløbs-tærskel (3mm, under den generiske 25mm) udløser TIDLIGERE end den generiske model', () => {
  const precipMM = 12;
  const low     = computeIntensityFactor(precipMM, 3);
  const generic  = computeIntensityFactor(precipMM, null);
  assert.ok(low > generic, `forventede lav tærskel (${low}) > generisk model (${generic}) ved samme nedbør`);
});

test('computeIntensityFactor: høj udløbs-tærskel (40mm) udløser SENERE end den generiske model', () => {
  const precipMM = 12;
  const high     = computeIntensityFactor(precipMM, 40);
  const generic  = computeIntensityFactor(precipMM, null);
  assert.ok(high < generic, `forventede høj tærskel (${high}) < generisk model (${generic}) ved samme nedbør`);
});

test('computeRisk: outlet med en lavere-end-generisk thresholdMm (3mm) giver højere risiko end uden ved samme nedbør', () => {
  // lav overflowProbBase, så pOverflow ikke saturerer ved 1 for begge og skjuler forskellen
  const base = { overflowProbBase: 0.2, meanVolumePerEvent: 1000, precipMM: 8, lastEventAge: null };
  const withLowThreshold = computeRisk({ ...base, thresholdMm: 3 });
  const withoutThreshold = computeRisk({ ...base, thresholdMm: null });
  assert.ok(withLowThreshold.risk > withoutThreshold.risk);
});

test('computeForecastRisk: null uden vejrdata', () => {
  const result = computeForecastRisk({ overflowProbBase: 0.5, meanVolumePerEvent: 1000, precipMM: null, forecastMM: 10 });
  assert.strictEqual(result, null);
});

test('computeForecastRisk: lægger forecastMM oveni precipMM (mere prognoseret regn -> højere prognoserisiko)', () => {
  const pt = { overflowProbBase: 0.5, meanVolumePerEvent: 1000, precipMM: 2, lastEventAge: null };
  const noForecastRain = computeForecastRisk({ ...pt, forecastMM: 0 });
  const heavyForecast  = computeForecastRisk({ ...pt, forecastMM: 20 });
  assert.ok(heavyForecast > noForecastRain, `forventede højere prognoserisiko med mere prognoseret regn: ${noForecastRain} vs ${heavyForecast}`);
});

test('derivePulsFields: korrekt afledning fra rå PULS-række', () => {
  // Row: [lat, lng, name, authIdx, areaIdx, volumeM3, eventsPerYear, qualityCode]
  const row = [55.7351, 12.5833, 'U17', 23, 3906, 1600.0, 11.0, 0];
  const derived = derivePulsFields(row);
  assert.strictEqual(derived.meanVolumePerEvent, 1600 / 11);
  assert.strictEqual(derived.overflowProbBase, Math.min(11 / 73, 1));
});

test('derivePulsFields: håndterer null eventsPerYear uden at crashe (division ved 0 undgået)', () => {
  const row = [55.0, 12.0, 'Test', 0, 0, 500, null, 3];
  const derived = derivePulsFields(row);
  assert.strictEqual(derived.overflowProbBase, 0);
  assert.strictEqual(derived.meanVolumePerEvent, 500); // vol / max(0,1) = vol/1
});

test('derivePulsFields: thresholdMm er null, når row[24] mangler (kort række, gammelt/ufuldstændigt format)', () => {
  const row = [55.0, 12.0, 'Test', 0, 0, 500, 10, 0];
  const derived = derivePulsFields(row);
  assert.strictEqual(derived.thresholdMm, null);
});

// RETTET (2026-08-20 — kritisk databug): thresholdMm flyttet fra row[13]
// til row[24] — se derivePulsFields()'s egen kommentar. row[13] var
// oprindeligt tærsklens plads, men update-puls.js genbrugte den senere til
// et helt andet felt (cod), uden at flytte tærsklen — se
// scripts/merge-puls-thresholds.js's tilsvarende rettelse.
test('derivePulsFields: thresholdMm læses korrekt fra row[24], når til stede', () => {
  const row = [
    55.0, 12.0, 'Test', 0, 0, 500, 10, 0, 'outfall-id', 1.5, 'type', 'SE', 2025,
    /* 13 cod */ 312, /* 14 bod */ 37, /* 15 nitrogen */ 12, /* 16 phosphor */ 1.87,
    /* 17 normalYear */ 2025, /* 18 normalVol */ 8160, /* 19 normalEv */ null,
    /* 20 normalCod */ 408, /* 21 normalBod */ 82, /* 22 normalNitrogen */ 16, /* 23 normalPhosphor */ 2.45,
    /* 24 thresholdMm */ 16.35,
  ];
  const derived = derivePulsFields(row);
  assert.strictEqual(derived.thresholdMm, 16.35);
});

test('derivePulsFields: thresholdMm er IKKE forvekslet med cod (row[13]) efter row[13]/row[24]-rettelsen', () => {
  // Regressionstest for selve bugfixet: en række med et cod-tal på
  // position 13, men INTET tærskel-tal på position 24 — thresholdMm skal
  // være null, IKKE den (forkerte) cod-værdi.
  const row = [55.0, 12.0, 'Test', 0, 0, 500, 10, 0, 'outfall-id', 1.5, 'type', 'SE', 2025, 312];
  const derived = derivePulsFields(row);
  assert.strictEqual(derived.thresholdMm, null);
});

// ── estimateLastEventAge — erstatning for Math.random() ─────────────────────
test('estimateLastEventAge: tom/manglende historik giver null (ikke 0 eller et gættet tal)', () => {
  assert.strictEqual(estimateLastEventAge([]), null);
  assert.strictEqual(estimateLastEventAge(null), null);
  assert.strictEqual(estimateLastEventAge(undefined), null);
});

test('estimateLastEventAge: ingen nedbør nogensinde i vinduet giver null', () => {
  const flat = new Array(168).fill(0); // 7 dage, ingen regn overhovedet
  assert.strictEqual(estimateLastEventAge(flat), null);
});

test('estimateLastEventAge: en kraftig regnbyge for PRÆCIS 24 timer siden giver ~1 dag', () => {
  const hours = new Array(168).fill(0);
  // Sidste indeks (167) = "nu". Kraftig byge 24 timer før nu = indeks 167-24=143.
  hours[143] = 15; // klart over den her eksplicit satte 5mm-tærskel på én gang
  // RETTET: kaldte tidligere estimateLastEventAge(hours) uden thresholdMm —
  // faldt da tilbage til DEFAULT_THRESHOLD_MM (25mm, se risk-model.js'
  // computeIntensityFactor()-filhoved for hvorfor den blev hævet fra 5mm),
  // som denne bygstyrke slet ikke krydsede. Testens EGEN kommentar ("5mm-
  // tærsklen") viser hensigten var altid et lavt, eksplicit testtærskel —
  // ikke appens produktions-fallback. Sætter nu tærsklen eksplicit, som
  // udløbs-specifikke tærskler altid gør i den rigtige risikoløkke.
  const age = estimateLastEventAge(hours, 5);
  assert.ok(age !== null, 'forventede et fund, fik null');
  assert.ok(Math.abs(age - 1.0) < 0.05, `forventede ~1,0 dag, fik ${age}`);
});

test('estimateLastEventAge: finder det SENESTE udløsningspunkt, ikke det tidligste', () => {
  const hours = new Array(168).fill(0);
  hours[20]  = 20; // en tidlig, kraftig byge langt tilbage
  hours[160] = 8;  // en NYERE byge, også over tærsklen (167-160=7 timer siden)
  const age = estimateLastEventAge(hours);
  assert.ok(age < 0.5, `forventede den NYESTE hændelse (~0,3 dage), fik ${age} — fandt muligvis den forkerte (ældste)`);
});

test('estimateLastEventAge: mange små regnbyger der akkumulerer over tærsklen tælles også med (ikke kun én stor byge)', () => {
  const hours = new Array(168).fill(0);
  // 5 timer i træk med 1,5mm hver, tæt på hinanden -> akkumuleret over 5mm samlet, henfald er minimalt over få timer
  for (let i = 150; i < 155; i++) hours[i] = 1.5;
  // RETTET: samme årsag som testen ovenfor — uden en eksplicit tærskel
  // faldt kaldet tilbage til DEFAULT_THRESHOLD_MM (25mm), som denne
  // ~7,5mm samlede regnmængde aldrig krydsede. Se dens kommentar for fuld
  // begrundelse.
  const age = estimateLastEventAge(hours, 5);
  assert.ok(age !== null, 'forventede at den akkumulerede regn udløste tærsklen');
});

test('estimateLastEventAge: er deterministisk (samme input giver samme output hver gang — modsat den tidligere Math.random())', () => {
  const hours = new Array(168).fill(0);
  hours[100] = 12;
  const a = estimateLastEventAge(hours);
  const b = estimateLastEventAge(hours);
  const c = estimateLastEventAge(hours);
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

// ── computeViralRisk / computeForecastViralRisk ──────────────────────────────
test('computeViralRisk: intet vejrdata giver null', () => {
  const { computeViralRisk } = require('./risk-model');
  assert.strictEqual(computeViralRisk({ overflowProbBase: 0.5, meanVolumePerEvent: 1000, precipMM: null }), null);
});

test('computeViralRisk: ingen nedbør giver ~0 risiko', () => {
  const { computeViralRisk } = require('./risk-model');
  const r = computeViralRisk({ overflowProbBase: 0.5, meanVolumePerEvent: 1000, precipMM: 0, lastEventAge: null });
  assert.ok(r < 0.01, `forventede tæt på 0, fik ${r}`);
});

test('computeForecastViralRisk: lægger forecastMM oveni, som den bakterielle udgave', () => {
  const { computeForecastViralRisk } = require('./risk-model');
  const pt = { overflowProbBase: 0.5, meanVolumePerEvent: 1000, precipMM: 2, lastEventAge: null };
  const low  = computeForecastViralRisk({ ...pt, forecastMM: 0 });
  const high = computeForecastViralRisk({ ...pt, forecastMM: 20 });
  assert.ok(high > low, `forventede højere viral prognoserisiko med mere regn: ${low} vs ${high}`);
});

// ── Badested-gruppe-aggregering (samme princip som sendPushNotifications() i server.js) ──
test('badested-aggregering: samlet risiko er max af bakteriel/viral på tværs af gruppens udløb', () => {
  const pointRisks = new Map([
    ['1', { foreRisk: 0.20, foreViralRisk: 0.10, hasRain: true }],
    ['2', { foreRisk: 0.45, foreViralRisk: 0.15, hasRain: true }], // højeste bakterielle
    ['3', { foreRisk: 0.05, foreViralRisk: 0.60, hasRain: false }], // højeste viral, men ingen regn her
  ]);
  const group = { name: 'Testbadestrand', pulsIds: ['1', '2', '3'] };
  let maxRisk = 0, hasRain = false;
  for (const id of group.pulsIds) {
    const pr = pointRisks.get(id);
    maxRisk = Math.max(maxRisk, pr.foreRisk || 0, pr.foreViralRisk || 0);
    if (pr.hasRain) hasRain = true;
  }
  assert.strictEqual(maxRisk, 0.60, 'skal finde den højeste værdi på tværs af BÅDE bakteriel og viral, uanset hvilket udløb den kommer fra');
  assert.strictEqual(hasRain, true, 'mindst ét udløb i gruppen har regn, så hasRain skal være true for hele gruppen');
});

test('riskBucket: matcher riskLabel()/riskStyle()s tærskler (0.6/0.2), null giver ingen-data', () => {
  assert.strictEqual(riskBucket(null), 'ingen-data');
  assert.strictEqual(riskBucket(undefined), 'ingen-data');
  assert.strictEqual(riskBucket(0.6), 'roed');
  assert.strictEqual(riskBucket(0.75), 'roed');
  assert.strictEqual(riskBucket(0.2), 'gul');
  assert.strictEqual(riskBucket(0.59), 'gul');
  assert.strictEqual(riskBucket(0), 'groen');
  assert.strictEqual(riskBucket(0.19), 'groen');
});

test('shouldLogTransition: første observation (prevBucket ukendt) logges IKKE', () => {
  assert.strictEqual(shouldLogTransition(undefined, 'roed'), false);
  assert.strictEqual(shouldLogTransition(null, 'gul'), false);
});

test('shouldLogTransition: reelt skift logges', () => {
  assert.strictEqual(shouldLogTransition('groen', 'gul'), true);
  assert.strictEqual(shouldLogTransition('gul', 'roed'), true);
  assert.strictEqual(shouldLogTransition('roed', 'groen'), true);
});

test('shouldLogTransition: uændret bucket logges IKKE', () => {
  assert.strictEqual(shouldLogTransition('groen', 'groen'), false);
  assert.strictEqual(shouldLogTransition('roed', 'roed'), false);
});

test('shouldLogTransition: skift til/fra ingen-data tæller også som et skift', () => {
  assert.strictEqual(shouldLogTransition('groen', 'ingen-data'), true);
  assert.strictEqual(shouldLogTransition('ingen-data', 'gul'), true);
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
