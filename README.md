# dkvand — samlet, deployment-klart repo

Sammensat fra `Badevand_1.zip` + `Badevand_2.zip` + de nyeste, testede
filer fra denne samtale. Alle overlappende filer er krydstjekket for
indhold (ikke kun filnavn/dato) — se "Kilde pr. fil" nedenfor.

## Verificeret

- **Al kode** (JS, Python, Bash, indlejret JS i HTML) er syntakstjekket — 0 fejl
- **14 automatiserede tests** (`scripts/id15/*.test.js`) — alle bestået
- **Hver fil `Dockerfile` COPY'er** findes rent faktisk i arkivet
- **Hver fil frontend'en henter (`fetch(...)`)** findes rent faktisk i arkivet

## Rettet undervejs

**Dockerfile manglede to `COPY`-linjer** for `rbu-lake-links.json` og
`id15-lake-matches.json` — begge hentes af frontend'en, men var ikke med i
nogen af de to uploadede versioner. Uden rettelsen ville billedet bygge og
containeren køre helt uden fejl — men hele søernes RBU- og ID15-opstrøms-
matching ville stille falde tilbage til navnematch/rumlig nærhed i
produktion, uden nogen synlig fejlmeddelelse. Tjekket mod `server.js`:
den generiske `express.static()`-fallback (linje 927) server filerne
automatisk, når de findes i containeren — ingen ændring nødvendig i
`server.js` selv.

## Kilde pr. fil (hvor der var flere kandidater)

| Fil | Brugt kilde | Begrundelse |
|---|---|---|
| `id15-lake-matches.json` | Denne samtales sandkasse | Badevand_1's udgave manglede rejsetids-integration (`pulsPoints`/`travelTimeHours`/`stoppedAtLakes`) — ældre snapshot |
| `match-lakes-via-id15.js` + test | Denne samtales sandkasse | Samme årsag — Badevand_1's udgave var 144 linjer vs. 232, uden rejsetids-logik |
| `scripts/id15/compute-travel-times.js` + test | Denne samtales sandkasse | Fandtes slet ikke i nogen af de to arkiver |
| `id15-travel-times.json`, `id15-area-centroid.json` | Denne samtales sandkasse | Samme årsag |
| `package.json` | Badevand_2 | Badevand_1's udgave (60 bytes, kun `@xmldom/xmldom`) var en rest fra et scripts-undereksperiment, ikke den rigtige projekt-root-fil |
| `Dockerfile` | Badevand_2 (identisk med B1), **rettet** | Se ovenfor |
| Alt andet overlap (dansk-overloeb-kort.html, update-all-data.sh, build-rbu-lake-links.js, soe/puls-to-id15.json, id15-flow-graph.json m.fl.) | Verificeret byte-for-byte identisk på tværs af begge arkiver og denne samtales sandkasse | Ingen konflikt at løse |

## Bevidst udeladt

- **`Update/`-undermappen** fra Badevand_2 — ældre, forældede kopier af `update-all-data.sh`/`fetch-vp3-all.js` (101 hhv. 31 linjers forskel til de korrekte rod-niveau-udgaver, tidsstemplet tidligere)
- **`fetch-vp3-water-layers.js`, `download-vandomraader.js`** — begge er forgængere til `fetch-vp3-all.js` (bekræftet i sidstnævntes egen kildehenvisning), ikke refereret fra `update-all-data.sh`
- **De rå `vp3_*_raw.geojson`-filer** (kystvande/rbu/soeer/vandlob, ~93 MB tilsammen) — mellemliggende output fra `fetch-vp3-all.js`, regenereres automatisk ved næste `update-all-data.sh`-kørsel
- **Diverse løse filer fra Badevand_1** (`healthcheck.html`, `upload_log.json`, `upload_resultat.csv`, `upload_store_log.json`, "Claude answers", "Full site scraping with language", `byacre.md`) — ser ud til at være scratch/note-filer, ikke del af selve applikationen. Sig til hvis nogen af dem faktisk skal med.

## Struktur

```
dkvand/
├── Dockerfile                    RETTET (2 manglende COPY-linjer)
├── fly.toml
├── package.json / requirements.txt
├── server.js / fetch_currents.py / overloeb-sw.js
├── dansk-overloeb-kort.html
├── puls-data.json / rbu-lake-links.json / id15-lake-matches.json
├── vp3_*.geojson (5 simplificerede/slankede filer)
├── update-all-data.sh            Jævnlig dataopdatering (15 trin)
├── update-puls.js / fetch-vp3-all.js / slim-geojson.js
├── risk-model.js                 Server-side risikoformel (delt med dansk-overloeb-kort.html, SKAL holdes i sync)
└── scripts/
    ├── build-rbu-lake-links.js
    ├── dhm-schema-check.js       (debug-værktøj, ikke del af selve appen)
    ├── fetch-puls-outlet-history.js        Trin 2: historisk nedbør pr. PULS-udløb
    ├── compute-puls-udloeb-taerskler.js    Trin 3: udløbs-specifikke tærskler (se PULS-TAERSKLER-RAPPORT.md)
    ├── merge-puls-thresholds.js            Trin 4: fletter tærskler ind i puls-data.json (row[13])
    ├── diagnose-puls-taerskler.js          Stikprøvetjek af tærskeloutput, ikke del af pipelinen
    └── id15/
        ├── *.js, *.py, *.sh      Fulde ID15-terrænmodel-pipeline
        ├── *.test.js             14 automatiserede tests
        ├── ID15_VP3_II_2025.*    Rå shapefil (fandtes i intet af de to arkiver, kun her)
        └── id15-*.json, *-to-id15.json   Forberegnede mellemresultater
```

## Deployment

```bash
git init && git add . && git commit -m "Initial commit — samlet fra Badevand_1+2"
fly deploy -a dkvand
```

Husk `fly secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... MAPTILER_KEY=...`
hvis de ikke allerede er sat på appen.

## Fremtidige dataopdateringer

- **Jævnligt** (PULS opdateres): `./update-all-data.sh`
- **Sjældent** (ID15-grænser/DHM-terræn ændrer sig): `DHM_APIKEY=xxx ./scripts/id15/setup-id15-terrain-model.sh`
