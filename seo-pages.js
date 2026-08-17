// ═══════════════════════════════════════════════════════════════════════════
// seo-pages.js — server-side rendering af Tier 1/2/3-siderne
// (/badested/:slug, /soe/:slug, /udloeb/:id) + sitemap.xml + OG-badges
// ═══════════════════════════════════════════════════════════════════════════
//
// Genbruger den ALLEREDE cachede, komprimerede app-shell (server.js's
// getCompressedHtml()) som base — INGEN ny templating-motor. To ting
// injiceres, begge via simple, streng-ankrede .replace()-kald på allerede
// kendte, stabile understrenge i dansk-overloeb-kort.html:
//   1. <title> + en blok nye meta-tags (description/OG/canonical/JSON-LD/
//      robots), indsat lige efter <title>.
//   2. For Tier 1/2 ALENE: en synlig, semantisk #ssr-content-blok lige
//      efter <body> åbner (rigtigt indhold i det RÅ svar, ikke kun efter en
//      efterfølgende JS-fetch), samt et lille window.__SSR_ROUTE__-script
//      så klienten kan åbne det korrekte panel uden selv at slå slug op.
//
// Risiko-farver/labels HOLDES I SYNC med klientens riskStyle()/riskLabel()
// (dansk-overloeb-kort.html) — samme tærskler (0.6/0.2), samme hex-farver.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const SITE_URL = 'https://www.ditbadevand.dk';

// Samme tærskler/farver som klientens riskStyle()/riskLabel() — se filhoved.
function riskInfo(risk) {
  if (risk === null || risk === undefined) return { label: 'Ingen data', color: '#1a6faf', pct: null };
  if (risk >= 0.6) return { label: 'Høj risiko',     color: '#c84b1f', pct: Math.round(risk * 100) };
  if (risk >= 0.2) return { label: 'Moderat risiko', color: '#d4a020', pct: Math.round(risk * 100) };
  return              { label: 'Lav risiko',       color: '#2d7d4f', pct: Math.round(risk * 100) };
}

// Datakonfidens — HOLDES I SYNC med klientens CONFIDENCE_META (dansk-
// overloeb-kort.html) og badevand-risk.js's deriveDataConfidence(), som er
// den ENESTE kilde, der reelt afgør tier'en — dette er kun visnings-tekst.
const CONFIDENCE_META = {
  'hoej':       { label: 'Høj',        text: 'Bekræftet eller direkte strømmålt kilde tæt på lokationen.' },
  'middel':     { label: 'Middel',     text: 'Baseret på en modelantagelse om spredningshastighed/afstand, ikke en direkte strømmåling.' },
  'lav':        { label: 'Lav',        text: 'Baseret på en usikker strømretning eller en kilde langt fra lokationen.' },
  'ingen-data': { label: 'Ingen data', text: 'Intet grundlag for en aktuel vurdering lige nu.' },
};
/** Returnerer null hvis tier er ukendt/fraværende (fx sø-siderne, som endnu ikke har et dataConfidence-felt, se describeSoeRisk()). */
function describeDataConfidence(tier) {
  const meta = CONFIDENCE_META[tier];
  if (!meta) return null;
  return { tier, label: meta.label, text: `Datakonfidens: ${meta.label} — ${meta.text}` };
}

// Samme tekst som klientens confirmReasonTooltipText() — se dansk-overloeb-
// kort.html for hvorfor de tre grunde er reelt forskellige bekræftelser.
function confirmReasonText(reason) {
  if (reason === 'id15-empty')     return 'Ingen kendte spildevandsudledninger i oplandet (ID15-bekræftet)';
  if (reason === 'all-stormwater') return 'Ingen kendte spildevandsudledninger i nærheden (kun regnvandsudløb)';
  if (reason === 'no-candidates')  return 'Ingen registrerede udløb i nærheden';
  return 'Ingen kendte spildevandsudledninger i nærheden';
}

function riskFromBactViral(entry) {
  const active = [entry.bact, entry.viral].filter(v => v !== null && v !== undefined);
  const risk = active.length ? Math.max(...active) : null;
  const { label, pct } = riskInfo(risk);
  if (pct === null) return { label, text: 'Der mangler pt. nedbørsdata til at beregne en aktuel risiko.' };
  return { label, text: `Aktuel forureningsrisiko: ${label.toLowerCase()} (${pct}%), baseret på nedbør og nærliggende overløbsudledninger.` };
}

