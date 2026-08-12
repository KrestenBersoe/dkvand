#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# setup-id15-terrain-model.sh — bygger ID15-terrænmodellen for søers
# opstrøms-matching (geometri, adjacency, DHM-højder, Manning-rejsetider).
#
# KØR SJÆLDENT — kun når:
#   - DCE udgiver en ny version af ID15-shapefilen, ELLER
#   - VP3-søerne ændrer sig ved en planrevision, ELLER
#   - Det er allerførste gang du sætter ID15-modellen op
#
# IKKE en del af update-all-data.sh's almindelige, jævnlige kørsel — dette
# script tager ~40 minutter (primært DHM-highdehentning) og belaster
# Datafordelerens API. Kør det IKKE bare fordi PULS-data er opdateret; det
# er map-puls-to-id15.py (kørt af update-all-data.sh) der holder PULS-
# koblingen frisk, uden at røre selve terrænmodellen.
#
# Forudsætninger:
#   - Python3 med shapely, pyshp, pyproj (pip install shapely pyshp pyproj --break-system-packages)
#   - Miljøvariablen DHM_APIKEY sat (Datafordeler-nøgle)
#   - ID15-shapefilen hentet MANUELT (ikke en del af Miljøportalens WFS):
#       https://landbrugsgeodata.fvm.dk/ → Vandmiljøplaner → ID15_VP3_II_2025.zip
#     pakket ud i scripts/id15/ (ID15_VP3_II_2025.shp/.dbf/.prj/.shx)
#   - En frisk vp3_soeer_raw.geojson (RÅ udgave — kør fetch-vp3-all.js først,
#     eller genbrug $TMP_DIR-versionen fra en update-all-data.sh-kørsel)
#
# Brug:
#   DHM_APIKEY=xxx ./scripts/id15/setup-id15-terrain-model.sh [sti-til-vp3_soeer_raw.geojson]
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SOEER_RAW="${1:-./vp3_soeer_raw.geojson}"

if [ -z "${DHM_APIKEY:-}" ]; then
  echo "❌ DHM_APIKEY er ikke sat. Kør: DHM_APIKEY=xxx $0"
  exit 1
fi
if [ ! -f "ID15_VP3_II_2025.shp" ]; then
  echo "❌ ID15_VP3_II_2025.shp mangler i $SCRIPT_DIR."
  echo "   Hent manuelt fra https://landbrugsgeodata.fvm.dk/ (Vandmiljøplaner →"
  echo "   ID15_VP3_II_2025.zip) og pak ud her."
  exit 1
fi
if [ ! -f "$SOEER_RAW" ]; then
  echo "❌ $SOEER_RAW ikke fundet. Angiv sti som argument, eller kør"
  echo "   fetch-vp3-all.js først for at hente en frisk vp3_soeer_raw.geojson."
  exit 1
fi

echo "════════════════════════════════════════════════════════════════"
echo " ID15-terrænmodel — opsætning (sjældent kørt)"
echo "════════════════════════════════════════════════════════════════"
echo

echo "── Trin 1/4: Geometri, adjacency og sø-kobling (Python/shapely) ──"
python3 build-id15-geometry.py \
  --shapefile ID15_VP3_II_2025 \
  --soeer "$SOEER_RAW" \
  --out .
echo

echo "── Trin 2/4: DHM-minimumshøjde pr. opland (Datafordeleren, ~40 min) ─"
echo "  Kan afbrydes og genoptages trygt — gemmer løbende."
node build-id15-flow-graph.js
echo

echo "── Trin 3/4: Manning-rejsetider (lokal beregning, sekunder) ──────"
node compute-travel-times.js
echo

echo "── Trin 4/4: Første PULS-kobling + sø-matching ────────────────────"
if [ -f ../../puls-data.json ]; then
  python3 map-puls-to-id15.py --polygons id15-polygons.json --puls ../../puls-data.json --out .
  node match-lakes-via-id15.js
  echo "  ✅ id15-lake-matches.json klar — kopiér til projektroden hvis den ikke allerede ligger der."
else
  echo "  ⚠ ../../puls-data.json ikke fundet — sprunget over. Kør"
  echo "    update-all-data.sh (som selv kalder map-puls-to-id15.py + match-lakes-via-id15.js)"
  echo "    for at færdiggøre koblingen, når PULS-data findes."
fi
echo

echo "════════════════════════════════════════════════════════════════"
echo " Terrænmodel klar. id15-flow-graph.json og id15-travel-times.json"
echo " er nu opdaterede — almindelige update-all-data.sh-kørsler genbruger"
echo " dem uden at røre DHM-API'et igen, indtil du kører dette script næste gang."
echo "════════════════════════════════════════════════════════════════"
