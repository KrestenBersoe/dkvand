#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# build-id15-geometry.py
# ═══════════════════════════════════════════════════════════════════════════
#
# ÉN-GANGS (sjældent genkørt) forbehandling af DCE's ID15-delvandoplande.
# Producerer den geometri, adjacency-graf og sø-kobling, resten af ID15-
# rørledningen (build-id15-flow-graph.js, compute-travel-times.js,
# match-lakes-via-id15.js) bygger videre på.
#
# HVORNÅR SKAL DETTE GENKØRES? Kun hvis:
#   - DCE udgiver en ny version af ID15-shapefilen (sjældent, uregelmæssigt)
#   - VP3-søerne ændrer sig ved en planrevision (vp3_soeer_raw.geojson)
# IKKE ved almindelige PULS-dataopdateringer — se map-puls-to-id15.py for
# det trin, der faktisk skal genkøres jævnligt.
#
# Forudsætninger:
#   pip install pyshp shapely pyproj --break-system-packages
#   ID15-shapefilen (ID15_VP3_II_2025.shp/.dbf/.prj/.shx) hentet manuelt fra
#     https://landbrugsgeodata.fvm.dk/ (Vandmiljøplaner → ID15_VP3_II_2025.zip)
#     — IKKE automatiseret, da det ikke er en del af Miljøportalens WFS.
#   vp3_soeer_raw.geojson (fra fetch-vp3-all.js, RÅ udgave — ikke den
#     simplificerede vp3_soeer.geojson appen bruger til visning)
#
# Brug:
#   python3 build-id15-geometry.py --shapefile ID15_VP3_II_2025 --soeer vp3_soeer_raw.geojson --out .
#
# Output (i --out mappen):
#   id15-polygons.json    — dissolvet geometri + adjacency-graf (3.355 enheder)
#   id15-area-centroid.json — areal + centroid pr. opland (bruges af Manning-beregningen)
#   soe-to-id15.json      — søens ov_navn -> dens ID15
#   soe-name-to-mstid.json — NYT: søens ov_navn -> [mst_id, ...]. ov_navn er
#     IKKE en unik nøgle i kildedatasættet (10 sonavne som "Mossø"/"Sømose"
#     findes 2-3 gange, forskellige søer). mst_id er kildens eget entydige
#     id (samme tal som i "DKLAKE<mst_id>"). Et navn med >1 mst_id i denne
#     fil er tvetydigt — se match-lakes-via-id15.js's mstIdAmbiguous-felt.
# ═══════════════════════════════════════════════════════════════════════════

import argparse
import json
import sys
import time
from collections import defaultdict

try:
    import shapefile
    from shapely.geometry import shape, Point
    from shapely.ops import unary_union
    from shapely.strtree import STRtree
