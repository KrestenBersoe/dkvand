#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// check-site-match.js — match-quality check: does schema-map-edm.js's
// free-text "Bathing Water" column (Southern Water's own naming) resolve
// to a real EA sampling point in fetch-ea-samples.js's ea-sites.json?
// Read-only diagnostic, NOT the join itself — answers "is name-matching
// viable, and how well" before that join gets built on top of it.
//
// Kør fra ukwater-repo/ (denne mappe), EFTER at have kørt BÅDE
// schema-map-edm.js OG fetch-ea-samples.js (begge skriver som standard til
// ./output/, se hver fils --out-dir):
//   node check-site-match.js --csv <path-to-full-release-history.csv>
//   node check-site-match.js               # genbruger ./output/edm-*.ndjson hvis de allerede findes
//   node check-site-match.js --dir DIR --out-report DIR/site-match-report.json
//
// ── Why this exists as its own step, not folded into a future join script ─
// Validated first against a 500-row REAL sample (not synthetic): 37/40
// (92.5%) of distinct Bathing Water names resolved to exactly one EA site,
// with genuinely ambiguous cases (Brighton Central, Herne Bay Central,
// Hove, Littlehampton, Worthing) cleanly broken by the discharge outfall's
// own lat/lng distance to each candidate. Two names (Chichester Harbour,
// Langstone Harbour) had NO EA counterpart at all — confirmed against the
// live API, not a matching bug: those are shellfish-water/estuarine sites
// (samplingPointType CC/CE), outside the Bathing Water Directive's scope
// entirely, so no compliance sample will ever exist for them from this
// source. That 40-name check was necessarily small (the 500-row sample has
// only 236 distinct events); this script runs the SAME logic against your
// real, full local file to get the true whole-dataset picture.
//
// ── Matching algorithm ────────────────────────────────────────────────────
// 1. Normalize both sides: uppercase, strip trailing "(NNNNN)" site-
//    reference codes, strip "EC BATHING WATER"/"BATHING WATER" boilerplate,
//    collapse punctuation to spaces.
// 2. Exact match against EA's prefLabel OR altLabel.
// 3. If no exact match: substring match (either direction) against the
//    same normalized labels.
// 4. If a name matches more than one EA site: prefer OPEN status over any
//    other status; if that's still tied, prefer the candidate nearest to
//    the EDM event's own outfall lat/lng (haversine), but only treat it as
//    RESOLVED if the nearest candidate is meaningfully closer than the
//    runner-up (--min-distance-gap-km, default 0.3km) — a 0.16km gap (the
//    real Eastbourne case found during validation) is noise, not signal.
// 5. No candidate at all: reported as NO MATCH, never silently dropped.
//
// ── Output ──────────────────────────────────────────────────────────────
// Console summary (counts by match category) plus two files:
//   <out-dir>/site-match-report.json   — full per-name detail, every
//                                          candidate considered, distances,
//                                          match category — for review.
//   <out-dir>/site-match-lookup.json   — bathingWaterName -> EA site
//                                          notation, ONLY for names that
//                                          resolved unambiguously (directly
//                                          or via a confident tiebreak).
//                                          A byproduct of this same check,
//                                          not yet wired into any join —
//                                          saved so the eventual join
//                                          script doesn't have to
//                                          re-derive it.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIR = path.resolve(argVal('--dir', path.join(__dirname, 'output')));
const EVENTS_PATH = path.resolve(argVal('--events', path.join(DIR, 'edm-events.ndjson')));
const IMPACTS_PATH = path.resolve(argVal('--impacts', path.join(DIR, 'edm-impacts.ndjson')));
const SITES_PATH = path.resolve(argVal('--sites', path.join(DIR, 'ea-sites.json')));
const REPORT_PATH = path.resolve(argVal('--out-report', path.join(DIR, 'site-match-report.json')));
const LOOKUP_PATH = path.resolve(argVal('--out-lookup', path.join(DIR, 'site-match-lookup.json')));
const MIN_DISTANCE_GAP_KM = parseFloat(argVal('--min-distance-gap-km', '0.3'));

for (const [label, p] of [['edm-events.ndjson', EVENTS_PATH], ['edm-impacts.ndjson', IMPACTS_PATH], ['ea-sites.json', SITES_PATH]]) {
  if (!fs.existsSync(p)) {
    console.error(`Mangler ${label} (${p}).`);
    console.error('Kør først: node schema-map-edm.js --csv <release-history.csv>  (skriver edm-events.ndjson/edm-impacts.ndjson)');
    console.error('       og: node fetch-ea-samples.js  (skriver ea-sites.json)');
    console.error('— begge skriver som standard til ./output/, se hver fils --out-dir hvis du har flyttet dem.');
    process.exit(1);
  }
}

