# dkvand — ditbadevand.dk

Nationalt badevands-/overløbsvarslingssystem for Danmark. Node.js/Express på
Fly.io, Fly Managed Postgres. Beregner forureningsrisiko for badesteder og søer
ud fra PULS-overløbsregisteret, nedbør/vejr (DMI/Open-Meteo) og havstrøm
(CMEMS), sender webpush-varsler, og tilbyder et separat kommunalt
admin-dashboard ("Kommunepakke") som betalt tenant-produkt.

## Kernefunktioner

**Offentlig side** (`dansk-overloeb-kort.html` + `server.js`)
- Landsdækkende kort: badesteder, søer, PULS-overløbspunkter, risikofarvet
  efter en delt risikoformel (`risk-model.js`, samme kode server- og
  klientside — SKAL holdes i sync)
- Havstrøms-animation (CMEMS, se "Strøm" nedenfor)
- SSR-sider pr. badested/sø/udløb med JSON-LD (Place+Dataset), datatillids-niveau
  (confidence tier), og borgerindberetninger (ét-tryks status + algeobservation)
- Webpush-varsler ved risikoskift, styret af `risk-model.js` + `overloeb-events.js`
- PDF-/EPS-/live digitale skilte pr. badested (`skilte.js`, `badested-skilt.html`)

**Kommunepakke** (`admin-dashboard.html` + tenant-modulerne i `server.js`)
Separat, login-baseret kommunalt admin-produkt. OAuth eller trial-login,
sessions cookie-baseret (`tenant-session.js`). Faner: **Overløb** (live
overløbskort m. varselsringe, hændelseslog, prioriteret liste, fuldskærm/
iframe-embed), **Badevand** (badested-/udløbs-kort med fuld PULS-stamdata,
Badevandssteder-historik, kommune-benchmark, borgerindberetninger),
**Skilte** (PDF/EPS/live-skilt-generering med kommunelogo), **Opsætning**
(OAuth). Egen sales-portal (`internal-sales.html`,
`internal-create-trial.html`) til at oprette trials og generere login-links.

## Datagrundlag

| Kilde | Bruges til | Opdateres via |
|---|---|---|
| PULS (Miljøstyrelsen) | Overløbs-/udledningspunkter, stamdata, tærskler | `update-puls.js` + `scripts/merge-puls-thresholds.js` |
| VP3-geodata | Kystvande/søer/vandløb/badevandsområder/RBU | `fetch-vp3-all.js` |
| Open-Meteo | Nedbør (observeret/prognose) | Løbende, in-memory cache i `server.js` |
| DMI | Observeret nedbør (badested-niveau) | Løbende |
| CMEMS (Copernicus Marine) | Havstrøm + havtemperatur | `fetch_currents.py`, hentet server-side hver time |
| ID15/DHM-terrænmodel | Opstrøms sø-/vandløbsmatching | `scripts/id15/` (sjældent kørt) |

### Strøm (CMEMS)

Tre CMEMS-datasæt kombineres i `fetch_currents.py` til ét sammenhængende
gitter, dækkende hele det danske farvand fra Vesterhavet til øst for
Bornholm:

- **Østersø-produktet** (`cmems_mod_bal_phy_anfc_PT1H-i`,
  BALTICSEA_ANALYSISFORECAST_PHY_003_006, uo/vo/thetao samlet) —
  hoveddækning. Vores bbox er `LON_MIN, LON_MAX = 8.0, 16.5` /
  `LAT_MIN, LAT_MAX = 54.0, 58.0`. `LON_MAX` var oprindeligt 15.0, hvilket
  skar tværs gennem Bornholm (øen strækker sig til ~15,2°E) og udelod al
  åben Østersø-vand østfor — udvidet til 16.5°E (2026-08-20). Produktets
  eget native grid går til ~30°E, så bbox-grænsen her er selvpålagt, ikke
  en begrænsning i selve CMEMS-produktet.
