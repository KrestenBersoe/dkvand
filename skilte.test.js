'use strict';
const assert = require('assert');
const { buildQrEps, buildQrMatrix } = require('./skilte');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

// Håndbygget 2×2-testmatrix (mørk ved (0,0) og (1,1), lys de to andre) —
// bevidst IKKE en rigtig QR-matrix fra buildQrMatrix(), for at holde denne
// test fuldt deterministisk og uafhængig af qrcode-bibliotekets interne
// opførsel — buildQrEps() skal virke for ethvert {size,data}-gitter.
const TEST_MATRIX = { size: 2, data: new Uint8Array([1, 0, 0, 1]) };

test('buildQrEps: starter med gyldig EPS-header', () => {
  const eps = buildQrEps(TEST_MATRIX, { sizeMm: 10 });
  assert.ok(eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0'), 'skal starte med EPS-magic-linjen');
});

test('buildQrEps: %%BoundingBox matcher sizeMm (72/25.4 pt pr. mm, oprundet)', () => {
  const eps = buildQrEps(TEST_MATRIX, { sizeMm: 10 });
  const expectedPt = Math.ceil(10 * 72 / 25.4); // 28,346... -> 29
  assert.ok(eps.includes(`%%BoundingBox: 0 0 ${expectedPt} ${expectedPt}`), `forventede BoundingBox 0 0 ${expectedPt} ${expectedPt}, fik:\n${eps}`);
});

test('buildQrEps: præcis ét rectfill pr. mørkt modul', () => {
  const eps = buildQrEps(TEST_MATRIX, { sizeMm: 10 });
  const rectfillCount = (eps.match(/rectfill/g) || []).length;
  assert.strictEqual(rectfillCount, 2, 'testmatrixen har 2 mørke moduler (1,0,0,1)');
});

test('buildQrEps: slutter med %%EOF', () => {
  const eps = buildQrEps(TEST_MATRIX, { sizeMm: 10 });
  assert.ok(eps.trimEnd().endsWith('%%EOF'));
});

test('buildQrEps: ingen mørke moduler giver INGEN rectfill-linjer (stadig gyldig EPS)', () => {
  const eps = buildQrEps({ size: 2, data: new Uint8Array([0, 0, 0, 0]) }, { sizeMm: 10 });
  assert.strictEqual((eps.match(/rectfill/g) || []).length, 0);
  assert.ok(eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0'));
});

test('buildQrMatrix: returnerer et kvadratisk gitter med mindst ét mørkt modul', () => {
  const matrix = buildQrMatrix('https://www.ditbadevand.dk/badested/test-strand');
  assert.strictEqual(matrix.data.length, matrix.size * matrix.size, 'data-længden skal matche size*size');
  assert.ok(Array.from(matrix.data).some(v => v === 1), 'en rigtig QR-kode har altid mindst ét mørkt modul');
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
if (failed > 0) process.exit(1);
