// ═══════════════════════════════════════════════════════════════════════════
// scripts/create-tenant-trial.js — Kommunepakke, modul 1: opret en ny
// kommune-tenant og udsted et tidsbegrænset trial-login
// ═══════════════════════════════════════════════════════════════════════════
//
// Kørt manuelt af ditbadevand.dk's driftsteam — ingen web-baseret platform-
// admin-login findes i dette modul (se tenant-admin.js's filhoved for
// begrundelsen: samme tillidsgrænse som at køre en hvilken som helst anden
// scripts/-fil i dette repo i dag).
//
// Brug:
//   DATABASE_URL=postgresql://... TENANT_CONFIG_ENCRYPTION_KEY=... ADMIN_SESSION_SECRET=... \
//     node scripts/create-tenant-trial.js --name="Odense Kommune" --days=30 \
//       --issued-by="Kresten" --note="sendt til jens@odense.dk" \
//       --logo-url="https://www.odense.dk/-/media/logo.svg"
//
// NYT (Kommunepakke, modul 6): --logo-url er valgfrit — vises i det
// offentlige overstyrings-banner (badested-overrides.js), hvis/når
// kommunen bruger overstyringsfunktionen. Samme staff-sat, ikke-selvbetjent
// princip som --name selv. Kan tilføjes/rettes senere ved at genkøre
// scripts/create-tenant-trial.js? NEJ — dette script opretter kun NYE
// tenants; ret et eksisterende logo via en direkte UPDATE i databasen
// (der findes endnu ingen selvbetjent redigeringsside, se planens
// "Bevidst uden for scope").
//
// Printer den fulde login-URL til konsollen — ingen automatiseret
// mail-udsendelse. Token'et vises HER, i klartekst, ÉN gang — kun dets
// SHA-256-hash gemmes i databasen (se tenant-admin.js's issueTrialLogin()).
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const tenantAdmin = require('../tenant-admin');
const { pool } = require('../db');
const seoPages = require('../seo-pages'); // SITE_URL — samme kilde som Tier 1/2-sidernes canonical-URL'er

// RETTET: tenant-admin.js's ready-promise (skemaoprettelse) starter
// UBETINGET ved require() ovenfor, uafhængigt af om denne scripts egen
// argument-validering nedenfor når at fejle FØRST. I server.js er dette
// altid trygt (Promise.all([...tenantAdmin.ready...]) hægter sig på den
// synkront, samme øjeblik filen loades) — men her, hvis --name/--days
// fejler FØR koden når frem til `await tenantAdmin.ready` i try-blokken,
// forbliver promisen uden nogen tilknyttet handler, indtil den senere
// (asynkront) afvises — hvilket crasher hele processen som en unhandled
// rejection, EFTER at den rigtige, brugervenlige valideringsfejl allerede
// er printet. Denne no-op .catch() forhindrer crashet uden at skjule den
// RIGTIGE fejl, som stadig rapporteres normalt via den ægte `await
// tenantAdmin.ready` længere nede.
tenantAdmin.ready.catch(() => {});

function argValue(flag, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : fallback;
}

const NAME       = argValue('name', null);
const DAYS       = parseInt(argValue('days', '30'), 10);
const ISSUED_BY  = argValue('issued-by', null);
const NOTE       = argValue('note', null);
const LOGO_URL   = argValue('logo-url', null);

(async () => {
  try {
    if (!NAME) throw new Error('--name="Kommunens navn" er påkrævet');
    if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error('--days skal være et positivt tal');

    await tenantAdmin.ready;

    const tenant = await tenantAdmin.createTenant({
      name: NAME,
      status: 'trial',
      trialDays: DAYS,
      createdBy: ISSUED_BY,
      logoUrl: LOGO_URL,
    });
    const rawToken = await tenantAdmin.issueTrialLogin({
      tenantId: tenant.id,
      expiresAt: tenant.trial_expires_at,
      issuedBy: ISSUED_BY,
      note: NOTE,
    });
    const loginUrl = `${seoPages.SITE_URL}/admin/trial/${rawToken}`;

    console.log(`Tenant oprettet: ${tenant.name} (${tenant.id})`);
    console.log(`Trial udløber:   ${tenant.trial_expires_at.toISOString()}`);
    console.log(`Login-URL (send til kommunens kontakt — vises kun denne ene gang):`);
    console.log(`  ${loginUrl}`);
  } catch (e) {
    console.error('create-tenant-trial fejlede:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
