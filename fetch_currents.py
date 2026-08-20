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

# NYT (2026-08-20 — lukker "ingen strømdata vest for ~9°E"-hullet, se memory
# "west-jutland-currents-gap"): Østersø-produktet ovenfor dækker slet ikke
# Vesterhavet/den jyske vestkyst — dets grid stopper reelt omkring ~9°E, alt
# vest for det er NaN/uden for modellens maske, ikke bare grov opløsning. NWS-
# produktet (NWSHELF_ANALYSISFORECAST_PHY_004_013) dækker Nordsøen/Kanalen/
# tilstødende shelf-farvande ved 1,5 km opløsning og bruges HERUNDER, kun
# supplerende for det stykke vestkysten Østersø-produktet ikke selv dækker
# (se west_lons-udregningen nedenfor). CMEMS holder strøm og temperatur i
# SEPARATE datasæt for dette produkt (i modsætning til Østersø-produktet
# ovenfor, hvor thetao er del af samme datasæt) — begge hentes derfor hver
# for sig nedenfor, samme variabelnavn (thetao) i begge, bekræftet direkte
# mod produktionens CMEMS-login.
#
# RETTET (bruger-rapport 2026-08-20: "styling af strømkortlaget er ikke
# gældende for det nye datagrundlag for vestkysten" — windy-currents.js'
# farveskala er en RELATIV min/max over de faktiske temperaturer i det
# viste datasæt, se computeVelocityTempRangeK() i dansk-overloeb-kort.html.
# Uden reel temp fik ALLE vestkyst-punkter samme syntetiske gennemsnits-
# faldback (fallbackTempC i server.js's buildVelocityGridJSON()), så hele
# Vesterhavet tegnede som ÉN ensfarvet klat i stedet for samme blå→røde
# gradient som resten af farvandet): henter nu ÆGTE SST for vestkyst-
# punkterne fra samme NWSHELF-produkts SST-datasæt, se DATASET_ID_NWS_SST.
DATASET_ID_NWS = "cmems_mod_nws_phy-cur_anfc_1.5km-2D_PT1H-i_202511"
DATASET_ID_NWS_SST = "cmems_mod_nws_phy-sst_anfc_1.5km-2D_PT1H-i_202511"
WEST_LON_MIN = 6.0  # dækker Vesterhavet ud til dansk søterritoriums vestgrænse

