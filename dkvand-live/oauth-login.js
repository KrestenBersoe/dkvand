// ═══════════════════════════════════════════════════════════════════════════
// oauth-login.js — Kommunepakke, modul 3: dynamisk OAuth-login (openid-client)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ejer selve openid-client-integrationen — ADSKILT fra tenant-admin.js (DB)
// og tenant-session.js (generisk kryptering/signering), samme "ét ansvar
// pr. fil"-princip som resten af Kommunepakken.
//
// ID-token-VALIDERING (signatur mod udbyderens JWKS, issuer, audience,
// expiry) udføres UDELUKKENDE af openid-client selv, ALDRIG hånd-rullet —
// se planens filhoved for hvorfor: hånd-rullet JWT-verifikation er et
// notorisk letantageligt sted at lave sikkerhedsfejl. tokens.claims()
// (handleCallback() nedenfor) returnerer derfor et ALLEREDE fuldt
// verificeret claims-sæt, ikke rå, utjekket JWT-payload.
//
// INGEN caching af discovery-dokumenter (bevidst, se planen) — login sker
// sjældent nok pr. bruger til at det er umagen/risikoen for et forældet-
// efter-modul-2-redigering-cache-hit værd. Genbruger tenant-admin.js's
// fetchDiscoveryDocument() — SAMME SSRF-beskyttelse som modul 2's
// validateDiscoveryUrl(), ikke en ny, dupliceret udgave.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const client = require('openid-client');
const tenantAdmin = require('./tenant-admin');
const oauthValidation = require('./oauth-config-validation');
const seoPages = require('./seo-pages'); // SITE_URL — samme kilde som resten af appens absolutte URL'er

// Fast, ÉN callback-URL for ALLE tenants (state-payloaden bærer hvilken
// tenant/login-forsøg det er, ikke URL'en selv) — standard OIDC-praksis,
// skal registreres af hver kommune som deres tilladte redirect_uri hos
// egen udbyder. Vist til kommunen i admin-oauth-setup.html (modul 2) —
// HOLD I SYNC, hvis denne sti nogensinde ændres.
const CALLBACK_PATH = '/admin/oauth/callback';
const CALLBACK_URL = `${seoPages.SITE_URL}${CALLBACK_PATH}`;

// Kortlivet (10 min — rigeligt til at gennemføre en login-runde hos
// udbyderen, men kort nok til at et glemt/afbrudt forsøg ikke hænger
// unødigt længe som en gyldig cookie), signeret, ADSKILT fra selve
// sessions-cookien (dkv_admin_session, 12 timer) — se tenant-session.js's
// generaliserede signPayload()/verifyPayload().
const OAUTH_STATE_COOKIE_NAME = 'dkv_admin_oauth_state';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Bygger autorisations-URL'en for trin 1 af login (redirect til udbyderen)
 * — autorisationskode-flow med PKCE (S256) + state + nonce, standard OIDC.
 * INGEN client_secret nødvendig her (kun ved selve token-udvekslingen i
 * handleCallback()) — kalder derfor bevidst tenant-admin.js's IKKE-
 * dekrypterende findTenantOauthConfigByEmailDomain(), ikke
 * getOauthConfigForLogin(), for at holde det dekrypterede secret ude af
 * denne funktions hukommelse helt.
 * @param {{tenantId: string, clientId: string, discoveryUrl: string}} providerConfig
 * @returns {Promise<{redirectUrl: URL, stateCookieValue: string}>}
 * @throws {Error} med .code==='DISCOVERY_FAILED' og en bruger-sikker besked, hvis discovery fejler
 */
async function buildAuthorizationRedirect({ tenantId, clientId, discoveryUrl }) {
  const discoveryResult = await tenantAdmin.fetchDiscoveryDocument(discoveryUrl);
  if (!discoveryResult.ok) {
    const err = new Error(`Kunne ikke kontakte jeres OAuth-udbyder: ${discoveryResult.reason}`);
    err.code = 'DISCOVERY_FAILED';
    throw err;
  }
  const config = new client.Configuration(discoveryResult.doc, clientId);

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const redirectUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: CALLBACK_URL,
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  const stateCookieValue = tenantAdmin.signPayload(
    { tenantId, codeVerifier, state, nonce },
    OAUTH_STATE_MAX_AGE_MS
  );

  return { redirectUrl, stateCookieValue };
}

/**
 * Håndterer trin 2 (`GET /admin/oauth/callback`) — udveksler koden til
 * tokens, validerer (VIA BIBLIOTEKET) og udtrækker e-mail, tjekker den
 * (IGEN — uafhængigt af det oprindelige domæne-opslag i buildAuthorization-
 * Redirect()/findTenantOauthConfigByEmailDomain(), da den faktisk
 * AUTENTIFICEREDE e-mail kan afvige fra den, brugeren indtastede før
 * omdirigeringen) mod kommunens allowed_email_domains.
 * @param {{stateCookieValue: string|undefined, currentUrl: URL}} p
 * @returns {Promise<{tenantId: string, email: string}>}
 * @throws {Error} med en .code (se de enkelte grene) og en bruger-sikker besked
 */
