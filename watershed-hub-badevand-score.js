#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// watershed-hub-badevand-score.js
// ═══════════════════════════════════════════════════════════════════════════
//
// One-shot Watershed hub adapter — Phase 1 of "hub som central scorings-
// leder" (bruger-beslutning 2026-09-16, "A": hub'en ejer også bucket-
// transition-/historik-state, ikke kun ren beregning). Kører den SAMME
// puls-risk-scoring.js::computeAllPointRisks() som server.js selv kalder
// (se dens filhoved — ren udtrækning, 100% adfærdsbevarende), her på hub'ens
// egen 15-minutters kadence i stedet for at hver dkvand-replika beregner det
// samme uafhængigt af hinanden.
//
// Kører i SAMME checkout som de tre eksisterende hub-adaptere
// (watershed-hub-open-meteo-poll.js/-dmi-rain-poll.js/-cmems-poll.js) og
// læser deres allerede-friske output DIREKTE fra disk — ingen HTTP-runde
// nødvendig, præcis samme begrundelse som deres egne filhoveder.
//
// BEVIDST UDELADT: waterFlagsCache (server.js's egen dyre VP3/badevand-
// geometriske "er dette punkt i et rigtigt badevand"-beregning, se
// ensureWaterFlagsCache() i server.js). At genskabe den på hub'en var uden
// for scope i denne første omgang — computeAllPointRisks() degraderer
// GRACEFULT når waterFlagsCache er undefined (waterFlagsCache?.get(pt.id)
// bliver undefined, algaeScore falder tilbage til ferskvands-temperatur-
// estimatet fra lufttemperatur i stedet for CMEMS-vandtemperatur, se dens
// eget kaldested) — IKKE en crash, men algaeScore for punkter i rigtige
// badevande bliver mindre præcis end server.js's egen lokale beregning,
// indtil et senere trin evt. flytter/genopbygger waterFlagsCache hub-side.
//
// Postgres: DATABASE_URL sættes til DKVAND_DATABASE_URL FØR overloeb-events.js
// (og dermed db.js) kræves — samme "sæt env FØR require" mønster som enhver
// anden hub-adapter der skal pege på ét bestemt projekts database, se
// samtalen der førte til denne fil for hvorfor det er sikkert på tværs af
// projekter (hver kørsel er sin egen kortlevede child-process).
'use strict';

if (!process.env.DKVAND_DATABASE_URL) {
  console.error('[watershed-hub-badevand-score] DKVAND_DATABASE_URL ikke sat — kan ikke skrive bucket-transitions/historik.');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.DKVAND_DATABASE_URL;

const fs = require('fs');
const path = require('path');
const { buildCurrentGrid } = require('./current-grid');
const weather = require('./open-meteo-weather');
const dmiRain = require('./dmi-rain');
const pulsRiskScoring = require('./puls-risk-scoring');
const overloebEvents = require('./overloeb-events');
const { pool } = require('./db');

const STATIC_DIR = __dirname;
const PULS_DATA_PATH = path.join(STATIC_DIR, 'puls-data.json');
const WEATHER_CACHE_PATH = path.join(STATIC_DIR, 'weather-cache.json');
const CURRENTS_HUB_PATH = path.join(STATIC_DIR, 'currents-hub.json');
const OUT_PATH = path.join(STATIC_DIR, 'badevand-scores-hub.json');
const MIN_RISK = 0.35; // matcher server.js's egen evaluatePushNotifications()-standard

function loadWeatherCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WEATHER_CACHE_PATH, 'utf8'));
    return Array.isArray(parsed) ? new Map(parsed) : new Map();
  } catch (e) {
    console.warn('[watershed-hub-badevand-score] kunne ikke læse weather-cache.json —', e.message);
    return new Map();
  }
}

function loadCurrentsCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CURRENTS_HUB_PATH, 'utf8'));
    if (parsed && Array.isArray(parsed.points) && parsed.points.length) {
      return { grid: buildCurrentGrid(parsed.points) };
    }
  } catch (e) {
    console.warn('[watershed-hub-badevand-score] kunne ikke læse currents-hub.json —', e.message);
  }
  return { grid: null };
}

