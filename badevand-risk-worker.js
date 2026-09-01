// ═══════════════════════════════════════════════════════════════════════════
// badevand-risk-worker.js — kører computeBadevandRiskCascade() i sin egen
// OS-tråd (worker_threads), IKKE på hovedtrådens event loop
// ═══════════════════════════════════════════════════════════════════════════
//
// NYT (2026-08-20, produktionshændelse — se badevand-risk.js:190-203 og
// current-grid.js's filhoved for de to tidligere, delvise rettelser af
// SAMME grundproblem): selv efter O(1)-strømopslag var
// computeBadevandRiskCascade() stadig observeret til at tage 45-57 sek. pr.
// kørsel — og for ~1.550 af funktionens ~1.550 linjer (frem til den
// batch-vise, portionsvise løkke nær bunden) findes INGEN
// `await new Promise(resolve => setImmediate(resolve))`-afgivelse til event
// loopet undervejs, i modsætning til water-classification.js's
// computeWaterFlagsAsync() (som allerede er portionsvis OG kun kører ÉN
// gang, ikke hver cyklus — derfor ikke flyttet hertil). Al Node's HTTP-
// betjening (inkl. /api/health) og pg-pool's keepalive/query-afvikling
// deler samme enkelttrådede event loop — så selv en fejlfri, korrekt
// beregning fastfrøs uundgåeligt ALT andet i op mod et minut, hver 15.
// minut. worker_threads flytter selve CPU-arbejdet til en separat OS-tråd,
// så hovedtråden forbliver fri til at betjene forespørgsler/DB-keepalives
// HELE VEJEN IGENNEM beregningen, uanset om koden selv afgiver kontrollen.
//
// Modtager REN DATA via workerData (points/staticDir/currentPoints — se
// server.js's runBadevandRiskCascadeInWorker()) og sender ÉT
// besked-svar tilbage. Kræver selv risk-model.js og current-grid.js — de
// funktions-referencer (seasonalTau/seasonalTauViral/getCurrentAt), som
// computeBadevandRiskCascade() forventer som parametre, kan IKKE sendes med
// over workerData (strukturklonings-algoritmen understøtter ikke
// funktioner) — løses ved at denne fil selv kræver modulerne og bygger
// funktionerne LOKALT i workerens eget modul-scope, i stedet for at forsøge
// at videresende hovedtrådens referencer.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const { parentPort, workerData } = require('worker_threads');
const badevandRisk = require('./badevand-risk');
const riskModel     = require('./risk-model');
const { buildCurrentGrid, getCurrentAtServer } = require('./current-grid');

(async () => {
  try {
    const { points, staticDir, currentPoints } = workerData;

    // Genopbygger samme grid+bucket-index som hovedtråden havde — fra de rå
    // strømpunkter (currentsCache.grid.values()), IKKE fra selve Map'en
    // (som strukturkloning ikke bevarer den bolt-på'ede .buckets-property
    // for, se runBadevandRiskCascadeInWorker()'s kommentar).
    const grid = currentPoints && currentPoints.length > 0 ? buildCurrentGrid(currentPoints) : null;
    const getCurrentAt = grid ? (lat, lng) => getCurrentAtServer(lat, lng, grid) : null;

    const result = await badevandRisk.computeBadevandRiskCascade(
      points, riskModel.seasonalTau, riskModel.seasonalTauViral, staticDir, undefined, getCurrentAt
    );
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e && e.message || String(e), stack: e && e.stack });
  }
})();
