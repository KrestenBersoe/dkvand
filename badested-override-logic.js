// ═══════════════════════════════════════════════════════════════════════════
// badested-override-logic.js — Kommunepakke, modul 6: rene funktioner for
// "Kommunalt Varsel" — et banner kommunen kan sætte på et badesteds side
// ═══════════════════════════════════════════════════════════════════════════
//
// RETTET (bruger-ønske, efter produktionstest): oprindeligt patchede
// patchBadevandEntry() bact/viral med syntetiske værdier, så kommunens valg
// slog igennem den ALMINDELIGE farve-/tærskellogik — dvs. en reel ændring
// af badestedets OFFICIELLE status. Det er bevidst IKKE længere sådan:
// "Kommunalt Varsel" ændrer UDELUKKENDE indholdet af det banner, der vises
// for abonnenter (badestedets side + push) — bact/viral/source/algae/forecast
// er 100% urørte, uanset om en overstyring er aktiv. Se patchBadevandEntry()
// nedenfor for selve grænsen.
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
 *
 * BEVIDST rent additivt: rører ALDRIG bact/viral/source/algae/forecast —
 * kommunens "Kommunalt Varsel" er UDELUKKENDE et banner vist til
 * abonnenter (badestedets side + push), ikke en ændring af den officielle,
 * modelberegnede status. `overrideRow.bucket` bruges kun til bannerets EGEN
 * farve/label (se dansk-overloeb-kort.html's/seo-pages.js's OVERRIDE_BUCKET_META),
 * aldrig til at foregive en anden risikoprocent end den reelt beregnede.
 * @param {object} entry — {id, bact, viral, algae, forecast, source, ...}
 * @param {object|null} overrideRow — {bucket, message, tenant_name, logo_url, created_at, expires_at, revoked_at} eller null
 * @param {Date} [now]
 * @returns {object}
 */
function patchBadevandEntry(entry, overrideRow, now = new Date()) {
  if (!overrideRow || !isOverrideRowActive(overrideRow, now)) return entry;
  if (!isValidBucket(overrideRow.bucket)) return entry; // ukendt bucket — fail-safe, ignorér i stedet for at crashe cascaden
  return {
    ...entry,
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
  MAX_OVERRIDE_DURATION_HOURS,
  isOverrideRowActive,
  patchBadevandEntry,
};
