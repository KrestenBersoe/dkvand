// ═══════════════════════════════════════════════════════════════════════════
// badevand-risk.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Server-side PORT af colorSoeerByRisk(), colorKystvandByRisk() og
// computeBadevandRisk() fra dansk-overloeb-kort.html — se de respektive
// funktioner dér for den oprindelige, autoritative logik og dens fulde
// historik/begrundelse.
//
// HVORFOR DENNE FIL FINDES: colorBadevandByRisk() blev målt til at blokere
// browseren i 6-6,4 SEKUNDER ved hver eneste sidevisning (1.039 badesteder
// × op til 985 søer + 109 kystvande + 5.227 vandløbslinjer, alt sammen
// synkron geometri-test). En bbox-optimering af selve vandløbs-testen gav
// ingen målbar forbedring — problemet er strukturelt (samme dyre kaskade
// gentaget for hver bruger, hver sidevisning), ikke en lokal ineffektivitet
// der kan finjusteres væk. Løsningen, i tråd med samme princip som
// risk-scores og isWater: beregn ÉN GANG pr. opdateringscyklus, server-side,
// server resultatet færdigt.
//
// RETTET (var oprindeligt bevidst udeladt her, med en forkert
// begrundelse — se risk-model.js's computeAlgaeRisk() filhoved for den
// fulde historik): ALGERISIKO er nu MED. CMEMS-strømdata/havtemperatur
// har allerede været hentet og cachet server-side i lang tid (samme
// currentsCache, brugt til strømkortet) — det var kun selve
// beregningen, der manglede at blive flyttet fra klienten.
//
// VIGTIGT — HOLD I SYNC MED KLIENTEN: ændres colorSoeerByRisk()/
// colorKystvandByRisk()/computeBadevandRisk() i dansk-overloeb-kort.html,
// SKAL den tilsvarende ændring foretages her, ellers vil server-leverede
// og lokalt beregnede badevands-tal stille komme til at afvige.
//
// ═══════════════════════════════════════════════════════════════════════════
// MODEL-OVERSIGT: udløbsklassifikation, positive nul-kategorier, afstand
// ═══════════════════════════════════════════════════════════════════════════
//
// UDLØBSTYPE (isWastewater, se risk-model.js's derivePulsFields() og
// PULS_NO_WASTEWATER_CODES): bakteriel/viral-risiko drives udelukkende af
// udløb, der reelt indeholder spildevand — PULS' sewerStructure-koder SE/SF
// ("Separat regnvand") sættes til null for riskScore/viralScore/foreRisk
// FØR nogen aggregering. algaeScore er upåvirket af dette felt (næringsstof-
// afstrømning fra regnvand indgår fortsat i algemodellen).
//
// "BEKRÆFTET INGEN SPILDEVANDSKILDE" (confirmedNoOutlet, lakes[navn]/
// kystvande[ov_id]): en positiv kategori, adskilt fra både en reel målt
// score og en ubekræftet datamangel. Sand hvis ÉN af tre betingelser
// gælder: (a) ID15's terrænsporing bekræfter eksplicit et tomt opland,
// (b) mindst ét udløb er matchet, men samtlige er bekræftet regnvand, eller
// (c) intet udløb er matchet overhovedet (hverken RBU/tekstmatch eller
// ID15). Findes på to niveauer: vandområdets SAMLEDE tilstand (sat i selve
// søe-/kystvand-opbygningsløkkerne) og et enkelt badesteds EGET, afstands-/
// strømfiltrerede resultat (computeIsotropicLakeResult()/
// -KystvandResult(), via sawContributingOutlet-mønsteret) — et vandområde
// kan have spildevandsudløb ét sted, mens et specifikt badested kun ser
// regnvandsudløb i sin egen relevante delmængde.
//
// AFSTANDSGRÆNSE PR. BADESTED (KYSTVAND_TEXTMATCH_MAX_DIST_M /
// SOE_NAVNEMATCH_MAX_DIST_M, 10 km, håndhævet i
// computeOutletDirectionalContribution() og computeIsotropicLakeResult()):
// et udløb tæller kun med i et SPECIFIKT badesteds bact/viral-resultat,
// hvis det ligger inden for 10 km af selve badestedet — uafhængigt af om
// det i forvejen er optaget i vandområdets samlede udløbspulje (som måles
// til polygonens/søens kant, ikke til det enkelte badested, og derfor kan
// være langt bredere for store kystvand-/sø-polygoner).
// [ANTAGELSE, IKKE MÅLT]: 10 km-grænsen er et modelvalg, ikke en valideret
// konstant — der findes ingen etableret faglitteratur for præcis hvilken
// afstand et strøm-øjebliksbillede holder op med at være meningsfuldt for
// flerdages-transport. Genbruger samme værdi som den eksisterende
// polygon-/sø-brede grænse, for konsistens.
//
// KYSTVANDENES BACT/VIRAL-VISNINGSVÆRDI (kystvande[props.ov_id], se
// kystvandBadevandContrib efter badevands-løkken): for et kystvand med
// mindst ét matchet badested er den viste værdi gennemsnittet af de
// FAKTISKE badesteders egne, allerede afstands-/strømkorrigerede
// resultater — for et kystvand uden noget matchet badested (fx åbent hav
// uden registrerede strande) er den i stedet gennemsnittet af selve
// udløbspuljens rå riskScore/viralScore. Individuelle badesteders egen
// markørfarve er upåvirket af hvilken af de to der bruges — den kystvand-
// brede værdi indgår kun som fallback, når et badested selv har nul
// matchede udløb.
'use strict';

const fs = require('fs');
const path = require('path');
const waterClass = require('./water-classification');

const WATERBODY_MATCH_BUFFER_DEG = 0.0045; // ~500 m — øget fra 0,003° (~334 m), se diagnose-badevand-afstand.js: fangede kun 88,8% af geometrisk-nære badesteder ved 334 m, 500 m fanger 96,6%. Forenklet kystvandgeometri (vp3_kystvande_simplified.geojson) trækker kanter indad ved komplekse kystlinjer, hvilket 334 m ikke kompenserede nok for. HOLD I SYNC med klientens konstant i dansk-overloeb-kort.html.
const VANDLOB_BUFFER_DEG = 0.0045;         // RETTET: hævet fra 0,0009° (~100 m) til samme 500 m som ovenfor, af samme årsag (se diagnose-badevand-afstand.js). HOLD I SYNC med klientens konstant.

// NYT: separat, STRAM bufferzone kun til at afgøre om et vandløbssegments
// ENDEPUNKT topologisk rører en sø (dvs. "løber dette vandløb ud i/fra
// søen") — bevidst IKKE samme løse 500 m som ovenfor. Den løse buffer er
// kalibreret til badevandspunkt-til-polygon-matching (tolerance for
// forenklet geometri); her skal vi undgå at koble et vandløb til en sø,
// det reelt ikke rører, bare fordi det ligger i nærheden. ~110 m.
const SEGMENT_LAKE_TOUCH_BUFFER_DEG = 0.001;

// RETTET: NY TIER — opstrøms udledninger til søer via vandløbsnetværket,
// retningsfiltreret. Se samtalen der førte hertil: Farum Sø fik tidligere
// fejlagtigt Fiskebæk Å's (bekræftet AFLØB, strømretning mod Furesøen)
// fulde, uhenfaldede score, fordi den eneste søkobling (ID15) hverken har
// retning ELLER fungerende henfald (rejsetid var 0t for de pågældende
// udløb — se id15-lake-matches.json). Denne tier bruger i stedet
// vandlob-directions.json (BEKRÆFTET retning, confidence==='sikker' KUN)
// til at inkludere udelukkende segmenter, der beviseligt løber IND i
// søen, aldrig ud af den. Segmenter med usikker retning udelades bevidst
// af DENNE tier (føjer ikke data til uden at kunne bekræfte den er
// korrekt) — de kan stadig bidrage via RBU/ID15/navnematch som hidtil.
//
// [ANTAGELSE, IKKE MÅLT]: vandlob-upstream-matches.json indeholder ingen
// afstand/rejsetid pr. udløb (kun pulsPointIds + lowConfidence) — kun
// ID15-sø-koblingen har det. Henfald her er derfor baseret på
// LUFTLINJE-afstand fra udløb til søens indløbspunkt, omregnet til en
// antaget rejsetid via en antaget strømningshastighed for mindre danske
// lavlandsvandløb. Det er en tilnærmelse, ikke en målt værdi — bør valideres
// eller erstattes, hvis en bedre kilde til faktisk rejsetid findes.
const ASSUMED_STREAM_VELOCITY_M_PER_S = 0.3;

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// NYT (kystvande-tekstmatch/"Stavns Fjord"-fejlen): en fysisk, absolut
// afstandsgrænse for hvor langt et udløb kan bidrage til et kystvands
// tekstmatch-score, UANSET om selve teksten matcher eksakt. Fandtes ikke
// tidligere — eksakt navnematch alene stoppede IKKE ~100+ udløb spredt
// over 35+ km fra at blive koblet til "Stavns Fjord", fordi deres
// waterArea-felt i selve PULS-kildedataen fejlagtigt/groft var sat til
// samme recipient-navn. Ingen autoritativ dansk/EU-standard for denne
// afstand blev fundet ved websøgning (badevandsdirektivet og de danske
// bekendtgørelser definerer VANDOMRÅDER og kvalitetskrav, ikke en fast
// påvirkningsradius for enkelte udløb — det afhænger reelt af strøm/
// tidevand/udledningsmængde, som er præcis det en hydrodynamisk model
// som DHI beregner pr. lokation). 10 km er derfor et pragmatisk, eksplicit
// valgt loft — ikke en målt eller fagligt udledt konstant.
const KYSTVAND_TEXTMATCH_MAX_DIST_M = 10000;

// RETTET (bruger-rapporteret: Furesøen/Høje Klint viste "UA10" — et udløb i
// Roskilde Kommune, 25,4 km væk, med Roskilde Fjord som RIGTIG recipient —
// som øverste opstrøms-match) — PRÆCIS samme fejlklasse som Stavns Fjord-
// hændelsen ovenfor, blot i søernes rbuMatchData/nameMatchData (se
// nedenfor) i stedet for kystvandenes. PULS-udløbskoder er IKKE globalt
// unikke — bekræftet: TRE forskellige, urelaterede udløb hedder "UA10"
// (Roskilde, Esbjerg, og det reelt Furesø-tilknyttede i Rudersdal
// kommune). rbu-lake-links.json's forb_id-koblinger og nameMatchData's
// waterArea-tekstmatch matcher begge udelukkende på UDLØBSNAVN — uden
// nogen afstandskontrol pulled de derfor ALLE tre "UA10"-udløb ind som
// "bekræftet" Furesø-tilknyttet, uanset fysisk placering. Samme 10 km-
// pragmatiske loft genbruges her — se kommentaren ovenfor for den fulde
// begrundelse (ingen fagligt udledt konstant findes, kun et bevidst valgt
// sikkerhedsnet mod navnekollisioner).
const SOE_NAVNEMATCH_MAX_DIST_M = 10000;

// Måler et punkts afstand (meter) til NÆRMESTE KANT af en polygon — 0 hvis
// punktet er inde i den. Mere præcist end en bounding-box-test, som kan
// være vildledende stor for en aflang eller uregelmæssig kyststrækning
// (et punkt kan ligge "inden for bbox'en", men stadig være langt fra selve
// kysten). Genbruger samme distToSegment-princip som isPointNearPolygonEdge.
function polygonEdgeDistanceM(lat, lng, geometry) {
  if (waterClass.pointInGeometry(lat, lng, geometry)) return 0;
  function distToSegment(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    if (dx === 0 && dy === 0) return Math.hypot(lng - x1, lat - y1);
    let t = ((lng - x1) * dx + (lat - y1) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(lng - (x1 + t * dx), lat - (y1 + t * dy));
  }
  let minDeg = Infinity;
  function walkRing(ring) {
    for (let i = 0; i < ring.length - 1; i++) {
      const d = distToSegment(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
      if (d < minDeg) minDeg = d;
    }
  }
  if (geometry.type === 'Polygon') geometry.coordinates.forEach(walkRing);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(poly => poly.forEach(walkRing));
  // Grov grad->meter-omregning (~111.320 m/grad ved danske breddegrader) —
  // samme tilnærmelse som allerede brugt i diagnose-badevand-afstand.js,
  // tilstrækkelig præcis til en 10 km-grænsevurdering.
  return minDeg * 111320;
}

// ── Normalisering — identisk port af normSoeName()/stripPulsRecipientPrefix() ──
function normSoeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripPulsRecipientPrefix(s) {
  let t = String(s || '');
  t = t.replace(/^\d+(\.\d+)*\s*-?\s*/i, '');
  t = t.replace(/^afl[øo]b(et)?\s+(fra|til)\s+/i, '');
  t = t.replace(/^udl[øo]b(et)?\s+(fra|til)\s+/i, '');
  t = t.replace(/^tilb?l[øo]b(et)?\s+(fra|til)\s+/i, '');
  return t.trim();
}

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn(`badevand-risk: kunne ikke indlæse ${p} — ${e.message}`); return fallback; }
}

/**
 * Beregner søers, kystvandes og badesteders bakteriel/viral risiko —
 * fuld server-side gengivelse af klientens Trin 0/0,5/1/2-kaskade.
 *
 * RETTET (proaktivt, FØR nogen produktionshændelse — se water-
 * classification.js for hvorfor dette ikke er valgfrit): en tidligere
 * server-side geometri-beregning i denne kodebase (isWater) tog hele
 * appen ned, fordi den kørte synkront og blokerede Node's event loop så
 * længe beregningen tog. Badevands-delen her har SAMME struktur (1.039
 * badesteder × op til ~6.000 geometrier) og kunne ramme nøjagtig samme
 * fælde. Er derfor ASYNKRON og giver kontrollen tilbage til event loopet
 * mellem hver portion badesteder, ligesom computeWaterFlagsAsync().
 *
 * @param {Array} points - PULS-punkter MED riskScore/viralScore/waterArea/name allerede sat (fra loadPulsPointsFull() + risiko-beregning)
 * @param {Function} seasonalTau - fra risk-model.js
 * @param {Function} seasonalTauViral - fra risk-model.js
 * @param {string} staticDir
 * @returns {Promise<{ lakes: object, kystvande: object, badevand: Array }>}
 */
