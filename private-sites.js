// ═══════════════════════════════════════════════════════════════════════════
// private-sites.js — private (bruger-oprettede) badesteder
// ═══════════════════════════════════════════════════════════════════════════
//
// PORT af ukwater/frwaters server/lib/privateSites.js — en bruger markerer et
// vilkårligt punkt, det scores gennem SAMME risikomodel som et officielt
// badested (se private-site-risk.js/badevand-risk.js's adHocPoints), og deles
// via et link/QR-kode. Samme to-tokens-design som ukwater, samme begrundelse:
//
//   - site_id ('private:' + uuid) er PERMANENT — det scoring, push-
//     abonnementer og resten af systemet nøgler af. Ændres aldrig.
//   - share_token er det, der rent faktisk ligger i det delte link/QR-koden,
//     og ER regenererbar. Var de samme værdi, kunne "regenerér linket" ikke
//     betyde noget — det ville forældreløsgøre enhver eksisterende
//     abonnent, da abonnementer nøgles på site_id. getPrivateSiteById()
//     (brugt af detalje-API'et, push-abonnerings-gaten og alle andre
//     steder, der allerede kender site_id) returnerer ALDRIG share_token —
//     rå-værdien udleveres kun ved oprettelse og regenerering, begge
//     owner-token-gatede.
//
// Ejerskab (til tilbagekald/regenerering) er et anonymt bearer-token — intet
// konto-system findes for almindelige besøgende, samme mønster som
// oauth-login.js's admin-sessioner (men UDEN nogen bruger-tilknytning her).
//
// RETTET (arkitektur-beslutning — se samtalen der førte hertil): dkvand's
// egen risikomodel (badevand-risk.js's computeBadevandRiskCascade(), en
// reel sø-/kystvand-/vandløbs-KASKADE, ikke ukwaters isotropiske afstands-
// model fra nærmeste udløb) kan IKKE scoreOneOff()'e et vilkårligt punkt
// billigt — hele udløbs-til-vandområde-opbygningen (den reelt dyre del,
// 45-57 sek., se badevand-risk-worker.js's filhoved) er nødvendig uanset om
// ét eller tusind badevandspunkter scores samme kørsel. Private badesteder
// scores derfor IKKE on-demand ved hver sidevisning, men på en periodisk
// 30-minutters cyklus (samme kadence ukwater bruger, af samme grund: et
// enkelt privat badested har meget få interesserede, intet tidskritisk
// tabes ved sjældnere genberegning) — se private-site-risk.js.
'use strict';

const crypto = require('crypto');
const { query, getClient } = require('./db');

const ready = query(`
  CREATE TABLE IF NOT EXISTS private_sites (
    site_id           TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    description       TEXT,
    lat               DOUBLE PRECISION NOT NULL,
    lng               DOUBLE PRECISION NOT NULL,
    share_token       TEXT UNIQUE NOT NULL,
    owner_token_hash  TEXT NOT NULL,
    ip_hash           TEXT NOT NULL,
    revoked_at        BIGINT,
    created_at        BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_private_sites_ip_time ON private_sites(ip_hash, created_at);
`).then(() => console.info('private-sites: Postgres-skema klar'))
  .catch(e => { console.error('private-sites: skemaoprettelse fejlede —', e.message); throw e; });

// Genbruger badested-observations.js's OBSERVATION_IP_SALT — samme
// tillidsgrænse (kun rate limiting, aldrig sikkerhedskritisk), ingen grund
// til at fragmentere den i endnu en Fly secret. Se den fils filhoved for
// engangs-opsætningen, hvis den mangler.
const IP_SALT = process.env.OBSERVATION_IP_SALT;
if (!IP_SALT) {
  throw new Error('OBSERVATION_IP_SALT mangler — sæt den som Fly secret før opstart (se badested-observations.js filhoved).');
}