/**
 * Badested-udgaven — badevandRiskCache.badevand[]-entries bruger `source`
 * (streng: 'soe'|'kystvand'|'nedstroms-bekraeftet'|'ingen-bekraeftet'|'ingen')
 * + `noDataMatch`, IKKE en confirmedNoOutlet-boolean (den findes kun på
 * lakes{}/kystvande{}, se describeSoeRisk() nedenfor). Replikerer PRÆCIST
 * samme fem grene som klientens colorBadevandByRisk() (dansk-overloeb-
 * kort.html) — se dens kommentarer for den fulde begrundelse pr. gren.
 * BEVIDST holdt adskilt fra describeSoeRisk() fremfor ét fælles, duck-typet
 * forsøg — de to kilder har reelt forskellig form, og denne tekst indgår i
 * en OFFENTLIGT INDEKSERET side, hvor en forkert sammenblanding er værre
 * end i en klient-tooltip.
 */
function describeBadestedRisk(entry) {
  if (!entry) return { label: 'Ingen data', text: 'Der er ikke fundet nogen aktuel risikovurdering for dette sted endnu.' };
  if (entry.source === 'ingen-bekraeftet') {
    return { label: 'Lav risiko', text: confirmReasonText(entry.confirmReason) + '.' };
  }
  if (entry.source === 'nedstroms-bekraeftet') {
    return { label: 'Lav risiko', text: 'Kendte udløb er lige nu strømbekræftet nedstrøms — ingen aktuel kilde mod badestedet.' };
  }
  if (entry.source === 'ingen' && !entry.noDataMatch) {
    return { label: 'Lav risiko', text: 'Ingen registrerede udløb, som udleder til denne lokation.' };
  }
  return riskFromBactViral(entry);
}

/**
 * Sø-udgaven — badevandRiskCache.lakes[navn]-entries har derimod en
 * boolean `confirmedNoOutlet` + `confirmReason` direkte (se badevand-
 * risk.js's opbygning af lakes{}), en simplere to-vejs gren.
 */
