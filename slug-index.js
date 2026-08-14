// ═══════════════════════════════════════════════════════════════════════════
// slug-index.js — navn-kommune-slugs for Tier 1 (badesteder) og Tier 2 (søer)
// ═══════════════════════════════════════════════════════════════════════════
//
// Bygger fire opslags-Map'er ÉN gang ved serveropstart (kaldes fra
// server.js), til de nye path-baserede routes (/badested/:slug, /soe/:slug)
// og til /sitemap.xml. Genopbygges IKKE ved runtime — vp3_badevand.geojson/
// vp3_soeer.geojson ændres kun via den offline update-all-data.sh-pipeline,
// aldrig af den kørende proces (samme antagelse som getBadevandCoordIndex()
// i server.js allerede gør for denne fil).
//
// Slug-skemaet (navn-kommune) er BEKRÆFTET mod de reelle, aktuelle data —
// ikke antaget: 0 kollisioner blandt 1.033 badesteder med kommune-match
// (985 søer: samme, 0 kollisioner). Kollisions-håndteringen nedenfor er
// derfor et sikkerhedsnet for FREMTIDIGE data, ikke en løsning på et
// eksisterende problem.
//
// Kortene gemmer bevidst navn/kommune/lat/lng SAMMEN med selve slug'et
// (ikke kun et id) — badevand-risk.js's cascade-resultat (badevandRiskCache)
// indeholder KUN risikotal, aldrig navn/kommune, og denne fil er allerede
// den ENESTE, der læser badevand-analyseresultater.json/vp3_soeer.geojson
// for at generere selve slug'et. At gemme det udledte navn/kommune/lat/lng
// her, i stedet for at parse de samme kildefiler igen i server.js's route-
// handlers, undgår dobbelt fil-parsing pr. request.
//
// slugify() eksporteres bevidst også som ren funktion — klienten
// (dansk-overloeb-kort.html) duplikerer en IDENTISK kopi til brug ved
// hash→path-omdirigering og intern linking på selve kortet (kan ikke
// importere denne fil direkte, ingen build-trin/modulsystem i browseren).
// HOLD DE TO I SYNC, samme princip som VANDLOB_BUFFER_DEG-mønsteret
// allerede bruger andre steder i appen.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const fs   = require('fs');
const path = require('path');
const waterClass = require('./water-classification');

