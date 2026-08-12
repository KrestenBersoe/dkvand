#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# resolve-canal-ambiguity.py
# ═══════════════════════════════════════════════════════════════════════════
#
# Fuld erstatning for den tidligere tekstmatch-/manuel-undtagelses-tilgang
# i match-lakes-via-id15.js, efter eksplicit tilbagemelding om at problemet
# er RETNINGSMÆSSIGT, ikke tekstligt: to søer forbundet af en kort kanal
# (fx Farum Sø/Furesø) kan have udløb i selve kanalen, der geografisk
# falder inden for DEN ENE søs kilometerstore ID15-opland, selvom den
# fysiske strømretning reelt går til den ANDEN, nedstrøms sø.
#
# METODE: for hvert udløb, match-lakes-via-id15.js markerede med
# viaOwnCatchment=true (dvs. udløbet blev KUN fundet fordi det geografisk
# falder i søens EGET startopland, ikke via en bekræftet opstrøms-kæde) —
# find alle nabo-oplande til søens eget opland, der:
#   1. tilhører en ANDEN, navngivet sø, OG
#   2. har lavere minimumshøjde (er nedstrøms for den nuværende sø)
# Beregn den FAKTISKE punkt-til-polygon-afstand (ikke centrum-afstand) fra
# udløbet til henholdsvis den nuværende sø og hver kvalificerende nabosø.
# Er udløbet tættere på nabosøen, ekskluderes det fra den nuværende sø —
# det hører reelt til nabosøens egen risikovurdering.
#
# Dette erstatter FULDT UD den tidligere waterArea-tekstmatch og
# MANUAL_EXCLUSIONS-listen: løsningen virker uafhængigt af om PULS' eget
# waterArea-felt nævner den rigtige sø ved navn (som det bekræftede
# VD-U57-tilfælde viste, gør det ofte IKKE — feltet navngiver ofte kun et
# mindre, mellemliggende vandløb som "Fiskebæk Å").
#
# Forudsætninger:
#   node match-lakes-via-id15.js   (skal være kørt FØRST, denne omgang)
#   id15-polygons.json, id15-flow-graph.json, soe-to-id15.json, puls-data.json
#
# Brug:
#   python3 resolve-canal-ambiguity.py
#
# Overskriver id15-lake-matches.json med den geometrisk korrigerede udgave
# (en sikkerhedskopi af inputtet gemmes som id15-lake-matches.pre-geo.json).
# ═══════════════════════════════════════════════════════════════════════════

import json
import sys
import time
from pathlib import Path

try:
    from shapely import wkt as wkt_module
    from shapely.geometry import Point, shape
    from shapely.ops import transform as shapely_transform
    import pyproj
except ImportError:
    print("Mangler afhængigheder. Kør: pip install shapely pyproj --break-system-packages", file=sys.stderr)
    sys.exit(1)

DIR = Path(__file__).parent
MIN_ELEVATION_MARGIN_M = 1.0  # samme, allerede kalibrerede margen som match-lakes-via-id15.js

# NYT: minimal, målrettet undtagelsesliste — KUN for bekræftede tilfælde,
# hvor selve den geometriske afstandsmetode beviseligt fejler. Konkret:
# et udløb der sidder lige ved en søs UDLØB (ikke indløb) kan sagtens
# ligge fysisk tættere på den sø, det FORLADER, end den sø, det ENDER I
# via den forbindende kanal — afstand alene kan ikke skelne "nærmest" fra
# "recipient efter faktisk strømretning" i den specifikke situation.
# Bekræftet direkte for Farum Sø/Furesø (VD-U57: 104m til Farum Sø vs.
# 264m til Furesø — Farum Sø "vinder" på ren afstand, men er beviseligt
# forkert, da strømretningen i kanalen går fra Farum Sø til Furesø).
# { søNavn: [PULS-ID, ...] } — udløb der IKKE skal indgå i søNavn's egen
# opstrøms-mængde, uanset hvad afstandsberegningen ovenfor konkluderer.
MANUAL_GEOMETRY_OVERRIDES = {
    'Farum Sø': [4845, 3895],  # VD-U57, VD-U49 — bekræftet recipient er Furesø
}

