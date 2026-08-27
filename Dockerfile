FROM node:20-bookworm-slim

WORKDIR /app

# ── Python til CMEMS-strømdata ───────────────────────────────────────────────
# Alpine er droppet til fordel for Debian (bookworm), fordi
# copernicusmarine-pakkens afhængigheder (xarray, zarr, dask, netCDF4 m.fl.)
# er langt mere pålidelige at installere som færdige wheels på glibc/Debian
# end på musl/Alpine, hvor flere af dem må kompileres fra kildekode.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
    && rm -rf /var/lib/apt/lists/*

# copernicusmarine installeres separat (layer-cache) — sjældent ændret
COPY requirements.txt ./
RUN pip install --break-system-packages --no-cache-dir -r requirements.txt

# Install Node-afhængigheder (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.js ./
# NYT: delt Postgres-forbindelse (Fly Managed Postgres) — server.js kræver
# den INDIREKTE via app-metrics.js/badested-observations.js's egne
# require('./db')-kald. Samme "crasher øjeblikkeligt uden denne linje"-
# fælde som resten af de lokale moduler nedenfor (se app-metrics.js's egen
# kommentar for et konkret eksempel på præcis denne fejl i produktion).
COPY db.js ./
# RETTET: server.js kræver nu (require('./risk-model')) den porterede
# risikomodel, brugt til serverstyret push-evaluering — uden denne linje
# crasher containeren ØJEBLIKKELIGT ved opstart (Cannot find module),
# hvilket lukker hele siden ned, ikke bare én funktion. Ligger fladt i
# rodmappen (ingen server-modules-undermappe), samme sted som server.js.
COPY risk-model.js ./
COPY water-classification.js ./
# NYT: URL-arkitektur/SEO (slug-baserede ruter for badested/sø/udløb) —
# server.js kræver (require('./slug-index'), require('./seo-pages')) disse
# moduler ved opstart, samme "crasher øjeblikkeligt uden denne linje"-fælde
# som resten af de lokale moduler i denne fil.
COPY slug-index.js ./
COPY seo-pages.js ./
# RETTET (produktionsudfald 2026-08-14): Kommunepakke, modul 1 — server.js
# kræver (require('./tenant-admin'), som selv require'r require('./tenant-
# session')) disse to moduler ved opstart, samme "crasher øjeblikkeligt
# uden denne linje"-fælde som resten af de lokale moduler i denne fil.
# Manglede oprindeligt her, hvilket fik containeren til at crashe i et
# tæt genstarts-loop i produktion (Node: "Cannot find module
# './tenant-admin'") — Fly's egen rate-limiting på gentagne maskine-
# genstarter eskalerede det hurtigt til et fuldt udfald af hele siden,
# ikke kun den nye Kommunepakke-funktion.
COPY tenant-admin.js ./
COPY tenant-session.js ./
# RETTET (produktionsudfald 2026-08-27 — SAMME "Cannot find module"-
# genstarts-loop-fælde beskrevet ovenfor for tenant-admin.js, denne gang med
# admin-users.js): single auth-løsning på tværs af dkvand/ukwater/frwater —
# server.js kræver nu også (require('./admin-users'), som selv require'r
# require('./admin-user-session')) disse to moduler, samt
# (require('./sso-handoff')) ved opstart.
COPY admin-users.js ./
COPY admin-user-session.js ./
COPY sso-handoff.js ./
# NYT (cross-market admin-dashboard): server.js kræver nu også
# (require('./admin-stats')) dette modul ved opstart, samme "crasher
# øjeblikkeligt uden denne linje"-fælde som de øvrige lokale moduler i
# denne fil.
COPY admin-stats.js ./
# NYT: Kommunepakke, modul 2 — tenant-admin.js requirer nu også
# (require('./oauth-config-validation')) dette modul ved opstart, samme
# "crasher øjeblikkeligt uden denne linje"-fælde som ovenfor. Tilføjet
# HER (før deploy, ikke efter) efter modul 1's produktionsudfald lærte
# denne lektie — se planens ⚠️-tjekliste-punkt.
COPY oauth-config-validation.js ./
# NYT: Kommunepakke, modul 3 — server.js requirer nu også
# (require('./oauth-login')) dette modul ved opstart (openid-client-
# integrationen), samme "crasher øjeblikkeligt uden denne linje"-fælde
# som de øvrige lokale moduler i denne fil.
COPY oauth-login.js ./
# NYT: Kommunepakke, modul 4 — server.js requirer nu også
# (require('./tenant-badesteder')) dette modul ved opstart, samme
# "crasher øjeblikkeligt uden denne linje"-fælde som de øvrige lokale
# moduler i denne fil.
COPY tenant-badesteder.js ./
# NYT: Kommunepakke, modul 6 — server.js requirer nu også
# (require('./badested-overrides'), som selv require'r require('./badested-
# override-logic')) disse to moduler ved opstart, samme "crasher
# øjeblikkeligt uden denne linje"-fælde som de øvrige lokale moduler i
# denne fil. Tilføjet HER (før commit/deploy, ikke efter) — se modul 1's
# produktionsudfald-kommentar ovenfor for hvorfor dette tjekkes hver gang.
COPY badested-overrides.js ./
COPY badested-override-logic.js ./
# NYT: Kommune Dashboard, "Overløb"-fanen — server.js kræver nu også
# (require('./overloeb-status')) dette modul ved opstart, samme "crasher
# øjeblikkeligt uden denne linje"-fælde som de øvrige lokale moduler i
# denne fil.
COPY overloeb-status.js ./
# NYT: Overløb-fanen, hændelseslog (bruger-ønske 2026-08-19) — server.js
# kræver nu også (require('./overloeb-events')) dette modul ved opstart,
# samme "crasher øjeblikkeligt uden denne linje"-fælde som de øvrige lokale
# moduler i denne fil.
COPY overloeb-events.js ./
# NYT (bruger-krav 2026-08-20) — server.js kræver nu også
# (require('./page-views')) dette modul ved opstart, samme "crasher
# øjeblikkeligt uden denne linje"-fælde som de øvrige lokale moduler i
# denne fil (se tenant-admin.js's kommentar ovenfor for den fulde
# forklaring, og server.js:1787220... produktionsudfaldet fra samme dag).
COPY page-views.js ./
# NYT: Kommune Dashboard, "Skilte"-fanen — server.js kræver nu også
# (require('./skilte'), require('./logo-fetch')) disse to moduler ved
# opstart, samme "crasher øjeblikkeligt uden denne linje"-fælde som de
# øvrige lokale moduler i denne fil.
COPY skilte.js ./
COPY logo-fetch.js ./
# server.js's GET /admin/dashboard, GET /admin/settings/oauth,
# GET /admin/login og GET /admin/overloeb-embed læser disse filer direkte
# via fs.readFileSync(STATIC_DIR, ...) ved hver request (samme mønster som
# stats.html nedenfor) — mangler en af dem, fejler netop DEN rute med
# ENOENT, men crasher IKKE hele processen (læsningen sker i en try/catch,
# se ruterne).
COPY admin-dashboard.html ./
COPY admin-oauth-setup.html ./
COPY admin-login.html ./
COPY internal-create-trial.html ./
# RETTET (bruger-krav 2026-08-27): internal-sales.html omdøbt til
# internal-country-admin.html (ét-lands-ad-gangen admin-skærm, se
# server.js's GET /internal/admin/:countryCode) — COPY-linjen omdøbt
# tilsvarende, ellers ville billedet bygge fint (kilden ville bare mangle),
# og containeren ville først crashe ved selve requesten (fs.readFileSync
# ENOENT), ikke ved build- eller opstartstidspunktet.
COPY internal-country-admin.html ./
COPY internal-choose-country.html ./
# NYT (single auth-løsning): samme "læses direkte via fs.readFileSync ved
# hver request"-mønster som de øvrige HTML-filer herover.
COPY internal-login.html ./
COPY login.html ./
COPY set-password.html ./
COPY overloeb-embed.html ./
COPY badested-skilt.html ./
COPY fetch_currents.py ./
COPY dansk-overloeb-kort.html ./
# Vendoret (ikke CDN-loadet) windy.js-motor for strøm-visualiseringen — se
# windy-currents.js' filhoved. express.static(STATIC_DIR) i server.js
# server dem automatisk, når de blot findes i containeren.
COPY windy-currents.js ./
COPY leaflet-canvas-layer.js ./
# NYT (cross-market admin-dashboard): samme "bevidst offentlig .js-fil, egen
# navngivet route i server.js"-mønster som de to filer ovenfor — se dens
# egen kommentar for hvorfor .js aldrig må dækkes af den generelle
# PUBLIC_STATIC_EXTENSIONS-allowlist.
COPY admin-dashboard-stats.js ./
COPY badevand-risk.js ./
# RETTET (produktionsudfald 2026-08-20 — samme "crasher øjeblikkeligt uden
# denne linje"-fælde som resten af de lokale moduler i denne fil, se
# tenant-admin.js's kommentar ovenfor for den fulde forklaring på hvorfor):
# server.js kræver nu (require('./current-grid')), og badevand-risk-
# worker.js (kørt via worker_threads, se server.js's
# runBadevandRiskCascadeInWorker()) kræver BÅDE badevand-risk.js og denne.
# Manglede oprindeligt her — fik containeren til at crashe i et tæt
# genstarts-loop i produktion (Node: "Cannot find module './current-grid'"),
# eskaleret af Fly's egen rate-limiting på gentagne maskine-genstarter til
# et fuldt udfald af hele siden.
COPY current-grid.js ./
COPY badevand-risk-worker.js ./
# NYT: borgerobservationer (ét-tryks status + algeobservation) — server.js
# kræver (require('./badested-observations')) dette modul ved opstart,
# samme "crasher øjeblikkeligt uden denne linje"-fælde som risk-model.js
# ovenfor. Selve SQLite-databasen/foto-mappen oprettes RUNTIME på
# volumen (/data), IKKE her — kun selve modul-koden er et build-tidspunkt-
# behov.
COPY badested-observations.js ./
# NYT: installations-telemetri + daglig badevands-risikohistorik — server.js
# kræver (require('./app-metrics')) dette modul ved opstart, samme
# "crasher øjeblikkeligt uden denne linje"-fælde som badested-observations.js
# ovenfor (glemt her først, forårsagede et kort produktionsudfald — se
# app-metrics.js's filhoved for modulets formål).
COPY app-metrics.js ./
# RETTET (bruger-krav 2026-08-27): stats.html/GET /stats fjernet — se
# server.js's kommentar hvor ruten stod. COPY-linjen fjernet SAMME sted, i
# samme ændring — ikke efterladt til at pege på en fil, der ikke længere
# findes.
# NYT: web app-manifest + ikoner — forudsætning for PWA-installation, som
# igen er en hård Apple-betingelse for at web push kan virke på iOS.
COPY manifest.json ./
COPY favicon.ico ./
COPY robots.txt ./
COPY icons/ ./icons/
COPY puls-data.json ./
COPY overloeb-sw.js ./

# VP3 geodata (kystvande, badevandsområder, RBU-punkter)
COPY vp3_kystvande_simplified.geojson ./
COPY vp3_badevand.geojson ./
COPY vp3_rbu_slim.geojson ./
COPY vp3_soeer.geojson ./
COPY vp3_vandlob.geojson ./

# RETTET (404 i produktion — samme klasse fejl som rbu-lake-links.json m.fl.
# nedenfor: hentes af frontend'en, fetch(...), men manglede i COPY-listen):
# Danmarks søterritorium (bbox minus land, se scripts/compute-denmark-sea.py),
# bruges til strøm-animationens klip-maske (se denmarkSeaRaw i dansk-
# overloeb-kort.html). denmark_land_simplified.geojson er kun et
# mellemtrins-input til DEN beregning — ikke hentet af klienten længere,
# derfor ikke i denne COPY-liste.
COPY denmark_sea_simplified.geojson ./

# RETTET: disse to filer hentes af frontend'en (fetch('rbu-lake-links.json')
# / fetch('id15-lake-matches.json')) men manglede i COPY-listen — uden denne
# rettelse ville containeren køre fint, men søers RBU- og ID15-opstrøms-
# matching ville stille falde tilbage til navnematch/rumlig nærhed i
# produktion, uden nogen synlig fejl.
COPY rbu-lake-links.json ./
COPY id15-lake-matches.json ./
COPY vandlob-directions.json ./
COPY id15-kystvand-matches.json ./
COPY vandlob-upstream-matches.json ./
COPY vandlob-display.json ./

# Badevand: analyseresultater (E. coli/enterokokker pr. badested) — se
# scripts/build-badevand-analyseresultater.js. Offline forbehandlet, samme
# mønster som id15-lake-matches.json ovenfor: hentes af klienten ved
# indlæsning, opdateres IKKE af den kørende proces.
COPY badevand-analyseresultater.json ./

# NYT: prækomputeret sø-stofbelastning (N/P/COD/BOD fra PULS' egne felter,
# samt miljøfremmede stoffer estimeret via MST-typetal × volumen) — se
# scripts/id15/aggregate-lake-substance-load.js og aggregate-lake-mfs-load.js.
# Samme fald-igennem-uden-fejl-fælde som id15-lake-matches.json ovenfor,
# hvis disse linjer glemmes: appen kører fint, men kan ikke vise sø-
# belastningsdata, uden nogen synlig fejl i logs.
COPY lake-substance-load.json ./
COPY lake-mfs-load.json ./

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production
ENV PYTHON_BIN=python3

CMD ["node", "server.js"]
