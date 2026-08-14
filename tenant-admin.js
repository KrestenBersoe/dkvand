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
const https  = require('https');
const dns    = require('dns');
const { URL } = require('url');
const { query } = require('./db');
const tenantSession = require('./tenant-session');
const oauthValidation = require('./oauth-config-validation');

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

// ── OAuth-konfiguration (Kommunepakke, modul 2) ─────────────────────────────
// Selvbetjent flow: en ALLEREDE logget ind tenant (i dag udelukkende via
// trial, se filhovedet) gemmer selv deres permanente OAuth/OIDC-udbyder-
// konfiguration. Bruges endnu ikke til at logge ind noget sted — det er
// modul 3's dynamiske OAuth-login-middleware.

// SSRF-beskyttelse for et bruger-angivet Discovery URL-felt — se planen
// (Kommunepakke modul 2)'s "Ny sikkerhedsrisiko"-afsnit for den fulde
// begrundelse. Fire lag:
//   1. Kun https:// tilladt.
//   2. DNS-opslag FØR forbindelse — ALLE resolvede adresser tjekkes mod
//      oauth-config-validation.js's isPrivateOrDisallowedIp() (en
//      hostname kan resolve til flere adresser; kun ÉN skal være privat
//      for at hele forespørgslen afvises — fail closed).
//   3. Selve forbindelsen PINNES til netop den adresse, der blev valideret
//      i trin 2 (https.get's `lookup`-option) — Node genresolver ALDRIG
//      hostname'et selv bagefter. Dette lukker den DNS-rebinding-TOCTOU-
//      begrænsning en naiv "slå op, så fetch(url)" ellers ville have (to
//      separate opslag, med et vindue hvor DNS-svaret kunne skifte
//      mellem dem) — servername/Host-header forbliver STADIG det rigtige
//      hostname (kun selve TCP-forbindelsens IP-mål er fastlåst), så TLS-
//      certifikatvalidering og vhost-routing hos udbyderen virker uændret.
//   4. Kort timeout (5s) + loft på svarstørrelse (100 KB — et ægte OIDC
//      discovery-dokument er typisk et par KB).
// Kaster ALDRIG for et forventeligt "kunne ikke bekræfte"-udfald (forkert
// URL, DNS-fejl, timeout, ugyldigt indhold) — kun {ok:false, reason}, som
// kaldestedet (server.js's POST-handler) viser direkte til brugeren.
const DISCOVERY_FETCH_TIMEOUT_MS = 5000;
const DISCOVERY_MAX_BYTES = 100 * 1024;
const REQUIRED_DISCOVERY_FIELDS = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'];

/**
 * SSRF-sikker hentning af en vilkårlig bruger-angivet URL, forventet at
 * indeholde et OIDC/OAuth2 discovery-JSON-dokument — se filhovedets
 * begrundelse. UDTRUKKET som selvstændig funktion (RETTET, Kommunepakke
 * modul 3): oprindeligt indlejret direkte i validateDiscoveryUrl(), men
 * oauth-login.js har brug for PRÆCIS samme SSRF-beskyttelse, når det
 * (ved hvert login-forsøg, se filhovedet) skal genhente samme dokument
 * for reelt at kunne konstruere en openid-client Configuration — at lade
 * to steder i koden hver hånd-rulle deres egen udgave af SSRF-tjekket
 * ville være at duplikere præcis den slags sikkerhedskritiske kode, denne
 * fil ellers konsekvent undgår at duplikere.
 * @param {string} rawUrl
 * @returns {Promise<{ok: true, doc: object}|{ok: false, reason: string}>}
 */
