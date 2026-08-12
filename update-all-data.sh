#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# update-all-data.sh — opdaterer SAMTLIGE datakilder appen bruger (PULS, VP3,
# CMEMS/Copernicus), optimerer geometrien til de faktiske opløsninger appen
# viser den i, og lægger de færdige filer klar i projektroden til deployment.
#
# Kør fra projektets rodmappe (samme sted som dansk-overloeb-kort.html,
# server.js osv.):
#   ./update-all-data.sh
#
# Kræver: node (18+), npx (følger med npm), python3 med shapely+pyproj
# (kun til RBU/ID15-trinnene), internetadgang til arealdata.miljoeportal.dk,
# pulsgeo.miljoeportal.dk og wfs2-miljoegis.mim.dk.
#
# RETTET/UDVIDET: Trin 7 (kystvand-matching) og Trin 8 (vandløbs-retning +
# opstrøms-matching + visningsdata) var tidligere selvstændige scripts uden
# NOGEN orkestrering — id15-kystvand-matches.json, vandlob-directions.json,
# vandlob-upstream-matches.json og vandlob-display.json blev alle brugt aktivt
# af appen (se badevand-risk.js), men skulle huskes kørt manuelt, i præcis
# den rigtige rækkefølge, hver gang PULS eller VP3-vandløb blev opdateret —
# ellers driver de stille og roligt ud af sync uden nogen fejlmeddelelse.
# Begge er nu del af denne ene, samlede kørsel.
#
# NYT (Trin 10): resolve-canal-ambiguity.py manglede TIDLIGERE helt i denne
# pipeline — trin 3's rå match-lakes-via-id15.js-output blev kopieret DIREKTE
# til roden, uden kanal-korrektionen. Reproducerede bevisligt en allerede
# kendt, allerede løst fejl (Farum Sø/Furesø — se trin 7's egen kommentar for
# detaljer). Kører nu efter trin 6, da den kræver vp3_soeer.geojson.
#
# NYT (Trin 13): myndigheden har fjernet waterArea (recipient-tekst) fra PULS'
# egen WFS — update-puls.js kan derfor ikke længere hente den fra kilden.
# scripts/derive-water-area.js udleder den i stedet, EFTER al anden data er
# frisk (kræver id15-lake-matches.json + de simplificerede VP3-lag) — se det
# scripts eget filhoved for den fulde, empirisk begrundede metode.
#
# VIGTIGT OM CMEMS/COPERNICUS: strøm- og temperaturdata fra Copernicus Marine
# kan IKKE forberedes som en statisk fil på forhånd — de hentes i sagens natur
# live af den kørende server hver 6. time (fetch_currents.py), da en gammel
# "øjebliksfil" ville være forældet i samme øjeblik den blev lavet. Dette
# script udfører derfor kun en hurtig, valgfri funktionstest af selve
# hentekæden (samme kode som serveren bruger), IKKE en dataopdatering — se
# trin 11 nedenfor.
#
# VIGTIGT OM ID15-TERRÆNMODELLEN (søers opstrøms-matching): dette script
# kører KUN de trin, der afhænger af PULS-data (som ændrer sig jævnligt).
# Selve terrænmodellen (ID15-geometri, DHM-højder, rejsetider) afhænger
# UDELUKKENDE af DCE's ID15-oplande og DHM-terrænet, som næsten aldrig
# ændrer sig — den opdateres derfor SEPARAT, sjældent, via
# scripts/id15/setup-id15-terrain-model.sh. Kør IKKE det script her ved hver
# almindelig dataopdatering — det tager ~40 minutter og belaster
# Datafordelerens API unødvendigt, hvis intet i terrænmodellen reelt har
# ændret sig siden sidst.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "════════════════════════════════════════════════════════════════"
echo " dkvand — samlet dataopdatering"
echo " Arbejdsmappe: $SCRIPT_DIR"
echo " Midlertidig mappe: $TMP_DIR"
echo "════════════════════════════════════════════════════════════════"
echo

