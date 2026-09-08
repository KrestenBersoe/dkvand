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
// Validated against a 500-row sample (38/40, 95%), then against the real
// full 387,789-row file (82/87, 94.3%, run by the repo owner locally) —
// consistent at both scales. Genuinely ambiguous name collisions (Brighton
// Central, Herne Bay Central, Hove, Littlehampton, Worthing, Eastbourne)
// all resolve cleanly via OPEN-status and outfall-distance tiebreaks. Two
// categories of exception, found real, not hypothesized:
//   - NO EA counterpart at all: Chichester Harbour, Langstone Harbour —
//     confirmed against the live API as shellfish-water/estuarine sites
//     (samplingPointType CC/CE), outside the Bathing Water Directive's
//     scope entirely. No compliance sample will ever exist for these from
//     this source — a real coverage gap, not a matching bug.
//   - Matchable but NOT by substring: the full-file run surfaced 3 more
//     misses — "ST MARYS BAY (KENT)" (EA's label has no "KENT", Southern
//     Water added a county qualifier EA doesn't use), "WEST BAY WESTGATE"
//     (word order transposed vs EA's "WESTGATE BAY..."), and "STOKES LAKE"
//     (vs EA's "STOKES BAY" — a real semantic mismatch, "lake" ≠ "bay",
//     left unresolved on purpose, see tier 4 below). The token-overlap
//     tier added below fixed the first two; the third stayed unresolved
//     because it should — auto-matching two visibly different feature
//     types would be a silently wrong join, not a fixed one.
//
// ── Matching algorithm ────────────────────────────────────────────────────
// 1. Normalize both sides: uppercase, strip trailing "(NNNNN)" site-
//    reference codes, strip "EC BATHING WATER"/"BATHING WATER" boilerplate,
//    collapse punctuation to spaces.
// 2. Exact match against EA's prefLabel OR altLabel.
// 3. If no exact match: substring match (either direction) against the
//    same normalized labels.
// 4. If still nothing: order-independent word-overlap (tokenOverlapRatio()
//    below) — catches transposed or qualifier-augmented names substring
//    matching structurally can't (see "ST MARYS BAY (KENT)"/"WEST BAY
//    WESTGATE" above), at a tunable minimum overlap ratio
//    (--min-token-overlap, default 0.6) chosen so "STOKES LAKE" vs "STOKES
//    BAY" (ratio 0.5, real full-file case) stays BELOW it and is correctly
//    left unresolved rather than force-matched.
// 5. If a name matches more than one EA site: prefer OPEN status over any
//    other status; if that's still tied, prefer the candidate nearest to
//    the EDM event's own outfall lat/lng (haversine), but only treat it as
//    RESOLVED if the nearest candidate is meaningfully closer than the
//    runner-up (--min-distance-gap-km, default 0.3km) — a 0.16km gap (the
//    real Eastbourne case found during validation) is noise, not signal.
// 6. No candidate at all: reported as NO MATCH, never silently dropped.
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
const MIN_TOKEN_OVERLAP = parseFloat(argVal('--min-token-overlap', '0.6'));

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

// Word-set overlap, order-independent: |intersection| / min(|tokensA|,
// |tokensB|). Added after real full-scale data (see filehead's "token-
// overlap tier" note) showed substring matching's real blind spot: EDM
// names that reorder or drop/add words relative to EA's label — "WEST BAY
// WESTGATE" vs EA's "WESTGATE BAY SAMPLED..." (words transposed), "ST
// MARYS BAY (KENT)" vs EA's "...BEACH SURVEY STATION" (Southern Water adds
// a county qualifier EA's label doesn't have) — neither is a substring of
// the other in either direction, but they clearly share the same place.
function tokenOverlapRatio(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / Math.min(ta.size, tb.size);
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

    // Third tier: order-independent word-overlap (see tokenOverlapRatio's
    // comment — catches transposed/qualifier-augmented names substring
    // matching structurally can't). Deliberately tried LAST, after exact
    // and substring both fail — it's the weakest signal of the three, so
    // every candidate it finds is tagged with its own overlap ratio and
    // carried into the report even when a tiebreak resolves it, unlike the
    // other two tiers, so a reviewer can see exactly how thin the evidence
    // was.
    let tokenOverlaps = null;
    if (!candidates || candidates.length === 0) {
      matchKind = 'token-overlap';
      const seen = new Set();
      candidates = [];
      tokenOverlaps = new Map();
      for (const s of sites) {
        const np = normalize(s.prefLabel || '');
        const na = normalize(s.altLabel || '');
        const ratioP = np ? tokenOverlapRatio(n, np) : 0;
        const ratioA = na ? tokenOverlapRatio(n, na) : 0;
        const bestRatio = Math.max(ratioP, ratioA);
        if (bestRatio >= MIN_TOKEN_OVERLAP && !seen.has(s.notation)) {
          seen.add(s.notation);
          candidates.push({ site: s, field: ratioP >= ratioA ? 'prefLabel' : 'altLabel' });
          tokenOverlaps.set(s.notation, bestRatio);
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
      tokenOverlap: tokenOverlaps ? tokenOverlaps.get(c.site.notation) : null,
    }));
    const serializeCandidates = (list) => list.map((w) => ({
      notation: w.site.notation, prefLabel: w.site.prefLabel, status: w.site.status, distanceKm: w.distKm,
      ...(w.tokenOverlap != null ? { tokenOverlap: w.tokenOverlap } : {}),
    }));

    if (uniqueSites.length === 1) {
      const c = withDist[0];
      counts.exactUnambiguous++;
      lookup[name] = c.site.notation;
      report.push({
        edmName: name, outfallCount: outfalls.length, matchKind, resolution: 'unambiguous',
        matchedSite: c.site.notation, matchedLabel: c.site.prefLabel, matchedField: c.field,
        distanceKm: c.distKm, siteStatus: c.site.status,
        ...(c.tokenOverlap != null ? { tokenOverlap: c.tokenOverlap } : {}),
        candidates: serializeCandidates(withDist),
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
        ...(nearest.tokenOverlap != null ? { tokenOverlap: nearest.tokenOverlap } : {}),
        candidates: serializeCandidates(withDist),
      });
    } else if (gapKm != null && gapKm >= MIN_DISTANCE_GAP_KM) {
      counts.resolvedByDistance++;
      lookup[name] = nearest.site.notation;
      report.push({
        edmName: name, outfallCount: outfalls.length, matchKind, resolution: resolvedBy === 'status' ? 'resolved_by_status_and_distance' : 'resolved_by_distance',
        matchedSite: nearest.site.notation, matchedLabel: nearest.site.prefLabel, matchedField: nearest.field,
        distanceKm: nearest.distKm, distanceGapKm: gapKm, siteStatus: nearest.site.status,
        ...(nearest.tokenOverlap != null ? { tokenOverlap: nearest.tokenOverlap } : {}),
        candidates: serializeCandidates(withDist),
      });
    } else {
      counts.unresolvedAmbiguous++;
      report.push({
        edmName: name, outfallCount: outfalls.length, matchKind, resolution: 'unresolved_ambiguous',
        distanceGapKm: gapKm,
        candidates: serializeCandidates(withDist),
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