# RETTET (fjorde/smalle bælter manglede næsten al strøm-animation, se
# dansk-overloeb-kort.html's currents-sektion): windy-currents.js springer
# en HEL gittercelle over, hvis blot ÉT af dens fire hjørner mangler data
# (land/uden for CMEMS' maske) — ved STRIDE=4 (~10 km gitter) ramte det
# 28 ud af 30 celler, der overlapper Isefjord (målt direkte mod
# produktionens /api/currents/velocity), fordi et ~10 km gitter næsten
# aldrig finder fire nabopunkter, der ALLE ligger inden for en smal fjord.
# Halveret til STRIDE=2 (~5 km, dobbelt så fint i begge retninger, altså
# ca. 4x så mange gitterpunkter som før) som et første, forsigtigt skridt —
# CMEMS' native opløsning er ~2,5 km, så STRIDE=1 ville ramme den præcist,
# men det giver ~16x flere punkter end i dag; test STRIDE=2's effekt på
# fjord-dækningen, FØR der eventuelt skrues yderligere ned (se også
# alternativet i dansk-overloeb-kort.html: lempe windy's "alle fire hjørner
# skal være gyldige"-krav i stedet for/i tillæg til dette).
STRIDE = 2

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
        import numpy as np

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

        # ── Supplerende: Vesterhavet/vestkyst-punkter fra NWSHELF-produktet ──
        # Best-effort: en fejl her (nyt, endnu ikke produktions-verificeret
        # datasæt/variabelnavn — kan IKKE testes lokalt, CMEMS-login findes
        # kun som Fly-secret) må ALDRIG vælte hele strøm-hentningen. Fejler
        # dette, falder scriptet blot tilbage til de hidtidige Østersø-punkter,
        # præcis som før denne udvidelse.
        try:
            dlat = float(lats[1] - lats[0]) if len(lats) > 1 else -0.05
            dlon = float(lons[1] - lons[0]) if len(lons) > 1 else 0.08
            baltic_lon_min = float(lons.min())
            n_west = int((baltic_lon_min - WEST_LON_MIN) / abs(dlon))
            if n_west < 1:
                raise ValueError(
                    "intet rum mellem WEST_LON_MIN og Østersø-gitterets vestkant"
                )

            # Målgitter, PRÆCIST aligned med Østersø-gitteret (samme dlon-
            # skridt, umiddelbart vest for dets vestligste kolonne, og samme
            # breddegrad-rækker som Østersø-punkterne) — afgørende for at
            # buildVelocityGridJSON() i server.js (som antager ÉT
            # sammenhængende regulært gitter på tværs af ALLE punkter) kan
            # flette de to datasæt uden at gitteret bliver uregelmæssigt.
            west_lons = baltic_lon_min - abs(dlon) * np.arange(n_west, 0, -1)

            nws_tmp_dir = tempfile.mkdtemp(prefix="cmems_nws_subset_")
            try:
                copernicusmarine.subset(
                    dataset_id=DATASET_ID_NWS,
                    username=USERNAME,
                    password=PASSWORD,
                    variables=["uo", "vo"],
                    minimum_longitude=WEST_LON_MIN - abs(dlon),
                    maximum_longitude=baltic_lon_min + abs(dlon),
                    minimum_latitude=float(lats.min()) - abs(dlat),
                    maximum_latitude=float(lats.max()) + abs(dlat),
                    start_datetime=start_dt,
                    end_datetime=end_dt,
                    output_directory=nws_tmp_dir,
                    output_filename="currents_nws.nc",
                    file_format="netcdf",
                    disable_progress_bar=True,
                    overwrite=True,
                )
                nws_files = glob.glob(os.path.join(nws_tmp_dir, "**", "*.nc"), recursive=True)
                if not nws_files:
                    raise RuntimeError("NWSHELF subset gav ingen NetCDF-fil")

                nws_ds = xr.load_dataset(nws_files[0], engine="h5netcdf")
                nws_latest = nws_ds.isel(time=-1) if "time" in nws_ds.dims else nws_ds
                if "depth" in nws_latest.dims:
                    nws_latest = nws_latest.isel(depth=0)
                elif "elevation" in nws_latest.dims:
                    nws_latest = nws_latest.isel(elevation=0)

                nws_lat_name = "latitude" if "latitude" in nws_latest.coords else "lat"
                nws_lon_name = "longitude" if "longitude" in nws_latest.coords else "lon"

                print(f"[debug] NWSHELF-variable: {list(nws_latest.data_vars)}", file=sys.stderr)

                # Interpolér NWSHELF's eget (finere, 1,5 km) native grid over
                # på PRÆCIS Østersø-gitterets breddegrader + de nye west_lons
                # — .transpose() sikrer aksehåndtering (lat, lon), uafhængigt
                # af dette (endnu uverificerede) datasæts interne dim-orden.
                nws_interp = nws_latest.interp({
                    nws_lat_name: lats,
                    nws_lon_name: west_lons,
                }).transpose(nws_lat_name, nws_lon_name)

                west_uo = nws_interp["uo"].values
                west_vo = nws_interp["vo"].values

                # ── SST (thetao) til vestkyst-punkterne — SEPARAT datasæt, se
                # DATASET_ID_NWS_SST-kommentaren ovenfor. Egen best-effort
                # try/except: fejler DEN, mister vestkysten kun temp-farven
                # (falder tilbage til samme gennemsnits-faldback som før denne
                # rettelse), men beholder stadig selve strøm-animationen.
                west_temp = None
                try:
                    sst_tmp_dir = tempfile.mkdtemp(prefix="cmems_nws_sst_subset_")
                    try:
                        copernicusmarine.subset(
                            dataset_id=DATASET_ID_NWS_SST,
                            username=USERNAME,
                            password=PASSWORD,
                            variables=["thetao"],
                            minimum_longitude=WEST_LON_MIN - abs(dlon),
                            maximum_longitude=baltic_lon_min + abs(dlon),
                            minimum_latitude=float(lats.min()) - abs(dlat),
                            maximum_latitude=float(lats.max()) + abs(dlat),
                            start_datetime=start_dt,
                            end_datetime=end_dt,
                            output_directory=sst_tmp_dir,
                            output_filename="sst_nws.nc",
                            file_format="netcdf",
                            disable_progress_bar=True,
                            overwrite=True,
                        )
                        sst_files = glob.glob(os.path.join(sst_tmp_dir, "**", "*.nc"), recursive=True)
                        if not sst_files:
                            raise RuntimeError("NWSHELF SST subset gav ingen NetCDF-fil")

                        sst_ds = xr.load_dataset(sst_files[0], engine="h5netcdf")
                        sst_latest = sst_ds.isel(time=-1) if "time" in sst_ds.dims else sst_ds
                        if "depth" in sst_latest.dims:
                            sst_latest = sst_latest.isel(depth=0)
                        elif "elevation" in sst_latest.dims:
                            sst_latest = sst_latest.isel(elevation=0)

                        sst_lat_name = "latitude" if "latitude" in sst_latest.coords else "lat"
                        sst_lon_name = "longitude" if "longitude" in sst_latest.coords else "lon"

                        sst_interp = sst_latest.interp({
                            sst_lat_name: lats,
                            sst_lon_name: west_lons,
                        }).transpose(sst_lat_name, sst_lon_name)
                        west_temp = sst_interp["thetao"].values
                    finally:
                        shutil.rmtree(sst_tmp_dir, ignore_errors=True)
                except Exception as e:
                    print(
                        f"[warn] NWSHELF SST (vestkyst-temperatur) fejlede ({describe_exception(e)}) — "
                        f"vestkyst-punkter fortsætter uden ægte temp",
                        file=sys.stderr,
                    )

                west_count = 0
                for i, lat in enumerate(lats):
                    for j, lon in enumerate(west_lons):
                        u = float(west_uo[i, j])
                        v = float(west_vo[i, j])
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
                        if west_temp is not None:
                            t = float(west_temp[i, j])
                            if not math.isnan(t) and -5 < t < 40:
                                point["temp"] = round(t, 2)
                        points.append(point)
                        west_count += 1
                print(
                    f"[debug] NWSHELF (vestkyst): {west_count} punkter tilføjet "
                    f"fra {n_west} gitterkolonner ({WEST_LON_MIN}°E–{baltic_lon_min:.2f}°E), "
                    f"temp: {'ja' if west_temp is not None else 'nej'}",
                    file=sys.stderr,
                )
            finally:
                shutil.rmtree(nws_tmp_dir, ignore_errors=True)
        except Exception as e:
            print(
                f"[warn] NWSHELF vestkyst-udvidelse fejlede ({describe_exception(e)}) — "
                f"fortsætter med kun Østersø-punkter (uændret hidtidig adfærd)",
                file=sys.stderr,
            )

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
