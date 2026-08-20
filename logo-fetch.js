// ═══════════════════════════════════════════════════════════════════════════
// logo-fetch.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Kommune Dashboard, "Skilte"-fanen (bruger-ønske 2026-08-19) — SSRF-sikker
// hentning af en tenants `logo_url` (tenants.logo_url, tenant-admin.js),
// til at flette ind i de server-genererede PDF-skilte.
//
// VIGTIGT: dette er FØRSTE sted i kodebasen, hvor `logo_url` nogensinde
// hentes SERVER-SIDE — feltet er kun valideret til at starte med https://
// ved oprettelse (se tenant-admin.js's createTenant()'s filhoved-kommentar:
// "hentes DIREKTE af borgerens browser <img src>, aldrig server-side, så
// modul 2's SSRF-beskyttelse er ikke relevant her"). Den antagelse holder
// ikke længere for DENNE feature — samme fire-lags SSRF-mønster som
// tenant-admin.js's fetchDiscoveryDocument() (OAuth discovery-URL'er)
// genbruges derfor 1:1, portet fra JSON-dokumenter til billed-bytes:
//   1. Kun https:// tilladt.
//   2. DNS-opslag FØR forbindelse — ALLE resolverede adresser tjekkes mod
//      oauth-config-validation.js's isPrivateOrDisallowedIp() (fail closed).
//   3. Forbindelsen PINNES til den validerede adresse (https.get's
//      `lookup`-option) — lukker DNS-rebinding-TOCTOU'en en naiv
//      "slå op, så fetch(url)" ellers ville have.
//   4. Kort timeout (5s) + loft på svarstørrelse (3 MB — et logo er et
//      billede, ikke et par KB JSON, deraf det højere loft end
//      discovery-dokumentets 100 KB).
// Kaster ALDRIG — kun {ok:false}, som kaldestedet (server.js's PDF-rute)
// bruger til at generere skiltet UDEN logo i stedet for at fejle helt,
// samme "vis skiltet alligevel"-filosofi som klientens eget
// onerror="this.style.display='none'" for det samme URL-felt.

'use strict';
const https = require('https');
const dns = require('dns');
const sharp = require('sharp');
const oauthValidation = require('./oauth-config-validation');

const LOGO_FETCH_TIMEOUT_MS = 5000;
const LOGO_MAX_BYTES = 3 * 1024 * 1024;
// RETTET (bruger-krav 2026-08-20 — "vi skal kunne understøtte svg format i
// tillæg til jpg og png"): flere kommuners logo_url peger på en SVG (fx
// Bornholms Regionskommune) — blev tidligere stille afvist her, hvilket
// betød PDF-skiltet blev genereret UDEN logo, uden nogen fejl nogen
// steder (samme "vis skiltet alligevel"-filosofi gjorde fejlen usynlig).
// pdfkit's doc.image() understøtter selv KUN PNG/JPEG (ingen SVG/vektor-
// understøttelse) — SVG rastereres derfor til PNG nedenfor (se
// rasterizeIfSvg()), FØR bufferen når skilte.js.
const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);

// NYT — rasterer en SVG-buffer til PNG ved 300 DPI (print-kvalitet, rigelig
// margin til skilte.js's `fit: [120, 50]`-nedskalering — pdfkit skalerer
// NED fra en skarp kilde, aldrig op fra en sløret). Ikke-SVG-buffere
// returneres UÆNDREDE. Kaster ALDRIG — samme "returnér null/uændret i
// stedet for at vælte kaldestedet"-filosofi som resten af denne fil.
async function rasterizeIfSvg(buffer, contentType) {
  if (contentType !== 'image/svg+xml') return buffer;
  try {
    return await sharp(buffer, { density: 300 }).png().toBuffer();
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} rawUrl
 * @returns {Promise<{ok: true, buffer: Buffer}|{ok: false}>}
 */
async function fetchTenantLogo(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return { ok: false };
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (e) { return { ok: false }; }
  if (parsed.protocol !== 'https:') return { ok: false };

  let addresses;
  try {
    addresses = await dns.promises.lookup(parsed.hostname, { all: true });
  } catch (e) {
    return { ok: false };
  }
  if (!addresses || addresses.length === 0) return { ok: false };
  for (const { address } of addresses) {
    if (oauthValidation.isPrivateOrDisallowedIp(address)) return { ok: false };
  }
  // Samme IPv4-foretrækkende pinning som fetchDiscoveryDocument() —
  // se dens filhoved for hvorfor (bekræftet IPv6-hæng i produktions-
  // sandboxen for et ellers identisk engangs-server-til-server-kald).
  const ipv4Address = addresses.find(a => a.family === 4);
  const chosen = ipv4Address || addresses[0];
  const pinnedAddress = chosen.address;
  const pinnedFamily = chosen.family;

  return new Promise(resolve => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    const req = https.get(parsed, {
      timeout: LOGO_FETCH_TIMEOUT_MS,
      lookup: (_hostname, opts, cb) => {
        if (opts && opts.all) return cb(null, [{ address: pinnedAddress, family: pinnedFamily }]);
        cb(null, pinnedAddress, pinnedFamily);
      },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return settle({ ok: false }); }
      const contentType = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) { res.resume(); return settle({ ok: false }); }

      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > LOGO_MAX_BYTES) {
          settle({ ok: false });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', async () => {
        if (settled) return;
        const raw = Buffer.concat(chunks);
        const png = await rasterizeIfSvg(raw, contentType);
        if (png === null) { settle({ ok: false }); return; }
        settle({ ok: true, buffer: png });
      });
      res.on('error', () => settle({ ok: false }));
    });
    req.on('timeout', () => { req.destroy(); settle({ ok: false }); });
    req.on('error', () => settle({ ok: false }));
  });
}

module.exports = { fetchTenantLogo };
