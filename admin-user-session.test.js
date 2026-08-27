#!/usr/bin/env node
// admin-user-session.test.js — kør fra repo-roden:
//   node admin-user-session.test.js
// Rene enhedstests af admin-user-session.js — INGEN database, INGEN
// netværkskald. Samme mønster/stil som tenant-session.test.js (se dens
// filhoved): sætter egne, deterministiske test-secrets FØR
// require('./tenant-session') (som admin-user-session.js selv requirer),
// og requirer BEVIDST aldrig admin-users.js (den fil udfører et REELT
// databasekald ved import, se dens "Filopdeling"-afsnit).

'use strict';
const assert = require('assert');

process.env.TENANT_CONFIG_ENCRYPTION_KEY = '0'.repeat(64); // 32 byte hex — deterministisk test-nøgle, ALDRIG en rigtig secret
process.env.ADMIN_SESSION_SECRET = 'test-session-secret-ikke-en-rigtig-hemmelighed';

const {
  signStaffSession, verifyStaffSession,
  buildStaffSessionSetCookieHeader, buildClearStaffSessionSetCookieHeader,
  requireStaffSession, STAFF_SESSION_COOKIE_NAME,
} = require('./admin-user-session');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

// ── signStaffSession / verifyStaffSession ────────────────────────────────
test('sign→verify: system-konto giver adminUserId/email/role tilbage, countryCode=null', () => {
  const cookie = signStaffSession({ adminUserId: 'u-1', email: 'kresten@ditbadevand.dk', role: 'system', countryCode: null });
  const result = verifyStaffSession(cookie);
  assert.deepStrictEqual(result, { adminUserId: 'u-1', email: 'kresten@ditbadevand.dk', role: 'system', countryCode: null });
});
test('sign→verify: country-konto bevarer sit countryCode', () => {
  const cookie = signStaffSession({ adminUserId: 'u-2', email: 'uk-lead@ditbadevand.dk', role: 'country', countryCode: 'UK' });
  const result = verifyStaffSession(cookie);
  assert.strictEqual(result.role, 'country');
  assert.strictEqual(result.countryCode, 'UK');
});
test('verify: en tenant-session (signSession fra tenant-session.js) er IKKE en gyldig staff-session', () => {
  // De to cookie-typer deler kryptografisk mekanisme (samme HMAC-nøgle),
  // men staff-payloaden kræver adminUserId+role — en tenant-session
  // (tenantId+authMethod) mangler begge og skal derfor afvises, ikke
  // fejlagtigt accepteres som en (forkert udfyldt) staff-session.
  const tenantSession = require('./tenant-session');
  const tenantCookie = tenantSession.signSession({ tenantId: 'abc-123', authMethod: 'trial' });
  assert.strictEqual(verifyStaffSession(tenantCookie), null);
});
test('verify: manipuleret payload afvises', () => {
  const cookie = signStaffSession({ adminUserId: 'u-1', email: 'a@b.dk', role: 'system', countryCode: null });
  const [payloadB64, sig] = cookie.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  payload.role = 'system-men-ondsindet';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;
  assert.strictEqual(verifyStaffSession(forged), null);
});
test('verify: udløbet session afvises', () => {
  const payload = { adminUserId: 'u-1', role: 'system', countryCode: null, iat: Date.now() - 100000, exp: Date.now() - 1000 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = require('crypto').createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payloadB64).digest('hex');
  assert.strictEqual(verifyStaffSession(payloadB64 + '.' + sig), null);
});
test('verify: tomt/ugyldigt/manglende input afvises uden at kaste', () => {
  assert.strictEqual(verifyStaffSession(undefined), null);
  assert.strictEqual(verifyStaffSession(''), null);
  assert.strictEqual(verifyStaffSession('ikke-en-gyldig-cookie'), null);
});

// ── Cookie-headers ────────────────────────────────────────────────────────
test('buildStaffSessionSetCookieHeader: bruger eget cookienavn og Path=/internal (ikke /admin)', () => {
  const header = buildStaffSessionSetCookieHeader('nogen-vaerdi');
  assert.ok(header.startsWith(`${STAFF_SESSION_COOKIE_NAME}=`));
  assert.ok(header.includes('Path=/internal'));
  assert.ok(!header.includes('Path=/admin'));
});
test('buildClearStaffSessionSetCookieHeader: Max-Age=0', () => {
  assert.ok(buildClearStaffSessionSetCookieHeader().includes('Max-Age=0'));
});

// ── requireStaffSession middleware ───────────────────────────────────────
function fakeReqRes(cookieHeader) {
  const req = { headers: { cookie: cookieHeader }, accepts: () => 'json' };
  const res = {
    statusCode: null, jsonBody: null, redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
    redirect(url) { this.redirectedTo = url; return this; },
  };
  return { req, res };
}
test('requireStaffSession: gyldig cookie sætter req.staff og kalder next()', () => {
  const cookie = signStaffSession({ adminUserId: 'u-1', email: 'a@b.dk', role: 'system', countryCode: null });
  const { req, res } = fakeReqRes(`${STAFF_SESSION_COOKIE_NAME}=${encodeURIComponent(cookie)}`);
  let nextCalled = false;
  requireStaffSession(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.staff.adminUserId, 'u-1');
});
test('requireStaffSession: manglende cookie svarer 401 uden at kalde next()', () => {
  const { req, res } = fakeReqRes(undefined);
  let nextCalled = false;
  requireStaffSession(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