# ── Trin 1: PULS-stamdata + udledning ────────────────────────────────────────
echo "── Trin 1/17: PULS-data (udledningspunkter) ──────────────────────"
node update-puls.js --out ./puls-data.json
echo

# ── Trin 2: Historisk nedbør for PULS-udløb (grundlag for tærskelberegning) ──
# NYT: 3 kalenderårs timeopløst arkiv-nedbør pr. unikt 0,25°-gitter (164
# celler for de ~13.900 udløb der er i scope, se scripts/fetch-puls-outlet-
# history.js's eget filhoved). Afhænger af Trin 1's friske puls-data.json
# (eventsPerYear/outfallId), skal derfor køre EFTER det, ikke før.
echo "── Trin 2/17: Historisk nedbør for PULS-udløb ─────────────────────"
node scripts/fetch-puls-outlet-history.js
echo

# ── Trin 3: Udløbs-specifikke empiriske nedbørstærskler ─────────────────────
# Se PULS-TAERSKLER-RAPPORT.md for metode/validering. Kræver Trin 2's output.
echo "── Trin 3/17: Beregner udløbs-specifikke nedbørstærskler ──────────"
node scripts/compute-puls-udloeb-taerskler.js
echo

# ── Trin 4: Fletter tærskler ind i puls-data.json (row[13]) ─────────────────
# Se scripts/merge-puls-thresholds.js's eget filhoved for scope/tillidsgrad-
# filtreringen (kun high/medium/borrowed, ikke low).
echo "── Trin 4/17: Fletter nedbørstærskler ind i puls-data.json ────────"
node scripts/merge-puls-thresholds.js
echo

# ── Trin 5: VP3 — kystvande, søer, vandløb, badevand, RBU (rå data) ─────────
echo "── Trin 5/17: VP3-data fra Miljøportalens WFS (rå, ikke optimeret) ─"
node fetch-vp3-all.js --out "$TMP_DIR"
echo

# ── Trin 6: Sø-recipient-koblinger (RBU-officiel + ID15-terræn-matching) ───
# RETTET: tidligere manglede disse trin helt i dataopdateringen — begge
# afhænger af PULS-data og skal derfor genkøres hver gang PULS opdateres,
# ellers driver koblingerne stille og roligt ud af sync uden nogen fejl.
#
# RBU-koblingen bruger de RÅ VP3-filer i $TMP_DIR (før mapshaper-
# simplificeringen i trin 6) — det er ligegyldigt for et rent tekst-/ID-
# opslag, og de rå filer forsvinder alligevel når scriptet slutter.
echo "── Trin 6/17: Sø-recipient-koblinger (RBU + ID15-opstrøms) ───────"

echo "  RBU-officielle koblinger…"
node scripts/build-rbu-lake-links.js \
  --rbu-path "$TMP_DIR/vp3_rbu_raw.geojson" \
  --soeer-path "$TMP_DIR/vp3_soeer_raw.geojson" \
  --out ./rbu-lake-links.json

echo "  Genopslag PULS-udløb -> ID15-opland (PULS ændrer sig ofte, opslaget skal følge med)…"
if [ ! -f scripts/id15/id15-polygons.json ]; then
  echo "  ❌ scripts/id15/id15-polygons.json mangler."
  echo "     Kør scripts/id15/setup-id15-terrain-model.sh FØRST (én gang, sjældent)."
  exit 1
fi
python3 scripts/id15/map-puls-to-id15.py \
  --polygons scripts/id15/id15-polygons.json \
  --puls ./puls-data.json \
  --out scripts/id15/

echo "  Matcher søer mod opstrøms PULS-udløb (med rejsetids-henfald)…"
node scripts/id15/match-lakes-via-id15.js
# RETTET: kopierede tidligere DIREKTE til roden her — men matchet er på
# dette tidspunkt ikke kanal-korrigeret endnu (viaOwnCatchment-tvetydigheder,
# fx Farum Sø/Furesø, uløst). Selve korrektionen (resolve-canal-ambiguity.py)
# kræver vp3_soeer.geojson, som først findes efter trin 6 — se dét trin for
# hvor kopieringen til roden nu reelt sker.
echo