function describeSoeRisk(entry) {
  if (!entry) return { label: 'Ingen data', text: 'Der er ikke fundet nogen aktuel risikovurdering for denne sø endnu.' };
  if (entry.confirmedNoOutlet) {
    return { label: 'Lav risiko', text: confirmReasonText(entry.confirmReason) + '.' };
  }
  return riskFromBactViral(entry);
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Injicerer titel + meta-tags i den allerede cachede app-shell (raw HTML-
 * streng, se server.js's getCompressedHtml()). `robotsContent` er valgfri —
 * udelades for Tier 1/2 (skal indekseres, default-adfærd), sat til
 * 'noindex, follow' for Tier 3.
 */
function injectHead(html, { title, description, canonicalPath, ogImagePath, robotsContent, jsonLd }) {
  const canonical = `${SITE_URL}${canonicalPath}`;
  const metaBlock = [
    `<meta name="description" content="${escHtml(description)}">`,
    robotsContent ? `<meta name="robots" content="${escHtml(robotsContent)}">` : '',
    `<link rel="canonical" href="${escHtml(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escHtml(title)}">`,
    `<meta property="og:description" content="${escHtml(description)}">`,
    `<meta property="og:url" content="${escHtml(canonical)}">`,
    ogImagePath ? `<meta property="og:image" content="${escHtml(SITE_URL + ogImagePath)}">` : '',
    jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : '',
  ].filter(Boolean).join('\n');

  let out = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escHtml(title)}</title>\n${metaBlock}`
  );
  return out;
}

/** Kun for Tier 3 (/udloeb/:id) — ingen data-forudfyldning, kun robots-metaen. */
function injectRobotsOnly(html, canonicalPath) {
  const canonical = `${SITE_URL}${canonicalPath}`;
  return html.replace(
    /<title>([^<]*)<\/title>/,
    `<title>$1</title>\n<meta name="robots" content="noindex, follow">\n<link rel="canonical" href="${escHtml(canonical)}">`
  );
}

// Kommunepakke, modul 6 — SAMME styling/tekst som klientens
// OVERRIDE_BUCKET_META/renderOverrideBanner() (dansk-overloeb-kort.html),
// holdt manuelt i sync (ingen fælles modul, samme "duplikeret men bevidst
// adskilt" begrundelse som riskInfo() ovenfor). Server-renderet HER er
// afgørende for reel synlighed: en søgemaskine-bruger, der lander direkte
// på /badested/:slug under en reel lukning, skal se advarslen i det RÅ
// svar, uden at vente på klient-JS.
const OVERRIDE_BUCKET_META = {
  groen:  { label: 'God badevandskvalitet', bg: '#e8f5ec', border: '#2d7d4f', text: '#1f5c39' },
  gul:    { label: 'Moderat risiko',         bg: '#fdf3dd', border: '#d4a020', text: '#8a6a14' },
  roed:   { label: 'Høj risiko',             bg: '#fbe9e4', border: '#c84b1f', text: '#8f3615' },
  lukket: { label: 'LUKKET FOR BADNING',     bg: '#3a1410', border: '#c84b1f', text: '#ffe4dc' },
};
function buildOverrideBannerHtml(overrideInfo) {
  if (!overrideInfo) return '';
  const meta = OVERRIDE_BUCKET_META[overrideInfo.bucket] || OVERRIDE_BUCKET_META.roed;
  const expiresStr = overrideInfo.expiresAt
    ? new Date(overrideInfo.expiresAt).toLocaleString('da-DK', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : null;
  const logoHtml = overrideInfo.logoUrl
    ? `<img src="${escHtml(overrideInfo.logoUrl)}" alt="" style="max-height:32px;max-width:120px;object-fit:contain" onerror="this.style.display='none'">`
    : '';
  return `
  <div style="background:${meta.bg};border:2px solid ${meta.border};border-radius:10px;padding:.9rem 1rem;margin-bottom:1.2rem">
    <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem">
      ${logoHtml}
      <div style="font-weight:800;font-size:.95rem;color:${meta.text};text-transform:uppercase;letter-spacing:.03em">${escHtml(meta.label)}</div>
    </div>
    <div style="color:${meta.text};font-size:.88rem;line-height:1.4;margin-bottom:.5rem">${escHtml(overrideInfo.message)}</div>
    <div style="color:${meta.text};opacity:.75;font-size:.72rem">
      Sat af ${escHtml(overrideInfo.tenantName || 'kommunen')}${expiresStr ? ` — gælder til ${expiresStr}` : ''}
    </div>
  </div>`;
}

/**
 * Synligt, crawlbart indhold lige efter <body> åbner — se filhoved for
 * hvorfor dette er en SEPARAT blok, ikke et forsøg på at forhåndsudfylde
 * den eksisterende, JS-vedligeholdte #badevand-panel-DOM. Klienten skjuler
 * denne blok, når det rigtige panel åbnes (se dansk-overloeb-kort.html).
 */
// Kommune- og afstands-baserede "andre badesteder"-lister (bruger-ønske
// 2026-08-17, samme SEO-rettelse som getSsrShellHtml() — se dens filhoved):
// begge peger på /badested/:slug og er derfor ægte, crawlbare interne links
// (samme begrundelse som buildSitelinksHtml(), blot synlige her i stedet
// for skjulte) — IKKE et forsøg på at duplikere selve kortets nabo-søgning,
// kun en tekst-liste. `items` er allerede filtreret/sorteret/afkortet af
// kaldestedet (server.js) — denne funktion formaterer blot.
function buildNearbyListHtml(heading, items) {
  if (!items || !items.length) return '';
  const li = items.map(b => `<li><a href="/badested/${escHtml(b.slug)}">${escHtml(b.navn)}</a></li>`).join('');
  return `<h2>${escHtml(heading)}</h2><ul>${li}</ul>`;
}

// Lokation/rutevejledning (bruger-ønske 2026-08-17) — samme keyless
// Google Maps-URL-mønster som klienten allerede bruger to steder
// (dansk-overloeb-kort.html's mapsLink/deep-links til "Åbn i Google Maps"),
// bevidst genbrugt fremfor Maps Embed API — intet API-nøgle-/GCP-setup at
// vedligeholde. output=embed er uofficiel men mangeårig og bredt brugt.
function buildLocationHtml(lat, lng) {
  if (lat == null || lng == null) return '';
  const q = `${lat},${lng}`;
  return `
  <h2>Lokation</h2>
  <p style="border:1px solid #d7dee3;border-radius:10px;overflow:hidden;line-height:0">
    <iframe src="https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=15&output=embed" width="100%" height="280" style="border:0" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Kort over ${escHtml(q)}"></iframe>
  </p>
  <p><a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}" target="_blank" rel="noopener">Få rutevejledning →</a></p>`;
}

