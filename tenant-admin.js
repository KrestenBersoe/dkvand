// ═══════════════════════════════════════════════════════════════════════════
// tenant-admin.js — Kommunepakke, modul 1: tenant-model, database-skema,
// tenant-/trial-CRUD
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Dette er UDELUKKENDE fundamentet — se planen (cached-toasting-stardust.md)
// for den fulde afgrænsning. Denne fil bygger IKKE:
//   - selvbetjent OAuth-konfigurationsflow (næste modul — tenant_oauth_configs
//     oprettes her, men forbliver tom/manuelt udfyldt indtil UI'en findes)
//   - dynamisk OAuth-login-middleware (modulet derefter, openid-client)
//   - noget dashboard-indhold (historik/rapporter/analyser/overstyring —
//     senere moduler)
//   - web-login til ditbadevand.dk's eget driftspersonale — trial-udstedelse
//     sker via scripts/create-tenant-trial.js, kørt af nogen med allerede
//     eksisterende server-/Fly-adgang, samme tillidsgrænse som at køre en
//     hvilken som helst anden scripts/-fil i dette repo i dag.
//
// ── Tenant-adgang, to veje ind ──────────────────────────────────────────────
// 1. Trial: ditbadevand.dk's driftsteam opretter en tenant og udsteder et
//    tidsbegrænset, engangsgenereret login-link (scripts/create-tenant-trial.js
//    → consumeTrialLogin() nedenfor). Bevidst den ENESTE fungerende login-vej
//    i dette modul — ingen OAuth-udbyder er sat op for et trial endnu.
// 2. OAuth (fremtidigt modul): kommunens egen udbyder, konfigureret via
//    tenant_oauth_configs. Genbruger PRÆCIS samme sessions-cookie-mekanisme
//    (tenant-session.js) som trial-loginet, blot med authMethod:'oauth' i
//    stedet for 'trial'.
//
// ── Filopdeling (VIGTIGT) ────────────────────────────────────────────────
// Kryptering/sessions-cookie/adgangs-middleware ligger IKKE her, men i
// tenant-session.js — den fil har BEVIDST ingen afhængighed af db.js, så den
// kan unit-testes uden en levende database (se tenant-session.test.js). Denne
// fil requirer og re-eksporterer den, så server.js fortsat kun behøver ét
// require for hele Kommunepakke-modulet (samme mønster som badestedObs/
// seoPages). Selve skemaoprettelsen herunder udfører et REELT, levende
// databasekald ved import — derfor må denne fil ALDRIG blive et require af
// tenant-session.test.js (ville kræve en Postgres-forbindelse for at teste
// rene funktioner).
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const crypto = require('crypto');
const { query } = require('./db');
const tenantSession = require('./tenant-session');

// ── Database-opsætning — samme mønster som badested-observations.js: egen
// CREATE TABLE IF NOT EXISTS, eksporteret ready-promise, afventet i
// server.js's Promise.all(...) før serveren begynder at lytte.
const ready = query(`
  CREATE TABLE IF NOT EXISTS tenants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'trial',
    trial_started_at    TIMESTAMPTZ,
    trial_expires_at    TIMESTAMPTZ,
    agreement_signed_at TIMESTAMPTZ,
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS tenant_oauth_configs (
    tenant_id                UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    provider_type            TEXT NOT NULL,
    client_id                TEXT NOT NULL,
    client_secret_ciphertext BYTEA NOT NULL,
    client_secret_iv         BYTEA NOT NULL,
    client_secret_auth_tag   BYTEA NOT NULL,
    discovery_url            TEXT NOT NULL,
    allowed_email_domains    TEXT[] NOT NULL,
    verified_at              TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS tenant_trial_logins (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    issued_by    TEXT,
    issued_note  TEXT,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_trial_token_hash ON tenant_trial_logins(token_hash);
`).then(() => console.info('tenant-admin: Postgres-skema klar'))
  .catch(e => { console.error('tenant-admin: skemaoprettelse fejlede —', e.message); throw e; });

// ── Tenant-/trial-CRUD ───────────────────────────────────────────────────────

/**
 * @param {{name: string, status?: 'trial'|'active', trialDays?: number|null, createdBy?: string|null}} p
 */
async function createTenant({ name, status = 'trial', trialDays = null, createdBy = null }) {
  const now = new Date();
  const trialStartedAt = status === 'trial' ? now : null;
  const trialExpiresAt = status === 'trial' && trialDays != null
    ? new Date(now.getTime() + trialDays * 24 * 3600 * 1000)
    : null;
  const { rows } = await query(
    `INSERT INTO tenants (name, status, trial_started_at, trial_expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, status, trial_started_at, trial_expires_at, created_at`,
    [name, status, trialStartedAt, trialExpiresAt, createdBy]
  );
  return rows[0];
}

/**
 * Genererer et engangs-token, gemmer KUN dets SHA-256-hash (samme ét-vejs-
 * princip som badested-observations.js's hashIp()) — det rå token returneres
 * HER og ALDRIG persisteret, kaldestedet (scripts/create-tenant-trial.js) er
 * eneste sted der ser det i klartekst.
 * @param {{tenantId: string, expiresAt: Date, issuedBy?: string|null, note?: string|null}} p
 * @returns {Promise<string>} rawToken
 */
async function issueTrialLogin({ tenantId, expiresAt, issuedBy = null, note = null }) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await query(
    `INSERT INTO tenant_trial_logins (tenant_id, token_hash, issued_by, issued_note, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, tokenHash, issuedBy, note, expiresAt]
  );
  return rawToken;
}

/**
 * Reusable-until-expiry (IKKE engangsbrug) — en kommune under trial skal
 * kunne logge ind flere gange over hele trial-perioden med samme link, ikke
 * kun én gang. Tilbagekaldes eksplicit (revoked_at) eller udløber (expires_at).
 * @param {string} rawToken
 * @returns {Promise<{tenantId: string, tenantName: string, tenantStatus: string}|null>}
 */
async function consumeTrialLogin(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await query(
    `SELECT ttl.tenant_id, ttl.expires_at, ttl.revoked_at, t.name, t.status
     FROM tenant_trial_logins ttl
     JOIN tenants t ON t.id = ttl.tenant_id
     WHERE ttl.token_hash = $1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { tenantId: row.tenant_id, tenantName: row.name, tenantStatus: row.status };
}

/** @param {string} tenantId */
async function getTenant(tenantId) {
  const { rows } = await query(
    `SELECT id, name, status, trial_started_at, trial_expires_at, agreement_signed_at, created_at
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

module.exports = {
  ready,
  // re-eksporteret fra tenant-session.js — se filhovedets "Filopdeling"
  ...tenantSession,
  // tenant/trial CRUD
  createTenant,
  issueTrialLogin,
  consumeTrialLogin,
  getTenant,
};
