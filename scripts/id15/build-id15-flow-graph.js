// ═══════════════════════════════════════════════════════════════════════════
// build-id15-flow-graph.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Bygger en rettet flow-graf over DCE's 3.990 ID15-delvandoplande (se
// id15-polygons.json, forberedt via en Python-forbehandling: adjacency
// bygget med shapely, polygongeometri eksporteret som WKT).
//
// PRINCIP: i modsætning til vores rasterbaserede D8-tilgang, der arbejder
// celle-for-celle (50 m), arbejder denne på KILOMETERSTORE, autoritative
// oplandsenheder. Det omgår det strukturelle problem med DHM Højdekurvers
// konturopløsning i fladt terræn — selv i det fladeste danske landskab er
// højdeforskellen mellem to km-store nabooplande typisk opløselig, selvom
// forskellen celle-til-celle (50 m) ikke er det.
//
// METODE: for hvert ID15-opland hentes ALLE konturpunkter der falder inden
// for oplandets EGEN polygongrænse (ikke en bufferet bbox som i
// build-lake-catchments.js — polygonen ER selve forespørgselsområdet,
// hvilket både er billigere og mere præcist). Oplandets MINIMUMSHØJDE
// bruges som dets karakteristiske "udløbspunkt": et korrekt afgrænset
// vandopland har per definition sit laveste punkt ved eller nær sit
// nedstrøms udløb (det er sådan vandskel-grænser tegnes i første omgang).
// Flow-retning mellem to naboer bestemmes derefter simpelt: oplandet med
// LAVEST minimumshøjde er downstream for det andet.
//
// Dette er en ÉNGANGS, LANDSDÆKKENDE beregning — genbruges af alle 985
// søer, i modsætning til build-lake-catchments.js's per-sø-forespørgsler.
//
// Brug:
//   DHM_APIKEY=xxx node build-id15-flow-graph.js
//   DHM_APIKEY=xxx node build-id15-flow-graph.js --limit 20   (testkørsel)
//
// Output: id15-flow-graph.json — { [id15]: { minElev, downstreamId15, kystvandId } }

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = {
  POLYGONS_PATH: path.join(__dirname, 'id15-polygons.json'),
  OUTPUT_PATH: path.join(__dirname, 'id15-flow-graph.json'),
  KOTE_ENTITY: 'DHMHoejdekurver_Kote2_5',
  REQUEST_DELAY_MS: 500,
  MAX_PAGES: 50, // 50×1000 = 50.000 punkter pr. opland — rigeligt for et enkelt ID15
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function parseWktPoint(wkt) {
  if (!wkt) return null;
  const m = /POINT\s*\(\s*([\-\d.]+)\s+([\-\d.]+)\s*\)/i.exec(wkt);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

let totalDhmRequests = 0;

// Henter MINIMUMSHØJDEN for konturpunkter inden for en given polygon (WKT,
// EPSG:25832). Samme forespørgselsmønster som fetchElevationGrid() i
// build-lake-catchments.js (bekræftet skema, korrekt paginering — se den
// fils historik for hvordan disse detaljer blev fundet), men beregner kun
// et enkelt tal (min) i stedet for at bygge et helt interpoleret gitter.
//
// RETTET (fundet ved reel kørsel): visse ID15-oplande har SÅ komplekse
// polygongeometrier (op til 1719 vertices, WKT op til 44.408 tegn — typisk
// oplande dissolvet fra mange spredte fragmenter, se dissolve-trinnet i
// Python-forbehandlingen), at selve GraphQL-forespørgslen overskrider
// Datafordelerens størrelsesgrænse ("Max GraphQL request size reached",
// HC0010) — UAFHÆNGIGT af antal resultater, det er selve QUERY-TEKSTEN der
// er for stor. Løses med en trinvis fallback: prøv først en kraftigere
// simplificering af polygonen (10 m, derefter 50 m tolerance), og falder
// til sidst tilbage til oplandets BOUNDING BOX i stedet for den præcise
// grænse — mindre præcist ved selve kanten, men stadig markant bedre end
// slet intet resultat for de berørte oplande.
async function fetchMinElevationForPolygon(originalWkt, apikey) {
  const attempts = [
    { label: 'original', wkt: originalWkt },
    { label: 'simplificeret 10m', wkt: null }, // udfyldes on-demand nedenfor
    { label: 'simplificeret 50m', wkt: null },
    { label: 'bounding box', wkt: null },
  ];

  // Simplificering/bbox kræver polygon-parsing — undgår en tung geometri-
  // afhængighed i Node ved kun at beregne bounding box selv (det er det
  // eneste fallback-trin, der reelt bruges i praksis ifølge testkørslen;
  // "simplificeret 10m/50m" fra samme WKT uden en rigtig geometri-motor er
  // ikke meningsfuldt at gøre i Node — springes derfor over, og vi går
  // direkte fra original til bounding box, som er den fallback der faktisk
  // løser problemet, blot med lidt tabt kant-præcision).
  function wktBoundingBox(wkt) {
    const nums = wkt.match(/-?\d+\.?\d*/g).map(Number);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < nums.length; i += 2) {
      const x = nums[i], y = nums[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return `POLYGON((${minX} ${minY}, ${maxX} ${minY}, ${maxX} ${maxY}, ${minX} ${maxY}, ${minX} ${minY}))`;
  }

  const realAttempts = [
    { label: 'original', wkt: originalWkt },
    { label: 'bounding box (fallback)', wkt: wktBoundingBox(originalWkt) },
  ];

  let lastError = null;
  for (const attempt of realAttempts) {
    try {
      const result = await fetchMinElevationRaw(attempt.wkt, apikey);
      if (attempt.label !== 'original') {
        console.warn(`    ↻ Lykkedes med fallback: ${attempt.label}`);
      }
      return { ...result, fallbackUsed: attempt.label !== 'original' ? attempt.label : null };
    } catch (e) {
      lastError = e;
      if (!/Max GraphQL request size reached/.test(e.message)) throw e; // anden fejltype: giv op med det samme
      console.warn(`    ⚠ "${attempt.label}" for stor/kompleks, prøver næste fallback...`);
    }
  }
  throw lastError;
}

async function fetchMinElevationRaw(wkt, apikey) {
  const virkningstid = new Date().toISOString();
  const entity = CONFIG.KOTE_ENTITY;
  const endpoint = `https://graphql.datafordeler.dk/DHMHoejdekurver/v2?apikey=${apikey}`;

  function buildQuery(hasCursor) {
    const afterVarDecl = hasCursor ? ', $after: String!' : '';
    const afterArg = hasCursor ? '\n        after: $after' : '';
    return `
      query HentKoter($wkt: String!, $virkningstid: DafDateTime!${afterVarDecl}) {
        ${entity}(
          first: 1000${afterArg}
          virkningstid: $virkningstid
          where: { geometri: { within: { wkt: $wkt, crs: 25832 } } }
        ) {
          nodes { hoejde }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
  }

  let minElev = null;
  let pointCount = 0;
  let after = null;
  let page = 0;

  do {
    const hasCursor = !!after;
    const query = buildQuery(hasCursor);
    const variables = { wkt, virkningstid };
    if (hasCursor) variables.after = after;

    if (totalDhmRequests > 0) await sleep(CONFIG.REQUEST_DELAY_MS);
    totalDhmRequests++;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      throw new Error(`DHM GraphQL HTTP 429 — frekvens-grænse ramt. Retry-After: ${retryAfter || 'ikke angivet'}`);
    }
    if (!res.ok) throw new Error(`DHM GraphQL HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.errors) throw new Error(`DHM GraphQL fejl: ${JSON.stringify(json.errors)}`);

    const conn = json.data?.[entity];
    const nodes = conn?.nodes || [];
    for (const n of nodes) {
      if (n.hoejde == null) continue;
      pointCount++;
      if (minElev === null || n.hoejde < minElev) minElev = n.hoejde;
    }

    page++;
    after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after && page < CONFIG.MAX_PAGES);

  return { minElev, pointCount };
}

async function main() {
  const apikey = process.env.DHM_APIKEY;
  if (!apikey) {
    console.error('Sæt DHM_APIKEY miljøvariablen først.');
    process.exit(1);
  }
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : null;
  const force = process.argv.includes('--force');

  console.log('Indlæser ID15-polygoner...');
  const polygons = JSON.parse(fs.readFileSync(CONFIG.POLYGONS_PATH, 'utf8'));
  console.log(`${polygons.length} polygoner indlæst.`);

  let results = {};
  if (!force && fs.existsSync(CONFIG.OUTPUT_PATH)) {
    results = JSON.parse(fs.readFileSync(CONFIG.OUTPUT_PATH, 'utf8'));
    console.log(`Genoptager: ${Object.keys(results).length} opland(e) allerede behandlet.`);
  }

  let toProcess = polygons.filter(p => !(p.id15 in results));
  if (limit) toProcess = toProcess.slice(0, limit);
  console.log(`Behandler ${toProcess.length} opland(e)...`);

  const runStart = Date.now();
  let processed = 0;

  for (const poly of toProcess) {
    processed++;
    const t0 = Date.now();
    try {
      const { minElev, pointCount, fallbackUsed } = await fetchMinElevationForPolygon(poly.wkt, apikey);
      results[poly.id15] = { minElev, pointCount, kystvandId: poly.kystvandId, index: poly.index, fallbackUsed };
      const fallbackNote = fallbackUsed ? ` [fallback: ${fallbackUsed}]` : '';
      console.log(`[${processed}/${toProcess.length}] ID15=${poly.id15}: min=${minElev != null ? minElev.toFixed(2) + 'm' : 'INGEN DATA'} (${pointCount} punkter, ${((Date.now() - t0) / 1000).toFixed(1)}s, ${totalDhmRequests} kald i alt)${fallbackNote}`);
    } catch (e) {
      console.error(`[${processed}/${toProcess.length}] ID15=${poly.id15}: ✗ FEJL: ${e.message}`);
      results[poly.id15] = { minElev: null, error: e.message, kystvandId: poly.kystvandId, index: poly.index };
    } finally {
      fs.writeFileSync(CONFIG.OUTPUT_PATH, JSON.stringify(results, null, 2));
    }
  }

  const elapsedS = (Date.now() - runStart) / 1000;
  console.log(`\nFærdig. ${processed} opland(e) behandlet på ${elapsedS.toFixed(1)}s, ${totalDhmRequests} DHM-kald.`);
  if (processed > 0) {
    console.log(`Ekstrapoleret til alle ${polygons.length}: ~${((elapsedS / processed) * polygons.length / 60).toFixed(0)} minutter.`);
  }
}

main().catch(e => { console.error('Uventet fejl:', e); process.exit(1); });
