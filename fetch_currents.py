#!/usr/bin/env python3
"""
Henter strømdata (uo, vo) for danske farvande fra CMEMS via den officielle
Copernicus Marine Toolbox (`copernicusmarine`-pakken).

Erstatter den tidligere hjemmerullede OPeNDAP/THREDDS ASCII-parsing i
server.js, som var afhængig af et skrøbeligt, uofficielt tekstformat.
Toolbox'en håndterer autentificering, dataset-opslag og subsetting korrekt
og er den anbefalede adgangsvej til CMEMS-data.

Kaldes fra server.js via child_process og outputter JSON på stdout:

  Success: {"ts": "<ISO-8601>", "points": [{"lat":.., "lng":.., "uo":.., "vo":..}, ...]}
  Fejl:    {"error": "<besked>"}   (exit code 1)

Miljøvariabler (samme navne som hidtil, sat via `fly secrets set`):
  CMEMS_USERNAME
  CMEMS_PASSWORD
"""
import sys
import os
import json
import datetime
import math
import logging
import signal

# Gør toolbox'ens interne fremdrifts-logging synlig i `fly logs` (stderr),
# så vi kan se PRÆCIS hvor et langsomt kald bruger tid — fx catalog-opslag
# vs. selve data-downloadet — i stedet for at gætte ud fra et hængende kald.
logging.basicConfig(
    level=logging.INFO,
    format="[copernicusmarine] %(message)s",
    stream=sys.stderr,
)

# Hård intern timeout: hvis hele scriptet ikke er færdigt inden for dette
# antal sekunder, fejler vi kontrolleret med en klar besked i stedet for at
# hænge på ubestemt tid. Sat lavere end server.js' egen 120s execFile-timeout,
# så VI når at levere en informativ fejl, før Node bare dræber processen.
HARD_TIMEOUT_SECONDS = 150


def _on_timeout(signum, frame):
    raise TimeoutError(f"script overskred {HARD_TIMEOUT_SECONDS}s intern timeout")


signal.signal(signal.SIGALRM, _on_timeout)
signal.alarm(HARD_TIMEOUT_SECONDS)


def fail(msg):
    print(json.dumps({"error": msg}))
    sys.exit(1)


def describe_exception(e):
    """Sikrer en informativ fejlbesked selv når str(e) er tom
    (fx visse netværks-/timeout-exceptions)."""
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

# Sikker diagnostik til stderr (ikke stdout — det skal forblive ren JSON).
# Afslører aldrig selve værdierne, kun længde + første/sidste tegn, så man
# kan opdage usynlige mellemrum/linjeskift eller forkert kopierede secrets
# uden at lække credentials i logs.
print(
    f"[debug] username: len={len(USERNAME)} starts={USERNAME[:2]!r} ends={USERNAME[-2:]!r} | "
    f"password: len={len(PASSWORD)} starts={PASSWORD[:1]!r} ends={PASSWORD[-1:]!r}",
    file=sys.stderr,
)

DATASET_ID = "cmems_mod_bal_phy_anfc_PT1H-i"
# Tidligere ID "cmems_mod_bal_phy_cur_anfc_2.5km_PT1H-i" findes ikke længere —
# CMEMS har konsolideret Østersø-produktet BALTICSEA_ANALYSISFORECAST_PHY_003_006
# til ét samlet, multi-variabel datasæt med flere dybdeniveauer i stedet for
# separate per-variabel datasæt. uo/vo er nu del af dette datasæt.

# Dansk farvand (samme bbox som tidligere JS-implementering)
LAT_MIN, LAT_MAX = 54.0, 58.0
LON_MIN, LON_MAX = 8.0, 15.0

# Stride ~4 -> ca. 10 km opløsning.
STRIDE = 4

