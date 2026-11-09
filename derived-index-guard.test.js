const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('./derived-index-guard');

const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ id: String(i), outfallId: 'g' + i, ...f(i) }));
const lakes = { A: { pulsPoints: [{ id: 0 }, { id: 1 }, { id: 2 }] } };
function tmp(manifest) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-'));
  if (manifest) fs.writeFileSync(path.join(d, g.MANIFEST_FILE), JSON.stringify(manifest));
  return d;
}

test('manifest: matcher fingeraftryk -> ok', () => {
  const pts = mk(5, i => ({ lat: 56, lng: 9 }));
  const fp = g.fingerprintOutfallIds(pts.map(p => p.outfallId));
  const r = g.checkDerivedIndexes(pts, tmp({ pulsRowCount: fp.count, pulsFingerprint: fp.sha1 }), lakes);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.mode, 'manifest');
});
test('manifest: ændret rækkefølge -> ikke ok', () => {
  const pts = mk(5, i => ({ lat: 56, lng: 9 }));
  const fp = g.fingerprintOutfallIds(pts.map(p => p.outfallId));
  const swapped = [pts[1], pts[0], ...pts.slice(2)];
  assert.strictEqual(g.checkDerivedIndexes(swapped, tmp({ pulsRowCount: fp.count, pulsFingerprint: fp.sha1 }), lakes).ok, false);
});
test('manifest: andet rækkeantal -> ikke ok', () => {
  const pts = mk(5, i => ({ lat: 56, lng: 9 }));
  const fp = g.fingerprintOutfallIds(pts.map(p => p.outfallId));
  assert.strictEqual(g.checkDerivedIndexes(pts.slice(0, 4), tmp({ pulsRowCount: fp.count, pulsFingerprint: fp.sha1 }), lakes).ok, false);
});
test('probe (uden manifest): nære udløb -> ok', () => {
  const pts = mk(3, i => ({ lat: 56 + i * 0.01, lng: 9 }));
  const r = g.checkDerivedIndexes(pts, tmp(null), lakes);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.mode, 'probe');
});
test('probe (uden manifest): udløb spredt >150 km -> ikke ok', () => {
  const pts = mk(3, i => ({ lat: 55 + i * 1.5, lng: 9 }));
  const r = g.checkDerivedIndexes(pts, tmp(null), lakes);
  assert.strictEqual(r.ok, false); assert.match(r.reason, /mangler/);
});
