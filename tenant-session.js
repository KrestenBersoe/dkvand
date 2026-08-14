// ═══════════════════════════════════════════════════════════════════════════
// tenant-session.js — Kommunepakke, modul 1: client_secret-kryptering,
// signeret sessions-cookie, tenant-adgangs-middleware
// ═══════════════════════════════════════════════════════════════════════════
//
// Bevidst UDEN afhængighed af db.js/Postgres — rene, deterministiske
// funktioner, direkte unit-testbare uden en levende database (se
// tenant-session.test.js). Al DB-bærende logik (skema, tenant-/trial-CRUD)
// ligger i stedet i tenant-admin.js, som requirer og re-eksporterer denne
// fil, så server.js fortsat kun behøver ét require (samme mønster som
// badestedObs/seoPages).
//
// Genbruges UÆNDRET af trial-login OG det fremtidige OAuth-modul — resten af
// systemet (alle fremtidige dashboard-/rapport-/analyse-ruter) behøver
// aldrig vide hvilken af de to en given session stammer fra, kun
// req.tenant.{tenantId,authMethod}.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const crypto = require('crypto');

// ── Secrets — hård fejl ved opstart, samme mønster som badested-
// observations.js's OBSERVATION_IP_SALT: en manglende/ustabil nøgle
// underminerer selve sikkerhedsformålet, skal derfor ALDRIG fejle stille.
const ENCRYPTION_KEY = process.env.TENANT_CONFIG_ENCRYPTION_KEY
  ? Buffer.from(process.env.TENANT_CONFIG_ENCRYPTION_KEY, 'hex')
  : null;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
  throw new Error(
    'TENANT_CONFIG_ENCRYPTION_KEY mangler eller har forkert længde (skal være 32 byte hex) — ' +
    'sæt som Fly secret før opstart:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
    '  fly secrets set TENANT_CONFIG_ENCRYPTION_KEY=<værdi> -a dkvand'
  );
}
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error(
    'ADMIN_SESSION_SECRET mangler — sæt som Fly secret før opstart:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
    '  fly secrets set ADMIN_SESSION_SECRET=<værdi> -a dkvand'
  );
}

// ── client_secret-kryptering (AES-256-GCM) ──────────────────────────────────
// Autentificeret kryptering — beskytter mod utilsigtet/ondsindet ÆNDRING af
// ciphertext, ikke kun indsigt (almindelig CBC ville ikke opdage det).
// decryptClientSecret() kaldes UDELUKKENDE af det fremtidige OAuth-middleware-
// modul, når det reelt skal tale med kommunens udbyder — aldrig af noget der
// sender data videre til en klient.
const GCM_IV_BYTES = 12; // standard/anbefalet IV-længde for AES-GCM

/**
 * @param {string} plaintext
 * @returns {{ciphertext: Buffer, iv: Buffer, authTag: Buffer}}
 */
