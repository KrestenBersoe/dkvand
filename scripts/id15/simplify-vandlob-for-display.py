#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# simplify-vandlob-for-display.py
# ═══════════════════════════════════════════════════════════════════════════
#
# Genererer en FORENKLET, klient-visnings-KOPI af vp3_vandlob.geojson —
# reducerer antal koordinater pr. linje via Douglas-Peucker-forenkling
# (shapely's .simplify(), samme algoritme mapshaper også bruger), for at
# reducere både overførselsstørrelse OG selve JSON.parse()-omkostningen i
# browseren. Se samtalen om første-sidevisnings ydelse: selve Leaflet-
# lagopbygningen viste sig hurtig (25 ms for 6.679 linjer) — den reelle
# omkostning var at PARSE den store, ukomprimerede JSON-tekst (~1000 ms),
# noget HTTP-komprimering (allerede bekræftet aktiv) ikke kan afhjælpe,
# da browseren under alle omstændigheder skal parse den fulde, dekomprimerede
# tekst.
#
# BEVIDST, VELBEGRUNDET TOLERANCE-VALG: bufferzonen der allerede bruges til
# vandmaskering (VANDLOB_BUFFER_DEG i dansk-overloeb-kort.html) er ~100 m.
# Tolerancen her er sat markant lavere (12 m som standard) — enhver
# geometrisk afvigelse forenklingen introducerer, opsluges derved fuldt af
# den eksisterende margin, uden at ændre noget reelt vandmasker-udfald.
# Bruger preserve_topology=True (undgår selvskærende linjer, som simplify()
# uden denne kan introducere ved for aggressiv forenkling — ikke relevant
# ved denne lave tolerance, men en billig sikkerhedsforanstaltning).
#
# VIGTIGT: rører IKKE selve originalfilen. Den fulde, upåvirkede geometri
# skal fortsat bruges af den offline ID15-analyse (map-vandlob-to-id15.py
# m.fl.) — kun denne NYE, separate fil er beregnet til klientens visning.
#
# Brug:
#   pip install shapely pyproj --break-system-packages   (hvis ikke allerede installeret)
#   python3 simplify-vandlob-for-display.py [--tolerance 12]
#
# Output: vp3_vandlob_simplified.geojson (samme mappe som originalen)
# ═══════════════════════════════════════════════════════════════════════════

import argparse
import json
import sys
import time
from pathlib import Path

try:
    from shapely.geometry import shape, mapping
    from shapely.ops import transform as shapely_transform
    import pyproj
except ImportError:
    print("Mangler afhængigheder. Kør: pip install shapely pyproj --break-system-packages", file=sys.stderr)
    sys.exit(1)

DIR = Path(__file__).parent


def main():
    parser = argparse.ArgumentParser(description="Forenkler vp3_vandlob.geojson til en klient-visnings-kopi.")
    parser.add_argument('--input', default=str(DIR / 'vp3_vandlob.geojson'), help="Original, ufortyndet fil (røres ikke)")
    parser.add_argument('--output', default=str(DIR / 'vp3_vandlob_simplified.geojson'), help="Ny, forenklet fil til klientens visning")
    parser.add_argument('--tolerance', type=float, default=12.0, help="Forenklingstolerance i METER — hold denne markant under den ~100 m vandmasker-buffer, se filhoved for begrundelse")
    args = parser.parse_args()

    t0 = time.time()
    print(f"Indlæser {args.input}...")
    with open(args.input, encoding='utf-8') as f:
        geojson = json.load(f)

    features = geojson.get('features', [])
    print(f"  {len(features)} vandløbslinjer indlæst.")

    # Samme projektion som resten af ID15-værktøjskæden (EPSG:25832, UTM
    # zone 32N) — .simplify()'s tolerance er i PROJEKTIONENS enhed (meter
    # her), ikke grader, så forenkling skal ske i denne projektion, ikke
    # direkte på de rå lat/lng-koordinater.
    to_utm  = pyproj.Transformer.from_crs('EPSG:4326', 'EPSG:25832', always_xy=True)
    to_wgs  = pyproj.Transformer.from_crs('EPSG:25832', 'EPSG:4326', always_xy=True)

    def reproject(geom, transformer):
        return shapely_transform(lambda x, y: transformer.transform(x, y), geom)

    total_coords_before = 0
    total_coords_after  = 0
    skipped = 0

    for feat in features:
        geom_dict = feat.get('geometry')
        if not geom_dict:
            continue
        try:
            geom_wgs = shape(geom_dict)
            n_before = len(geom_wgs.coords) if geom_wgs.geom_type == 'LineString' else sum(len(l.coords) for l in geom_wgs.geoms)
            total_coords_before += n_before

            geom_utm = reproject(geom_wgs, to_utm)
            geom_simplified_utm = geom_utm.simplify(args.tolerance, preserve_topology=True)
            geom_simplified_wgs = reproject(geom_simplified_utm, to_wgs)

            n_after = len(geom_simplified_wgs.coords) if geom_simplified_wgs.geom_type == 'LineString' else sum(len(l.coords) for l in geom_simplified_wgs.geoms)
            total_coords_after += n_after

            # RETTET (selv-fanget efter første kørsel på ægte data — filen
            # blev STØRRE trods færre koordinater): frem-og-tilbage-
            # projektionen (WGS84 → UTM meter → WGS84) rammer aldrig
            # præcis de oprindelige, ofte 5-7-cifrede koordinatværdier
            # igen — resultatet er typisk 15-17 cifre "støj" (fx
            # 10.123449999999997 i stedet for det oprindelige 10.12345).
            # Hvert ENKELT tal fylder derved markant mere i JSON-teksten
            # end originalen, hvilket let opsluger (og i dette tilfælde
            # overgik) hele besparelsen fra selve punkt-reduktionen.
            # Afrundes derfor til 6 decimaler (~11 cm præcision ved
            # danske breddegrader) — langt mere præcist end den valgte
            # forenklings-tolerance (12 m) i forvejen kræver, men fjerner
            # al den unødvendige støj fra selve teksten.
            geom_simplified_wgs = shapely_transform(
                lambda x, y: (round(x, 6), round(y, 6)), geom_simplified_wgs)

            feat['geometry'] = mapping(geom_simplified_wgs)
        except Exception as e:
            print(f"  ⚠ Sprang en linje over ({e}) — beholder original geometri for denne", file=sys.stderr)
            skipped += 1
            total_coords_after += n_before  # uændret, tæl som bevaret

    reduction_pct = 100 * (1 - total_coords_after / total_coords_before) if total_coords_before else 0

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, separators=(',', ':'))  # kompakt, ingen mellemrum — samme sparegevinst som minifikation

    size_before = Path(args.input).stat().st_size
    size_after  = Path(args.output).stat().st_size

    print(f"\nKoordinater: {total_coords_before} → {total_coords_after} ({reduction_pct:.1f}% reduktion)")
    print(f"Filstørrelse: {size_before/1_000_000:.2f} MB → {size_after/1_000_000:.2f} MB")
    if skipped:
        print(f"⚠ {skipped} linje(r) kunne ikke forenkles og beholdt deres originale geometri.")
    print(f"Skrevet: {args.output} ({time.time()-t0:.1f}s)")
    print(f"\nOriginalen ({args.input}) er URØRT — bruges fortsat af map-vandlob-to-id15.py m.fl.")


if __name__ == '__main__':
    main()
