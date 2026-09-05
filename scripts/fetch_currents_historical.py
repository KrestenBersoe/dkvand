#!/usr/bin/env python3
"""
Henter HISTORISK strømretning (uo, vo) for ÉT punkt fra CMEMS' multi-year
reanalyse-produkter — udelukkende til scripts/validate-predictions-
historical.js's opstrøms/nedstrøms-afgørelse. IKKE en live/produktions-
kode-sti (se fetch_currents.py for den, som bruger et analysis-forecast-
produkt uden nogen brugbar historik længere end nogle dage tilbage).

VIGTIGT — UBEKRÆFTEDE dataset_id'er: DATASET_ID_BALTIC/DATASET_ID_NWS
nedenfor er fundet via websøgning i CMEMS' produktdokumentation, IKKE
bekræftet direkte mod et autentificeret login (ingen CMEMS-credentials
tilgængelige i det miljø, dette blev skrevet i — kun tilgængelige som
Fly-secrets). VERIFICÉR før første rigtige kørsel:
  copernicusmarine describe --contains BALTICSEA_MULTIYEAR_PHY_003_011
  copernicusmarine describe --contains NWSHELF_MULTIYEAR_PHY_004_009
og ret konstanterne, hvis de faktiske dataset_id'er afviger.

Design, bevidst MEGET simplere end fetch_currents.py's levende udgave:
denne fil beder om ÉT geografisk PUNKT (min==max lat/lng) over et helt
datointerval, ikke et fladt gitter der siden skal reprojiceres/flettes
mellem Østersø-/NWSHELF-produkterne (det, den levende version gør, findes
KUN fordi UI'ens strøm-ANIMATION kræver et sammenhængende vektorfelt).
Her er der udelukkende brug for "hvilken vej strømmer det ved denne
badevands-celle, på denne historiske dato" — samme "ét kald pr. distinkt
vejrgitter-celle, hele datointervallet i ét hug" mønster
validate-predictions-historical.js allerede bruger til nedbør (se dens
fetchArchive()).

CMEMS' historiske dækning slutter typisk 1-1,5 år før i dag (se de to
produkters egen dokumentation) — end_datetime sættes til NU og lader
CMEMS/copernicusmarine selv afgøre hvor langt den faktisk når; hvor langt
tilbage der REELT er data, er derfor kun kendt EFTER kaldet, ikke en
konstant her. Kaldestedet (validate-predictions-historical.js) indsnævrer
selv sit sammenligningsvindue til den datorække, der faktisk kom tilbage.

Input: ÉT JSON-objekt på stdin — {"lat":.., "lng":.., "start": "YYYY-MM-DD"}
Output (stdout):
  Success:      {"dates": ["YYYY-MM-DD", ...], "uo": [...], "vo": [...], "source": "baltic"|"nws"}
  Ingen dækning (uden for begge produkters maske, fx midt inde i landet
  eller en fjord ingen af de to grove reanalyse-gitre rammer): samme form,
  men alle tre lister tomme.
  Fejl:          {"error": "..."}  (exit code 1)

Miljøvariabler (samme som fetch_currents.py):
  CMEMS_USERNAME
  CMEMS_PASSWORD
"""
import sys
import os
import json
import math
import tempfile
import glob
import shutil
import datetime as _dt


def fail(msg):
    print(json.dumps({"error": msg}))
    sys.exit(1)


def describe_exception(e):
    msg = str(e).strip()
    return f"{type(e).__name__}: {msg}" if msg else type(e).__name__


try:
    import copernicusmarine
except ImportError as e:
    fail(f"copernicusmarine package not installed: {e}")

USERNAME = (os.environ.get("CMEMS_USERNAME") or "").strip()
PASSWORD = (os.environ.get("CMEMS_PASSWORD") or "").strip()
if not USERNAME or not PASSWORD:
    fail("CMEMS_USERNAME/CMEMS_PASSWORD not set")

