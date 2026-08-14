#!/usr/bin/env node
// tenant-session.test.js — kør fra repo-roden:
//   node tenant-session.test.js
// Rene enhedstests af tenant-session.js — INGEN database, INGEN netværkskald.
// Sætter egne, deterministiske test-secrets FØR require('./tenant-session'),
// da modulet hård-fejler ved import uden dem (se dens filhoved) — samme
// grund til at denne fil BEVIDST aldrig requirer tenant-admin.js (den fil
// udfører et REELT databasekald ved import, se dens "Filopdeling"-afsnit).

'use strict';
const assert = require('assert');

process.env.TENANT_CONFIG_ENCRYPTION_KEY = '0'.repeat(64); // 32 byte hex — deterministisk test-nøgle, ALDRIG en rigtig secret
process.env.ADMIN_SESSION_SECRET = 'test-session-secret-ikke-en-rigtig-hemmelighed';

const {
  encryptClientSecret, decryptClientSecret,
  signPayload, verifyPayload,
  signSession, verifySession, parseCookies,
  buildSessionSetCookieHeader, buildClearSessionSetCookieHeader,
  requireTenantSession, SESSION_COOKIE_NAME,
} = require('./tenant-session');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

// ── encryptClientSecret / decryptClientSecret ────────────────────────────
test('encrypt→decrypt: giver den oprindelige klartekst tilbage', () => {
  const plaintext = 'mit-hemmelige-oauth-client-secret-123';
  const enc = encryptClientSecret(plaintext);
  assert.strictEqual(decryptClientSecret(enc), plaintext);
});
test('encrypt: to krypteringer af samme klartekst giver FORSKELLIGT ciphertext (tilfældig IV)', () => {
  const a = encryptClientSecret('samme-tekst');
  const b = encryptClientSecret('samme-tekst');
  assert.notStrictEqual(a.ciphertext.toString('hex'), b.ciphertext.toString('hex'));
  assert.notStrictEqual(a.iv.toString('hex'), b.iv.toString('hex'));
});
test('decrypt: manipuleret ciphertext fejler (GCM authTag-tjek)', () => {
  const enc = encryptClientSecret('vigtig-hemmelighed');
  const tampered = Buffer.from(enc.ciphertext);
  tampered[0] ^= 0xff;
  assert.throws(() => decryptClientSecret({ ...enc, ciphertext: tampered }));
});
test('decrypt: manipuleret authTag fejler', () => {
  const enc = encryptClientSecret('vigtig-hemmelighed');
  const tampered = Buffer.from(enc.authTag);
  tampered[0] ^= 0xff;
  assert.throws(() => decryptClientSecret({ ...enc, authTag: tampered }));
});
test('decrypt: forkert IV fejler (eller giver forkert resultat, aldrig den rigtige klartekst)', () => {
  const enc = encryptClientSecret('vigtig-hemmelighed');
  const wrongIv = Buffer.from(enc.iv); wrongIv[0] ^= 0xff;
  assert.throws(() => decryptClientSecret({ ...enc, iv: wrongIv }));
});

