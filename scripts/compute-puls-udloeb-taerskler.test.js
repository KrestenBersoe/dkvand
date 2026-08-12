#!/usr/bin/env node
// compute-puls-udloeb-taerskler.test.js — kør fra repo-roden:
//   node scripts/compute-puls-udloeb-taerskler.test.js
// Rene enhedstests, syntetiske fixtures, INGEN netværkskald eller læsning
// af puls-data.json/puls-outlet-precip-history.json.

'use strict';
const assert = require('assert');
const {
  collapsePeaks, sliceYear, deriveThresholdForOutlet, kNearestByArea, linearRegression, median,
} = require('./compute-puls-udloeb-taerskler.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

// ── collapsePeaks ────────────────────────────────────────────────────────
test('collapsePeaks: to peaks langt fra hinanden tælles begge', () => {
  const series = [0, 0, 5, 0, 0, 0, 0, 10, 0, 0];
  const peaks = collapsePeaks(series, 2);
  assert.strictEqual(peaks.length, 2, `forventede 2 peaks, fik ${peaks.length}`);
  assert.strictEqual(peaks[0].index, 7);
  assert.strictEqual(peaks[0].value, 10);
  assert.strictEqual(peaks[1].index, 2);
  assert.strictEqual(peaks[1].value, 5);
});

test('collapsePeaks: to peaks inden for vinduet kollapses til én (den højeste)', () => {
  const series = [0, 10, 0, 0, 12, 0, 0];
  const peaks = collapsePeaks(series, 5);
  assert.strictEqual(peaks.length, 1, `forventede 1 kollapset peak, fik ${peaks.length}`);
  assert.strictEqual(peaks[0].index, 4);
  assert.strictEqual(peaks[0].value, 12);
});

test('collapsePeaks: tom/ingen-regn serie giver ingen peaks', () => {
  const peaks = collapsePeaks([0, 0, 0, 0], 5);
  assert.strictEqual(peaks.length, 0);
});

test('collapsePeaks: peaks er sorteret faldende', () => {
  const series = [3, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 6];
  const peaks = collapsePeaks(series, 1);
  assert.strictEqual(peaks.length, 3);
  assert.ok(peaks[0].value >= peaks[1].value && peaks[1].value >= peaks[2].value, 'ikke faldende sorteret');
});

// ── sliceYear ────────────────────────────────────────────────────────────
test('sliceYear: fuldt kalenderår (ikke skudår) giver complete=true og 8760 timer', () => {
  const mm = new Array(8760 + 24).fill(0); // 2023 (365 dage) + lidt af 2024
  const result = sliceYear(mm, '2023-01-01T00:00', 2023);
  assert.ok(result, 'forventede et resultat, fik null');
  assert.strictEqual(result.complete, true);
  assert.strictEqual(result.slice.length, 8760);
});

test('sliceYear: skudår (2024) giver 8784 timer', () => {
  const mm = new Array(8760 + 8784).fill(0); // 2023 + 2024
  const result = sliceYear(mm, '2023-01-01T00:00', 2024);
  assert.ok(result);
  assert.strictEqual(result.complete, true);
  assert.strictEqual(result.slice.length, 8784);
});

test('sliceYear: år uden for det dækkede vindue giver null', () => {
  const mm = new Array(8760).fill(0); // kun 2023
  const result = sliceYear(mm, '2023-01-01T00:00', 2025);
  assert.strictEqual(result, null);
});

test('sliceYear: delvist dækket år (data slutter midt i året) markeres complete=false', () => {
  const mm = new Array(4000).fill(0); // kun ca. halvdelen af 2023
  const result = sliceYear(mm, '2023-01-01T00:00', 2023);
  assert.ok(result);
  assert.strictEqual(result.complete, false);
});

// ── deriveThresholdForOutlet ─────────────────────────────────────────────
function buildYearWithNStorms(hoursInYear, n, stormMm) {
  const mm = new Array(hoursInYear).fill(0);
  const spacing = Math.floor(hoursInYear / (n + 1));
  for (let i = 1; i <= n; i++) mm[i * spacing] = stormMm;
  return mm;
}

test('deriveThresholdForOutlet: udløb med under 3 hændelser udelades eksplicit', () => {
  const cellMm = new Array(8760 * 3).fill(0);
  const result = deriveThresholdForOutlet(2, cellMm, '2023-01-01T00:00', [2023, 2024, 2025]);
  assert.strictEqual(result.excluded, true);
  assert.strictEqual(result.reason, 'for_faa_haendelser');
});

test('deriveThresholdForOutlet: gyldigt udløb får en tærskel, tillidsgrad og årsliste', () => {
  const year2023 = buildYearWithNStorms(8760, 12, 15);
  const year2024 = buildYearWithNStorms(8784, 12, 18);
  const year2025 = buildYearWithNStorms(8760, 12, 12);
  const cellMm = [...year2023, ...year2024, ...year2025];
  const result = deriveThresholdForOutlet(12, cellMm, '2023-01-01T00:00', [2023, 2024, 2025]);
  assert.strictEqual(result.excluded, false);
  assert.strictEqual(result.confidence, 'high'); // N=12 >= 10
  assert.strictEqual(result.eventsUsed, 12);
  assert.strictEqual(result.yearsUsed.length, 3);
  assert.ok(result.thresholdMm > 0, 'tærskel bør være positiv');
});

test('deriveThresholdForOutlet: N=4 giver lav tillidsgrad (3-4-intervallet)', () => {
  const cellMm = buildYearWithNStorms(8760, 4, 10);
  const result = deriveThresholdForOutlet(4, cellMm, '2023-01-01T00:00', [2023]);
  assert.strictEqual(result.excluded, false);
  assert.strictEqual(result.confidence, 'low');
});

// ── kNearestByArea ───────────────────────────────────────────────────────
test('kNearestByArea: vælger de K nærmeste ved absolut arealdifferens', () => {
  const donors = [
    { outfallId: 'a', reducedArea: 1, thresholdMm: 10 },
    { outfallId: 'b', reducedArea: 2, thresholdMm: 20 },
    { outfallId: 'c', reducedArea: 3, thresholdMm: 30 },
    { outfallId: 'd', reducedArea: 10, thresholdMm: 100 },
  ];
  const result = kNearestByArea(2.5, null, donors, 2);
  assert.strictEqual(result.length, 2);
  const ids = result.map(r => r.donor.outfallId).sort();
  assert.deepStrictEqual(ids, ['b', 'c']);
});

test('kNearestByArea: vægtene summerer til 1 og den tætteste vejer mest', () => {
  const donors = [
    { outfallId: 'a', reducedArea: 2, thresholdMm: 10 },
    { outfallId: 'b', reducedArea: 5, thresholdMm: 20 },
  ];
  const result = kNearestByArea(2.1, null, donors, 2);
  const sumWeights = result.reduce((s, r) => s + r.weight, 0);
  assert.ok(Math.abs(sumWeights - 1) < 1e-9, `vægte summerer til ${sumWeights}, ikke 1`);
  const closest = result.find(r => r.donor.outfallId === 'a');
  const farthest = result.find(r => r.donor.outfallId === 'b');
  assert.ok(closest.weight > farthest.weight, 'nærmeste donor bør veje mest');
});

test('kNearestByArea: donorer uden reducedArea ekskluderes', () => {
  const donors = [
    { outfallId: 'a', reducedArea: null, thresholdMm: 10 },
    { outfallId: 'b', reducedArea: 3, thresholdMm: 20 },
  ];
  const result = kNearestByArea(3, null, donors, 2);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].donor.outfallId, 'b');
});

