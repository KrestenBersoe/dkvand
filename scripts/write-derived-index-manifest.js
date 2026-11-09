#!/usr/bin/env node
// Skriver derived-index-manifest.json: fingeraftryk af puls-data.json's
// outfallId-kolonne (række 8) i rækkefølge. Kør som SIDSTE skridt i
// update-all-data.sh, efter alle afledte filer er bygget. Se derived-index-guard.js.
'use strict';
const fs = require('fs');
const path = require('path');
const { fingerprintOutfallIds, MANIFEST_FILE } = require('../derived-index-guard');
const root = path.resolve(__dirname, '..');
const rows = JSON.parse(fs.readFileSync(path.join(root, 'puls-data.json'), 'utf8')).d;
const fp = fingerprintOutfallIds(rows.map(r => (r[8] != null && r[8] !== '') ? String(r[8]) : null));
fs.writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify({
  pulsRowCount: fp.count, pulsFingerprint: fp.sha1, builtAt: new Date().toISOString(),
}, null, 2) + '\n');
console.log(`${MANIFEST_FILE}: ${fp.count} rækker, ${fp.sha1}`);
