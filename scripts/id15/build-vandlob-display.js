#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// build-vandlob-display.js
// ═══════════════════════════════════════════════════════════════════════════
//
// NAIV, DIREKTE LØSNING — erstatter det tidligere forsøg med Douglas-
// Peucker-forenkling (tolerance-tuning, uventet stigende filstørrelse pga.
// flydende-komma-støj fra frem-og-tilbage-projektion — opgivet efter
// gentagne, utilfredsstillende forsøg). I stedet: FLYT HELE OPGAVEN til
// serveren, i stedet for at finjustere klientens arbejde.
//
// Server-siden gør her, ÉN GANG, alt det klienten tidligere gjorde ved
// HVER sidevisning i buildVandlobDirectionLayer():
//   - beregner bæring (bearingDegrees, identisk formel som klienten)
//   - vælger farve efter sikker/usikker retning
//   - afrunder koordinater til 5 decimaler (~1,1 m — REN præcisions-
//     beskæring, ingen formforandrende algoritme, intet tolerance-valg)
//
// Klienten fetcher output-filen og TEGNER den direkte — ingen beregning,
// intet opslag i vandlobDirections, ingen bearingDegrees()-kald tilbage.
//
// Brug:
//   node build-vandlob-display.js
//
// Forudsætninger: vp3_vandlob.geojson, vandlob-directions.json
// Output: vandlob-display.json —
//   [{ coords: [[lat,lng],...], bearing: number|null, confident: boolean|null }, ...]
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const paths = {
  vandlobGeojson:     path.join(DIR, '..', '..', 'vp3_vandlob.geojson'),
  vandlobDirections:  path.join(DIR, 'vandlob-directions.json'),
  output:             path.join(DIR, '..', '..', 'vandlob-display.json'),
};

const ROUND_DECIMALS = 5; // ~1,1 m ved danske breddegrader — ren præcisionsbeskæring, ingen formændring

// Identisk formel med bearingDegrees() i dansk-overloeb-kort.html.
function bearingDegrees(latA, lngA, latB, lngB) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const y = Math.sin(toRad(lngB - lngA)) * Math.cos(toRad(latB));
  const x = Math.cos(toRad(latA)) * Math.sin(toRad(latB)) -
            Math.sin(toRad(latA)) * Math.cos(toRad(latB)) * Math.cos(toRad(lngB - lngA));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function round(n) {
  const f = 10 ** ROUND_DECIMALS;
  return Math.round(n * f) / f;
}

function main() {
  console.log('Indlæser data...');
  for (const [name, p] of Object.entries(paths)) {
    if (name === 'output') continue;
    if (!fs.existsSync(p)) {
      console.error(`❌ Mangler ${p}`);
      process.exit(1);
    }
  }

  const vandlobGeojson = JSON.parse(fs.readFileSync(paths.vandlobGeojson, 'utf8'));
  const directions = JSON.parse(fs.readFileSync(paths.vandlobDirections, 'utf8'));
  const dirByIndex = {};
  for (const d of directions) dirByIndex[d.index] = d;

  const features = vandlobGeojson.features || [];
  console.log(`${features.length} vandløbslinjer indlæst.`);

  const result = [];
  let withBearing = 0;

  features.forEach((feat, index) => {
    const geom = feat.geometry;
    if (!geom) return;

    let coords;
    if (geom.type === 'LineString') coords = geom.coordinates;
    else if (geom.type === 'MultiLineString') coords = geom.coordinates.flat();
    else return;
    if (!coords || coords.length < 2) return;

    const [lngA, latA] = coords[0];
    const [lngB, latB] = coords[coords.length - 1];
    const midIdx = Math.floor(coords.length / 2);
    const [midLng, midLat] = coords[midIdx];

    // NYT: afrundede lat/lng-par til selve tegningen — samme koordinater
    // som originalen viser, blot uden overflødig præcision ud over
    // ~1,1 m. Byttet til [lat,lng]-rækkefølge her (Leaflet-konvention),
    // så klienten kan bruge dem direkte uden selv at bytte om.
    const drawCoords = coords.map(([lng, lat]) => [round(lat), round(lng)]);

    const dirEntry = dirByIndex[index];
    let bearing = null, confident = null;
    if (dirEntry && dirEntry.direction) {
      bearing = dirEntry.direction === 'AtilB'
        ? bearingDegrees(latA, lngA, latB, lngB)
        : bearingDegrees(latB, lngB, latA, lngA);
      bearing = Math.round(bearing * 10) / 10; // 0,1° er rigeligt for en pil
      confident = dirEntry.confidence === 'sikker';
      withBearing++;
    }

    result.push({
      index,  // NYT: oprindeligt filindeks, EKSPLICIT gemt — array-positionen i result[] kan IKKE antages at matche, da linjer uden gyldig geometri springes over ovenfor, hvilket ellers ville forskyde alle efterfølgende positioner
      coords: drawCoords,
      mid: [round(midLat), round(midLng)],
      bearing, confident,
    });
  });

  fs.writeFileSync(paths.output, JSON.stringify(result));
  const sizeMB = fs.statSync(paths.output).size / 1_000_000;

  console.log(`\n${result.length} linjer skrevet, ${withBearing} med kendt retning/bæring.`);
  console.log(`Filstørrelse: ${sizeMB.toFixed(2)} MB`);
  console.log(`Skrevet: ${paths.output}`);
  console.log(`\nIngen simplificerings-tolerance, ingen reprojektion — kun ren decimalbeskæring og`);
  console.log(`server-side prækomputering af det, klienten før beregnede selv ved hver sidevisning.`);
}

main();
