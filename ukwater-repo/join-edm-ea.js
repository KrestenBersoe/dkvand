#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// join-edm-ea.js — combines the two independently-ingested UK datasets into
// one site-resolved table: schema-map-edm.js's discharge events/impacts
// (cause data, Southern Water) + fetch-ea-samples.js's lab sample results
// (outcome data, Environment Agency), linked via check-site-match.js's
// name-resolution lookup.
//
// This is STILL ingestion, not the backtest. It answers "which EA site did
// this discharge event impact, and what does that site's own event/sample
// coverage look like" — a clean, resolved, per-site dataset. It deliberately
// does NOT do any date-window/lag matching between an event and a sample
// (e.g. "which samples fall within 48h of this event") — that's genuinely
// the walk-forward backtest's job (same separation dkvand's own PULS
// ingestion keeps: scripts/build-badevand-analyseresultater.js builds the
// clean sample table, scripts/validate-badevand-model.js does the actual
// lag/decay matching). Keeping that boundary here means the eventual UK
// backtest script can implement its OWN leakage-safe temporal join against
// clean inputs, rather than inheriting date logic buried in an ingestion
// step.
//
// Kør fra ukwater-repo/ (denne mappe), EFTER schema-map-edm.js,
// fetch-ea-samples.js OG check-site-match.js alle er kørt (alle skriver
// som standard til ./output/):
//   node join-edm-ea.js
//   node join-edm-ea.js --dir DIR
//
// ── Why unresolved impacts are written out, not dropped ───────────────────
// check-site-match.js already found (on the real full file) 3 bathing-water
// names that don't resolve: 2 out-of-scope EA site types (Chichester/
// Langstone Harbour — confirmed no compliance data will ever exist for
// them) and 1 genuine semantic mismatch (Stokes Lake vs EA's "Stokes Bay")
// left unresolved on purpose rather than force-matched. Every impact row
// naming one of those still gets written — to unresolved-impacts.ndjson,
// not silently discarded — so a future backtest (or a human) can decide
// whether to manually map "Stokes Lake" once its real identity is known,
// without re-deriving which rows were affected.
//
// ── Output ──────────────────────────────────────────────────────────────
// <out-dir>/joined-impacts.ndjson       — one row per (event, EA site)
//                                          impact that resolved to a real
//                                          EA site, augmented with that
//                                          site's notation/name/geometry.
// <out-dir>/unresolved-impacts.ndjson   — impacts whose bathingWater name
//                                          didn't resolve (see above).
// <out-dir>/site-timeline-summary.json  — per EA site: event coverage
//                                          (count, genuine count, date
//                                          range, distinct outfalls) AND
//                                          sample coverage (count, date
//                                          range, determinand breakdown) —
//                                          a coverage diagnostic, so
//                                          "does this site have BOTH cause
//                                          and outcome data" is answerable
//                                          before the backtest is built,
//                                          not discovered partway through it.
// <out-dir>/join-diagnostics.json       — overall counts.
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
const LOOKUP_PATH = path.resolve(argVal('--lookup', path.join(DIR, 'site-match-lookup.json')));
const SITES_PATH = path.resolve(argVal('--sites', path.join(DIR, 'ea-sites.json')));
const SAMPLES_PATH = path.resolve(argVal('--samples', path.join(DIR, 'ea-samples.ndjson')));
const OUT_DIR = path.resolve(argVal('--out-dir', DIR));

for (const [label, p] of [
  ['edm-events.ndjson', EVENTS_PATH], ['edm-impacts.ndjson', IMPACTS_PATH],
  ['site-match-lookup.json', LOOKUP_PATH], ['ea-sites.json', SITES_PATH], ['ea-samples.ndjson', SAMPLES_PATH],
]) {
  if (!fs.existsSync(p)) {
    console.error(`Mangler ${label} (${p}).`);
    console.error('Kør først, i rækkefølge: schema-map-edm.js, fetch-ea-samples.js, check-site-match.js — alle skriver som standard til ./output/.');
    process.exit(1);
  }
}

async function* ndjsonLines(p) {
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line) continue;
    yield JSON.parse(line);
  }
}

