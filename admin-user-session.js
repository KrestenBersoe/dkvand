// ═══════════════════════════════════════════════════════════════════════════
// admin-user-session.js — single auth-løsning, system-/country-tier:
// signeret sessions-cookie + adgangs-middleware
// ═══════════════════════════════════════════════════════════════════════════
//
// Bevidst UDEN afhængighed af db.js/Postgres — samme "ren, deterministisk,
// direkte unit-testbar uden en levende database"-princip som
// tenant-session.js (se dens filhoved), som denne fil i øvrigt GENBRUGER
// (signPayload/verifyPayload/parseCookies) i stedet for at hånd-rulle endnu
// en udgave af samme HMAC-signerede cookie-mekanisme. admin-users.js
// (DB-CRUD: admin_users-skema, createAdminUser, verifyAdminUserPassword)
// requirer og re-eksporterer denne fil, så server.js fortsat kun behøver ét
// require — nøjagtig samme opdeling tenant-admin.js/tenant-session.js
// allerede etablerer.
//
// Sit EGET cookienavn/sti (dkv_staff_session, Path=/internal) — ADSKILT fra
// tenant-sessionen (dkv_admin_session, Path=/admin): to helt forskellige
// privilegie-domæner (dkvand/ukwater/frwater's eget personale vs. en
// kommunes/council's/mairie's medarbejder) må aldrig kunne forveksles, selv
// om de deler samme underliggende HMAC-nøgle (ADMIN_SESSION_SECRET).
'use strict';
const tenantSession = require('./tenant-session');

const STAFF_SESSION_COOKIE_NAME = 'dkv_staff_session';
const STAFF_SESSION_MAX_AGE_MS = 12 * 3600 * 1000; // 12 timer, samme begrundelse som tenant-sessionen
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** @param {{adminUserId: string, email: string, role: 'system'|'country', countryCode: string|null}} p */
function signStaffSession(p) {
  return tenantSession.signPayload(p, STAFF_SESSION_MAX_AGE_MS);
}

/** @returns {{adminUserId: string, email: string, role: 'system'|'country', countryCode: string|null}|null} */
function verifyStaffSession(cookieValue) {
  const payload = tenantSession.verifyPayload(cookieValue);
  if (!payload || !payload.adminUserId || !payload.role) return null;
  return {
    adminUserId: payload.adminUserId,
    email: payload.email,
    role: payload.role,
    countryCode: payload.countryCode ?? null,
  };
}

function buildStaffSessionSetCookieHeader(cookieValue) {
  const maxAgeSec = Math.floor(STAFF_SESSION_MAX_AGE_MS / 1000);
  const flags = [`Max-Age=${maxAgeSec}`, 'Path=/internal', 'HttpOnly', 'SameSite=Lax'];
  if (IS_PRODUCTION) flags.push('Secure');
  return `${STAFF_SESSION_COOKIE_NAME}=${encodeURIComponent(cookieValue)}; ${flags.join('; ')}`;
}

function buildClearStaffSessionSetCookieHeader() {
  const flags = ['Max-Age=0', 'Path=/internal', 'HttpOnly', 'SameSite=Lax'];
  if (IS_PRODUCTION) flags.push('Secure');
  return `${STAFF_SESSION_COOKIE_NAME}=; ${flags.join('; ')}`;
}

/**
 * Express-middleware — sætter req.staff = {adminUserId, email, role,
 * countryCode} eller svarer 401/redirect. Genbrugt uændret af alle
 * /internal/*-ruter i server.js (se dens tidligere requireInternalAuth).
 */
function requireStaffSession(req, res, next) {
  const cookies = tenantSession.parseCookies(req.headers.cookie);
  const session = verifyStaffSession(cookies[STAFF_SESSION_COOKIE_NAME]);
  if (!session) {
    res.status(401);
    if (req.accepts(['html', 'json']) === 'json') {
      return res.json({ error: 'Ikke logget ind, eller sessionen er udløbet.' });
    }
    return res.redirect('/internal/login');
  }
  req.staff = session;
  next();
}

module.exports = {
  STAFF_SESSION_COOKIE_NAME,
  signStaffSession,
  verifyStaffSession,
  buildStaffSessionSetCookieHeader,
  buildClearStaffSessionSetCookieHeader,
  requireStaffSession,
};
