#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// aggregate-lake-mfs-load.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Estimerer sandsynlig belastning af miljøfremmede stoffer (MFS — tungmetaller,
// PAH'er, PFAS, lægemiddelstoffer, pesticider m.fl.) per sø, ved at:
//   1. Klassificere hvert PULS-udløb som fælleskloakeret (spildevandsoverløb)
//      eller separatkloakeret (regnvandsudledning) ud fra SewerStructure-koden
//      (samme klassifikation som ditbadevand.dk allerede bruger til RBU
//      Kloak/RBU Regn — se dansk-overloeb-kort.html).
//   2. Slå Miljøstyrelsens typetal (gennemsnitskoncentration, µg/l) op for
//      den relevante kloaktype — se scripts/mst-typetal-mfs.json.
//   3. Gange typetal (µg/l) med udløbets volumen (m³) for at få en
//      sandsynlig stofmængde. Enhedsregning: 1 µg/l × 1 m³ = 1 µg/l × 1.000 l
//      = 1.000 µg = 1 mg. Så: belastning_mg = typetal_µg_per_l × volumen_m3.
//   4. Aggregere per sø via id15-lake-matches.json, samme metode som
//      aggregate-lake-substance-load.js bruger til COD/BOD/N/P.
//
// DETTE ER IKKE MÅLT DATA — det er en MODELLERET SANDSYNLIG BELASTNING,
// baseret på nationale gennemsnitskoncentrationer ganget med kendt volumen.
// Metoden er den samme, MST selv bruger til at "vurdere påvirkningen fra
// landets øvrige punktkilder af samme type" (se typetal-rapportens
// konklusion) — men med samme begrænsninger som typetallene selv har:
//
// KRITISKE FORBEHOLD, LÆS FØR BRUG:
//   1. Typetallene gælder KUN boligdominerede oplande UDEN forudgående
//      rensning. MST skriver selv: "regnbetingede udledninger fra andre
//      typer oplande som fx industriområder eller meget trafikerede veje...
//      kan typetallene derfor underestimere den faktiske udledning." Vi har
//      INGEN oplandskarakteristik-data til at identificere disse udløb (se
//      tidligere undersøgelse — hverken PULS eller DAI udstiller
//      oplandsgeometri/arealanvendelse). Alle udløb behandles ens her.
//   2. Typetallene er baseret på et MEGET spinkelt datagrundlag: kun 6
//      fælleskloakerede og 5 separatkloakerede oplande på LANDSPLAN indgår i
//      NOVANA-programmet, med overrepræsentation af Nordjylland/Midtjylland.
//      Dette er IKKE et lokalt kalibreret tal for det enkelte udløb.
//   3. Kun 76 af de 209+110 stoffer MST har undersøgt, har et beregnet
//      typetal overhovedet (resten har for få målinger over
//      detektionsgrænsen). Stoffer uden typetal indgår IKKE her — det
//      betyder IKKE at stoffet er fraværende, kun at MST ikke kunne beregne
//      et pålideligt gennemsnit.
//   4. "robust: false" (indikativt typetal, 5-49 målinger over
//      detektionsgrænsen) er en svagere kilde end "robust: true" (≥50
//      målinger) — brug de indikative tal med ekstra forbehold, jf. MST's
//      egen anbefaling.
//   5. Metaltypetal er OPLØST fraktion (<0,45 µm filtreret) — undervurderer
//      total metalindhold, som også inkluderer partikelbundet metal.
//   6. SewerStructure-klassifikationen (fælles/separat) er selv nullable —
//      udløb uden kendt SewerStructure kan IKKE typetal-beregnes og
//      udelades stille fra summen (se "unclassifiedOutlets" i outputtet).
//
// Forudsætninger:
//   scripts/mst-typetal-mfs.json (typetal-opslag)
//   id15-lake-matches.json i repo-roden (kanal-korrigeret)
//   puls-data.json i repo-roden, MED SewerStructure-feltet (position 11)
//
// Brug:
//   node scripts/id15/aggregate-lake-mfs-load.js
//   node scripts/id15/aggregate-lake-mfs-load.js --out /sti/til/output.json
//
// Output: lake-mfs-load.json i repo-roden (medmindre --out angivet)
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