# ── Trin 7: Kystvand-matching (ID15-baseret, fuld dækning) ──────────────────
# NYT: build-id15-kystvand-matches.js (ikke den ældre match-kystvand-via-id15.js
# — dens output-nøgler ("1", "2", "6", …) matcher IKKE vp3_kystvande's eget
# ov_id-felt ("DKCOAST1", "DKCOAST101", …), som badevand-risk.js faktisk slår
# op på. build-id15-kystvand-matches.js skriver korrekt "DKCOAST<id>"-nøgler
# og har desuden 100% oplandsdækning, mod den ældre udgaves sparsomme,
# delvise dækning). Skriver direkte til id15-kystvand-matches.json i
# projektroden (finder selv roden via puls-data.json).
echo "── Trin 7/17: Kystvand-matching (ID15, fuld dækning) ─────────────"
node scripts/id15/build-id15-kystvand-matches.js
echo

# ── Trin 8: Vandløbs-retning + opstrøms-matching ────────────────────────────
# NYT: lukker samme hul som Trin 7, for vandløbslinjer i stedet for
# kystvande/søer — uden dette matcher badesteder ved et vandløb (der hverken
# er en målsat sø eller direkte kystlinje) ingen udløb overhovedet.
# Rækkefølgen er FAST (se de enkelte scripts filhoved): endepunkts-mapping →
# retning (kræver mapping) → opstrøms-match (kræver retning).
echo "── Trin 8/17: Vandløbs-retning + opstrøms-matching ───────────────"

echo "  Kortlægger vandløbs-endepunkter til ID15-opland…"
python3 scripts/id15/map-vandlob-to-id15.py \
  --polygons scripts/id15/id15-polygons.json \
  --vandlob "$TMP_DIR/vp3_vandlob_raw.geojson" \
  --out scripts/id15/

echo "  Beregner strømretning pr. vandløbslinje…"
node scripts/id15/compute-vandlob-directions.js

echo "  Matcher vandløb mod opstrøms PULS-udløb…"
node scripts/id15/match-vandlob-via-id15.js

cp scripts/id15/vandlob-directions.json ./vandlob-directions.json
cp scripts/id15/vandlob-upstream-matches.json ./vandlob-upstream-matches.json
echo

# ── Trin 9: Optimér geometri til de opløsninger appen faktisk bruger ────────
# Polygoner/linjer simplificeres med mapshaper — punktdata (badevand/RBU) har
# ingen geometrisk "opløsning" at reducere, kun overflødige properties (trin
# 8). Procentsatserne er valgt ud fra hvad der viste sig fornuftigt under
# udvikling: nok til markant mindre filstørrelse, uden at skabe for mange
# ureparerede selvskæringer (se noter i klientkoden om søer-simplificering).
echo "── Trin 9/17: Geometri-optimering (mapshaper) ────────────────────"

echo "  Kystvande (polygoner, 15% bevaret)…"
npx --yes mapshaper "$TMP_DIR/vp3_kystvande_raw.geojson" \
  -simplify 15% -clean \
  -o vp3_kystvande_simplified.geojson format=geojson

echo "  Søer (polygoner, 20% bevaret)…"
npx --yes mapshaper "$TMP_DIR/vp3_soeer_raw.geojson" \
  -simplify 20% -clean \
  -o vp3_soeer.geojson format=geojson

echo "  Vandløb (linjer, 12% bevaret)…"
npx --yes mapshaper "$TMP_DIR/vp3_vandlob_raw.geojson" \
  -simplify 12% -clean \
  -o vp3_vandlob.geojson format=geojson
echo