except ImportError:
    print("Mangler afhængigheder. Kør: pip install pyshp shapely pyproj --break-system-packages", file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--shapefile', required=True, help='Sti til ID15-shapefilen UDEN filendelse (fx ID15_VP3_II_2025)')
    ap.add_argument('--soeer', required=True, help='Sti til vp3_soeer_raw.geojson')
    ap.add_argument('--out', default='.', help='Output-mappe (default: nuværende mappe)')
    args = ap.parse_args()

    t0 = time.time()
    print(f"Indlæser shapefile {args.shapefile}...")
    sf = shapefile.Reader(args.shapefile)
    by_id15 = defaultdict(list)
    kystvand_by_id15 = {}
    for shaperec in sf.iterShapeRecords():
        geom = shape(shaperec.shape.__geo_interface__)
        if not geom.is_valid:
            geom = geom.buffer(0)
        rec = shaperec.record.as_dict()
        by_id15[rec['ID15']].append(geom)
        kystvand_by_id15[rec['ID15']] = rec.get('KystvandID')

    total_raw = sum(len(v) for v in by_id15.values())
    print(f"  {total_raw} rå records, {len(by_id15)} unikke ID15-værdier ({time.time()-t0:.1f}s)")

    # ── Dissolve fragmenter med samme ID15 ──────────────────────────────────
    # VIGTIGT: kildedatasættet splitter nogle oplande i op til 46 separate
    # polygon-fragmenter under samme ID15 (fundet ved fejlsøgning af en
    # tidligere kørsel, hvor højdeberegningen fik forskellige resultater for
    # "samme" opland afhængig af hvilket fragment der blev behandlet sidst).
    # Uden dissolve behandles disse fejlagtigt som separate, urelaterede
    # oplande i adjacency-grafen.
    dissolved = {}
    for id15, geoms in by_id15.items():
        dissolved[id15] = geoms[0] if len(geoms) == 1 else unary_union(geoms)
    print(f"  Dissolved til {len(dissolved)} enheder ({time.time()-t0:.1f}s)")

    id15_keys = list(dissolved.keys())
    geoms_list = [dissolved[k] for k in id15_keys]
    tree = STRtree(geoms_list)

    # ── Adjacency ────────────────────────────────────────────────────────────
    BUFFER_TOL = 1.0  # meter — fanger næsten-sammenfaldende, men ikke pixel-perfekt snappede grænser
    adjacency = [[] for _ in geoms_list]
    t1 = time.time()
    for i, geom in enumerate(geoms_list):
        buffered = geom.buffer(BUFFER_TOL)
        for j in tree.query(buffered):
            j = int(j)
            if j == i:
                continue
            if geoms_list[j].intersects(buffered):
                adjacency[i].append(j)
        if i % 500 == 0:
            print(f"    adjacency {i}/{len(geoms_list)} ({time.time()-t1:.1f}s)")
    print(f"  Adjacency bygget ({time.time()-t1:.1f}s)")

    # ── Eksportér polygoner (WKT, let simplificeret til mindre GraphQL-kald) ─
    polygons = []
    area_centroid = {}
    for i, id15 in enumerate(id15_keys):
        geom = dissolved[id15]
        simplified = geom.simplify(0.5, preserve_topology=True)
        c = geom.centroid
        polygons.append({
            'index': i,
            'id15': id15,
            'kystvandId': kystvand_by_id15.get(id15),
            'neighbors': adjacency[i],
            'wkt': simplified.wkt,
        })
        area_centroid[id15] = {'areaM2': geom.area, 'centroidX': c.x, 'centroidY': c.y}

    with open(f'{args.out}/id15-polygons.json', 'w') as f:
        json.dump(polygons, f)
    with open(f'{args.out}/id15-area-centroid.json', 'w') as f:
        json.dump(area_centroid, f)
    print(f"  Skrevet id15-polygons.json og id15-area-centroid.json")

    # ── Søer -> ID15 ─────────────────────────────────────────────────────────
    import pyproj
    transformer = pyproj.Transformer.from_crs('EPSG:4326', 'EPSG:25832', always_xy=True)

    print(f"\nIndlæser søer fra {args.soeer}...")
    with open(args.soeer) as f:
        soeer = json.load(f)

    def find_containing_id15(x, y):
        pt = Point(x, y)
        for idx in tree.query(pt):
            idx = int(idx)
            if geoms_list[idx].intersects(pt):
                return id15_keys[idx]
        return None

    soe_to_id15 = {}
    soe_name_to_mstid = {}
    unmatched = []
    dupe_names = set()
    seen_names = set()
    for feat in soeer['features']:
        navn = feat['properties'].get('ov_navn')
        if not navn:
            continue
        # NYT: ov_navn er IKKE en unik nøgle — 10 sonavne (Sømose, Mossø,
        # Sortesø, m.fl.) findes 2-3 gange i kildedatasættet, forskellige
        # søer forskellige steder i landet. mst_id (kildens eget entydige
        # id, samme tal som i "DKLAKE<mst_id>"-URL'en) er derimod garanteret
        # unikt — gemmes her SEPARAT, additivt, uden at ændre eksisterende
        # forbrugere af soe-to-id15.json (som stadig kun kender navnet).
        # Ved navnekollision beholdes første fund i soe_to_id15 (uændret
        # opsætrisiko for eksisterende adfærd), men mst_id gemmes for BEGGE
        # — downstream-forbrugere kan bruge soe_name_to_mstid til at opdage
        # tvetydigheden, selvom soe_to_id15 kun har ét tal per navn.
        if navn in seen_names:
            dupe_names.add(navn)
        seen_names.add(navn)
        mst_id = feat['properties'].get('mst_id')
        centroid = shape(feat['geometry']).centroid
        x, y = transformer.transform(centroid.x, centroid.y)
        id15 = find_containing_id15(x, y)
        if id15 is None:
            unmatched.append(navn)
        else:
            # UÆNDRET fra før: sidste fund vinder ved navnekollision (samme
            # adfærd som oprindeligt — jeg ændrer IKKE hvilken id15 der
            # ender med at blive brugt for de 10 tvetydige navne, kun
            # tilføjer sporingen af at kollisionen findes).
            soe_to_id15[navn] = id15
            if mst_id is not None:
                soe_name_to_mstid.setdefault(navn, []).append(mst_id)

    print(f"  Søer matchet til ID15: {len(soe_to_id15)}/{len(soeer['features'])} ({len(unmatched)} umatchede)")
    if dupe_names:
        print(f"  ⚠ {len(dupe_names)} sonavne optræder MERE END EN GANG i kilden (tvetydigt ved navne-opslag alene): {sorted(dupe_names)}")
    with open(f'{args.out}/soe-to-id15.json', 'w') as f:
        json.dump(soe_to_id15, f, ensure_ascii=False, indent=2)
    print(f"  Skrevet soe-to-id15.json")

    # NYT: navn -> [mst_id, ...]. Liste (ikke enkelt tal), da et tvetydigt
    # navn som "Mossø" har FLERE mst_id'er — downstream-forbrugere kan se
    # på list-længden for at opdage tvetydighed uden selv at genberegne den.
    with open(f'{args.out}/soe-name-to-mstid.json', 'w') as f:
        json.dump(soe_name_to_mstid, f, ensure_ascii=False, indent=2)
    print(f"  Skrevet soe-name-to-mstid.json ({sum(1 for v in soe_name_to_mstid.values() if len(v)>1)} navne med >1 mst_id)")

    print(f"\nFærdig på {time.time()-t0:.1f}s.")
    print("Husk: kør map-puls-to-id15.py separat (og jævnligt, ved hver PULS-opdatering).")


if __name__ == '__main__':
    main()
