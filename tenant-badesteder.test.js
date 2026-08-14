#!/usr/bin/env node
// tenant-badesteder.test.js — kør fra repo-roden:
//   node tenant-badesteder.test.js
// Rene enhedstests — INGEN database, INGEN netværkskald, INGEN filsystem-
// læsning (kommuneKeyToBadesteder-Map'en konstrueres direkte i testen,
// ikke via slug-index.js's buildSlugIndex()).

'use strict';
const assert = require('assert');
const { resolveTenantBadesteder } = require('./tenant-badesteder');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

function fakeMap() {
  return new Map([
    ['odense', [
      { id: 'DKBW1', slug: 'strand-a-odense', navn: 'Strand A', lat: 1, lng: 2 },
      { id: 'DKBW2', slug: 'strand-b-odense', navn: 'Strand B', lat: 3, lng: 4 },
    ]],
    // NYT: "Københavns Kommune" har et genitiv-s i selve kommunenavnet —
    // normalizeKommuneKey() strippet KUN "kommune"-suffikset, ikke det 's',
    // så nøglen er bevidst "koebenhavns", ikke "koebenhavn" (bekræftet
    // mod reelle data: samme resultat for "KØBENHAVNS KOMMUNE").
    ['koebenhavns', [
      { id: 'DKBW3', slug: 'strand-c-koebenhavn', navn: 'Strand C', lat: 5, lng: 6 },
    ]],
  ]);
}

test('resolveTenantBadesteder: matcher "Odense Kommune" mod nøglen "odense"', () => {
  const result = resolveTenantBadesteder('Odense Kommune', fakeMap());
  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(result.map(b => b.id), ['DKBW1', 'DKBW2']);
});
test('resolveTenantBadesteder: case-insensitivt og uafhængigt af "kommune"-suffiks', () => {
  assert.strictEqual(resolveTenantBadesteder('ODENSE KOMMUNE', fakeMap()).length, 2);
  assert.strictEqual(resolveTenantBadesteder('odense', fakeMap()).length, 2);
  assert.strictEqual(resolveTenantBadesteder('Odense kommune', fakeMap()).length, 2);
});
test('resolveTenantBadesteder: matcher kun ÉT badested for en kommune med kun ét', () => {
  const result = resolveTenantBadesteder('Københavns Kommune', fakeMap());
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'DKBW3');
});
test('resolveTenantBadesteder: intet match giver TOM LISTE, ikke en fejl', () => {
  assert.deepStrictEqual(resolveTenantBadesteder('Ikke En Rigtig Kommune', fakeMap()), []);
});
test('resolveTenantBadesteder: tomt/manglende tenantName giver tom liste uden at kaste', () => {
  assert.deepStrictEqual(resolveTenantBadesteder('', fakeMap()), []);
  assert.deepStrictEqual(resolveTenantBadesteder(undefined, fakeMap()), []);
  assert.deepStrictEqual(resolveTenantBadesteder(null, fakeMap()), []);
});
test('resolveTenantBadesteder: manglende kommuneKeyToBadesteder giver tom liste uden at kaste', () => {
  assert.deepStrictEqual(resolveTenantBadesteder('Odense Kommune', undefined), []);
  assert.deepStrictEqual(resolveTenantBadesteder('Odense Kommune', null), []);
});
test('resolveTenantBadesteder: tom Map giver tom liste', () => {
  assert.deepStrictEqual(resolveTenantBadesteder('Odense Kommune', new Map()), []);
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
