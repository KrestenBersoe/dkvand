#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// update-puls.js — henter og opdaterer puls-data.json fra Miljøportalen
//
// Brug:
//   node update-puls.js              (skriver til ./puls-data.json)
//   node update-puls.js --dry-run    (printer statistik uden at skrive)
//   node update-puls.js --out /sti   (skriver til anden sti)
//
// RETTET (fuld omskrivning): myndigheden har lagt PULS' regnbetingede-udløb-
// data om siden dette script sidst blev skrevet. De to gamle lag,
// puls:rbu_punkt (stamdata) og puls:rbu_udledning (udledning, hentet fra
// arealdata.miljoeportal.dk), findes IKKE længere — det første giver HTTP 400
// (ikke i GetCapabilities), og det andet endpoint (arealdata.miljoeportal.dk/
// geoserver/ows) svarer i dag slet ikke med WFS/GeoServer, men med en helt
// almindelig webside (Arealdata-søgeportalen). Bekræftet ved direkte
// forespørgsel mod serveren, ikke en antagelse.
//
// Data er nu KONSOLIDERET i ét enkelt WFS-lag: puls:Regnbetingedeudloeb
// (stadig hos pulsgeo.miljoeportal.dk) — stamdata OG udledning i samme
// feature, ingen sammenfletning nødvendig længere. Laget indeholder BÅDE
// aktive og historiske/nedlagte udløb blandet sammen (67.857 i alt) —
// "Closed"-feltet er "Aktivt" for et åbent udløb, "Nedlagt d. <dato>" for et
// lukket. Filtreres server-side via CQL_FILTER til kun de aktive (bekræftet
// ved test: 21.600 aktive, tæt på det tidligere kendte antal på 21.556).
//
// waterArea (recipient-vandområde) findes IKKE længere i noget PULS-lag
// overhovedet (bekræftet: tjekket samtlige 6 lag på serveren, samt VP3's
// RBU-lag som kun dækker ~1%) — sættes derfor altid tomt her. Udledes i
// stedet EFTERFØLGENDE af scripts/derive-water-area.js (se update-all-data.sh
// trin 9), fra data vi allerede henter/beregner i forvejen.
//
// Datakilde (åben data, ingen API-nøgle):
//   pulsgeo.miljoeportal.dk — puls:Regnbetingedeudloeb: koordinater, navn,
//   kommune, årets udledte volumen (m³) og antal overløbshændelser, i én
//   feature pr. udløb.
//
// Output: komprimeret JSON-format til dkvand-appen
//   { a: [kommuner], w: [vandområder],
//     d: [[lat,lng,navn,aIdx,wIdx,vol,ev,q,
//          outfallId,reducedArea,type,sewerStructure,latestDischargeYear,
//          cod,bod,nitrogen,phosphor,
//          normalYear,normalVol,normalEv,normalCod,normalBod,normalNitrogen,normalPhosphor]] }
//   qualityCode: 0=reelle data, 1=verificeret nul, 2=estimeret, 3=ingen data
//
// NYT: outfallId/reducedArea/type/sewerStructure/latestDischargeYear —
// tilføjet som BAGESTILLEDE felter (positionerne 0-7 er uændrede) til brug
// for den udløbs-specifikke nedbørstærskel-beregning (se
// scripts/compute-puls-udloeb-taerskler.js). Hentes fra WFS-kildelagets
// ReducedArea/Type/SewerStructure/LatestDischargeYear-felter (bekræftet via
// DescribeFeatureType — findes i kilden, var bare ikke udtrukket her
// tidligere). latestDischargeYear er PÅKRÆVET i kilden (minOccurs=1), men
// gemmes alligevel med samme null-tolerante mønster som resten. reducedArea/
// type/sewerStructure er alle nullable i kilden og kan derfor være null her.
//
// NYT (2. runde): cod/bod/nitrogen/phosphor (LatestDischargeCod/Bod/
// Nitrogen/Phosphor) samt hele normalårs-sættet (LatestNormalDischarge*) —
// stofbelastning i kg/år, bekræftet til stede på selve udløbsniveau via
// DescribeFeatureType (ikke kun aggregeret på anlægs-/kloakoplandsniveau,
// som først antaget). Alle nullable (minOccurs=0) undtagen
// LatestNormalDischargeYear (minOccurs=1) — samme null-tolerante mønster
// som resten. Normalår er MST's beregnede gennemsnit over 10-30 års
// nedbørsdata (jf. DTA DP02) og er derfor mere robust til
// sø-sammenligning end konkretår; begge gemmes, da konkretår viser aktuel
// belastning.
//
// Ingen eksisterende forbruger (risk-model.js, dansk-overloeb-kort.html)
// destrukturerer mere end de første 8 positioner, så dette er
// bagudkompatibelt.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── Konfiguration ─────────────────────────────────────────────────────────────
const WFS_STAMDATA  = 'https://pulsgeo.miljoeportal.dk/geoserver/wfs';