function buildSsrContent({ navn, kommune, riskText, updatedAt, outlets, confidenceText, overrideInfo, lat, lng, nearbyKommune, nearbyDistance, vurderingCount30d }) {
  // NYT (ustabil-id-rettelse — se server.js's loadPulsPointsFull()):
  // bruger outfallId (stabil GUID) i stedet for o.id (rækkeindekset) til
  // selve linket — dette er server-renderet, crawlbart HTML, indekseret af
  // søgemaskiner og potentielt bogmærket direkte af brugere. Et
  // rækkeindeks-baseret link her ville forblive KORREKT lige nu, men
  // uigenkaldeligt pege på et andet, forkert udløb efter blot ÉN
  // dataopdatering (samme klasse fejl som "F-U9 i Furesø" åbnede et udløb
  // i Odense) — modsat klient-cachede referencer er dette link permanent,
  // det kan ikke "opdage" at det er blevet forældet.
  // NYT (opstrøms sø/kystvand-propagering — se badevand-risk.js's
  // lakeEdges-afsnit): syntetiske "opstrøms sø"-udløb har hverken id eller
  // outfallId (de er ikke et enkelt PULS-punkt) — vist som ren tekst i
  // stedet for et /udloeb/-link, der ellers ville pege på "/udloeb/null".
  const outletLinks = (outlets || []).slice(0, 20).map(o =>
    (o.outfallId || o.id) != null
      ? `<li><a href="/udloeb/${escHtml(o.outfallId || o.id)}">${escHtml(o.name || `Udløb ${o.id}`)}</a></li>`
      : `<li>${escHtml(o.name || 'Opstrøms kilde')}</li>`
  ).join('');
  // Badestedsvurdering (bruger-ønske 2026-08-17) — kun vist når > 0 (se
  // server.js's vurderingCount30dCache-filhoved for hvorfor): en "0
  // vurderinger"-sætning ville selv blive en ny, boilerplate-agtig sætning
  // gentaget på tværs af de fleste lav-trafik badesteder, stik imod hele
  // formålet med denne rettelse.
  const vurderingHtml = vurderingCount30d > 0
    ? `<h2>Badestedsvurdering</h2><p>${vurderingCount30d} ${vurderingCount30d === 1 ? 'vurdering' : 'vurderinger'} fra besøgende de seneste 30 dage.</p>`
    : '';
  return `
<div id="ssr-content" style="max-width:640px;margin:0 auto;padding:2rem 1.2rem;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a2733">
  ${buildOverrideBannerHtml(overrideInfo)}
  <h1>${escHtml(navn)}${kommune ? ` — ${escHtml(kommune)}` : ''}</h1>
  <p>${escHtml(riskText)}</p>
  ${confidenceText ? `<p style="color:#5a6b78;font-size:.85rem">${escHtml(confidenceText)}</p>` : ''}
  <p style="color:#5a6b78;font-size:.85rem">Sidst opdateret: ${escHtml(updatedAt)}</p>
  ${outletLinks ? `<h2>Udløb der påvirker dette sted</h2><ul>${outletLinks}</ul>` : ''}
  ${vurderingHtml}
  ${buildLocationHtml(lat, lng)}
  ${buildNearbyListHtml('Badesteder i nærheden', nearbyDistance)}
  ${buildNearbyListHtml(kommune ? `Andre badesteder i ${kommune}` : 'Andre badesteder i kommunen', nearbyKommune)}
</div>`;
}

/** Slår window.__SSR_ROUTE__ ind, så klienten slipper for slug→id-opslag. */
function buildSsrRouteScript(route) {
  return `<script>window.__SSR_ROUTE__=${JSON.stringify(route)};</script>`;
}

function injectBodyContent(html, bodyHtml) {
  return html.replace('<body>', `<body>${bodyHtml}`);
}

/**
 * `dataset`, hvis givet, tilføjes som subjectOf: Dataset — de modelberegnede
 * risikoestimater ER et selvstændigt datasæt om stedet (Place), ikke
 * egenskaber ved selve stedet. `dataset.temporalCoverage` skal være
 * badevandRiskCache.ts (samme tidsstempel som "Sidst opdateret" i
 * #ssr-content, se buildSsrContent()) — IKKE Date.now() ved render-
 * tidspunktet, som ville stemple hver eneste request som "lige nu", selvom
 * dataene reelt kun opdateres hvert 15. minut (se server.js's
 * WEATHER_CHECK_INTERVAL_MS).
 */
