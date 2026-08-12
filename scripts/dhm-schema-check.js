// ═══════════════════════════════════════════════════════════════════════════
// dhm-schema-check.js — KØR DENNE FØRST, før build-lake-catchments.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Jeg (Claude) kan ikke selv nå datafordeler.dk fra mit sandbox-miljø —
// domænet er ikke på min tilladte netværksliste. Query-formen i
// build-lake-catchments.js er derfor bygget ud fra Datafordelerens
// offentlige dokumentation, IKKE testet mod det faktiske skema.
//
// Dette script henter det RIGTIGE GraphQL-skema for DHM Terræn-registret
// (introspection query — standard GraphQL-mekanisme, kræver ingen kendskab
// til feltnavne på forhånd) og printer de tilgængelige entiteter og felter.
// Kør det, og send mig outputtet (eller de relevante dele) tilbage, så jeg
// kan rette query'en i build-lake-catchments.js til at matche PRÆCIS det
// virkelige skema, i stedet for mit bedste gæt.
//
// Brug:
//   DHM_APIKEY=xxx node dhm-schema-check.js
//
// Forventet endpoint-mønster (bekræftet fra Datafordelerens transitionsguide):
//   https://graphql.datafordeler.dk/<Register>/<Version>?apikey=...
// Register-forkortelser og nøjagtig version bør stadig bekræftes for netop
// DHM under "Mine tjenester" i Datafordeler Administration.

'use strict';

const APIKEY = process.env.DHM_APIKEY;
if (!APIKEY) {
  console.error('Sæt miljøvariablen DHM_APIKEY først: DHM_APIKEY=xxx node dhm-schema-check.js');
  process.exit(1);
}

// RETTET (v3): en tidligere version brugte en Authorization-header
// ("apikey <nøgle>"), fulgt fra et tredjeparts-blogeksempel — men
// Datafordelerens EGEN dokumentation ("Autentifikationsmetoder på
// Datafordeler Administration") siger eksplicit: "API-keys bliver anvendt
// direkte i URL'en" som et query-parameter, IKKE som header.
// Header-baseret autentifikation (Authorization: Bearer ...) er forbeholdt
// OAuth Shared Secret/Certifikat, ikke almindelig API-key. Det var derfor
// forrige forsøg gav 401: nøglen lå i en header, tjenesten ikke tjekker.
function withApikey(baseUrl) {
  return `${baseUrl}?apikey=${APIKEY}`;
}

// VIGTIGT FUND: Datafordelerens officielle liste over registre med
// entitetsbaseret GraphQL for DHM indeholder KUN "DHMHoejdekurver" og
// "DHMOprindelse" — IKKE noget "DHMTerraen"-register. Det kan betyde at
// selve det rå højdegitter (terræn-DEM, det REST-endpointet DHM/Koter
// leverede) slet ikke er udstillet som GraphQL-entitet endnu — kun
// højdekurver (Formkurve/Referencekurve/Kote0_5/Kote2_5, som er PUNKTER
// LANGS konturlinjer, ikke et regulært gitter) og dataoprindelse-metadata.
// Scriptet prøver derfor DHMHoejdekurver først. Hvis det er den eneste vej
// ind, skal build-lake-catchments.js ændres til at INTERPOLERE et gitter
// fra konturpunkter i stedet for at hente et færdigt gitter direkte — en
// ekstra kompleksitet ud over det oprindelige design.
//
// ALTERNATIV værd at undersøge parallelt: tjek "Dataoversigt" på
// datafordeler.dk for "Danmarks Højdemodel (DHM) / DHM Terræn" og se
// hvilke adgangstyper der reelt er listet der (Fildownload/WCS er typisk
// bedre egnet til et helt rastergitter end punkt-for-punkt GraphQL-kald,
// og kan vise sig at være den rigtige vej for netop denne opgave).
// BEKRÆFTET (fra query-builderen i Datafordelerens Dataoversigt, altså
// den faktiske kilde — ikke gæt): DHMOprindelse bruger v2, ikke v1.
// https://graphql.datafordeler.dk/DHMOprindelse/v2?apikey=...
// Prøver v2 for begge DHM-registre, da version formentlig er sat pr.
// register-generation snarere end globalt ens for alle registre.
const CANDIDATE_ENDPOINTS = [
  'https://graphql.datafordeler.dk/DHMOprindelse/v2',
  'https://graphql.datafordeler.dk/DHMHoejdekurver/v2',
  'https://graphql.datafordeler.dk/DHMHoejdekurver/v1', // beholdt som fallback, ikke bekræftet forkert endnu
];