- **NWSHELF-strøm** (`cmems_mod_nws_phy-cur_anfc_1.5km-2D_PT1H-i_202511`,
  uo/vo) og **NWSHELF-SST** (`cmems_mod_nws_phy-sst_anfc_1.5km-2D_PT1H-i_202511`,
  thetao) — to separate datasæt (i modsætning til Østersø-produktet, hvor
  strøm og temperatur er ét datasæt), tilføjet 2026-08-20 for at dække
  Vesterhavet/den jyske vestkyst, som Østersø-produktet slet ikke når
  (dets reelle data starter først ved ~9,04°E). Bbox går ned til
  `WEST_LON_MIN = 6.0`. Begge interpoleres (`xarray.interp()`, kræver
  `scipy` — se `requirements.txt`) onto PRÆCIS Østersø-gitterets egne
  breddegrader og gitter-afstand (udledt af de faktiske Østersø-koordinater,
  ikke hardkodet), så det samlede punktsæt forbliver ét regulært gitter —
  afgørende fordi `buildVelocityGridJSON()` i `server.js` antager præcis
  dét. Begge NWSHELF-hentninger er best-effort (egen try/except pr. datasæt)
  — fejler de, falder scriptet tilbage til uændret Østersø-only-dækning
  frem for at vælte hele strøm-hentningen.

Farveskalaen i strøm-animationen (`windy-currents.js`) er RELATIV min/max
over de faktiske temperaturer i det viste datasæt (beregnet klientside i
`computeVelocityTempRangeK()`), ikke en fast skala — så alle tre datasæts
punkter altid falder inden for samme blå→røde farveinterval. Uden ægte
temperatur for et område ville det området vises som én ensfarvet klat i
stedet for en gradient, derfor hentes SST separat for NWSHELF-punkterne
fremfor at lade dem falde tilbage til en syntetisk gennemsnitsværdi.

## Arkitektur / struktur

```
dkvand/
├── server.js                     Hovedapplikation (Express, alle API-ruter)
├── db.js                         Delt Postgres-pool (Fly Managed Postgres)
├── risk-model.js                 Risikoformel — delt server/klient, SKAL holdes i sync
├── badevand-risk.js               Badevands-risiko-kaskade (søer/kystvande/badesteder)
├── badevand-risk-worker.js       Samme kaskade i egen worker_thread (event loop-aflastning)
├── current-grid.js               Fælles CMEMS-gitter-opbygning/opslag (hoved- og worker-tråd)
├── fetch_currents.py             CMEMS-hentning (Østersø + NWSHELF), se ovenfor
├── overloeb-status.js            Beregner kommune-scopet overløbsstatus (Kommunepakke)
├── overloeb-events.js            Hændelseslog + persisteret bucket-tilstand (Postgres)
├── page-views.js                 Dagligt visningstæller-aggregat pr. badested/udløb
├── app-metrics.js                Installations-telemetri, push-log, daglig risikohistorik
├── badested-observations.js      Borgerindberetninger (status/algeobservation)
├── slug-index.js / seo-pages.js  URL-slug-arkitektur + SSR-sideindhold
├── water-classification.js       Sø/kystvand-klassificering
├── skilte.js / logo-fetch.js     Skilt-generering (PDF/EPS/live) + kommunelogo (SVG→PNG)
├── tenant-*.js, oauth-*.js       Kommunepakke: tenant-model, sessions, OAuth
├── badested-overrides*.js        Kommunal manuel overstyring af badested-status
├── dansk-overloeb-kort.html      Offentligt kort (Leaflet + windy-currents.js)
├── admin-dashboard.html          Kommunalt admin-dashboard
├── windy-currents.js             Vendoret strøm-animationsmotor (windy.js-afledt)
├── puls-data.json                PULS-stamdata inkl. beregnede tærskler
├── vp3_*.geojson                 Simplificerede VP3-lag
└── scripts/
    ├── update-all-data.sh                  Fuld dataopdatering (flere trin)
    ├── compute-puls-udloeb-taerskler.js    PULS-udløbstærskler (se PULS-TAERSKLER-RAPPORT.md)
    ├── merge-puls-thresholds.js            Fletter tærskler ind i puls-data.json
    └── id15/                               ID15-terrænmodel-pipeline (sjældent kørt)
```

## Deployment

```bash
fly deploy -a dkvand
```