test('kNearestByArea: type-tie-break foretrækker samme kloaktype når nok findes', () => {
  const donors = [
    { outfallId: 'a', reducedArea: 2.4, type: 'X', thresholdMm: 10 },
    { outfallId: 'b', reducedArea: 2.6, type: 'X', thresholdMm: 20 },
    { outfallId: 'c', reducedArea: 2.5, type: 'Y', thresholdMm: 30 }, // tættest, men anden type
  ];
  const result = kNearestByArea(2.5, 'X', donors, 2);
  const ids = result.map(r => r.donor.outfallId).sort();
  assert.deepStrictEqual(ids, ['a', 'b'], 'burde foretrække de to X-donorer frem for den tættere Y-donor');
});

// ── linearRegression ─────────────────────────────────────────────────────
test('linearRegression: perfekt lineær sammenhæng giver a≈forventet, b≈forventet, r2≈1', () => {
  const xs = [1, 2, 3, 4, 5];
  const ys = xs.map(x => 2 * x + 1);
  const reg = linearRegression(xs, ys);
  assert.ok(Math.abs(reg.a - 1) < 1e-9, `a=${reg.a}`);
  assert.ok(Math.abs(reg.b - 2) < 1e-9, `b=${reg.b}`);
  assert.ok(Math.abs(reg.r2 - 1) < 1e-9, `r2=${reg.r2}`);
});

test('linearRegression: for få punkter giver null', () => {
  assert.strictEqual(linearRegression([1], [2]), null);
});

// ── median ───────────────────────────────────────────────────────────────
test('median: ulige antal værdier', () => {
  assert.strictEqual(median([5, 1, 3]), 3);
});

test('median: lige antal værdier (gennemsnit af de to midterste)', () => {
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
});

test('median: tom liste giver null', () => {
  assert.strictEqual(median([]), null);
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
