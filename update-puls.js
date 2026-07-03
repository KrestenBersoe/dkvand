#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// update-puls.js — henter og opdaterer puls-data.json fra Miljøportalen
//
// Brug:
//   node scripts/update-puls.js              (skriver til ./puls-data.json)
//   node scripts/update-puls.js --dry-run    (printer statistik uden at skrive)
//   node scripts/update-puls.js --out /sti   (skriver til anden sti)
//
// Datakilder (begge åbne data, ingen API-nøgle):
//   Stamdata: pulsgeo.miljoeportal.dk — koordinater, navn, kommune, recipient
//   Udledning: arealdata.miljoeportal.dk — volumen (m³) og overløbshændelser/år
//
// Output: komprimeret JSON-format til dkvand-appen
//   { a: [kommuner], w: [vandområder], d: [[lat,lng,navn,aIdx,wIdx,vol,ev,q]] }
//   qualityCode: 0=reelle data, 1=verificeret nul, 2=estimeret, 3=ingen data
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── Konfiguration ─────────────────────────────────────────────────────────────
const WFS_STAMDATA  = 'https://pulsgeo.miljoeportal.dk/geoserver/wfs';
const WFS_UDLEDNING = 'https://arealdata.miljoeportal.dk/geoserver/ows';

const TYPENAME_STAMDATA  = 'puls:rbu_punkt';         // koordinater + stamoplysninger
const TYPENAME_UDLEDNING = 'puls:rbu_udledning';     // volumen + hændelsesantal

const PAGE_SIZE = 2000;   // antal features pr. WFS-kald
const OUT_FILE  = path.resolve(process.argv.find(a => a === '--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(__dirname, '..', 'puls-data.json'));
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

    const req = lib.get(rawUrl, { headers: { 'Accept': 'application/json' } }, res => {
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

function buildWfsUrl(base, typename, startIndex = 0) {
  return `${base}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeNames=${encodeURIComponent(typename)}` +
    `&outputFormat=application%2Fjson` +
    `&srsName=EPSG%3A4326` +
    `&count=${PAGE_SIZE}&startIndex=${startIndex}`;
}

// ── WFS pagineret hentning ────────────────────────────────────────────────────
async function fetchAllFeatures(baseUrl, typename) {
  const features = [];
  let   start    = 0;
  let   total    = null;

  process.stdout.write(`  Henter ${typename}:`);

  while (true) {
    const wfsUrl = buildWfsUrl(baseUrl, typename, start);
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
  ]);

  return { a: auths, w: areas, d: rows };
}

// ── Sammenfletning af stamdata + udledning ────────────────────────────────────
function merge(stamdataFeatures, udledningFeatures) {
  // Byg opslag: udløbsnavn (lowercase) → { volumeM3, eventsYear }
  const udMap = new Map();
  for (const f of udledningFeatures) {
    const p   = f.properties || {};
    // Forsøg kendte feltnavn-varianter
    const key = (p.navn || p.name || p.NAVN || p.NAME || '').toLowerCase().trim();
    if (!key) continue;
    const vol = parseFloat(p.total_afledt_vandmaengde ?? p.volumen_m3 ?? p.VOLUMEN_M3 ?? p.volume_m3 ?? 0) || 0;
    const ev  = parseFloat(p.antal_overloeb ?? p.overloeb_antal ?? p.events ?? p.ANTAL_OVERLOEB ?? NaN);
    const existing = udMap.get(key);
    // Behold posten med højest volumen (data kan forekomme per år)
    if (!existing || vol > (existing.volumeM3 || 0)) {
      udMap.set(key, { volumeM3: vol || null, eventsYear: isNaN(ev) ? null : ev });
    }
  }

  const points = [];
  let q0 = 0, q1 = 0, q2 = 0, q3 = 0;

  for (const f of stamdataFeatures) {
    const p     = f.properties || {};
    const coords = getCoords(f);
    if (!coords) continue;

    const name   = (p.navn || p.name || p.NAVN || p.NAME || '').trim();
    const muni   = (p.kommune || p.municipality || p.KOMMUNE || '').trim();
    const water  = (p.vandloebsnavn || p.recipient || p.RECIPIENT || p.vandområde || p.waterarea || '').trim();

    const key    = name.toLowerCase();
    const ud     = udMap.get(key) || null;
    const vol    = ud?.volumeM3   ?? null;
    const ev     = ud?.eventsYear ?? null;

    let quality, evFinal;

    if (ev !== null && ev > 0) {
      quality = 0; evFinal = ev; q0++;                        // reelle data
    } else if (ev === 0 || (vol !== null && vol === 0)) {
      quality = 1; evFinal = 0; q1++;                         // verificeret nul
    } else if (vol !== null && vol > 0) {
      quality = 2; evFinal = imputeEvents(vol); q2++;          // estimeret fra volumen
    } else {
      quality = 3; evFinal = null; q3++;                       // ingen data
    }

    points.push({
      lat: coords.lat, lng: coords.lng,
      name:         name || `Udløb ${points.length}`,
      municipality: muni,
      waterArea:    water,
      volumeM3:     vol,
      eventsYear:   evFinal,
      quality,
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
    const body = await fetch(capUrl, { timeout: 15000 });
    const found = body.includes(typename.split(':').pop());
    if (!found) {
      console.warn(`  Advarsel: "${typename}" ikke fundet i GetCapabilities — fortsætter alligevel`);
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

  // 1. Verificer endpoints
  console.log('Verificerer WFS-endpoints…');
  await verifyEndpoint(WFS_STAMDATA,  TYPENAME_STAMDATA);
  await verifyEndpoint(WFS_UDLEDNING, TYPENAME_UDLEDNING);

  // 2. Hent stamdata
  console.log('\nHenter stamdata…');
  const stamdata = await fetchAllFeatures(WFS_STAMDATA, TYPENAME_STAMDATA);
  if (stamdata.length === 0) throw new Error('Ingen stamdata-features returneret');

  // 3. Hent udledningsdata
  console.log('Henter udledningsdata…');
  const udledning = await fetchAllFeatures(WFS_UDLEDNING, TYPENAME_UDLEDNING);
  console.log(`  ${udledning.length.toLocaleString('da')} udledningsposter hentet`);

  // 4. Udtræk og sammenflet
  console.log('\nSammenfletning…');
  const points = merge(stamdata, udledning);

  // 5. Komprimér
  const output = compress(points);
  const json   = JSON.stringify(output);
  const sizeKB = (json.length / 1024).toFixed(0);
  console.log(`\nOutputstørrelse: ${sizeKB} KB (ukomprimeret)`);

  // 6. Sammenlign med eksisterende fil
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

  // 7. Skriv eller dry-run
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
