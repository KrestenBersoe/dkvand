#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// build-badevand-analyseresultater.js — kør fra repo-roden:
//   node scripts/build-badevand-analyseresultater.js --csv /sti/til/udpakket.csv
//   node scripts/build-badevand-analyseresultater.js --zip /sti/til/puls_vBadevandsstationResultater_csv.zip
//   node scripts/build-badevand-analyseresultater.js
//     (uden --csv/--zip: leder selv i repo-roden efter en .csv eller .zip
//      hvis filnavn indeholder "puls" og "badevand" — bekvemt når filen bare
//      er droppet i repo-mappen)
//   node scripts/build-badevand-analyseresultater.js --zip ... --inspect-csv     (skema-tjek, ingen skrivning)
//   node scripts/build-badevand-analyseresultater.js --zip ... --dry-run
//   node scripts/build-badevand-analyseresultater.js --zip ... --limit 100000    (hurtig lokal test)
//
// KØRES IKKE VED RUNTIME — dette er et offline forbehandlingsscript, samme
// mønster som id15-lake-matches.json/id15-kystvand-matches.json/
// vandlob-directions.json (se scripts/id15/). Output er én let, statisk
// JSON-fil, som appen henter ved indlæsning — al tung databehandling (2,1 GB
// CSV) sker her, aldrig i den kørende Fly.io-proces.
//
// ── Datakilder ────────────────────────────────────────────────────────────
// 1. CSV-eksport fra PULS "Badevand: Analyse- og Måleresultater"
//    (semikolon-separeret, ca. 2,1 GB ukomprimeret, leveres som
//    puls_vBadevandsstationResultater_csv.zip). For stor til at indlæse i
//    hukommelsen — streames (fs.createReadStream, eller `unzip -p` som
//    barneproces, hvis --zip bruges direkte) gennem en citat-bevidst
//    række-parser (streamCsvRows nedenfor), IKKE linje for linje: bekræftet
//    mod den faktiske fil at fritekstfelter (fx Remarks) kan indeholde
//    ægte linjeskift inde i et citeret felt, hvilket en simpel
//    linje-splitning ville brække midt i én logisk række. Relevante felter
//    (opslået via header, ikke fast kolonneposition — mere robust mod at
//    myndigheden omarrangerer kolonner): BathingwaterStationId,
//    BathingwaterStationName, SamplingStarted, Status, Parameter, Value,
//    Unit — samt Attribute ("<"/">" for censurerede laboratorieresultater,
//    se attrCol nedenfor).
//
// 2. WFS-lag fra pulsgeo.miljoeportal.dk (puls:Kontrol + puls:Badevand).
//    Skemaet er VERIFICERET direkte mod den levende tjeneste (GetFeature +
//    DescribeFeatureType), IKKE gættet:
//      BathingwaterStationId (string), Name (string), Responsible (string,
//      kommune), LatestClassification (string, nullable), LatestSample
//      (string, "DD.MM.YYYY" — bekræftet ved stikprøve, IKKE ISO),
//      ProfileUrl (string, nullable), Closed (xsd:dateTime, nullable — null
//      = stadig åben, ellers nedlæggelsestidspunkt som ISO-streng, IKKE en
//      boolean eller fritekst som PULS' regnbetingede-udløbslag). Begge lag
//      har PRÆCIS samme skema (bekræftet ved sammenligning); puls:Badevand
//      har derudover Dkbw (EU-badevands-ID, tal). puls:Kontrol har 632
//      features, puls:Badevand 1.488 (begge tal bekræftet direkte mod
//      tjenesten i denne opgaves research) — færre end CSV'ens ca. 2.076
//      unikke BathingwaterStationId, så en del CSV-stationer findes i INGEN
//      af de to lag (historiske/nedlagte, aldrig registreret i den
//      nuværende stamdata). Disse markeres eksplicit som status "udgaaet"
//      nedenfor — de springes ALDRIG stille over.
//
// ── Output ────────────────────────────────────────────────────────────────
// badevand-analyseresultater.json — { [BathingwaterStationId]: {...} },
// se main()'s output-opbygning nedenfor for feltlisten. Kompakt (ingen
// indrykning) — filen er tænkt fetchet direkte af klienten, samme mønster
// som id15-lake-matches.json. Inkluderer et server/build-beregnet "farve"-
// felt (groen/gul/roed, se computeFarve()) — frontend'en skal UDELUKKENDE
// rendere denne værdi, aldrig selv genberegne grøn/gul/rød ud fra de rå
// ecoli/enterokokker-tal (samme server-autoritative princip som resten af
// risikomodellen, se badevand-risk.js).
//
// ── EKSPLICIT UDE AF SCOPE ────────────────────────────────────────────────
// Ingen sammenkobling til nedbørsmodellen og ingen påstand om at historiske
// grænseværdi-overskridelser forudsiger fremtidig risiko ved regn — det er
// en separat, endnu ikke valideret hypotese. Dette script beregner
// UDELUKKENDE historiske analyseresultater, rent beskrivende.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { spawn } = require('child_process');

