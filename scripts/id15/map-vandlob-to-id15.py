#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# map-vandlob-to-id15.py
# ═══════════════════════════════════════════════════════════════════════════
#
# Kortlægger hver vandløbslinjes TO ENDEPUNKTER til deres respektive ID15-
# delvandopland. Dette er forberedelsestrinnet for at udlede strømretning —
# selve retnings-/sikkerhedsberegningen sker i compute-vandlob-directions.js,
# som bruger denne fils output sammen med den allerede byggede
# id15-flow-graph.json (samme flow-graf, søernes opstrøms-matching allerede
# bruger — se match-lakes-via-id15.js).
#
# HVORFOR ENDEPUNKTER, IKKE HELE LINJEN: en vandløbslinje kan krydse flere
# ID15-oplande undervejs, men selve RETNINGEN kan udledes alene af hvilket
# opland hver ende ligger i — falder begge ender i SAMME opland, kan
# ID15-niveauets data (kilometerstore enheder) ikke sige noget meningsfuldt
# om retningen for netop dén linje, og den markeres usikker (se
# compute-vandlob-directions.js).
#
# GeoJSON-linjens digitaliseringsrækkefølge (hvilket punkt der står FØRST i
# koordinatlisten) antages IKKE at afspejle den faktiske strømretning — det
# er blot rækkefølgen, data blev tegnet i. De to endepunkter navngives
# derfor neutralt "a" og "b" her; det er ID15-flow-grafen, der efterfølgende
# afgør hvilken af de to der reelt er opstrøms.
#
# Forudsætninger:
#   pip install shapely pyproj --break-system-packages
#   id15-polygons.json (fra build-id15-geometry.py)
#   vp3_vandlob_raw.geojson (fra fetch-vp3-all.js, RÅ udgave — ikke den
#     simplificerede vp3_vandlob.geojson appen bruger til visning, for at
#     bevare præcise endepunkt-koordinater)
#
# Brug:
#   python3 map-vandlob-to-id15.py --polygons id15-polygons.json --vandlob vp3_vandlob_raw.geojson --out .
#
# Output: vandlob-to-id15.json —
#   [{ index: <linjeindeks i kildefilen>, id15A: <id15 for endepunkt A eller null>,
#      id15B: <id15 for endepunkt B eller null> }, ...]
# ═══════════════════════════════════════════════════════════════════════════

import argparse
import json
import sys
import time

try:
    from shapely.geometry import shape, Point
    from shapely.strtree import STRtree
    from shapely import wkt as wkt_module
    import pyproj
except ImportError:
    print("Mangler afhængigheder. Kør: pip install shapely pyproj --break-system-packages", file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--polygons', required=True, help='Sti til id15-polygons.json')
    ap.add_argument('--vandlob', required=True, help='Sti til vp3_vandlob_raw.geojson (RÅ udgave)')
    ap.add_argument('--out', default='.', help='Output-mappe')
    args = ap.parse_args()

    t0 = time.time()
    print(f"Indlæser {args.polygons}...")
    with open(args.polygons) as f:
        polygons = json.load(f)

    geoms_list = [wkt_module.loads(p['wkt']) for p in polygons]
    id15_keys = [p['id15'] for p in polygons]
    tree = STRtree(geoms_list)
    print(f"  {len(polygons)} oplande indlæst ({time.time()-t0:.1f}s)")

    # RETTET-STIL (samme som map-puls-to-id15.py): VP3-kildedata er i
    # EPSG:4326 (lat/lng), ID15-geometrien er i EPSG:25832 (UTM zone 32N,
    # samme projektion som resten af ID15-rørledningen bruger) — begge
    # skal være i SAMME koordinatsystem, før et STRtree-opslag giver mening.
    transformer = pyproj.Transformer.from_crs('EPSG:4326', 'EPSG:25832', always_xy=True)

    def find_containing_id15(x, y):
        pt = Point(x, y)
        for idx in tree.query(pt):
            idx = int(idx)
            if geoms_list[idx].intersects(pt):
                return id15_keys[idx]
        return None

    print(f"Indlæser {args.vandlob}...")
    with open(args.vandlob) as f:
        vandlob = json.load(f)
    features = vandlob['features']
    print(f"  {len(features)} vandløbslinjer")

    def line_endpoints(geom):
        """Returnerer (a, b) som (lng, lat)-par for en LineString eller
        MultiLineString's FØRSTE og SIDSTE koordinat i digitaliserings-
        rækkefølgen — se filhovedets note om at denne rækkefølge IKKE
        antages at være den faktiske strømretning."""
        gtype = geom.geom_type
        if gtype == 'LineString':
            coords = list(geom.coords)
            return coords[0], coords[-1]
        elif gtype == 'MultiLineString':
            # Sammensæt til én logisk streng: første koordinat i FØRSTE del,
            # sidste koordinat i SIDSTE del. Multi-dele optræder typisk i
            # digitaliseringsrækkefølge i VP3-data, men selv hvis ikke,
            # ændrer det intet ved metoden — a/b er stadig neutrale
            # endepunkter, som ID15-flow-grafen efterfølgende tolker.
            parts = list(geom.geoms)
            return list(parts[0].coords)[0], list(parts[-1].coords)[-1]
        return None, None

    t1 = time.time()
    results = []
    unmatched_both, unmatched_one = 0, 0
    for i, feat in enumerate(features):
        geom = shape(feat['geometry'])
        a, b = line_endpoints(geom)
        if a is None:
            continue

        ax, ay = transformer.transform(a[0], a[1])
        bx, by = transformer.transform(b[0], b[1])
        id15A = find_containing_id15(ax, ay)
        id15B = find_containing_id15(bx, by)

        if id15A is None and id15B is None:
            unmatched_both += 1
            continue
        if id15A is None or id15B is None:
            unmatched_one += 1

        results.append({'index': i, 'id15A': id15A, 'id15B': id15B})

        if i % 1000 == 0:
            print(f"    {i}/{len(features)} ({time.time()-t1:.1f}s)")

    print(f"\nMatchet: {len(results)}/{len(features)}")
    print(f"  Begge ender udenfor alle oplande: {unmatched_both}")
    print(f"  Kun én ende matchet: {unmatched_one}")

    with open(f'{args.out}/vandlob-to-id15.json', 'w') as f:
        json.dump(results, f)
    print(f"Skrevet vandlob-to-id15.json ({time.time()-t0:.1f}s total)")


if __name__ == '__main__':
    main()
