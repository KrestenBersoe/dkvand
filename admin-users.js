// ═══════════════════════════════════════════════════════════════════════════
// admin-users.js — single auth-løsning (dkvand/ukwater/frwater), system-/
// country-tier: konto-model, database-skema, login
// ═══════════════════════════════════════════════════════════════════════════
//
// Erstatter den hidtidige requireInternalAuth i server.js — ÉT delt Basic-
// Auth-kodeord (INTERNAL_ADMIN_PASSWORD) uden nogen person-specifik
// identitet, oprindeligt bevidst dokumenteret som en midlertidig løsning
// ("giv INGEN person-specifik audit-log ... genovervej en rigtig intern
// login-løsning, hvis det behov opstår" — se server.js's requireInternalAuth).
// Det behov er nu opstået: en 'system'-bruger skal kunne se/administrere
// tenants i alle tre lande, en 'country'-bruger kun sit eget land — det kan
// et delt kodeord ikke udtrykke.
//
// ── Filopdeling (samme princip som tenant-admin.js/tenant-session.js) ──────
// Selve sessions-cookien/adgangs-middlewaren ligger IKKE her, men i
// admin-user-session.js — den fil har BEVIDST ingen afhængighed af db.js, så
// den kan unit-testes uden en levende database. Denne fil requirer og
// re-eksporterer den, så server.js fortsat kun behøver ét require. Selve
// skemaoprettelsen herunder udfører et REELT, levende databasekald ved
// import — derfor må denne fil ALDRIG blive et require af et rent
// admin-user-session-testmodul.
//
// Adgangskoder hashes med bcryptjs (ren JS, ingen native afhængighed) —
// dette er et lavvolumen, internt login (et lille betroet team, ikke
// offentlige brugere), så bcryptjs' langsommere rene JS-hashing er et fint
// bytte mod endnu en native build-afhængighed for så lidt volumen.
'use strict';
const bcrypt = require('bcryptjs');
const { query } = require('./db');
const adminUserSession = require('./admin-user-session');
// tenant-admin.js's ready creates the countries table this module's
// admin_users.country_code references — awaited below BEFORE issuing our
// own CREATE TABLE, so the two schema-setup queries can never race each
// other regardless of module require order in server.js.
const tenantAdminReady = require('./tenant-admin').ready;

const BCRYPT_ROUNDS = 12;

const ready = tenantAdminReady.then(() => query(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('system', 'country')),
    country_code  TEXT REFERENCES countries(code),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    TEXT,
    -- Håndhæves i skemaet, ikke kun i applikationskoden: en 'system'-bruger
    -- kan pr. definition se alle lande og må derfor ALDRIG have et
    -- country_code sat (ville ellers stille det uklare spørgsmål "hvorfor
    -- har en system-bruger ét bestemt lands kode?"); en 'country'-bruger
    -- er omvendt meningsløs uden ét.
    CONSTRAINT admin_users_country_matches_role CHECK (
      (role = 'system' AND country_code IS NULL) OR
      (role = 'country' AND country_code IS NOT NULL)
    )
  );
`)).then(() => console.info('admin-users: Postgres-skema klar'))
  .catch(e => { console.error('admin-users: skemaoprettelse fejlede —', e.message); throw e; });

// ── Konto-CRUD ───────────────────────────────────────────────────────────

/**
 * @param {{email: string, password: string, role: 'system'|'country', countryCode?: string|null, createdBy?: string|null}} p
 * @returns {Promise<{id: string, email: string, role: string, countryCode: string|null}>}
 */
async function createAdminUser({ email, password, role, countryCode = null, createdBy = null }) {
  if (role === 'system' && countryCode) {
    const err = new Error('En system-bruger må ikke have et countryCode.');
    err.code = 'VALIDATION'; throw err;
  }
  if (role === 'country' && !countryCode) {
    const err = new Error('En country-bruger skal have et countryCode.');
    err.code = 'VALIDATION'; throw err;
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const { rows } = await query(
    `INSERT INTO admin_users (email, password_hash, role, country_code, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, role, country_code`,
    [email.toLowerCase().trim(), passwordHash, role, countryCode, createdBy]
  );
  return { id: rows[0].id, email: rows[0].email, role: rows[0].role, countryCode: rows[0].country_code };
}

/**
 * Verificerer email+password mod admin_users. Returnerer ALTID en generisk
 * null ved forkert email ELLER forkert password — aldrig hvilken af de to,
 * samme princip som tenant-admin.js's trial-login-fejl (må ikke kunne bruges
 * til at afprøve hvilke emails der findes).
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{adminUserId: string, email: string, role: string, countryCode: string|null}|null>}
 */
async function verifyAdminUserPassword(email, password) {
  if (!email || !password) return null;
  const { rows } = await query(
    `SELECT id, email, password_hash, role, country_code FROM admin_users WHERE email = $1`,
    [String(email).toLowerCase().trim()]
  );
  const row = rows[0];
  if (!row) {
    // RETTET: stadig kør en bcrypt.compare mod en dummy-hash, selv når
    // brugeren ikke findes — ellers ville et ukendt-email-svar returnere
    // markant hurtigere end et forkert-password-svar, hvilket ville lække
    // hvilke emails der er registreret via en simpel timing-måling.
    await bcrypt.compare(password, '$2a$12$C6UzMDM.H6dfI/f/IKcEeO0h5vN6q6zLGZ4jK9CqMkQ4jz2Zc.5Fq');
    return null;
  }
  const match = await bcrypt.compare(password, row.password_hash);
  if (!match) return null;
  return { adminUserId: row.id, email: row.email, role: row.role, countryCode: row.country_code };
}

module.exports = {
  ready,
  // re-eksporteret fra admin-user-session.js — se filhovedets "Filopdeling"
  ...adminUserSession,
  createAdminUser,
  verifyAdminUserPassword,
};