# ── Trin 10: Sø-kanal-korrektion + kopiering til roden ────────────────────────
# RETTET: manglede TIDLIGERE HELT i denne pipeline — trin 3's rå
# match-lakes-via-id15.js-output blev kopieret DIREKTE til roden, uden denne
# korrektion. Det reproducerer bevisligt en allerede kendt, allerede løst fejl:
# to søer forbundet af en kort kanal (Farum Sø/Furesø) kan have et udløb, der
# geografisk falder i den ENE søs ID15-opland (viaOwnCatchment=true), selvom
# strømmen i kanalen reelt går til den ANDEN, nedstrøms sø — bekræftet ved
# direkte sammenligning: PULS-ID 4845 (VD-U57) lå FORTSAT fejlagtigt under
# Farum Sø i roden af id15-lake-matches.json, selvom scripts/id15/-udgaven
# (allerede korrigeret en tidligere gang, manuelt) korrekt har den ekskluderet.
# Kræver vp3_soeer.geojson (lige ovenfor, trin 6) — kan derfor IKKE køre
# tidligere i pipelinen, selvom selve matchet (trin 3) sker før geometrien.
echo "── Trin 10/17: Sø-kanal-korrektion (viaOwnCatchment-tvetydighed) ──"
python3 scripts/id15/resolve-canal-ambiguity.py
cp scripts/id15/id15-lake-matches.json ./id15-lake-matches.json
echo

# ── Trin 11: Vandløbs-visningsdata (prækomputeret bæring + retningsfarve) ────
# NYT: kræver BÅDE trin 5 (scripts/id15/vandlob-directions.json) OG trin 6
# (den simplificerede vp3_vandlob.geojson her i projektroden) — skal derfor
# køre EFTER begge. Se build-vandlob-display.js's eget filhoved: erstatter
# fuldt ud den tidligere Douglas-Peucker-forenklede vp3_vandlob_simplified.geojson
# (simplify-vandlob-for-display.py, nu forældet/ubrugt — rør den ikke).
echo "── Trin 11/17: Vandløbs-visningsdata (bæring + retningsfarve) ──────"
node scripts/id15/build-vandlob-display.js
echo

# ── Trin 12: Slank punktdata for ubrugte properties ──────────────────────────
echo "── Trin 12/17: Fjerner ubrugte felter fra punktdata ────────────────"

node slim-geojson.js "$TMP_DIR/vp3_badevand.geojson" vp3_badevand.geojson \
  nametext,pkt_navn,navn,NAVN,Navn,name,ov_navn,bathingwat,ov_id,id,komm_navn

node slim-geojson.js "$TMP_DIR/vp3_rbu_raw.geojson" vp3_rbu_slim.geojson \
  pkt_navn,pkt_id,komm_navn,vandomr_id,udl_va_sta,i_program,bgv_type
echo

# ── Trin 13: Udled waterArea (recipient-visningstekst) ───────────────────────
# NYT: se scripts/derive-water-area.js's filhoved for den fulde begrundelse.
# Kræver id15-lake-matches.json (kanal-korrigeret i trin 7, ikke det rå
# match fra trin 3) og de simplificerede VP3-lag (trin 6) — skal derfor køre
# efter dem, hvilket den nu gør. Overskriver puls-data.json's waterArea-felt
# in-place (resten af filen er urørt).
echo "── Trin 13/17: Udleder waterArea (recipient-visningstekst) ───────"
node scripts/derive-water-area.js
echo

# ── Trin 14: Sø-stofbelastning (N/P/COD/BOD, fra PULS' egne udledningsfelter) ─
# NYT: aggregerer volumen + N/P/COD/BOD per sø via id15-lake-matches.json,
# kræver Trin 1's friske puls-data.json (stof-felterne) og Trin 10's
# kanal-korrigerede id15-lake-matches.json i roden. Rå sum, ikke
# flow-routet/henfaldsvægtet — se scriptets eget filhoved for fulde forbehold.
echo "── Trin 14/17: Sø-stofbelastning (N/P/COD/BOD per sø) ────────────"
node scripts/id15/aggregate-lake-substance-load.js
echo

