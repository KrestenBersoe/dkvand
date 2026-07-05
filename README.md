# Overløbsrisiko — Danmarks vandmiljø

Interaktivt kort over forureningsrisiko fra regnbetingede kloakoverløb (CSO) ved
alle 21.556 aktive udløbspunkter i Danmark. Bygget på officielle PULS-data fra
Miljøportalen og DMI's HARMONIE AROME 2 km nedbørsmodel via Open-Meteo.

## Filer

| Fil | Rolle |
|-----|-------|
| `server.js` | Node/Express-server: serverer appen + vejr-proxy med delt cache |
| `fetch_currents.py` | Henter CMEMS-strømdata (uo/vo) via Copernicus Marine Toolbox, kaldes af `server.js` |
| `requirements.txt` | Python-afhængigheder (`copernicusmarine`) |
| `package.json` | Node-afhængigheder (express) |
| `dansk-overloeb-kort.html` | Selve appen (kort, varsler, dokumentation) — ~85 KB |
| `puls-data.json` | PULS-datasæt, 21.556 udløb — ~1 MB, cachet 1 år |
| `overloeb-sw.js` | Service worker til push-notifikationer |

## Strømdata (CMEMS)

Badevands-risikoscoren justeres med en "opstrøms-vægt" baseret på den aktuelle
strømretning i Østersøen/Kattegat, hentet fra CMEMS-datasættet
`cmems_mod_bal_phy_cur_anfc_2.5km_PT1H-i`.

Adgangen sker via den officielle **Copernicus Marine Toolbox**
(`copernicusmarine`-pakken) i `fetch_currents.py`, som `server.js` kalder som
en underproces og cacher i 6 timer. Tidligere blev CMEMS' OPeNDAP/THREDDS
ASCII-output parset manuelt med regex direkte i Node — det er droppet til
fordel for toolbox'en, som er langt mere robust overfor formatændringer.

Kræver `CMEMS_USERNAME`/`CMEMS_PASSWORD` som miljøvariabler (Fly.io secrets).
Uden dem falder `/api/currents` gracefully tilbage til `503` med
`{"fallback": true}`, og appen fungerer stadig — bare uden strøm-justering.

## Kør lokalt

```bash
npm install
npm start
# → http://localhost:3000
```

For udvikling med auto-reload:

```bash
npm run dev
```

## Arkitektur — tre cache-lag

```
Browser (IndexedDB)     PULS-data 1 år · sidste resultat · favoritter
       ↓
HTTP / CDN              puls-data.json (1 år) · vejr-svar (6t)
       ↓
Server (delt cache)     vejr-proxy: 6t TTL per 0,5° gittercelle
       ↓
Open-Meteo / DMI        kun ved cache-miss
```

Vejrdata hentes på et 0,5°-gitter (~56 celler over Danmark) i én bulk-forespørgsel.
Serverens delte cache betyder at Open-Meteo kun kaldes når en celle er udløbet (6t),
**på tværs af alle brugere** — ikke per browser.

## Endpoints

| Endpoint | Beskrivelse |
|----------|-------------|
| `GET /` | Appen |
| `GET /puls-data.json` | PULS-datasæt (Cache-Control: 1 år) |
| `GET /api/weather?lat=&lng=` | Vejr for én gittercelle |
| `POST /api/weather/bulk` | Vejr for mange celler: `{ cells: [{lat,lng}] }` |
| `GET /api/health` | Status + cache-statistik |

## Produktion

Bag en reverse proxy (nginx/Caddy) med HTTPS. Service worker og push-notifikationer
kræver `https:`. Sæt `PORT` via miljøvariabel hvis nødvendigt:

```bash
PORT=8080 node server.js
```

Vejr-cachen er in-memory. Ved flere serverinstanser bør den flyttes til Redis eller
tilsvarende delt lager, så cachen deles på tværs af instanser.

## Datakilder

- **PULS** (Miljøportalen) — regnbetingede udløb, stamdata + udledning. Åbne data.
- **Open-Meteo / DMI HARMONIE AROME 2 km** — nedbør. CC BY 4.0.
- **OpenStreetMap** — baggrundskort. ODbL.

Se dokumentationsfanen i appen for fuld beskrivelse af datakilder, kvalitetskoder
og de matematiske modeller.

## Opdatering af PULS-data

PULS opdateres årligt. Hent nye filudtræk fra
`arealdata.miljoeportal.dk`, regenerér `puls-data.json` (samkør stamdata + udledning
på navn, omregn ikke volumen — behold m³), og erstat filen. Klienter henter den nye
version automatisk når deres 1-års cache udløber, eller med ctrl+shift+R.