// NYT: getCurrentAt (valgfri, standard null) — funktion (lat,lng) =>
// {uo,vo,speed,dir,temp}|null, samme format som server.js's
// getCurrentAtServer()/currentsCache.grid. Bruges KUN af kystvandenes
// isotropiske model (se computeIsotropicKystvandResult()) til at udelukke
// nedstrøms/tværgående udløb og bruge målt strømhastighed for bekræftede
// opstrøms udløb — søer har ingen CMEMS-dækning og påvirkes ikke.
// Valgfri (kan udelades/være null) for bagudkompatibilitet med
// eksisterende tests/kald uden strømdata — falder da tilbage til den
// hidtidige, retningsblinde model for ALLE kystvands-udløb.
async function computeBadevandRiskCascade(points, seasonalTau, seasonalTauViral, staticDir, batchSize = 100, getCurrentAt = null) {
  const t0 = Date.now();

  // RETTET (bruger-ønske 2026-07-25/26): bekræftede rene regnvandsudløb (se
  // risk-model.js's derivePulsFields()/isWastewater) skal IKKE tælle med i
  // bakteriel/viral-risikoen (nu OG prognose) for badesteder/søer/
  // kystvande — kun i algaeScore, hvor nedbørs-/næringsstofafstrømning fra
  // regnvand rent faktisk ER relevant, i modsætning til fækal bakterie-/
  // virus-forurening. foreRisk er PROGNOSE-udgaven af riskScore (samme
  // bakterielle model, se risk-model.js's computeForecastRisk()) og skal
  // derfor nulstilles af samme grund — RETTET 2026-07-26 (oversete ved
  // første omgang, opdaget da push-varslernes brug af foreRisk skulle
  // bringes i overensstemmelse med samme filter, se server.js's
  // enqueuePushNotifications()). `points` deles med server.js's generelle
  // overløbskort og push-evaluering (samme objektreferencer) — de
  // originale pt-objekter må derfor IKKE muteres her. En ny, lokal kopi
  // (kun for regnvandsudløb) bruges i stedet for resten af denne funktion
  // (pointsById, RBU-/navnematch-/vandløbs-løkkerne, toOutlet() m.fl.) —
  // algaeScore/lat/lng/name er uændrede.
  points = points.map(p => p.isWastewater === false ? { ...p, riskScore: null, viralScore: null, foreRisk: null } : p);

  // RETTET (KRITISK — server holdt helt op med at svare): getCurrentAt()
  // (se server.js's getCurrentAtServer) har et LINEÆRT SCAN over alle
  // ~1.478 strømpunkter som fallback, hver gang det hurtige, afrundede
  // gitteropslag ikke rammer præcist — dyrt, men uproblematisk ved den
  // oprindelige brug (højst 21.556 kald totalt, ét pr. PULS-punkt). Den
  // retningsbevidste kystvandsmodel kalder den nu i stedet for HVERT
  // udløb (op til 300+ for store polygoner som Øresund) for HVERT
  // kystvand-matchet badevandspunkt — potentielt hundredtusindvis af
  // dyre opslag pr. beregningscyklus, nok til at blokere Node's
  // enkelttrådede event loop så længe at ALT (ikke kun badevand-risk)
  // holdt op med at svare. Memoiseres nu pr. kørsel, afrundet til ~1 km
  // (3 decimaler) — CMEMS' egen opløsning er alligevel ~10 km, så denne
  // afrunding taber ingen reel præcision, men lader mange geografisk
  // nærliggende udløb dele samme, allerede opslåede resultat.
  const currentCache = new Map();
  const getCurrentAtCached = getCurrentAt ? (lat, lng) => {
    const key = `${lat.toFixed(3)}:${lng.toFixed(3)}`;
    if (currentCache.has(key)) return currentCache.get(key);
    const result = getCurrentAt(lat, lng);
    currentCache.set(key, result);
    return result;
  } : null;

  const rbuLakeLinks       = loadJson(path.join(staticDir, 'rbu-lake-links.json'), {});
  const id15LakeMatches    = loadJson(path.join(staticDir, 'id15-lake-matches.json'), {});
  const id15KystvandMatches = loadJson(path.join(staticDir, 'id15-kystvand-matches.json'), {});
  const soeerGeojson       = loadJson(path.join(staticDir, 'vp3_soeer.geojson'), { features: [] });
  const kystvandGeojson    = loadJson(path.join(staticDir, 'vp3_kystvande_simplified.geojson'), { features: [] });
  const badevandGeojson    = loadJson(path.join(staticDir, 'vp3_badevand.geojson'), { features: [] });
  const vandlobDisplay     = loadJson(path.join(staticDir, 'vandlob-display.json'), []);
  const vandlobUpstream    = loadJson(path.join(staticDir, 'vandlob-upstream-matches.json'), []);
  const vandlobDirections  = loadJson(path.join(staticDir, 'vandlob-directions.json'), []);
  const vandlobUpstreamByIndex = {};
  for (const entry of vandlobUpstream) vandlobUpstreamByIndex[entry.index] = entry;
  const vandlobDirectionByIndex = {};
  for (const entry of vandlobDirections) vandlobDirectionByIndex[entry.index] = entry;

  // ── Vandløb-cache (kun linjer med mindst ét matchet udløb) — flyttet op
  // hertil (var tidligere bygget lige før badevand-løkken) fordi den nye
  // sø-indløbstier nedenfor skal bruge den. `coordsRaw` beholder [lat,lng]
  // i original rækkefølge (A=først, B=sidst) — nødvendigt for at afgøre
  // hvilken ende der rører søen og matche mod vandlob-directions.json's
  // 'AtilB'/'BtilA'-værdier, som er relative til DENNE rækkefølge. ─────────
  const vandlobEntries = [];
  // RETTET (rodårsag til at VD-U57/52/53 stadig ikke blev udelukket, trods
  // korrekt retningslogik): denne liste indeholder KUN segmenter med mindst
  // ét matchet pulsPointIds i vandlob-upstream-matches.json — men vi
  // bekræftede tidligere i samtalen (direkte filanalyse) at VD-U52/57/53
  // slet ikke findes i NOGET segments pulsPointIds, ud af alle 5.227.
  // outflow-detektion kan derfor IKKE bruge denne liste eller dens
  // pulsPointIds — se allDirectionSegments nedenfor, som i stedet tester
  // hvert udløbs EGNE koordinater direkte mod segmentgeometrien.
  for (const entry of vandlobDisplay) {
    const match = vandlobUpstreamByIndex[entry.index];
    if (!match || !match.pulsPointIds || match.pulsPointIds.length === 0) continue;
    const geometry = { type: 'LineString', coordinates: entry.coords.map(([lat, lng]) => [lng, lat]) };
    vandlobEntries.push({
      index: entry.index, geometry, bbox: waterClass.computeGeometryBbox(geometry), match,
      coordsRaw: entry.coords, direction: vandlobDirectionByIndex[entry.index] || null,
    });
  }
  // NYT: ALLE segmenter med retningsdata, UANSET om de har nogen
  // pulsPointIds-kobling i vandlob-upstream-matches.json. Bruges
  // UDELUKKENDE til at finde bekræftede AFLØBSSEGMENTER (touching en given
  // sø) — selve udelukkelsen af et specifikt udløb sker ved at teste
  // UDLØBETS EGNE koordinater mod segmentets geometri (pointNearLine),
  // ikke via en forudberegnet punkt-til-segment-kobling, som VD-U57/52/53
  // beviseligt mangler.
  const allDirectionSegments = [];
  for (const entry of vandlobDisplay) {
    const direction = vandlobDirectionByIndex[entry.index];
    if (!direction || direction.confidence !== 'sikker' || !direction.direction) continue;
    const geometry = { type: 'LineString', coordinates: entry.coords.map(([lat, lng]) => [lng, lat]) };
    allDirectionSegments.push({
      index: entry.index, geometry, bbox: waterClass.computeGeometryBbox(geometry),
      coordsRaw: entry.coords, direction,
    });
  }

  const pointsById = {};
  for (const p of points) pointsById[p.id] = p;

  // NYT: løfter et matchet PULS-punkt til klientens outlet-format (samme
  // felter som den lokale computeBadevandRisk() altid har brugt, se
  // dansk-overloeb-kort.html linje ~5200) — genbruges af alle tre kilder
  // (RBU/ID15/navnematch for søer, tekstmatch/ID15 for kystvande,
  // opstrøms-match for vandløb) nedenfor.
  function toOutlet(pt) {
    // NYT (ustabil-id-rettelse — se server.js's loadPulsPointsFull()):
    // outfallId (stabil GUID) medbringes nu også — uden den brugte
    // klientens udløbslister (badevands-/sø-panelernes "Vis udløb"-klik,
    // se goToPointDeepLink() i dansk-overloeb-kort.html) stadig id
    // (rækkeindekset) til selve deep-linket. Et FRISKT serversvar (denne
    // liste) og klientens EGET, evt. IndexedDB-cachede puls-data.json (op
    // til 14 dage gammelt, se TTL_PULS_MS) kan referere FORSKELLIGE
    // rækkeindeks-ordner — id 4050 kunne dermed være "F-U9" i det friske
    // svar, men et helt andet udløb i klientens forældede lokale kopi,
    // nøjagtig den fejl der oprindelig blev rapporteret ("F-U9 i
    // Furesø" åbnede et udløb i Odense).
    return { id: pt.id, outfallId: pt.outfallId ?? null, name: pt.name, municipality: pt.municipality, lat: pt.lat, lng: pt.lng,
             riskScore: pt.riskScore ?? null, viralScore: pt.viralScore ?? null, algaeScore: pt.algaeScore ?? null,
             // NYT (bruger-ønske 2026-07-26): se derivePulsFields()'s filhoved —
             // bruges af computeIsotropicLakeResult()/-KystvandResult() til at
             // afgøre om et badesteds NULL bact/viral (efter afstands-/strøm-
             // filtrering) skyldes bekræftet regnvand (grøn) eller en anden,
             // reel datamangel (blå).
             isWastewater: pt.isWastewater };
  }
  // Samler en Set af bidragende punkt-ID'er til en dedupliceret, klientklar
  // outlet-liste. Bruges ved sammenlægning af flere kilder pr. sø/kystvand.
  function resolveOutlets(idSet) {
    const out = [];
    for (const id of idSet) { const pt = pointsById[id]; if (pt) out.push(toOutlet(pt)); }
    return out;
  }

  // ── Trin 0: RBU-koblinger ────────────────────────────────────────────────
  const rbuMatchData = new Map();
  for (const pt of points) {
    const soeNavn = rbuLakeLinks[String(pt.name || '').toLowerCase()];
    if (!soeNavn) continue;
    const key = normSoeName(soeNavn);
    let rec = rbuMatchData.get(key);
    if (!rec) { rec = { risk: null, viral: null, algae: null, forecast: null, ids: new Set() }; rbuMatchData.set(key, rec); }
    rec.ids.add(pt.id);
    if (pt.riskScore  != null && (rec.risk  === null || pt.riskScore  > rec.risk))  rec.risk  = pt.riskScore;
    if (pt.viralScore != null && (rec.viral === null || pt.viralScore > rec.viral)) rec.viral = pt.viralScore;
    if (pt.algaeScore != null && (rec.algae === null || pt.algaeScore > rec.algae)) rec.algae = pt.algaeScore;
    // NYT: 24-timers nedbørsprognose — se filhovedets ASSUMED_STREAM_VELOCITY-
    // note for det generelle princip; her ingen dæmpning overhovedet (samme
    // som alge, og samme som klientens tidligere lokale kystvand-prognose
    // ALDRIG havde nogen rejsetids-vægtning — se badevand-risk.js-historikken).
    if (pt.foreRisk != null && (rec.forecast === null || pt.foreRisk > rec.forecast)) rec.forecast = pt.foreRisk;
  }

  // ── Trin 1: navnebaseret opslag fra PULS waterArea ──────────────────────
  const nameMatchData = new Map();
  for (const pt of points) {
    const raw = pt.waterArea || '';
    if (!raw || !/sø/i.test(raw)) continue;
    const key = normSoeName(stripPulsRecipientPrefix(raw));
    if (!key) continue;
    let rec = nameMatchData.get(key);
    if (!rec) { rec = { risk: null, viral: null, algae: null, forecast: null, ids: new Set() }; nameMatchData.set(key, rec); }
    rec.ids.add(pt.id);
    if (pt.riskScore  != null && (rec.risk  === null || pt.riskScore  > rec.risk))  rec.risk  = pt.riskScore;
    if (pt.viralScore != null && (rec.viral === null || pt.viralScore > rec.viral)) rec.viral = pt.viralScore;
    if (pt.algaeScore != null && (rec.algae === null || pt.algaeScore > rec.algae)) rec.algae = pt.algaeScore;
    if (pt.foreRisk != null && (rec.forecast === null || pt.foreRisk > rec.forecast)) rec.forecast = pt.foreRisk;
  }

  // NYT: finder vandløbssegmenter der er BEKRÆFTET AFLØB fra denne sø
  // (samme touch-/retningslogik som computeVandlobInflowRec, men over
  // allDirectionSegments — ALLE segmenter med retningsdata, ikke kun dem
  // med en pulsPointIds-kobling). Returnerer segmentgeometrierne selv, så
  // ethvert udløbs EGNE koordinater efterfølgende kan testes direkte mod
  // dem (se isPointOnAnySegment nedenfor) — uafhængigt af om det udløb
  // nogensinde blev koblet til segmentet i vandlob-upstream-matches.json.
  function findConfirmedOutflowSegments(lakeGeometry, lakeBbox) {
    const segments = [];
    for (const v of allDirectionSegments) {
      const b = v.bbox;
      if (lakeBbox.minLat - SEGMENT_LAKE_TOUCH_BUFFER_DEG > b.maxLat || lakeBbox.maxLat + SEGMENT_LAKE_TOUCH_BUFFER_DEG < b.minLat ||
          lakeBbox.minLng - SEGMENT_LAKE_TOUCH_BUFFER_DEG > b.maxLng || lakeBbox.maxLng + SEGMENT_LAKE_TOUCH_BUFFER_DEG < b.minLng) continue;
      const A = v.coordsRaw[0], Bp = v.coordsRaw[v.coordsRaw.length - 1];
      const aNearLake = waterClass.pointInGeometry(A[0], A[1], lakeGeometry) || isPointNearPolygonEdge(A[0], A[1], lakeGeometry, SEGMENT_LAKE_TOUCH_BUFFER_DEG);
      const bNearLake = waterClass.pointInGeometry(Bp[0], Bp[1], lakeGeometry) || isPointNearPolygonEdge(Bp[0], Bp[1], lakeGeometry, SEGMENT_LAKE_TOUCH_BUFFER_DEG);
      if (!aNearLake && !bNearLake) continue;
      if (aNearLake && bNearLake) continue;
      const nearEnd = aNearLake ? 'A' : 'B';
      const farEnd   = aNearLake ? 'B' : 'A';
      if (v.direction.direction === `${nearEnd}til${farEnd}`) segments.push(v); // strøm FRA søen — bekræftet afløb
    }
    return segments;
  }
  // Tester om et punkts EGNE koordinater ligger inden for VANDLOB_BUFFER_DEG
  // af mindst ét af de givne segmenter — samme tolerance/mønster som den
  // generelle badevand-til-vandløb-matching allerede bruger.
  function isPointOnAnySegment(lat, lng, segments) {
    for (const seg of segments) {
      const b = seg.bbox;
      if (lat < b.minLat - VANDLOB_BUFFER_DEG || lat > b.maxLat + VANDLOB_BUFFER_DEG ||
          lng < b.minLng - VANDLOB_BUFFER_DEG || lng > b.maxLng + VANDLOB_BUFFER_DEG) continue;
      if (waterClass.pointNearLine(lat, lng, seg.geometry, VANDLOB_BUFFER_DEG)) return true;
    }
    return false;
  }

  // NYT: finder vandløbssegmenter der BEVISELIGT løber IND i denne sø
  // (endepunkt inden for SEGMENT_LAKE_TOUCH_BUFFER_DEG af søens polygon,
  // OG bekræftet retning — confidence==='sikker' — peger mod det
  // søgende endepunkt, ikke væk fra det). Segmenter med usikker retning
  // udelades bevidst — se filhovedets begrundelse. For hvert bekræftet
  // indløb henfaldes de tilknyttede udløbs risikoscore med luftlinje-
  // afstand fra udløb til søens indløbspunkt, omregnet til en antaget
  // rejsetid (se ASSUMED_STREAM_VELOCITY_M_PER_S — en tilnærmelse, ikke
  // en målt værdi).
  //
  // RETTET: håndterede tidligere OGSÅ afløbs-udelukkelse (outflowIds) her,
  // via segmenternes pulsPointIds — men vi bekræftede direkte i
  // vandlob-upstream-matches.json at VD-U52/57/53 slet ikke findes i NOGET
  // segments pulsPointIds. Den udelukkelse virkede derfor aldrig i praksis.
  // Afløbs-udelukkelse sker nu i stedet via findConfirmedOutflowSegments()
  // + isPointOnAnySegment() ovenfor, som tester hvert udløbs EGNE
  // koordinater direkte mod segmentgeometrien — uafhængigt af
  // pulsPointIds-koblingen.
  function computeVandlobInflowRec(lakeGeometry, lakeBbox, tau, tauV) {
    let rBact = null, rViral = null, rAlgae = null, rForecast = null;
    const ids = new Set();
    for (const v of vandlobEntries) {
      const b = v.bbox;
      if (lakeBbox.minLat - SEGMENT_LAKE_TOUCH_BUFFER_DEG > b.maxLat || lakeBbox.maxLat + SEGMENT_LAKE_TOUCH_BUFFER_DEG < b.minLat ||
          lakeBbox.minLng - SEGMENT_LAKE_TOUCH_BUFFER_DEG > b.maxLng || lakeBbox.maxLng + SEGMENT_LAKE_TOUCH_BUFFER_DEG < b.minLng) continue;
      if (!v.direction || v.direction.confidence !== 'sikker' || !v.direction.direction) continue;

      const A = v.coordsRaw[0], Bp = v.coordsRaw[v.coordsRaw.length - 1];
      const aNearLake = waterClass.pointInGeometry(A[0], A[1], lakeGeometry) || isPointNearPolygonEdge(A[0], A[1], lakeGeometry, SEGMENT_LAKE_TOUCH_BUFFER_DEG);
      const bNearLake = waterClass.pointInGeometry(Bp[0], Bp[1], lakeGeometry) || isPointNearPolygonEdge(Bp[0], Bp[1], lakeGeometry, SEGMENT_LAKE_TOUCH_BUFFER_DEG);
      if (!aNearLake && !bNearLake) continue;
      // Hvis begge endepunkter rører søen (fx en kort søtilstødende stump),
      // kan retning ikke bruges til at afgøre ind/ud — spring over frem for at gætte.
      if (aNearLake && bNearLake) continue;

      const nearEnd = aNearLake ? 'A' : 'B';
      const farEnd   = aNearLake ? 'B' : 'A';
      const nearCoord = aNearLake ? A : Bp;
      const isInflow = v.direction.direction === `${farEnd}til${nearEnd}`; // strøm FRA det fjerne endepunkt MOD søen
      if (!isInflow) continue; // enten bekræftet afløb (håndteres nu andetsteds), eller ingen af de to retninger matcher

      for (const pid of v.match.pulsPointIds) {
        const pt = pointsById[pid];
        if (!pt || pt.lat == null || pt.lng == null) continue;
        ids.add(pt.id);
        const distM = haversineM(pt.lat, pt.lng, nearCoord[0], nearCoord[1]);
        const travelTimeDays = (distM / ASSUMED_STREAM_VELOCITY_M_PER_S) / 86400;
        const adjBact  = pt.riskScore  != null ? pt.riskScore  * Math.exp(-travelTimeDays / tau)  : null;
        const adjViral = pt.viralScore != null ? pt.viralScore * Math.exp(-travelTimeDays / tauV) : null;
        if (adjBact  != null && (rBact  === null || adjBact  > rBact))  rBact  = adjBact;
        if (adjViral != null && (rViral === null || adjViral > rViral)) rViral = adjViral;
        // Alge: samme undtagelse som ID15-tieren ovenfor — ingen henfald.
        if (pt.algaeScore != null && (rAlgae === null || pt.algaeScore > rAlgae)) rAlgae = pt.algaeScore;
        // NYT: 24-timers nedbørsprognose — uden afstands-/rejsetids-dæmpning,
        // samme princip som alge og som RBU/navnematch-tiers ovenfor.
        if (pt.foreRisk != null && (rForecast === null || pt.foreRisk > rForecast)) rForecast = pt.foreRisk;
      }
    }
    // RETTET: returnerer nu et objekt selv når der INGEN indløbsdata er,
    // så længe der er fundet mindst ét bekræftet afløb at udelukke — ellers
    // ville outflowIds være tabt for søer der KUN har afløbssegmenter
    // touching (som Farum Sø, hvor Fiskebæk Å er det eneste bekræftede
    // segment nær selve søbredden — indløbene sker via ID15 uden et
    // matchende, søtilstødende vandløbssegment).
    if (rBact === null && rViral === null && rAlgae === null) return null;
    return { risk: rBact, viral: rViral, algae: rAlgae, forecast: rForecast, ids };
  }
  // Genberegner max af et felt (riskScore/viralScore/algaeScore/foreRisk)
  // over et sæt bidragende punkt-ID'er, med mulighed for at udelukke
  // specifikke ID'er — bruges til at fjerne bekræftede afløbsudløb fra
  // RBU/navnematch EFTER de er aggregeret (de gemmer kun selve max-
  // værdien, ikke hvilket punkt der satte den, så en simpel "fjern én
  // værdi"-operation er ikke mulig — hele max genberegnes i stedet fra
  // den bevarede ids-liste).
  function maxExcluding(idsSet, excludeIds, field) {
    if (!idsSet) return null;
    let max = null;
    for (const id of idsSet) {
      if (excludeIds.has(id)) continue;
      const pt = pointsById[id];
      if (!pt) continue;
      const val = pt[field];
      if (val != null && (max === null || val > max)) max = val;
    }
    return max;
  }
  // NYT (bruger-ønske 2026-07-25, kystvand-polygonernes farve): gennemsnit
  // af et felt over et sæt bidragende punkt-ID'er — se kystvande-loopets
  // brug nedenfor for hvorfor bact/viral for HELE kystvand-polygonen nu
  // bruger gennemsnit i stedet for maxExcluding()'s værste-enkeltmåling.
  function avgOf(idsSet, field) {
    if (!idsSet) return null;
    let sum = 0, count = 0;
    for (const id of idsSet) {
      const pt = pointsById[id];
      if (!pt) continue;
      const val = pt[field];
      if (val != null) { sum += val; count++; }
    }
    return count > 0 ? sum / count : null;
  }
  // Hjælper: er punktet inden for buf af polygonens KANT (ikke kun
  // "inde i" den) — waterClass eksporterer ikke dette direkte, så det er
  // en lille, lokal implementering af samme princip som pointNearLine().
  function isPointNearPolygonEdge(lat, lng, geometry, buf) {
    function distToSegment(x1, y1, x2, y2) {
      const dx = x2 - x1, dy = y2 - y1;
      if (dx === 0 && dy === 0) return Math.hypot(lng - x1, lat - y1);
      let t = ((lng - x1) * dx + (lat - y1) * dy) / (dx * dx + dy * dy);
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(lng - (x1 + t * dx), lat - (y1 + t * dy));
    }
    function walkRing(ring) {
      for (let i = 0; i < ring.length - 1; i++) {
        if (distToSegment(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]) < buf) return true;
      }
      return false;
    }
    if (geometry.type === 'Polygon') return geometry.coordinates.some(walkRing);
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(poly => poly.some(walkRing));
    return false;
  }
  // RETTET (rodårsag til Doktorens Bugt/DKBW364-fejlen): WATERBODY_MATCH_
  // BUFFER_DEG blev tidligere KUN brugt til den billige bbox-forkastelse
  // nedenfor — selve afgørelsen brugte stadig waterClass.pointInGeometry()
  // STRENGT, uden nogen tolerance. At øge bufferen hjalp derfor kun
  // badesteder der lå tæt nok på en ANDEN, korrekt polygon — aldrig
  // badesteder der ligger lige UDENFOR kanten af deres egen, korrekte sø
  // (præcis det en forenklet/afskåret bugt-geometri giver). Klienten havde
  // tidligere netop denne tolerance (pointInOrNearGeometry(), fjernet som
  // "død kode" da den lokale fallback blev fjernet) — den er nu portet
  // til serveren i stedet, som den altid burde have været.
  function pointInOrNearGeometry(lat, lng, geometry, buf) {
    if (waterClass.pointInGeometry(lat, lng, geometry)) return true;
    return isPointNearPolygonEdge(lat, lng, geometry, buf);
  }

  // ── Søer: Trin 0/0,5/1/2 kombineret ────────────────────────────────────
  const lakes = {};  // navn -> { bact, viral, geometry, bbox }
  // NYT (bruger-ønske — søer opstrøms andre søer/kystvande, se
  // "Farum Sø opstrøms Furesøen"-samtalen der førte hertil): gemmer hver
  // søs bekræftede AFLØBSsegmenter (allerede beregnet som outflowSegments
  // nedenfor, kun for at udelukke dem fra søens EGEN indløbsberegning) til
  // genbrug EFTER hele søløkken — se opstrøms-propageringen efter
  // kystvandsløkken for hvorfor dette skal vente til begge lister
  // (lakes/kystvande) er færdige.
  const lakeOutflowSegments = new Map(); // navn -> segments[]
  let _lakeIterCount = 0;
  for (const feat of soeerGeojson.features || []) {
    const props = feat.properties || {};
    const navn = props.ov_navn || props.navn || 'Sø';
    const rbuRec  = rbuMatchData.get(normSoeName(navn));
    const nameRec = nameMatchData.get(normSoeName(navn));

    // RETTET: beregnes nu FØRST (var tidligere sidst) — bruges til at
    // filtrere ID15/RBU/navnematch nedenfor, ikke kun til selv at bidrage.
    // Se computeVandlobInflowRec()'s filhoved for den fulde begrundelse
    // (Doktorens Bugt/VD-U57-eftervirkningen).
    const tauLocal = seasonalTau(), tauVLocal = seasonalTauViral();
    const lakeBboxForInflow = waterClass.computeGeometryBbox(feat.geometry);
    const vandlobInflowRec = computeVandlobInflowRec(feat.geometry, lakeBboxForInflow, tauLocal, tauVLocal);
    // RETTET: outflowIds bygges nu via findConfirmedOutflowSegments() +
    // isPointOnAnySegment() — en direkte geometrisk nærhedstest af hvert
    // KANDIDAT-udløbs egne koordinater, IKKE via segmenternes pulsPointIds
    // (som VD-U52/57/53 bekræftet aldrig optræder i, se filhovedets
    // begrundelse). Kandidatlisten er unionen af alle udløb, der overhovedet
    // kunne bidrage til denne sø (RBU + navnematch + ID15) — kun disse
    // testes, for at holde det billigt.
    const outflowSegments = findConfirmedOutflowSegments(feat.geometry, lakeBboxForInflow);
    if (outflowSegments.length > 0) lakeOutflowSegments.set(navn, outflowSegments);
    const outflowIds = new Set();
    if (outflowSegments.length > 0) {
      const candidateIds = new Set([
        ...(rbuRec?.ids ?? []), ...(nameRec?.ids ?? []),
        ...((id15LakeMatches[navn]?.pulsPoints ?? []).map(p => p.id)),
      ]);
      for (const id of candidateIds) {
        const pt = pointsById[id];
        if (pt && pt.lat != null && pt.lng != null && isPointOnAnySegment(pt.lat, pt.lng, outflowSegments)) outflowIds.add(id);
      }
    }

    let id15Rec = null;
    const id15Entry = id15LakeMatches[navn];
    if (id15Entry && id15Entry.pulsPoints && id15Entry.pulsPoints.length > 0) {
      let rBact = null, rViral = null, rAlgae = null, rForecast = null;
      const id15Ids = new Set();
      const tau = seasonalTau(), tauV = seasonalTauViral();
      for (const { id, travelTimeHours } of id15Entry.pulsPoints) {
        // RETTET: springer bekræftede afløbspunkter over her (nu korrekt
        // detekteret via egne koordinater, se ovenfor). Uden dette blev fx
        // VD-U57 (Fiskebæk Å, bekræftet afløb fra Farum Sø mod Furesøen)
        // stadig medregnet ufiltreret via ID15 (rejsetid=0t i selve
        // id15-lake-matches.json), og vandt over den korrekte, filtrerede
        // vandløbsindløbstier, fordi de to kombineres med Math.max.
        if (outflowIds.has(id)) continue;
        const pt = pointsById[id];
        if (!pt) continue;
        id15Ids.add(pt.id);
        const travelTimeDays = (travelTimeHours || 0) / 24;
        const adjBact  = pt.riskScore  != null ? pt.riskScore  * Math.exp(-travelTimeDays / tau)  : null;
        const adjViral = pt.viralScore != null ? pt.viralScore * Math.exp(-travelTimeDays / tauV) : null;
        if (adjBact  != null && (rBact  === null || adjBact  > rBact))  rBact  = adjBact;
        if (adjViral != null && (rViral === null || adjViral > rViral)) rViral = adjViral;
        // Alge har ingen selvstændig patogen-henfaldsmodel (afhænger af
        // næringsstoffer, ikke bakterie/viral inaktivering) — samme
        // undtagelse som klientens colorSoeerByRisk() allerede har.
        if (pt.algaeScore != null && (rAlgae === null || pt.algaeScore > rAlgae)) rAlgae = pt.algaeScore;
        // NYT: 24-timers nedbørsprognose — uden rejsetids-dæmpning, se
        // begrundelse i rbuMatchData ovenfor.
        if (pt.foreRisk != null && (rForecast === null || pt.foreRisk > rForecast)) rForecast = pt.foreRisk;
      }
      if (rBact !== null || rViral !== null || rAlgae !== null) id15Rec = { risk: rBact, viral: rViral, algae: rAlgae, forecast: rForecast, ids: id15Ids };
    }

    // RETTET: rbuRec/nameRec er pre-aggregerede globalt (rbuMatchData/
    // nameMatchData, bygget én gang for hele datasættet, se ovenfor) — de
    // gemmer kun selve max-værdien pr. sønavn, ikke hvilket punkt der satte
    // den, og kan derfor ikke filtreres direkte for DENNE sø's outflowIds.
    // De har dog en `ids`-liste over alle bidragende punkter bevaret —
    // maxExcluding() genberegner max herfra, med outflowIds udelukket.
    // I praksis rammer dette sjældent (rbuRec/nameRec kræver enten en
    // eksplicit myndighedskobling eller at PULS' waterArea-tekst selv
    // nævner "sø" — et bekræftet afløbsudløb som VD-U57 har typisk
    // waterArea sat til selve vandløbet, fx "Fiskebæk Å", og rammer derfor
    // ikke navnematch i forvejen), men koster stort set intet at gøre
    // konsekvent.
    //
    // NYT (Furesøen/UA10-hændelsen — se SOE_NAVNEMATCH_MAX_DIST_M's
    // filhoved): ekskluderer nu OGSÅ ethvert kandidat-udløb, hvis egne
    // koordinater ligger mere end 10 km fra selve søens geometri — et rent
    // navnematch (RBU-forb_id eller waterArea-tekst) er ikke i sig selv
    // bevis for en reel forbindelse, hvis udløbet fysisk ligger et helt
    // andet sted i landet. Samme sikkerhedsnet-princip som kystvandenes
    // KYSTVAND_TEXTMATCH_MAX_DIST_M.
    function farAwayIds(rec) {
      const far = new Set();
      if (!rec) return far;
      for (const id of rec.ids) {
        const pt = pointsById[id];
        if (!pt || pt.lat == null || pt.lng == null || polygonEdgeDistanceM(pt.lat, pt.lng, feat.geometry) > SOE_NAVNEMATCH_MAX_DIST_M) {
          far.add(id);
        }
      }
      return far;
    }
    const rbuExclude  = new Set([...outflowIds, ...farAwayIds(rbuRec)]);
    const nameExclude = new Set([...outflowIds, ...farAwayIds(nameRec)]);
    const rbuRecFiltered = (rbuRec && rbuExclude.size > 0) ? {
      risk: maxExcluding(rbuRec.ids, rbuExclude, 'riskScore'),
      viral: maxExcluding(rbuRec.ids, rbuExclude, 'viralScore'),
      algae: maxExcluding(rbuRec.ids, rbuExclude, 'algaeScore'),
      forecast: maxExcluding(rbuRec.ids, rbuExclude, 'foreRisk'),
      ids: new Set([...rbuRec.ids].filter(id => !rbuExclude.has(id))),
    } : rbuRec;
    const nameRecFiltered = (nameRec && nameExclude.size > 0) ? {
      risk: maxExcluding(nameRec.ids, nameExclude, 'riskScore'),
      viral: maxExcluding(nameRec.ids, nameExclude, 'viralScore'),
      algae: maxExcluding(nameRec.ids, nameExclude, 'algaeScore'),
      forecast: maxExcluding(nameRec.ids, nameExclude, 'foreRisk'),
      ids: new Set([...nameRec.ids].filter(id => !nameExclude.has(id))),
    } : nameRec;

    let bact = null, viral = null, algae = null, forecast = null;
    if (rbuRecFiltered || id15Rec || nameRecFiltered || vandlobInflowRec) {
      bact  = Math.max(rbuRecFiltered?.risk  ?? -Infinity, id15Rec?.risk  ?? -Infinity, nameRecFiltered?.risk  ?? -Infinity, vandlobInflowRec?.risk  ?? -Infinity);
      viral = Math.max(rbuRecFiltered?.viral ?? -Infinity, id15Rec?.viral ?? -Infinity, nameRecFiltered?.viral ?? -Infinity, vandlobInflowRec?.viral ?? -Infinity);
      algae = Math.max(rbuRecFiltered?.algae ?? -Infinity, id15Rec?.algae ?? -Infinity, nameRecFiltered?.algae ?? -Infinity, vandlobInflowRec?.algae ?? -Infinity);
      forecast = Math.max(rbuRecFiltered?.forecast ?? -Infinity, id15Rec?.forecast ?? -Infinity, nameRecFiltered?.forecast ?? -Infinity, vandlobInflowRec?.forecast ?? -Infinity);
      if (bact  === -Infinity) bact  = null;
      if (viral === -Infinity) viral = null;
      if (algae === -Infinity) algae = null;
      if (forecast === -Infinity) forecast = null;
    }
    // NYT (6. runde — "Nors Sø/bekræftet ingen risiko"-kategorien): en sø,
    // hvor ID15's terrænsporede opland (den mest pålidelige kilde, se
    // computeVandlobInflowRec()'s filhoved) EKSPLICIT har fundet NUL
    // PULS-punkter i hele oplandet (pulsPoints: [], IKKE blot fraværende
    // fra filen — se diagnose-id15-daekning.js, som bekræftede at 970 af
    // 973 søer har et eksplicit ja/nej-svar), OG hvor ingen af de øvrige,
    // uafhængige kilder (RBU, navnematch, vandløbsindløb, eller et
    // bekræftet afløbssegment) finder noget som helst — er en ægte,
    // data-funderet bekræftelse af INGEN kendt udledningsforbindelse.
    // Dette er IKKE det samme som "ingen data" (fravær af undersøgelse) —
    // det er en POSITIV bekræftelse (undersøgt og fundet tom), og
    // markeres derfor som en tredje, adskilt kategori, ikke som en
    // manglende score. Bevidst KUN automatisk udledt fra data — ingen
    // manuel liste, efter eksplicit ønske.
    const id15EksplicitTom = !!(id15Entry && Array.isArray(id15Entry.pulsPoints) && id15Entry.pulsPoints.length === 0);
    const trueConfirmedEmpty = id15EksplicitTom && !rbuRec && !nameRec && !vandlobInflowRec && outflowIds.size === 0;

    // NYT: union af bidragende punkt-ID'er på tværs af de kilder, der
    // rent faktisk gav et resultat — sendes nu med til klienten, så
    // "Bekræftet vandområde, men ingen individuelle udløb kunne matches"
    // kun vises når det er sandt, ikke som en fast konsekvens af at bruge
    // server-genvejen (se dansk-overloeb-kort.html's computeBadevandRisk()).
    // RETTET: bruger nu de outflow-filtrerede lister, så et bekræftet
    // afløbsudløb (som VD-U57) ikke længere optræder i badevands-
    // detaljepanelets udløbsliste, selvom det aldrig burde have bidraget.
    // FLYTTET OP (bruger-ønske 2026-07-26): skal bruges af
    // allCandidatesStormwater herunder, FØR "ingen data"-tjekket.
    const outletIds = new Set([...(rbuRecFiltered?.ids ?? []), ...(id15Rec?.ids ?? []), ...(nameRecFiltered?.ids ?? []), ...(vandlobInflowRec?.ids ?? [])]);

    // RETTET (bruger-ønske 2026-07-26 — regnvandsbassin-regressionen):
    // udvider confirmedNoOutlet til OGSÅ at dække søer, hvor der ER
    // matchet mindst ét udløb (RBU/ID15/navnematch/vandløbsindløb), men
    // bact/viral begge blev null, FORDI samtlige matchede udløb er
    // bekræftede rene regnvandsudløb (se risk-model.js's isWastewater) —
    // IKKE fordi data mangler af andre grunde (fx manglende vejrdata for
    // cellen, som ville give samme null-værdier uden at være en positiv
    // "ingen spildevand"-konklusion). Mange registrerede VP3-"søer" er
    // reelt regnvandsbassiner, hvor dette er den NORMALE, forventede
    // tilstand for ALLE nærliggende PULS-punkter — uden denne udvidelse
    // viste ca. halvdelen af alle søer fejlagtigt "ingen data" (blå) efter
    // wastewater-filtreringen blev indført, selvom det reelt er en
    // bekræftet, positiv konklusion (samme som confirmedNoOutlet, blot
    // fundet via en anden rute: udløb fundet, men filtreret, i stedet for
    // slet ikke fundet af ID15's terrænsporing).
    const allCandidatesStormwater = bact === null && viral === null && outletIds.size > 0 &&
      [...outletIds].every(id => pointsById[id]?.isWastewater === false);
    // RETTET (bruger-ønske 2026-07-26 — "Anholt"-fejlen, samme princip for
    // søer): en sø kan også have INGEN kandidat-udløb overhovedet (hverken
    // RBU, ID15, navnematch eller vandløbsindløb) UDEN at ID15 eksplicit
    // har bekræftet et tomt opland (trueConfirmedEmpty kræver netop dette
    // — mange søer har slet intet ID15-svar, hverken ja eller nej, se
    // diagnose-id15-daekning.js). Intet kendt udløb betyder pr. definition
    // heller intet kendt spildevandsudløb, uanset om ID15 udtrykkeligt
    // bekræftede det eller blot ikke havde noget at sige om søen.
    const noCandidatesAtAll = bact === null && viral === null && algae === null && outletIds.size === 0;
    const confirmedNoOutlet = trueConfirmedEmpty || allCandidatesStormwater || noCandidatesAtAll;
    // RETTET (bruger-rapporteret — Ågerup/Vollerup Badebro/Svenstrup
    // Overdrev/Saltbæk Badebro viste "søens opland — bekræftet via
    // terrænsporing (ID15)", selvom alle fire er KYSTvande, ikke søer):
    // 'ingen-bekraeftet' dækker nu tre reelt forskellige bekræftelser (se
    // de tre betingelser ovenfor), men klientens tekst antog ubetinget den
    // FØRSTE, oprindelige (ID15's terrænsporing af EN SØS opland). confirmReason
    // lader klienten vise en tekst, der matcher den FAKTISKE årsag — kun
    // 'id15-empty' er reelt ID15-terrænsporing af et sø-opland.
    const confirmReason = trueConfirmedEmpty ? 'id15-empty'
                        : allCandidatesStormwater ? 'all-stormwater'
                        : noCandidatesAtAll ? 'no-candidates'
                        : null;

    // NYT: Trin 2 (ren rumlig ~5 km-nærhed) er BEVIDST UDELADT her —
    // kræver et rumligt indeks over alle 21.556 punkter, som denne
    // beregning ikke allerede har opbygget. Søer uden RBU/ID15/navnematch/
    // vandløbsindløb vil derfor mangle her og vises som "ingen data" i
    // klienten. RETTET: der findes IKKE længere en klient-side fallback at
    // falde tilbage til (fjernet efter eksplicit ønske — serveren er nu
    // eneste kilde for både badevandspunkter OG sø-/kystvand-polygoner).
    if (bact === null && viral === null && algae === null && !confirmedNoOutlet) continue;

    // NYT: samme prioritetsrækkefølge som klientens tidligere lokale
    // colorSoeerByRisk() brugte til sin "Kilde: ..."-tooltip-linje —
    // bevaret her så tooltip-teksten ikke ændrer betydning efter
    // server-omlægningen. Angiver hvilken kilde der (efter prioritet,
    // ikke nødvendigvis hvilken der satte MAX på hver enkelt værdi) blev
    // brugt for denne sø.
    const kilde = confirmedNoOutlet ? 'bekraeftet-ingen-udloeb'
                : rbuRecFiltered?.risk != null || rbuRecFiltered?.viral != null || rbuRecFiltered?.algae != null ? 'rbu'
                : id15Rec ? 'id15'
                : nameRecFiltered?.risk != null || nameRecFiltered?.viral != null || nameRecFiltered?.algae != null ? 'navn'
                : 'vandlob-indloeb';
    lakes[navn] = { bact, viral, algae, forecast, kilde, confirmedNoOutlet, confirmReason, geometry: feat.geometry, bbox: waterClass.computeGeometryBbox(feat.geometry), outlets: resolveOutlets(outletIds) };

    // NYT: giv kontrollen tilbage til Node periodisk — den nye
    // vandløbsindløbstier tilføjer en ekstra indre løkke over op til
    // ~5.227 vandløbssegmenter PR. sø, potentielt tungere end de
    // oprindelige tre kilder. Samme "ikke valgfrit"-begrundelse som
    // resten af filen (se computeWaterFlagsAsync() i water-classification.js).
    if (++_lakeIterCount % 50 === 0) await new Promise(resolve => setImmediate(resolve));
  }

  // ── Kystvande: waterArea-tekstmatch + ID15 kombineret ───────────────────
  const areaData = new Map();
  for (const pt of points) {
    // RETTET (4. runde — "Åbenrå/Aabenraa"-fejlen): brugte tidligere kun
    // rå toLowerCase().trim() — i modsætning til søernes nameMatchData,
    // som allerede bruger normSoeName() (æ→ae, ø→oe, å→aa). "Åbenrå
    // Fjord" (polygonens navn) og "Aabenraa Fjord" (PULS' stavevariant)
    // er semantisk samme sted, men matchede ALDRIG hinanden — hverken
    // eksakt eller fuzzy — fordi 'å' og 'aa' er bogstaveligt forskellige
    // tegn uden normalisering. Samme normSoeName() som søerne bruges nu
    // her, af samme grund.
    const key = normSoeName(pt.waterArea);
    if (!key) continue;
    let rec = areaData.get(key);
    if (!rec) { rec = { risk: null, viral: null, algae: null, forecast: null, ids: new Set() }; areaData.set(key, rec); }
    rec.ids.add(pt.id);
    if (pt.riskScore  != null && (rec.risk  === null || pt.riskScore  > rec.risk))  rec.risk  = pt.riskScore;
    if (pt.viralScore != null && (rec.viral === null || pt.viralScore > rec.viral)) rec.viral = pt.viralScore;
    if (pt.algaeScore != null && (rec.algae === null || pt.algaeScore > rec.algae)) rec.algae = pt.algaeScore;
    if (pt.foreRisk != null && (rec.forecast === null || pt.foreRisk > rec.forecast)) rec.forecast = pt.foreRisk;
  }
  // RETTET (2. runde — "Skagerrak/Lillebælt/Kattegat mangler nu data"-
  // regressionen): det oprindelige eksakte-match-fix (se ovenfor) løste
  // "Kattegat"-krydsregionsfejlen korrekt, men fjernede VED SAMME LEJLIGHED
  // legitime generisk-til-specifik-relationer — PULS' waterArea bruger
  // ofte et bredt navn ("Kattegat", "Lillebælt"), mens VP3-polygonerne er
  // opdelt i specifikke underområder ("Kattegat, Aalborg Bugt",
  // "Lillebælt, syd"), som ALDRIG kan ramme et rent eksakt match.
  //
  // Fuzzy-matchet er nu TRYGT at genindføre, fordi kaldestedet (se
  // nedenfor) filtrerer resultatet med KYSTVAND_TEXTMATCH_MAX_DIST_M
  // BAGEFTER, uafhængigt af hvordan teksten blev matchet — selv hvis denne
  // funktion vælger en forkert/for bred generisk bucket, vil kun udløb
  // inden for 10 km af DEN KONKRETE polygon overleve videre. Samler nu IDs
  // fra ALLE fuzzy-matchende buckets (ikke kun den første fundet i Map-
  // iterationsrækkefølge, som den oprindelige, fjernede version gjorde) —
  // et specifikt polygonnavn kan relatere til flere generiske PULS-
  // varianter samtidig (fx "Kattegat" OG "Kattegat v/Sælvig").
  // RETTET (3. runde — "DKCOAST217/UAS03R"-fejlen): funktionen returnerede
  // tidligere ØJEBLIKKELIGT ved et eksakt match, uden nogensinde at nå
  // fuzzy-trinnet — selv når et BREDERE, mere inkluderende fuzzy-match
  // fandtes. Hvis et PULS-punkt tilfældigvis er tagget med PRÆCIS samme
  // tekst som polygonens eget navn (fx et enkelt punkt tagget "Lillebælt,
  // Bredningen", mens de fleste andre relevante punkter blot er tagget det
  // bredere "Lillebælt"), vandt den smalle, eksakte bucket — og udelukkede
  // dermed alle de bredere, generiske punkter (som UAS03R), der ellers
  // korrekt ville være fundet via fuzzy. Eksakt og fuzzy FORENES nu altid
  // — trygt, fordi den fysiske 10 km-afstandsgrænse (se kaldestedet)
  // stadig beskytter mod fejlkoblinger uanset hvor bredt nettet kastes her.
  function lookupAreaRecord(candidates) {
    const mergedIds = new Set();
    for (const c of candidates) {
      for (const [key, rec] of areaData) {
        if (key.includes(c) || c.includes(key)) { for (const id of rec.ids) mergedIds.add(id); }
      }
    }
    return mergedIds.size > 0 ? { ids: mergedIds } : null;
  }

  // NYT (5. runde — "Grenå Strand/Djursland Øst"-fejlen): "Kattegat" og
  // "Djursland Øst" er IKKE to forskellige vandområder, der tilfældigvis
  // deler tekst — det ER samme hav, bare den officielle, navngivne
  // kyststrækning ud for Djursland. Fuzzy-matchet ovenfor kan strukturelt
  // ALDRIG forbinde dem, fordi hverken navn indeholder det andet som
  // tekststreng (i modsætning til fx "Isefjord"/"Isefjord, indre", som
  // allerede virker).
  //
  // Danmark har kun et lille, fast antal officielle, overordnede
  // havområdenavne. Disse fungerer nu som en SIDSTE UDVEJ — kun forsøgt
  // når INTET andet tekstmatch (eksakt eller fuzzy) findes for en given
  // polygon — stadig beskyttet af samme fysiske KYSTVAND_TEXTMATCH_MAX_DIST_M
  // (10 km) som al anden tekstmatch her. Bevidst KUN for kystvande, ikke
  // søer: en åben kyststrækning uden omsluttende fjordgrænser har ikke
  // den samme modstridende-intern-retning-risiko, som gjorde en
  // tilsvarende generisk fallback farlig for søer (se Farum Sø/VD-U57).
  const DANISH_SEA_NAMES = [normSoeName('Kattegat'), normSoeName('Skagerrak'), normSoeName('Østersøen'), normSoeName('Bælthavet'), normSoeName('Nordsøen'), normSoeName('Vesterhavet')];
  function lookupSeaFallback() {
    const mergedIds = new Set();
    for (const seaName of DANISH_SEA_NAMES) {
      const rec = areaData.get(seaName);
      if (rec) { for (const id of rec.ids) mergedIds.add(id); }
    }
    return mergedIds.size > 0 ? { ids: mergedIds } : null;
  }

  const kystvande = {};  // ov_id -> { bact, viral, algae, forecast, geometry, bbox, outlets }
  for (const feat of kystvandGeojson.features || []) {
    const props = feat.properties || {};
    // RETTET: normSoeName() i stedet for rå toLowerCase().trim() — se
    // begrundelse ved areaData-opbygningen ovenfor. Begge sider af matchet
    // skal normaliseres ens, ellers virker det stadig ikke.
    const candidates = [props.ov_navn, props.ov_id, props.ho_na].filter(Boolean).map(s => normSoeName(s));
    let rawRec = lookupAreaRecord(candidates);
    // NYT: sidste udvej — se lookupSeaFallback()'s filhoved. Forsøges KUN
    // hvis intet normalt tekstmatch (eksakt eller fuzzy) fandtes overhovedet.
    let usedSeaFallback = false;
    if (!rawRec) { rawRec = lookupSeaFallback(); usedSeaFallback = !!rawRec; }
    // NYT: filtrerer den fundne tekstmatch-record til KUN de udløb, hvis
    // egne koordinater ligger inden for KYSTVAND_TEXTMATCH_MAX_DIST_M af
    // NETOP denne polygon — se filhovedets "Stavns Fjord"-begrundelse.
    // Genberegner max fra bunden (samme mønster som maxExcluding() for
    // søernes afløbsudelukkelse), da den globale areaData-record ikke ved
    // hvilken specifik polygon den bliver anvendt på.
    let rec = {};
    if (rawRec) {
      const nearIds = new Set();
      for (const id of rawRec.ids) {
        const pt = pointsById[id];
        if (pt && pt.lat != null && pt.lng != null && polygonEdgeDistanceM(pt.lat, pt.lng, feat.geometry) <= KYSTVAND_TEXTMATCH_MAX_DIST_M) nearIds.add(id);
      }
      rec = { ids: nearIds };
    }
    const outletIds = new Set(rec.ids ?? []);

    const kystvandEntry = id15KystvandMatches[props.ov_id];
    if (kystvandEntry && kystvandEntry.pulsPointIds && kystvandEntry.pulsPointIds.length > 0) {
      for (const id of kystvandEntry.pulsPointIds) {
        const pt = pointsById[id];
        if (!pt) continue;
        // NYT: samme fysiske 10 km-grænse som tekstmatch-tieren ovenfor —
        // ID15-kystvand-koblingen har ALDRIG haft nogen afstands- eller
        // rejsetidsbegrænsning (se tidligere kommentar i koden), samme
        // arkitektoniske risiko som "Stavns Fjord"-fejlen, selvom den ikke
        // var årsagen til DE KONKRET fundne 12 tilfælde.
        if (pt.lat == null || pt.lng == null || polygonEdgeDistanceM(pt.lat, pt.lng, feat.geometry) > KYSTVAND_TEXTMATCH_MAX_DIST_M) continue;
        outletIds.add(pt.id);
      }
    }
    // RETTET (bruger-ønske 2026-07-25): bact/viral for HELE kystvand-
    // polygonen brugte tidligere Math.max over samtlige matchede udløb (op
    // til 10 km fra polygonens rand, se KYSTVAND_TEXTMATCH_MAX_DIST_M) — ét
    // enkelt, kraftigt forurenet udløb kunne dermed farve en flere-titals-
    // km lang kystlinje rødt, selvom resten af området reelt er upåvirket.
    // Gennemsnit (avgOf()) er en mere retvisende repræsentation af HELE
    // polygonens tilstand end værste enkeltmåling. Individuelle badesteders
    // EGEN markørfarve er IKKE ramt af denne ændring — se
    // computeIsotropicKystvandResult() ovenfor, som allerede beregner sin
    // egen, afstands-/strømafhængige score pr. badested ud fra kystvandets
    // outlets-liste; den bruger kun kyst.bact/viral direkte som fallback,
    // når et badested selv har NUL matchede udløb (sjældent, se dens
    // filhoved). algae/forecast beholder bevidst max (maxExcluding) — ingen
    // etableret afstandsmodel for de to felter, samme begrundelse som
    // søerne (se computeIsotropicLakeResult()).
    //
    // RETTET (bruger-ønske 2026-07-25 — "Læsø"-fejlen): bact/viral herunder
    // er STADIG et rå, ikke-afstandsdæmpet gennemsnit af udløb op til 10 km
    // fra polygonens rand — det kan afvige stærkt fra det, faktiske
    // badesteder i området oplever, hvis nogen af de bidragende udløb er
    // langt væk eller strømbekræftet nedstrøms (se Læsø: to bekræftede
    // spildevandsudløb gav en rød polygon, mens ALLE badesteder i samme
    // kystvand var grønne — enten fordi de var >13 km væk med kraftigt
    // afstandshenfald, eller strømbekræftet nedstrøms). Denne rå værdi
    // ERSTATTES derfor længere nede (se "kystvandBadevandContrib" efter
    // badevands-løkken) med et gennemsnit af de FAKTISKE badesteders egne,
    // allerede afstands-/strømkorrigerede resultater — men KUN for
    // kystvand, der reelt har mindst ét matchet badested. Uden noget
    // matchet badested (fx rent åbent hav uden registrerede strande)
    // forbliver denne rå værdi den eneste tilgængelige, og bruges som den
    // er nu.
    const bact     = avgOf(outletIds, 'riskScore');
    const viral    = avgOf(outletIds, 'viralScore');
    const algae    = maxExcluding(outletIds, new Set(), 'algaeScore');
    const forecast = maxExcluding(outletIds, new Set(), 'foreRisk');
    // RETTET (bruger-ønske 2026-07-26 — samme regnvandsbassin-regression
    // som lakes[navn] ovenfor, blot for kystvand): et kystvand kan have
    // matchede udløb (outletIds.size > 0), men bact/viral begge null, FORDI
    // samtlige er bekræftede rene regnvandsudløb (se isWastewater) — en
    // positiv "ingen kendt spildevandskilde"-konklusion, ikke fravær af
    // data. Uden dette ville sådanne kystvand fejlagtigt vise "ingen data"
    // (blå) i stedet for den samme grønne, bekræftede tilstand som søernes
    // confirmedNoOutlet (se computeIsotropicLakeResult()/-KystvandResult()
    // og lakes[navn] ovenfor for den fulde begrundelse).
    // RETTET (bruger-ønske 2026-07-26 — "Anholt"-fejlen): udvidet til OGSÅ
    // at dække outletIds.size === 0 (INGEN kandidat-udløb overhovedet
    // fundet, hverken via tekstmatch eller ID15 — fx et lille, afsides
    // kystvand uden registrerede PULS-udløb i nærheden). Samme princip som
    // brugerens eget om badevands-punkter uden noget geometri-match: intet
    // kendt udløb betyder pr. definition heller intet kendt spildevands-
    // udløb. Adskilt fra "udløb fundet, men alle regnvand" (kun mulig når
    // outletIds.size > 0) — begge ender i samme positive konklusion.
    const kystNoCandidates     = bact === null && viral === null && outletIds.size === 0;
    const kystAllStormwater    = bact === null && viral === null && outletIds.size > 0 &&
      [...outletIds].every(id => pointsById[id]?.isWastewater === false);
    const confirmedNoOutlet = kystNoCandidates || kystAllStormwater;
    // RETTET (bruger-rapporteret — se lakes[navn]'s confirmReason ovenfor
    // for fuld begrundelse): kystvande har ALDRIG en 'id15-empty'-variant
    // (kun søer har den ægte ID15-terrænsporing af et helt opland) — kun
    // de to andre, generiske årsager er mulige her.
    const confirmReason = kystAllStormwater ? 'all-stormwater' : kystNoCandidates ? 'no-candidates' : null;
    if (bact === null && viral === null && algae === null && !confirmedNoOutlet) continue;
    // NYT: samme kilde-tag-princip som lakes[navn] ovenfor.
    const kilde = confirmedNoOutlet ? 'bekraeftet-ingen-udloeb'
                : usedSeaFallback ? 'havnavn-fallback' : (rec.ids && rec.ids.size > 0) ? 'tekstmatch' : 'id15';
    kystvande[props.ov_id] = { ov_id: props.ov_id, bact, viral, algae, forecast, kilde, confirmedNoOutlet, confirmReason, navn: props.ov_navn || props.ov_id, geometry: feat.geometry, bbox: waterClass.computeGeometryBbox(feat.geometry), outlets: resolveOutlets(outletIds) };
  }

  // ── NYT (bruger-ønske — generel opstrøms sø/kystvand-propagering) ──────────
  // En sø, der er BEKRÆFTET (samme vandlob-directions.json-baserede
  // retningslogik som findConfirmedOutflowSegments()/computeVandlobInflowRec()
  // ovenfor) at løbe ud i en ANDEN sø eller et kystvand, bidrog hidtil intet
  // til den modtagende sø/det modtagende kystvand — hver sø/hvert kystvand
  // fik UDELUKKENDE point-kilder (RBU/ID15/navnematch/vandløbsindløb) fra
  // sit EGET, direkte matchede udløbssæt.
  //
  // Konkret eksempel der førte hertil (bruger-rapporteret): Farum Sø (33
  // direkte matchede udløb, bl.a. F-U7 — 100.000 m³/år over 27 hændelser,
  // ~450 m fra søens bred) løber via Fiskebæk Å (bekræftet afløb, se
  // findConfirmedOutflowSegments()'s filhoved) ud i Furesøen — men
  // Furesøens EGEN udløbsliste (114 direkte matchede udløb, INGEN overlap
  // med Farum Søs 33) havde ingen mekanisme til at "arve" Farum Søs
  // allerede forhøjede risiko, selvom badestedet Fiskebæk Friluftsbad kun
  // ligger ~1,25 km fra F-U7 og vandet fysisk løber derhen.
  //
  // Implementeret som en GENEREL, retningsbevidst graf (ikke hardkodet til
  // dette ene sø-par): for hvert bekræftet afløbssegment (gemt i
  // lakeOutflowSegments under søløkken ovenfor, kun for at udelukke dem fra
  // søens EGEN indløbsberegning) testes om segmentets FJERNE endepunkt
  // (væk fra kildesøen) rører en ANDEN sø eller et kystvand — hvis ja,
  // registreres en rettet kant, med rejsetids-henfald langs selve
  // forbindelsens fulde stiforløb (ikke luftlinje mellem søerne), samme
  // hastighedskonstant som et enkelt udløbs bidrag til en sø
  // (ASSUMED_STREAM_VELOCITY_M_PER_S).
  //
  // Selve fremskrivningen (kæder A → B → C, topologisk rækkefølge, hvert
  // enkelt udløb navngivet og sporbart — ikke kun søens samlede tal) sker i
  // "Opstrøms-fremskrivning, del 2", lige før badevands-løkken — se dens
  // filhoved for hvorfor den del ikke kan stå her (kræver
  // buildRelevantOutlets()/ASSUMED_LAKE_MIXING_VELOCITY_M_PER_S, begge
  // defineret efter dette punkt i filen). Selve kant-opbygningen
  // (lakeEdges) sker her, fordi den naturligt hører sammen med
  // søløkken/lakeOutflowSegments ovenfor.
  const lakeEdges = []; // { fromNavn, toType: 'lake'|'kystvand', toKey, distM, nearCoord, farCoord }
  for (const [fromNavn, segments] of lakeOutflowSegments) {
    const fromLake = lakes[fromNavn];
    if (!fromLake) continue; // søen selv havde intet resultat (se "continue" i søløkken ovenfor) — intet at propagere
    for (const seg of segments) {
      const A = seg.coordsRaw[0], Bp = seg.coordsRaw[seg.coordsRaw.length - 1];
      const aNearFrom = waterClass.pointInGeometry(A[0], A[1], fromLake.geometry) || isPointNearPolygonEdge(A[0], A[1], fromLake.geometry, SEGMENT_LAKE_TOUCH_BUFFER_DEG);
      const nearCoord = aNearFrom ? A : Bp; // rører kildesøen — udgangspunkt for leg 1 (intern spredning, se propagateEdge())
      const farCoord = aNearFrom ? Bp : A;
      // Faktisk stilængde (summeret over alle segmentets vertices) —
      // mere præcist end luftlinje mellem de to søer for et snoet vandløb.
      let pathM = 0;
      for (let i = 1; i < seg.coordsRaw.length; i++) {
        pathM += haversineM(seg.coordsRaw[i - 1][0], seg.coordsRaw[i - 1][1], seg.coordsRaw[i][0], seg.coordsRaw[i][1]);
      }
      for (const toNavn of Object.keys(lakes)) {
        if (toNavn === fromNavn) continue;
        const toLake = lakes[toNavn];
        const b = toLake.bbox;
        if (farCoord[0] < b.minLat - SEGMENT_LAKE_TOUCH_BUFFER_DEG || farCoord[0] > b.maxLat + SEGMENT_LAKE_TOUCH_BUFFER_DEG ||
            farCoord[1] < b.minLng - SEGMENT_LAKE_TOUCH_BUFFER_DEG || farCoord[1] > b.maxLng + SEGMENT_LAKE_TOUCH_BUFFER_DEG) continue;
        if (waterClass.pointInGeometry(farCoord[0], farCoord[1], toLake.geometry) || isPointNearPolygonEdge(farCoord[0], farCoord[1], toLake.geometry, SEGMENT_LAKE_TOUCH_BUFFER_DEG)) {
          lakeEdges.push({ fromNavn, toType: 'lake', toKey: toNavn, distM: pathM, nearCoord, farCoord });
        }
      }
      for (const ovId of Object.keys(kystvande)) {
        const toKyst = kystvande[ovId];
        const b = toKyst.bbox;
        if (farCoord[0] < b.minLat - SEGMENT_LAKE_TOUCH_BUFFER_DEG || farCoord[0] > b.maxLat + SEGMENT_LAKE_TOUCH_BUFFER_DEG ||
            farCoord[1] < b.minLng - SEGMENT_LAKE_TOUCH_BUFFER_DEG || farCoord[1] > b.maxLng + SEGMENT_LAKE_TOUCH_BUFFER_DEG) continue;
        if (waterClass.pointInGeometry(farCoord[0], farCoord[1], toKyst.geometry) || isPointNearPolygonEdge(farCoord[0], farCoord[1], toKyst.geometry, SEGMENT_LAKE_TOUCH_BUFFER_DEG)) {
          lakeEdges.push({ fromNavn, toType: 'kystvand', toKey: ovId, distM: pathM, nearCoord, farCoord });
        }
      }
    }
  }

  // NYT: selve fremskrivningen (brug af lakeEdges) sker LÆNGERE NEDE, som
  // sidste trin før badevands-løkken — se "Opstrøms-fremskrivning, del 2"
  // dér for hvorfor (kræver buildRelevantOutlets()/ASSUMED_LAKE_MIXING_
  // VELOCITY_M_PER_S, begge defineret efter dette punkt i filen).

  const lakeList = Object.values(lakes);
  const kystvandList = Object.values(kystvande);

  // NYT: understøtter den samme skelnen klientens FJERNEDE lokale fallback
  // tidligere lavede ("Lokationen ligger inden for X, men har ikke selv
  // nogen beregnet risikodata" vs. "Ingen bekræftet hydrologisk forbindelse
  // fundet") — nu at klienten ikke længere har egen geometri at falde
  // tilbage på, SKAL denne skelnen komme fra serveren, ellers mister
  // brugerne en reelt nyttig besked. `lakeList`/`kystvandList` ovenfor
  // indeholder kun vandområder MED data (bevidst, af `continue` i deres
  // respektive løkker) — disse to lister er ALLE geometrier, uanset data,
  // brugt UDELUKKENDE til denne sekundære "matchede geometrien, men har
  // ingen data"-besked når det primære match fejler.
  const allLakeGeoms = (soeerGeojson.features || []).map(f => ({
    navn: f.properties?.ov_navn || f.properties?.navn || 'Sø',
    geometry: f.geometry, bbox: waterClass.computeGeometryBbox(f.geometry),
  }));
  const allKystvandGeoms = (kystvandGeojson.features || []).map(f => ({
    navn: f.properties?.ov_navn || f.properties?.ov_id || 'Kystvand',
    geometry: f.geometry, bbox: waterClass.computeGeometryBbox(f.geometry),
  }));

  // NYT (intern sø-cirkulation — Doktorens Bugt/VD-U52/53-eftervirkningen):
  // lakes[navn] har hidtil givet ÉN fælles maks-score til HELE søens
  // polygon, uanset hvor i søen et badested ligger. Det er strukturelt
  // forkert for store søer med flere bugte (som Farum Sø) — et udløb i den
  // modsatte ende af søen fik samme vægt som ét lige ved badestedet. Der
  // findes IKKE nogen kendt kilde til intern strømretning i danske søer
  // (bekræftet ved websøgning — hverken EU's badevandsdirektiv eller danske
  // bekendtgørelser angiver en påvirkningsradius, og en decideret
  // hydrodynamisk model, parallel til DHI, er ikke tilgængelig her).
  //
  // Dette er derfor en ISOTROPISK tilnærmelse: hvert bidragende udløbs EGEN,
  // u-henfaldne score (allerede tilgængelig i lake.outlets, se toOutlet())
  // henfaldes med luftlinje-AFSTAND fra udløbet til DETTE SPECIFIKKE
  // badested (ikke til søens polygon generelt), omregnet til en antaget
  // rejsetid — samme formel som vandløbsindløbstieren, men UDEN
  // retningsantagelse (spreder sig lige meget i alle retninger, som ringe i
  // vandet). Det er en reel forbedring af "hele søen får max"-fejlen, men
  // IKKE det samme som en ægte strømningsberegning: hvis den faktiske strøm
  // i søen går væk fra badestedet, vil denne model stadig overvurdere
  // risikoen der — bare mindre end i dag.
  //
  // [ANTAGELSE, IKKE MÅLT]: bruger sin EGEN hastighedskonstant, adskilt fra
  // ASSUMED_STREAM_VELOCITY_M_PER_S — åbent, vindpåvirket sø-vand blander sig
  // fysisk anderledes end kanaliseret vandløbsstrøm, og der er ingen
  // begrundelse for at antage samme tal gælder for begge. Sat til samme
  // værdi udelukkende af mangel på bedre grundlag — juster frit.
  const ASSUMED_LAKE_MIXING_VELOCITY_M_PER_S = 0.3;


  // NYT (8. runde — "Hellerup Strand viser Helsingør-udløb"-fejlen): selve
  // bact/viral-tallet blev korrekt afstandshenfaldet af den isotropiske
  // model (se ovenfor), men den RETURNEREDE outlets-liste var stadig hele
  // søens/kystvandets UDIFFERENTIEREDE pulje — for Øresund (DKCOAST6) hele
  // 186 udløb spredt fra Helsingør til Dragør, uanset badestedets egen
  // position. Klienten sorterer denne liste efter RÅ riskScore (ikke
  // afstand) og viser top 15 — et Helsingør-udløb 40+ km fra Hellerup
  // Strand med moderat RÅ score kunne derfor fejlagtigt fremstå som en
  // hovedkilde, selvom det reelt intet bidrager efter afstandshenfald.
  //
  // Bygger nu i stedet en liste sorteret efter hvert udløbs EGEN,
  // afstandshenfaldede bidrag TIL NETOP DETTE BADESTED — samme princip som
  // selve maks-beregningen, nu også anvendt på selve listen. riskScore/
  // viralScore i den returnerede liste er DERFOR de henfaldede værdier,
  // ikke de rå — mere retvisende for brugeren ("dette udløbs faktiske
  // bidrag her", ikke "dette udløbs egen, uafhængige måling"). algaeScore
  // forbliver rå (intet etableret henfald for alge, se ovenfor).
  function buildRelevantOutlets(lat, lng, outlets, velocity, tau, tauV, maxCount = 20) {
    const withDecay = [];
    for (const o of outlets) {
      if (o.lat == null || o.lng == null) continue;
      const distM = haversineM(lat, lng, o.lat, o.lng);
      const travelTimeDays = (distM / velocity) / 86400;
      const adjBact  = o.riskScore  != null ? o.riskScore  * Math.exp(-travelTimeDays / tau)  : null;
      const adjViral = o.viralScore != null ? o.viralScore * Math.exp(-travelTimeDays / tauV) : null;
      withDecay.push({ ...o, riskScore: adjBact, viralScore: adjViral, dist: distM / 1000 });
    }
    withDecay.sort((a, b) => (b.riskScore ?? -1) - (a.riskScore ?? -1));
    return withDecay.slice(0, maxCount);
  }

  function computeIsotropicLakeResult(lat, lng, lake, tau, tauV) {
    // NYT: bekræftet ingen udledningsforbindelse (se lakes[navn]s
    // confirmedNoOutlet-felt og filhovedets begrundelse) — en tredje,
    // adskilt kategori, hverken en reel målt score ('soe') eller en
    // ubekræftet mangel ('ingen'). bact/viral/algae forbliver bevidst
    // null — der er intet at beregne en risiko UD FRA, ikke fordi vi
    // mangler data, men fordi ID15's terrænsporing POSITIVT har bekræftet
    // at der ikke findes noget at måle.
    if (lake.confirmedNoOutlet) {
      return { bact: null, viral: null, algae: null, forecast: null, source: 'ingen-bekraeftet', confirmReason: lake.confirmReason, outlets: [] };
    }
    if (!lake.outlets || lake.outlets.length === 0) {
      // Fallback: ingen udløbsdetaljer at regne isotropisk på (bør ikke ske
      // i praksis, da outlets altid følger med når bact/viral er sat — men
      // undgår at miste data i et uventet edge-case).
      return { bact: lake.bact, viral: lake.viral, algae: lake.algae, forecast: lake.forecast, source: 'soe', outlets: lake.outlets };
    }
    let bact = null, viral = null;
    let sawContributingOutlet = false;
    for (const o of lake.outlets) {
      if (o.lat == null || o.lng == null) continue;
      const distM = haversineM(lat, lng, o.lat, o.lng);
      // RETTET (bruger-ønske 2026-07-26 — samme "Amager Strandpark/Øresund"-
      // fejl som kystvande, se computeOutletDirectionalContribution()):
      // SOE_NAVNEMATCH_MAX_DIST_M begrænsede tidligere kun optagelse i
      // SØENS samlede udløbspulje (målt til søens geometri), ikke til det
      // specifikke badested — en stor sø kunne derfor stadig vise et udløb
      // langt fra det pågældende badested. Samme 10 km-grænse, nu håndhævet
      // pr. badested. [ANTAGELSE, IKKE MÅLT] — se den fulde begrundelse ved
      // computeOutletDirectionalContribution().
      if (distM > SOE_NAVNEMATCH_MAX_DIST_M) continue;
      const travelTimeDays = (distM / ASSUMED_LAKE_MIXING_VELOCITY_M_PER_S) / 86400;
      const adjBact  = o.riskScore  != null ? o.riskScore  * Math.exp(-travelTimeDays / tau)  : null;
      const adjViral = o.viralScore != null ? o.viralScore * Math.exp(-travelTimeDays / tauV) : null;
      if (adjBact  != null && (bact  === null || adjBact  > bact))  bact  = adjBact;
      if (adjViral != null && (viral === null || adjViral > viral)) viral = adjViral;
      if (o.isWastewater !== false) sawContributingOutlet = true; // se nedenfor
    }
    // RETTET (bruger-ønske 2026-07-26 — "Vesterlyng/Havnsø"-fejlen): denne
    // søs KYSTVAND-/sø-brede confirmedNoOutlet (ovenfor) dækker kun HELE
    // vandområdets samlede udløbsliste — men for et SPECIFIKT badested kan
    // bact/viral OGSÅ blive null, hvis samtlige af DENNE lokations egne,
    // relevante udløb (efter afstandsberegningen ovenfor) tilfældigvis alle
    // er bekræftede regnvandsudløb, selvom søen SOM HELHED også har andre,
    // spildevands-klassificerede udløb et andet sted. Uden dette tjek endte
    // sådan et badested med source:'soe', bact/viral=null, algae=ikke-null
    // — klienten viste det derfor fejlagtigt som blå "ingen data", fordi
    // den tidlige "sp.algae != null"-gren i computeBadevandRisk() greb ind,
    // før det nogensinde nåede at overveje 'ingen-bekraeftet'. Kun sat, hvis
    // vi rent faktisk SÅ mindst ét bekræftet spildevandsudløb blandt de
    // relevante — er alle udløb regnvand, er det en positiv konklusion.
    if (bact === null && viral === null && lake.outlets.length > 0 && !sawContributingOutlet) {
      return { bact: null, viral: null, algae: null, forecast: null, source: 'ingen-bekraeftet', confirmReason: 'all-stormwater', outlets: [] };
    }
    // Alge/prognose beholder søens fælles værdi — ingen af de to har nogen
    // etableret afstands-/henfaldsmodel andetsteds i denne fil (alge afhænger
    // af næringsstoffer/temperatur, ikke punktkilde-spredning; prognose er
    // vejrbaseret, ikke udledningsbaseret).
    const relevantOutlets = buildRelevantOutlets(lat, lng, lake.outlets, ASSUMED_LAKE_MIXING_VELOCITY_M_PER_S, tau, tauV);
    return { bact, viral, algae: lake.algae, forecast: lake.forecast, source: 'soe', outlets: relevantOutlets };
  }

  // NYT (7. runde — "hele Øresundskysten blodrød"-fejlen): kystvande havde
  // NØJAGTIG samme arkitektoniske hul, som søerne havde før den isotropiske
  // model — ÉN fælles maks-score for hele polygonen, uafhængigt af hvor på
  // en potentielt meget lang kyststrækning (Øresund: Helsingør til Dragør,
  // 186 udløb i én polygon) badestedet ligger. Bekræftet med konkrete data:
  // 56 badesteder delte PRÆCIS samme bact-værdi på tværs af hele kysten.
  // Samme isotropiske tilnærmelse som søerne, egen hastighedskonstant —
  // åbent, tidevands-/strømpåvirket kystvand spredes fysisk anderledes end
  // en afgrænset sø, og der er ingen begrundelse for at antage samme tal.
  // [ANTAGELSE, IKKE MÅLT] — samme forbehold som søernes konstant.
  const ASSUMED_KYSTVAND_MIXING_VELOCITY_M_PER_S = 0.3;

  // NYT (9. runde — retningsbevidst kystvands-model): erstatter den rene
  // isotropiske tilnærmelse for kystvande med en retningsbevidst version,
  // når strømdata (getCurrentAt) er tilgængelig. For hvert udløb: beregn
  // skalarproduktet mellem CMEMS-strømvektoren VED UDLØBET og retningen
  // fra udløb MOD badestedet — positivt produkt betyder strømmen (helt
  // eller delvist) bevæger sig MOD badestedet, dvs. udløbet er bekræftet
  // OPSTRØMS. Negativt/nul produkt betyder nedstrøms eller tværgående —
  // udelukkes HELT, samme princip som Fiskebæk Å/VD-U57 for søer.
  //
  // For bekræftet opstrøms udløb bruges MÅLT strømhastighed (c.speed) i
  // henfaldsberegningen i stedet for den tidligere gættede konstant — en
  // reel forbedring, ikke kun en tilnærmelse, hvor data findes.
  //
  // RETTET/BEVIDST VALG: hvis der IKKE findes strømdata for netop dette
  // udløbs gittercelle (getCurrentAt returnerer null — sker fx ved en
  // fejlet/forældet CMEMS-hentning, som vi har set konkrete eksempler på
  // i denne samtales server-logs), udelukkes udløbet IKKE — det falder i
  // stedet tilbage til den hidtidige retningsblinde isotropiske model for
  // netop DET udløb. At udelukke stille ved manglende strømdata ville
  // være endnu en variant af de tavse fejltilstande, resten af denne
  // samtale har fjernet.
  // NYT (10. runde — "Nyby Havn/FUD5"-fejlen): retningsudelukkelse er
  // fysisk meningsløs ved meget kort afstand — CMEMS' gitteropløsning er
  // ~10 km, så et udløb få meter/hundrede meter fra badestedet får reelt
  // SAMME strømcelle som badestedet selv. "Opstrøms" vs. "nedstrøms" er
  // ikke en meningsfuld skelnen på den skala, og et skalarprodukt tæt på
  // nul kan tippe til den forkerte side af ren måleunøjagtighed — præcis
  // den svaghed, der allerede var dokumenteret som en kendt risiko i Om
  // Risiko-siden. Udløb inden for denne grænse medregnes derfor ALTID
  // (isotropisk, som før den retningsbevidste model), uanset strømretning.
  const DIRECTIONAL_EXCLUSION_MIN_DIST_M = 500;

  function computeOutletDirectionalContribution(lat, lng, o, tau, tauV) {
    const distM = haversineM(lat, lng, o.lat, o.lng);
    // RETTET (bruger-ønske 2026-07-26 — "Amager Strandpark/Øresund"-fejlen):
    // KYSTVAND_TEXTMATCH_MAX_DIST_M begrænsede tidligere kun om et udløb
    // overhovedet blev optaget i EN GIVEN POLYGONS samlede udløbspulje —
    // målt til polygonens KANT, ikke til det specifikke badested. For en
    // stor polygon (fx "Øresund", Helsingør til Dragør, ~186 udløb i én
    // polygon) kunne et udløb ligge <10 km fra kanten et sted, men 40+ km
    // fra et badested et andet sted i samme polygon — bekræftet konkret:
    // "Amager Strandpark, Lagunen" viste udløb fra Helsingør, 43 km væk,
    // som "opstrøms", mens flere reelle spildevandsudløb blot 1,5-2 km væk
    // blev udelukket som "nedstrøms" i samme øjebliksmåling.
    //
    // [ANTAGELSE, IKKE MÅLT — samme forbehold som ASSUMED_KYSTVAND_
    // MIXING_VELOCITY_M_PER_S ovenfor]: der findes ingen valideret
    // faglitteratur for PRÆCIS hvilken afstand et øjebliksbillede af
    // strømretning holder op med at være meningsfuldt for flerdages-
    // transport (efterspurgt og undersøgt eksplicit, se samtalen — Kattegat/
    // Øresund domineres af vind-/densitetsdrevet residualstrøm, som kan
    // vende over dage, hvilket kvalitativt understøtter EN grænse, men
    // ikke en specifik værdi). Genbruger derfor samme 10 km-grænse som
    // KYSTVAND_TEXTMATCH_MAX_DIST_M, nu håndhævet PR. BADESTED (ikke kun
    // pr. polygon), for konsistens frem for at indføre endnu en separat,
    // lige så uvaliderede konstant.
    if (distM > KYSTVAND_TEXTMATCH_MAX_DIST_M) return null;
    let velocity = ASSUMED_KYSTVAND_MIXING_VELOCITY_M_PER_S;
    let upstream = null; // null = ukendt (ingen strømdata, ELLER for tæt på til at retning giver mening)
    if (getCurrentAtCached && distM > DIRECTIONAL_EXCLUSION_MIN_DIST_M) {
      const current = getCurrentAtCached(o.lat, o.lng);
      if (current && current.uo != null && current.vo != null) {
        // Øst-/nord-komponenter fra udløb mod badested, samme konvention
        // som uo=øst-hastighed, vo=nord-hastighed. cos(lat) kompenserer
        // groft for at længdegrader indsnævres mod polerne — tilstrækkelig
        // præcision over de korte afstande (typisk <50 km), dette bruges til.
        const dEast  = (lng - o.lng) * Math.cos(o.lat * Math.PI / 180);
        const dNorth = (lat - o.lat);
        const dot = current.uo * dEast + current.vo * dNorth;
        upstream = dot > 0;
        if (!upstream) return null; // bekræftet nedstrøms/tværgående — udelukkes
        if (current.speed != null && current.speed > 0) velocity = current.speed;
      }
    }
    const travelTimeDays = (distM / velocity) / 86400;
    const adjBact  = o.riskScore  != null ? o.riskScore  * Math.exp(-travelTimeDays / tau)  : null;
    const adjViral = o.viralScore != null ? o.viralScore * Math.exp(-travelTimeDays / tauV) : null;
    return { adjBact, adjViral, distKm: distM / 1000, upstream, velocity };
  }

  function computeIsotropicKystvandResult(lat, lng, kyst, tau, tauV) {
    // NYT (bruger-ønske 2026-07-26): se kystvande[props.ov_id]'s
    // confirmedNoOutlet-felt — samme princip som computeIsotropicLakeResult()
    // nedenfor. Tjekkes FØR outlets-længden, da et regnvandsbassin-lignende
    // kystvand godt kan have en ikke-tom outlets-liste (de bekræftede
    // regnvandsudløb er stadig med i listen, blot med riskScore/viralScore
    // sat til null af wastewater-filteret) — uden dette tjek ville
    // funktionen falde igennem til den almindelige afstands-/strøm-loop
    // nedenfor og returnere source:'kystvand' med bact/viral=null, i stedet
    // for den korrekte, positive 'ingen-bekraeftet'-konklusion.
    if (kyst.confirmedNoOutlet) {
      return { bact: null, viral: null, algae: null, forecast: null, source: 'ingen-bekraeftet', confirmReason: kyst.confirmReason, outlets: [] };
    }
    if (!kyst.outlets || kyst.outlets.length === 0) {
      return { bact: kyst.bact, viral: kyst.viral, algae: kyst.algae, forecast: kyst.forecast, source: 'kystvand', outlets: kyst.outlets };
    }
    let bact = null, viral = null;
    const annotated = [];
    for (const o of kyst.outlets) {
      if (o.lat == null || o.lng == null) continue;
      const contrib = computeOutletDirectionalContribution(lat, lng, o, tau, tauV);
      if (!contrib) continue; // bekræftet nedstrøms/tværgående — udelukkes helt
      if (contrib.adjBact  != null && (bact  === null || contrib.adjBact  > bact))  bact  = contrib.adjBact;
      if (contrib.adjViral != null && (viral === null || contrib.adjViral > viral)) viral = contrib.adjViral;
      annotated.push({ ...o, riskScore: contrib.adjBact, viralScore: contrib.adjViral, dist: contrib.distKm, upstream: contrib.upstream });
    }
    // RETTET (10. runde — "Nyby Havn/FUD5"-fejlen): returnerede tidligere
    // UBETINGET source:'kystvand' med kystvandets egen, upåvirkede algae-
    // værdi, selv når ALLE udløb blev udelukket af retningsfilteret —
    // bact/viral blev null, outlets blev tomt, men badevand-loopet
    // opfattede det stadig som et "matchet" resultat, hvilket udløste
    // klientens "Bekræftet vandområde fundet, men ingen individuelle
    // udløb kunne matches"-besked for lokationer, der reelt HAR nære,
    // relevante udløb — de blev bare (evt. fejlagtigt, se
    // DIRECTIONAL_EXCLUSION_MIN_DIST_M ovenfor) klassificeret nedstrøms.
    // Returnerer nu null i stedet, hvis intet udløb overlevede filteret —
    // badevand-loopet fortsætter da til vandløb, eller falder korrekt til
    // "ingen"/geomMatchNoData, i stedet for at foregive et match uden data.
    if (annotated.length === 0) return null;
    // RETTET (bruger-ønske 2026-07-26 — "Vesterlyng/Havnsø"-fejlen): samme
    // fejl som computeIsotropicLakeResult() havde — kystvandets SAMLEDE
    // confirmedNoOutlet (ovenfor) dækker kun HELE polygonens udløbsliste,
    // men for et SPECIFIKT badested kan bact/viral OGSÅ blive null, hvis
    // samtlige af DENNE lokations egne, strøm-/afstandsoverlevende udløb
    // (annotated) tilfældigvis alle er bekræftede regnvandsudløb, selvom
    // kystvandet SOM HELHED også har andre, spildevands-klassificerede
    // udløb et andet sted langs kysten. Uden dette tjek endte sådan et
    // badested med source:'kystvand', bact/viral=null, algae=ikke-null —
    // klienten viste det derfor fejlagtigt som blå "ingen data" (samme
    // årsag som lakes-udgaven, se computeIsotropicLakeResult()).
    if (bact === null && viral === null && !annotated.some(a => a.isWastewater !== false)) {
      return { bact: null, viral: null, algae: null, forecast: null, source: 'ingen-bekraeftet', confirmReason: 'all-stormwater', outlets: [] };
    }
    // Alge/prognose beholder kystvandets fælles værdi — samme begrundelse
    // som søerne (ingen etableret afstandsmodel for disse to felter).
    annotated.sort((a, b) => (b.riskScore ?? -1) - (a.riskScore ?? -1));
    return { bact, viral, algae: kyst.algae, forecast: kyst.forecast, source: 'kystvand', outlets: annotated.slice(0, 20) };
  }

  // ── Datakonfidens — "hvor meget kan man stole på DETTE badesteds bact/
  // viral-tal lige nu", en SEPARAT, klart mærket dimension fra selve
  // risikotallet (samme adskillelsesprincip som algescore, se filhovedets
  // HÅRDE GRÆNSE-advarsel: må aldrig ændre selve risikoen). Afledt
  // UDELUKKENDE af signaler cascaden allerede har beregnet for dette
  // badested (source, dominerende udløbs upstream-status/afstand) — INGEN
  // nyt dataopslag.
  //
  // Fire diskrete tiers, bevidst IKKE en opfundet numerisk procent — en
  // tal-værdi ville give falsk præcision oven på antagelser, filen selv
  // gentagne gange mærker [ANTAGELSE, IKKE MÅLT] (se ASSUMED_*_VELOCITY_
  // M_PER_S ovenfor).
  //
  // "Tæt på" defineres som en ANDEL af KYSTVAND_TEXTMATCH_MAX_DIST_M/
  // SOE_NAVNEMATCH_MAX_DIST_M (den afstand der allerede afgør om et udløb
  // overhovedet medtages) — bevidst IKKE en ny, selvstændig afstands-
  // konstant, for ikke at opfinde endnu et uvalideret tal ved siden af de
  // eksisterende.
  const NEAR_OUTLET_FRACTION = 0.3;
  function deriveDataConfidence(result, allDownstreamKyst) {
    const source = result?.source ?? (allDownstreamKyst ? 'nedstroms-bekraeftet' : 'ingen');
    // Positivt bekræftet (strøm- eller ID15-bekræftet ingen aktuel kilde)
    // — ikke fravær af data, den mest pålidelige kategori der findes.
    if (source === 'nedstroms-bekraeftet' || source === 'ingen-bekraeftet') return 'hoej';
    // Intet vandområde/vandløb overhovedet matchet — reel datamangel.
    if (source === 'ingen') return 'ingen-data';
    // Udløb/vandområde fundet, men bact OG viral endte alligevel begge
    // null (fx manglende nedbørsdata for netop dette udløbs gittercelle,
    // se riskFromBactViral()'s tilsvarende tjek i seo-pages.js) — reelt
    // samme datamangel-kategori, uanset at et geometrisk match lykkedes.
    if (result.bact == null && result.viral == null) return 'ingen-data';
    // Vandløb med usikker strømretning (compute-vandlob-directions.js'
    // confidence !== 'sikker') — den svageste af de reelle datakilder.
    if (source === 'vandlob-usikker') return 'lav';
    // Vandløb med bekræftet retning — ingen per-udløbs afstandsmodel i
    // denne gren (se toOutlet(), som ikke sætter .dist), så et fast
    // 'middel' er den ærlige konklusion frem for at foregive præcision.
    if (source === 'vandlob') return 'middel';

    const dominant = (result.outlets ?? [])[0]; // allerede sorteret efter faktisk bidrag, se buildRelevantOutlets()/annotated.sort()
    if (!dominant || dominant.dist == null) return 'middel';
    const nearKm = (KYSTVAND_TEXTMATCH_MAX_DIST_M / 1000) * NEAR_OUTLET_FRACTION;
    if (source === 'kystvand') {
      // upstream===true: CMEMS-strømmålt bekræftelse, ikke kun antaget
      // hastighed — kombineret med kort afstand er dette den bedst
      // funderede ikke-bekræftede kategori. upstream===null (isotropisk
      // fallback, ingen strømdata for cellen, eller for tæt til at retning
      // giver mening) forbliver 'middel' uanset afstand.
      if (dominant.upstream === true) return dominant.dist <= nearKm ? 'hoej' : 'middel';
      return 'middel';
    }
    // source === 'soe' — søer har slet ingen retningsmodel, kun afstand.
    return dominant.dist <= nearKm ? 'middel' : 'lav';
  }

  // Sø-udgaven — bruges til lakes[navn].dataConfidence (se tildelingen
  // efter lakeEdges-fremskrivningen nedenfor), til /soe/:slug-siderne.
  // Søer mangler den positions-specifikke information deriveDataConfidence()
  // ovenfor bruger: INGEN enkelt fysisk "badested"-punkt findes for en hel
  // sø (info.lat/info.lng i slug-index.js er blot polygonens bbox-
  // midtpunkt, ikke en reel lokation), og lakes[navn].outlets har derfor
  // ALDRIG per-udløbs .dist/.upstream (dem sætter kun
  // computeIsotropicLakeResult()/-KystvandResult(), kaldt med et KONKRET
  // badesteds lat/lng). En kunstig "afstand fra bbox-midtpunkt"-tilnærmelse
  // ville opfinde et fysisk meningsløst tal — denne er derfor bevidst
  // grovere: kun tre tiers, ingen 'lav', da der intet afstandssignal er at
  // skelne 'middel' fra 'lav' med på dette niveau.
  function deriveLakeDataConfidence(lake) {
    if (lake.confirmedNoOutlet) return 'hoej';
    if (!lake.outlets || lake.outlets.length === 0) return 'ingen-data';
    if (lake.bact == null && lake.viral == null) return 'ingen-data';
    return 'middel';
  }

  // ── Opstrøms-fremskrivning, del 2 (kræver buildRelevantOutlets()/
  // ASSUMED_LAKE_MIXING_VELOCITY_M_PER_S ovenfor — se lakeEdges' filhoved
  // for den fulde begrundelse/eksempel) ──────────────────────────────────
  //
  // RETTET (bruger-rapporteret — "skulle F-U7 ikke fremgå af listen over
  // udløb der påvirker Fiskebæk Friluftsbad?"): første udgave gav hver
  // modtagende sø/hvert kystvand ÉT syntetisk "Farum Sø (opstrøms sø)"-
  // udløb, bygget af kilde-søens allerede fladtrykte MAX-værdi — korrekt
  // beløbsmæssigt, men usporbart: brugeren kunne se AT Furesøen var
  // påvirket, ikke AF HVILKET UDLØB. Fremskriver nu i stedet kilde-søens
  // EGNE, NAVNGIVNE udløb (F-U7 forbliver "F-U7", med sit rigtige id/
  // outfallId — klikbart, åbner udløbets EGEN, virkelige side) — hver
  // enkelt decayet i to lag: (1) intern spredning i kilde-søen fra
  // udløbets EGEN position til søens afløbspunkt (samme
  // ASSUMED_LAKE_MIXING_VELOCITY_M_PER_S/buildRelevantOutlets(), som
  // ethvert badested allerede bruger til at se sin egen, positions-
  // specifikke udløbsliste), (2) rejsetid langs selve forbindelses-
  // vandløbet (ASSUMED_STREAM_VELOCITY_M_PER_S, samme som lakeEdges'
  // distM). Det modtagende vandområdes EGEN, pr.-badested isotropiske
  // model (computeIsotropicLakeResult()/computeOutletDirectionalContribution())
  // lægger derefter et TREDJE henfaldslag oveni (afstand fra sø-
  // forbindelsespunktet til det KONKRETE badested) — matematisk identisk
  // med at henfalde over den fulde, sande rejsetid i ét hug (produktet af
  // tre exp(-t/tau)-led er exp(-summen/tau)), men opdelt i lag der hver
  // for sig allerede fandtes i kodebasen.
  //
  // Behandler lakeEdges i TOPOLOGISK rækkefølge (Kahn's algoritme, kun
  // over sø→sø-kanter — kystvande er altid "bladknuder", ingen udgående
  // kant i denne graf) — garanterer at en søs EGEN udløbsliste allerede
  // indeholder alt fremskrevet fra DENS opstrøms søer, FØR den selv
  // fremskrives videre (korrekt flerled-kæde, fx sø A → sø B → sø C).
  // Bekræftet retningsdata bør aldrig danne en cyklus (vand løber ikke i
  // ring) — resterende søer (hvis en skulle opstå af en datafejl)
  // tilføjes sidst, bedste forsøg, uden at hænge processen.
  if (lakeEdges.length > 0) {
    const lakeAdj = new Map();       // fromNavn -> sø→sø-kanter
    const kystvandOutEdges = new Map(); // fromNavn -> sø→kystvand-kanter
    const inDegree = new Map();
    for (const navn of Object.keys(lakes)) inDegree.set(navn, 0);
    for (const edge of lakeEdges) {
      if (edge.toType === 'lake') {
        if (!lakeAdj.has(edge.fromNavn)) lakeAdj.set(edge.fromNavn, []);
        lakeAdj.get(edge.fromNavn).push(edge);
        inDegree.set(edge.toKey, (inDegree.get(edge.toKey) || 0) + 1);
      } else {
        if (!kystvandOutEdges.has(edge.fromNavn)) kystvandOutEdges.set(edge.fromNavn, []);
        kystvandOutEdges.get(edge.fromNavn).push(edge);
      }
    }
    const inDegreeWork = new Map(inDegree);
    const queue = [...inDegreeWork.entries()].filter(([, d]) => d === 0).map(([navn]) => navn);
    const topoOrder = [];
    while (queue.length > 0) {
      const navn = queue.shift();
      topoOrder.push(navn);
      for (const edge of (lakeAdj.get(navn) || [])) {
        const d = inDegreeWork.get(edge.toKey) - 1;
        inDegreeWork.set(edge.toKey, d);
        if (d === 0) queue.push(edge.toKey);
      }
    }
    const topoSet = new Set(topoOrder);
    for (const navn of Object.keys(lakes)) if (!topoSet.has(navn)) topoOrder.push(navn); // cyklus-fallback, se ovenfor

    const tauP = seasonalTau(), tauVP = seasonalTauViral();

    // Fremskriver kilde-søens EGNE, navngivne udløb (leg 1: intern
    // spredning til afløbspunktet, leg 2: rejsetid langs forbindelsen) ind
    // i target's outlets-liste, og opdaterer targets bact/viral/algae/
    // forecast-aggregat (Math.max, samme princip som resten af filen).
    function propagateEdge(edge, target) {
      const fromLake = lakes[edge.fromNavn];
      if (!fromLake || !fromLake.outlets || fromLake.outlets.length === 0) return;
      const leg1 = buildRelevantOutlets(edge.nearCoord[0], edge.nearCoord[1], fromLake.outlets, ASSUMED_LAKE_MIXING_VELOCITY_M_PER_S, tauP, tauVP, fromLake.outlets.length);
      const travelTimeDaysSeg = (edge.distM / ASSUMED_STREAM_VELOCITY_M_PER_S) / 86400;
      const forwarded = [];
      for (const o of leg1) {
        const adjBact  = o.riskScore  != null ? o.riskScore  * Math.exp(-travelTimeDaysSeg / tauP)  : null;
        const adjViral = o.viralScore != null ? o.viralScore * Math.exp(-travelTimeDaysSeg / tauVP) : null;
        if (adjBact == null && adjViral == null && o.algaeScore == null) continue;
        if (adjBact  != null && (target.bact  === null || adjBact  > target.bact))  target.bact  = adjBact;
        if (adjViral != null && (target.viral === null || adjViral > target.viral)) target.viral = adjViral;
        if (o.algaeScore != null && (target.algae === null || o.algaeScore > target.algae)) target.algae = o.algaeScore;
        forwarded.push({
          ...o, riskScore: adjBact, viralScore: adjViral,
          lat: edge.farCoord[0], lng: edge.farCoord[1],
          municipality: o.municipality ? `${o.municipality} (via ${edge.fromNavn})` : `via ${edge.fromNavn}`,
        });
      }
      // NYT: prognose (forecast) har INGEN per-udløb henfaldsmodel noget
      // sted i denne fil (toOutlet() bærer den slet ikke pr. punkt, se dens
      // filhoved — kun søens/kystvandets EGEN, allerede fladtrykte
      // fælles værdi findes) — fremskrives derfor som kildesøens egen
      // uhenfaldede fælles prognoseværdi, samme "intet etableret henfald"-
      // princip som algae ovenfor.
      if (fromLake.forecast != null && (target.forecast === null || fromLake.forecast > target.forecast)) target.forecast = fromLake.forecast;
      if (forwarded.length === 0) return;
      target.outlets = [...(target.outlets || []), ...forwarded];
      if (target.confirmedNoOutlet) {
        target.confirmedNoOutlet = false;
        target.confirmReason = null;
        if (!target.kilde || target.kilde === 'bekraeftet-ingen-udloeb') target.kilde = 'opstroms-soe';
      }
    }

    for (const navn of topoOrder) {
      for (const edge of (lakeAdj.get(navn) || [])) propagateEdge(edge, lakes[edge.toKey]);
      for (const edge of (kystvandOutEdges.get(navn) || [])) propagateEdge(edge, kystvande[edge.toKey]);
    }
  }

  // NYT (bruger-ønske — datakonfidens for sø-siderne): beregnes her,
  // UBETINGET (uden for lakeEdges.length>0-blokken ovenfor) — skal sættes
  // for ALLE søer, ikke kun dem med opstrøms sø-forbindelser, og skal ske
  // EFTER propagateEdge()-fremskrivningen ovenfor, så confirmedNoOutlet/
  // outlets er de ENDELIGE værdier (propagateEdge kan rydde
  // confirmedNoOutlet, se dens filhoved).
  for (const navn of Object.keys(lakes)) {
    lakes[navn].dataConfidence = deriveLakeDataConfidence(lakes[navn]);
  }

  // ── Badevand: punkt-i-polygon (sø → kystvand) → punkt-nær-linje (vandløb) ─
  const badevandFeatures = (badevandGeojson.features || []).filter(f => f.geometry?.type === 'Point');
  const badevand = [];
  // NYT (bruger-ønske 2026-07-25 — "Læsø"-fejlen): ov_id -> {bactSum,
  // bactN, viralSum, viralN}, fyldt undervejs i badevands-løkken nedenfor,
  // brugt EFTER løkken til at genberegne kystvande[ov_id].bact/viral (se
  // gennemgangen lige efter denne løkke slutter).
  const kystvandBadevandContrib = new Map();
  const tauBadevand = seasonalTau(), tauVBadevand = seasonalTauViral();
  for (let i = 0; i < badevandFeatures.length; i += batchSize) {
    const batch = badevandFeatures.slice(i, i + batchSize);
    for (const feat of batch) {
      const geom = feat.geometry;
      const [lng, lat] = geom.coordinates;
      const props = feat.properties || {};
      // RETTET: vp3_badevand.geojson's reelle ID-felt hedder 'bathingwat'
      // (EU's badevandsdirektiv-ID, fx "DKBW1009") — hverken 'ov_id' eller
      // 'id' findes på badevands-featuresne (kun på sø-/kystvand-lagene).
      // Ramte derfor ALTID null her, hvilket sprang alle 1.039 badesteder
      // over uden fejl — arrayet blev stille og roligt tomt.
      const id = props.bathingwat ?? props.ov_id ?? props.id ?? null;
      if (id === null) continue;

      let result = null;
      for (const lake of lakeList) {
        const b = lake.bbox;
        if (lat < b.minLat - WATERBODY_MATCH_BUFFER_DEG || lat > b.maxLat + WATERBODY_MATCH_BUFFER_DEG ||
            lng < b.minLng - WATERBODY_MATCH_BUFFER_DEG || lng > b.maxLng + WATERBODY_MATCH_BUFFER_DEG) continue;
        if (pointInOrNearGeometry(lat, lng, lake.geometry, WATERBODY_MATCH_BUFFER_DEG)) { result = computeIsotropicLakeResult(lat, lng, lake, tauBadevand, tauVBadevand); break; }
      }
      // NYT: skelner "intet kystvand matchet overhovedet" fra "kystvand
      // matchet, HAR kendte udløb, men samtlige blev bekræftet nedstrøms af
      // CMEMS' strømretning lige nu" (se computeIsotropicKystvandResult()'s
      // "Nyby Havn/FUD5"-kommentar) — sidstnævnte er IKKE det samme som
      // "ingen data": det er en positiv, strømbekræftet konklusion (ingen
      // kendt forureningskilde truer lige nu dette badested), som tidligere
      // gik tabt og faldt sammen med den generiske "ingen"/navnematch-
      // besked nedenfor. Se badevand.push() nedenfor for hvordan det nu
      // rapporteres distinkt til klienten.
      let allDownstreamKyst = null;
      // NYT (bruger-ønske 2026-07-25 — "Læsø"-fejlen): husker HVILKET
      // specifikt kystvand dette badested matchede til, så dets EGET,
      // allerede afstands-/strømkorrigerede resultat kan bruges til at
      // genberegne kystvandets viste bact/viral EFTER hele badevands-
      // løkken (se kystvandBadevandContrib nedenfor) — i stedet for
      // kystvandets rå, ikke-afstandsdæmpede udløbsgennemsnit.
      let matchedKystOvId = null;
      if (!result) {
        for (const kyst of kystvandList) {
          const b = kyst.bbox;
          if (lat < b.minLat - WATERBODY_MATCH_BUFFER_DEG || lat > b.maxLat + WATERBODY_MATCH_BUFFER_DEG ||
              lng < b.minLng - WATERBODY_MATCH_BUFFER_DEG || lng > b.maxLng + WATERBODY_MATCH_BUFFER_DEG) continue;
          if (pointInOrNearGeometry(lat, lng, kyst.geometry, WATERBODY_MATCH_BUFFER_DEG)) {
            result = computeIsotropicKystvandResult(lat, lng, kyst, tauBadevand, tauVBadevand);
            if (!result && kyst.outlets && kyst.outlets.length > 0) allDownstreamKyst = kyst;
            if (result || allDownstreamKyst) matchedKystOvId = kyst.ov_id;
            break;
          }
        }
      }
      if (!result) {
        for (const v of vandlobEntries) {
          const b = v.bbox;
          if (lat < b.minLat - VANDLOB_BUFFER_DEG || lat > b.maxLat + VANDLOB_BUFFER_DEG ||
              lng < b.minLng - VANDLOB_BUFFER_DEG || lng > b.maxLng + VANDLOB_BUFFER_DEG) continue;
          if (!waterClass.pointNearLine(lat, lng, v.geometry, VANDLOB_BUFFER_DEG)) continue;
          let bact = null, viral = null, algae = null;
          const outlets = [];
          for (const pid of v.match.pulsPointIds) {
            const pt = pointsById[pid];
            if (!pt) continue;
            outlets.push(toOutlet(pt));
            if (pt.riskScore  != null && (bact  === null || pt.riskScore  > bact))  bact  = pt.riskScore;
            if (pt.viralScore != null && (viral === null || pt.viralScore > viral)) viral = pt.viralScore;
            if (pt.algaeScore != null && (algae === null || pt.algaeScore > algae)) algae = pt.algaeScore;
          }
          if (bact !== null || viral !== null || algae !== null) { result = { bact, viral, algae, source: v.match.lowConfidence ? 'vandlob-usikker' : 'vandlob', outlets }; break; }
        }
      }

      // NYT: sekundært opslag — kun hvis intet primært match med data blev
      // fundet ovenfor — mod ALLE kendte geometrier (uanset om de har
      // data), så klienten (uden egen lokal fallback) stadig kan vise
      // "vandområde matchet, men ingen data" fremfor "intet match
      // overhovedet", når det er sandt. Se allLakeGeoms/allKystvandGeoms
      // ovenfor.
      let noDataMatch = null;
      if (!result && !allDownstreamKyst) {
        for (const lake of allLakeGeoms) {
          const b = lake.bbox;
          if (lat < b.minLat - WATERBODY_MATCH_BUFFER_DEG || lat > b.maxLat + WATERBODY_MATCH_BUFFER_DEG ||
              lng < b.minLng - WATERBODY_MATCH_BUFFER_DEG || lng > b.maxLng + WATERBODY_MATCH_BUFFER_DEG) continue;
          if (pointInOrNearGeometry(lat, lng, lake.geometry, WATERBODY_MATCH_BUFFER_DEG)) { noDataMatch = { type: 'sø', navn: lake.navn }; break; }
        }
      }
      if (!result && !allDownstreamKyst && !noDataMatch) {
        for (const kyst of allKystvandGeoms) {
          const b = kyst.bbox;
          if (lat < b.minLat - WATERBODY_MATCH_BUFFER_DEG || lat > b.maxLat + WATERBODY_MATCH_BUFFER_DEG ||
              lng < b.minLng - WATERBODY_MATCH_BUFFER_DEG || lng > b.maxLng + WATERBODY_MATCH_BUFFER_DEG) continue;
          if (pointInOrNearGeometry(lat, lng, kyst.geometry, WATERBODY_MATCH_BUFFER_DEG)) { noDataMatch = { type: 'kystvand', navn: kyst.navn }; break; }
        }
      }

      // NYT: outlets sendes nu med til klienten (se toOutlet()/resolveOutlets()
      // og lakes/kystvande ovenfor) — retter "Bekræftet vandområde fundet,
      // men ingen individuelle udløb kunne matches", som ellers ALTID viste
      // sig for badesteder der ramte server-genvejen i computeBadevandRisk(),
      // fordi den før hardkodede outlets:[] uafhængigt af faktiske match.
      //
      // NYT: 'nedstroms-bekraeftet' — se allDownstreamKyst ovenfor. Egen,
      // POSITIV kildeværdi (ikke 'ingen'), så klienten kan vise en grøn,
      // strømbekræftet "ingen aktuel kilde"-markering i stedet for den
      // neutrale/blå "ingen data"-visning, som ellers fejlagtigt antyder
      // manglende viden, ikke en reel, aktuel strømbekræftelse.
      // ⚠️ HÅRD GRÆNSE: badested-observations.js's borgerobservationer
      // (ét-tryks status + algeobservation) må ALDRIG læses ind i bact/
      // viral/algae herunder eller på nogen anden måde påvirke `source` —
      // de er et bevidst adskilt, egetmærket lag, samme princip som
      // algerisiko allerede er adskilt fra den officielle sikkerheds-
      // vurdering. Se badested-observations.js's filhoved for den fulde
      // begrundelse, hvis det nogensinde virker fristende at koble dem.
      // (Denne grænse er UBERØRT af Kommunepakke, modul 6 — badested-
      // overrides.js's applyActiveOverrides() patcher bact/viral EFTER
      // denne cascade er beregnet, udenfor denne fil, som en bevidst
      // ANDEN, autentificeret og tydeligt offentligt mærket mekanisme.
      // Se badested-observations.js's filhoved for den fulde skelnen.)
      badevand.push({
        id,
        bact: result?.bact ?? null, viral: result?.viral ?? null, algae: result?.algae ?? null,
        // NYT: eksponeret her (var allerede beregnet af computeIsotropicLakeResult()/
        // -KystvandResult(), se deres returværdi) til app-metrics.js's daglige
        // risikohistorik-akkumulering — lakes/kystvande fik allerede forecast
        // med til klienten, kun badevand-objektet manglede feltet.
        forecast: result?.forecast ?? null,
        source: result?.source ?? (allDownstreamKyst ? 'nedstroms-bekraeftet' : 'ingen'),
        // RETTET (bruger-rapporteret — confirmReason blev sat korrekt i
        // computeIsotropicLakeResult()/-KystvandResult()'s returværdi, men
        // aldrig kopieret videre hertil, det FAKTISKE objekt der sendes til
        // klienten — endte derfor altid som null/undefined uanset årsag).
        confirmReason: result?.confirmReason ?? null,
        outlets: result?.outlets ?? [],
        noDataMatch: result || allDownstreamKyst ? null : noDataMatch,
        allDownstreamMatch: allDownstreamKyst ? { type: 'kystvand', navn: allDownstreamKyst.navn } : null,
        // NYT (bruger-ønske — datakonfidens): se deriveDataConfidence()
        // ovenfor for den fulde begrundelse. 'hoej'|'middel'|'lav'|'ingen-data'.
        dataConfidence: deriveDataConfidence(result, allDownstreamKyst),
      });
      // NYT (bruger-ønske 2026-07-25 — "Læsø"-fejlen): saml dette badesteds
      // EGET, allerede afstands-/strømkorrigerede resultat til senere at
      // genberegne det matchede kystvands VISTE bact/viral (se
      // kystvandBadevandContrib-gennemgangen efter denne løkke). Kilden
      // 'kystvand' bidrager med sin faktiske (lave eller høje) score;
      // 'nedstroms-bekraeftet' bidrager bevidst med 0 — en reel, positiv
      // måling (strømbekræftet ingen aktuel kilde), ikke fravær af data.
      if (matchedKystOvId != null && (result?.source === 'kystvand' || allDownstreamKyst)) {
        let c = kystvandBadevandContrib.get(matchedKystOvId);
        if (!c) { c = { bactSum: 0, bactN: 0, viralSum: 0, viralN: 0 }; kystvandBadevandContrib.set(matchedKystOvId, c); }
        const b = result?.source === 'kystvand' ? (result.bact ?? null) : 0;
        const v = result?.source === 'kystvand' ? (result.viral ?? null) : 0;
        if (b !== null) { c.bactSum  += b; c.bactN++;  }
        if (v !== null) { c.viralSum += v; c.viralN++; }
      }
    }
    // NYT: giv kontrollen tilbage til Node mellem hver portion — se
    // funktionsdokumentationen ovenfor for hvorfor dette IKKE er valgfrit.
    await new Promise(resolve => setImmediate(resolve));
  }

  // RETTET (bruger-ønske 2026-07-25 — "Læsø"-fejlen): erstatter kystvandenes
  // rå, ikke-afstandsdæmpede udløbsgennemsnit (sat tidligere i denne fil,
  // se kommentaren ved kystvande[props.ov_id]) med et gennemsnit af de
  // FAKTISKE, matchede badesteders egne, allerede afstands-/strøm-
  // korrigerede resultater — kun for kystvand med mindst ét matchet
  // badested. Uden noget matchet badested forbliver den rå værdi (allerede
  // sat) uændret, da den er det eneste tilgængelige estimat.
  for (const [ovId, c] of kystvandBadevandContrib) {
    const kv = kystvande[ovId];
    if (!kv) continue;
    if (c.bactN  > 0) kv.bact  = c.bactSum  / c.bactN;
    if (c.viralN > 0) kv.viral = c.viralSum / c.viralN;
  }

  console.log(`badevand-risk: ${lakeList.length} søer, ${kystvandList.length} kystvande, ${badevand.length} badesteder beregnet på ${Date.now() - t0} ms`);
  return { lakes, kystvande, badevand };
}

module.exports = { computeBadevandRiskCascade, haversineM };