// ── signPayload / verifyPayload (generisk, Kommunepakke modul 3) ─────────
test('signPayload→verifyPayload: vilkårligt payload rundtur, inkl. iat/exp', () => {
  const cookie = signPayload({ tenantId: 'abc', codeVerifier: 'xyz' }, 10 * 60 * 1000);
  const result = verifyPayload(cookie);
  assert.strictEqual(result.tenantId, 'abc');
  assert.strictEqual(result.codeVerifier, 'xyz');
  assert.strictEqual(typeof result.iat, 'number');
  assert.strictEqual(typeof result.exp, 'number');
});
test('signPayload: maxAgeMs sætter exp = iat + maxAgeMs, uafhængigt af sessionens 12 timer', () => {
  const TEN_MIN_MS = 10 * 60 * 1000;
  const cookie = signPayload({ x: 1 }, TEN_MIN_MS);
  const payload = verifyPayload(cookie);
  assert.strictEqual(payload.exp - payload.iat, TEN_MIN_MS);
  assert.ok(payload.exp - payload.iat < 12 * 3600 * 1000, 'skal være markant kortere end sessionens 12 timer');
});
test('verifyPayload: udløbet payload (kort maxAgeMs) afvises — samme deterministiske teknik som "verify: udløbet session afvises" (håndkrafted exp i fortiden, ingen reel ventetid)', () => {
  const payload = { x: 1, iat: Date.now() - 700000, exp: Date.now() - 600000 }; // "udløbet for 10 min siden" — simulerer en OAuth-state-cookie, der overskred sin 10-minutters levetid
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = require('crypto').createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payloadB64).digest('hex');
  assert.strictEqual(verifyPayload(payloadB64 + '.' + sig), null);
});
test('verifyPayload: manipuleret payload afvises (samme signaturbeskyttelse som verifySession)', () => {
  const cookie = signPayload({ tenantId: 'abc' }, 60000);
  const [payloadB64, sig] = cookie.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  payload.tenantId = 'ONDSINDET';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;
  assert.strictEqual(verifyPayload(forged), null);
});

