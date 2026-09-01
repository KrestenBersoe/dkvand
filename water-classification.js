// ═══════════════════════════════════════════════════════════════════════════
// water-classification.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Server-side PORT af isInDanishWater() og dens hjælpefunktioner fra
// dansk-overloeb-kort.html (pointInRing, pointInGeometry, distToSegment,
// computeGeometryBbox, pointNearLine — se de respektive funktioner i
// frontend-filen for den oprindelige, autoritative version).
//
// HVORFOR DENNE FIL FINDES: om et PULS-udløbs koordinat ligger i dansk vand
// er en STATISK egenskab ved punktet — den ændrer sig aldrig, uafhængigt af
// vejr, tid eller hvilken bruger der spørger. Alligevel blev den genberegnet
// FOR HVER ENESTE SIDEVISNING, for alle 21.556 punkter, mod op til 109
// kystvand-polygoner + 985 sø-polygoner + 6.679 vandløbslinjer — målt til at
// dominere renderMap()'s samlede tid (op mod 2 sekunder), langt mere end
// selve risikoberegningen (se samtalen om første-sidevisnings ydelse).
// Beregnes derfor nu ÉN GANG her, cachet, og leveres færdigt via
// /api/risk-scores' isWater-felt — samme "beregn på serveren, ikke i hver
// klient" princip som risk-model.js allerede anvender for selve risikoen.
//
// VIGTIGT — HOLD DENNE FIL I SYNC MED FRONTEND'EN: hvis
// isInDanishWater()/pointInGeometry()/pointNearLine() ændres i dansk-
// overloeb-kort.html (fx en justeret bufferzone eller ny geometrikilde),
// SKAL den samme ændring foretages her, ellers vil server-leverede
// isWater-flag og klientens egen (fallback-)beregning stille og roligt
// komme til at afvige fra hinanden.
'use strict';

const fs = require('fs');
const path = require('path');

const VANDLOB_BUFFER_DEG = 0.0009; // ~100 m ved danske breddegrader — identisk med klientens konstant

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lat, lng, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates;
    if (!rings.length || !pointInRing(lat, lng, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) {
      if (pointInRing(lat, lng, rings[k])) return false; // inde i et hul
    }
    return true;
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(poly =>
      pointInGeometry(lat, lng, { type: 'Polygon', coordinates: poly }));
  }
  return false;
}

function distToSegment(lat, lng, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(lng - x1, lat - y1);
  let t = ((lng - x1) * dx + (lat - y1) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(lng - (x1 + t * dx), lat - (y1 + t * dy));
}

function pointNearLine(lat, lng, geometry, bufferDeg) {
  if (!geometry) return false;
  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      if (distToSegment(lat, lng, coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1]) < bufferDeg) return true;
    }
    return false;
  }
  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.some(line =>
      pointNearLine(lat, lng, { type: 'LineString', coordinates: line }, bufferDeg));
  }
  return false;
}

function computeGeometryBbox(geometry) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  (function walk(node) {
    if (typeof node[0] === 'number') {
      const x = node[0], y = node[1];
      if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
      if (x < minLng) minLng = x; if (x > maxLng) maxLng = x;
    } else {
      node.forEach(walk);
    }
  })(geometry.coordinates);
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Beregner isWater for HVERT punkt i `points` ({id, lat, lng}[]), mod de tre
 * VP3-geometrifiler i staticDir. Returnerer en Map<id, boolean>.
 * Læser filerne synkront ved kald — kaldes derfor kun ved opstart/periodisk
 * genopvarmning, ALDRIG pr. HTTP-forespørgsel (se server.js for hvor ofte).
 */
function computeWaterFlags(points, staticDir) {
  const t0 = Date.now();

  let loadFailed = false;
  function loadGeojson(filename) {
    try {
      const raw = fs.readFileSync(path.join(staticDir, filename), 'utf8');
      const features = JSON.parse(raw).features || [];
      if (features.length === 0) console.warn(`water-classification: ${filename} indlæst, men indeholder 0 features — mistænkeligt, men ikke behandlet som fejl`);
      return features;
    } catch (e) {
      console.warn(`water-classification: kunne ikke indlæse ${filename} — ${e.message}`);
      loadFailed = true;
      return [];
    }
  }

  const kystvandFeatures = loadGeojson('vp3_kystvande_simplified.geojson');
  const soeerFeatures    = loadGeojson('vp3_soeer.geojson');
  const vandlobFeatures  = loadGeojson('vp3_vandlob.geojson');

  // NYT: en DELVIS fejl (fx én manglende fil pga. en glemt COPY-linje i
  // Dockerfile — samme fejlklasse er set flere gange tidligere for
  // id15-filerne) må IKKE fortsætte stille med ufuldstændige data. Det
  // ville give et TAVST FORKERT isWater=false for punkter i netop den
  // manglende fils vandområde — sværere at opdage end en tydelig fejl,
  // fordi resultatet ser gyldigt ud (en bool, ikke null/undefined). En
  // total fejl her betyder klienten korrekt falder tilbage til sin egen,
  // fulde lokale beregning i stedet — langsommere, men aldrig forkert.
  if (loadFailed) {
    console.warn('water-classification: mindst én geometrifil manglede — springer HELE beregningen over for at undgå tavse, ufuldstændige isWater-resultater. Klienter falder tilbage til lokal beregning.');
    return new Map();
  }

  for (const f of kystvandFeatures) f._bbox = computeGeometryBbox(f.geometry);
  for (const f of soeerFeatures)    f._bbox = computeGeometryBbox(f.geometry);
  for (const f of vandlobFeatures)  f._bbox = computeGeometryBbox(f.geometry);

  const result = new Map();
  for (const pt of points) {
    const { lat, lng } = pt;

    const inKystvand = kystvandFeatures.some(f => {
      const b = f._bbox;
      if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) return false;
      return pointInGeometry(lat, lng, f.geometry);
    });

    let inSoe = false;
    if (!inKystvand) {
      inSoe = soeerFeatures.some(f => {
        const b = f._bbox;
        if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) return false;
        return pointInGeometry(lat, lng, f.geometry);
      });
    }

    let inVandlob = false;
    if (!inKystvand && !inSoe) {
      inVandlob = vandlobFeatures.some(f => {
        const b = f._bbox;
        if (lat < b.minLat - VANDLOB_BUFFER_DEG || lat > b.maxLat + VANDLOB_BUFFER_DEG ||
            lng < b.minLng - VANDLOB_BUFFER_DEG || lng > b.maxLng + VANDLOB_BUFFER_DEG) return false;
        return pointNearLine(lat, lng, f.geometry, VANDLOB_BUFFER_DEG);
      });
    }

    result.set(pt.id, inKystvand || inSoe || inVandlob);
  }

  console.log(`water-classification: ${result.size} punkter klassificeret på ${Date.now() - t0} ms ` +
    `(${kystvandFeatures.length} kystvande, ${soeerFeatures.length} søer, ${vandlobFeatures.length} vandløb)`);
  return result;
}

