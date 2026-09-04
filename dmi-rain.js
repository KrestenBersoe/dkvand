// ═══════════════════════════════════════════════════════════════════════════
// dmi-rain.js — reelt MÅLT nedbør (DMI's regnmålernetværk), ikke prognose
// ═══════════════════════════════════════════════════════════════════════════
//
// BAGGRUND (bruger-krav 2026-09-04): al nedbørsdata i appen var indtil nu
// UDELUKKENDE fra Open-Meteo (se fetchOpenMeteo()/computeMetrics() i
// server.js) — og selv den del, Open-Meteo selv kalder "past" (allerede
// passeret), er stadig NWP-modelreanalyse/blanding, ALDRIG en fysisk
// regnmålers faktiske aflæsning, uanset hvor langt tilbage i tiden man
// spørger. Brugerens krav: "Measured rainfall should take priority to
// predicted" — denne fil henter DEN, fra DMI's åbne meteorologiske
// observations-API, og server.js's risikoløkke bruger den nu i stedet for
// Open-Meteo-modellen, for enhver badevands-celle der har en DMI-regnmåler
// inden for rækkevidde.
//
// Datakilde: DMI Open Data, metObs v2 (opendataapi.dmi.dk) — ingen API-
// nøgle krævet siden 2026-03-26 (den gamle dmigw.govcloud.dk-endpoint, som
// KRÆVEDE en nøgle, lukker 2026-06-30). Bekræftet direkte live 2026-09-04.
// Kun ÉT parameterId bruges, precip_past1h (mm nedbør i seneste hele
// klokketime pr. station) — samme enhed/opløsning som Open-Meteos
// hourly.precipitation, så denne fils output kan fodres DIREKTE ind i
// risk-model.js's EKSISTERENDE accumulateDecayed()/estimateLastEventAge()
// uden nogen ny matematik, blot en anden kilde-array. precip_past24h
// FRAVALGT bevidst — verificeret direkte at den kun opdateres én gang i
// døgnet (06:00 UTC) og dækker et andet stationssæt (bl.a. Færøerne), for
// upraktisk/inkonsistent til denne brug sammenlignet med at summere de
// seneste 24 precip_past1h-aflæsninger selv.
//
// Netværksdækning (verificeret direkte 2026-09-04): typisk ~110 stationer
// rapporterer precip_past1h i en given time, spredt over hele riget
// (Danmark+Færøerne+Grønland). Stationskoordinater LÆRES af selve
// observationsstrømmen (se stationCoords' filhoved nedenfor for hvorfor
// DMI's separate /station/items-katalog VISTE SIG upålideligt til dette).
// Et afstands-cutoff (MAX_STATION_DIST_KM) sikrer at fjerne/udenlandske
// stationer aldrig matches til en dansk badevands-celle — findes ingen
// station inden for rækkevidde, eller er dens seneste måling for gammel
// (STALE_MS), returnerer getMeasuredForCell() null, og kalderen (server.js)
// falder tilbage til Open-Meteo-modellen, PRÆCIS som hvis denne fil slet
// ikke fandtes.
//
// Arkitektur, parallel til CMEMS-strømcachen (se fetchCMEMSCurrents() i
// server.js): ét rullende pr.-station nedbørsvindue (genopfrisket hver time
// via server.js's eksisterende WEATHER_CHECK_INTERVAL_MS-kæde, som også
// løbende genlærer stationCoords) og et afledt pr.-vejrgitter-celle opslag
// (SAMME 0,25°-gitter som weatherCache allerede bruger, se cellKey() i
// risk-model.js).
'use strict';

const https      = require('https');
const riskModel   = require('./risk-model');
const badevandRisk = require('./badevand-risk');

const DMI_BASE = 'https://opendataapi.dmi.dk/v2/metObs/collections';