// ── signSession / verifySession ──────────────────────────────────────────
test('sign→verify: gyldig session giver tenantId/authMethod tilbage', () => {
  const cookie = signSession({ tenantId: 'abc-123', authMethod: 'trial' });
  const result = verifySession(cookie);
  assert.deepStrictEqual(result, { tenantId: 'abc-123', authMethod: 'trial' });
});
test('sign→verify: trial-session UDEN email har IKKE en email-nøgle overhovedet (ikke email:undefined)', () => {
  const cookie = signSession({ tenantId: 'abc-123', authMethod: 'trial' });
  const result = verifySession(cookie);
  assert.strictEqual('email' in result, false);
});
test('sign→verify (Kommunepakke modul 6): OAuth-session MED email bevarer den', () => {
  const cookie = signSession({ tenantId: 'abc-123', authMethod: 'oauth', email: 'jens@kommune.dk' });
  const result = verifySession(cookie);
  assert.deepStrictEqual(result, { tenantId: 'abc-123', authMethod: 'oauth', email: 'jens@kommune.dk' });
});
test('verify: manipuleret payload afvises (signaturen matcher ikke længere)', () => {
  const cookie = signSession({ tenantId: 'abc-123', authMethod: 'trial' });
  const [payloadB64, sig] = cookie.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  payload.tenantId = 'ONDSINDET-ANDEN-TENANT';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;
  assert.strictEqual(verifySession(forged), null);
});
test('verify: manipuleret signatur afvises', () => {
  const cookie = signSession({ tenantId: 'abc-123', authMethod: 'trial' });
  const [payloadB64, sig] = cookie.split('.');
  const forgedSig = sig.slice(0, -2) + (sig.slice(-2) === '00' ? '11' : '00');
  assert.strictEqual(verifySession(payloadB64 + '.' + forgedSig), null);
});
test('verify: udløbet session afvises', () => {
  const payload = { tenantId: 'abc-123', authMethod: 'trial', iat: Date.now() - 100000, exp: Date.now() - 1000 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = require('crypto').createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payloadB64).digest('hex');
  assert.strictEqual(verifySession(payloadB64 + '.' + sig), null);
});
test('verify: tomt/ugyldigt/manglende input afvises uden at kaste', () => {
  assert.strictEqual(verifySession(undefined), null);
  assert.strictEqual(verifySession(''), null);
  assert.strictEqual(verifySession('ikke-et-gyldigt-format'), null);
  assert.strictEqual(verifySession('foo.bar'), null);
});
test('verify: session signeret med en ANDEN secret afvises', () => {
  const payload = { tenantId: 'abc-123', authMethod: 'trial', iat: Date.now(), exp: Date.now() + 10000 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const wrongSig = require('crypto').createHmac('sha256', 'en-helt-anden-secret').update(payloadB64).digest('hex');
  assert.strictEqual(verifySession(payloadB64 + '.' + wrongSig), null);
});

// ── parseCookies ──────────────────────────────────────────────────────────
test('parseCookies: parser flere cookies korrekt', () => {
  const result = parseCookies(`${SESSION_COOKIE_NAME}=abc123; other_cookie=xyz; third=1`);
  assert.strictEqual(result[SESSION_COOKIE_NAME], 'abc123');
  assert.strictEqual(result.other_cookie, 'xyz');
  assert.strictEqual(result.third, '1');
});
test('parseCookies: tomt/manglende cookie-header giver tomt objekt', () => {
  assert.deepStrictEqual(parseCookies(undefined), {});
  assert.deepStrictEqual(parseCookies(''), {});
});
test('parseCookies: URL-decoder værdien', () => {
  const result = parseCookies(`${SESSION_COOKIE_NAME}=a%2Bb%3Dc`);
  assert.strictEqual(result[SESSION_COOKIE_NAME], 'a+b=c');
});

// ── buildSessionSetCookieHeader / buildClearSessionSetCookieHeader ───────
test('buildSessionSetCookieHeader: indeholder HttpOnly, SameSite, cookienavn', () => {
  const header = buildSessionSetCookieHeader('nogen-cookie-vaerdi');
  assert.ok(header.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert.ok(header.includes('HttpOnly'));
  assert.ok(header.includes('SameSite=Lax'));
  assert.ok(header.includes('Path=/admin'));
});
test('buildSessionSetCookieHeader: uden NODE_ENV=production er der IKKE Secure-flag (lokal HTTP-verifikation skal virke)', () => {
  assert.ok(!buildSessionSetCookieHeader('x').includes('Secure'));
});
test('buildClearSessionSetCookieHeader: Max-Age=0 rydder cookien', () => {
  assert.ok(buildClearSessionSetCookieHeader().includes('Max-Age=0'));
});

// ── requireTenantSession (Express-middleware) ────────────────────────────
function fakeReq(cookieHeader) {
  return { headers: { cookie: cookieHeader }, accepts: () => 'json' };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  res.type = () => res;
  res.send = (obj) => { res.body = obj; return res; };
  return res;
}
test('requireTenantSession: gyldig cookie sætter req.tenant og kalder next()', () => {
  const cookie = signSession({ tenantId: 'tenant-1', authMethod: 'trial' });
  const req = fakeReq(`${SESSION_COOKIE_NAME}=${encodeURIComponent(cookie)}`);
  const res = fakeRes();
  let nextCalled = false;
  requireTenantSession(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(req.tenant, { tenantId: 'tenant-1', authMethod: 'trial' });
});
test('requireTenantSession: manglende cookie giver 401, next() kaldes IKKE', () => {
  const req = fakeReq(undefined);
  const res = fakeRes();
  let nextCalled = false;
  requireTenantSession(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});
test('requireTenantSession: to forskellige tenants forbliver adskilte (ingen krydsforurening)', () => {
  const cookieA = signSession({ tenantId: 'tenant-A', authMethod: 'trial' });
  const cookieB = signSession({ tenantId: 'tenant-B', authMethod: 'oauth' });
  const reqA = fakeReq(`${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieA)}`);
  const reqB = fakeReq(`${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieB)}`);
  requireTenantSession(reqA, fakeRes(), () => {});
  requireTenantSession(reqB, fakeRes(), () => {});
  assert.strictEqual(reqA.tenant.tenantId, 'tenant-A');
  assert.strictEqual(reqB.tenant.tenantId, 'tenant-B');
  assert.notStrictEqual(reqA.tenant.tenantId, reqB.tenant.tenantId);
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