async function fetchDiscoveryDocument(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (e) { return { ok: false, reason: 'Ugyldig URL.' }; }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Discovery-URL skal starte med https://.' };
  }

  let addresses;
  try {
    addresses = await dns.promises.lookup(parsed.hostname, { all: true });
  } catch (e) {
    return { ok: false, reason: `Kunne ikke slå hostnavnet op: ${e.message}` };
  }
  if (!addresses || addresses.length === 0) {
    return { ok: false, reason: 'Hostnavnet resolverede til ingen adresser.' };
  }
  for (const { address } of addresses) {
    if (oauthValidation.isPrivateOrDisallowedIp(address)) {
      return { ok: false, reason: "Discovery-URL'en peger på en ikke-tilladt (privat/intern) adresse." };
    }
  }
  // RETTET: pin'er til en IPv4-adresse, hvis en findes, frem for blot
  // addresses[0] (som ofte er IPv6 først på en dual-stack-resolver) — IPv6-
  // udgangsforbindelse er langt fra universel på tværs af hostingmiljøer
  // (bekræftet konkret her: en IPv6-pinnet forbindelse hang pålideligt til
  // timeout i denne sandbox, specifikt EFTER et forudgående dns.lookup()
  // af 'localhost' i samme proces — sandsynligvis en libuv/c-ares-særhed,
  // men uafhængigt af rodårsagen er IPv4 det markant mere pålidelige valg
  // for et engangs-server-til-server-kald som dette).
  const ipv4Address = addresses.find(a => a.family === 4);
  const chosen = ipv4Address || addresses[0];
  const pinnedAddress = chosen.address;
  const pinnedFamily = chosen.family;

  return new Promise(resolve => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    const req = https.get(parsed, {
      timeout: DISCOVERY_FETCH_TIMEOUT_MS,
      // RETTET: Node's interne agent kalder somme tider lookup() med
      // opts.all===true (set under afvikling — bekræftet ved direkte test)
      // og forventer da cb(err, [{address,family}]) — en ARRAY — ikke
      // enkelt-formen cb(err,address,family). Uden dette gren fejlede
      // ALLE rigtige HTTPS-kald med den kryptiske "Invalid IP address:
      // undefined", uafhængigt af om selve pin'ingen/DNS-opslaget var
      // korrekt — kun opdaget ved at teste mod en ægte offentlig URL,
      // ikke kun de afviste (privat-IP/forkert protokol) testtilfælde.
      lookup: (_hostname, opts, cb) => {
        if (opts && opts.all) return cb(null, [{ address: pinnedAddress, family: pinnedFamily }]);
        cb(null, pinnedAddress, pinnedFamily);
      },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return settle({ ok: false, reason: `Discovery-URL'en svarede HTTP ${res.statusCode}.` });
      }
      let body = '';
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > DISCOVERY_MAX_BYTES) {
          settle({ ok: false, reason: 'Discovery-dokumentet er uventet stort.' });
          req.destroy();
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        if (settled) return;
        let doc;
        try { doc = JSON.parse(body); }
        catch (e) { return settle({ ok: false, reason: "Discovery-URL'en returnerede ikke gyldig JSON." }); }
        settle({ ok: true, doc });
      });
      res.on('error', e => settle({ ok: false, reason: `Fejl ved læsning af svar: ${e.message}` }));
    });
    req.on('timeout', () => { req.destroy(); settle({ ok: false, reason: "Discovery-URL'en svarede ikke inden for tidsgrænsen." }); });
    req.on('error', e => settle({ ok: false, reason: `Kunne ikke kontakte discovery-URL'en: ${e.message}` }));
  });
}

/**
 * @param {string} rawUrl
 * @returns {Promise<{ok: true}|{ok: false, reason: string}>}
 */
async function validateDiscoveryUrl(rawUrl) {
  const result = await fetchDiscoveryDocument(rawUrl);
  if (!result.ok) return result;
  const missing = REQUIRED_DISCOVERY_FIELDS.filter(f => typeof result.doc[f] !== 'string' || !result.doc[f]);
  if (missing.length > 0) {
    return { ok: false, reason: `Discovery-dokumentet mangler felt(er): ${missing.join(', ')}.` };
  }
  return { ok: true };
}