Kræver bl.a. følgende `fly secrets`: `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`,
`MAPTILER_KEY`, `CMEMS_USERNAME`/`CMEMS_PASSWORD`, `OBSERVATION_IP_SALT`,
Postgres-forbindelsen (Fly Managed Postgres, tilknyttet automatisk).

**Dockerfile-fælde** (gentagne gange årsag til produktionsudfald): hver ny
lokal `require('./modul')` i `server.js` (eller transitivt) SKAL have sin
egen `COPY modul.js ./`-linje i `Dockerfile` — ellers crasher containeren
øjeblikkeligt ved opstart (`Cannot find module`). Tjek Dockerfile FØR deploy,
ikke efter.

## Fremtidige dataopdateringer

- **Jævnligt** (PULS opdateres): `./update-all-data.sh`
- **Sjældent** (ID15-grænser/DHM-terræn ændrer sig):
  `DHM_APIKEY=xxx ./scripts/id15/setup-id15-terrain-model.sh`

## Seneste udvikling (siden sidste dokumentationsopdatering, 2026-07-20)

### Kommunepakke — nyt kommunalt admin-produkt (bygget fra bunden)
Tenant-model, OAuth-selvbetjening + trial-login, sessions. Dashboard med
Overløb-/Badevand-/Skilte-/Opsætning-faner: live overløbskort med
varselsringe og klik-detaljepaneler (badested + udløb, fuld PULS-stamdata,
webpush-abonnenttal, udløbsliste), hændelseslog, kommune-benchmark,
borgerindberetninger, PDF/EPS/live-skilt-generering med kommunelogo
(inkl. SVG-understøttelse), og en redesignet Statistik-fane (visningstæller
pr. badested/udløb, samlet visninger/abonnenter/indberetninger/varsler,
trendgrafer, standardiserede periodevælgere). Egen sales-portal til
trial-oprettelse og login-links. GDPR-sikker kommunal overstyringsbanner.

### PULS-datakvalitet — kritisk fejl fundet og rettet
`row[13]` blev brugt til BÅDE cod-værdi og beregnet tærskel — kollisionen
undervurderede overløbsrisikoen for ca. 70% af udløbene. Tærsklen flyttet til
`row[24]`; dokumentation og tests rettet. En efterfølgende frisk PULS-hentning
ødelagde indeksbaseret sø-/kystvands-matching (id15-*.json refererer punkter
via array-indeks, ikke stabilt id) og blev akut revertet til sidste kendte
gode datasæt. Fuld PULS-stamdata er nu synlig i Kommunepakkens udløbspanel.

### Havstrøm — Østersø-produktets dækningshuller lukket
Animationen gik gennem flere iterationer (fra statisk lag → vendoret windy.js
-motor, diverse rendering-/farve-/maske-rettelser) og fik i dag suppleret
Østersø-produktet med NWSHELF-produktet for at lukke to dækningshuller:
Vesterhavet/den jyske vestkyst (intet Østersø-data vest for ~9°E) og
farvandet øst for Bornholm (tidligere afskåret af en selvpålagt 15,0°E-grænse,
udvidet til 16,5°E). Begge nye områder får ægte temperatur (ikke kun strøm),
så den relative farveskala fortsat spænder korrekt. Samme udvidelse gav
automatisk den eksisterende retningsbevidste kystvands-risikomodel (opstrøms/
nedstrøms via strømvektor) reelle data for vestkysten, uden kodeændring.

### SEO/indeksering
Badested-/sø-sider fik unikt SSR-indhold (var næsten-duplikater pga. delt
app-shell-boilerplate), JSON-LD udvidet til Place+Dataset, og et
per-badested datatillidsniveau (confidence tier) tilføjet.

### Øvrigt
Borgervurderings-grænser hævet (5/dag, 50/dag ved GPS-bekræftet tilstedeværelse,
den tidligere ét-badested-pr-dag-regel fjernet). Flere robusthedsrettelser
(pg-pool/event-loop, worker_threads-aflastning af den tunge badevands-
risikoberegning, gentagne Dockerfile-COPY-mangler efter nye moduler).