const DIR  = __dirname;                    // scripts/id15
const ROOT = path.join(DIR, '..', '..');   // repo-rod

const TYPETAL_PATH      = path.join(ROOT, 'scripts', 'mst-typetal-mfs.json');
const LAKE_MATCHES_PATH = path.join(ROOT, 'id15-lake-matches.json');
const PULS_PATH         = path.resolve(argVal('--puls-data', path.join(ROOT, 'puls-data.json')));
const OUTPUT_PATH       = path.resolve(argVal('--out', path.join(ROOT, 'lake-mfs-load.json')));

// Array-positioner i puls-data.json's 'd'-rækker — skal matche
// update-puls.js's compress()-funktion. sewerStructure = position 11.
const IDX = { vol: 5, quality: 7, sewerStructure: 11 };

// Klassifikation af SewerStructure-koder — samme mønster som
// ditbadevand.dk's egen RBU Kloak/RBU Regn-opdeling (se dansk-overloeb-
// kort.html): OS/OV/OF/OVI/OSI/OK/OKI = fælleskloak (blandet spildevand/
// regnvand), SE/SF = separatkloak (rent regnvand). Øvrige/ukendte koder
// klassificeres IKKE — udløbet udelades fra MFS-beregningen (se
// unclassifiedOutlets i output), i stedet for at gætte forkert kloaktype.
const FAELLESKLOAK_KODER  = new Set(['OS', 'OV', 'OF', 'OVI', 'OSI', 'OK', 'OKI']);
const SEPARATKLOAK_KODER  = new Set(['SE', 'SF']);

function classifySewer(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  if (FAELLESKLOAK_KODER.has(c)) return 'faelleskloak';
  if (SEPARATKLOAK_KODER.has(c)) return 'separatkloak';
  return null;  // ukendt kode — udelades bevidst, se filhoved
}