/**
 * Étrække-pr.-tenant (tenant_id er PRIMARY KEY, se skemaet) — en gemning
 * overskriver en evt. eksisterende konfiguration MED DET SAMME, ingen
 * versionering/staging. client_secret krypteres HER (aldrig gemt/logget i
 * klartekst noget sted).
 *
 * `clientSecret` er valgfrit ved OPDATERING (tomt = "behold det allerede
 * gemte secret uændret" — brugeren skal ikke tvinges til at genindtaste
 * det, hver gang de blot retter et andet felt, fx et domæne). Håndteres
 * HER, ikke i server.js's route-handler — den ser ALDRIG det eksisterende
 * krypterede secret (getOauthConfig() eksponerer det bevidst aldrig, se
 * dens filhoved), så "bevar-uændret"-stien skal nødvendigvis ligge
 * server-DB-siden af det skel.
 * @param {{tenantId: string, providerType: string, clientId: string, clientSecret: string, discoveryUrl: string, allowedEmailDomains: string[], verified: boolean}} p
 * @throws {Error} med .code === 'SECRET_REQUIRED' hvis clientSecret er tomt OG der ikke findes en eksisterende konfiguration at bevare secret'et fra
 */
async function upsertOauthConfig({ tenantId, providerType, clientId, clientSecret, discoveryUrl, allowedEmailDomains, verified }) {
  const verifiedAt = verified ? new Date() : null;

  if (clientSecret) {
    const { ciphertext, iv, authTag } = tenantSession.encryptClientSecret(clientSecret);
    await query(
      `INSERT INTO tenant_oauth_configs
         (tenant_id, provider_type, client_id, client_secret_ciphertext, client_secret_iv, client_secret_auth_tag, discovery_url, allowed_email_domains, verified_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         provider_type = EXCLUDED.provider_type,
         client_id = EXCLUDED.client_id,
         client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
         client_secret_iv = EXCLUDED.client_secret_iv,
         client_secret_auth_tag = EXCLUDED.client_secret_auth_tag,
         discovery_url = EXCLUDED.discovery_url,
         allowed_email_domains = EXCLUDED.allowed_email_domains,
         verified_at = EXCLUDED.verified_at,
         updated_at = now()`,
      [tenantId, providerType, clientId, ciphertext, iv, authTag, discoveryUrl, allowedEmailDomains, verifiedAt]
    );
    return;
  }

  // Intet nyt secret angivet — kun gyldigt som en OPDATERING af en
  // allerede eksisterende konfiguration (secret-kolonnerne røres slet
  // ikke). rowCount===0 betyder ingen eksisterende række at opdatere —
  // dvs. dette var reelt et FØRSTE-gangs-forsøg uden secret, som er en
  // brugerfejl, ikke en gyldig "bevar uændret".
  const { rowCount } = await query(
    `UPDATE tenant_oauth_configs SET
       provider_type = $2, client_id = $3, discovery_url = $4,
       allowed_email_domains = $5, verified_at = $6, updated_at = now()
     WHERE tenant_id = $1`,
    [tenantId, providerType, clientId, discoveryUrl, allowedEmailDomains, verifiedAt]
  );
  if (rowCount === 0) {
    const err = new Error('Der er intet gemt Client Secret at bevare — angiv ét ved første opsætning.');
    err.code = 'SECRET_REQUIRED';
    throw err;
  }
}

/**
 * SELECT ALDRIG client_secret_*-kolonnerne — secret'et vises ALDRIG tilbage
 * til klienten, hverken krypteret eller i klartekst. `hasSecret` er blot
 * "findes der en gemt konfiguration" (en gemt konfiguration har pr.
 * definition altid et secret, se upsertOauthConfig()).
 * @param {string} tenantId
 */
async function getOauthConfig(tenantId) {
  const { rows } = await query(
    `SELECT provider_type, client_id, discovery_url, allowed_email_domains, verified_at, created_at, updated_at
     FROM tenant_oauth_configs WHERE tenant_id = $1`,
    [tenantId]
  );
  if (!rows[0]) return null;
  return { ...rows[0], hasSecret: true };
}