function buildJsonLd({ name, lat, lng, addressLocality, description, dataset }) {
  const place = {
    '@context': 'https://schema.org',
    '@type': 'Place',
    name,
    ...(description ? { description } : {}),
    ...(addressLocality ? { address: { '@type': 'PostalAddress', addressLocality } } : {}),
    ...(lat != null && lng != null ? { geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lng } } : {}),
  };
  if (dataset) {
    place.subjectOf = {
      '@type': 'Dataset',
      name: dataset.name,
      ...(dataset.description ? { description: dataset.description } : {}),
      ...(dataset.temporalCoverage ? { temporalCoverage: dataset.temporalCoverage } : {}),
      provider: { '@type': 'Organization', name: 'Danmarks Vandmiljø', url: SITE_URL },
      ...(dataset.variableMeasured ? { variableMeasured: dataset.variableMeasured } : {}),
    };
  }
  return place;
}

/** Let, håndrullet SVG-badge til og:image — se planens begrundelse for hvorfor SVG (ikke PNG) i første omgang. */
function buildOgSvg({ navn, kommune, label, color }) {
  const W = 1200, H = 630;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0d1720"/>
  <rect x="0" y="0" width="${W}" height="14" fill="${color}"/>
  <text x="80" y="220" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="30" fill="#4fb8d6" font-weight="700">DIT BADEVAND</text>
  <text x="80" y="330" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="64" fill="#f0ede6" font-weight="800">${escHtml(navn)}</text>
  ${kommune ? `<text x="80" y="385" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="30" fill="#9fb0bb">${escHtml(kommune)}</text>` : ''}
  <rect x="80" y="440" width="26" height="26" rx="6" fill="${color}"/>
  <text x="118" y="461" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="30" fill="#f0ede6" font-weight="600">${escHtml(label)}</text>
</svg>`;
}

/**
 * Punkt 5 (planen) — "intern linking": et skjult, men EGTE crawlbart
 * <a href>-link pr. Tier 1/2-side, så Google kan crawle sig ind til alle
 * ~2.024 sider via almindelige links, ikke kun via sitemap.xml/JS-
 * klik-handlere på selve kort-markørerne (som ikke er rigtige DOM-anchors —
 * kortet er Canvas/SVG-renderet, se dansk-overloeb-kort.html's
 * pointsPane-filhoved). Bygges ÉN gang ved opstart (samme livscyklus som
 * slug-index/sitemap selv) og injiceres i den ALLEREDE cachede app-shell
 * (server.js's getCompressedHtml()) FØR gzip/brotli beregnes — nul
 * pr.-request-omkostning, samme princip som selve komprimeringen.
 *
 * Visuelt skjult (position:absolute, 1×1px, clip) — IKKE display:none
 * (som visse crawlere behandler som et signal om skjult/spam-indhold) —
 * standard, legitim teknik for navigation til indhold der ellers kun er
 * tilgængeligt via et Canvas-renderet kort, ikke en forsøg på cloaking:
 * indholdet (badested-/sø-navnet) er identisk med hvad en bruger reelt ser.
 */
function buildSitelinksHtml(badestedSlugToInfo, soeSlugToInfo) {
  const badestedLinks = [...badestedSlugToInfo.entries()]
    .map(([slug, info]) => `<a href="/badested/${slug}">${escHtml(info.navn)}</a>`).join('');
  const soeLinks = [...soeSlugToInfo.entries()]
    .map(([slug, info]) => `<a href="/soe/${slug}">${escHtml(info.navn)}</a>`).join('');
  return `<nav id="seo-sitelinks" aria-hidden="true" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">${badestedLinks}${soeLinks}</nav>`;
}

// FJERNET (bruger-ønske): priority (og changefreq/lastmod, der aldrig var
// med) er droppet — Google ignorerer priority-attributten helt, den fyldte
// kun op i et sitemap med ~2.000 URL'er.
function buildSitemapXml(urls) {
  const items = urls.map(({ loc }) => `  <url><loc>${escHtml(loc)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>`;
}

module.exports = {
  SITE_URL,
  riskInfo,
  describeBadestedRisk,
  describeSoeRisk,
  describeDataConfidence,
  injectHead,
  injectRobotsOnly,
  buildSsrContent,
  buildSsrRouteScript,
  injectBodyContent,
  buildJsonLd,
  buildOgSvg,
  buildSitemapXml,
  buildSitelinksHtml,
};
