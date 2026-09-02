# Shared vector tile pipeline (dkvand / ukwater / frwater)

Builds one vector tile set covering all three sites' coverage areas, to
replace live tile fetches (currently MapTiler for dkvand; OSM directly for
ukwater/frwater) with a self-hosted, pre-rendered artifact cached at
Cloudflare's edge.

Background: OSM's [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
prohibits bulk/pre-emptive downloading from `tile.openstreetmap.org` and is
"best-effort" with no SLA — not viable to build production traffic on. This
pipeline avoids that entirely: it downloads raw OSM *data* extracts (governed
by the ODbL, not the tile policy) from Geofabrik and renders our own tiles
from them, so it never talks to OSM's tile servers.

## Coverage

| Region | Geofabrik extract | Size |
|---|---|---|
| Denmark | `europe/denmark-latest.osm.pbf` | ~470 MB |
| Great Britain | `europe/great-britain-latest.osm.pbf` | ~2.0 GB |
| Ireland and Northern Ireland | `europe/ireland-and-northern-ireland-latest.osm.pbf` | ~392 MB |
| France (+ Corsica) | `europe/france-latest.osm.pbf` | ~4.7 GB |

(Sizes as of 2026-08-31; check https://download.geofabrik.de/europe.html for
current figures before running.)

## Zoom

Capped at **z14** to match the deepest zoom any of the three apps actually
uses (`setView` calls in dkvand top out at 14 — see `dansk-overloeb-kort.html`).
Vector tiles support client-side overzoom past their max generated level, so
z14 source data can still render at z18+ display zoom with no extra tiles.

Estimated output at z0–14 across all four regions: ~1.42M unique tiles.
Rough size: ~21 GB if this were raster; vector (this pipeline) should land
in the low single-digit GB — confirm with the real build, don't trust the
estimate.

## Pipeline

1. `build-tiles.sh` downloads the four extracts, merges them with
   [osmium-tool](https://osmcode.org/osmium-tool/), and runs
   [Planetiler](https://github.com/onthegomap/planetiler) to produce one
   `.pmtiles` file (OpenMapTiles schema, z0–14).
2. **Not yet automated**: upload the resulting `.pmtiles` to Cloudflare R2,
   serve it via the PMTiles HTTP protocol (range requests, no live tile
   server needed), and put a Cloudflare Cache Rule in front.
3. **Not yet automated**: point each site's map (MapLibre GL, once migrated
   off Leaflet — see the raster→vector migration plan) at the hosted
   PMTiles URL.

## Requirements to run

- `osmium-tool` (`apt install osmium-tool` / `brew install osmium-tool`)
- Docker (for the Planetiler image), or a local Planetiler JAR + Java 17+
- **~10-15 GB free disk minimum**: ~7.6 GB raw extracts + merged file +
  build output + Planetiler's working temp files. Not sized for a
  disk-quota-constrained sandbox — run on a build machine or CI runner
  with adequate space, not ad hoc in a constrained session.
- Real build time not yet measured for this combined region set; budget for
  it to take a while (Planetiler's own planet-scale benchmarks run
  minutes-to-hours depending on hardware — this is a small fraction of
  planet size, but untested here).

## Usage

```
./build-tiles.sh
```

Output: `tiles/data/coverage.pmtiles`