// ── OAuth-login (Kommunepakke, modul 3) ─────────────────────────────────────

/**
 * Finder en VERIFICERET OAuth-konfiguration for det domæne, en bruger
 * indtastede på /admin/login. Kun verified_at IS NOT NULL kan bruges til
 * et reelt login-forsøg (se modul 2: en ubekræftet konfiguration kan
 * skyldes en fejlkonfigureret discovery-URL — skal ikke kunne forsøges).
 * Flere matches burde ikke forekomme (domæner er unikke pr. kommune i
 * praksis) — logges som advarsel, første match bruges, ingen hård fejl
 * (en driftsforstyrrelse for ÉN kommune skal ikke kunne blokere login for
 * andre).
 * @param {string} emailDomain — allerede udtrukket/normaliseret domæne, se emailMatchesAllowedDomains()
 * @returns {Promise<{tenantId: string, providerType: string, clientId: string, discoveryUrl: string, allowedEmailDomains: string[]}|null>}
 */
async function findTenantOauthConfigByEmailDomain(emailDomain) {
  const { rows } = await query(
    `SELECT tenant_id, provider_type, client_id, discovery_url, allowed_email_domains
     FROM tenant_oauth_configs
     WHERE verified_at IS NOT NULL AND $1 = ANY(allowed_email_domains)`,
    [emailDomain]
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.warn(`findTenantOauthConfigByEmailDomain: ${rows.length} tenants deler domænet "${emailDomain}" — bruger første match (tenant_id=${rows[0].tenant_id})`);
  }
  const row = rows[0];
  return {
    tenantId: row.tenant_id,
    providerType: row.provider_type,
    clientId: row.client_id,
    discoveryUrl: row.discovery_url,
    allowedEmailDomains: row.allowed_email_domains,
  };
}

/**
 * INTERN udgave af getOauthConfig() — DEKRYPTERER client_secret. Kaldes
 * UDELUKKENDE af oauth-login.js, som reelt skal tale med udbyderen for at
 * udveksle en autorisationskode. ALDRIG brugt af noget der sender data
 * videre til en klient — modsat getOauthConfig() ovenfor (den offentlige,
 * sikre udgave bag modul 2's indstillingsside), bevidst navngivet tydeligt
 * forskelligt for at gøre det umuligt ved en fejl at forveksle de to.
 * @param {string} tenantId
 */
async function getOauthConfigForLogin(tenantId) {
  const { rows } = await query(
    `SELECT provider_type, client_id, client_secret_ciphertext, client_secret_iv, client_secret_auth_tag,
            discovery_url, allowed_email_domains, verified_at
     FROM tenant_oauth_configs WHERE tenant_id = $1`,
    [tenantId]
  );
  const row = rows[0];
  if (!row) return null;
  const clientSecret = tenantSession.decryptClientSecret({
    ciphertext: row.client_secret_ciphertext,
    iv: row.client_secret_iv,
    authTag: row.client_secret_auth_tag,
  });
  return {
    providerType: row.provider_type,
    clientId: row.client_id,
    clientSecret,
    discoveryUrl: row.discovery_url,
    allowedEmailDomains: row.allowed_email_domains,
    verifiedAt: row.verified_at,
  };
}

module.exports = {
  ready,
  // re-eksporteret fra tenant-session.js — se filhovedets "Filopdeling"
  ...tenantSession,
  // re-eksporteret fra oauth-config-validation.js — samme "ét require pr.
  // feature-modul i server.js"-princip, denne fil requirer den allerede
  // til intern brug i validateDiscoveryUrl() ovenfor.
  ...oauthValidation,
  // tenant/trial CRUD
  createTenant,
  issueTrialLogin,
  consumeTrialLogin,
  getTenant,
  // OAuth-konfiguration (modul 2)
  fetchDiscoveryDocument,
  validateDiscoveryUrl,
  upsertOauthConfig,
  getOauthConfig,
  // OAuth-login (modul 3)
  findTenantOauthConfigByEmailDomain,
  getOauthConfigForLogin,
};
