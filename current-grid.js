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

// RETTET (produktionshændelse 2026-09-15 — badevands-kaskaden viste 0 røde/
// gule badesteder trods reel, udbredt regn): getCurrentAtServer() accepterede
// tidligere ubetinget den nærmeste fundne CMEMS-punkt inden for 1,5° (~100-
// 166 km ved danske breddegrader) — langt ud over CMEMS' egen ~10 km
// punktafstand (se fetch_currents.py's filhoved). For forespørgsler i smalle
// fjorde CMEMS' havmodeller ikke opløser (Limfjorden bekræftet direkte i
// produktion: nærmeste reelle punkt 23-38 km væk, samme kendte begrænsning
// som allerede dokumenteret for Isefjorden i fetch_currents.py), blev et
// fjernt, uvedkommende åbent-vand-punkt derfor behandlet som lokal, reel
// strømmåling — brugt til BÅDE retningsbestemmelse (badevand-risk.js's
// upstream/downstream-udelukkelse) og henfaldshastighed, og udløste dermed
// forkerte "bekræftet nedstrøms"-udelukkelser og kraftigt overdrevet
// afstandshenfald. ~15 km (0,135°, et lille tillæg til CMEMS' egen ~10 km
// opløsning for gitterafstanden efter STRIDE=2, se fetch_currents.py) er
// grænsen for hvornår et fundet punkt overhovedet kan kaldes "denne
// lokations" strøm — udover det er "intet strømdata" (null, samme
// behandling som i dag, når intet punkt findes) mere korrekt end at foregive
// præcision, en fjern gætning ikke har. Kun en tilnærmelse (samme grove
// grad-metrik uden cos(lat)-korrektion som resten af denne funktion allerede
// bruger), ikke en eksakt geodætisk grænse.
const MAX_MATCH_DIST_DEG = 0.135;

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
  // MAX_MATCH_DIST_DEG-grænse nedenfor.
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
    // RETTET: brugte tidligere en løsere 0,3°-tærskel her end selve
    // accept-grænsen (dengang 1,5°) — harmløst mens accept-grænsen var
    // løsere end denne. Nu hvor MAX_MATCH_DIST_DEG (0,135°) er STRAMMERE
    // end 0,3° ville et tidligt stop her kunne afbryde søgningen ved et
    // punkt, der alligevel bliver forkastet nedenfor, FØR et reelt tættere
    // punkt i en senere ring nås. Bruger derfor samme konstant begge steder.
    if (minDist < MAX_MATCH_DIST_DEG) break;
  }
  return minDist < MAX_MATCH_DIST_DEG ? nearest : null;
}

module.exports = { CURRENT_BUCKET_SIZE, buildCurrentGrid, getCurrentAtServer };