// Ud over dette: stationen er for langt væk til at være repræsentativ for
// cellen — fald tilbage til Open-Meteo-modeldata. 25km er et forsigtigt
// førstevalg givet ~110 aktivt rapporterende stationer over hele Danmark;
// juster op/ned efter faktisk observeret cellsMatched/totalCells (se stats()).
const MAX_STATION_DIST_KM = 25;
// Matcher Open-Meteos past_days=7 / hourlyWeek's vinduelængde i computeMetrics().
const HISTORY_HOURS = 7 * 24;
// Ingen ny måling fra stationen i over 3 timer — anses for stille/nede
// (samme forsigtige grænse som WEATHER_TTL_MS-familien ellers bruger i
// server.js), fald tilbage til modeldata frem for at vise en flere timer
// gammel "målt" værdi som om den var frisk.
const STALE_MS = 3 * 3600 * 1000;

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'dkvand.dk (badevand-risiko, kontakt via dmi.dk/kontakt)' } }, resp => {
      if (resp.statusCode !== 200) { resp.resume(); reject(new Error(`DMI HTTP ${resp.statusCode} — ${url}`)); return; }
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Følger OGC API Features' "next"-link til hele resultatet er hentet —
// samme paginerings-mønster alle DMI's collections/items-endpoints bruger.
async function fetchAllPages(url, maxPages) {
  const out = [];
  let next = url;
  for (let i = 0; i < maxPages && next; i++) {
    const page = await httpsGetJson(next);
    const features = page.features || [];
    out.push(...features);
    if (features.length === 0) break;
    next = (page.links || []).find(l => l.rel === 'next')?.href || null;
  }
  return out;
}

// ── Stationskoordinater: stationId -> { lat, lng } ──────────────────────
// UDLEDT UDELUKKENDE af selve precip_past1h-observationsstrømmen (hver
// observation-feature bærer sin egen geometry.coordinates), IKKE af DMI's
// separate /station/items-katalog — bekræftet direkte (2026-09-04) at
// kataloget er upålideligt til dette formål: en stations "Active" status
// (og selv dens EGEN deklarerede parameterId-liste) garanterer ikke at den
// RENT FAKTISK sender data lige nu. Eksempel: 05735 (nærmeste-koordinat-
// station til København) er "Active" og har "precip_past1h" i sin
// deklarerede parameterId-liste, men optræder aldrig i selve
// observationsstrømmen — nærmeste-match mod den ville permanent give null
// for hele cellen. At udlede koordinater af strømmen i stedet gør en sådan
// mismatch strukturelt umulig: en station kan kun matches, hvis den
// FAKTISK har leveret mindst én måling.
let stationCoords = new Map();

// ── Løbende opdatering — henter seneste hele times precip_past1h for ALLE
// DMI-stationer på tværs af hele riget i ÉT kald, lærer/opdaterer
// stationCoords undervejs, og fodrer hver aflæsning ind i
// stationHistory (se appendReading() nedenfor). Kaldt både som
// engangs-opstartskilde (server.js kalder denne FØR rebuildCellIndex()) og
// gentagne gange derefter fra server.js's WEATHER_CHECK_INTERVAL_MS-kæde.
async function refreshLatest() {
  const features = await fetchAllPages(
    `${DMI_BASE}/observation/items?parameterId=precip_past1h&period=latest-hour&limit=500`, 5
  );
  let updated = 0;
  for (const f of features) {
    const p      = f.properties || {};
    const coords = f.geometry?.coordinates; // [lng, lat]
    if (!p.stationId || p.value == null || !p.observed || !coords) continue;
    stationCoords.set(p.stationId, { lat: coords[1], lng: coords[0] });
    appendReading(p.stationId, floorToHour(p.observed), Math.max(Number(p.value) || 0, 0));
    updated++;
  }
  return updated;
}

// ── Pr.-celle nærmeste-station-indeks (samme 0,25°-gitter som weatherCache) ──
let cellStation = new Map(); // cellKey -> { stationId, distKm }

function rebuildCellIndex(cells) {
  const next = new Map();
  for (const cell of cells) {
    let bestId = null, bestDist = Infinity;
    for (const [stationId, s] of stationCoords) {
      const distKm = badevandRisk.haversineM(cell.lat, cell.lng, s.lat, s.lng) / 1000;
      if (distKm < bestDist) { bestDist = distKm; bestId = stationId; }
    }
    if (bestId !== null && bestDist <= MAX_STATION_DIST_KM) {
      next.set(riskModel.cellKey(cell.lat, cell.lng), { stationId: bestId, distKm: bestDist });
    }
  }
  cellStation = next;
  console.info(`dmi-rain: ${cellStation.size}/${cells.length} celler matchet til en DMI-regnmåler (≤${MAX_STATION_DIST_KM}km)`);
}

function matchedStationIds() {
  return new Set([...cellStation.values()].map(v => v.stationId));
}

// ── Pr.-station nedbørshistorik: stationId -> Map<hourTs(ms), mm> ───────
// Et sparsomt kort (kun timer vi RENT FAKTISK har modtaget en måling for),
// IKKE et tæt array — huller (en station der midlertidigt ikke rapporterer)
// skal antages 0mm ved AFLÆSNING (se denseSeriesFor() nedenfor), ikke
// stiltiende skrumpe vinduets effektive længde ved at blive sprunget over i
// et almindeligt array (ville forskyde alle senere timers indeks og dermed
// regnemodellens implicitte "1 indeks = 1 time"-antagelse i
// accumulateDecayed()/estimateLastEventAge()).
let stationHistory = new Map();

function floorToHour(iso) {
  return Math.floor(new Date(iso).getTime() / 3600000) * 3600000;
}

function appendReading(stationId, hourTs, mm) {
  let h = stationHistory.get(stationId);
  if (!h) { h = new Map(); stationHistory.set(stationId, h); }
  h.set(hourTs, mm);
  // RETTET: brugte tidligere et for-loop med `break` ved første nøgle over
  // cutoff — men Map bevarer INDSÆTTELSESrækkefølge, ikke kronologisk
  // rækkefølge (backfillHistory()'s DMI-svar er ikke garanteret tidssorteret,
  // og refreshLatest()/backfillHistory() kan interleave under opstart) — et
  // tidligt indsat, men kronologisk NYT tidsstempel ville da stoppe
  // oprydningen øjeblikkeligt, uden at fjerne noget som helst. Gennemløber nu
  // ALLE nøgler ubetinget — Map-iteratoren håndterer sletning af allerede
  // besøgte/ubesøgte nøgler korrekt under iteration.
  const cutoff = hourTs - HISTORY_HOURS * 3600000;
  for (const ts of h.keys()) { if (ts < cutoff) h.delete(ts); }
}

// Bygger et TÆT, kronologisk (ældste først) time-for-time array for de
// seneste `hours` timer op til `latestHourTs`, huller udfyldt med 0 — den
// form risk-model.js's accumulateDecayed()/estimateLastEventAge() kræver
// (de antager implicit uniform 1-times skridt mellem hvert array-indeks).
function denseSeriesFor(h, latestHourTs, hours) {
  const out = new Array(hours);
  for (let i = 0; i < hours; i++) {
    const ts = latestHourTs - (hours - 1 - i) * 3600000;
    out[i] = h.get(ts) ?? 0;
  }
  return out;
}

// ── Ét-gangs historisk opbakning ved kold start ──────────────────────────
// Uden dette ville stationHistory være praktisk talt tom lige efter enhver
// deploy/genstart, og målt data ville først "vinde" over modellen efter en
// hel uges kontinuerlig drift (se refreshLatest()'s hyppige, men kun
// ÉN-time-ad-gangen opdatering). CONCURRENCY=8 — samme forsigtige burst-
// undgåelse som warmCache() i server.js bruger mod Open-Meteo.
async function backfillHistory(stationIds) {
  const now   = Date.now();
  const start = new Date(now - HISTORY_HOURS * 3600000).toISOString();
  const end   = new Date(now).toISOString();
  const ids   = [...stationIds];
  const CONC  = 8;
  let idx = 0, ok = 0, failed = 0;

  async function worker() {
    while (idx < ids.length) {
      const stationId = ids[idx++];
      try {
        const url = `${DMI_BASE}/observation/items?parameterId=precip_past1h&stationId=${encodeURIComponent(stationId)}` +
          `&datetime=${encodeURIComponent(start)}/${encodeURIComponent(end)}&limit=${HISTORY_HOURS + 10}`;
        const features = await fetchAllPages(url, 3);
        for (const f of features) {
          const p = f.properties || {};
          if (p.value == null || !p.observed) continue;
          appendReading(stationId, floorToHour(p.observed), Math.max(Number(p.value) || 0, 0));
        }
        ok++;
      } catch (e) {
        failed++;
        console.warn(`dmi-rain: historisk opbakning fejlede for station ${stationId} —`, e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, ids.length) }, worker));
  console.info(`dmi-rain: historisk opbakning færdig — ${ok} stationer ok, ${failed} fejlet`);
}

// ── Offentlig opslagsfunktion — kaldt fra server.js's risikoløkke, ét kald
// pr. PULS-punkt, præcis som weatherCache.get(key) allerede sker ──────────
// Returnerer null hvis ingen station inden for rækkevidde ELLER dens
// seneste måling er for gammel — kalderen falder da tilbage til Open-
// Meteo-modeldata (w.hourlyWeek/w.antecedentMM/w.todayMM), præcis som hvis
// denne fil slet ikke fandtes.
function getMeasuredForCell(cellKey) {
  const match = cellStation.get(cellKey);
  if (!match) return null;
  const h = stationHistory.get(match.stationId);
  if (!h || h.size === 0) return null;
  const latestHourTs = Math.max(...h.keys());
  if (Date.now() - latestHourTs > STALE_MS) return null;

  const hourlyWeek = denseSeriesFor(h, latestHourTs, HISTORY_HOURS);
  return {
    hourlyWeek,
    todayMM: hourlyWeek.slice(-24).reduce((a, b) => a + b, 0),
    stationId: match.stationId,
    distKm: match.distKm,
    updatedAt: latestHourTs,
  };
}

function stats() {
  return {
    stationsTotal: stationCoords.size,
    cellsMatched: cellStation.size,
    stationsWithHistory: stationHistory.size,
    maxStationDistKm: MAX_STATION_DIST_KM,
  };
}

module.exports = {
  rebuildCellIndex, matchedStationIds, backfillHistory, refreshLatest,
  getMeasuredForCell, stats,
};
