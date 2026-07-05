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

DATASET_ID = "cmems_mod_bal_phy_cur_anfc_2.5km_PT1H-i"

# Dansk farvand (samme bbox som tidligere JS-implementering)
LAT_MIN, LAT_MAX = 54.0, 58.0
LON_MIN, LON_MAX = 8.0, 15.0

# Stride ~2 -> ca. 5 km opløsning, matcher tidligere implementering
STRIDE = 2

try:
    ds = copernicusmarine.open_dataset(
        dataset_id=DATASET_ID,
        username=USERNAME,
        password=PASSWORD,
        variables=["uo", "vo"],
        minimum_longitude=LON_MIN,
        maximum_longitude=LON_MAX,
        minimum_latitude=LAT_MIN,
        maximum_latitude=LAT_MAX,
    )
except Exception as e:
    fail(f"open_dataset failed: {describe_exception(e)}")

try:
    # Seneste tidspunkt i datasættet
    latest = ds.isel(time=-1) if "time" in ds.dims else ds

    # Overfladelag hvis der er en dybde-dimension
    if "depth" in latest.dims:
        latest = latest.isel(depth=0)
    elif "elevation" in latest.dims:
        latest = latest.isel(elevation=0)

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

    points = []
    for i, lat in enumerate(lats):
        for j, lon in enumerate(lons):
            u = float(uo_vals[i, j])
            v = float(vo_vals[i, j])
            if math.isnan(u) or math.isnan(v):
                continue
            if abs(u) > 10 or abs(v) > 10:  # fill-value sentinel
                continue
            points.append({
                "lat": round(float(lat), 4),
                "lng": round(float(lon), 4),
                "uo": round(u, 4),
                "vo": round(v, 4),
            })

    if not points:
        fail("no current points extracted from dataset")

    print(json.dumps({
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "points": points,
    }))

except Exception as e:
    fail(f"data extraction failed: {describe_exception(e)}")