function normalize(s) {
  return s
    .toUpperCase()
    .replace(/\(\s*\d+\s*\)/g, '')
    .replace(/\bEC BATHING WATER\b/g, '')
    .replace(/\bBATHING WATER\b/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function readNdjson(p) {
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

async function main() {
  console.log(`Læser ${EVENTS_PATH}...`);
  const events = await readNdjson(EVENTS_PATH);
  console.log(`Læser ${IMPACTS_PATH}...`);
  const impacts = await readNdjson(IMPACTS_PATH);
  console.log(`Læser ${SITES_PATH}...`);
  const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
  console.log(`${events.length.toLocaleString('en')} hændelser, ${impacts.length.toLocaleString('en')} impact-vurderinger, ${sites.length} EA-stationer.\n`);

  const eventById = new Map(events.map((e) => [e.eventId, e]));

  // bathingWater name -> array of outfall {outfall,lat,lng} that discharged
  // an impact against it (one entry per distinct outfall, not per event —
  // an outfall firing 500 times still only tells us its location once).
  const nameToOutfalls = new Map();
  for (const im of impacts) {
    if (!im.bathingWater) continue;
    const ev = eventById.get(im.eventId);
    if (!ev || ev.lat == null || ev.lng == null) continue;
    if (!nameToOutfalls.has(im.bathingWater)) nameToOutfalls.set(im.bathingWater, new Map());
    nameToOutfalls.get(im.bathingWater).set(ev.outfall, { outfall: ev.outfall, lat: ev.lat, lng: ev.lng });
  }

  const byNorm = new Map(); // normalized label -> [{site, field}]
  for (const s of sites) {
    for (const [field, val] of [['prefLabel', s.prefLabel], ['altLabel', s.altLabel]]) {
      const n = normalize(val || '');
      if (!n) continue;
      if (!byNorm.has(n)) byNorm.set(n, []);
      byNorm.get(n).push({ site: s, field });
    }
  }

  const names = [...nameToOutfalls.keys()].sort();
  const report = [];
  const lookup = {};
  const counts = {
    exactUnambiguous: 0,
    resolvedByStatus: 0,
    resolvedByDistance: 0,
    unresolvedAmbiguous: 0,
    noMatch: 0,
  };

  for (const name of names) {
    const n = normalize(name);
    const outfalls = [...nameToOutfalls.get(name).values()];
    const repPt = outfalls[0];

    let candidates = byNorm.get(n);
    let matchKind = 'exact';
    if (!candidates) {
      matchKind = 'substring';
      const seen = new Set();
      candidates = [];
      for (const s of sites) {
        const np = normalize(s.prefLabel || '');
        const na = normalize(s.altLabel || '');
        if ((np && (np.includes(n) || n.includes(np))) || (na && (na.includes(n) || n.includes(na)))) {
          if (!seen.has(s.notation)) { seen.add(s.notation); candidates.push({ site: s, field: (np.includes(n) || n.includes(np)) ? 'prefLabel' : 'altLabel' }); }
        }
      }
    }

    if (candidates.length === 0) {
      counts.noMatch++;
      report.push({ edmName: name, outfallCount: outfalls.length, matchKind: 'none', resolution: 'no_match', candidates: [] });
      continue;
    }

    const uniqueSites = [...new Map(candidates.map((c) => [c.site.notation, c])).values()];
    const withDist = uniqueSites.map((c) => ({
      site: c.site,
      field: c.field,
      distKm: c.site.lat != null && repPt ? haversineKm(repPt.lat, repPt.lng, c.site.lat, c.site.lng) : null,
    }));

    if (uniqueSites.length === 1) {
      const c = withDist[0];
      counts.exactUnambiguous++;
      lookup[name] = c.site.notation;
      report.push({
        edmName: name, outfallCount: outfalls.length, matchKind, resolution: 'unambiguous',
        matchedSite: c.site.notation, matchedLabel: c.site.prefLabel, matchedField: c.field,
        distanceKm: c.distKm, siteStatus: c.site.status,
        candidates: withDist.map((w) => ({ notation: w.site.notation, prefLabel: w.site.prefLabel, status: w.site.status, distanceKm: w.distKm })),
      });
      continue;
    }

    // Tiebreak 1: prefer OPEN status.
    const openOnes = withDist.filter((c) => c.site.status === 'O');
    let pool = openOnes.length > 0 ? openOnes : withDist;
    let resolvedBy = openOnes.length > 0 && openOnes.length < withDist.length ? 'status' : null;

    pool = [...pool].sort((a, b) => (a.distKm ?? 1e9) - (b.distKm ?? 1e9));
    const nearest = pool[0];
    const runnerUp = pool[1];
    const gapKm = runnerUp && nearest.distKm != null && runnerUp.distKm != null ? runnerUp.distKm - nearest.distKm : null;

    if (pool.length === 1) {
      counts.resolvedByStatus++;
      lookup[name] = nearest.site.notation;
      report.push({
        edmName: name, outfallCount: outfalls.length, matchKind, resolution: 'resolved_by_status',
        matchedSite: nearest.site.notation, matchedLabel: nearest.site.prefLabel, matchedField: nearest.field,
        distanceKm: nearest.distKm, siteStatus: nearest.site.status,
        candidates: withDist.map((w) => ({ notation: w.site.notation, prefLabel: w.site.prefLabel, status: w.site.status, distanceKm: w.distKm })),
      });
    } else if (gapKm != null && gapKm >= MIN_DISTANCE_GAP_KM) {
      counts.resolvedByDistance++;
      lookup[name] = nearest.site.notation;
      report.push({
        edmName: name, outfallCount: outfalls.length, matchKind, resolution: resolvedBy === 'status' ? 'resolved_by_status_and_distance' : 'resolved_by_distance',
        matchedSite: nearest.site.notation, matchedLabel: nearest.site.prefLabel, matchedField: nearest.field,
        distanceKm: nearest.distKm, distanceGapKm: gapKm, siteStatus: nearest.site.status,
        candidates: withDist.map((w) => ({ notation: w.site.notation, prefLabel: w.site.prefLabel, status: w.site.status, distanceKm: w.distKm })),
      });
    } else {
      counts.unresolvedAmbiguous++;
      report.push({
        edmName: name, outfallCount: outfalls.length, matchKind, resolution: 'unresolved_ambiguous',
        distanceGapKm: gapKm,
        candidates: withDist.map((w) => ({ notation: w.site.notation, prefLabel: w.site.prefLabel, status: w.site.status, distanceKm: w.distKm })),
      });
    }
  }

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceEvents: EVENTS_PATH,
    sourceImpacts: IMPACTS_PATH,
    sourceSites: SITES_PATH,
    minDistanceGapKm: MIN_DISTANCE_GAP_KM,
    totalDistinctNames: names.length,
    counts,
    names: report,
  }, null, 2), 'utf8');
  fs.writeFileSync(LOOKUP_PATH, JSON.stringify(lookup, null, 2), 'utf8');

  const resolved = counts.exactUnambiguous + counts.resolvedByStatus + counts.resolvedByDistance;
  console.log('═══ Resultat ═══');
  console.log(`Distinkte "Bathing Water"-navne (med mindst ét stedfæstet udløb): ${names.length}`);
  console.log(`  Entydigt match (direkte): ${counts.exactUnambiguous}`);
  console.log(`  Løst via status-tiebreak (foretrækker OPEN): ${counts.resolvedByStatus}`);
  console.log(`  Løst via afstands-tiebreak (udløb -> nærmeste station): ${counts.resolvedByDistance}`);
  console.log(`  UAFKLARET (flertydigt, hverken status eller afstand skiller dem): ${counts.unresolvedAmbiguous}`);
  console.log(`  INTET match (ingen EA-station overhovedet): ${counts.noMatch}`);
  console.log(`\nSamlet: ${resolved}/${names.length} (${((resolved / names.length) * 100).toFixed(1)}%) navne løst entydigt.`);
  if (counts.unresolvedAmbiguous > 0 || counts.noMatch > 0) {
    console.log(`\n⚠ ${counts.unresolvedAmbiguous} uafklarede + ${counts.noMatch} uden match — se "resolution" i ${path.basename(REPORT_PATH)} for hvilke, og "candidates" for hvorfor.`);
  }
  console.log(`\nSkrevet: ${REPORT_PATH}  (fuld detalje pr. navn, til gennemsyn)`);
  console.log(`Skrevet: ${LOOKUP_PATH}  (kun de entydigt løste navne — biprodukt af dette tjek, IKKE endnu koblet til noget join)`);
}

main().catch((err) => {
  console.error('check-site-match fejlede:', err);
  process.exit(1);
});
