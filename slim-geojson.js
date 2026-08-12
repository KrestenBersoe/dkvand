#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// slim-geojson.js — fjerner ubrugte properties fra et GeoJSON, så kun de
// felter appen faktisk læser bevares. Reducerer filstørrelsen markant for
// store punktdatasæt (fx RBU's 21.000+ punkter), uden at ændre selve
// geometrien.
//
// Brug:
//   node slim-geojson.js <input.geojson> <output.geojson> felt1,felt2,felt3
//
// Eksempel (RBU — matcher felterne openRbuUdlobPanel() rent faktisk bruger):
//   node slim-geojson.js vp3_rbu_raw.geojson vp3_rbu_slim.geojson pkt_navn,pkt_id,komm_navn,vandomr_id,udl_va_sta,i_program
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');

const [,, inFile, outFile, fieldsArg] = process.argv;
if (!inFile || !outFile || !fieldsArg) {
  console.error('Brug: node slim-geojson.js <input.geojson> <output.geojson> felt1,felt2,felt3');
  process.exit(1);
}
const keepFields = fieldsArg.split(',').map(f => f.trim());

const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const before = fs.statSync(inFile).size;

const slimmed = {
  type: 'FeatureCollection',
  features: data.features.map(f => {
    const slimProps = {};
    for (const key of keepFields) {
      if (f.properties && f.properties[key] !== undefined) slimProps[key] = f.properties[key];
    }
    return { type: 'Feature', geometry: f.geometry, properties: slimProps };
  }),
};

fs.writeFileSync(outFile, JSON.stringify(slimmed));
const after = fs.statSync(outFile).size;
console.log(`${inFile} → ${outFile}: ${(before/1024).toFixed(0)} KB → ${(after/1024).toFixed(0)} KB (${(100*(1-after/before)).toFixed(0)}% mindre), ${slimmed.features.length} features`);