# NYT (bruger-rapporteret 2026-08-10 — Saltbæk Vig viste 70.332 m³ stof-
# belastning i lake-substance-load.json, udelukkende via viaUpstream=true):
# helt ANDEN fejlklasse end MANUAL_GEOMETRY_OVERRIDES ovenfor — der er intet
# nedstrøms nabosø-alternativ at flytte udløbene TIL, fordi de slet ikke
# reelt udleder til NOGEN sø. Saltbæk Vig blev diget af fra havet i 1873
# (Sejerø Bugt) og afvandes i dag via afvandingskanaler/pumpestation UDENOM
# selve vigen, direkte til havet — en rent menneskeskabt hydrologi, som
# terrænmodellen (DEM, ren højdedata) strukturelt ikke kan se: den følger
# blot terrænets naturlige hældning, uafhængig af dige/kanal/pumpe.
# Bekræftet: badevand-risk.js's egen, uafhængige strømretnings-baserede
# ind-/afløbsdetektion (vandlob-directions.json) finder INTET bekræftet
# segment (hverken ind- eller afløb) inden for søens egen polygon-tolerance
# for nogen af disse 9 udløb — id15's rene højdebaserede opstrøms-sporing er
# derfor den ENESTE kilde til alle 70.332 m³, uden nogen uafhængig
# bekræftelse. Ekskluderes derfor HELT (ikke omfordelt til en nabosø, som
# MANUAL_GEOMETRY_OVERRIDES gør) — se samme udelukkelses-mekanisme
# nedenfor (manual_overrides), som allerede virker uafhængigt af
# viaOwnCatchment (alle 9 er viaUpstream, ingen viaOwnCatchment).
# UDVIDET (bruger-bekræftet 2026-08-10): Mulen og Krageø Sø er to små damme
# (0,02 og 0,11 km²) der geografisk ligger lige ved Saltbæk Vigs nordkant —
# begge FULDT indeholdt i vigens egen "stoppedAtLakes" (ID15's opstrøms-
# sporing fra Saltbæk Vig passerede begges opland undervejs). Brugeren
# bekræftede eksplicit at begge ligger i det SAMME digede reservat og
# afvandes via samme kanal-/pumpestation-system som selve vigen — samme
# rodårsag, ikke to uafhængige fejl. Deres id15-opland er langt større
# (108 udløb hver, identisk sæt for begge — allerede flagget i
# possiblyConnectedGroups i lake-substance-load.json som mulige
# kanalforbundne søer, af en ANDEN grund end den her).
MANUAL_ENGINEERED_BYPASS_EXCLUSIONS = {
    'Saltbæk Vig': [1732, 6227, 16200, 18132, 18187, 4886, 10552, 11125, 15015],
    'Mulen': [59, 131, 604, 613, 637, 737, 799, 887, 939, 1109, 1406, 1581, 1686, 1732, 1806, 1967, 2064, 2122, 2147, 2396, 2706, 2717, 2752, 2755, 3025, 3286, 3484, 3805, 4227, 4287, 4288, 4321, 4392, 4421, 4481, 4805, 4838, 4886, 5529, 5555, 5632, 5666, 5774, 5842, 6227, 6914, 7157, 8416, 8566, 8981, 9708, 9807, 9825, 9991, 10178, 10261, 10423, 10510, 10543, 10552, 10573, 10664, 10712, 11125, 11187, 11346, 11612, 11813, 12218, 12403, 12475, 12812, 12921, 12926, 12950, 13640, 13693, 13837, 14207, 14242, 15015, 15080, 15810, 16121, 16166, 16172, 16200, 16231, 16642, 16678, 16764, 17406, 17562, 17701, 17809, 18048, 18132, 18174, 18187, 18984, 19161, 19523, 19944, 20165, 20553, 20952, 21489, 21538],
    'Krageø Sø': [59, 131, 604, 613, 637, 737, 799, 887, 939, 1109, 1406, 1581, 1686, 1732, 1806, 1967, 2064, 2122, 2147, 2396, 2706, 2717, 2752, 2755, 3025, 3286, 3484, 3805, 4227, 4287, 4288, 4321, 4392, 4421, 4481, 4805, 4838, 4886, 5529, 5555, 5632, 5666, 5774, 5842, 6227, 6914, 7157, 8416, 8566, 8981, 9708, 9807, 9825, 9991, 10178, 10261, 10423, 10510, 10543, 10552, 10573, 10664, 10712, 11125, 11187, 11346, 11612, 11813, 12218, 12403, 12475, 12812, 12921, 12926, 12950, 13640, 13693, 13837, 14207, 14242, 15015, 15080, 15810, 16121, 16166, 16172, 16200, 16231, 16642, 16678, 16764, 17406, 17562, 17701, 17809, 18048, 18132, 18174, 18187, 18984, 19161, 19523, 19944, 20165, 20553, 20952, 21489, 21538],
}