// ── Grænseværdier ─────────────────────────────────────────────────────────
// IKKE et lovfæstet enkeltprøve-krav — EU-badevandsdirektivet vurderer på
// sæson-percentiler, ikke enkeltprøver. De to tal her er udbredt KOMMUNAL
// PRAKSIS for hvornår én enkelt prøve udløser en midlertidig advarsel/
// badeforbud, og bruges her udelukkende til at klassificere historiske
// enkeltprøver som "under" / "over" til visning — ikke en juridisk vurdering.
// Overstyrbar via --ecoli-threshold/--entero-threshold, for det tilfælde en
// kommune bruger andre lokale grænser.
const ECOLI_THRESHOLD_PER_100ML       = 500;
const ENTEROKOKKER_THRESHOLD_PER_100ML = 200;

// NYT: bekræftet mod den faktiske fil (kørsel 2026-07-30) — mindst én række
// har en SamplingStarted-dato i fremtiden ("08.07.2029", station
// "Stubberup Havn", DKBW55) — en tastefejl i kildens årstal, ikke et
// scriptproblem. Uden en øvre grænse ville en sådan række kunne vinde
// "seneste"-sammenligningen og fortrænge en reelt nyere, korrekt dateret
// prøve. RUN_TS_MS fastfryses ÉN gang ved scriptets start (ikke Date.now()
// genkaldt pr. række) — se brugen i main()'s rækkeløkke.
const RUN_TS_MS = Date.now();

// Grænsen er et MAKSIMALT acceptabelt tal: en værdi PRÆCIS på grænsen tæller
// som "over" (ikke "under") — "under grænseværdien" fortolkes derfor strengt
// (<), mens "over" fortolkes som "grænseværdien nået eller overskredet" (>=).
// De to klassifikationer er dermed udtømmende og gensidigt udelukkende for
// en given enkeltparameter-værdi; se classifySample() nedenfor.

// Parameternavne som de forventes at stå i CSV'ens Parameter-kolonne.
// Case-insensitiv/trimmet sammenligning (se matchesParameter()) — men navnet
// der reelt bruges i outputtet er disse konstanter, ikke kildens rå streng.
const PARAMETER_ECOLI       = 'Escherichia coli';
const PARAMETER_ENTEROKOKKER = 'Intestinal enterokokker';

// ── Repo-rod ──────────────────────────────────────────────────────────────
// Samme mønster som scripts/id15/build-id15-kystvand-matches.js — scriptet
// kan ligge i scripts/, ikke nødvendigvis repo-roden.
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'puls-data.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Kunne ikke finde puls-data.json i ${startDir} eller nogen overliggende mappe — kør scriptet fra eller under repo-roden.`);
}
const STATIC_DIR = findRepoRoot(__dirname);

// ── CLI-argumenter ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argVal(flag, fallback = null) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}
// Auto-detect: hvis hverken --csv eller --zip er angivet, led i repo-roden
// efter en udpakket/zippet PULS-eksport i stedet for at kræve en eksplicit
// sti hver gang — bekvemt når filen bare er droppet i repo-mappen. Kun
// filnavne der reelt ligner PULS-eksporten (matcher "badevand" og
// "resultat", case-insensitivt) tælles med, så vilkårlige andre .csv/.zip-
// filer i roden (fx test-fixtures) ikke fejlagtigt vælges. Kræver IKKE
// "puls" i navnet — det unzippede PULS-udtræk hedder typisk bare
// "vBadevandsstationResultater.csv", uden "puls"-præfiks (kun selve
// zip-filen fra PULS er navngivet med det).
function findLocalExport(dir, ext) {
  const rx = /badevand.*resultat|resultat.*badevand/i;
  const matches = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(ext) && rx.test(f));
  return matches.map(f => path.join(dir, f));
}
function autoDetectExport() {
  const csvMatches = findLocalExport(STATIC_DIR, '.csv');
  if (csvMatches.length === 1) return { csv: csvMatches[0] };
  if (csvMatches.length > 1) {
    console.error(`Flere kandidat-CSV'er fundet i ${STATIC_DIR} — angiv den rigtige med --csv:\n  ${csvMatches.join('\n  ')}`);
    process.exit(1);
  }
  const zipMatches = findLocalExport(STATIC_DIR, '.zip');
  if (zipMatches.length === 1) return { zip: zipMatches[0] };
  if (zipMatches.length > 1) {
    console.error(`Flere kandidat-zip'er fundet i ${STATIC_DIR} — angiv den rigtige med --zip:\n  ${zipMatches.join('\n  ')}`);
    process.exit(1);
  }
  return null;
}
const explicitCsv = argVal('--csv');
const explicitZip = argVal('--zip');
const autoDetected = (!explicitCsv && !explicitZip) ? autoDetectExport() : null;
const CSV_PATH        = explicitCsv || autoDetected?.csv || null;
const ZIP_PATH        = explicitZip || autoDetected?.zip || null;
if (autoDetected) console.log(`Ingen --csv/--zip angivet — bruger fundet fil: ${autoDetected.csv || autoDetected.zip}`);
const ZIP_ENTRY       = argVal('--zip-entry');
const OUT_FILE        = path.resolve(argVal('--out', path.join(STATIC_DIR, 'badevand-analyseresultater.json')));
// Fuld prøvehistorik (ikke kun seneste-pr-station som OUT_FILE ovenfor) —
// samplesByStation nedenfor har den allerede i hukommelsen (parsingen
// smider intet væk, kun output-opbygningen reducerer til "seneste"), så
// dette koster ingen ekstra CSV-gennemløb. Rå ingrediens til
// scripts/validate-predictions.js, samme mønster som frwater's
// bathing-water-samples.json (se dens pipeline-fils egen kommentar).
const OUT_SAMPLES_FILE = path.resolve(argVal('--out-samples', path.join(STATIC_DIR, 'badevand-proeve-historik.json')));
const ENCODING        = argVal('--encoding', 'utf8');
const DELIMITER       = argVal('--delimiter', ';');
const LIMIT           = argVal('--limit') ? parseInt(argVal('--limit'), 10) : null;  // KUN til hurtig lokal test
const PROGRESS_EVERY  = argVal('--progress-every') ? parseInt(argVal('--progress-every'), 10) : 250000;
const INSPECT_CSV     = argv.includes('--inspect-csv');
const DRY_RUN         = argv.includes('--dry-run');
const ECOLI_THRESHOLD    = argVal('--ecoli-threshold') ? parseFloat(argVal('--ecoli-threshold')) : ECOLI_THRESHOLD_PER_100ML;
const ENTERO_THRESHOLD   = argVal('--entero-threshold') ? parseFloat(argVal('--entero-threshold')) : ENTEROKOKKER_THRESHOLD_PER_100ML;

