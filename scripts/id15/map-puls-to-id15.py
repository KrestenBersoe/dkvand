#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# map-puls-to-id15.py
# ═══════════════════════════════════════════════════════════════════════════
#
# Kortlægger hvert PULS-udløb til dets ID15-delvandopland. I MODSÆTNING til
# build-id15-geometry.py skal dette script genkøres VED HVER PULS-
# dataopdatering — PULS-punkternes indeks/antal ændrer sig løbende, og en
# forældet kortlægning giver stille og roligt forkerte matches i
# match-lakes-via-id15.js uden nogen fejlmeddelelse.
#
# Forudsætninger:
#   pip install shapely pyproj --break-system-packages
#   id15-polygons.json (fra build-id15-geometry.py — geometrien selv ændrer
#     sig sjældent, men skal ligge klar)
#   puls-data.json (den friskeste udgave, fra update-puls.js)
#
# Brug:
#   python3 map-puls-to-id15.py --polygons id15-polygons.json --puls puls-data.json --out .
#
# Output: puls-to-id15.json — { pulsPunktIndex: id15 }
# ═══════════════════════════════════════════════════════════════════════════

import argparse
import json
import sys
import time

try:
    from shapely.geometry import shape, Point
    from shapely.strtree import STRtree
    import pyproj
except ImportError:
    print("Mangler afhængigheder. Kør: pip install shapely pyproj --break-system-packages", file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--polygons', required=True, help='Sti til id15-polygons.json')
    ap.add_argument('--puls', required=True, help='Sti til puls-data.json')
    ap.add_argument('--out', default='.', help='Output-mappe')
    args = ap.parse_args()

    t0 = time.time()
    print(f"Indlæser {args.polygons}...")
    with open(args.polygons) as f:
        polygons = json.load(f)

    from shapely import wkt as wkt_module
    geoms_list = [wkt_module.loads(p['wkt']) for p in polygons]
    id15_keys = [p['id15'] for p in polygons]
    tree = STRtree(geoms_list)
    print(f"  {len(polygons)} oplande indlæst ({time.time()-t0:.1f}s)")

    transformer = pyproj.Transformer.from_crs('EPSG:4326', 'EPSG:25832', always_xy=True)

    def find_containing_id15(x, y):
        pt = Point(x, y)
        for idx in tree.query(pt):
            idx = int(idx)
            if geoms_list[idx].intersects(pt):
                return id15_keys[idx]
        return None

    print(f"Indlæser {args.puls}...")
    with open(args.puls) as f:
        puls = json.load(f)
    d = puls['d']
    print(f"  {len(d)} PULS-punkter")

    t1 = time.time()
    puls_to_id15 = {}
    unmatched = 0
    for i, row in enumerate(d):
        lat, lng = row[0], row[1]
        x, y = transformer.transform(lng, lat)
        id15 = find_containing_id15(x, y)
        if id15 is not None:
            puls_to_id15[i] = id15
        else:
            unmatched += 1
        if i % 5000 == 0:
            print(f"    {i}/{len(d)} ({time.time()-t1:.1f}s)")

    print(f"\nMatchet: {len(puls_to_id15)}/{len(d)} ({unmatched} udenfor alle oplande — typisk direkte kystudledninger)")
    with open(f'{args.out}/puls-to-id15.json', 'w') as f:
        json.dump(puls_to_id15, f)
    print(f"Skrevet puls-to-id15.json ({time.time()-t0:.1f}s total)")


if __name__ == '__main__':
    main()
