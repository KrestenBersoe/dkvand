#!/usr/bin/env node
// calibrate-overflow-model.test.js — kør fra repo-roden:
//   node scripts/calibrate-overflow-model.test.js
// Rene enhedstests, syntetiske fixtures, INGEN netværkskald eller læsning
// af puls-data.json/puls-outlet-precip-history.json.

'use strict';
const assert = require('assert');
const {
  classifySewerType, fnv1aHash, assignPartition, mulberry32,
  predictPositive, evaluateCombo, rankAUC, gridSearch, percentileCI, bootstrapCI,
  effectivePeakCutoffMm,
} = require('./calibrate-overflow-model.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

// ── classifySewerType ────────────────────────────────────────────────────
test('classifySewerType: Overløbsbygværk-typer klassificeres som combined_sewer_overflow', () => {
  assert.strictEqual(classifySewerType('Overløbsbygværk med bassin'), 'combined_sewer_overflow');
  assert.strictEqual(classifySewerType('Overløbsbygværk uden bassin'), 'combined_sewer_overflow');
});
test('classifySewerType: Separat regnvand-typer klassificeres som separate_stormwater', () => {
  assert.strictEqual(classifySewerType('Separat regnvand med bassin'), 'separate_stormwater');
});
test('classifySewerType: ukendt/null type falder til andet_or_unknown', () => {
  assert.strictEqual(classifySewerType('Andet'), 'andet_or_unknown');
  assert.strictEqual(classifySewerType(null), 'andet_or_unknown');
});

// ── fnv1aHash / assignPartition ──────────────────────────────────────────
test('fnv1aHash: deterministisk — samme input giver samme output', () => {
  assert.strictEqual(fnv1aHash('56.6250:9.7500'), fnv1aHash('56.6250:9.7500'));
});
test('assignPartition: deterministisk og giver kun train/test', () => {
  const p1 = assignPartition('56.6250:9.7500');
  const p2 = assignPartition('56.6250:9.7500');
  assert.strictEqual(p1, p2);
  assert.ok(p1 === 'train' || p1 === 'test');
});
test('assignPartition: fordeling over mange nøgler er groft ~80/20', () => {
  let train = 0, test = 0;
  for (let i = 0; i < 2000; i++) {
    (assignPartition(`celle-${i}`) === 'train' ? train++ : test++);
  }
  const testShare = test / (train + test);
  assert.ok(testShare > 0.12 && testShare < 0.28, `test-andel ${testShare} for langt fra ~20%`);
});

// ── mulberry32 ────────────────────────────────────────────────────────────
test('mulberry32: samme seed giver samme sekvens', () => {
  const a = mulberry32(42), b = mulberry32(42);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  assert.deepStrictEqual(seqA, seqB);
});
test('mulberry32: værdier er i [0,1)', () => {
  const rng = mulberry32(1);
  for (let i = 0; i < 100; i++) { const v = rng(); assert.ok(v >= 0 && v < 1, `${v} uden for [0,1)`); }
});

// ── predictPositive / evaluateCombo ──────────────────────────────────────
test('predictPositive: kraftigt peak langt over tærsklen forudsiger positiv', () => {
  assert.strictEqual(predictPositive(100, 10, 3, 1), true);
});
test('predictPositive: intet nedbør (0mm) forudsiger negativ', () => {
  assert.strictEqual(predictPositive(0, 10, 3, 1), false);
});

test('evaluateCombo: perfekt separation giver precision=recall=1', () => {
  const records = [
    { peakMaxMm: 50, label: 1 }, { peakMaxMm: 60, label: 1 },
    { peakMaxMm: 2, label: 0 }, { peakMaxMm: 3, label: 0 },
  ];
  const result = evaluateCombo(records, 20, 3, 1);
  assert.strictEqual(result.precision, 1);
  assert.strictEqual(result.recall, 1);
  assert.strictEqual(result.tp, 2);
  assert.strictEqual(result.fp, 0);
});

test('evaluateCombo: ingen forudsagte positive giver precision=null (0/0), recall=0', () => {
  const records = [{ peakMaxMm: 1, label: 1 }, { peakMaxMm: 1, label: 0 }];
  const result = evaluateCombo(records, 1000, 1, 1);
  assert.strictEqual(result.precision, null);
  assert.strictEqual(result.recall, 0);
});

// ── rankAUC ───────────────────────────────────────────────────────────────
test('rankAUC: perfekt separation giver AUC=1', () => {
  const records = [
    { peakMaxMm: 50, label: 1 }, { peakMaxMm: 60, label: 1 },
    { peakMaxMm: 2, label: 0 }, { peakMaxMm: 3, label: 0 },
  ];
  assert.strictEqual(rankAUC(records), 1);
});
test('rankAUC: perfekt INVERTERET separation giver AUC=0', () => {
  const records = [
    { peakMaxMm: 2, label: 1 }, { peakMaxMm: 3, label: 1 },
    { peakMaxMm: 50, label: 0 }, { peakMaxMm: 60, label: 0 },
  ];
  assert.strictEqual(rankAUC(records), 0);
});
test('rankAUC: ingen positive eller ingen negative giver null', () => {
  assert.strictEqual(rankAUC([{ peakMaxMm: 1, label: 1 }]), null);
});
test('rankAUC: identiske scores på tværs af klasser giver AUC≈0,5', () => {
  const records = [
    { peakMaxMm: 10, label: 1 }, { peakMaxMm: 10, label: 0 },
    { peakMaxMm: 10, label: 1 }, { peakMaxMm: 10, label: 0 },
  ];
  assert.strictEqual(rankAUC(records), 0.5);
});

// ── gridSearch ────────────────────────────────────────────────────────────
test('gridSearch: finder en kombination der adskiller et klart separerbart datasæt', () => {
  const records = [];
  for (let i = 0; i < 20; i++) records.push({ peakMaxMm: 40 + i, label: 1 });
  for (let i = 0; i < 20; i++) records.push({ peakMaxMm: 1 + i * 0.1, label: 0 });
  const best = gridSearch(records);
  assert.ok(best, 'forventede et resultat');
  assert.ok(best.result.balancedAccuracy > 0.9, `balancedAccuracy ${best.result.balancedAccuracy} for lav for et klart separerbart datasæt`);
});

// ── percentileCI / bootstrapCI ───────────────────────────────────────────
test('percentileCI: tom liste giver null', () => {
  assert.strictEqual(percentileCI([]), null);
});
test('percentileCI: kendt fordeling giver fornuftige grænser', () => {
  const values = Array.from({ length: 100 }, (_, i) => i / 99); // 0..1 jævnt fordelt
  const ci = percentileCI(values);
  assert.ok(ci.lo < 0.1 && ci.hi > 0.9, `CI [${ci.lo}, ${ci.hi}] dækker ikke forventet spredning`);
});

test('bootstrapCI: deterministisk med samme seed', () => {
  const records = [];
  for (let i = 0; i < 20; i++) records.push({ peakMaxMm: 40 + i, label: 1 });
  for (let i = 0; i < 20; i++) records.push({ peakMaxMm: 1 + i * 0.1, label: 0 });
  const ciA = bootstrapCI(records, 20, 3, 1, 200, mulberry32(7));
  const ciB = bootstrapCI(records, 20, 3, 1, 200, mulberry32(7));
  assert.deepStrictEqual(ciA, ciB);
});

// ── effectivePeakCutoffMm ─────────────────────────────────────────────────
test('effectivePeakCutoffMm: multiplier=0 giver Infinity (udløser aldrig)', () => {
  assert.strictEqual(effectivePeakCutoffMm(10, 0, 1), Infinity);
});
test('effectivePeakCutoffMm: lav multiplier der aldrig når cutoff giver Infinity', () => {
  assert.strictEqual(effectivePeakCutoffMm(2, 0.5, 1), Infinity);
});
test('effectivePeakCutoffMm: den fundne grænse udløser score>=cutoff, lige under gør ikke', () => {
  const riskModel = require('../risk-model');
  const cutoffMm = effectivePeakCutoffMm(10, 3, 1);
  assert.ok(Number.isFinite(cutoffMm));
  assert.ok(riskModel.computeIntensityFactor(cutoffMm, 10) * 3 >= 1 - 1e-6);
  assert.ok(riskModel.computeIntensityFactor(cutoffMm - 1, 10) * 3 < 1);
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