const TYPENAME_STAMDATA = 'puls:Regnbetingedeudloeb';  // koordinater + stamdata + udledning, ét lag
// Kun aktive udløb — se filhoved. "Closed" er en tekststreng ("Aktivt" eller
// "Nedlagt d. <dato>"), ikke en boolean/dato, så et LIKE-udtryk er nødvendigt.
const ACTIVE_FILTER = "Closed NOT LIKE 'Nedlagt%'";

const PAGE_SIZE = 2000;   // antal features pr. WFS-kald
// RETTET: pegede tidligere én mappe FOR HØJT ('..') — scriptet ligger i
// repo-roden (samme sted som puls-data.json), ikke i en undermappe.
const OUT_FILE  = path.resolve(process.argv.find(a => a === '--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(__dirname, 'puls-data.json'));
const DRY_RUN   = process.argv.includes('--dry-run');

// Log-log regressionsmodel til estimering af hændelser fra volumen
// Kalibreret på de ~4.683 punkter med reelle data
// log10(events) = LOG_A + LOG_B * log10(volume_m3)
const LOG_A =  0.28;   // intercept
const LOG_B =  0.52;   // hældning

// ── HTTP hjælpefunktioner ─────────────────────────────────────────────────────
function fetch(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(rawUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const timeout = options.timeout || 30000;
    // RETTET: GetCapabilities returnerer XML, ikke JSON — men denne
    // funktion sendte hidtil ALTID "Accept: application/json", uanset
    // hvilken slags kald der var tale om. For GetCapabilities-kaldet
    // afviste serveren det tilsyneladende med HTTP 406 (Not Acceptable),
    // fordi den ikke kan levere JSON for den operation. Accept-header kan
    // nu overstyres pr. kald; standard er stadig JSON for selve
    // datahentningen (GetFeature), som eksplicit beder om outputFormat=json.
    const acceptHeader = options.accept || 'application/json';

    const req = lib.get(rawUrl, { headers: { 'Accept': acceptHeader } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetch(res.headers.location, options).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${rawUrl}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function buildWfsUrl(base, typename, startIndex = 0, cqlFilter = null) {
  let u = `${base}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeNames=${encodeURIComponent(typename)}` +
    `&outputFormat=application%2Fjson` +
    `&srsName=EPSG%3A4326` +
    `&count=${PAGE_SIZE}&startIndex=${startIndex}`;
  if (cqlFilter) u += `&CQL_FILTER=${encodeURIComponent(cqlFilter)}`;
  return u;
}

// ── WFS pagineret hentning ────────────────────────────────────────────────────
async function fetchAllFeatures(baseUrl, typename, cqlFilter = null) {
  const features = [];
  let   start    = 0;
  let   total    = null;

  process.stdout.write(`  Henter ${typename}:`);

  while (true) {
    const wfsUrl = buildWfsUrl(baseUrl, typename, start, cqlFilter);
    let   body;
    try {
      body = await fetch(wfsUrl, { timeout: 60000 });
    } catch(e) {
      throw new Error(`WFS-fejl ved ${typename} (start=${start}): ${e.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch(e) {
      // GeoServer kan returnere XML-fejl — forsøg at udskrive de første 200 tegn
      throw new Error(`JSON-parse fejl (start=${start}): ${body.slice(0, 200)}`);
    }

    if (parsed.exceptions || parsed.ExceptionReport) {
      const msg = JSON.stringify(parsed).slice(0, 300);
      throw new Error(`WFS Exception: ${msg}`);
    }

    const batch = parsed.features || [];
    if (total === null) {
      total = parsed.totalFeatures ?? parsed.numberMatched ?? '?';
    }

    features.push(...batch);
    process.stdout.write(` ${features.length}`);

    if (batch.length < PAGE_SIZE) break;  // sidste side
    start += PAGE_SIZE;
  }

  process.stdout.write(` / ${total} total\n`);
  return features;
}

// ── Koordinatudtræk ───────────────────────────────────────────────────────────
function getCoords(feature) {
  const geom = feature.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') {
    const [lng, lat] = geom.coordinates;
    return { lat: +lat, lng: +lng };
  }
  return null;
}

// ── Log-log hændelsesestimering ───────────────────────────────────────────────
function imputeEvents(volumeM3) {
  if (!volumeM3 || volumeM3 <= 0) return null;
  const logVol = Math.log10(volumeM3);
  const logEv  = LOG_A + LOG_B * logVol;
  return Math.max(1, Math.round(Math.pow(10, logEv)));
}

// ── Komprimeringsformat ───────────────────────────────────────────────────────
// Output: { a: [kommuner], w: [vandområder], d: rows }
// Hvert row: [lat, lng, navn, authIdx, areaIdx, volumeM3, eventsPerYear|null, qualityCode]
function compress(points) {
  const authMap = new Map();   // kommune → idx
  const areaMap = new Map();   // vandområde → idx
  const auths   = [];
  const areas   = [];

  function authIdx(name) {
    if (!authMap.has(name)) { authMap.set(name, auths.length); auths.push(name); }
    return authMap.get(name);
  }
  function areaIdx(name) {
    if (!areaMap.has(name)) { areaMap.set(name, areas.length); areas.push(name); }
    return areaMap.get(name);
  }

  const rows = points.map(p => [
    +p.lat.toFixed(5),
    +p.lng.toFixed(5),
    p.name,
    authIdx(p.municipality || '—'),
    areaIdx(p.waterArea    || 'Ukendt'),
    p.volumeM3   !== null ? +p.volumeM3.toFixed(0)   : 0,
    p.eventsYear !== null ? +p.eventsYear.toFixed(1)  : null,
    p.quality,
    p.outfallId      || null,
    p.reducedArea     !== null ? +p.reducedArea.toFixed(4) : null,
    p.type            || null,
    p.sewerStructure  || null,
    p.latestDischargeYear !== null ? p.latestDischargeYear : null,
    p.cod       !== null ? +p.cod.toFixed(1)       : null,
    p.bod       !== null ? +p.bod.toFixed(1)       : null,
    p.nitrogen  !== null ? +p.nitrogen.toFixed(1)  : null,
    p.phosphor  !== null ? +p.phosphor.toFixed(2)  : null,
    p.normalYear   !== null ? p.normalYear : null,
    p.normalVol      !== null ? +p.normalVol.toFixed(0)      : null,
    p.normalEv       !== null ? +p.normalEv.toFixed(1)       : null,
    p.normalCod      !== null ? +p.normalCod.toFixed(1)      : null,
    p.normalBod      !== null ? +p.normalBod.toFixed(1)      : null,
    p.normalNitrogen !== null ? +p.normalNitrogen.toFixed(1) : null,
    p.normalPhosphor !== null ? +p.normalPhosphor.toFixed(2) : null,
  ]);

  return { a: auths, w: areas, d: rows };
}

// ── Udtræk fra det konsoliderede puls:Regnbetingedeudloeb-lag ────────────────
// RETTET: erstatter tidligere merge(stamdata, udledning) — stamdata og
// udledning ligger nu i SAMME feature, ingen navnebaseret sammenfletning
// nødvendig længere (og dermed heller ikke den fejlkilde, det tidligere var,
// hvis to udløb tilfældigvis delte navn).
function extractPoints(features) {
  const points = [];
  let q0 = 0, q1 = 0, q2 = 0, q3 = 0;

  for (const f of features) {
    const p      = f.properties || {};
    const coords = getCoords(f);
    if (!coords) continue;

    const name = (p.Name || '').trim();
    const muni = (p.Authority || '').trim();

    // NYT: OutfallId (stabil GUID, til utvetydig sporbarhed — Name kan
    // kollidere på tværs af udløb), ReducedArea ("reduceret areal", ha,
    // DP02-terminologi — matchingvariabel for tærskellåning), Type
    // (selvforklarende fritekst, fx "Overløbsbygværk med bassin") og
    // SewerStructure (kort kode, ubekræftet legende — gemmes rå).
    const outfallId      = (p.OutfallId || '').trim() || null;
    const reducedAreaRaw = p.ReducedArea;
    const reducedArea    = reducedAreaRaw == null ? null : parseFloat(reducedAreaRaw);
    const type            = (p.Type || '').trim() || null;
    const sewerStructure  = (p.SewerStructure || '').trim() || null;
    const latestDischargeYearRaw = p.LatestDischargeYear;
    const latestDischargeYear    = latestDischargeYearRaw == null ? null : parseInt(latestDischargeYearRaw, 10);

    // NYT (2. runde): stofbelastning kg/år, konkretår + normalår — se
    // filhoved. Samme null-tolerante mønster som resten: felterne er
    // minOccurs=0 i kilden (undtagen LatestNormalDischargeYear), så en
    // ærlig null betyder "ikke indberettet", ikke 0.
    const codRaw       = p.LatestDischargeCod;
    const cod          = codRaw == null ? null : parseFloat(codRaw);
    const bodRaw       = p.LatestDischargeBod;
    const bod          = bodRaw == null ? null : parseFloat(bodRaw);
    const nitrogenRaw  = p.LatestDischargeNitrogen;
    const nitrogen     = nitrogenRaw == null ? null : parseFloat(nitrogenRaw);
    const phosphorRaw  = p.LatestDischargePhosphor;
    const phosphor     = phosphorRaw == null ? null : parseFloat(phosphorRaw);

    const normalYearRaw = p.LatestNormalDischargeYear;
    const normalYear     = normalYearRaw == null ? null : parseInt(normalYearRaw, 10);
    const normalVolRaw   = p.LatestNormalDischargeVolume;
    const normalVol      = normalVolRaw == null ? null : parseFloat(normalVolRaw);
    const normalEvRaw    = p.LatestNormalDischargeOverflows;
    const normalEv       = normalEvRaw == null ? null : parseFloat(normalEvRaw);
    const normalCodRaw   = p.LatestNormalDischargeCod;
    const normalCod      = normalCodRaw == null ? null : parseFloat(normalCodRaw);
    const normalBodRaw   = p.LatestNormalDischargeBod;
    const normalBod      = normalBodRaw == null ? null : parseFloat(normalBodRaw);
    const normalNitrogenRaw = p.LatestNormalDischargeNitrogen;
    const normalNitrogen    = normalNitrogenRaw == null ? null : parseFloat(normalNitrogenRaw);
    const normalPhosphorRaw = p.LatestNormalDischargePhosphor;
    const normalPhosphor    = normalPhosphorRaw == null ? null : parseFloat(normalPhosphorRaw);

    // NYT: begge felter kan reelt være NULL (ikke indberettet) ELLER 0
    // (bekræftet nul) — en meningsfuld forskel, se kvalitetskode-grenene
    // nedenfor, så de holdes adskilt her (ingen "?? 0"-sammenfald).
    const volRaw = p.LatestDischargeVolume;
    const vol    = volRaw == null ? null : parseFloat(volRaw);
    const evRaw  = p.LatestDischargeOverflows;
    const ev     = evRaw == null ? null : parseFloat(evRaw);

    let quality, evFinal;
    if (ev !== null && ev > 0) {
      quality = 0; evFinal = ev; q0++;                          // reelle data
    } else if (ev === 0 || (vol !== null && vol === 0)) {
      quality = 1; evFinal = 0; q1++;                           // verificeret nul
    } else if (vol !== null && vol > 0) {
      quality = 2; evFinal = imputeEvents(vol); q2++;            // estimeret fra volumen
    } else {
      quality = 3; evFinal = null; q3++;                         // ingen data
    }

    points.push({
      lat: coords.lat, lng: coords.lng,
      name:         name || `Udløb ${points.length}`,
      municipality: muni,
      // NYT: recipient-feltet findes ikke længere i kilden — udledes i
      // stedet EFTERFØLGENDE af scripts/derive-water-area.js, se filhoved.
      waterArea:    '',
      volumeM3:     vol,
      eventsYear:   evFinal,
      quality,
      outfallId, reducedArea, type, sewerStructure, latestDischargeYear,
      cod, bod, nitrogen, phosphor,
      normalYear, normalVol, normalEv, normalCod, normalBod, normalNitrogen, normalPhosphor,
    });
  }

  console.log(`\nKvalitetskoder:`);
  console.log(`  q0 (reelle data):      ${q0.toLocaleString('da')}`);
  console.log(`  q1 (verificeret nul):  ${q1.toLocaleString('da')}`);
  console.log(`  q2 (estimeret):        ${q2.toLocaleString('da')}`);
  console.log(`  q3 (ingen data):       ${q3.toLocaleString('da')}`);
  console.log(`  I alt:                 ${points.length.toLocaleString('da')} udløb`);

  return points;
}

// ── GetCapabilities verificering ──────────────────────────────────────────────
async function verifyEndpoint(baseUrl, typename) {
  const capUrl = `${baseUrl}?service=WFS&version=2.0.0&request=GetCapabilities`;
  try {
    // RETTET: brug en neutral Accept-header her (ikke application/json,
    // som forårsagede HTTP 406) — GetCapabilities svarer altid i XML.
    const body = await fetch(capUrl, { timeout: 15000, accept: '*/*' });
    const shortName = typename.split(':').pop();
    const found = body.includes(shortName);
    if (!found) {
      // RETTET: advarede tidligere kun og fortsatte blindt — hvilket
      // uundgåeligt endte i en langt mere kryptisk HTTP 400 senere, når
      // selve GetFeature-kaldet forsøgte at bruge et lag-navn, der ikke
      // findes. Viser nu i stedet de FAKTISK tilgængelige lag-navne, der
      // ligner det forventede, så den reelle årsag er synlig med det samme.
      console.warn(`  Advarsel: "${typename}" ikke fundet i GetCapabilities.`);
      const allNames = [...body.matchAll(/<(?:wfs:)?Name>([^<]+)<\/(?:wfs:)?Name>/g)].map(m => m[1]);
      const similar = allNames.filter(n => n.toLowerCase().includes('puls') || n.toLowerCase().includes('rbu'));
      if (similar.length > 0) {
        console.warn(`  Lignende lag-navne fundet på denne server (kontrollér om typename skal opdateres):`);
        similar.forEach(n => console.warn(`    - ${n}`));
      } else {
        console.warn(`  Ingen lignende lag-navne fundet — tjek om ${baseUrl} overhovedet er det rigtige endpoint.`);
      }
    } else {
      console.log(`  OK: ${typename} bekræftet i GetCapabilities`);
    }
  } catch(e) {
    console.warn(`  Advarsel: GetCapabilities fejlede (${e.message}) — fortsætter`);
  }
}

// ── Hoved ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('PULS-data opdatering');
  console.log(new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' }));
  console.log('═══════════════════════════════════════════════\n');

  // Diagnostik-tilstand: hent blot 3 features fra det NYE lag-navn og vis
  // alle deres properties, så det korrekte feltnavn for volumen/hændelser
  // kan bekræftes, før hele sammenkoblings-logikken omskrives blindt.
  //   node update-puls.js --inspect puls:Regnbetingedeudloeb
  // Skema-diagnostik: DescribeFeatureType lister SAMTLIGE mulige felter i
  // laget, uanset om de tre stikprøve-features fra --inspect tilfældigvis
  // havde data i dem. Bruges specifikt til at afklare om et recipient-/
  // vandområde-felt findes et sted, --inspect ikke viste.
  //   node update-puls.js --describe puls:Regnbetingedeudloeb
  const describeIdx = process.argv.indexOf('--describe');
  if (describeIdx >= 0) {
    const typename = process.argv[describeIdx + 1];
    if (!typename) { console.error('Brug: node update-puls.js --describe <typename>'); process.exit(1); }
    console.log(`Henter skema for ${typename}…\n`);
    const url = `${WFS_STAMDATA}?service=WFS&version=2.0.0&request=DescribeFeatureType` +
      `&typeNames=${encodeURIComponent(typename)}`;
    const body = await fetch(url, { timeout: 30000, accept: '*/*' });
    // RETTET: den oprindelige regex fangede kun rod-elementet, ikke de
    // enkelte felter — den faktiske XML-struktur var anderledes end
    // antaget. Viser nu den rå XML direkte i stedet for at gætte på et
    // parsing-mønster igen.
    console.log(body);
    return;
  }

  const inspectIdx = process.argv.indexOf('--inspect');
  if (inspectIdx >= 0) {
    const typename = process.argv[inspectIdx + 1];
    if (!typename) { console.error('Brug: node update-puls.js --inspect <typename>'); process.exit(1); }
    console.log(`Henter 3 eksempel-features fra ${typename}…\n`);
    const url = `${WFS_STAMDATA}?service=WFS&version=2.0.0&request=GetFeature` +
      `&typeNames=${encodeURIComponent(typename)}&outputFormat=application%2Fjson` +
      `&srsName=EPSG%3A4326&count=3&startIndex=0`;
    const body = await fetch(url, { timeout: 30000 });
    const parsed = JSON.parse(body);
    (parsed.features || []).forEach((f, i) => {
      console.log(`--- Feature ${i + 1} ---`);
      console.log('geometry:', JSON.stringify(f.geometry));
      console.log('properties:', JSON.stringify(f.properties, null, 2));
      console.log('');
    });
    return;
  }

  // 1. Verificer endpoint
  console.log('Verificerer WFS-endpoint…');
  await verifyEndpoint(WFS_STAMDATA, TYPENAME_STAMDATA);

  // 2. Hent data — server-side filtreret til kun aktive udløb (se ACTIVE_FILTER)
  console.log(`\nHenter ${TYPENAME_STAMDATA} (kun aktive, CQL_FILTER="${ACTIVE_FILTER}")…`);
  const features = await fetchAllFeatures(WFS_STAMDATA, TYPENAME_STAMDATA, ACTIVE_FILTER);
  if (features.length === 0) throw new Error('Ingen features returneret');

  // 3. Udtræk
  console.log('\nUdtrækker punkter…');
  const points = extractPoints(features);

  // 4. Komprimér
  const output = compress(points);
  const json   = JSON.stringify(output);
  const sizeKB = (json.length / 1024).toFixed(0);
  console.log(`\nOutputstørrelse: ${sizeKB} KB (ukomprimeret)`);

  // 5. Sammenlign med eksisterende fil
  if (fs.existsSync(OUT_FILE)) {
    const existing = fs.readFileSync(OUT_FILE, 'utf8');
    const old      = JSON.parse(existing);
    const oldCount = old?.d?.length ?? 0;
    const newCount = output.d.length;
    const delta    = newCount - oldCount;
    console.log(`Ændring: ${oldCount.toLocaleString('da')} → ${newCount.toLocaleString('da')} udløb (${delta >= 0 ? '+' : ''}${delta})`);
    if (Math.abs(delta) > oldCount * 0.1) {
      console.warn(`Advarsel: > 10% ændring i antal udløb — tjek manuelt inden deploy`);
    }
  }

  // 6. Skriv eller dry-run
  if (DRY_RUN) {
    console.log('\n--dry-run: ingen filer skrevet.');
    console.log(`Ville have skrevet til: ${OUT_FILE}`);
  } else {
    // Backup af eksisterende
    if (fs.existsSync(OUT_FILE)) {
      const backup = OUT_FILE.replace('.json', `.bak-${Date.now()}.json`);
      fs.copyFileSync(OUT_FILE, backup);
      console.log(`\nBackup: ${path.basename(backup)}`);
    }
    fs.writeFileSync(OUT_FILE, json, 'utf8');
    console.log(`Skrevet: ${OUT_FILE}`);
    console.log('\nKlar til deploy. Kør: fly deploy');
  }
}

main().catch(err => {
  console.error('\nFEJL:', err.message);
  process.exit(1);
});