# UBEKRÆFTET — se filhovedets advarsel.
DATASET_ID_BALTIC = "cmems_mod_bal_phy_my_P1D-m"
DATASET_ID_NWS = "cmems_mod_nws_phy-uv_my_7km-3D_P1D-m"

try:
    req = json.load(sys.stdin)
    lat = float(req["lat"])
    lng = float(req["lng"])
    start_date = req["start"]  # "YYYY-MM-DD" — se filhovedet for hvorfor der ikke er en fast fallback
except Exception as e:
    fail(f"invalid stdin JSON (forventede {{lat, lng, start}}): {describe_exception(e)}")

start_dt = _dt.datetime.fromisoformat(f"{start_date}T00:00:00+00:00")
end_dt = _dt.datetime.now(_dt.timezone.utc)


def try_subset(dataset_id, tag):
    tmp_dir = tempfile.mkdtemp(prefix=f"cmems_hist_{tag}_")
    try:
        copernicusmarine.subset(
            dataset_id=dataset_id,
            username=USERNAME,
            password=PASSWORD,
            variables=["uo", "vo"],
            minimum_longitude=lng, maximum_longitude=lng,
            minimum_latitude=lat, maximum_latitude=lat,
            minimum_depth=0, maximum_depth=1,  # overfladelag, samme konvention som fetch_currents.py
            start_datetime=start_dt, end_datetime=end_dt,
            output_directory=tmp_dir, output_filename=f"{tag}.nc",
            file_format="netcdf", disable_progress_bar=True, overwrite=True,
        )
        nc_files = glob.glob(os.path.join(tmp_dir, "**", "*.nc"), recursive=True)
        if not nc_files:
            return None

        import xarray as xr

        ds = xr.load_dataset(nc_files[0], engine="h5netcdf")
        if "depth" in ds.dims:
            ds = ds.isel(depth=0)
        elif "elevation" in ds.dims:
            ds = ds.isel(elevation=0)
        if "time" not in ds.dims:
            return None

        lat_name = "latitude" if "latitude" in ds.coords else "lat"
        lon_name = "longitude" if "longitude" in ds.coords else "lon"
        # Nærmeste native gitterpunkt til det ønskede punkt — samme
        # nearest-match-princip som fetch_currents.py's .interp() bruger for
        # sit eget (fladere) reprojektions-behov, her forenklet til ét punkt.
        point = ds.sel({lat_name: lat, lon_name: lng}, method="nearest")

        times = [str(t)[:10] for t in point["time"].values]
        uo_vals = point["uo"].values
        vo_vals = point["vo"].values

        dates, uo_out, vo_out = [], [], []
        for i, d in enumerate(times):
            u, v = float(uo_vals[i]), float(vo_vals[i])
            if math.isnan(u) or math.isnan(v):
                continue
            if abs(u) > 10 or abs(v) > 10:  # fill-value sentinel, samme grænse som fetch_currents.py
                continue
            dates.append(d)
            uo_out.append(round(u, 4))
            vo_out.append(round(v, 4))
        return {"dates": dates, "uo": uo_out, "vo": vo_out, "source": tag} if dates else None
    except Exception as e:
        print(f"[warn] {tag} subset fejlede for ({lat},{lng}): {describe_exception(e)}", file=sys.stderr)
        return None
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# Østersø-produktet dækker langt hovedparten af danske badesteder — kun
# hvis DET intet finder (punktet ligger uden for dets maske, typisk
# vestkysten, se fetch_currents.py's WEST_LON_MIN-begrundelse) forsøges
# NWSHELF-produktet som fallback. Samme "prøv det bedste, fald tilbage"-
# princip som dmi-rain.js bruger for regnmålere, blot pr.-kilde i stedet
# for pr.-station.
result = try_subset(DATASET_ID_BALTIC, "baltic")
if result is None:
    result = try_subset(DATASET_ID_NWS, "nws")
if result is None:
    result = {"dates": [], "uo": [], "vo": [], "source": None}

print(json.dumps(result))
