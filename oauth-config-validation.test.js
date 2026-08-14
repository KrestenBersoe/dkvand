#!/usr/bin/env node
// oauth-config-validation.test.js — kør fra repo-roden:
//   node oauth-config-validation.test.js
// Rene enhedstests — INGEN database, INGEN netværkskald.

'use strict';
const assert = require('assert');
const {
  PROVIDER_TYPES, isValidProviderType,
  normalizeEmailDomains, isPrivateOrDisallowedIp,
} = require('./oauth-config-validation');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

// ── isValidProviderType ───────────────────────────────────────────────────
test('isValidProviderType: alle fire kendte typer accepteres', () => {
  for (const t of PROVIDER_TYPES) assert.strictEqual(isValidProviderType(t), true);
});
test('isValidProviderType: ukendt/tomt/undefined afvises', () => {
  assert.strictEqual(isValidProviderType('google'), false);
  assert.strictEqual(isValidProviderType(''), false);
  assert.strictEqual(isValidProviderType(undefined), false);
});

// ── normalizeEmailDomains ─────────────────────────────────────────────────
test('normalizeEmailDomains: komma-separeret, "@" strippet, lowercased', () => {
  assert.deepStrictEqual(
    normalizeEmailDomains('@Kommune.dk, Andet.dk'),
    ['kommune.dk', 'andet.dk']
  );
});
test('normalizeEmailDomains: linjeskift-separeret virker også', () => {
  assert.deepStrictEqual(
    normalizeEmailDomains('kommune.dk\nandet.dk'),
    ['kommune.dk', 'andet.dk']
  );
});
test('normalizeEmailDomains: dubletter fjernes', () => {
  assert.deepStrictEqual(
    normalizeEmailDomains('kommune.dk, kommune.dk, KOMMUNE.DK'),
    ['kommune.dk']
  );
});
test('normalizeEmailDomains: tomt input kaster', () => {
  assert.throws(() => normalizeEmailDomains(''), /Angiv mindst/);
  assert.throws(() => normalizeEmailDomains('   '), /Angiv mindst/);
  assert.throws(() => normalizeEmailDomains(undefined), /Angiv mindst/);
});
test('normalizeEmailDomains: ugyldigt domæne (intet punktum) kaster', () => {
  assert.throws(() => normalizeEmailDomains('ikke-et-domaene'), /gyldigt domænenavn/);
});
test('normalizeEmailDomains: en fuld e-mailadresse (ikke kun domæne) kaster', () => {
  assert.throws(() => normalizeEmailDomains('jens@kommune.dk'), /gyldigt domænenavn/);
});

// ── isPrivateOrDisallowedIp ────────────────────────────────────────────────
test('isPrivateOrDisallowedIp: offentlige IPv4-adresser accepteres', () => {
  assert.strictEqual(isPrivateOrDisallowedIp('8.8.8.8'), false);
  assert.strictEqual(isPrivateOrDisallowedIp('1.1.1.1'), false);
  assert.strictEqual(isPrivateOrDisallowedIp('93.184.216.34'), false);
});
test('isPrivateOrDisallowedIp: RFC 1918-private IPv4-ranges afvises', () => {
  assert.strictEqual(isPrivateOrDisallowedIp('10.0.0.1'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('10.255.255.255'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('172.16.0.1'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('172.31.255.255'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('172.32.0.1'), false); // lige UDENFOR 172.16.0.0/12
  assert.strictEqual(isPrivateOrDisallowedIp('192.168.1.1'), true);
});
test('isPrivateOrDisallowedIp: loopback/link-local IPv4 afvises', () => {
  assert.strictEqual(isPrivateOrDisallowedIp('127.0.0.1'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('169.254.169.254'), true); // cloud metadata-endpoint — SSRF-klassiker
});
test('isPrivateOrDisallowedIp: carrier-grade NAT/dokumentation/broadcast IPv4 afvises', () => {
  assert.strictEqual(isPrivateOrDisallowedIp('100.64.0.1'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('192.0.2.1'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('255.255.255.255'), true);
});
test('isPrivateOrDisallowedIp: IPv6 loopback/uspecificeret/link-local/ULA afvises', () => {
  assert.strictEqual(isPrivateOrDisallowedIp('::1'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('::'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('fe80::1'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('fd00::1'), true);
});
test('isPrivateOrDisallowedIp: offentlig IPv6 accepteres', () => {
  assert.strictEqual(isPrivateOrDisallowedIp('2606:4700:4700::1111'), false); // Cloudflare DNS
});
test('isPrivateOrDisallowedIp: IPv4-mapped IPv6 afsløres og tjekkes som IPv4 (kan ikke omgå blokeringen)', () => {
  assert.strictEqual(isPrivateOrDisallowedIp('::ffff:127.0.0.1'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('::ffff:10.0.0.1'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('::ffff:8.8.8.8'), false);
});
test('isPrivateOrDisallowedIp: NAT64-indlejret privat IPv4 afvises', () => {
  assert.strictEqual(isPrivateOrDisallowedIp('64:ff9b::169.254.169.254'), true);
});
test('isPrivateOrDisallowedIp: ugyldig/tom streng fejler LUKKET (afvises), ikke ÅBENT', () => {
  assert.strictEqual(isPrivateOrDisallowedIp(''), true);
  assert.strictEqual(isPrivateOrDisallowedIp('ikke-en-ip'), true);
  assert.strictEqual(isPrivateOrDisallowedIp('999.999.999.999'), true);
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
