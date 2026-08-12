# Selv-hostet kortserver (Danmark)

Erstatter MapTiler som baggrundskort-kilde. Ingen ekstern kvote, ingen API-nøgle.

## Baggrund

Appen har tidligere skiftet leverandør flere gange, hver gang det "gratis"
niveau blev strammet uden varsel: rå `tile.openstreetmap.org` → CARTO →
MapTiler. Denne opsætning bryder mønstret permanent ved selv at generere og
hoste kortfliser for Danmark, baseret på OpenStreetMap-data — samme
kildedata MapTiler i øvrigt selv bruger.

## Arkitektur

```
scripts/tiles/build-denmark-tiles.sh   → genererer denmark.mbtiles (lokalt, periodisk)
tileserver/data/denmark.mbtiles        → selve fliserne (vektor, OpenMapTiles-skema)
tileserver/styles/basic.json           → kartografisk stil (Positron-baseret, lys)
tileserver/config.json                 → TileServer GL's opsætning
tileserver/Dockerfile + fly.toml       → deployes som EGEN Fly.io-app: dkvand-tiles
```

Hoved-appen (`dansk-overloeb-kort.html`) henter fliser fra
`https://dkvand-tiles.fly.dev/styles/basic/{z}/{x}/{y}.png` — se
`TILE_SERVER_URL`-konstanten i filen.

**Bevidst holdt simpelt:** containeren kører udelukkende TileServer GL,
uændret fra imagets egen, testede opstartsmekanisme — intet cache-lag,
ingen ekstra processer. Et tidligere forsøg på at tilføje Nginx som
cache-lag foran TileServer GL blev rullet tilbage, efter det gav flere
runder af opstartsfejl (manglende mapper, forkerte PATH-antagelser, og til
sidst en binær inkompatibilitet mellem en frisk npm-hentet udgave og
imagets systembiblioteker). For en produktionstjeneste er det ikke
risikoen værd.

## Hastighed/kapacitet uden cache-lag

To simple, lavrisiko-tiltag adresserer det oprindelige problem (langsom/
ufuldstændig levering) uden at røre ved containerens opstartsproces:
- **`min_machines_running = 1`** (fly.toml) — undgår "kolde opstarter",
  hvor en helt ny maskine skal boote og indlæse 373+ MB data, før den kan
  svare på noget som helst.
- **2 GB RAM** (op fra 1 GB) — server-side vektor→raster-rendering er
  hukommelseskrævende, særligt med fonte og fuld stil tilkoblet.

**Hvis dette ikke er nok, er den sikreste vej til yderligere caching et
lag UDENFOR containeren** — fx Cloudflare foran `dkvand-tiles.fly.dev`
(kræver et domæne, I selv styrer DNS for — se tidligere diskussion) eller
Flys egen `[[statics]]`/CDN-funktionalitet, hvis den dækker behovet. Begge
kræver ikke at ændre selve containerens interne opstartsproces, og bærer
derfor ikke samme risiko som Nginx-forsøget.

## Førstegangsopsætning

```bash
# 1. Generér fliser (kræver Docker lokalt, tager nogle minutter for Danmark)
chmod +x scripts/tiles/build-denmark-tiles.sh
./scripts/tiles/build-denmark-tiles.sh

# 2. Opret Fly-appen (kun allerførste gang)
cd tileserver
fly launch --name dkvand-tiles --no-deploy

# 3. Deploy
fly deploy -a dkvand-tiles

# 4. Bekræft det virker (bør returnere et faktisk PNG-billede)
curl -o /tmp/test-tile.png https://dkvand-tiles.fly.dev/styles/basic/6/34/20.png
file /tmp/test-tile.png   # skal sige "PNG image data"
```

## Løbende vedligehold

OSM-data ændrer sig (nye veje, stednavne). For en vandkvalitets-app, hvor
formålet er risikovisning frem for gadenavigation, er en genkørsel et par
gange om året rigeligt:

```bash
./scripts/tiles/build-denmark-tiles.sh
cd tileserver && fly deploy -a dkvand-tiles
```

## Efter migrering: ryd op i den gamle MapTiler-nøgle

`MAPTILER_KEY` bruges ikke længere af hoved-appen. Kan roligt fjernes:

```bash
fly secrets unset MAPTILER_KEY -a dkvand
```

## Filstørrelse

`denmark.mbtiles` genereres med `--maxzoom=14` (se build-scriptet for
begrundelse) — typisk et par GB. Bliver den upraktisk stor for almindelig
git-håndtering, brug Git LFS:

```bash
git lfs install
git lfs track "tileserver/data/*.mbtiles"
```

## Kvalitet vs. MapTiler

Samme underliggende OpenStreetMap-data, samme OpenMapTiles-skema. Den
kartografiske stil her er baseret på Positron (samme stilart OpenFreeMap
selv bruger) — visuelt tæt på, men ikke pixel-for-pixel identisk med
MapTilers proprietære "basic-v2"-stil. Justér farver/lag i
`tileserver/styles/basic.json` frit — det er almindelig MapLibre GL-stil-
JSON, veldokumenteret format.
