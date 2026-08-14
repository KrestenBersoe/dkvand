#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# compute-denmark-sea.py
# ═══════════════════════════════════════════════════════════════════════════
#
# Beregner selve HAV-polygonen (en bounding box om hele Danmark, MINUS
# landpolygonen fra fetch-and-simplify-denmark-land.py) som en RIGTIG
# geometrisk differens (shapely .difference()) — output er ÉN eller flere
# POSITIVE polygoner (med øer som interne "huller", en almindelig, veldefineret
# GeoJSON-struktur), IKKE en kunstig skærm-rektangel-plus-hul-teknik.
#
# HVORFOR (i stedet for den tidligere klient-side "baggrunds-rektangel minus
# land, evenodd"-teknik i updateWaterClipPath()): den blandede skærm-
# koordinat-rektangel (bygget fra map.getSize()) sammen med geografisk
# udledte land-ringe (via map.latLngToContainerPoint()) i ÉN evenodd-sti
# viste sig IKKE at virke korrekt i en rigtig browser (bruger-rapport:
# strøm-animation over HELE land, ikke kun hav) — trods gentagen
# kildekode-gennemgang, der ikke fandt en logisk fejl. Denne fil erstatter
# den tilgang med PRÆCIS samme mønster, som allerede beviseligt VIRKEDE
# korrekt tidligere i dag (VP3 kystvande-polygonernes simple UNION, ingen
# kunstig rektangel, alle koordinater fra ÉN kilde, ens behandlet).
#
# Brug:
#   python3 scripts/compute-denmark-sea.py
#   (kræver denmark_land_simplified.geojson allerede genereret, se
#   fetch-and-simplify-denmark-land.py)
#
# Output: denmark_sea_simplified.geojson (repo-rod)
# ═══════════════════════════════════════════════════════════════════════════

import json
import sys
import time
from pathlib import Path

try:
    from shapely.geometry import shape, mapping, box
    from shapely.ops import transform as shapely_transform, unary_union
    import pyproj
except ImportError:
    print("Mangler afhængigheder. Kør: pip install shapely pyproj --break-system-packages", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).parent.parent

# Generøs margin ud over selve landet (54.5-57.7N, 8.07-15.2E) — dækker
# dansk søterritorium/EEZ i alle retninger, inkl. Vesterhavet mod vest.
LAT_MIN, LAT_MAX = 53.3, 58.5
LON_MIN, LON_MAX = 6.5, 16.0


def main():
    input_path = REPO_ROOT / 'denmark_land_simplified.geojson'
    output_path = REPO_ROOT / 'denmark_sea_simplified.geojson'

    t0 = time.time()
    print(f"Indlæser {input_path}...")
    with open(input_path, encoding='utf-8') as f:
        land_geojson = json.load(f)

    land_geoms = [shape(f['geometry']) for f in land_geojson['features'] if f.get('geometry')]
    land_union = unary_union(land_geoms)
    print(f"  Land indlæst: {land_union.geom_type}")

    bbox = box(LON_MIN, LAT_MIN, LON_MAX, LAT_MAX)
    print("Beregner hav = bbox - land (shapely difference)...")
    sea = bbox.difference(land_union)
    print(f"  Hav beregnet: {sea.geom_type}")

    def coord_count(geom):
        if geom.geom_type == 'Polygon':
            return len(geom.exterior.coords) + sum(len(r.coords) for r in geom.interiors)
        if geom.geom_type == 'MultiPolygon':
            return sum(coord_count(g) for g in geom.geoms)
        return 0

    n_coords = coord_count(sea)
    print(f"  {n_coords} koordinater i resultatet.")

    # RETTET (samme rundtrips-støj-problem som i fetch-and-simplify-denmark-
    # land.py — afrund til 6 decimaler for at holde filstørrelsen nede;
    # ingen yderligere .simplify() nødvendig her, da land-inputtet allerede
    # er forenklet, og selve differensen ikke tilføjer ekstra detaljer ud
    # over bbox'ens fire hjørner).
    sea_rounded = shapely_transform(lambda x, y: (round(x, 6), round(y, 6)), sea)

    out = {
        'type': 'FeatureCollection',
        'features': [{
            'type': 'Feature',
            'properties': {'name': 'Danmark sø-territorium (bbox minus land)'},
            'geometry': mapping(sea_rounded),
        }],
    }
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))

    size = output_path.stat().st_size
    print(f"\nFilstørrelse: {size/1_000_000:.2f} MB")
    print(f"Skrevet: {output_path} ({time.time()-t0:.1f}s)")


if __name__ == '__main__':
    main()