# ── Trin 15: Sø-MFS-belastning (miljøfremmede stoffer, MST-typetal × volumen) ─
# NYT: estimerer sandsynlig belastning af tungmetaller/PAH/PFAS/lægemidler mv.
# per sø, ved at gange MST's nationale typetal (scripts/mst-typetal-mfs.json)
# med hvert udløbs volumen, klassificeret efter SewerStructure (fælles-/
# separatkloak). MODELLERET estimat, IKKE målt data — gælder kun
# boligdominerede oplande jf. MST's egne typetal-forbehold. Se scriptets
# eget filhoved for fulde forbehold før brug.
echo "── Trin 15/17: Sø-MFS-belastning (miljøfremmede stoffer, MST-typetal) ─"
node scripts/id15/aggregate-lake-mfs-load.js
echo

# ── Trin 16: Valgfri CMEMS/Copernicus funktionstest (IKKE en dataopdatering) ─
echo "── Trin 16/17: CMEMS/Copernicus — funktionstest (valgfri) ─────────"
if [ "${CMEMS_USERNAME:-}" != "" ] && [ "${CMEMS_PASSWORD:-}" != "" ]; then
  echo "  CMEMS_USERNAME/PASSWORD fundet i miljøet — tester hentekæden…"
  if python3 fetch_currents.py > "$TMP_DIR/cmems_test.json" 2>"$TMP_DIR/cmems_test.log"; then
    POINTS=$(python3 -c "import json; print(len(json.load(open('$TMP_DIR/cmems_test.json'))['points']))" 2>/dev/null || echo "?")
    echo "  ✅ CMEMS-hentekæde virker — $POINTS punkter hentet (bruges IKKE her, kun bekræftet funktionel)"
  else
    echo "  ⚠️  CMEMS-hentekæde fejlede — se $TMP_DIR/cmems_test.log"
    echo "     (Dette blokerer IKKE resten af scriptet — currents-cachen på"
    echo "     serveren opdateres uafhængigt af denne dataopdatering.)"
  fi
else
  echo "  Sprunget over — CMEMS_USERNAME/CMEMS_PASSWORD ikke sat i miljøet."
  echo "  (Helt normalt at springe over her — CMEMS opdateres uafhængigt af"
  echo "  denne dataopdatering, direkte på den kørende server hver 6. time.)"
fi
echo

# ── Trin 15: Opsummering ─────────────────────────────────────────────────────
echo "── Trin 17/17: Opsummering ─────────────────────────────────────────"
echo
echo "Filer klar til deployment i $SCRIPT_DIR:"
for f in puls-data.json vp3_kystvande_simplified.geojson vp3_soeer.geojson \
         vp3_vandlob.geojson vp3_badevand.geojson vp3_rbu_slim.geojson \
         rbu-lake-links.json id15-lake-matches.json id15-kystvand-matches.json \
         vandlob-directions.json vandlob-upstream-matches.json vandlob-display.json \
         lake-substance-load.json lake-mfs-load.json; do
  if [ -f "$f" ]; then
    SIZE=$(du -h "$f" | cut -f1)
    echo "  ✅ $f ($SIZE)"
  else
    echo "  ❌ $f MANGLER"
  fi
done
echo
echo "Næste skridt:"
echo "  1. Gennemse de opdaterede filer (de er ændret direkte i arbejdsmappen)"
echo "  2. Bekræft at Dockerfile'en COPY'er alle filerne ovenfor (se COPY-listen)"
echo "  3. Deploy (fx fly deploy -a dkvand) når du er klar"
echo
echo "Husk: ID15-terrænmodellen (geometri/højder/rejsetider) opdateres IKKE"
echo "af dette script — kør scripts/id15/setup-id15-terrain-model.sh separat,"
echo "og kun hvis DCE's ID15-oplande eller DHM-terrænet reelt har ændret sig."
echo
echo "════════════════════════════════════════════════════════════════"
echo " Færdig."
echo "════════════════════════════════════════════════════════════════"
