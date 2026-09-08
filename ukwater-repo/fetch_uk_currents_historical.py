#!/usr/bin/env python3
"""
fetch_uk_currents_historical.py — real historical daily-mean current
velocity (uo, vo) for the whole Southern Water bathing-site/outlet
coastline, from CMEMS's confirmed-live multi-year reanalysis product.

Dataset confirmed LIVE via `copernicusmarine describe --contains
NWSHELF_MULTIYEAR_PHY_004_009` during this session (not guessed): product
NWSHELF_MULTIYEAR_PHY_004_009 ("Atlantic- European North West Shelf- Ocean
Physics Reanalysis"), dataset cmems_mod_nws_phy-uv_my_7km-3D_P1D-m
(daily-mean horizontal velocity) — the same dataset ID dkvand's own
scripts/fetch_currents_historical.py had guessed but explicitly flagged as
UNCONFIRMED for the UK ("ingen CMEMS-credentials tilgængelige" at the time
it was written). Now confirmed.

Unlike that per-POINT script (one subset() call per grid cell, looped from
Node), this fetches ONE bounding box covering the whole real outlet/site
area in a SINGLE subset() call — same efficient-batching approach as the
real product's own live fetch (krestenbersoe/ukwater's
pipeline/lib/cmems_fetch.py: "fetch the box once, extract many points
locally" rather than one network round-trip per point), just for the
multi-year product instead of the live analysis-forecast one. The real
outlet/EA-site coastline (Kent to the Solent) is compact enough that one
bbox with generous padding covers it cheaply.

Kør (kræver copernicusmarine >=2.4 installeret + CMEMS_USERNAME/
CMEMS_PASSWORD sat som miljøvariabler, ALDRIG som argumenter/i en fil):
  CMEMS_USERNAME=... CMEMS_PASSWORD=... python3 fetch_uk_currents_historical.py \
    --out output/currents-history.json [--date-from 2015-01-01] [--date-to 2026-09-08]

Output (stdout is progress/log only — the real data goes to --out):
  {
    "generatedAt": "...", "datasetId": "...",
    "meta": {"latMin":.., "latMax":.., "lonMin":.., "lonMax":..,
              "dateFrom": "...", "dateTo": "...", "actualDateRange": ["...", "..."]},
    "grid": [{"lat":.., "lon":.., "dates": ["YYYY-MM-DD", ...], "uo": [...], "vo": [...]}, ...]
  }
"""
import sys
import os
import json
import math
import argparse
import tempfile
import glob
import shutil
import datetime as _dt

USERNAME = (os.environ.get("CMEMS_USERNAME") or "").strip()
PASSWORD = (os.environ.get("CMEMS_PASSWORD") or "").strip()
if not USERNAME or not PASSWORD:
    print(json.dumps({"error": "CMEMS_USERNAME/CMEMS_PASSWORD not set"}))
    sys.exit(1)

try:
    import copernicusmarine
    import xarray as xr
except ImportError as e:
    print(json.dumps({"error": f"missing package: {e}"}))
    sys.exit(1)

DATASET_ID = "cmems_mod_nws_phy-uv_my_7km-3D_P1D-m"

parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True)
parser.add_argument("--date-from", default="2015-01-01")
parser.add_argument("--date-to", default=_dt.date.today().isoformat())
# Real outlet/EA-site coastline (Kent to the Solent), lat 50.59-51.44,
# lon -1.70..1.45 — checked directly against ea-sites.json before writing
# this script — padded generously.
parser.add_argument("--lat-min", type=float, default=50.2)
parser.add_argument("--lat-max", type=float, default=51.8)
parser.add_argument("--lon-min", type=float, default=-2.0)
parser.add_argument("--lon-max", type=float, default=1.8)
args = parser.parse_args()

print(f"[info] username len={len(USERNAME)} starts={USERNAME[:2]!r} | password len={len(PASSWORD)}", file=sys.stderr)
print(f"[info] fetching {DATASET_ID} bbox lat[{args.lat_min},{args.lat_max}] lon[{args.lon_min},{args.lon_max}] {args.date_from}..{args.date_to}", file=sys.stderr)

start_dt = _dt.datetime.fromisoformat(f"{args.date_from}T00:00:00+00:00")
end_dt = _dt.datetime.fromisoformat(f"{args.date_to}T23:59:59+00:00")

tmp_dir = tempfile.mkdtemp(prefix="cmems_uk_hist_")
try:
    copernicusmarine.subset(
        dataset_id=DATASET_ID,
        username=USERNAME,
        password=PASSWORD,
        variables=["uo", "vo"],
        minimum_longitude=args.lon_min, maximum_longitude=args.lon_max,
        minimum_latitude=args.lat_min, maximum_latitude=args.lat_max,
        minimum_depth=0, maximum_depth=1,
        start_datetime=start_dt, end_datetime=end_dt,
        output_directory=tmp_dir, output_filename="uk_currents_hist.nc",
        file_format="netcdf", disable_progress_bar=False, overwrite=True,
    )
    nc_files = glob.glob(os.path.join(tmp_dir, "**", "*.nc"), recursive=True)
    if not nc_files:
        print(json.dumps({"error": "subset produced no NetCDF file"}))
        sys.exit(1)

    ds = xr.load_dataset(nc_files[0], engine="h5netcdf")
    if "depth" in ds.dims:
        ds = ds.isel(depth=0)
    elif "elevation" in ds.dims:
        ds = ds.isel(elevation=0)

    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"

    lats = ds[lat_name].values
    lons = ds[lon_name].values
    times = [str(t)[:10] for t in ds["time"].values]
    uo_all = ds["uo"].values  # shape (time, lat, lon)
    vo_all = ds["vo"].values

    grid = []
    for i, lat in enumerate(lats):
        for j, lon in enumerate(lons):
            dates, uo_out, vo_out = [], [], []
            for t in range(len(times)):
                u = float(uo_all[t, i, j])
                v = float(vo_all[t, i, j])
                if math.isnan(u) or math.isnan(v):
                    continue
                if abs(u) > 10 or abs(v) > 10:
                    continue
                dates.append(times[t])
                uo_out.append(round(u, 4))
                vo_out.append(round(v, 4))
            if dates:
                grid.append({"lat": round(float(lat), 4), "lon": round(float(lon), 4), "dates": dates, "uo": uo_out, "vo": vo_out})

    if not grid:
        print(json.dumps({"error": "no current points extracted (all-land bbox or no coverage)"}))
        sys.exit(1)

    actual_range = [min(g["dates"][0] for g in grid), max(g["dates"][-1] for g in grid)]
    output = {
        "generatedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "datasetId": DATASET_ID,
        "meta": {
            "latMin": args.lat_min, "latMax": args.lat_max, "lonMin": args.lon_min, "lonMax": args.lon_max,
            "dateFrom": args.date_from, "dateTo": args.date_to, "actualDateRange": actual_range,
            "gridPointCount": len(grid),
        },
        "grid": grid,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(output, f)
    print(f"[info] wrote {len(grid)} grid points, actual date range {actual_range[0]}..{actual_range[1]}, to {args.out}", file=sys.stderr)
    print(json.dumps({"ok": True, "gridPointCount": len(grid), "actualDateRange": actual_range}))

except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
finally:
    shutil.rmtree(tmp_dir, ignore_errors=True)