paths = {
    'polygons': DIR / 'id15-polygons.json',
    'flowGraph': DIR / 'id15-flow-graph.json',
    'soeToId15': DIR / 'soe-to-id15.json',
    'matches': DIR / 'id15-lake-matches.json',
    'pulsData': DIR / '..' / '..' / 'puls-data.json',
    # NYT: søernes FAKTISKE fysiske form — se begrundelse i filhovedet
    # (selv-fanget fejl i første udgave: sammenligning mod det kilometer-
    # store ID15-opland gav altid afstand 0, da et allerede matchet punkt
    # per definition ligger INDEN I det opland — sammenligningen kunne
    # derfor aldrig give noget andet resultat end "bliv hvor du er").
    'soeerGeojson': DIR / '..' / '..' / 'vp3_soeer.geojson',
    'backup': DIR / 'id15-lake-matches.pre-geo.json',
}


def main():
    t0 = time.time()
    print("Indlæser data...")
    for name, p in paths.items():
        if name in ('backup',):
            continue
        if not p.exists():
            print(f"❌ Mangler {p} — kør forbehandlingstrinnene først (se filhoved).", file=sys.stderr)
            sys.exit(1)

    with open(paths['polygons']) as f:
        polygons = json.load(f)
    with open(paths['flowGraph']) as f:
        flow_graph = json.load(f)
    with open(paths['soeToId15']) as f:
        soe_to_id15 = json.load(f)
    with open(paths['matches']) as f:
        matches = json.load(f)
    with open(paths['pulsData']) as f:
        puls_data = json.load(f)
    with open(paths['soeerGeojson']) as f:
        soeer_geojson = json.load(f)

    # NYT: søernes faktiske form, i EPSG:4326 (samme som selve GeoJSON'en
    # — VP3-kildedata er altid lat/lng, ikke UTM) — konverteres til
    # EPSG:25832 nedenfor, samme projektion som ID15-polygonerne og PULS-
    # punkternes koordinater (se transformer nedenfor), så afstands-
    # beregning giver mening i meter, ikke grader. Samme transformer
    # genbruges for begge — ingen grund til to identiske objekter.
    transformer = pyproj.Transformer.from_crs('EPSG:4326', 'EPSG:25832', always_xy=True)

    def reproject_geom(geom4326):
        return shapely_transform(lambda x, y: transformer.transform(x, y), geom4326)

    lake_geom_by_name = {}
    for feat in soeer_geojson.get('features', []):
        navn = feat.get('properties', {}).get('ov_navn')
        if not navn or not feat.get('geometry'):
            continue
        try:
            g = shape(feat['geometry'])
            lake_geom_by_name[navn] = reproject_geom(g)
        except Exception:
            continue
    print(f"  {len(lake_geom_by_name)} søers faktiske geometri indlæst (vp3_soeer.geojson).")

    print(f"  {len(polygons)} ID15-polygoner, {len(soe_to_id15)} søer, {len(matches)} sø-match-poster, "
          f"{len(puls_data.get('d', puls_data))} PULS-punkter.")

    # Sikkerhedskopi af inputtet, før det overskrives.
    with open(paths['backup'], 'w') as f:
        json.dump(matches, f)
    print(f"  Sikkerhedskopi skrevet: {paths['backup'].name}")

    # ── Opbygning af opslagsstrukturer ───────────────────────────────────────
    geoms_by_id15 = {}
    neighbors_by_id15 = {}
    for p in polygons:
        geoms_by_id15[p['id15']] = wkt_module.loads(p['wkt'])
        neighbors_by_id15[p['id15']] = [polygons[i]['id15'] for i in p['neighbors']]

    id15_to_lakes = {}
    for navn, id15 in soe_to_id15.items():
        id15_to_lakes.setdefault(id15, []).append(navn)

    # PULS-punktets koordinater, transformeret til samme projektion.
    rows = puls_data.get('d', puls_data)
    puls_points_proj = {}
    for i, r in enumerate(rows):
        lat, lng = r[0], r[1]
        x, y = transformer.transform(lng, lat)
        puls_points_proj[i] = Point(x, y)

    # ── Løs hver sø's usikre ("viaOwnCatchment") udløb ───────────────────────
    total_checked = 0
    total_reassigned = 0
    reassignment_log = []

    for soe_navn, rec in matches.items():
        own_id15 = rec['id15']
        # RETTET: brugte tidligere geoms_by_id15 (det kilometerstore
        # ID15-opland) her — men et allerede matchet punkt ligger PER
        # DEFINITION inden i det opland, så afstanden var altid ~0,
        # uanset punktets faktiske position. Bruger nu søens EGEN,
        # fysiske form (lake_geom_by_name) — en meningsfuld, ikke-triviel
        # afstand.
        own_geom = lake_geom_by_name.get(soe_navn)
        if own_geom is None:
            continue  # ingen fysisk geometri for denne sø i vp3_soeer.geojson — kan ikke sammenligne
        own_elev = flow_graph.get(str(own_id15), {}).get('minElev')

        # Kvalificerende nabo-søer: andet navn end denne, nabo-opland til
        # denne søs EGET ID15-opland (bruges stadig til selve
        # NABOSKABET — det er en rimelig, kilometerstor grovsigtning af
        # "er de overhovedet i nærheden af hinanden" — men den ENDELIGE
        # afstandsmåling bruger nu deres faktiske form, ikke oplandet),
        # og reelt lavere (nedstrøms).
        candidate_lakes = []
        if own_elev is not None:
            for neighbor_id15 in neighbors_by_id15.get(own_id15, []):
                neighbor_lakes = id15_to_lakes.get(neighbor_id15)
                if not neighbor_lakes:
                    continue
                neighbor_elev = flow_graph.get(str(neighbor_id15), {}).get('minElev')
                if neighbor_elev is None:
                    continue
                if own_elev - neighbor_elev >= MIN_ELEVATION_MARGIN_M:
                    for n in neighbor_lakes:
                        if n != soe_navn and n in lake_geom_by_name:
                            candidate_lakes.append((n, lake_geom_by_name[n]))

        manual_overrides = set(MANUAL_GEOMETRY_OVERRIDES.get(soe_navn, [])) | set(MANUAL_ENGINEERED_BYPASS_EXCLUSIONS.get(soe_navn, []))

        if not candidate_lakes and not manual_overrides:
            continue  # hverken nedstrøms nabosø at sammenligne med, eller en manuel undtagelse — intet at gøre

        kept = []
        for pt in rec['pulsPoints']:
            # NYT: manuel undtagelse tjekkes FØRST, FØR selve
            # viaOwnCatchment-tjekket — en bekræftet, kendt fejl skal
            # ekskluderes UANSET hvordan punktet oprindeligt blev matchet
            # (søens eget opland direkte, eller via en reel opstrøms-kæde).
            # Det var netop denne rækkefølge, der tidligere fik VD-U49 til
            # at overleve i Farum Søs liste, selvom VD-U57 (samme
            # bekræftede tilfælde) korrekt blev fjernet — VD-U49 var for
            # Farum Sø specifikt matchet via en reel opstrøms-kæde
            # (viaOwnCatchment=false), og undtagelses-tjekket lå dengang
            # KUN inde i den gren, der aldrig kørte for den slags punkter.
            if pt['id'] in manual_overrides:
                total_reassigned += 1
                source_list = 'MANUAL_GEOMETRY_OVERRIDES' if pt['id'] in MANUAL_GEOMETRY_OVERRIDES.get(soe_navn, []) else 'MANUAL_ENGINEERED_BYPASS_EXCLUSIONS'
                reassignment_log.append(f"  {soe_navn}: PULS-ID {pt['id']} ekskluderet manuelt (bekræftet — se {source_list})")
                continue

            if not pt.get('viaOwnCatchment'):
                kept.append(pt)
                continue
            total_checked += 1

            puls_geom = puls_points_proj.get(pt['id'])
            if puls_geom is None:
                kept.append(pt)
                continue

            dist_own = puls_geom.distance(own_geom)
            closest_other, closest_dist = None, None
            for other_navn, other_geom in candidate_lakes:
                if other_geom is None:
                    continue
                d = puls_geom.distance(other_geom)
                if closest_dist is None or d < closest_dist:
                    closest_dist, closest_other = d, other_navn

            if closest_other is not None and closest_dist < dist_own:
                total_reassigned += 1
                reassignment_log.append(f"  {soe_navn} → {closest_other}: PULS-ID {pt['id']} "
                                         f"(afstand {dist_own:.0f}m til {soe_navn} vs. {closest_dist:.0f}m til {closest_other})")
            else:
                kept.append(pt)

        rec['pulsPoints'] = kept

    for line in reassignment_log:
        print(line)

    with open(paths['matches'], 'w') as f:
        json.dump(matches, f, indent=2)

    print(f"\nUdløb tjekket (viaOwnCatchment=true): {total_checked}")
    print(f"Udløb geometrisk ekskluderet (tættere på en nedstrøms nabosø): {total_reassigned}")
    print(f"Opdateret {paths['matches'].name} skrevet ({time.time()-t0:.1f}s).")


if __name__ == '__main__':
    main()
