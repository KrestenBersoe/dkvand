// ═══════════════════════════════════════════════════════════════════════════
// sso-handoff.js — single auth-løsning: kryptografisk håndsrækning af et
// fuldført kommune-login videre til ukwater/frwater
// ═══════════════════════════════════════════════════════════════════════════
//
// dkvand er den ENESTE plads en municipality-konto (dansk kommune, UK
// council, FR mairie) rent faktisk logger ind — se tenant-admin.js's
// country_code. Når den tenant, der lige gennemførte et trial- eller OAuth-
// login (server.js), IKKE hører til dkvand selv ('DK'), skal login'et
// afsluttes hos det rigtige søsterprodukt i stedet for at sætte en lokal
// dkv_admin_session-cookie — det er præcis hvad denne fil bygger.
//
// Kortlivet (60 sek. — rigeligt til én browser-redirect, aldrig ment til at
// blive gemt/genbrugt), HMAC-signeret med en helt ny, DELT hemmelighed
// (CENTRAL_AUTH_SIGNING_KEY, sat identisk på dkvand/ukwater/frwater) —
// bevidst IKKE tenant-session.js's ADMIN_SESSION_SECRET, som kun dkvand selv
// kender. `product`-feltet i selve payloaden forhindrer at et token udstedt
// til ét produkt kan genbruges mod et andet, selvom nøglen er delt mellem
// alle tre. Samme hånd-rullede HMAC-mønster som tenant-session.js's
// signPayload/verifyPayload (base64url-payload + hex-HMAC), men en HELT
// EGEN implementering her — ligesom councilSession.js/mairieSession.js
// allerede er uafhængige "porte" af samme mønster, ikke en delt afhængighed
// mellem de tre selvstændigt deploy'ede repos.
//
// Ingen replay-beskyttelses-tabel (jti/"brugt token") — bevidst, samme
// risikovurdering koden allerede lægger til grund andre steder for en
// kortlivet signeret payload (se oauth-login.js's 10-minutters OAuth-state-
// cookie, som heller ingen har): transporten er én enkelt server-til-
// browser-redirect over HTTPS, og 60 sek. er kort nok til at et evt. lækket
// token i praksis er ubrugeligt, længe før det ville være det værd at bygge
// og vedligeholde endnu en tabel for.
'use strict';
const crypto = require('crypto');
const { query } = require('./db');

const SIGNING_KEY = process.env.CENTRAL_AUTH_SIGNING_KEY;
if (!SIGNING_KEY) {
  throw new Error(
    'CENTRAL_AUTH_SIGNING_KEY mangler — SKAL sættes til PRÆCIS samme værdi på dkvand, ukwater og frwater (en fejlmatch gør hånd-rækningen tavst ubrugelig, ikke usikker):\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
    '  fly secrets set CENTRAL_AUTH_SIGNING_KEY=<værdi> -a dkvand -a ukwater -a frwater'
  );
}

const HANDOFF_MAX_AGE_MS = 60 * 1000;

// dkvand's eget land — en tenant med dette country_code afsluttes ALDRIG
// via denne fil (server.js afgør det FØR den kalder buildHandoffRedirect),
// men holdt her som den ene, eksplicit navngivne kilde til "hvilket land er
// vi selv" i stedet for at lade 'DK' stå hardkodet flere steder.
const THIS_PRODUCT_COUNTRY = 'DK';

/**
 * @param {object} payload
 * @returns {string} <base64url-payload>.<hex-hmac>
 */
function signHandoffToken(payload) {
  const full = { ...payload, iat: Date.now(), exp: Date.now() + HANDOFF_MAX_AGE_MS };
  const payloadB64 = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SIGNING_KEY).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

/**
 * Bygger den fulde redirect-URL til det land, en municipality-tenant reelt
 * hører til — slår landets product_base_url/municipality_login_path op i
 * countries-tabellen (tenant-admin.js's ready opretter/seeder den) i stedet
 * for at hardkode nogen af de tre produkters URL'er her.
 * @param {{countryCode: string, municipalityId: string, municipalityName: string}} p
 * @returns {Promise<string|null>} null hvis countryCode er ukendt (bør ikke ske — se kaldestedets fejlhåndtering)
 */
async function buildMunicipalityHandoffRedirect({ countryCode, municipalityId, municipalityName }) {
  const { rows } = await query(
    'SELECT product_base_url, municipality_login_path FROM countries WHERE code = $1',
    [countryCode]
  );
  const row = rows[0];
  if (!row) return null;
  const token = signHandoffToken({
    intent: 'login',
    product: countryCode,
    role: 'municipality',
    countryCode,
    municipalityId,
    municipalityName,
  });
  return `${row.product_base_url}${row.municipality_login_path}${encodeURIComponent(token)}`;
}

// ── Selvbetjent adgangskode, den MODSATTE retning (ukwater/frwater → dkvand)
// ────────────────────────────────────────────────────────────────────────
// En allerede-logget-ind UK council/FR mairie (lokal session på DERES eget
// produkt, aldrig en dkvand-cookie) skal kunne sætte sin egen adgangskode
// på den CENTRALE konto her. Samme HMAC-mekanisme som ovenfor, men SIGNERET
// af ukwater/frwater (se deres centralAuthClient.js's signAssertion()) og
// KUN verificeret her — dkvands rolle her er modsat af login-håndsrækningen,
// derfor `intent: 'set-password'` (ADSKILT fra 'login' ovenfor): forhindrer
// at et opsnappet login-token nogensinde kunne genbruges til i stedet at
// sætte en adgangskode, og omvendt.
const ASSERTION_MAX_AGE_MS = 10 * 60 * 1000; // 10 min — nok tid til at udfylde en formular, samme størrelsesorden som oauth-login.js's state-cookie

/**
 * @param {string} token — udstedt af ukwater's/frwater's centralAuthClient.js's signAssertion()
 * @returns {{municipalityId: string, municipalityName: string}|null}
 */
function verifyProductAssertion(token) {
  if (!token || typeof token !== 'string') return null;
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);

  const expectedSig = crypto.createHmac('sha256', SIGNING_KEY).update(payloadB64).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (payload.intent !== 'set-password' || payload.role !== 'municipality') return null;
  if (payload.product !== 'UK' && payload.product !== 'FR') return null; // DK never needs this — a dkvand tenant already has a local session, see server.js's /set-password dispatch
  if (!payload.municipalityId) return null;

  return { municipalityId: payload.municipalityId, municipalityName: payload.municipalityName };
}

module.exports = {
  THIS_PRODUCT_COUNTRY,
  ASSERTION_MAX_AGE_MS,
  buildMunicipalityHandoffRedirect,
  verifyProductAssertion,
};