function slugify(navn, kommuneOrNull) {
  const kom = (kommuneOrNull || '').replace(/\s*kommune\s*$/i, '').trim();
  const raw = kom ? `${navn}-${kom}` : String(navn);
  return raw
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip resterende diakritiske tegn
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Tilføjer et unikt løbenummer (-2, -3, …), hvis slug'et allerede er brugt —
// sikkerhedsnet, se filhoved. Rammer 0 sites i dagens data.
function dedupeSlug(baseSlug, usedSlugs) {
  if (!usedSlugs.has(baseSlug)) return baseSlug;
  let n = 2;
  while (usedSlugs.has(`${baseSlug}-${n}`)) n++;
  return `${baseSlug}-${n}`;
}

// NYT (Kommunepakke, modul 4): normaliseret nøgle til tenant↔badested-
// matchning (se tenant-badesteder.js) — kommune-feltet i kildedata er
// INKONSISTENT ("Odense Kommune", "KØBENHAVNS KOMMUNE", "Aarhus kommune"),
// og en tenants `name` (frit tekstfelt, sat manuelt via
// scripts/create-tenant-trial.js) skal kunne matches mod det uanset
// forskellig store/små bogstaver og "kommune"-suffiks.
//
// BEVIDST EN SELVSTÆNDIG, DUPLIKERET udgave af slugify()'s tilsvarende
// normalisering — ikke delt/genbrugt kode. slugify() er allerede
// verificeret mod reelle data (0 kollisioner, se filhoved) og bruges af
// den etablerede URL-arkitektur (/badested/:slug); at dele normaliserings-
// logikken mellem de to ville risikere at ændre slugify()'s adfærd for et
// helt andet formål. De få linjer duplikeret kode her er en langt mindre
// risiko end det.
//
// Eksempler: normalizeKommuneKey("Odense Kommune") === normalizeKommuneKey("ODENSE KOMMUNE") === normalizeKommuneKey("Odense") === "odense".
function normalizeKommuneKey(s) {
  return String(s || '')
    .replace(/\s*kommune\s*$/i, '')
    .trim()
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildBadestedSlugs(staticDir) {
  const badestedSlugToInfo = new Map(); // slug -> {id, navn, kommune, lat, lng}
  const idToBadestedSlug   = new Map();
  // NYT (Kommunepakke, modul 4): normaliseret kommune-nøgle -> liste af
  // badesteder — se tenant-badesteder.js for hvordan en tenants navn
  // matches mod denne.
  const kommuneKeyToBadesteder = new Map();
  const usedSlugs = new Set();

  let geo, analyse;
  try {
    geo     = JSON.parse(fs.readFileSync(path.join(staticDir, 'vp3_badevand.geojson'), 'utf8'));
    analyse = JSON.parse(fs.readFileSync(path.join(staticDir, 'badevand-analyseresultater.json'), 'utf8'));
  } catch (e) {
    console.warn('slug-index: kunne ikke indlæse badevand-kilder —', e.message);
    return { badestedSlugToInfo, idToBadestedSlug, kommuneKeyToBadesteder };
  }

  // dkbw-nummer -> analyseresultat-record (navn/kommune/lat/lng) — samme
  // kobling badevand-analyseresultater.json's eget build-script allerede
  // etablerer, her genbrugt via dkbw i stedet for koordinat-afrunding.
  const byDkbw = new Map();
  for (const rec of Object.values(analyse)) {
    if (rec.dkbw != null && !byDkbw.has(rec.dkbw)) byDkbw.set(rec.dkbw, rec);
  }

  for (const f of geo.features || []) {
    const bathingwat = f.properties?.bathingwat;
    if (!bathingwat) continue;
    const m = /^DKBW(\d+)$/i.exec(bathingwat);
    const dkbw = m ? parseInt(m[1], 10) : null;
    const rec = dkbw != null ? byDkbw.get(dkbw) : null;

    // GeoJSON-koordinater er [lng, lat] — analyseresultatets EGNE lat/lng
    // foretrækkes, når de findes (samme kilde slug'et selv er udledt af),
    // geometrien er fallback for de 6 badesteder uden analyseresultat-match.
    const coords = f.geometry?.coordinates;
    const lat = rec?.lat ?? coords?.[1] ?? null;
    const lng = rec?.lng ?? coords?.[0] ?? null;

    // Fallback for de få badesteder uden analyseresultat-match (verificeret:
    // 6 af 1.039 i dagens data) — nametext + selve DKBW-ID'et, garanteret unikt.
    const navn = rec?.navn || f.properties?.nametext || bathingwat;
    const kommune = rec?.kommune || null;
    const base = rec ? slugify(navn, kommune) : `${slugify(navn)}-${bathingwat.toLowerCase()}`;
    const slug = dedupeSlug(base, usedSlugs);
    usedSlugs.add(slug);

    badestedSlugToInfo.set(slug, { id: bathingwat, navn, kommune, lat, lng });
    idToBadestedSlug.set(bathingwat, slug);

    if (kommune) {
      const key = normalizeKommuneKey(kommune);
      if (key) {
        if (!kommuneKeyToBadesteder.has(key)) kommuneKeyToBadesteder.set(key, []);
        kommuneKeyToBadesteder.get(key).push({ id: bathingwat, slug, navn, lat, lng });
      }
    }
  }

  return { badestedSlugToInfo, idToBadestedSlug, kommuneKeyToBadesteder };
}

function buildSoeSlugs(staticDir) {
  const soeSlugToInfo = new Map(); // slug -> {navn, kommune, lat, lng}
  const navnToSoeSlug = new Map();
  const usedSlugs = new Set();

  let geo;
  try {
    geo = JSON.parse(fs.readFileSync(path.join(staticDir, 'vp3_soeer.geojson'), 'utf8'));
  } catch (e) {
    console.warn('slug-index: kunne ikke indlæse vp3_soeer.geojson —', e.message);
    return { soeSlugToInfo, navnToSoeSlug };
  }

  for (const f of geo.features || []) {
    const navn = f.properties?.ov_navn;
    if (!navn) continue;
    const kommune = f.properties?.kom1 || null;
    const base = slugify(navn, kommune);
    const slug = dedupeSlug(base, usedSlugs);
    usedSlugs.add(slug);

    // NYT: søens "centrum" til geo/OG-formål — bbox-midtpunkt af selve
    // polygonen (samme geometri badevand-risk.js bruger til match). Ikke
    // et præcist areal-centroid (kræver polygon-vægtning), men mere end
    // tilstrækkeligt til et kortudsnit/schema.org-geo-punkt.
    const bbox = waterClass.computeGeometryBbox(f.geometry);
    const lat = (bbox.minLat + bbox.maxLat) / 2;
    const lng = (bbox.minLng + bbox.maxLng) / 2;

    soeSlugToInfo.set(slug, { navn, kommune, lat, lng });
    // NYT: flere søer kan dele samme ov_navn (kanalforbundne søer, se
    // badevand-risk.js's possiblyConnectedGroups-tilsvarende problem) — ved
    // navn-kollision her beholdes kun FØRSTE slug for det navn i den
    // omvendte retning (navn -> slug), da lakes{} i badevandRiskCache selv
    // kun har én entry pr. navn. Uden praktisk betydning i dag (0 navne-
    // kollisioner mellem FORSKELLIGE søer verificeret), men dokumenteret
    // for fremtidig robusthed.
    if (!navnToSoeSlug.has(navn)) navnToSoeSlug.set(navn, slug);
  }

  return { soeSlugToInfo, navnToSoeSlug };
}

/** Bygger alle Map'er — kaldes ÉN gang ved serveropstart i server.js. */
function buildSlugIndex(staticDir) {
  const { badestedSlugToInfo, idToBadestedSlug, kommuneKeyToBadesteder } = buildBadestedSlugs(staticDir);
  const { soeSlugToInfo, navnToSoeSlug }         = buildSoeSlugs(staticDir);
  console.info(`slug-index: ${badestedSlugToInfo.size} badested-slugs, ${soeSlugToInfo.size} sø-slugs, ${kommuneKeyToBadesteder.size} kommune-nøgler bygget`);
  return { badestedSlugToInfo, idToBadestedSlug, soeSlugToInfo, navnToSoeSlug, kommuneKeyToBadesteder };
}

module.exports = { slugify, normalizeKommuneKey, buildSlugIndex };
