#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# fetch-and-simplify-denmark-land.py
# ═══════════════════════════════════════════════════════════════════════════
#
# Henter Danmarks fulde landpolygon (DAGI "danmark_current", SDFI/Datafordeler
# WFS) og forenkler den til en klient-visnings-fil — samme mønster som
# scripts/id15/simplify-vandlob-for-display.py (shapely .simplify(), UTM32-
# reprojektion, 6-decimal afrunding), se dén for den fulde begrundelse.
#
# HVORFOR: strøm-animationens klip-maske (updateWaterClipPath() i dansk-
# overloeb-kort.html) var hidtil en POSITIV maske — union af VP3's navngivne
# kystvande-/sø-polygoner (~43.581 km², kun regulatorisk klassificerede
# vandområder). Store dele af åbent dansk farvand (Kattegat/Skagerrak uden
# for de klassificerede områder) var derfor aldrig dækket, uafhængigt af om
# CMEMS-data fandtes. Denne fil bruges i stedet til en NEGATIV maske —
# "alt UNDTAGEN land" — som dækker AL dansk kystnær hav, ikke kun de
# navngivne vandområder.
#
# Landpolygonen (DAGI "danmark_current") er ~28 MB rå — alt for stor til
# klienten. Forenkles her ned til noget der kan sendes/parses hurtigt, uden
# mærkbart tab af visuel præcision ved almindelige web-kort-zoomniveauer.
#
# Brug:
#   pip install shapely pyproj --break-system-packages   (hvis ikke allerede installeret)
#   SKAERMKORT_API_KEY=<key> python3 scripts/fetch-and-simplify-denmark-land.py [--tolerance 30]
#
# Output: denmark_land_simplified.geojson (repo-rod, samme placering som
# vp3_kystvande_simplified.geojson m.fl.) — KUN den forenklede fil committes,
# ligesom vp3_kystvande_simplified.geojson (ingen rå kilde-kopi i repoet,
# samme konvention).
# ═══════════════════════════════════════════════════════════════════════════

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

try:
    from shapely.geometry import shape, mapping
    from shapely.ops import transform as shapely_transform
    import pyproj
except ImportError:
    print("Mangler afhængigheder. Kør: pip install shapely pyproj --break-system-packages", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).parent.parent
WFS_URL = 'https://wfs.datafordeler.dk/DAGI/DAGI_WFS/1.0.0/WFS'


def fetch_denmark_land(apikey):
    params = {
        'SERVICE': 'WFS', 'REQUEST': 'GetFeature', 'VERSION': '2.0.0',
        'TYPENAMES': 'dagi_v001:danmark_current',
        'SRSNAME': 'EPSG:4326', 'outputFormat': 'application/json',
        'apikey': apikey,
    }
    url = WFS_URL + '?' + '&'.join(f'{k}={v}' for k, v in params.items())
    print("Henter DAGI danmark_current (~28 MB, kan tage et øjeblik)...")
    with urllib.request.urlopen(url, timeout=120) as resp:
        return json.load(resp)


def main():
    parser = argparse.ArgumentParser(description="Henter og forenkler DAGI's danmark_current landpolygon til en klient-visnings-kopi.")
    parser.add_argument('--output', default=str(REPO_ROOT / 'denmark_land_simplified.geojson'))
    parser.add_argument('--tolerance', type=float, default=30.0, help="Forenklingstolerance i METER — rent visuel klip-maske, ikke præcisionsklassificering, så en større tolerance end vandlob-scriptets 12 m er acceptabel her")
    args = parser.parse_args()

    apikey = os.environ.get('SKAERMKORT_API_KEY', '').strip()
    if not apikey:
        print("SKAERMKORT_API_KEY mangler i miljøet (samme nøgle som resten af Datafordeler-integrationen).", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    geojson = fetch_denmark_land(apikey)
    features = geojson.get('features', [])
    print(f"  {len(features)} feature(s) hentet.")
    if not features:
        print("Ingen features modtaget — tjek apikey/typename.", file=sys.stderr)
        sys.exit(1)

    to_utm = pyproj.Transformer.from_crs('EPSG:4326', 'EPSG:25832', always_xy=True)
    to_wgs = pyproj.Transformer.from_crs('EPSG:25832', 'EPSG:4326', always_xy=True)

    def reproject(geom, transformer):
        return shapely_transform(lambda x, y: transformer.transform(x, y), geom)

    def coord_count(geom):
        if geom.geom_type == 'Polygon':
            return len(geom.exterior.coords) + sum(len(r.coords) for r in geom.interiors)
        if geom.geom_type == 'MultiPolygon':
            return sum(coord_count(g) for g in geom.geoms)
        return 0

    total_before = total_after = 0
    out_features = []
    for feat in features:
        geom_dict = feat.get('geometry')
        if not geom_dict:
            continue
        geom_wgs = shape(geom_dict)
        total_before += coord_count(geom_wgs)

        geom_utm = reproject(geom_wgs, to_utm)
        geom_simplified_utm = geom_utm.simplify(args.tolerance, preserve_topology=True)
        geom_simplified_wgs = reproject(geom_simplified_utm, to_wgs)
        # RETTET (se scripts/id15/simplify-vandlob-for-display.py's filhoved
        # for hvorfor): rund til 6 decimaler for at fjerne rundtrips-støj fra
        # frem-og-tilbage-reprojektionen, ellers overgår støjen let selve
        # besparelsen fra punkt-reduktionen.
        geom_simplified_wgs = shapely_transform(lambda x, y: (round(x, 6), round(y, 6)), geom_simplified_wgs)
        total_after += coord_count(geom_simplified_wgs)

        out_features.append({
            'type': 'Feature',
            'properties': feat.get('properties', {}),
            'geometry': mapping(geom_simplified_wgs),
        })

    out = {'type': 'FeatureCollection', 'features': out_features}
    output_path = Path(args.output)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))

    size_after = output_path.stat().st_size
    reduction_pct = 100 * (1 - total_after / total_before) if total_before else 0
    print(f"\nKoordinater: {total_before} → {total_after} ({reduction_pct:.1f}% reduktion)")
    print(f"Filstørrelse: {size_after/1_000_000:.2f} MB")
    print(f"Skrevet: {output_path} ({time.time()-t0:.1f}s)")


if __name__ == '__main__':
    main()