async function main() {
  const t0 = Date.now();

  console.log(`Læser ${EVENTS_PATH}...`);
  const eventById = new Map();
  for await (const ev of ndjsonLines(EVENTS_PATH)) eventById.set(ev.eventId, ev);
  console.log(`${eventById.size.toLocaleString('en')} hændelser indlæst.`);

  const lookup = JSON.parse(fs.readFileSync(LOOKUP_PATH, 'utf8')); // bathingWater name -> EA site notation
  const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
  const siteByNotation = new Map(sites.map((s) => [s.notation, s]));

  // Per-site accumulator, seeded with every EA site (so a site with events
  // but zero samples, or samples but zero events, is visible in the
  // summary rather than simply absent from it).
  const siteStats = new Map();
  for (const s of sites) {
    siteStats.set(s.notation, {
      notation: s.notation,
      prefLabel: s.prefLabel,
      lat: s.lat,
      lng: s.lng,
      status: s.status,
      eventCount: 0,
      genuineEventCount: 0,
      distinctOutfalls: new Set(),
      eventDateRange: { earliest: null, latest: null },
      sampleCount: 0,
      sampleDateRange: { earliest: null, latest: null },
      determinandCounts: {},
    });
  }

  console.log(`Læser ${IMPACTS_PATH} og kobler mod ${LOOKUP_PATH}...`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const joinedStream = fs.createWriteStream(path.join(OUT_DIR, 'joined-impacts.ndjson'));
  const unresolvedStream = fs.createWriteStream(path.join(OUT_DIR, 'unresolved-impacts.ndjson'));

  let totalImpacts = 0, resolvedImpacts = 0, unresolvedImpacts = 0, missingEventRefs = 0;
  const unresolvedNameCounts = {};
  const seenEventIdsPerSite = new Map(); // notation -> Set(eventId) — de-dup event-level stats across repeated impact rows for the SAME (event, site) pair (shouldn't happen post schema-map-edm.js's own dedup, but this stage doesn't assume it)

  for await (const im of ndjsonLines(IMPACTS_PATH)) {
    totalImpacts++;
    const ev = eventById.get(im.eventId);
    if (!ev) { missingEventRefs++; continue; } // referential integrity issue in the source ingestion, not this join — surfaced via diagnostics below, not silently skipped without counting

    const notation = lookup[im.bathingWater];
    if (!notation || !siteByNotation.has(notation)) {
      unresolvedImpacts++;
      unresolvedNameCounts[im.bathingWater] = (unresolvedNameCounts[im.bathingWater] || 0) + 1;
      unresolvedStream.write(JSON.stringify({ ...im, outfall: ev.outfall, startFormatted: ev.startFormatted }) + '\n');
      continue;
    }

    resolvedImpacts++;
    const site = siteByNotation.get(notation);
    joinedStream.write(JSON.stringify({
      eventId: im.eventId,
      bathingWaterNameRaw: im.bathingWater,
      impactStatus: im.impactStatus,
      eaSiteNotation: notation,
      eaSiteName: site.prefLabel,
      outfall: ev.outfall,
      outfallLat: ev.lat,
      outfallLng: ev.lng,
      status: ev.status,
      genuine: ev.genuine,
      startTsMs: ev.startTsMs,
      startFormatted: ev.startFormatted,
      endTsMs: ev.endTsMs,
      endFormatted: ev.endFormatted,
      endedStatus: ev.endedStatus,
      durationSeconds: ev.durationSeconds,
      tidalModelVersion: ev.tidalModelVersion,
    }) + '\n');

    // Site-level stats are keyed on distinct EVENTS, not impact rows — a
    // site's event count should count "how many discharges could have
    // reached it", not be inflated by anything upstream that repeats a row.
    let seenForSite = seenEventIdsPerSite.get(notation);
    if (!seenForSite) { seenForSite = new Set(); seenEventIdsPerSite.set(notation, seenForSite); }
    if (!seenForSite.has(im.eventId)) {
      seenForSite.add(im.eventId);
      const stat = siteStats.get(notation);
      stat.eventCount++;
      if (ev.genuine) stat.genuineEventCount++;
      if (ev.outfall) stat.distinctOutfalls.add(ev.outfall);
      if (ev.startTsMs != null) {
        if (stat.eventDateRange.earliest === null || ev.startTsMs < stat.eventDateRange.earliest) stat.eventDateRange.earliest = ev.startTsMs;
        if (stat.eventDateRange.latest === null || ev.startTsMs > stat.eventDateRange.latest) stat.eventDateRange.latest = ev.startTsMs;
      }
    }
  }
  await new Promise((resolve) => joinedStream.end(resolve));
  await new Promise((resolve) => unresolvedStream.end(resolve));
  console.log(`${totalImpacts.toLocaleString('en')} impact-rækker: ${resolvedImpacts.toLocaleString('en')} løst, ${unresolvedImpacts.toLocaleString('en')} uafklaret${missingEventRefs ? `, ${missingEventRefs.toLocaleString('en')} med manglende hændelsesreference` : ''}.`);

  console.log(`Læser ${SAMPLES_PATH} (streamet, ikke indlæst i hukommelsen)...`);
  let totalSamples = 0;
  for await (const obs of ndjsonLines(SAMPLES_PATH)) {
    totalSamples++;
    const stat = siteStats.get(obs.siteNotation);
    if (!stat) continue; // a sample for a site outside this fetch's region filter — shouldn't happen given ea-sites.json is the source of truth for which sites were queried, but not assumed
    stat.sampleCount++;
    const key = obs.determinandCode;
    stat.determinandCounts[key] = (stat.determinandCounts[key] || 0) + 1;
    if (obs.phenomenonTime) {
      if (stat.sampleDateRange.earliest === null || obs.phenomenonTime < stat.sampleDateRange.earliest) stat.sampleDateRange.earliest = obs.phenomenonTime;
      if (stat.sampleDateRange.latest === null || obs.phenomenonTime > stat.sampleDateRange.latest) stat.sampleDateRange.latest = obs.phenomenonTime;
    }
  }
  console.log(`${totalSamples.toLocaleString('en')} prøve-observationer talt ind i sites-oversigten.`);

  const siteSummaries = [...siteStats.values()]
    .map((s) => ({
      ...s,
      distinctOutfalls: s.distinctOutfalls.size,
      eventDateRange: s.eventDateRange.earliest !== null ? { earliest: new Date(s.eventDateRange.earliest).toISOString(), latest: new Date(s.eventDateRange.latest).toISOString() } : null,
    }))
    .sort((a, b) => b.eventCount - a.eventCount);

  const sitesWithEventsNoSamples = siteSummaries.filter((s) => s.eventCount > 0 && s.sampleCount === 0);
  const sitesWithSamplesNoEvents = siteSummaries.filter((s) => s.eventCount === 0 && s.sampleCount > 0);
  const sitesWithBoth = siteSummaries.filter((s) => s.eventCount > 0 && s.sampleCount > 0);

  fs.writeFileSync(path.join(OUT_DIR, 'site-timeline-summary.json'), JSON.stringify(siteSummaries, null, 2), 'utf8');

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    sourceEvents: EVENTS_PATH,
    sourceImpacts: IMPACTS_PATH,
    sourceLookup: LOOKUP_PATH,
    sourceSites: SITES_PATH,
    sourceSamples: SAMPLES_PATH,
    totalImpacts,
    resolvedImpacts,
    unresolvedImpacts,
    missingEventRefs,
    unresolvedNameCounts,
    totalSamplesCounted: totalSamples,
    siteCount: sites.length,
    sitesWithBoth: sitesWithBoth.length,
    sitesWithEventsNoSamples: sitesWithEventsNoSamples.map((s) => s.notation),
    sitesWithSamplesNoEvents: sitesWithSamplesNoEvents.map((s) => s.notation),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'join-diagnostics.json'), JSON.stringify(diagnostics, null, 2), 'utf8');

  console.log('\n═══ Resultat ═══');
  console.log(`Tidsforbrug: ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Impact-rækker: ${totalImpacts.toLocaleString('en')} (${resolvedImpacts.toLocaleString('en')} løst -> joined-impacts.ndjson, ${unresolvedImpacts.toLocaleString('en')} uafklaret -> unresolved-impacts.ndjson)`);
  if (Object.keys(unresolvedNameCounts).length) {
    console.log('Uafklarede navne:');
    Object.entries(unresolvedNameCounts).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${n}: ${c.toLocaleString('en')} rækker`));
  }
  console.log(`\nEA-stationer: ${sites.length} i alt.`);
  console.log(`  Med BÅDE hændelser og prøver: ${sitesWithBoth.length} (de eneste, en lag-baseret backtest reelt kan bruge)`);
  console.log(`  Med hændelser, men INGEN prøver: ${sitesWithEventsNoSamples.length}${sitesWithEventsNoSamples.length ? ' (' + sitesWithEventsNoSamples.map((s) => s.notation).join(', ') + ')' : ''}`);
  console.log(`  Med prøver, men INGEN hændelser: ${sitesWithSamplesNoEvents.length}${sitesWithSamplesNoEvents.length ? ' (' + sitesWithSamplesNoEvents.map((s) => s.notation).join(', ') + ')' : ''}`);
  console.log(`\nSkrevet: ${path.join(OUT_DIR, 'joined-impacts.ndjson')}`);
  console.log(`Skrevet: ${path.join(OUT_DIR, 'unresolved-impacts.ndjson')}`);
  console.log(`Skrevet: ${path.join(OUT_DIR, 'site-timeline-summary.json')}`);
  console.log(`Skrevet: ${path.join(OUT_DIR, 'join-diagnostics.json')}`);
}

main().catch((err) => {
  console.error('join-edm-ea fejlede:', err);
  process.exit(1);
});