if (!CSV_PATH && !ZIP_PATH) {
  console.error(`Angiv enten --csv <udpakket .csv-fil> eller --zip <puls_vBadevandsstationResultater_csv.zip>, eller læg filen direkte i ${STATIC_DIR} (filnavnet skal indeholde "badevand" og "resultat").`);
  process.exit(1);
}

// ── WFS: HTTP-hjælpefunktion (samme mønster som update-puls.js) ──────────
function fetchUrl(rawUrl, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, { headers: { Accept: 'application/json' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
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

const WFS_BASE  = 'https://pulsgeo.miljoeportal.dk/geoserver/wfs';
const PAGE_SIZE = 2000;

function buildWfsUrl(typename, startIndex) {
  return `${WFS_BASE}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeNames=${encodeURIComponent(typename)}` +
    `&outputFormat=application%2Fjson&srsName=EPSG%3A4326` +
    `&count=${PAGE_SIZE}&startIndex=${startIndex}`;
}

async function fetchAllFeatures(typename) {
  const features = [];
  let start = 0, total = null;
  process.stdout.write(`  Henter ${typename}:`);
  while (true) {
    const wfsUrl = buildWfsUrl(typename, start);
    let body;
    try {
      body = await fetchUrl(wfsUrl, 60000);
    } catch (e) {
      throw new Error(`WFS-fejl ved ${typename} (start=${start}): ${e.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`JSON-parse fejl ved ${typename} (start=${start}): ${body.slice(0, 200)}`);
    }
    if (parsed.exceptions || parsed.ExceptionReport) {
      throw new Error(`WFS Exception (${typename}): ${JSON.stringify(parsed).slice(0, 300)}`);
    }
    const batch = parsed.features || [];
    if (total === null) total = parsed.totalFeatures ?? parsed.numberMatched ?? '?';
    features.push(...batch);
    process.stdout.write(` ${features.length}/${total}`);
    if (batch.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }
  console.log(' ✓');
  return features;
}

// ── WFS: stamdata-udtræk (skema verificeret — se filhoved) ───────────────
function extractStamdata(feature, kilde) {
  const p = feature.properties || {};
  let lat = null, lng = null;
  const geom = feature.geometry;
  if (geom && geom.type === 'Point' && Array.isArray(geom.coordinates)) {
    lng = geom.coordinates[0];
    lat = geom.coordinates[1];
  }
  return {
    navn:                  p.Name || null,
    kommune:               p.Responsible || null,
    senesteKlassifikation: p.LatestClassification || null,
    senesteProeveWfs:      p.LatestSample || null,   // "DD.MM.YYYY" — se filhoved
    profilUrl:             p.ProfileUrl || null,
    lukket:                p.Closed || null,          // ISO-dato eller null (åben)
    dkbw:                  p.Dkbw != null ? p.Dkbw : null,
    lat, lng,
    kilde,
  };
}

async function loadStamdata() {
  console.log('Henter stamdata fra WFS (puls:Kontrol + puls:Badevand)…');
  const [kontrolFeatures, badevandFeatures] = await Promise.all([
    fetchAllFeatures('puls:Kontrol'),
    fetchAllFeatures('puls:Badevand'),
  ]);

  const byId = new Map();
  for (const f of kontrolFeatures) {
    const id = f.properties?.BathingwaterStationId;
    if (!id) continue;
    byId.set(id, extractStamdata(f, 'kontrol'));
  }
  // Fallback: kun de stationer, der IKKE allerede fandtes i puls:Kontrol.
  let fallbackCount = 0;
  for (const f of badevandFeatures) {
    const id = f.properties?.BathingwaterStationId;
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, extractStamdata(f, 'badevand'));
      fallbackCount++;
    }
  }
  console.log(`Stamdata: ${kontrolFeatures.length} fra puls:Kontrol, ${fallbackCount} yderligere fra puls:Badevand (fallback), ${byId.size} unikke stationer i alt.\n`);
  return byId;
}

// ── CSV: citat-bevidst række-parser (streamer direkte over rå tekst-chunks,
// IKKE linje for linje) ───────────────────────────────────────────────────
// RETTET: en tidligere udgave splittede først i linjer (readline), og
// parsede kun quotes INDEN for hver linje for sig. Bekræftet direkte mod den
// faktiske 2,1 GB-fil (ikke en antagelse): "Remarks"-feltet kan indeholde et
// ægte linjeskift INDE I et citeret felt (fx en flerlinjet lab-kommentar som
// "...rettet.\nDenne rapport erstatter version 1."). Linje-for-linje-
// tilgangen splittede så ÉN logisk CSV-række i to fysiske linjer — begge
// blev kasseret som "forkert antal felter", og en ægte E. coli/enterokok-
// måling gik tabt UDEN at det var synligt som andet end en lille stigning i
// malformedRowCount. Denne udgave scanner tegn for tegn hen over selve
// stream-chunks'ene og behandler kun \n som rækkeafslutning, når vi IKKE er
// inde i et citeret felt — linjeskift inde i quotes bliver en almindelig del
// af feltets tekst, præcis som RFC4180 foreskriver.
async function* streamCsvRows(input, delimiter) {
  let fields = [];
  let cur = '';
  let inQuotes = false;
  let firstChunk = true;

  function flushField() { fields.push(cur); cur = ''; }

  for await (let chunk of input) {
    // RETTET: en BOM FØR selve rækkens første anførselstegn forhindrede
    // quote-detektionen ("ch==='\"' && cur===''") i nogensinde at slå til
    // for det allerførste felt — BOM'en havde allerede gjort cur ikke-tom.
    // Resultatet var at HELE feltet (inkl. begge anførselstegn som
    // bogstavelig tekst) endte forkert som "﻿\"BathingwaterStationId\"".
    // Fjernes derfor her, FØR selve tegn-for-tegn-scanningen, i stedet for
    // efterfølgende på det allerede fejlparsede felt.
    if (firstChunk) {
      firstChunk = false;
      if (chunk.charCodeAt(0) === 0xFEFF) chunk = chunk.slice(1);
    }
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (inQuotes) {
        if (ch === '"') {
          if (chunk[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"' && cur === '') {
        inQuotes = true;
      } else if (ch === delimiter) {
        flushField();
      } else if (ch === '\r') {
        // ignoreres — håndterer både \n og \r\n ensartet
      } else if (ch === '\n') {
        flushField();
        const row = fields;
        fields = [];
        yield row;
      } else {
        cur += ch;
      }
    }
  }
  // Sidste række, hvis filen ikke slutter med et linjeskift
  if (cur !== '' || fields.length > 0) {
    flushField();
    yield fields;
  }
}

// ── CSV: dato-parser ──────────────────────────────────────────────────────
// Understøtter både ISO (YYYY-MM-DD, evt. med klokkeslæt) og dansk format
// (DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY) — hvilket format SamplingStarted
// reelt bruger er ikke bekræftet (CSV'en er ikke tilgængelig i dette miljø),
// så begge understøttes. Returnerer millisekunder siden epoch (UTC), eller
// null hvis formatet slet ikke genkendes — ALDRIG et gæt, se
// unparsableDateCount/unparsableDateExamples i main().
// RETTET: bekræftet mod den faktiske fil at SamplingStarted er
// "DD.MM.YYYY HH.MM.SS" (punktum som separator i BÅDE dato- og
// klokkeslætsdelen, ikke kun datoen) — inkluderer nu klokkeslættet i
// tidsstemplet, så to prøver samme kalenderdag (men forskelligt klokkeslæt)
// sammenlignes korrekt kronologisk, i stedet for at ende uafgjort på
// dags-granularitet. ISO-varianten bevares som fallback, hvis en fremtidig
// eksport skulle skifte format.
function parseCsvDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = s.match(/^(\d{2})[.\-/](\d{2})[.\-/](\d{4})(?:[ T](\d{2})[.:](\d{2})(?:[.:](\d{2}))?)?/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return null;
}

// ── CSV: parameter-match (case-insensitiv, trimmet) ──────────────────────
function matchesParameter(raw, expected) {
  return String(raw || '').trim().toLowerCase() === expected.toLowerCase();
}

// ── CSV: værdi-parser ─────────────────────────────────────────────────────
// Semikolon som felt-separator er selve grunden til at danske/EU-eksporter
// bruger KOMMA som decimalseparator (undgår kollision med selve
// kolonneskilletegnet) — ',' konverteres derfor til '.' før parseFloat.
function parseCsvValue(raw) {
  const s = String(raw || '').trim().replace(',', '.');
  if (s === '') return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

// ── Zip-håndtering: finder CSV-entry og streamer via `unzip -p` ──────────
function listZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-Z1', zipPath]);
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => reject(new Error(`Kunne ikke køre "unzip" — er det installeret? (${e.message})`)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`unzip -Z1 fejlede (kode ${code}): ${err.trim()}`));
      resolve(out.split('\n').map(l => l.trim()).filter(Boolean));
    });
  });
}

async function resolveZipEntry(zipPath, override) {
  if (override) return override;
  const entries = await listZipEntries(zipPath);
  const csvEntries = entries.filter(e => e.toLowerCase().endsWith('.csv'));
  if (csvEntries.length === 1) return csvEntries[0];
  if (csvEntries.length === 0) {
    throw new Error(`Ingen .csv-fil fundet i ${zipPath}. Indhold:\n  ${entries.join('\n  ')}`);
  }
  throw new Error(
    `Flere .csv-kandidater i ${zipPath} — angiv den rigtige med --zip-entry:\n  ${csvEntries.join('\n  ')}`
  );
}

async function openCsvInput() {
  if (CSV_PATH) {
    if (!fs.existsSync(CSV_PATH)) throw new Error(`Fil ikke fundet: ${CSV_PATH}`);
    const stream = fs.createReadStream(CSV_PATH);
    stream.setEncoding(ENCODING);
    return stream;
  }
  if (!fs.existsSync(ZIP_PATH)) throw new Error(`Fil ikke fundet: ${ZIP_PATH}`);
  const entry = await resolveZipEntry(ZIP_PATH, ZIP_ENTRY);
  console.log(`Streamer "${entry}" fra ${ZIP_PATH} via unzip -p (ingen udpakning til disk)…`);
  const child = spawn('unzip', ['-p', ZIP_PATH, entry]);
  let stderrBuf = '';
  child.stderr.on('data', d => stderrBuf += d);
  child.on('error', e => { throw new Error(`Kunne ikke køre "unzip" — er det installeret? (${e.message})`); });
  // RETTET: unzip kan afslutte med fejlkode UDEN at stdout-streamen selv
  // rapporterer en fejl (den lukker bare for tidligt) — en stille afkortet
  // fil ville give et forkert, men umærkeligt ufuldstændigt resultat.
  // Fejlen kastes derfor eksplicit her, ikke kun logges.
  //
  // UNDTAGET når --limit er sat: her stopper main() BEVIDST med at læse
  // strømmen, før hele filen er dekomprimeret (kun til hurtig lokal test,
  // se filhoved) — unzip modtager derfor en broken pipe og bliver dræbt
  // (kode/signal ikke 0), hvilket er FORVENTET, ikke en fejl. Uden denne
  // undtagelse ville enhver --limit-baseret smoke-test fejlagtigt afslutte
  // med exitkode 1, selvom resten af scriptet kørte og printede korrekt.
  child.on('close', code => {
    if (code !== 0 && !LIMIT) {
      console.error(`\n❌ unzip afsluttede med kode ${code}: ${stderrBuf.trim()}`);
      process.exitCode = 1;
    }
  });
  child.stdout.setEncoding(ENCODING);
  return child.stdout;
}

// ── Klassifikation af én "prøve" (samme station + samme SamplingStarted) ─
// Se grænseværdi-kommentaren øverst for "under" (strengt <) vs. "over"
// (nået eller overskredet, >=) — udtømmende og gensidigt udelukkende.
function classifySample(ecoliValue, enteroValue) {
  const hasBoth = ecoliValue != null && enteroValue != null;
  const under = hasBoth && ecoliValue < ECOLI_THRESHOLD && enteroValue < ENTERO_THRESHOLD;
  const over = (ecoliValue != null && ecoliValue >= ECOLI_THRESHOLD) ||
               (enteroValue != null && enteroValue >= ENTERO_THRESHOLD);
  return { under, over };
}

// ── Stations-farve (grøn/gul/rød) — bruges af frontend'ens "Seneste
// Vandmålinger"-panel til en enkelt, samlet statusindikator ────────────────
// Modsat classifySample() ovenfor (som kræver BEGGE parametre fra SAMME
// prøve/dato) bruger denne funktion stationens SENESTE kendte værdi for
// hver parameter UAFHÆNGIGT af hinanden — de kan sagtens stamme fra
// forskellige datoer. Det er bevidst: kræves en fælles prøvedato, ville
// stationer, hvor E. coli og enterokokker sjældent måles på nøjagtig samme
// dag, næsten altid ende som "gul" (utilstrækkelig data), selvom vi reelt
// har en frisk måling af hver. "Farven" udtrykker derfor "hvad ved vi lige
// nu om denne stations tilstand", ikke "bestod den seneste enkeltprøve".
//
// Prioritering: en KENDT overskridelse er altid rød, uanset om den anden
// parameter mangler — at skjule et kendt problem bag en "utilstrækkelig
// data"-etiket, blot fordi den anden måling mangler, ville være vildledende
// i den forkerte (farligere) retning. Gul er derfor forbeholdt "intet kendt
// problem, men mangler mindst én måling for at kunne bekræfte grøn".
function computeFarve(ecoliValue, enteroValue) {
  const ecoliOver  = ecoliValue  != null && ecoliValue  >= ECOLI_THRESHOLD;
  const enteroOver = enteroValue != null && enteroValue >= ENTERO_THRESHOLD;
  if (ecoliOver || enteroOver) return 'roed';
  if (ecoliValue == null || enteroValue == null) return 'gul';
  return 'groen';
}

// ── Hoved ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('Badevand: analyseresultater — offline forbehandling');
  console.log(new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' }));
  console.log(`Grænseværdier: E. coli < ${ECOLI_THRESHOLD}, enterokokker < ${ENTERO_THRESHOLD} (pr. 100 ml, kommunal praksis — se filhoved)`);
  if (LIMIT) console.log(`--limit ${LIMIT} — KUN til lokal test, output er ufuldstændigt`);
  console.log('═══════════════════════════════════════════════\n');

  const input = await openCsvInput();

  // stationId -> Map<samplingStartedRaw, { dateMs, ecoli:{value,unit}|null, entero:{value,unit}|null }>
  const samplesByStation = new Map();
  // stationId -> BathingwaterStationName seen i CSV'en (fallback-visningsnavn for stationer, der ikke findes i noget WFS-lag)
  const csvNameByStation = new Map();

  let headerCols = null;
  let idCol, nameCol, dateCol, statusCol, paramCol, valueCol, unitCol, attrCol;

  let rowCount = 0;
  let matchedParamCount = 0;
  let malformedRowCount = 0;
  let unparsableDateCount = 0;
  const unparsableDateExamples = [];
  let futureDateCount = 0;   // se RUN_TS_MS-kommentaren øverst
  const futureDateExamples = [];
  let unparsableValueCount = 0;
  const statusHistogram = new Map();
  const unitsByParam = { [PARAMETER_ECOLI]: new Map(), [PARAMETER_ENTEROKOKKER]: new Map() };
  let censoredCount = 0;   // rækker med Attribute "<" eller ">" — se attrCol-kommentaren ovenfor

  const t0 = Date.now();

  for await (const fields of streamCsvRows(input, DELIMITER)) {
    if (headerCols === null) {
      // BOM'en (bekræftet til stede i den faktiske fil, foran selve
      // headerens første anførselstegn) er allerede fjernet af
      // streamCsvRows, se dens RETTET-kommentar.
      headerCols = fields.map(h => h.trim());
      const idx = name => {
        let i = headerCols.indexOf(name);
        if (i === -1) i = headerCols.findIndex(h => h.toLowerCase() === name.toLowerCase());
        return i;
      };
      idCol     = idx('BathingwaterStationId');
      nameCol   = idx('BathingwaterStationName');
      dateCol   = idx('SamplingStarted');
      statusCol = idx('Status');
      paramCol  = idx('Parameter');
      valueCol  = idx('Value');
      unitCol   = idx('Unit');
      // NYT: bekræftet mod den faktiske fil — findes som separat kolonne,
      // ikke indlejret i selve Value. Indeholder "<" eller ">" for
      // censurerede laboratorieresultater (under/over kvantifikationsgrænsen)
      // — Value indeholder i så fald KUN grænsetallet, ikke den reelle
      // (ukendte) værdi. Valgfri kolonne (findes muligvis ikke i alle
      // eksportversioner) — påvirker IKKE selve under/over-klassificeringen
      // (uden for scope at ændre den logik), men tælles og rapporteres, så
      // omfanget af censurerede resultater er synligt, ikke skjult.
      attrCol   = idx('Attribute');
      const missing = [
        ['BathingwaterStationId', idCol], ['SamplingStarted', dateCol],
        ['Parameter', paramCol], ['Value', valueCol],
      ].filter(([, i]) => i === -1).map(([n]) => n);
      if (missing.length > 0) {
        throw new Error(`Påkrævede kolonner mangler i CSV-headeren: ${missing.join(', ')}. Fundne kolonner: ${headerCols.join(', ')}`);
      }
      if (INSPECT_CSV) {
        console.log('Header-kolonner fundet:', headerCols);
        console.log(`Indekser — id:${idCol} navn:${nameCol} dato:${dateCol} status:${statusCol} param:${paramCol} værdi:${valueCol} enhed:${unitCol} attribut:${attrCol}\n`);
      }
      continue;
    }

    rowCount++;

    if (LIMIT && rowCount > LIMIT) break;

    if (rowCount % PROGRESS_EVERY === 0) {
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ${rowCount.toLocaleString('da')} rækker læst (${secs}s), ${matchedParamCount.toLocaleString('da')} relevante…`);
    }

    // NYT: giver Node's event loop luft til I/O ind imellem, selv når mange
    // linjer i træk hverken matcher parameter-filtret eller kræver meget
    // arbejde — undgår at en lang, uafbrudt synkron kørsel gennem 2,1 GB
    // sulter event loopet (fx healthcheck-lignende ting, hvis scriptet nogen
    // sinde køres side om side med andet i samme proces).
    if (rowCount % 50000 === 0) await new Promise(res => setImmediate(res));

    if (fields.length <= Math.max(idCol, nameCol, dateCol, statusCol, paramCol, valueCol, unitCol, attrCol)) {
      malformedRowCount++;
      continue;
    }

    const paramRaw = fields[paramCol];
    const isEcoli  = matchesParameter(paramRaw, PARAMETER_ECOLI);
    const isEntero = matchesParameter(paramRaw, PARAMETER_ENTEROKOKKER);
    if (!isEcoli && !isEntero) continue;   // eneste to parametre i scope

    matchedParamCount++;

    const stationId = (fields[idCol] || '').trim();
    if (!stationId) { malformedRowCount++; continue; }

    if (nameCol !== -1 && !csvNameByStation.has(stationId)) {
      const n = (fields[nameCol] || '').trim();
      if (n) csvNameByStation.set(stationId, n);
    }

    const status = statusCol !== -1 ? (fields[statusCol] || '').trim() : '';
    statusHistogram.set(status, (statusHistogram.get(status) || 0) + 1);

    const dateRaw = fields[dateCol];
    const dateMs  = parseCsvDate(dateRaw);
    if (dateMs === null) {
      unparsableDateCount++;
      if (unparsableDateExamples.length < 5) unparsableDateExamples.push(dateRaw);
      continue;   // uden en gyldig dato kan resultatet ikke indgå i "seneste"-sammenligninger
    }
    // RETTET: se RUN_TS_MS's filhoved — en dato i fremtiden er en
    // dokumenteret kilde-tastefejl, ikke en gyldig "seneste" prøve. Uden
    // dette tjek kunne en sådan række vinde "seneste"-sammenligningen og
    // fortrænge en reelt nyere, korrekt dateret prøve i outputtet.
    if (dateMs > RUN_TS_MS) {
      futureDateCount++;
      if (futureDateExamples.length < 5) futureDateExamples.push(dateRaw);
      continue;
    }

    const value = parseCsvValue(fields[valueCol]);
    if (value === null) { unparsableValueCount++; continue; }

    const unit = unitCol !== -1 ? (fields[unitCol] || '').trim() : '';
    const paramKey = isEcoli ? PARAMETER_ECOLI : PARAMETER_ENTEROKOKKER;
    unitsByParam[paramKey].set(unit, (unitsByParam[paramKey].get(unit) || 0) + 1);

    const attribute = attrCol !== -1 ? (fields[attrCol] || '').trim() : '';
    if (attribute === '<' || attribute === '>') censoredCount++;

    let stationSamples = samplesByStation.get(stationId);
    if (!stationSamples) { stationSamples = new Map(); samplesByStation.set(stationId, stationSamples); }

    let sample = stationSamples.get(dateRaw);
    if (!sample) { sample = { dateMs, ecoli: null, entero: null }; stationSamples.set(dateRaw, sample); }

    // Sidst-vundne, hvis samme (station, SamplingStarted, parameter) skulle
    // forekomme flere gange (fx QA-genindberetning) — dokumenteret
    // forenkling, ikke en antaget umulighed.
    if (isEcoli)  sample.ecoli  = { value, unit, attribute: attribute || null };
    else          sample.entero = { value, unit, attribute: attribute || null };
  }

  if (headerCols === null) throw new Error('CSV-filen var tom (ingen header-linje fundet).');

  console.log(`\nCSV indlæst: ${rowCount.toLocaleString('da')} rækker, ${matchedParamCount.toLocaleString('da')} med E. coli/enterokokker, ${samplesByStation.size.toLocaleString('da')} stationer med mindst ét relevant resultat.`);
  if (malformedRowCount > 0) console.warn(`⚠ ${malformedRowCount.toLocaleString('da')} rækker sprunget over (for få felter / tomt stations-id).`);
  if (unparsableDateCount > 0) {
    console.warn(`⚠ ${unparsableDateCount.toLocaleString('da')} rækker med ukendt datoformat i SamplingStarted, eksempler: ${unparsableDateExamples.join(', ')}`);
  }
  if (futureDateCount > 0) {
    console.warn(`⚠ ${futureDateCount.toLocaleString('da')} rækker sprunget over pga. en SamplingStarted-dato i FREMTIDEN (kilde-tastefejl, ikke gyldige "seneste"-prøver), eksempler: ${futureDateExamples.join(', ')}`);
  }
  if (unparsableValueCount > 0) console.warn(`⚠ ${unparsableValueCount.toLocaleString('da')} rækker med ikke-numerisk Value sprunget over.`);
  if (attrCol === -1) {
    console.log('(Ingen "Attribute"-kolonne fundet — censurerede "<"/">"-resultater kan ikke skelnes fra eksakte værdier i denne eksport.)');
  } else if (censoredCount > 0) {
    console.warn(`⚠ ${censoredCount.toLocaleString('da')} rækker er censurerede laboratorieresultater (Attribute "<" eller ">") — Value er da en GRÆNSE, ikke den reelle værdi. Klassificeringen under/over bruger tallet som angivet; se "attribute" i outputtets ecoli/enterokokker-felter for at vise "< 10" korrekt i UI'en i stedet for et bart tal.`);
  }

  for (const [param, units] of Object.entries(unitsByParam)) {
    if (units.size > 1) {
      console.warn(`⚠ "${param}" optræder med FLERE forskellige enheder — tjek at grænseværdien (pr. 100 ml) reelt gælder for alle:`);
      for (const [u, n] of units) console.warn(`    "${u}": ${n.toLocaleString('da')} rækker`);
    }
  }
  console.log('\nStatus-værdier set i data (ingen filtrering foretaget herpå — betydningen af feltet er ikke dokumenteret, gennemse selv):');
  [...statusHistogram.entries()].sort((a, b) => b[1] - a[1]).forEach(([s, n]) => {
    console.log(`  "${s || '(tom)'}": ${n.toLocaleString('da')}`);
  });

  if (INSPECT_CSV) {
    console.log('\n--inspect-csv: afslutter uden at hente WFS-stamdata eller skrive output.');
    return;
  }

  // ── Stamdata ──────────────────────────────────────────────────────────
  const stamdataByStation = await loadStamdata();

  // ── Sammenfat pr. station ─────────────────────────────────────────────
  let activeCount = 0, closedCount = 0, orphanCount = 0;
  const output = {};

  for (const [stationId, samples] of samplesByStation) {
    let latestEcoli = null, latestEntero = null, latestUnder = null, latestOver = null;

    for (const [dateRaw, s] of samples) {
      if (s.ecoli && (!latestEcoli || s.dateMs > latestEcoli.dateMs)) {
        latestEcoli = { dateMs: s.dateMs, dato: dateRaw, vaerdi: s.ecoli.value, enhed: s.ecoli.unit, attribut: s.ecoli.attribute };
      }
      if (s.entero && (!latestEntero || s.dateMs > latestEntero.dateMs)) {
        latestEntero = { dateMs: s.dateMs, dato: dateRaw, vaerdi: s.entero.value, enhed: s.entero.unit, attribut: s.entero.attribute };
      }
      const { under, over } = classifySample(s.ecoli?.value ?? null, s.entero?.value ?? null);
      if (under && (!latestUnder || s.dateMs > latestUnder.dateMs)) {
        latestUnder = {
          dateMs: s.dateMs, dato: dateRaw,
          ecoli: s.ecoli?.value ?? null, enterokokker: s.entero?.value ?? null,
        };
      }
      if (over && (!latestOver || s.dateMs > latestOver.dateMs)) {
        const aarsager = [];
        if (s.ecoli?.value != null && s.ecoli.value >= ECOLI_THRESHOLD) aarsager.push('ecoli');
        if (s.entero?.value != null && s.entero.value >= ENTERO_THRESHOLD) aarsager.push('enterokokker');
        latestOver = {
          dateMs: s.dateMs, dato: dateRaw,
          ecoli: s.ecoli?.value ?? null, enterokokker: s.entero?.value ?? null,
          aarsager,
        };
      }
    }

    const stripDateMs = o => o ? (({ dateMs, ...rest }) => rest)(o) : null;

    const stamdata = stamdataByStation.get(stationId) || null;
    let status;
    if (!stamdata) { status = 'udgaaet'; orphanCount++; }
    else if (stamdata.lukket) { status = 'lukket'; closedCount++; }
    else { status = 'aktiv'; activeCount++; }

    output[stationId] = {
      navn:    stamdata?.navn || csvNameByStation.get(stationId) || null,
      kommune: stamdata?.kommune ?? null,
      lat: stamdata?.lat ?? null,
      lng: stamdata?.lng ?? null,
      dkbw: stamdata?.dkbw ?? null,
      senesteKlassifikation: stamdata?.senesteKlassifikation ?? null,
      profilUrl: stamdata?.profilUrl ?? null,
      lukketDato: stamdata?.lukket ?? null,
      kilde: stamdata?.kilde ?? 'kun-csv',
      status,
      ecoli:        stripDateMs(latestEcoli),
      enterokokker: stripDateMs(latestEntero),
      senesteGodkendtProeve:    stripDateMs(latestUnder),
      senesteIkkeGodkendtProeve: stripDateMs(latestOver),
      // NYT: se computeFarve()'s filhoved for hvorfor dette bruger de to
      // parametres UAFHÆNGIGE seneste værdier, ikke senesteGodkendt/
      // -IkkeGodkendtProeve ovenfor (som kræver samme prøvedato for begge).
      farve: computeFarve(latestEcoli?.vaerdi ?? null, latestEntero?.vaerdi ?? null),
    };
  }

  const farveCounts = { groen: 0, gul: 0, roed: 0 };
  for (const s of Object.values(output)) farveCounts[s.farve]++;
  console.log(`\nStationer i output: ${Object.keys(output).length.toLocaleString('da')} (${activeCount} aktive, ${closedCount} lukkede, ${orphanCount} udgåede/ukendte i WFS).`);
  console.log(`Farvefordeling: ${farveCounts.groen} grøn, ${farveCounts.gul} gul, ${farveCounts.roed} rød.`);

  const json = JSON.stringify(output);
  console.log(`Outputstørrelse: ${(json.length / 1024).toFixed(0)} KB (ukomprimeret, kompakt JSON).`);

  if (DRY_RUN) {
    console.log(`\n--dry-run: ingen fil skrevet. Ville have skrevet til: ${OUT_FILE}`);
    return;
  }

  if (fs.existsSync(OUT_FILE)) {
    const backup = OUT_FILE.replace(/\.json$/, `.bak-${Date.now()}.json`);
    fs.copyFileSync(OUT_FILE, backup);
    console.log(`Backup: ${path.basename(backup)}`);
  }
  fs.writeFileSync(OUT_FILE, json, 'utf8');
  console.log(`Skrevet: ${OUT_FILE}`);
  console.log('\nHusk: tilføj en COPY-linje for badevand-analyseresultater.json i Dockerfile, hvis den ikke allerede er der, og deploy (fly deploy -a dkvand) når du er klar.');

  // Fuld prøvehistorik — se OUT_SAMPLES_FILE's egen kommentar. Ikke nødvendig
  // for den kørende app (scripts/validate-predictions.js er offline, samme
  // "ikke en del af Dockerfile'ens COPY-liste"-status som selve dette
  // build-script), så ingen deploy-huskeseddel nødvendig for den.
  const samples = [];
  for (const [stationId, byDate] of samplesByStation) {
    for (const [, sample] of byDate) {
      samples.push({
        siteId: stationId,
        dateIso: new Date(sample.dateMs).toISOString().slice(0, 10),
        ecoli: sample.ecoli?.vaerdi ?? sample.ecoli?.value ?? null,
        enterokokker: sample.entero?.vaerdi ?? sample.entero?.value ?? null,
      });
    }
  }
  samples.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  fs.writeFileSync(
    OUT_SAMPLES_FILE,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: samples.length, samples }),
    'utf8'
  );
  console.log(`Skrevet: ${OUT_SAMPLES_FILE} (${samples.length.toLocaleString('da')} prøver, fuld historik).`);
}

main().catch(err => {
  console.error('\nFEJL:', err.message);
  process.exit(1);
});
