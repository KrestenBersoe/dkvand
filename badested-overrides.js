// ═══════════════════════════════════════════════════════════════════════════
// badested-overrides.js — Kommunepakke, modul 6: kommune-overstyring af et
// badesteds offentlige status (grøn/gul/rød/lukket)
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Dette er en BEVIDST ANDEN mekanisme end badested-observations.js's
// borgerobservationer. badested-observations.js's HÅRDE GRÆNSE ("borger-
// observationer må ALDRIG påvirke den officielle risikofarve") gælder
// FORTSAT, uændret, og UDELUKKENDE uautentificerede borger-indsendelser.
// Dette modul er en AUTENTIFICERET, tenant-scoped (kun egne badesteder,
// se tenant-badesteder.js), TYDELIGT OFFENTLIGT MÆRKET (banner med
// kommunens logo+besked, ALDRIG en usynlig talmanipulation) kommune-
// beslutning — en helt anden tillids- og gennemsigtigheds-kategori. Se
// krydsreference-kommentarerne i badested-observations.js/badevand-risk.js.
//
// ── Filopdeling (VIGTIGT) ────────────────────────────────────────────────
// De rene bucket-/patch-funktioner ligger IKKE her, men i
// badested-override-logic.js — den fil har BEVIDST ingen afhængighed af
// db.js, så den kan unit-testes uden en levende database (se
// badested-override-logic.test.js), samme mønster som tenant-session.js/
// tenant-admin.js. Denne fil requirer og re-eksporterer den, så server.js
// fortsat kun behøver ét require. Selve skemaoprettelsen herunder udfører
// et REELT, levende databasekald ved import — derfor må denne fil ALDRIG
// blive et require af badested-override-logic.test.js.
//
// ── Injektionsprincip ────────────────────────────────────────────────────
// computeBadevandRiskCascade() (badevand-risk.js) rører vi ALDRIG — cascaden
// forbliver 100% uændret. applyActiveOverrides() nedenfor patcher i stedet
// cascadens FÆRDIGE resultat (server.js's badevandRiskCache/badevandByIdCache),
// ved at erstatte bact/viral med syntetiske værdier, der producerer den
// ØNSKEDE bucket gennem den EKSISTERENDE, uændrede 0,6/0,2-tærskel-logik
// (samme tærskler som resten af appen, se seo-pages.js's riskInfo()) — intet
// forbrugende sted (klientens colorBadevandByRisk(), SSR-siderne, app-
// metrics.js's daglige historik) behøver vide, at en overstyring fandtes.
// Det ekstra `overrideInfo`-felt er PURT ADDITIVT (ingen eksisterende
// forbruger læser det i dag) — det er DÉT feltet, banner-visningen (klient +
// SSR) bruger til rent faktisk at vise overstyringen synligt for offentligheden.
//
// Kaldes TO steder (se server.js): (1) hver periodisk cyklus, FØR cachen
// tildeles — udløb/tilbagekaldelse falder dermed automatisk væk uden nogen
// oprydningsjob, samme "expires_at < now() ⇒ betragt som fraværende"-
// idiom som tenant-admin.js's trial-login; (2) synkront af selve
// oprettelses-/rydnings-ruterne, så en ændring er synlig for offentligheden
// med det samme, ikke først ved næste periodiske cyklus (~15 min) — "under
// 10 sekunder"-kravet er ellers ikke reelt.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const { query } = require('./db');
const overrideLogic = require('./badested-override-logic');
const { isValidBucket, isOverrideRowActive, patchBadevandEntry, MAX_OVERRIDE_DURATION_HOURS } = overrideLogic;

// ── Database-opsætning ──────────────────────────────────────────────────────
const ready = query(`
  CREATE TABLE IF NOT EXISTS badested_overrides (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    badested_id  TEXT NOT NULL,
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    bucket       TEXT NOT NULL,
    message      TEXT NOT NULL,
    set_by       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_overrides_badested_active ON badested_overrides(badested_id, expires_at);
`).then(() => console.info('badested-overrides: Postgres-skema klar'))
  .catch(e => { console.error('badested-overrides: skemaoprettelse fejlede —', e.message); throw e; });

/**
 * @param {{badestedId: string, tenantId: string, bucket: string, message: string, setBy: string|null, durationHours: number}} p
 * @returns {Promise<object>} den oprettede række (rå, snake_case felter)
 * @throws {Error} .code='VALIDATION' ved ugyldigt bucket/message/durationHours
 */
