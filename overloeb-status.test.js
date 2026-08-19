'use strict';
const assert = require('assert');
const { computeOverloebStatusForTenant, bucketForBadested, resolveHorizonField } = require('./overloeb-status');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

test('resolveHorizonField: mapper nu/24h/72h til de korrekte felter, ukendt falder tilbage til nu', () => {
  assert.strictEqual(resolveHorizonField('nu'), 'riskScore');
  assert.strictEqual(resolveHorizonField('24h'), 'foreRisk');
  assert.strictEqual(resolveHorizonField('72h'), 'foreRisk72h');
  assert.strictEqual(resolveHorizonField('ukendt'), 'riskScore');
  assert.strictEqual(resolveHorizonField(undefined), 'riskScore');
});

test('bucketForBadested: aktiv override vinder over alt andet', () => {
  const bucket = bucketForBadested({ bact: 0.01, viral: 0.01, source: 'ingen-bekraeftet', overrideInfo: { bucket: 'roed' } });
  assert.strictEqual(bucket, 'roed');
});

test('bucketForBadested: server-utilgaengelig er ingen-data, uanset bact/viral', () => {
  assert.strictEqual(bucketForBadested({ bact: 0.9, viral: 0.9, source: 'server-utilgaengelig' }), 'ingen-data');
});

test('bucketForBadested: ingen-bekraeftet/nedstroms-bekraeftet er altid grøn', () => {
  assert.strictEqual(bucketForBadested({ bact: null, viral: null, source: 'ingen-bekraeftet' }), 'groen');
  assert.strictEqual(bucketForBadested({ bact: null, viral: null, source: 'nedstroms-bekraeftet' }), 'groen');
});

test('bucketForBadested: normal måling bruger max(bact,viral) mod 0.6/0.2-tærsklerne', () => {
  assert.strictEqual(bucketForBadested({ bact: 0.7, viral: 0.1, source: 'vandlob' }), 'roed');
  assert.strictEqual(bucketForBadested({ bact: 0.3, viral: null, source: 'vandlob' }), 'gul');
  assert.strictEqual(bucketForBadested({ bact: 0.05, viral: 0.01, source: 'vandlob' }), 'groen');
});

test('bucketForBadested: manglende entry (intet match i badevandList) giver ingen-data', () => {
  assert.strictEqual(bucketForBadested(null), 'ingen-data');
  assert.strictEqual(bucketForBadested(undefined), 'ingen-data');
});

const FIXTURE_POINTS = [
  { id: '1', name: 'Udløb A', lat: 55.1, lng: 12.1, municipality: 'Odense Kommune', isWastewater: true,  riskScore: 0.7, foreRisk: 0.8, foreRisk72h: 0.9, forecastMM: 3, todayMM: 1 },
  { id: '2', name: 'Udløb B', lat: 55.2, lng: 12.2, municipality: 'ODENSE',          isWastewater: false, riskScore: 0.3, foreRisk: 0.1, foreRisk72h: 0.2, forecastMM: 0, todayMM: 0 },
  { id: '3', name: 'Udløb C', lat: 55.3, lng: 12.3, municipality: 'Odense kommune',  isWastewater: true,  riskScore: 0.05, foreRisk: 0.05, foreRisk72h: 0.05, forecastMM: 0, todayMM: 0 },
  { id: '4', name: 'Udløb D (anden kommune)', lat: 56.0, lng: 10.0, municipality: 'Aarhus Kommune', isWastewater: true, riskScore: 0.9, foreRisk: 0.9, foreRisk72h: 0.9 },
  { id: '5', name: 'Udløb E (ingen kommune)', lat: 55.0, lng: 12.0, municipality: null, isWastewater: true, riskScore: null, foreRisk: null, foreRisk72h: null },
];

test('computeOverloebStatusForTenant: kommune-scoping matcher uanset kasing/kommune-suffiks, udelader andre kommuner', () => {
  const result = computeOverloebStatusForTenant({
    tenant: { name: 'Odense Kommune' },
    horizon: 'nu',
    riskScoresPoints: FIXTURE_POINTS,
    badevandList: [],
    tenantBadesteder: [],
  });
  assert.strictEqual(result.udloeb.length, 3, 'kun de tre Odense-punkter skal med, ikke Aarhus eller punktet uden kommune');
  assert.ok(result.udloeb.every(u => u.id !== '4' && u.id !== '5'));
});

test('computeOverloebStatusForTenant: horizon-parameteren vælger risikofelt (nu vs. 24h vs. 72h)', () => {
  const base = { tenant: { name: 'Odense' }, riskScoresPoints: FIXTURE_POINTS, badevandList: [], tenantBadesteder: [] };
  const nu  = computeOverloebStatusForTenant({ ...base, horizon: 'nu' }).udloeb.find(u => u.id === '1');
  const h24 = computeOverloebStatusForTenant({ ...base, horizon: '24h' }).udloeb.find(u => u.id === '1');
  const h72 = computeOverloebStatusForTenant({ ...base, horizon: '72h' }).udloeb.find(u => u.id === '1');
  assert.strictEqual(nu.risk, 0.7);
  assert.strictEqual(h24.risk, 0.8);
  assert.strictEqual(h72.risk, 0.9);
});

test('computeOverloebStatusForTenant: totals tæller rød/gul/grøn korrekt, ingen-data tælles separat', () => {
  const result = computeOverloebStatusForTenant({
    tenant: { name: 'Odense' }, horizon: 'nu', riskScoresPoints: FIXTURE_POINTS, badevandList: [], tenantBadesteder: [],
  });
  // Odense: id1 risk .7->roed, id2 risk .3->gul, id3 risk .05->groen
  assert.deepStrictEqual(result.totals, { roed: 1, gul: 1, groen: 1, ingenData: 0 });
});

test('computeOverloebStatusForTenant: varsler-listen indeholder kun gul/rød, sorteret højeste risiko først', () => {
  const result = computeOverloebStatusForTenant({
    tenant: { name: 'Odense' }, horizon: 'nu', riskScoresPoints: FIXTURE_POINTS, badevandList: [], tenantBadesteder: [],
  });
  assert.strictEqual(result.varsler.length, 2);
  assert.strictEqual(result.varsler[0].id, '1'); // .7, højest
  assert.strictEqual(result.varsler[1].id, '2'); // .3
});

test('computeOverloebStatusForTenant: badesteder joines mod badevandList på id og bucketes', () => {
  const result = computeOverloebStatusForTenant({
    tenant: { name: 'Odense' },
    horizon: 'nu',
    riskScoresPoints: [],
    badevandList: [{ id: 'DKBW1', bact: 0.7, viral: 0.1, source: 'vandlob' }],
    tenantBadesteder: [{ id: 'DKBW1', slug: 'test-strand', navn: 'Test Strand', lat: 55.1, lng: 12.1 }],
  });
  assert.strictEqual(result.badesteder.length, 1);
  assert.strictEqual(result.badesteder[0].bucket, 'roed');
  assert.strictEqual(result.badesteder[0].navn, 'Test Strand');
});

test('computeOverloebStatusForTenant: tom tenantBadesteder/riskScoresPoints giver tomme lister uden at kaste', () => {
  const result = computeOverloebStatusForTenant({ tenant: { name: 'Ukendt' }, horizon: 'nu', riskScoresPoints: [], badevandList: [], tenantBadesteder: [] });
  assert.deepStrictEqual(result.udloeb, []);
  assert.deepStrictEqual(result.badesteder, []);
  assert.deepStrictEqual(result.totals, { roed: 0, gul: 0, groen: 0, ingenData: 0 });
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
if (failed > 0) process.exit(1);
