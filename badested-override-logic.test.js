#!/usr/bin/env node
// badested-override-logic.test.js — kør fra repo-roden:
//   node badested-override-logic.test.js
// Rene enhedstests — INGEN database, INGEN netværkskald. BEVIDST aldrig et
// require af badested-overrides.js (den fil udfører et REELT databasekald
// ved import, se dens "Filopdeling"-afsnit).

'use strict';
const assert = require('assert');
const {
  OVERRIDE_BUCKETS, isValidBucket, MAX_OVERRIDE_DURATION_HOURS,
  isOverrideRowActive, patchBadevandEntry,
} = require('./badested-override-logic');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

// ── isValidBucket ──────────────────────────────────────────────────────────
test('isValidBucket: alle fire kendte buckets accepteres', () => {
  for (const b of OVERRIDE_BUCKETS) assert.strictEqual(isValidBucket(b), true);
});
test('isValidBucket: ukendt/tomt/undefined afvises', () => {
  assert.strictEqual(isValidBucket('blaa'), false);
  assert.strictEqual(isValidBucket(''), false);
  assert.strictEqual(isValidBucket(undefined), false);
});

// ── isOverrideRowActive ────────────────────────────────────────────────────
test('isOverrideRowActive: gyldig, ikke-udløbet, ikke-tilbagekaldt række er aktiv', () => {
  const row = { revoked_at: null, expires_at: new Date(Date.now() + 3600000) };
  assert.strictEqual(isOverrideRowActive(row), true);
});
test('isOverrideRowActive: udløbet række er IKKE aktiv', () => {
  const row = { revoked_at: null, expires_at: new Date(Date.now() - 1000) };
  assert.strictEqual(isOverrideRowActive(row), false);
});
test('isOverrideRowActive: tilbagekaldt række er IKKE aktiv, selvom den ikke er udløbet endnu', () => {
  const row = { revoked_at: new Date(), expires_at: new Date(Date.now() + 3600000) };
  assert.strictEqual(isOverrideRowActive(row), false);
});
test('isOverrideRowActive: null/undefined giver false uden at kaste', () => {
  assert.strictEqual(isOverrideRowActive(null), false);
  assert.strictEqual(isOverrideRowActive(undefined), false);
});

// ── patchBadevandEntry ─────────────────────────────────────────────────────
const baseEntry = { id: 'DKBW1', bact: 0.1, viral: 0.05, algae: 0.2, forecast: 0.1, source: 'kystvand', outlets: [] };

test('patchBadevandEntry: ingen overrideRow → entry returneres UÆNDRET (samme reference)', () => {
  const result = patchBadevandEntry(baseEntry, null);
  assert.strictEqual(result, baseEntry);
});
test('patchBadevandEntry: udløbet overrideRow → entry returneres uændret', () => {
  const expired = { bucket: 'roed', message: 'Lukket', tenant_name: 'Testby', logo_url: null,
    created_at: new Date(), expires_at: new Date(Date.now() - 1000), revoked_at: null };
  const result = patchBadevandEntry(baseEntry, expired);
  assert.strictEqual(result, baseEntry);
});
test('patchBadevandEntry: aktiv "roed"-overstyring tilføjer KUN overrideInfo — bact/viral/source UÆNDREDE', () => {
  const active = { bucket: 'roed', message: 'Forhøjet bakterieindhold', tenant_name: 'Testby Kommune', logo_url: 'https://example.com/logo.png',
    created_at: new Date('2026-07-01'), expires_at: new Date(Date.now() + 3600000), revoked_at: null };
  const result = patchBadevandEntry(baseEntry, active);
  assert.strictEqual(result.bact, baseEntry.bact);
  assert.strictEqual(result.viral, baseEntry.viral);
  assert.strictEqual(result.source, baseEntry.source);
  assert.deepStrictEqual(result.overrideInfo, {
    bucket: 'roed', message: 'Forhøjet bakterieindhold', tenantName: 'Testby Kommune',
    logoUrl: 'https://example.com/logo.png', setAt: active.created_at, expiresAt: active.expires_at,
  });
});
test('patchBadevandEntry: "lukket"-overstyring rører HELLER IKKE bact/viral — kun banneret viser "Lukket"', () => {
  const active = { bucket: 'lukket', message: 'Badestedet er lukket', tenant_name: 'Testby Kommune', logo_url: null,
    created_at: new Date(), expires_at: new Date(Date.now() + 3600000), revoked_at: null };
  const result = patchBadevandEntry(baseEntry, active);
  assert.strictEqual(result.bact, baseEntry.bact);
  assert.strictEqual(result.viral, baseEntry.viral);
  assert.strictEqual(result.overrideInfo.bucket, 'lukket');
});
test('patchBadevandEntry: alle ANDRE felter (algae, forecast, outlets, id) forbliver UÆNDREDE', () => {
  const active = { bucket: 'gul', message: 'Test', tenant_name: 'Testby', logo_url: null,
    created_at: new Date(), expires_at: new Date(Date.now() + 3600000), revoked_at: null };
  const result = patchBadevandEntry(baseEntry, active);
  assert.strictEqual(result.algae, baseEntry.algae);
  assert.strictEqual(result.forecast, baseEntry.forecast);
  assert.strictEqual(result.outlets, baseEntry.outlets);
  assert.strictEqual(result.id, baseEntry.id);
});
test('patchBadevandEntry: manglende logo_url giver logoUrl:null (ikke undefined)', () => {
  const active = { bucket: 'groen', message: 'Test', tenant_name: 'Testby', logo_url: null,
    created_at: new Date(), expires_at: new Date(Date.now() + 3600000), revoked_at: null };
  const result = patchBadevandEntry(baseEntry, active);
  assert.strictEqual(result.overrideInfo.logoUrl, null);
});
test('patchBadevandEntry: ukendt bucket-værdi (fx en fremtidig, ikke-understøttet type) fejler LUKKET (entry uændret), ikke crash', () => {
  const active = { bucket: 'ukendt-fremtidig-type', message: 'Test', tenant_name: 'Testby', logo_url: null,
    created_at: new Date(), expires_at: new Date(Date.now() + 3600000), revoked_at: null };
  const result = patchBadevandEntry(baseEntry, active);
  assert.strictEqual(result, baseEntry);
});

test('MAX_OVERRIDE_DURATION_HOURS: er 30 dage (720 timer)', () => {
  assert.strictEqual(MAX_OVERRIDE_DURATION_HOURS, 720);
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