# ── subset() i stedet for open_dataset() ─────────────────────────────────────
# open_dataset() streamer datasættet lazy via xarray/dask/zarr, hvilket har en
# betydelig hukommelses-overhead uafhængigt af hvor lille et udsnit man rent
# faktisk beder om — det forårsagede gentagne OOM-kills i produktion, selv med
# forøget RAM. subset() laver i stedet selve udsnits-arbejdet på Copernicus'
# egne servere og sender kun en lille, allerede-afgrænset NetCDF-fil tilbage,
# som vi læser med almindelig (ikke-lazy) xarray. Markant lettere for en
# lille, veldefineret geografisk/tidsmæssig forespørgsel som denne.
import tempfile
import glob
import shutil
import datetime as _dt

now = _dt.datetime.now(_dt.timezone.utc)
# Analysis-forecast-datasæt har typisk data omkring "nu" — spænd et vindue
# der med sikkerhed rammer mindst ét tidspunkt, uden at hente hele historikken.
start_dt = now - _dt.timedelta(hours=12)
end_dt   = now + _dt.timedelta(hours=6)

tmp_dir = tempfile.mkdtemp(prefix="cmems_subset_")

try:
    # RETTET: hvis "thetao" ikke er en gyldig variabel for dette datasæt (set
    # for andre CMEMS-produkter, hvor temperatur er splittet ud i et separat
    # "-tem"-datasæt fra strøm), fejler subset()-kaldet typisk med det samme,
    # FØR vi når til selve dataudtrækningen — og ville derfor vælte HELE
    # strømhentningen, inkl. uo/vo. Første forsøg inkluderer thetao; hvis det
    # fejler, gentages kaldet uden thetao, så strøm aldrig går tabt på grund
    # af en manglende temperaturvariabel.
    included_temp = True
    try:
        response = copernicusmarine.subset(
            dataset_id=DATASET_ID,
            username=USERNAME,
            password=PASSWORD,
            variables=["uo", "vo", "thetao"],  # thetao = havvands potentiel temperatur (°C) — bruges til algerisiko-model
            minimum_longitude=LON_MIN,
            maximum_longitude=LON_MAX,
            minimum_latitude=LAT_MIN,
            maximum_latitude=LAT_MAX,
            minimum_depth=0,
            maximum_depth=1,  # datasættets øverste niveau ligger på ~0.5 m, ikke 0 m
            start_datetime=start_dt,
            end_datetime=end_dt,
            output_directory=tmp_dir,
            output_filename="currents.nc",
            file_format="netcdf",
            disable_progress_bar=True,
            overwrite=True,
        )
    except Exception as e:
        print(f"[warn] subset med thetao fejlede ({describe_exception(e)}) — "
              f"prøver igen uden temperatur-variabel", file=sys.stderr)
        included_temp = False
        try:
            response = copernicusmarine.subset(
                dataset_id=DATASET_ID,
                username=USERNAME,
                password=PASSWORD,
                variables=["uo", "vo"],
                minimum_longitude=LON_MIN,
                maximum_longitude=LON_MAX,
                minimum_latitude=LAT_MIN,
                maximum_latitude=LAT_MAX,
                minimum_depth=0,
                maximum_depth=1,
                start_datetime=start_dt,
                end_datetime=end_dt,
                output_directory=tmp_dir,
                output_filename="currents.nc",
                file_format="netcdf",
                disable_progress_bar=True,
                overwrite=True,
            )
        except Exception as e2:
            fail(f"subset failed (også uden thetao): {describe_exception(e2)}")

    try:
        import xarray as xr

        nc_files = glob.glob(os.path.join(tmp_dir, "**", "*.nc"), recursive=True)
        if not nc_files:
            fail("subset gav ingen NetCDF-fil")

        # Almindelig (ikke-lazy) indlæsning — filen er allerede lille (afgrænset
        # server-side), så hele indholdet kan roligt loades direkte i hukommelsen.
        # engine="h5netcdf" eksplicit, da netCDF4-pakken ikke er installeret, men
        # h5netcdf følger med som copernicusmarine-afhængighed.
        ds = xr.load_dataset(nc_files[0], engine="h5netcdf")

        # Seneste tidspunkt i det hentede udsnit
        latest = ds.isel(time=-1) if "time" in ds.dims else ds

        # Overfladelag hvis der er en dybde-dimension
        if "depth" in latest.dims:
            latest = latest.isel(depth=0)
        elif "elevation" in latest.dims:
            latest = latest.isel(elevation=0)

        # Diagnostik: log hvilke variable datasættet FAKTISK indeholder — det
        # afgør definitivt om "thetao" findes her, eller om CMEMS har splittet
        # temperatur ud i et separat datasæt (set for andre CMEMS-produkter,
        # hvor "cur"-datasæt kun indeholder uo/vo, og temperatur ligger i et
        # separat "-tem"-datasæt). Vises i fly logs, ikke i selve JSON-outputtet.
        print(f"[debug] variable i datasæt: {list(latest.data_vars)} (thetao forsøgt: {included_temp})", file=sys.stderr)

        lat_name = "latitude" if "latitude" in latest.coords else "lat"
        lon_name = "longitude" if "longitude" in latest.coords else "lon"

        latest = latest.isel({
            lat_name: slice(0, None, STRIDE),
            lon_name: slice(0, None, STRIDE),
        })

        lats = latest[lat_name].values
        lons = latest[lon_name].values
        uo_vals = latest["uo"].values
        vo_vals = latest["vo"].values

        # RETTET: "thetao"-opslaget skete tidligere UBETINGET før selve løkken
        # — hvis variablen ikke findes i datasættet, fejlede HELE hentningen
        # (inkl. uo/vo), ikke kun temperaturen. Nu er det defensivt: mangler
        # thetao, fortsætter strømdata uden temperatur i stedet for at fejle
        # totalt, og en tydelig advarsel logges til stderr.
        temp_vals = None
        if "thetao" in latest.data_vars:
            temp_vals = latest["thetao"].values
        else:
            print("[warn] 'thetao' findes ikke i dette datasæt — "
                  "strømdata fortsætter uden vandtemperatur. "
                  f"Tilgængelige variable: {list(latest.data_vars)}", file=sys.stderr)

        points = []
        for i, lat in enumerate(lats):
            for j, lon in enumerate(lons):
                u = float(uo_vals[i, j])
                v = float(vo_vals[i, j])
                if math.isnan(u) or math.isnan(v):
                    continue
                if abs(u) > 10 or abs(v) > 10:  # fill-value sentinel
                    continue
                point = {
                    "lat": round(float(lat), 4),
                    "lng": round(float(lon), 4),
                    "uo": round(u, 4),
                    "vo": round(v, 4),
                }
                # Temperatur kan mangle/være fill-value uden at strømdata gør —
                # medtag kun hvis reel, men lad ikke en manglende værdi fjerne
                # selve strømpunktet.
                if temp_vals is not None:
                    t = float(temp_vals[i, j])
                    if not math.isnan(t) and -5 < t < 40:
                        point["temp"] = round(t, 2)
                points.append(point)

        if not points:
            fail("no current points extracted from dataset")

        print(json.dumps({
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "points": points,
        }))

    except Exception as e:
        fail(f"data extraction failed: {describe_exception(e)}")

finally:
    # KRITISK: uden denne oprydning efterlader hvert kald en ny NetCDF-fil i
    # /tmp. Ved gentagne baggrunds-opdateringer (hver 6. time, samt hver
    # autostop/genstart-cyklus) fylder det langsomt containerens disk op,
    # hvilket i sidste ende kan gøre HELE appen utilgængelig — ikke kun
    # strøm-endpointet. shutil.rmtree fejler aldrig processen selvom
    # oprydningen af en eller anden grund ikke lykkes (ignore_errors=True).
    shutil.rmtree(tmp_dir, ignore_errors=True)