async function main() {
  await overloebEvents.ready;

  const points = pulsRiskScoring.loadPulsPointsFull(STATIC_DIR);
  if (!points.length) throw new Error('ingen PULS-punkter indlæst — puls-data.json mangler/tom');

  const weatherCache = loadWeatherCache();
  const currentsCache = loadCurrentsCache();

  // RETTET (fundet ved live-test mod hub'ens rigtige checkout): dmi-rain.js's
  // loadPersistedHistory() indlæser KUN stationHistory, ALDRIG stationCoords
  // (se dens eget filhoved — det er den lokale /data-cache-udgave, som ikke
  // har koordinater i sit format). rebuildCellIndex() kan derfor intet matche
  // uden koordinater — observeret direkte: "0/171 celler matchet". Samme fil
  // (dmi-rain-history.json, skrevet af watershed-hub-dmi-rain-poll.js's
  // persistHistoryToDiskSync()) HAR faktisk coords i sit format — det er
  // netop derfor loadFromSyncedFile() (som forventer PRÆCIS dette format,
  // {stations, coords}) er den rigtige læser her, ikke loadPersistedHistory().
  const dmiRainHistoryPath = path.join(STATIC_DIR, 'dmi-rain-history.json');
  dmiRain.loadFromSyncedFile(dmiRainHistoryPath);
  const cells = weather.buildPulsGrid(PULS_DATA_PATH);
  dmiRain.rebuildCellIndex(cells);

  const lastKnownBucketByPointId = await overloebEvents.loadAllLastBuckets();

  const {
    allPointRisks, bucketTransitions, bucketPersistUpdates,
    cellMatched, cellMissing, maxForecastMMSeen, maxTodayMMSeen, maxForeRiskSeen,
  } = pulsRiskScoring.computeAllPointRisks(points, {
    weatherCache, dmiRain, waterFlagsCache: undefined, currentsCache, lastKnownBucketByPointId, minRisk: MIN_RISK,
  });

  await overloebEvents.recordTransitions(bucketTransitions);
  await overloebEvents.upsertLastBuckets(bucketPersistUpdates);

  const ts = Date.now();
  fs.writeFileSync(OUT_PATH, JSON.stringify({ ts, points: allPointRisks }));

  console.log(
    `[watershed-hub-badevand-score] ${allPointRisks.length} punkter scoret ` +
    `(${cellMatched} matchet/${cellMissing} manglende celle, ${bucketTransitions.length} bucket-skift, ` +
    `maxForecastMM=${maxForecastMMSeen.toFixed(1)}, maxTodayMM=${maxTodayMMSeen.toFixed(1)}, maxForeRisk=${maxForeRiskSeen.toFixed(2)}) -> ${OUT_PATH}`
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[watershed-hub-badevand-score] failed:', err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      // RETTET (produktionshændelse 2026-09-16 — set live: kørslen
      // GENNEMFØRTE fuldt ud, skrev alle 21563 punkter, alligevel markeret
      // 'failed' med "exit null" PRÆCIS 120,0 sek. efter start): pool.end()
      // alene er IKKE nok — db.js's eget 5-minutters heartbeat-setInterval
      // (se dens filhoved) er ALDRIG .unref()'et, så det holder event loopet
      // i live på ubestemt tid, uafhængigt af om selve pool'en er lukket.
      // watershed-scheduleren's egen TIMEOUT_MS (her 120000) ramte derfor
      // FØRST — et SIGKILL af en proces der reelt allerede var færdig med
      // alt sit arbejde. Et eksplicit process.exit() her er den eneste
      // pålidelige rettelse (matcher db.js's egen tilsigtede brug i den
      // LANGTKØRENDE server, hvor akkurat DEN samme opførsel er korrekt —
      // rettelsen hører derfor hjemme her, i det ét-skuds-script, ikke i
      // det delte db.js).
      await pool.end().catch(() => {});
      process.exit(process.exitCode ?? 0);
    });
}

module.exports = { main };