/**
 * IKKE-BLOKERENDE udgave af computeWaterFlags() — se filhovedet for hvorfor
 * den synkrone udgave forårsagede en fuld serverfrysning (Fly.io health-
 * check opfattede den blokerede proces som død). Behandler punkterne i
 * små portioner, og giver KONTROLLEN TILBAGE til Node's event loop mellem
 * hver portion (via setImmediate) — HTTP-forespørgsler kan derfor
 * besvares undervejs, i stedet for at vente på hele beregningen er færdig.
 * Selve algoritmen pr. punkt er UÆNDRET, kun selve løkke-strukturen er ny.
 */
async function computeWaterFlagsAsync(points, staticDir, batchSize = 250) {
  const t0 = Date.now();

  let loadFailed = false;
  function loadGeojson(filename) {
    try {
      const raw = fs.readFileSync(path.join(staticDir, filename), 'utf8');
      const features = JSON.parse(raw).features || [];
      if (features.length === 0) console.warn(`water-classification: ${filename} indlæst, men indeholder 0 features — mistænkeligt, men ikke behandlet som fejl`);
      return features;
    } catch (e) {
      console.warn(`water-classification: kunne ikke indlæse ${filename} — ${e.message}`);
      loadFailed = true;
      return [];
    }
  }

  const kystvandFeatures = loadGeojson('vp3_kystvande_simplified.geojson');
  const soeerFeatures    = loadGeojson('vp3_soeer.geojson');
  const vandlobFeatures  = loadGeojson('vp3_vandlob.geojson');

  if (loadFailed) {
    console.warn('water-classification: mindst én geometrifil manglede — springer HELE beregningen over. Klienter falder tilbage til lokal beregning.');
    return new Map();
  }

  for (const f of kystvandFeatures) f._bbox = computeGeometryBbox(f.geometry);
  for (const f of soeerFeatures)    f._bbox = computeGeometryBbox(f.geometry);
  for (const f of vandlobFeatures)  f._bbox = computeGeometryBbox(f.geometry);
  // NYT: selv denne forberedelse (gennemløber hver koordinat i alle
  // features for at finde min/max) gøres nu portionsvist mellem de tre
  // filer, ikke fordi det alene ville være for langsomt (det er O(antal
  // koordinater), ikke O(punkter×features) som hovedløkken), men for at
  // undgå selv en enkelt, uforudset lang synkron blok.
  await new Promise(resolve => setImmediate(resolve));

  const result = new Map();
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    for (const pt of batch) {
      const { lat, lng } = pt;

      const inKystvand = kystvandFeatures.some(f => {
        const b = f._bbox;
        if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) return false;
        return pointInGeometry(lat, lng, f.geometry);
      });

      let inSoe = false;
      if (!inKystvand) {
        inSoe = soeerFeatures.some(f => {
          const b = f._bbox;
          if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) return false;
          return pointInGeometry(lat, lng, f.geometry);
        });
      }

      let inVandlob = false;
      if (!inKystvand && !inSoe) {
        inVandlob = vandlobFeatures.some(f => {
          const b = f._bbox;
          if (lat < b.minLat - VANDLOB_BUFFER_DEG || lat > b.maxLat + VANDLOB_BUFFER_DEG ||
              lng < b.minLng - VANDLOB_BUFFER_DEG || lng > b.maxLng + VANDLOB_BUFFER_DEG) return false;
          return pointNearLine(lat, lng, f.geometry, VANDLOB_BUFFER_DEG);
        });
      }

      result.set(pt.id, inKystvand || inSoe || inVandlob);
    }
    // NYT: kernen i selve rettelsen — giv kontrollen tilbage til Node
    // mellem hver portion, så en ventende HTTP-forespørgsel kan nå at
    // blive besvaret, i stedet for at stå i kø bag hele beregningen.
    await new Promise(resolve => setImmediate(resolve));
  }

  console.log(`water-classification: ${result.size} punkter klassificeret på ${Date.now() - t0} ms (ikke-blokerende, portionsstørrelse ${batchSize}) ` +
    `(${kystvandFeatures.length} kystvande, ${soeerFeatures.length} søer, ${vandlobFeatures.length} vandløb)`);
  return result;
}

module.exports = { computeWaterFlags, computeWaterFlagsAsync, pointInGeometry, pointNearLine, computeGeometryBbox };