async function createOverride({ badestedId, tenantId, bucket, message, setBy, durationHours }) {
  if (!isValidBucket(bucket)) {
    const err = new Error(`Ugyldig status "${bucket}" — skal være én af: ${overrideLogic.OVERRIDE_BUCKETS.join(', ')}.`);
    err.code = 'VALIDATION'; throw err;
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    const err = new Error('Angiv en besked til borgerne.');
    err.code = 'VALIDATION'; throw err;
  }
  const hours = Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_OVERRIDE_DURATION_HOURS) {
    const err = new Error(`Varighed skal være mellem 0 og ${MAX_OVERRIDE_DURATION_HOURS} timer (${MAX_OVERRIDE_DURATION_HOURS / 24} dage).`);
    err.code = 'VALIDATION'; throw err;
  }

  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  const { rows } = await query(
    `INSERT INTO badested_overrides (badested_id, tenant_id, bucket, message, set_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, badested_id, tenant_id, bucket, message, set_by, created_at, expires_at, revoked_at`,
    [String(badestedId), tenantId, bucket, message.trim(), setBy || null, expiresAt]
  );
  return rows[0];
}

/**
 * Tilbagekalder DEN AKTIVE overstyring for et badested — kun for den
 * angivne tenant (ekstra forsvarslag: kaldestedet, server.js's rute, har
 * allerede tjekket ejerskab via tenant-badesteder.js, men denne WHERE-
 * betingelse forhindrer alligevel en tenant i nogensinde at kunne
 * tilbagekalde en ANDEN tenants overstyring, selv ved en fremtidig fejl i
 * det første tjek).
 * @param {{badestedId: string, tenantId: string}} p
 * @returns {Promise<boolean>} true hvis en aktiv overstyring blev fundet og ryddet
 */
async function revokeOverride({ badestedId, tenantId }) {
  const { rowCount } = await query(
    `UPDATE badested_overrides SET revoked_at = now()
     WHERE badested_id = $1 AND tenant_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [String(badestedId), tenantId]
  );
  return rowCount > 0;
}

/** @param {string} tenantId @returns {Promise<object[]>} tenantens egne AKTIVE overstyringer */
async function listActiveOverridesForTenant(tenantId) {
  const { rows } = await query(
    `SELECT badested_id, bucket, message, set_by, created_at, expires_at
     FROM badested_overrides
     WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows;
}

/**
 * Én AKTIV (ikke tilbagekaldt/udløbet) overstyring pr. badested_id, seneste
 * først — DISTINCT ON håndterer "kun seneste pr. badested" i selve SQL'en,
 * ikke i JS, da tabellen er append-only (kan i teorien have flere historiske
 * rækker for samme badested). JOIN mod tenants for logo_url/name til
 * banner-visningen — overrideRow'en alene har kun tenant_id.
 * @param {string[]} badestedIds
 * @returns {Promise<Map<string, object>>}
 */
async function getActiveOverridesForBadestedIds(badestedIds) {
  const result = new Map();
  if (!Array.isArray(badestedIds) || badestedIds.length === 0) return result;
  const { rows } = await query(
    `SELECT DISTINCT ON (o.badested_id)
       o.badested_id, o.bucket, o.message, o.set_by, o.created_at, o.expires_at, o.revoked_at,
       t.name AS tenant_name, t.logo_url
     FROM badested_overrides o
     JOIN tenants t ON t.id = o.tenant_id
     WHERE o.badested_id = ANY($1) AND o.revoked_at IS NULL AND o.expires_at > now()
     ORDER BY o.badested_id, o.created_at DESC`,
    [badestedIds.map(String)]
  );
  for (const row of rows) result.set(row.badested_id, row);
  return result;
}

/**
 * Patcher HELE cascade-resultatets badevand-array med aktive overstyringer
 * — se filhovedets "Injektionsprincip". Returnerer et NYT array (entries
 * uden en aktiv overstyring er SAMME reference som input, se
 * patchBadevandEntry()) — kaldestedet (server.js) erstatter blot sin lokale
 * variabel med returværdien.
 * @param {object[]} badevandArray
 * @returns {Promise<object[]>}
 */
async function applyActiveOverrides(badevandArray) {
  if (!Array.isArray(badevandArray) || badevandArray.length === 0) return badevandArray;
  const overrides = await getActiveOverridesForBadestedIds(badevandArray.map(b => b.id));
  if (overrides.size === 0) return badevandArray;
  return badevandArray.map(entry => patchBadevandEntry(entry, overrides.get(String(entry.id)) || null));
}

module.exports = {
  ready,
  // re-eksporteret fra badested-override-logic.js — se filhovedets "Filopdeling"
  ...overrideLogic,
  // DB-CRUD
  createOverride,
  revokeOverride,
  listActiveOverridesForTenant,
  getActiveOverridesForBadestedIds,
  applyActiveOverrides,
};
