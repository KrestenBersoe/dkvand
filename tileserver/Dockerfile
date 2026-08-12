# ═══════════════════════════════════════════════════════════════════════════
# tileserver/Dockerfile — selv-hostet Danmarks-kortserver
#
# Erstatter MapTiler (og før det CARTO, og før det rå tile.openstreetmap.org)
# som baggrundskort-kilde. Se dansk-overloeb-kort.html for hvor fliserne
# faktisk hentes fra, og scripts/tiles/build-denmark-tiles.sh for hvordan
# denmark.mbtiles genereres.
#
# VIGTIGT: bruger den FULDE maptiler/tileserver-gl (ikke -light), fordi
# Planetiler producerer VEKTOR-fliser, og vi skal server-side rendere dem
# til RASTER PNG for at være kompatible med Leaflets L.tileLayer() — kun
# den fulde udgave kan lave den rendering (MapLibre GL Native).
#
# RETTET/RULLET TILBAGE: forsøgte tidligere at tilføje Nginx som cache-lag
# foran TileServer GL (se git-historik hvis det skal genfindes). Det
# krævede at overskrive imagets eget CMD med et selvskrevet opstartsscript,
# som skulle finde og starte TileServer GL manuelt — hvilket gik galt på
# tre forskellige måder i træk (manglende cache-mappe, forkert PATH-
# antagelse, og til sidst en reel binær inkompatibilitet: en frisk npm-
# hentet udgave af tileserver-gl passede ikke til systembibliotekerne i
# dette specifikke image). For en produktionstjeneste er det ikke risikoen
# værd at blive ved med at rette live. Vender tilbage til imagets EGEN,
# testede opstartsmekanisme, helt uændret — ingen cache-lag, men en
# GARANTERET virkende tileserver. Se README.md for en sikrere vej til
# caching (fx Cloudflare foran, som slet ikke kræver at ændre selve
# containerens opstartsproces).
# ═══════════════════════════════════════════════════════════════════════════
FROM maptiler/tileserver-gl:latest

WORKDIR /data

COPY config.json ./config.json
COPY styles/ ./styles/
# RETTET/NYT: TileServer GL medfølger IKKE med skrifttyper som standard —
# uden dem renderes INGEN labels (stednavne, vejnavne) overhovedet, hvilket
# var præcis symptomet der blev observeret. Bundler her de færdiggenererede
# PBF-glyf-filer (ikke rå TTF-fonte — de skal først konverteres med
# specialværktøj, som vi undgår ved at hente allerede-færdige filer fra
# openmaptiles/fonts' gh-pages-branch) for netop de skrifttyper,
# styles/basic.json faktisk refererer til. Kun 6,1 MB, da vi kun medtager
# de 6 skrifttype-varianter, stilen bruger — ikke hele det tilgængelige
# skrifttype-katalog.
COPY fonts/ ./fonts/
# NOTE: denmark.mbtiles genereres IKKE her — den forudsættes allerede at
# ligge i tileserver/data/ (kør scripts/tiles/build-denmark-tiles.sh
# FØRST, lokalt, og commit resultatet — se scriptet for hvorfor tile-
# generering bevidst holdes uden for selve deploy-processen).
COPY data/ ./data/

EXPOSE 8080

# RETTET: manglede --bind 0.0.0.0 — uden den binder TileServer GL som
# standard kun til localhost INDE i containeren, hvilket gør den usynlig
# for Flys proxy udefra (selvom serveren teknisk set kører fint). Viste sig
# som "WARNING The app is not listening on the expected address" ved
# `fly deploy`.
CMD ["--config", "config.json", "--port", "8080", "--bind", "0.0.0.0"]
