#!/usr/bin/env bash
# Downloads OSM data extracts (Denmark, Great Britain, Ireland+NI, France),
# merges them, and renders one shared vector tile set (z0-14) for
# dkvand/ukwater/frwater. See README.md for background and requirements.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"
MAXZOOM=14
MERGED_PBF="$DATA_DIR/merged.osm.pbf"
OUTPUT_PMTILES="$DATA_DIR/coverage.pmtiles"

declare -A EXTRACTS=(
  [denmark]="https://download.geofabrik.de/europe/denmark-latest.osm.pbf"
  [great-britain]="https://download.geofabrik.de/europe/great-britain-latest.osm.pbf"
  [ireland-and-northern-ireland]="https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf"
  [france]="https://download.geofabrik.de/europe/france-latest.osm.pbf"
)

mkdir -p "$DATA_DIR"

echo "== Downloading extracts =="
for name in "${!EXTRACTS[@]}"; do
  dest="$DATA_DIR/${name}.osm.pbf"
  if [[ -f "$dest" ]]; then
    echo "  $name: already downloaded, skipping"
  else
    echo "  $name: downloading..."
    curl -fL --progress-bar "${EXTRACTS[$name]}" -o "$dest.tmp"
    mv "$dest.tmp" "$dest"
  fi
done

echo "== Merging extracts with osmium =="
if ! command -v osmium &>/dev/null; then
  echo "osmium-tool not found. Install it (apt install osmium-tool / brew install osmium-tool) and re-run." >&2
  exit 1
fi
MERGE_INPUTS=()
for name in "${!EXTRACTS[@]}"; do
  MERGE_INPUTS+=("$DATA_DIR/${name}.osm.pbf")
done
osmium merge "${MERGE_INPUTS[@]}" -o "$MERGED_PBF" --overwrite

echo "== Running Planetiler =="
if ! command -v docker &>/dev/null; then
  echo "Docker not found. Install Docker, or run Planetiler directly via a local JAR instead." >&2
  exit 1
fi
docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx8g" \
  -v "$DATA_DIR":/data \
  ghcr.io/onthegomap/planetiler:latest \
  --osm-path=/data/merged.osm.pbf \
  --output=/data/coverage.pmtiles \
  --maxzoom="$MAXZOOM"
# NOTE: verify --maxzoom against `docker run ghcr.io/onthegomap/planetiler:latest --help`
# before relying on this — not independently confirmed against current Planetiler docs.

echo "== Done =="
ls -lh "$OUTPUT_PMTILES"