async function fetchSchemaFile(baseUrl) {
  const schemaUrl = withApikey(`${baseUrl}/schema`);
  console.log(`\n── Henter skema (GET): ${schemaUrl.replace(APIKEY, 'xxx')} ──`);
  const res = await fetch(schemaUrl, {
    headers: { 'Content-Type': 'application/json' },
  });
  console.log('HTTP status:', res.status);
  const text = await res.text();
  if (!res.ok) {
    console.log('Response (fejl):', text.slice(0, 500));
    return null;
  }
  console.log(`✓ Skema hentet, ${text.length} tegn.`);
  return text;
}

const INTROSPECTION_QUERY = `
  query IntrospectSchema {
    __schema {
      types {
        name
        kind
        fields {
          name
          type { name kind ofType { name kind } }
        }
      }
    }
  }
`;

async function tryIntrospection(baseUrl) {
  const url = withApikey(baseUrl);
  console.log(`\n── Prøver introspection (POST): ${url.replace(APIKEY, 'xxx')} ──`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    });
    console.log('HTTP status:', res.status);
    const text = await res.text();
    if (!res.ok) {
      console.log('Response (fejl):', text.slice(0, 500));
      return null;
    }
    const json = JSON.parse(text);
    if (json.errors) {
      console.log('GraphQL-fejl:', JSON.stringify(json.errors, null, 2).slice(0, 800));
      return null;
    }
    const types = json.data.__schema.types.filter(t =>
      !t.name.startsWith('__') && t.kind === 'OBJECT' && t.fields && t.fields.length
    );
    console.log(`✓ Fandt ${types.length} relevante typer:`);
    for (const t of types) {
      console.log(`\n  type ${t.name}:`);
      for (const f of t.fields.slice(0, 25)) {
        const typeName = f.type.name || f.type.ofType?.name || f.type.kind;
        console.log(`    ${f.name}: ${typeName}`);
      }
      if (t.fields.length > 25) console.log(`    ... og ${t.fields.length - 25} flere felter`);
    }
    return json;
  } catch (e) {
    console.log('Fejlede:', e.message);
    return null;
  }
}

(async () => {
  for (const baseUrl of CANDIDATE_ENDPOINTS) {
    const schema = await fetchSchemaFile(baseUrl);
    if (schema) {
      // Gem det rå skema til fil, så det kan gennemgås i sin fulde form
      require('fs').writeFileSync(
        `schema-${baseUrl.split('/').slice(-2, -1)[0]}.graphql`, schema
      );
      console.log(`  → Gemt til schema-${baseUrl.split('/').slice(-2, -1)[0]}.graphql`);
    }
    await tryIntrospection(baseUrl);
  }
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('Hvis BEGGE endpoints fejlede med 401/403: tjek at API-nøglen');
  console.log('er aktiveret (der går 15 min. efter oprettelse) og at dit');
  console.log('IT-system har adgang til DHM-registrene i Datafordeler Administration.');
  console.log('');
  console.log('Hvis begge fejlede med 404: register-navnet eller versionen');
  console.log('("v1") er forkert — tjek "Mine tjenester" i Administration for');
  console.log('den præcise URL, Datafordeleren viser for dit oprettede IT-system.');
  console.log('');
  console.log('Send mig under alle omstændigheder hele terminal-outputtet.');
})();

