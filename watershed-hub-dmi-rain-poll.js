#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// watershed-hub-dmi-rain-poll.js
// ═══════════════════════════════════════════════════════════════════════════
//
// One-shot Watershed adapter — the hub's own copy of dmi-rain.js's fetch
// logic, run on the hub's schedule instead of independently inside every
// dkvand replica's own WEATHER_CHECK_INTERVAL_MS chain (server.js).
//
// Deliberately NATIONWIDE, not dkvand-specific: fetches every reporting DMI
// station's latest precip_past1h reading plus backfills its rolling 7-day
// history, with no knowledge of dkvand's own bathing-site cell list at all.
// dmi-rain.js's rebuildCellIndex()/getMeasuredForCell() — the part that
// actually matches a station to one of dkvand's own cells — stays exactly
// where it is, in server.js's own process, now running against data this
// script fetched instead of data server.js fetched itself. Same split
// ukwater's liveEdmPoller.js (fetch) vs server/index.js's own .live-patching
// (app-specific use) already uses.
//
// Reuses dmi-rain.js's real fetch/backfill/persistence functions directly
// (refreshLatest, backfillHistory, allStationIds, loadPersistedHistory) —
// no protocol logic duplicated here, so a future fix to DMI's pagination or
// field names only has to happen once.
'use strict';

const dmiRain = require('./dmi-rain');

async function main() {
  dmiRain.loadPersistedHistory();

  const updated = await dmiRain.refreshLatest();
  console.log(`[watershed-hub-dmi-rain-poll] refreshLatest: ${updated} station(s) updated`);

  const allIds = dmiRain.allStationIds();
  await dmiRain.backfillHistory(allIds);

  const s = dmiRain.stats();
  console.log(`[watershed-hub-dmi-rain-poll] done — ${s.stationsTotal} stations known, ${s.stationsWithHistory} with history`);

  // NOT dmi-rain.js's own persistHistoryToDisk() — real bug found running
  // this live: that one is throttled to one write per 10 minutes AND
  // fire-and-forget async, both correct for a long-running server but wrong
  // for a one-shot process (refreshLatest()'s own write throttles away
  // backfillHistory()'s much fuller one moments later; the process can also
  // exit before an unawaited write lands). persistHistoryToDiskSync() is
  // exactly for this: unconditional, synchronous, guaranteed on disk before
  // main() returns.
  dmiRain.persistHistoryToDiskSync();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[watershed-hub-dmi-rain-poll] failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
