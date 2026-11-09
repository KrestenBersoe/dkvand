'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// derived-index-guard.js — kontrol af indeks-afhængighed mellem puls-data.json
// og de afledte filer, der peger på udløb via RÆKKENUMMER (pulsPoints[].id).
//
// BAGGRUND (2026-11-09, kommune-henvendelsen): hubben synkroniserede en ny
// puls-data.json (21.715 rækker, ny rækkefølge), mens id15-lake-matches.json
// m.fl. forblev på den version, der var bagt ind i imaget (bygget mod en
// anden rækkefølge). Søer blev derved koblet til tilfældige udløb i hele
// landet (Gårdsvig Sø: median 117 km, maks 403 km). Ingen fejl, ingen alarm.
//
// Kontrollen kører to veje:
//   1. 'manifest': derived-index-manifest.json (skrevet af
//      scripts/write-derived-index-manifest.js som sidste skridt i
//      update-all-data.sh) indeholder rækkeantal + fingeraftryk af
//      puls-data.json's outfallId-kolonne i rækkefølge. Sammenlignes med de
//      punkter serveren FAKTISK scorer med (hukommelsen, ikke disken).
//   2. 'probe' (hvis manifestet mangler): geografisk selvkonsistens af
//      id15-lake-matches.json — udløb koblet til samme sø ligger tæt på
//      hinanden, når rækkefølgen passer, og spredt over hele landet ellers.
// ═══════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_FILE = 'derived-index-manifest.json';
const PROBE_MAX_PAIR_KM = 150;
const PROBE_MAX_BAD_SHARE = 0.05;

function fingerprintOutfallIds(ids) {
  const h = crypto.createHash('sha1');
  for (const id of ids) { h.update(String(id ?? '')); h.update('\n'); }
  return { count: ids.length, sha1: h.digest('hex') };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, p = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * p / 2) ** 2 +
            Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lng2 - lng1) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function probeLakeMatches(points, id15LakeMatches) {
  let pairs = 0, bad = 0;
  for (const entry of Object.values(id15LakeMatches || {})) {
    const pp = entry && entry.pulsPoints;
    if (!Array.isArray(pp) || pp.length < 2) continue;
    const a = points[pp[0].id];
    if (!a || a.lat == null) { pairs++; bad++; continue; }
    for (let i = 1; i < pp.length; i++) {
      const b = points[pp[i].id];
      pairs++;
      if (!b || b.lat == null || haversineKm(a.lat, a.lng, b.lat, b.lng) > PROBE_MAX_PAIR_KM) bad++;
    }
  }
  return { pairs, bad, share: pairs ? bad / pairs : 0 };
}

/**
 * @param {Array} points punkter som serveren scorer med (id = rækkeindeks, outfallId, lat, lng)
 * @returns {{ok:boolean, mode:string, reason:string|null}}
 */
function checkDerivedIndexes(points, staticDir, id15LakeMatches) {
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(staticDir, MANIFEST_FILE), 'utf8')); } catch { /* mangler */ }
  if (manifest && manifest.pulsFingerprint) {
    const fp = fingerprintOutfallIds(points.map(p => p.outfallId));
    if (fp.count !== manifest.pulsRowCount || fp.sha1 !== manifest.pulsFingerprint) {
      return { ok: false, mode: 'manifest',
        reason: `puls-data.json (${fp.count} rækker) passer ikke til de afledte filer (bygget mod ${manifest.pulsRowCount} rækker)` };
    }
    return { ok: true, mode: 'manifest', reason: null };
  }
  const pr = probeLakeMatches(points, id15LakeMatches);
  if (pr.share > PROBE_MAX_BAD_SHARE) {
    return { ok: false, mode: 'probe',
      reason: `derived-index-manifest.json mangler, og ${(pr.share * 100).toFixed(0)} % af sø-koblingerne (${pr.bad}/${pr.pairs}) peger >${PROBE_MAX_PAIR_KM} km fra søens øvrige udløb` };
  }
  return { ok: true, mode: 'probe', reason: null };
}

module.exports = { MANIFEST_FILE, fingerprintOutfallIds, probeLakeMatches, checkDerivedIndexes };