function main() {
  for (const [label, p] of [
    ['scripts/mst-typetal-mfs.json', TYPETAL_PATH],
    ['id15-lake-matches.json', LAKE_MATCHES_PATH],
    ['puls-data.json', PULS_PATH],
  ]) {
    if (!fs.existsSync(p)) {
      console.error(`❌ Mangler ${label}: ${p}`);
      process.exit(1);
    }
  }

  const typetalData = JSON.parse(fs.readFileSync(TYPETAL_PATH, 'utf8'));
  const lakeMatches  = JSON.parse(fs.readFileSync(LAKE_MATCHES_PATH, 'utf8'));
  const puls         = JSON.parse(fs.readFileSync(PULS_PATH, 'utf8'));
  const rows          = puls.d || [];

  if (rows.length > 0 && rows[0].length <= IDX.sewerStructure) {
    console.error(`❌ puls-data.json mangler SewerStructure-feltet (position ${IDX.sewerStructure}).`);
    process.exit(1);
  }

  const substances = typetalData.substances;
  console.log(`${substances.length} stoffer med typetal indlæst.`);
  console.log(`${Object.keys(lakeMatches).length} søer i id15-lake-matches.json`);
  console.log(`${rows.length.toLocaleString('da')} aktive udløb i puls-data.json\n`);

  // ── Pre-klassificér alle udløb én gang (fælles/separat/uklassificeret) ──
  const outletClass = rows.map(r => classifySewer(r[IDX.sewerStructure]));
  const classCounts = { faelleskloak: 0, separatkloak: 0, ukendt: 0 };
  for (const c of outletClass) classCounts[c || 'ukendt']++;
  console.log('Kloaktype-fordeling (alle aktive udløb):');
  console.log(`  Fælleskloak:  ${classCounts.faelleskloak.toLocaleString('da')}`);
  console.log(`  Separatkloak: ${classCounts.separatkloak.toLocaleString('da')}`);
  console.log(`  Ukendt (udelades): ${classCounts.ukendt.toLocaleString('da')}\n`);

  const results = {};

  for (const [lakeName, info] of Object.entries(lakeMatches)) {
    const pts = info.pulsPoints || [];
    if (pts.length === 0) continue;

    // sums[stofnavn] = { totalMg, nContributing }
    const sums = {};
    for (const s of substances) sums[s.navn] = { totalMg: 0, nContributing: 0 };

    let nFaelles = 0, nSeparat = 0, nUnclassified = 0;
    const unclassifiedOutlets = [];

    for (const pt of pts) {
      const row = rows[pt.id];
      if (!row) continue;

      const vol = row[IDX.vol];
      const sewerClass = outletClass[pt.id];

      if (sewerClass === 'faelleskloak') nFaelles++;
      else if (sewerClass === 'separatkloak') nSeparat++;
      else { nUnclassified++; unclassifiedOutlets.push(pt.id); continue; }

      if (vol === null || vol === undefined || vol <= 0) continue;  // intet volumen, intet at gange med

      for (const s of substances) {
        const entry = sewerClass === 'faelleskloak' ? s.faelleskloak : s.separatkloak;
        if (!entry) continue;  // intet typetal for denne stof/kloaktype-kombination
        const loadMg = entry.typetal_ugl * vol;  // µg/l × m³ = mg, se filhoved
        sums[s.navn].totalMg += loadMg;
        sums[s.navn].nContributing++;
      }
    }

    const outletsTotal = pts.length;
    const substanceResults = {};
    for (const s of substances) {
      const sum = sums[s.navn];
      if (sum.nContributing === 0) continue;  // ingen bidrag for dette stof i denne sø — udelad
      substanceResults[s.navn] = {
        gruppe: s.gruppe,
        belastningMg: Math.round(sum.totalMg * 1000) / 1000,
        // RETTET: stod tidligere `sum.totalMg / 1000 * 1e6` — det er kun
        // én omregning fra mg til GRAM (/1000), afrundet til 6 decimaler,
        // men feltet hedder belastningKG og blev vist som kg i UI'et.
        // Manglede den ANDEN /1000 (gram -> kg). Alle MFS-tal var derfor
        // vist 1.000× for høje (bruger-rapport: "tallene virker voldsomme",
        // Farum Sø Aluminium viste 1.224.369,6 i stedet for korrekt
        // 1.224,37 kg). N/P/COD/BOD (aggregate-lake-substance-load.js) er
        // uberørt af denne fejl — de summerer allerede-kg PULS-felter uden
        // nogen omregning.
        belastningKg: Math.round(sum.totalMg / 1e6 * 1e6) / 1e6,
        outletsBidraget: `${sum.nContributing}/${outletsTotal}`,
      };
    }

    if (Object.keys(substanceResults).length === 0) continue;  // intet at rapportere for denne sø

    results[lakeName] = {
      outletsMatched: outletsTotal,
      outletsFaelleskloak: nFaelles,
      outletsSeparatkloak: nSeparat,
      outletsUklassificeret: nUnclassified,
      stoffer: substanceResults,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    metode: 'MST typetal (µg/l, nationalt gennemsnit for boligoplande) × udløbets volumen (m³) = sandsynlig stofmængde (mg). Se scriptets filhoved for fulde forbehold.',
    typetalKilde: typetalData._meta.kilde,
    typetalUrl: typetalData._meta.url,
    lakeCount: Object.keys(results).length,
    lakes: results,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');

  console.log(`${Object.keys(results).length} søer med ≥1 MFS-estimat aggregeret.`);
  console.log(`Skrevet: ${OUTPUT_PATH}`);
}

main();
