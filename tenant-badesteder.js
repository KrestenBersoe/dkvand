// ═══════════════════════════════════════════════════════════════════════════
// tenant-badesteder.js — Kommunepakke, modul 4: tenant → badesteder-mapping
// ═══════════════════════════════════════════════════════════════════════════
//
// Bevidst UDEN afhængighed af db.js/slug-index.js — ren funktion, direkte
// unit-testbar (se tenant-badesteder.test.js), samme princip som
// tenant-session.js/oauth-config-validation.js. Kaldestedet (server.js)
// leverer de allerede-byggede kommuneKeyToBadesteder-data (bygget ÉN gang
// ved opstart af slug-index.js's buildSlugIndex()) som parameter.
//
// Normaliseret navnematch (`tenants.name` mod badesteders `kommune`-felt,
// begge kørt gennem slug-index.js's normalizeKommuneKey()) — BEVIDST ikke
// en ny relations-tabel, se planen (Kommunepakke modul 4)'s "Bevidst uden
// for scope"-afsnit for den fulde begrundelse og den kendte, accepterede
// svaghed (et tastefejlsramt tenant-navn matcher intet).
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const { normalizeKommuneKey } = require('./slug-index');

/**
 * @param {string} tenantName — tenants.name, fritekst (fx "Odense Kommune")
 * @param {Map<string, {id:string,slug:string,navn:string,lat:number,lng:number}[]>} kommuneKeyToBadesteder — fra slug-index.js's buildSlugIndex()
 * @returns {{id:string,slug:string,navn:string,lat:number,lng:number}[]} tom liste (IKKE en fejl) hvis intet matcher
 */
function resolveTenantBadesteder(tenantName, kommuneKeyToBadesteder) {
  if (!tenantName || !kommuneKeyToBadesteder) return [];
  const key = normalizeKommuneKey(tenantName);
  if (!key) return [];
  return kommuneKeyToBadesteder.get(key) || [];
}

module.exports = { resolveTenantBadesteder };
