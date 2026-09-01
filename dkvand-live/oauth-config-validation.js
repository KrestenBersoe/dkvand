// ═══════════════════════════════════════════════════════════════════════════
// oauth-config-validation.js — Kommunepakke, modul 2: rene valideringsfunktioner
// for kommunens selvbetjente OAuth-konfigurationsflow
// ═══════════════════════════════════════════════════════════════════════════
//
// Bevidst UDEN afhængighed af db.js/net-kald — rene, deterministiske
// funktioner, direkte unit-testbare (se oauth-config-validation.test.js),
// samme princip som tenant-session.js i modul 1. Den faktiske Discovery
// URL-hentning (netværks-I/O) ligger i tenant-admin.js's validateDiscoveryUrl()
// — DEN bruger isPrivateOrDisallowedIp() herfra som byggesten, men selve
// DNS-opslaget/HTTP-kaldet kan ikke være en ren funktion.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const net = require('net');

const PROVIDER_TYPES = ['entra_id', 'mitid_erhverv', 'keycloak', 'custom'];
function isValidProviderType(v) {
  return PROVIDER_TYPES.includes(v);
}

// Simpelt "noget.tld"-mønster — bevidst IKKE en fuld RFC 1035-parser (ingen
// eksisterende afhængighed til det, og domænenavne til e-mail-matching har
// ikke brug for at afvise fx underscore eller validere label-længder helt
// præcist). Kræver mindst ét punktum og kun gyldige domænetegn.
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Splitter på komma/linjeskift, strip evt. foranstillet "@" (brugeren kan
 * naturligt taste "@kommune.dk" eller "kommune.dk" — begge accepteret),
 * lowercase, dedupe. Kaster med en klar, felt-specifik fejlbesked ved
 * ugyldigt input — kaldestedet (server.js's POST-handler) fanger og
 * returnerer den direkte til klienten.
 * @param {string} rawInput
 * @returns {string[]}
 */
function normalizeEmailDomains(rawInput) {
  const parts = String(rawInput || '')
    .split(/[,\n]/)
    .map(s => s.trim().replace(/^@/, '').toLowerCase())
    .filter(s => s.length > 0);
  if (parts.length === 0) {
    throw new Error('Angiv mindst ét tilladt e-maildomæne (fx kommune.dk).');
  }
  const unique = [...new Set(parts)];
  for (const domain of unique) {
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new Error(`"${domain}" ligner ikke et gyldigt domænenavn (fx kommune.dk).`);
    }
  }
  return unique;
}

// NYT (Kommunepakke, modul 3): genbruges af BÅDE /admin/logins indledende
// e-mail→tenant-opslag OG oauth-login.js's callback-genkontrol EFTER selve
// OAuth-godkendelsen (den faktisk AUTENTIFICEREDE e-mail kan afvige fra den,
// brugeren indtastede før omdirigeringen — begge steder skal tjekke
// uafhængigt, se planens login-flow-afsnit). Sammenligner udelukkende
// domænedelen, case-insensitivt — allowedDomains forventes allerede
// normaliseret (se normalizeEmailDomains()), men lowercases forsvarligt
// begge sider alligevel.
/**
 * @param {string} email
 * @param {string[]} allowedDomains
 * @returns {boolean}
 */
function emailMatchesAllowedDomains(email, allowedDomains) {
  if (typeof email !== 'string' || !Array.isArray(allowedDomains)) return false;
  const atIdx = email.lastIndexOf('@');
  if (atIdx < 0 || atIdx === email.length - 1) return false;
  const domain = email.slice(atIdx + 1).toLowerCase();
  return allowedDomains.some(d => String(d).toLowerCase() === domain);
}

// ── SSRF-beskyttelse: private/loopback/link-local/reserverede IP-ranges ────
// Bruges af tenant-admin.js's validateDiscoveryUrl() til at afvise en
// resolvet IP FØR noget HTTP-kald sker. Se planens "Ny sikkerhedsrisiko"-
// afsnit for den fulde begrundelse og den bevidst accepterede DNS-rebinding-
// begrænsning (to separate opslag, ikke pinnet forbindelse).
function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
function inCidr(ipInt, baseIp, prefixLen) {
  const baseInt = ipv4ToInt(baseIp);
  const mask = prefixLen === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}
// IANA "Special-Purpose Address Registry" — de blokke der er relevante at
// blokere for en server-side SSRF-kontekst (privat/loopback/link-local/
// carrier-NAT/dokumentation/benchmark/multicast/reserveret/broadcast).
const IPV4_DISALLOWED_CIDRS = [
  ['0.0.0.0', 8],       // "denne" netværk
  ['10.0.0.0', 8],      // privat (RFC 1918)
  ['100.64.0.0', 10],   // carrier-grade NAT (RFC 6598)
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local
  ['172.16.0.0', 12],   // privat (RFC 1918)
  ['192.0.0.0', 24],    // IETF-protokoltildelinger
  ['192.0.2.0', 24],    // dokumentation (TEST-NET-1)
  ['192.168.0.0', 16],  // privat (RFC 1918)
  ['198.18.0.0', 15],   // benchmark-test
  ['198.51.100.0', 24], // dokumentation (TEST-NET-2)
  ['203.0.113.0', 24],  // dokumentation (TEST-NET-3)
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserveret
  ['255.255.255.255', 32], // broadcast
];
function isDisallowedIpv4(ip) {
  const ipInt = ipv4ToInt(ip);
  return IPV4_DISALLOWED_CIDRS.some(([base, prefix]) => inCidr(ipInt, base, prefix));
}

function isDisallowedIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / uspecificeret
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local (ULA)
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  if (lower.startsWith('2001:db8:')) return true; // dokumentation

  // IPv4-mapped (::ffff:a.b.c.d) og NAT64 (64:ff9b::/96) indlejrer en reel
  // IPv4-adresse — SKAL tjekkes som IPv4 også, ellers kan en angriber
  // omgå hele IPv4-blokeringen ovenfor blot ved at skrive adressen i sin
  // IPv6-form.
  const mappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) return isDisallowedIpv4(mappedMatch[1]);
  const nat64Match = lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (nat64Match) return isDisallowedIpv4(nat64Match[1]);

  return false;
}

/**
 * @param {string} ip — allerede resolvet IP-adresse (IPv4 eller IPv6), IKKE et hostname
 * @returns {boolean} true hvis IP'en er privat/loopback/link-local/reserveret og derfor skal afvises
 */
function isPrivateOrDisallowedIp(ip) {
  if (net.isIPv4(ip)) return isDisallowedIpv4(ip);
  if (net.isIPv6(ip)) return isDisallowedIpv6(ip);
  return true; // ugyldig/ukendt IP-form — fail closed, ikke fail open
}

module.exports = {
  PROVIDER_TYPES,
  isValidProviderType,
  normalizeEmailDomains,
  emailMatchesAllowedDomains,
  isPrivateOrDisallowedIp,
};
