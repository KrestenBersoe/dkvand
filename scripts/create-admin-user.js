// ═══════════════════════════════════════════════════════════════════════════
// scripts/create-admin-user.js — single auth-løsning: opret en system-/
// country-tier staff-konto
// ═══════════════════════════════════════════════════════════════════════════
//
// Kørt manuelt af nogen med allerede eksisterende server-/Fly-adgang — samme
// tillidsgrænse som scripts/create-tenant-trial.js (se dens filhoved).
// Eneste vej til at oprette den ALLERFØRSTE system-konto (kylling-og-æg:
// admin-users.js's requireStaffSession kræver jo netop én for at logge ind
// via /internal/login) — og fortsat den eneste vej for en 'system'-bruger
// selv, da der ikke findes en selvbetjent "administrer staff"-side (se
// planens "Explicit non-goals").
//
// Brug:
//   DATABASE_URL=postgresql://... ADMIN_SESSION_SECRET=... TENANT_CONFIG_ENCRYPTION_KEY=... \
//     node scripts/create-admin-user.js --email="kresten@ditbadevand.dk" --password="..." --role=system
//   DATABASE_URL=... node scripts/create-admin-user.js --email="uk-lead@ditbadevand.dk" --password="..." --role=country --country=UK
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const adminUsers = require('../admin-users');
const { pool } = require('../db');

// Samme unhandled-rejection-forebyggelse som create-tenant-trial.js — se
// dens filhoved.
adminUsers.ready.catch(() => {});

function argValue(flag, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : fallback;
}

const EMAIL    = argValue('email', null);
const PASSWORD = argValue('password', null);
const ROLE     = argValue('role', null);
const COUNTRY  = argValue('country', null);

(async () => {
  try {
    if (!EMAIL) throw new Error('--email="person@example.com" er påkrævet');
    if (!PASSWORD || PASSWORD.length < 12) throw new Error('--password er påkrævet og skal være mindst 12 tegn');
    if (ROLE !== 'system' && ROLE !== 'country') throw new Error('--role skal være enten "system" eller "country"');
    if (ROLE === 'country' && !COUNTRY) throw new Error('--country="DK"|"UK"|"FR" er påkrævet for en country-konto');
    if (ROLE === 'system' && COUNTRY) throw new Error('--country må ikke angives for en system-konto');

    await adminUsers.ready;

    const user = await adminUsers.createAdminUser({
      email: EMAIL,
      password: PASSWORD,
      role: ROLE,
      countryCode: COUNTRY ? COUNTRY.toUpperCase() : null,
      createdBy: 'scripts/create-admin-user.js',
    });

    console.log(`Staff-konto oprettet: ${user.email} (${user.role}${user.countryCode ? ', ' + user.countryCode : ''})`);
    console.log('Log ind på /internal/login med denne e-mail og den angivne adgangskode.');
  } catch (e) {
    if (e.code === '23505') {
      console.error('create-admin-user fejlede: en konto med den e-mail findes allerede.');
    } else {
      console.error('create-admin-user fejlede:', e.message);
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