function hashIp(rawIp) {
  return crypto.createHmac('sha256', IP_SALT).update(String(rawIp || 'ukendt')).digest('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

const MAX_PRIVATE_SITES_PER_IP_PER_DAY = 10;
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;

// Danmark inkl. Bornholm og Færøerne/Grønland UDELADT (helt anden CRS/
// datadækning, ude af scope) — et rundhåndet bbox om selve Kongeriget
// Danmarks europæiske del, samme rolle som ukwaters PRIVATE_SITE_BBOX.
// RETTET (bruger-rapporteret i ukwater, se samtalen): ukwaters tilsvarende
// bbox fandtes i TO kopier (server + klient) med FORSKELLIGE grænser — kun
// ÉN definition her, eksporteret, så server.js's klientvendte kopi altid
// kan holdes i sync i stedet for at risikere at divergere igen.
const DK_BBOX = { latMin: 54.4, latMax: 57.9, lngMin: 7.9, lngMax: 15.3 };

function isWithinDkBbox(lat, lng) {
  return lat >= DK_BBOX.latMin && lat <= DK_BBOX.latMax && lng >= DK_BBOX.lngMin && lng <= DK_BBOX.lngMax;
}

function rowToPublicSite(row) {
  return {
    siteId: row.site_id,
    name: row.name,
    description: row.description,
    lat: row.lat,
    lng: row.lng,
    revokedAt: row.revoked_at != null ? Number(row.revoked_at) : null,
    createdAt: Number(row.created_at),
  };
}

/**
 * Rate-begrænset via ip_hash med et Postgres advisory-transaktionslås —
 * samme mønster som badested-observations.js's insertVurderingTxn(), samme
 * begrundelse: låsen serialiserer samtidige opretter fra SAMME ip_hash
 * (et reelt kollisionsmål) uden at blokere opretter fra en ANDEN.
 * @param {{name: string, description?: string, lat: number, lng: number}} p
 * @param {string} rawIp
 * @returns {Promise<{siteId: string, shareToken: string, ownerToken: string}>}
 */
async function createPrivateSite({ name, description, lat, lng }, rawIp, now = new Date()) {
  if (!isWithinDkBbox(lat, lng)) {
    const err = new Error('Punktet ligger uden for Danmark.');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!name || !name.trim()) {
    const err = new Error('Navn mangler.');
    err.code = 'VALIDATION';
    throw err;
  }

  const nowMs = now.getTime();
  const ipHash = hashIp(rawIp);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ipHash]);

    const dayAgoMs = nowMs - 24 * 3_600_000;
    const { rows: countRows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM private_sites WHERE ip_hash = $1 AND created_at > $2',
      [ipHash, dayAgoMs]
    );
    if (countRows[0].n >= MAX_PRIVATE_SITES_PER_IP_PER_DAY) {
      const err = new Error('rate-limited-max-per-day');
      err.code = 'RATE_LIMITED';
      err.limit = MAX_PRIVATE_SITES_PER_IP_PER_DAY;
      throw err;
    }

    const siteId = `private:${crypto.randomUUID()}`;
    const shareToken = newToken();
    const ownerToken = newToken();

    await client.query(
      `INSERT INTO private_sites (site_id, name, description, lat, lng, share_token, owner_token_hash, ip_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [siteId, name.slice(0, MAX_NAME_LENGTH), (description ?? '').slice(0, MAX_DESCRIPTION_LENGTH) || null, lat, lng, shareToken, hashToken(ownerToken), ipHash, nowMs]
    );

    await client.query('COMMIT');
    return { siteId, shareToken, ownerToken };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Returnerer ALDRIG share_token/owner_token_hash — se filhovedet. */
async function getPrivateSiteById(siteId) {
  const { rows } = await query('SELECT * FROM private_sites WHERE site_id = $1', [siteId]);
  return rows[0] ? rowToPublicSite(rows[0]) : null;
}

/** Minimal — nok til at GET /p/:shareToken kan resolve til et siteId og tjekke tilbagekaldelse. */
async function getPrivateSiteByShareToken(shareToken) {
  const { rows } = await query('SELECT site_id, revoked_at FROM private_sites WHERE share_token = $1', [shareToken]);
  if (!rows[0]) return null;
  return { siteId: rows[0].site_id, revokedAt: rows[0].revoked_at != null ? Number(rows[0].revoked_at) : null };
}

/** Udelukker tilbagekaldte badesteder — brugt af private-site-risk.js's periodiske cyklus og /batch-routen. */
async function getActivePrivateSitesByIds(siteIds) {
  if (!siteIds || siteIds.length === 0) return [];
  const placeholders = siteIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(
    `SELECT * FROM private_sites WHERE site_id IN (${placeholders}) AND revoked_at IS NULL`,
    siteIds
  );
  return rows.map(rowToPublicSite);
}

/**
 * Distinkte 'private:'-site-ID'er, der optræder i mindst ét push-abonnements
 * favourites-liste — grundlaget for private-site-risk.js's "kun genberegn
 * abonnerede" filter (se dens filhoved for hvorfor). jsonb_array_elements_text
 * udfolder hver rækkes favourites-array; WHERE-filteret undgår at teste
 * hver enkelt element mod et regexp i JS for samtlige abonnementer.
 */
async function getSubscribedPrivateSiteIds() {
  const { rows } = await query(`
    SELECT DISTINCT elem AS site_id
    FROM push_subscriptions, jsonb_array_elements_text(favourites) AS elem
    WHERE elem LIKE 'private:%'
  `);
  return rows.map(r => r.site_id);
}

async function verifyOwnerToken(siteId, rawOwnerToken) {
  if (!rawOwnerToken) return false;
  const { rows } = await query('SELECT owner_token_hash FROM private_sites WHERE site_id = $1', [siteId]);
  if (!rows[0]) return false;
  const expected = Buffer.from(rows[0].owner_token_hash, 'hex');
  const actual = Buffer.from(hashToken(rawOwnerToken), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** @returns {Promise<string>} det nye rå share-token — det ENESTE andet sted (foruden oprettelse) et rå token nogensinde returneres. */
async function regenerateShareToken(siteId) {
  const shareToken = newToken();
  await query('UPDATE private_sites SET share_token = $1 WHERE site_id = $2', [shareToken, siteId]);
  return shareToken;
}

/** @returns {Promise<boolean>} true hvis en række faktisk blev ændret (idempotent — false ved andet kald). */
async function revokePrivateSite(siteId, now = new Date()) {
  const { rowCount } = await query(
    'UPDATE private_sites SET revoked_at = $1 WHERE site_id = $2 AND revoked_at IS NULL',
    [now.getTime(), siteId]
  );
  return rowCount > 0;
}

module.exports = {
  ready,
  createPrivateSite,
  getPrivateSiteById,
  getPrivateSiteByShareToken,
  getActivePrivateSitesByIds,
  getSubscribedPrivateSiteIds,
  verifyOwnerToken,
  regenerateShareToken,
  revokePrivateSite,
  hashIp,
  isWithinDkBbox,
  DK_BBOX,
  MAX_PRIVATE_SITES_PER_IP_PER_DAY,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
};