function encryptClientSecret(plaintext) {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * @param {{ciphertext: Buffer, iv: Buffer, authTag: Buffer}} p
 * @returns {string} plaintext
 * @throws {Error} hvis authTag ikke matcher (manipuleret/forkert nøgle/data)
 */
function decryptClientSecret({ ciphertext, iv, authTag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ── Signerede cookies (generisk) — håndrullet, INGEN session-store/express-
// session (appen er i dag helt stateless, og repoets stil er konsekvent
// "ingen unødig afhængighed" — samme princip som badested-observations.js's
// håndrullede IP-hashing). Format: <base64url(JSON-payload)>.<hex-HMAC>.
//
// RETTET (Kommunepakke, modul 3): generaliseret fra den tidligere
// sessions-specifikke signSession()/verifySession() til signPayload()/
// verifyPayload() med en VILKÅRLIG payload og udløbstid — genbruges nu af
// BÅDE selve sessions-cookien (12 timer) OG modul 3's kortlivede (10 min)
// OAuth-state-cookie (state/nonce/PKCE-code_verifier under selve login-
// omdirigeringen til udbyderen). Samme signatur-/timingSafeEqual-logik som
// før, blot ikke længere hårdkodet til {tenantId,authMethod}-formen.
// signSession()/verifySession() er nu TYNDE wrappers herom — deres
// offentlige adfærd/signatur er UÆNDRET, se tenant-session.test.js.
const SESSION_COOKIE_NAME = 'dkv_admin_session';
const SESSION_MAX_AGE_MS = 12 * 3600 * 1000; // 12 timer — én arbejdsdag, kommune-medarbejder logger ind igen næste dag
// Defensiv note: 'Secure'-cookie-flaget kræver HTTPS. fly.toml sætter
// NODE_ENV=production i drift (force_https er også sat der); lokal
// verifikation (se planens Verifikations-afsnit) sker over almindelig HTTP,
// hvor et 'Secure'-flag ville forhindre browseren i overhovedet at sende
// cookien tilbage. Ingen anden brug af NODE_ENV noget sted i repoet — dette
// er den ENESTE, snævert begrundede undtagelse.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * @param {object} payload — vilkårligt JSON-serialiserbart objekt
 * @param {number} maxAgeMs — udløbstid, tilføjes som payload.exp
 * @returns {string} cookieværdi (ikke selve Set-Cookie-headeren)
 */
function signPayload(payload, maxAgeMs) {
  const now = Date.now();
  const full = { ...payload, iat: now, exp: now + maxAgeMs };
  const payloadB64 = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

/**
 * @param {string|undefined} cookieValue
 * @returns {object|null} det oprindelige payload (inkl. iat/exp) eller null ved manipuleret/udløbet/ugyldig cookie
 */
function verifyPayload(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const dotIdx = cookieValue.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const payloadB64 = cookieValue.slice(0, dotIdx);
  const sig = cookieValue.slice(dotIdx + 1);

  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('hex');
  // timingSafeEqual kræver samme længde — en forfalsket/forkert-længde
  // signatur skal afvises FØR sammenligningen, ikke kaste en exception.
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

/**
 * @param {{tenantId: string, authMethod: 'trial'|'oauth'}} p
 * @returns {string} cookieværdi (ikke selve Set-Cookie-headeren)
 */
function signSession({ tenantId, authMethod }) {
  return signPayload({ tenantId, authMethod }, SESSION_MAX_AGE_MS);
}

/**
 * @param {string|undefined} cookieValue
 * @returns {{tenantId: string, authMethod: string}|null}
 */
function verifySession(cookieValue) {
  const payload = verifyPayload(cookieValue);
  if (!payload || !payload.tenantId || !payload.authMethod) return null;
  return { tenantId: payload.tenantId, authMethod: payload.authMethod };
}

// Triviel håndrullet cookie-parsing — ingen ny npm-afhængighed for noget der
// er få linjer kode (samme "ingen unødig abstraktion"-begrundelse som
// sessions-mekanismen selv).
function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; } }
  }
  return out;
}

function buildSessionSetCookieHeader(cookieValue) {
  const maxAgeSec = Math.floor(SESSION_MAX_AGE_MS / 1000);
  const flags = [`Max-Age=${maxAgeSec}`, 'Path=/admin', 'HttpOnly', 'SameSite=Lax'];
  if (IS_PRODUCTION) flags.push('Secure');
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieValue)}; ${flags.join('; ')}`;
}

function buildClearSessionSetCookieHeader() {
  const flags = ['Max-Age=0', 'Path=/admin', 'HttpOnly', 'SameSite=Lax'];
  if (IS_PRODUCTION) flags.push('Secure');
  return `${SESSION_COOKIE_NAME}=; ${flags.join('; ')}`;
}

/**
 * Express-middleware — sætter req.tenant = {tenantId, authMethod} eller
 * svarer 401. Genbruges UÆNDRET af alle fremtidige admin-API-ruter
 * (dashboard-/rapport-/analyse-moduler).
 */
function requireTenantSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies[SESSION_COOKIE_NAME]);
  if (!session) {
    res.status(401);
    if (req.accepts(['html', 'json']) === 'json') {
      return res.json({ error: 'Ikke logget ind eller session udløbet.' });
    }
    return res.type('text/plain').send('Session udløbet eller ugyldig — log ind igen.');
  }
  req.tenant = session;
  next();
}

module.exports = {
  encryptClientSecret,
  decryptClientSecret,
  SESSION_COOKIE_NAME,
  signPayload,
  verifyPayload,
  signSession,
  verifySession,
  parseCookies,
  buildSessionSetCookieHeader,
  buildClearSessionSetCookieHeader,
  requireTenantSession,
};