async function handleCallback({ stateCookieValue, currentUrl }) {
  const statePayload = tenantAdmin.verifyPayload(stateCookieValue);
  if (!statePayload || !statePayload.tenantId || !statePayload.codeVerifier || !statePayload.state) {
    const err = new Error('Login-forsøget er udløbet eller ugyldigt — prøv at logge ind igen.');
    err.code = 'INVALID_STATE';
    throw err;
  }

  const loginConfig = await tenantAdmin.getOauthConfigForLogin(statePayload.tenantId);
  if (!loginConfig) {
    const err = new Error('Kommunens OAuth-konfiguration blev ikke fundet — kontakt jeres it-administrator.');
    err.code = 'CONFIG_NOT_FOUND';
    throw err;
  }

  // Frisk discovery-hentning HER (ikke genbrugt fra trin 1's state-cookie)
  // — se filhovedet: konfigurationen kan i teorien være redigeret via
  // modul 2 midt i et login-forsøg, og friskhed vejer tungere end at
  // spare ét ekstra HTTPS-kald for et sjældent-kaldt flow.
  const discoveryResult = await tenantAdmin.fetchDiscoveryDocument(loginConfig.discoveryUrl);
  if (!discoveryResult.ok) {
    const err = new Error(`Kunne ikke kontakte jeres OAuth-udbyder: ${discoveryResult.reason}`);
    err.code = 'DISCOVERY_FAILED';
    throw err;
  }
  const config = new client.Configuration(discoveryResult.doc, loginConfig.clientId, loginConfig.clientSecret);

  let tokens;
  try {
    tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: statePayload.codeVerifier,
      expectedState: statePayload.state,
      expectedNonce: statePayload.nonce,
    });
  } catch (e) {
    // RETTET: hverken den rå fejl fra biblioteket (kan indeholde interne
    // detaljer om udbyderens svar) eller e.message videregives direkte til
    // klienten — kun en generisk, bruger-sikker besked. Selve fejlen
    // logges server-side via .cause, hvis kaldestedet vælger at gøre det.
    const err = new Error('Login hos udbyderen mislykkedes eller blev afvist.');
    err.code = 'TOKEN_EXCHANGE_FAILED';
    err.cause = e;
    throw err;
  }

  // tokens.claims() — se filhovedet: ALLEREDE fuldt verificeret af
  // openid-client (signatur/issuer/audience/expiry), ikke rå JWT-payload.
  const claims = tokens.claims();
  const email = claims?.email;
  if (!email || typeof email !== 'string') {
    const err = new Error('Udbyderen returnerede ingen e-mailadresse — login kan ikke gennemføres.');
    err.code = 'NO_EMAIL_CLAIM';
    throw err;
  }
  // email_verified håndhæves KUN hvis udbyderen rent faktisk sender
  // claimet — flere enterprise-/myndigheds-udbydere (Entra ID/MitID
  // Erhverv typisk for arbejdskonti) udelader det helt for interne
  // konti, hvor det ville være en falsk negativ at kræve dets tilstedeværelse.
  if (claims.email_verified === false) {
    const err = new Error('Udbyderen har ikke bekræftet denne e-mailadresse.');
    err.code = 'EMAIL_NOT_VERIFIED';
    throw err;
  }

  if (!oauthValidation.emailMatchesAllowedDomains(email, loginConfig.allowedEmailDomains)) {
    const err = new Error('Din e-mailadresse er ikke godkendt til at logge ind hos denne kommune.');
    err.code = 'DOMAIN_NOT_ALLOWED';
    throw err;
  }

  return { tenantId: statePayload.tenantId, email };
}

function buildOauthStateSetCookieHeader(cookieValue) {
  const maxAgeSec = Math.floor(OAUTH_STATE_MAX_AGE_MS / 1000);
  const flags = [`Max-Age=${maxAgeSec}`, 'Path=/admin', 'HttpOnly', 'SameSite=Lax'];
  if (process.env.NODE_ENV === 'production') flags.push('Secure');
  return `${OAUTH_STATE_COOKIE_NAME}=${encodeURIComponent(cookieValue)}; ${flags.join('; ')}`;
}

function buildClearOauthStateSetCookieHeader() {
  const flags = ['Max-Age=0', 'Path=/admin', 'HttpOnly', 'SameSite=Lax'];
  if (process.env.NODE_ENV === 'production') flags.push('Secure');
  return `${OAUTH_STATE_COOKIE_NAME}=; ${flags.join('; ')}`;
}

module.exports = {
  CALLBACK_PATH,
  CALLBACK_URL,
  OAUTH_STATE_COOKIE_NAME,
  buildAuthorizationRedirect,
  handleCallback,
  buildOauthStateSetCookieHeader,
  buildClearOauthStateSetCookieHeader,
};
