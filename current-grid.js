// ═══════════════════════════════════════════════════════════════════════════
// current-grid.js — CMEMS-strømgitter: byg + slå op (delt mellem server.js's
// hovedtråd og badevand-risk-worker.js's worker_thread)
// ═══════════════════════════════════════════════════════════════════════════
//
// UDSKILT (2026-08-20, event loop-blokerings-rettelse) fra server.js, hvor
// disse to funktioner tidligere boede — se badevand-risk-worker.js's filhoved
// for hvorfor: computeBadevandRiskCascade() flyttede til en worker_thread, og
// workerData kan ikke bære funktions-referencer over tråd-grænsen, kun rene
// data. Løsningen er at lade BÅDE hovedtråden (server.js) og worker-tråden
// (badevand-risk-worker.js) kræve denne samme, selvstændige fil og selv
// genopbygge grid'et lokalt — hovedtråden fra currentsCache, workeren fra de
// rå strømpunkter, den modtager via workerData (se currentPoints dér).
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// RETTET (KRITISK — se badevand-risk.js:190-203 for den oprindelige
// hændelse): getCurrentAtServer() faldt for ethvert reelt badested tilbage
// til et LINEÆRT SCAN over alle ~1.500 CMEMS-strømpunkter, fordi dens
// "hurtige" nøgle (afrundet til nærmeste 0,5°) næsten aldrig matchede et
// faktisk punkts koordinat (som ikke ligger 0,5°-justeret) — kaldt op til
// hundredtusindvis af gange pr. badevand-risk-beregning, nok til at en enkelt
// cyklus observeret i produktion tog 93,8 sek (mod normalt ~10 sek), og
// blokerede Node's event loop imens. buildCurrentGrid() bygger nu ET rigtigt
// spatialt bucket-index (0,5°-celler) ved siden af selve punkt-Map'en (kun
// bevaret for .size, se currentsCache.grid-brug andre steder), så et opslag
// kun skal tjekke nabocellerne omkring punktet — O(1) i praksis, ikke O(n).
const CURRENT_BUCKET_SIZE = 0.5;

function buildCurrentGrid(points) {
  const grid = new Map();
  const buckets = new Map();
  for (const p of points) {
    const speed = Math.hypot(p.uo, p.vo);
    const dir   = (Math.atan2(p.uo, p.vo) * 180 / Math.PI + 360) % 360; // 0=N,90=E
    const entry = { lat: p.lat, lng: p.lng, uo: p.uo, vo: p.vo, speed, dir, temp: p.temp ?? null };
    grid.set(`${p.lat.toFixed(2)}:${p.lng.toFixed(2)}`, entry);
    const bKey = `${Math.floor(p.lat / CURRENT_BUCKET_SIZE)}:${Math.floor(p.lng / CURRENT_BUCKET_SIZE)}`;
    let arr = buckets.get(bKey);
    if (!arr) { arr = []; buckets.set(bKey, arr); }
    arr.push(entry);
  }
  grid.buckets = buckets;
  return grid;
}

// NYT: server-side port af klientens getCurrentAt() — identisk logik,
// genbruger samme currentsCache.grid-struktur direkte (se buildCurrentGrid()
// ovenfor, allerede fælles mellem klient og server). Bruges af
// evaluatePushNotifications() til algeberegningens CMEMS-temperaturopslag —
// se risk-model.js's computeAlgaeRisk() filhoved for hvorfor dette først nu
// blev flyttet server-side.
function getCurrentAtServer(lat, lng, grid) {
  if (!grid || grid.size === 0 || !grid.buckets) return null;
  const bLat = Math.floor(lat / CURRENT_BUCKET_SIZE);
  const bLng = Math.floor(lng / CURRENT_BUCKET_SIZE);
  let minDist = Infinity, nearest = null;
  // Udvider søgeringen bucket-ring for bucket-ring i stedet for at scanne
  // ALLE punkter — ring 4 (× 0,5°) dækker rigeligt den accepterede
  // 1,5°-grænse nedenfor, med god margin til CMEMS' ~10 km punktafstand.
  for (let ring = 0; ring <= 4; ring++) {
    for (let dLat = -ring; dLat <= ring; dLat++) {
      for (let dLng = -ring; dLng <= ring; dLng++) {
        if (Math.max(Math.abs(dLat), Math.abs(dLng)) !== ring) continue; // kun ringens rand — det indre er allerede tjekket i tidligere iterationer
        const arr = grid.buckets.get(`${bLat + dLat}:${bLng + dLng}`);
        if (!arr) continue;
        for (const v of arr) {
          const d = Math.hypot(v.lat - lat, v.lng - lng);
          if (d < minDist) { minDist = d; nearest = v; }
        }
      }
    }
    if (minDist < 0.3) break;
  }
  return minDist < 1.5 ? nearest : null;
}

module.exports = { CURRENT_BUCKET_SIZE, buildCurrentGrid, getCurrentAtServer };
