// ═══════════════════════════════════════════════════════════════════════════
// badested-override-logic.js — Kommunepakke, modul 6: rene funktioner for
// kommune-overstyring af et badesteds offentlige status
// ═══════════════════════════════════════════════════════════════════════════
//
// Bevidst UDEN afhængighed af db.js/Postgres — rene, deterministiske
// funktioner, direkte unit-testbare uden en levende database (se
// badested-override-logic.test.js), samme princip som tenant-session.js i
// modul 1. badested-overrides.js (skema + DB-CRUD) requirer og re-
// eksporterer denne fil, så server.js fortsat kun behøver ét require.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const OVERRIDE_BUCKETS = ['groen', 'gul', 'roed', 'lukket'];
function isValidBucket(v) {
  return OVERRIDE_BUCKETS.includes(v);
}

// Syntetiske bact/viral-værdier, der PÅLIDELIGT producerer den ønskede
// bucket gennem EKSISTERENDE, uændrede tærskel-logik (≥0,6 rød, ≥0,2 gul,
// ellers grøn — se seo-pages.js's riskInfo()). 'lukket' bruger SAMME høje
// værdi som 'roed' (skal vises som høj-alarm/rød farve på selve kortet),
// men banner-TEKSTEN skelner klart mellem "Lukket" og "Høj risiko" (se
// klientens/SSR'ens bucket-label, ikke denne fil).
const BUCKET_SYNTHETIC_RISK = { groen: 0.05, gul: 0.35, roed: 0.85, lukket: 0.85 };

// Loft — forhindrer et tastefejlsramt "9999 timer" i at binde en
// overstyring op i årevis uden nogen automatisk sikkerhedsnet. 30 dage,
// rundt tal, langt over enhver realistisk badesæson-hændelse.
const MAX_OVERRIDE_DURATION_HOURS = 30 * 24;

/**
 * @param {{revoked_at: Date|string|null, expires_at: Date|string}} row
 * @param {Date} [now]
 * @returns {boolean}
 */
function isOverrideRowActive(row, now = new Date()) {
  if (!row) return false;
  if (row.revoked_at) return false;
  return new Date(row.expires_at).getTime() > now.getTime();
}

/**
 * Patcher ÉN badevand-cascade-entry (se badevand-risk.js's badevand.push())
 * med en aktiv overstyring — REN funktion, ingen DB-adgang. Returnerer
 * `entry` UÆNDRET (samme reference) hvis `overrideRow` er null/inaktiv.
 * @param {object} entry — {id, bact, viral, algae, forecast, source, ...}
 * @param {object|null} overrideRow — {bucket, message, tenant_name, logo_url, created_at, expires_at, revoked_at} eller null
 * @param {Date} [now]
 * @returns {object}
 */
function patchBadevandEntry(entry, overrideRow, now = new Date()) {
  if (!overrideRow || !isOverrideRowActive(overrideRow, now)) return entry;
  const risk = BUCKET_SYNTHETIC_RISK[overrideRow.bucket];
  if (risk === undefined) return entry; // ukendt bucket — fail-safe, ignorér i stedet for at crashe cascaden
  return {
    ...entry,
    bact: risk,
    viral: risk,
    source: 'kommune-override',
    overrideInfo: {
      bucket: overrideRow.bucket,
      message: overrideRow.message,
      tenantName: overrideRow.tenant_name,
      logoUrl: overrideRow.logo_url || null,
      setAt: overrideRow.created_at,
      expiresAt: overrideRow.expires_at,
    },
  };
}

module.exports = {
  OVERRIDE_BUCKETS,
  isValidBucket,
  BUCKET_SYNTHETIC_RISK,
  MAX_OVERRIDE_DURATION_HOURS,
  isOverrideRowActive,
  patchBadevandEntry,
};
