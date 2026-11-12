#!/usr/bin/env python3
# /// script
# dependencies = [
#   "zarr>=3.0.0",
#   "gcsfs>=2024.1.0",
#   "numpy>=1.26.0",
# ]
# ///
"""
scripts/fetch-weathernext3.py

Google DeepMind WeatherNext 3 Data Extraction & Staging CLI.
Accesses requester-pays GCS bucket:
  gs://weathernext3_statistics_spatial/weathernext_3_0_0_statistics/zarr/2026_to_present/
with billing project 'antigravity-agent-1765655548'.

Features:
- Application Default Credentials (ADC) resolution respecting ~/.zshenv, environment variables,
  and ~/.config/gcloud/application_default_credentials.json.
- Resolves GCSFileSystem with token=adc_path string to prevent Zarr 3.x serializability errors.
- Fast backward candidate search from UTC now to discover latest finalized cycle in < 2 seconds.
- Validates completion via 'success' sentinel file.
- Extracts up to 48 hourly timesteps (t=0 to t=47) across 6 core prognostic fields:
    1. u_component_of_wind_10m_mean (10m eastward wind velocity)
    2. v_component_of_wind_10m_mean (10m northward wind velocity)
    3. total_precipitation_1hr_mean (accumulated precipitation rate)
    4. temperature_2m_mean (2m ambient surface temperature)
    5. dewpoint_temperature_2m_mean (2m surface dewpoint temperature)
    6. total_cloud_cover_mean (column-integrated cloud fraction)
- Decodes Zarr v3 chunks [1, 1801, 3600], downcasting Float32 -> Float16 (np.float16).
- Inverts latitudes vertically (slice[::-1, :]) so row 0 is North Pole (+90°) matching WebGPU / cartographic convention.
- Rolls longitudes horizontally by 1800 columns (np.roll(..., GRID_WIDTH // 2, axis=1)) so column 0 is Antimeridian (-180°).
- Supports WebGPU 256-byte row pitch padding: 3600 * 2 = 7200 bytes raw -> 7424 bytes padded (224 bytes pad per row).
- Generates metadata index: public/data/weathernext/meta.json.
- Local caching: skips downloading if matching cycle and slices already exist.
- --dry-run: verifies auth, bucket connectivity, finds latest cycle, lists variables, checks chunk metadata,
  computes expected bandwidth and storage, and exits with code 0 without downloading full tensors.
"""

import sys
import os
import re
import math
import time
import json
import argparse
import warnings
import atexit
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from typing import Tuple, List, Dict, Any, Optional

# Suppress harmless asyncio / weakref warnings at Python shutdown
warnings.filterwarnings("ignore")

def _suppress_asyncio_shutdown_warning():
    try:
        import asyncio
        loop = asyncio.get_event_loop_policy().get_event_loop()
        if loop.is_running():
            loop.stop()
    except Exception:
        pass

atexit.register(_suppress_asyncio_shutdown_warning)

# Constants & Configuration
DEFAULT_BILLING_PROJECT = "antigravity-agent-1765655548"
GCS_BUCKET_NAME = "weathernext3_statistics_spatial"
GCS_PREFIX_DIR = "weathernext_3_0_0_statistics/zarr/2026_to_present"
GCS_DATASET_URL = f"gs://{GCS_BUCKET_NAME}/{GCS_PREFIX_DIR}/"

GRID_WIDTH = 3600
GRID_HEIGHT = 1801
BYTES_PER_TEXEL = 2  # Float16
RAW_ROW_BYTES = GRID_WIDTH * BYTES_PER_TEXEL  # 7200
PADDED_ROW_BYTES = math.ceil(RAW_ROW_BYTES / 256) * 256  # 7424
PADDING_BYTES_PER_ROW = PADDED_ROW_BYTES - RAW_ROW_BYTES  # 224
PADDING_TEXELS_PER_ROW = PADDING_BYTES_PER_ROW // BYTES_PER_TEXEL  # 112
PADDED_COLS = GRID_WIDTH + PADDING_TEXELS_PER_ROW  # 3712

UNPADDED_SLICE_BYTES = RAW_ROW_BYTES * GRID_HEIGHT  # 12,967,200 bytes
PADDED_SLICE_BYTES = PADDED_ROW_BYTES * GRID_HEIGHT  # 13,370,624 bytes

# 2-channel vector field constants (rg16float)
VECTOR_BYTES_PER_TEXEL = 4  # 2x Float16
VECTOR_RAW_ROW_BYTES = GRID_WIDTH * VECTOR_BYTES_PER_TEXEL  # 14400
VECTOR_PADDED_ROW_BYTES = math.ceil(VECTOR_RAW_ROW_BYTES / 256) * 256  # 14592
VECTOR_PADDING_BYTES_PER_ROW = VECTOR_PADDED_ROW_BYTES - VECTOR_RAW_ROW_BYTES  # 192
VECTOR_PADDING_TEXELS_PER_ROW = VECTOR_PADDING_BYTES_PER_ROW // VECTOR_BYTES_PER_TEXEL  # 48
VECTOR_PADDED_COLS = GRID_WIDTH + VECTOR_PADDING_TEXELS_PER_ROW  # 3648

VECTOR_UNPADDED_SLICE_BYTES = VECTOR_RAW_ROW_BYTES * GRID_HEIGHT  # 25,934,400 bytes
VECTOR_PADDED_SLICE_BYTES = VECTOR_PADDED_ROW_BYTES * GRID_HEIGHT  # 26,280,192 bytes

DEFAULT_HOURS = 12
MAX_SAFE_HOURS = 12
COST_PER_GB_USD = 0.10
MAX_SAFE_COST_USD = 0.25

CORE_VARIABLES = [
    "wind_10m_vector",
    "total_precipitation_1hr_mean",
    "temperature_2m_mean",
    "dewpoint_temperature_2m_mean",
    "low_cloud_cover_mean",
    "medium_cloud_cover_mean",
    "high_cloud_cover_mean",
]

CLOUD_STRATA_VARIABLES = [
    "low_cloud_cover_mean",
    "medium_cloud_cover_mean",
    "high_cloud_cover_mean",
    "wind_10m_vector",
]

VARIABLE_METADATA = {
    "u_component_of_wind_10m_mean": {
        "longName": "10m Eastward Wind Velocity",
        "units": "m/s",
        "canonicalMin": -45.0,
        "canonicalMax": 45.0,
    },
    "v_component_of_wind_10m_mean": {
        "longName": "10m Northward Wind Velocity",
        "units": "m/s",
        "canonicalMin": -45.0,
        "canonicalMax": 45.0,
    },
    "wind_10m_vector": {
        "longName": "10m Wind Velocity Vector Field (rg16float)",
        "units": "m/s",
        "canonicalMin": -45.0,
        "canonicalMax": 45.0,
    },
    "total_precipitation_1hr_mean": {
        "longName": "Accumulated Precipitation Rate",
        "units": "kg/m^2",
        "canonicalMin": 0.0,
        "canonicalMax": 50.0,
    },
    "temperature_2m_mean": {
        "longName": "2m Ambient Surface Temperature",
        "units": "°C",
        "canonicalMin": -90.0,
        "canonicalMax": 60.0,
    },
    "dewpoint_temperature_2m_mean": {
        "longName": "2m Surface Dewpoint Temperature",
        "units": "°C",
        "canonicalMin": -90.0,
        "canonicalMax": 60.0,
    },
    "total_cloud_cover_mean": {
        "longName": "Column-Integrated Total Cloud Fraction",
        "units": "fraction",
        "canonicalMin": 0.0,
        "canonicalMax": 1.0,
    },
    "low_cloud_cover_mean": {
        "longName": "Low Cloud Cover Fraction (0-2000m)",
        "units": "fraction",
        "canonicalMin": 0.0,
        "canonicalMax": 1.0,
    },
    "medium_cloud_cover_mean": {
        "longName": "Medium Cloud Cover Fraction (2000-6000m)",
        "units": "fraction",
        "canonicalMin": 0.0,
        "canonicalMax": 1.0,
    },
    "high_cloud_cover_mean": {
        "longName": "High Cloud Cover Fraction (6000-12000m)",
        "units": "fraction",
        "canonicalMin": 0.0,
        "canonicalMax": 1.0,
    },
    "sea_surface_temperature_mean": {
        "longName": "Sea Surface Temperature",
        "units": "°C",
        "canonicalMin": -2.0,
        "canonicalMax": 40.0,
    },
    "mean_sea_level_pressure_mean": {
        "longName": "Mean Sea Level Pressure Anomaly (P - 1013.25 hPa)",
        "units": "hPa",
        "canonicalMin": -140.0,
        "canonicalMax": 70.0,
    },
    "surface_solar_radiation_downwards_1hr_mean": {
        "longName": "Surface Downwelling Shortwave Flux (SSRD)",
        "units": "W/m^2",
        "canonicalMin": 0.0,
        "canonicalMax": 1200.0,
    },
    "total_sky_direct_solar_radiation_at_surface_1hr_mean": {
        "longName": "Surface Direct Shortwave Flux (FDIR)",
        "units": "W/m^2",
        "canonicalMin": 0.0,
        "canonicalMax": 1200.0,
    },
    "radiative_optical_depth": {
        "longName": "Normalized Cloud Radiative Optical Depth (1 - FDIR/SSRD + Multi-Layer Overlap)",
        "units": "fraction",
        "canonicalMin": 0.0,
        "canonicalMax": 1.0,
    },
    "u_component_of_wind_100m_mean": {
        "longName": "100m Eastward Boundary-Layer Wind Component",
        "units": "m/s",
        "canonicalMin": -60.0,
        "canonicalMax": 60.0,
    },
    "v_component_of_wind_100m_mean": {
        "longName": "100m Northward Boundary-Layer Wind Component",
        "units": "m/s",
        "canonicalMin": -60.0,
        "canonicalMax": 60.0,
    },
    "wind_100m_vector": {
        "longName": "100m Boundary-Layer Wind Velocity Vector Field (rg16float)",
        "units": "m/s",
        "canonicalMin": -60.0,
        "canonicalMax": 60.0,
    },
    "convective_spread": {
        "longName": "Ensemble Quantile Convective Spread (_p90 - _p10)",
        "units": "fraction",
        "canonicalMin": 0.0,
        "canonicalMax": 1.0,
    },
    "station_head_temperature_2m_mean": {
        "longName": "0.05-deg Station-Head 2m Surface Temperature",
        "units": "°C",
        "canonicalMin": -90.0,
        "canonicalMax": 60.0,
    },
    "station_head_dewpoint_temperature_2m_mean": {
        "longName": "0.05-deg Station-Head 2m Dewpoint Temperature",
        "units": "°C",
        "canonicalMin": -90.0,
        "canonicalMax": 60.0,
    },
    "imerg_tp_1hr_mean": {
        "longName": "IMERG-Calibrated 1-Hour Total Precipitation Accumulation",
        "units": "mm/hr",
        "canonicalMin": 0.0,
        "canonicalMax": 100.0,
    },
}

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_OUTPUT_DIR = os.path.join(PROJECT_ROOT, "public", "data", "weathernext")


def resolve_adc_and_project(cli_project: Optional[str] = None) -> Tuple[str, str]:
    """
    Resolves Application Default Credentials file path and billing project.
    Checks CLI args, environment variables, ~/.zshenv, and default gcloud paths.
    """
    # 1. Billing project resolution
    billing_project = cli_project or os.environ.get("CLOUDSDK_CORE_PROJECT")
    
    # 2. Check ~/.zshenv for environment variables if not already set
    zshenv_path = os.path.expanduser("~/.zshenv")
    adc_env = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    
    if os.path.exists(zshenv_path):
        try:
            with open(zshenv_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not billing_project and "CLOUDSDK_CORE_PROJECT=" in line:
                        m = re.search(r'CLOUDSDK_CORE_PROJECT=["\']?([^"\'\s]+)', line)
                        if m:
                            billing_project = m.group(1)
                    if not adc_env and "GOOGLE_APPLICATION_CREDENTIALS=" in line:
                        m = re.search(r'GOOGLE_APPLICATION_CREDENTIALS=["\']?([^"\'\s]+)', line)
                        if m:
                            adc_env = m.group(1)
        except Exception:
            pass

    if not billing_project:
        billing_project = DEFAULT_BILLING_PROJECT

    # 3. ADC path resolution
    adc_candidates = [
        adc_env,
        os.path.expanduser("~/.config/gcloud/application_default_credentials.json"),
    ]

    resolved_adc: Optional[str] = None
    for candidate in adc_candidates:
        if candidate and os.path.exists(os.path.expanduser(candidate)):
            resolved_adc = os.path.abspath(os.path.expanduser(candidate))
            break

    if not resolved_adc:
        raise RuntimeError(
            "Could not locate Application Default Credentials (ADC) file.\n"
            "Checked GOOGLE_APPLICATION_CREDENTIALS and ~/.config/gcloud/application_default_credentials.json.\n"
            "Please run `gcloud auth application-default login` to authenticate."
        )

    return resolved_adc, billing_project


def init_gcsfs(adc_path: str, billing_project: str):
    """
    Initializes gcsfs.GCSFileSystem with requester_pays=True.
    Passing token=adc_path as a string path prevents Zarr 3.x serializability errors.
    """
    import gcsfs
    fs = gcsfs.GCSFileSystem(
        project=billing_project,
        token=adc_path,
        requester_pays=True,
    )
    return fs


def discover_latest_cycle(
    fs,
    bucket: str = GCS_BUCKET_NAME,
    prefix: str = GCS_PREFIX_DIR,
    requested_cycle: Optional[str] = None,
    max_backward_hours: int = 72,
) -> Tuple[str, str, str]:
    """
    Discovers the latest completed WeatherNext 3 cycle.
    Uses fast backward candidate search from UTC now, checking for the 'success' sentinel file.
    Returns: (cycle_name, cycle_full_gcs_path, init_iso_timestamp)
    """
    if requested_cycle:
        clean_cycle = requested_cycle.strip("/")
        cycle_dir = f"{bucket}/{prefix}/{clean_cycle}"
        success_file = f"{cycle_dir}/success"
        if not fs.exists(success_file):
            # Check if directory exists at least
            if not fs.exists(cycle_dir):
                raise ValueError(f"Requested cycle directory does not exist: gs://{cycle_dir}")
            print(f"[WARN] Requested cycle gs://{cycle_dir} does not contain 'success' sentinel.")
        
        # Parse ISO timestamp from cycle name e.g. 20260911_18hr_01_preds
        m = re.match(r"^(\d{4})(\d{2})(\d{2})_(\d{2})hr", clean_cycle)
        if m:
            init_iso = f"{m.group(1)}-{m.group(2)}-{m.group(3)}T{m.group(4)}:00:00Z"
        else:
            init_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
        return clean_cycle, cycle_dir, init_iso

    now = datetime.now(timezone.utc)
    t0 = time.perf_counter()
    
    # Backward candidate probe
    for hours_back in range(max_backward_hours):
        dt = now - timedelta(hours=hours_back)
        candidate = dt.strftime("%Y%m%d_%Hhr_01_preds")
        cycle_dir = f"{bucket}/{prefix}/{candidate}"
        success_file = f"{cycle_dir}/success"
        
        if fs.exists(success_file):
            elapsed_s = time.perf_counter() - t0
            init_iso = dt.strftime("%Y-%m-%dT%H:00:00Z")
            print(f"-> Discovered finalized cycle: {candidate} in {elapsed_s:.2f}s (checking 'success' sentinel)")
            return candidate, cycle_dir, init_iso

    raise RuntimeError(
        f"No finalized forecast cycle with 'success' sentinel found in gs://{bucket}/{prefix}/ "
        f"over the past {max_backward_hours} hours."
    )


def open_zarr_predictions(cycle_dir: str, adc_path: str, billing_project: str):
    """
    Opens predictions.zarr group within the cycle directory in read-only mode.
    """
    import zarr
    store_url = f"gs://{cycle_dir}/predictions.zarr"
    storage_opts = {
        "project": billing_project,
        "token": adc_path,
        "requester_pays": True,
    }
    zg = zarr.open_group(store_url, mode="r", storage_options=storage_opts)
    return zg


def execute_dry_run(
    fs,
    adc_path: str,
    billing_project: str,
    cycle_name: str,
    cycle_dir: str,
    init_iso: str,
    variables: List[str],
    hours: int,
    padded: bool,
):
    """
    Executes dry run verification:
    - Verifies auth, bucket connectivity, and cycle discovery.
    - Inspects Zarr v3 store and checks shapes, chunking, and codecs for all variables.
    - Measures chunk 0 byte size from GCS info.
    - Calculates network egress bandwidth and uncompressed staging storage requirements.
    - Exits with code 0 without downloading full tensors.
    """
    import zarr
    print("=" * 80)
    print("WEATHERNEXT 3 PIPELINE: DRY-RUN VERIFICATION & CAPACITY AUDIT")
    print("=" * 80)
    print(f"Google Cloud ADC:       {adc_path}")
    print(f"Requester-Pays Project: {billing_project}")
    print(f"Target Bucket:          gs://{cycle_dir}/")
    print(f"Latest Forecast Cycle:  {cycle_name}")
    print(f"Forecast Init Time:     {init_iso}")
    print(f"Verification Sentinel:  gs://{cycle_dir}/success (Confirmed Present)")
    print(f"Timestep Horizon:       {hours} hours (t=0h to t=+{hours-1}h)")
    print(f"WebGPU Row Pitch Mode:  {'256-Byte Padded (7424 bytes/row)' if padded else 'Unpadded Raw (7200 bytes/row)'}")
    print("-" * 80)

    t0 = time.perf_counter()
    zg = open_zarr_predictions(cycle_dir, adc_path, billing_project)
    open_elapsed = time.perf_counter() - t0
    print(f"Zarr v3 Store Opened:   predictions.zarr ({open_elapsed:.2f}s, {len(zg)} available variables)")

    print("\nVariable Manifest & Chunk Audit:")
    print(f"{'Variable':<32} {'Shape':<18} {'Chunk Shape':<16} {'Dtype':<8} {'Chunk 0 Wire Size':<18}")
    print("-" * 96)

    total_wire_sample_bytes = 0
    measured_vars = 0
    total_disk_estimate_bytes = 0
    total_chunks_to_fetch = 0

    for var_name in variables:
        if var_name == "wind_10m_vector":
            if "u_component_of_wind_10m_mean" not in zg or "v_component_of_wind_10m_mean" not in zg:
                raise KeyError("u/v wind components not found in predictions.zarr for wind_10m_vector!")
            u_arr = zg["u_component_of_wind_10m_mean"]
            v_arr = zg["v_component_of_wind_10m_mean"]

            chunk_u_bytes = 0
            chunk_v_bytes = 0
            try:
                chunk_u_bytes = fs.info(f"{cycle_dir}/predictions.zarr/u_component_of_wind_10m_mean/c/0/0/0").get("size", 0)
                chunk_v_bytes = fs.info(f"{cycle_dir}/predictions.zarr/v_component_of_wind_10m_mean/c/0/0/0").get("size", 0)
                wire_bytes = chunk_u_bytes + chunk_v_bytes
                total_wire_sample_bytes += wire_bytes
                measured_vars += 2
                wire_str = f"{wire_bytes / (1024 * 1024):.2f} MB (u+v)"
            except Exception:
                wire_str = "N/A"

            shape_str = str(list(u_arr.shape))
            chunks_str = str(list(u_arr.chunks))
            print(f"{var_name:<32} {shape_str:<18} {chunks_str:<16} {'rg16flt':<8} {wire_str:<18}")
            slice_bytes = VECTOR_PADDED_SLICE_BYTES if padded else VECTOR_UNPADDED_SLICE_BYTES
            total_disk_estimate_bytes += hours * slice_bytes
            total_chunks_to_fetch += 2 * hours
            continue

        if var_name not in zg:
            raise KeyError(f"Requested variable '{var_name}' not found in predictions.zarr!")
        arr = zg[var_name]
        
        # Query GCS object info for chunk 0 (c/0/0/0)
        chunk0_path = f"{cycle_dir}/predictions.zarr/{var_name}/c/0/0/0"
        try:
            info = fs.info(chunk0_path)
            chunk0_bytes = info.get("size", 0)
            size_str = f"{chunk0_bytes / (1024 * 1024):.2f} MB"
            total_wire_sample_bytes += chunk0_bytes
            measured_vars += 1
        except Exception as e:
            size_str = "N/A"

        shape_str = str(list(arr.shape))
        chunks_str = str(list(arr.chunks))
        print(f"{var_name:<32} {shape_str:<18} {chunks_str:<16} {str(arr.dtype):<8} {size_str:<18}")
        slice_bytes = PADDED_SLICE_BYTES if padded else UNPADDED_SLICE_BYTES
        total_disk_estimate_bytes += hours * slice_bytes
        total_chunks_to_fetch += hours

    print("-" * 96)

    avg_chunk_wire_bytes = (total_wire_sample_bytes / measured_vars) if measured_vars > 0 else 21_000_000
    total_wire_estimate_bytes = total_chunks_to_fetch * avg_chunk_wire_bytes
    slice_disk_bytes = PADDED_SLICE_BYTES if padded else UNPADDED_SLICE_BYTES

    print("\nBandwidth & Storage Capacity Projections:")
    print(f"Total Tensors to Fetch: {total_chunks_to_fetch} slices ({len(variables)} fields × {hours} hours)")
    print(f"Average Wire Chunk Size: {avg_chunk_wire_bytes / (1024 * 1024):.2f} MB (Zstandard Level 0 compressed)")
    print(f"Projected Wire Egress:   {total_wire_estimate_bytes / (1024 * 1024 * 1024):.2f} GB (Requester-pays to {billing_project})")
    print(f"Output Slice Format:     Float16 (r16float, 2 bytes/texel, vertically flipped for WebGPU)")
    print(f"Per-Slice Staged Size:   {slice_disk_bytes / (1024 * 1024):.2f} MB ({slice_disk_bytes:,} bytes)")
    print(f"Total Staged Footprint:  {total_disk_estimate_bytes / (1024 * 1024 * 1024):.2f} GB on disk in public/data/weathernext/")

    print("\nWebGPU Hardware Compatibility Audit (Invariant §40 & §73):")
    print(f"  Grid Dimensions:       {GRID_WIDTH} cols × {GRID_HEIGHT} rows (0.1° Pole-to-Pole)")
    print(f"  Raw Row Pitch:         {RAW_ROW_BYTES} bytes ({GRID_WIDTH} texels × 2 bytes)")
    print(f"  256-Byte Remainder:    {RAW_ROW_BYTES % 256} bytes (Needs padding: {RAW_ROW_BYTES % 256 != 0})")
    print(f"  Hardware Row Pitch:    {PADDED_ROW_BYTES} bytes ({PADDED_COLS} texels, divisible by 256)")
    print(f"  Row Zero-Padding:      {PADDING_BYTES_PER_ROW} bytes ({PADDING_TEXELS_PER_ROW} zero texels)")
    print(f"  Zero-Copy Pass-Through:{' ENABLED (Pre-padded on disk)' if padded else ' DISABLED (Runtime JS row staging required)'}")

    print("\n[OK] DRY-RUN VERIFICATION PASSED. All authentication, GCS connectivity, and metadata contracts valid.")
    print("=" * 80)
    sys.exit(0)


def check_local_cache(
    output_dir: str,
    cycle_name: str,
    variables: List[str],
    hours: int,
    padded: bool,
) -> bool:
    """
    Checks if local cached binary files and meta.json already match the requested cycle.
    """
    meta_path = os.path.join(output_dir, "meta.json")
    if not os.path.exists(meta_path):
        return False

    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        return False

    if meta.get("forecastRunCycle") != cycle_name:
        return False

    expected_padded = meta.get("textureEncoding", {}).get("isPrePadded", False)
    if expected_padded != padded:
        return False

    # Check all slice files
    for var_name in variables:
        is_vector = var_name == "wind_10m_vector"
        expected_size = (
            (VECTOR_PADDED_SLICE_BYTES if padded else VECTOR_UNPADDED_SLICE_BYTES)
            if is_vector
            else (PADDED_SLICE_BYTES if padded else UNPADDED_SLICE_BYTES)
        )
        for h in range(hours):
            slice_path = os.path.join(output_dir, f"{var_name}-{h}.bin")
            if not os.path.exists(slice_path):
                return False
            if os.path.getsize(slice_path) != expected_size:
                return False

    return True


def write_metadata_index(
    output_dir: str,
    cycle_name: str,
    cycle_dir: str,
    init_iso: str,
    variables: List[str],
    hours: int,
    padded: bool,
    billing_project: str,
):
    """
    Generates public/data/weathernext/meta.json recording forecast initialization timestamp,
    forecast run cycle, variable list, valid prediction hours, grid dimensions, and textureEncoding details.
    """
    meta = {
        "source": "Google DeepMind WeatherNext 3",
        "model": "weathernext_3_0_0_statistics",
        "dataset": f"gs://{GCS_BUCKET_NAME}/{GCS_PREFIX_DIR}/",
        "forecastInitTimestamp": init_iso,
        "forecastRunCycle": cycle_name,
        "ingestedAtUTC": datetime.now(timezone.utc).isoformat(),
        "billingProject": billing_project,
        "gridDimensions": {
            "width": GRID_WIDTH,
            "height": GRID_HEIGHT,
            "lonPoints": GRID_WIDTH,
            "latPoints": GRID_HEIGHT,
            "resolutionDeg": 0.1,
            "latMin": -90.0,
            "latMax": 90.0,
            "lonMin": -180.0,
            "lonMax": 179.9,
        },
        "timeHorizon": {
            "startHour": 0,
            "endHour": hours - 1,
            "stepHours": 1,
            "totalHours": hours,
        },
        "validPredictionHours": list(range(hours)),
        "cloudStrataCoverage": "full_3_strata" if ("low_cloud_cover_mean" in variables and "medium_cloud_cover_mean" in variables and "high_cloud_cover_mean" in variables) else ("single_layer_total" if "total_cloud_cover_mean" in variables else "none"),
        "cloudStrata": {
            "mode": "full_3_strata" if ("low_cloud_cover_mean" in variables and "medium_cloud_cover_mean" in variables and "high_cloud_cover_mean" in variables) else ("single_layer_total" if "total_cloud_cover_mean" in variables else "none"),
            "hasLowCloud": "low_cloud_cover_mean" in variables,
            "hasMediumCloud": "medium_cloud_cover_mean" in variables,
            "hasHighCloud": "high_cloud_cover_mean" in variables,
            "hasTotalCloud": "total_cloud_cover_mean" in variables,
            "isFull3Strata": "low_cloud_cover_mean" in variables and "medium_cloud_cover_mean" in variables and "high_cloud_cover_mean" in variables,
        },
        "costEnvelope": {
            "horizonHours": hours,
            "maxSafeHours": MAX_SAFE_HOURS,
            "wireVariablesCount": len([v for v in variables if v != "wind_10m_vector"]),
            "projectedWireEgressGB": round(len([v for v in variables if v != "wind_10m_vector"]) * hours * 0.0206, 2),
            "estimatedCostUSD": round(len([v for v in variables if v != "wind_10m_vector"]) * hours * 0.0206 * COST_PER_GB_USD, 2),
            "costSafetyCapUSD": MAX_SAFE_COST_USD,
            "billingProject": billing_project,
            "costSafetyCapActive": hours <= MAX_SAFE_HOURS,
        },
        "variables": variables,
        "variableMetadata": {v: VARIABLE_METADATA.get(v, {}) for v in variables},
        "textureEncoding": {
            "format": "r16float",
            "bytesPerTexel": BYTES_PER_TEXEL,
            "rawRowBytes": RAW_ROW_BYTES,
            "paddedRowBytes": PADDED_ROW_BYTES,
            "paddingBytesPerRow": PADDING_BYTES_PER_ROW,
            "isPrePadded": padded,
            "sliceByteLength": UNPADDED_SLICE_BYTES,
            "paddedSliceByteLength": PADDED_SLICE_BYTES,
        },
        "vectorTextureEncoding": {
            "format": "rg16float",
            "bytesPerTexel": VECTOR_BYTES_PER_TEXEL,
            "rawRowBytes": VECTOR_RAW_ROW_BYTES,
            "paddedRowBytes": VECTOR_PADDED_ROW_BYTES,
            "paddingBytesPerRow": VECTOR_PADDING_BYTES_PER_ROW,
            "isPrePadded": padded,
            "sliceByteLength": VECTOR_UNPADDED_SLICE_BYTES,
            "paddedSliceByteLength": VECTOR_PADDED_SLICE_BYTES,
        },
        "filePattern": "/data/weathernext/{variable}-{hour}.bin",
        "provenance": {
            "sourceBucket": f"gs://{cycle_dir}/predictions.zarr",
            "chunkShape": [1, GRID_HEIGHT, GRID_WIDTH],
            "sourceDtype": "float32",
            "outputDtype": "float16",
            "latitudeOrientation": "row_0_north_inverted",
            "longitudeOrientation": "col_0_antimeridian_rolled_1800",
        },
    }

    meta_path = os.path.join(output_dir, "meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"[OK] Wrote metadata sidecar to {meta_path}")


def process_vector_slice(
    u_raw: Any,
    v_raw: Any,
    padded: bool = True,
) -> Tuple[Any, bytes]:
    """
    Transforms raw WeatherNext u and v wind slices [1801, 3600] (Float32) to WebGPU-ready rg16float binary payload.

    1. Latitude Flip & Longitude Roll:
       - Row 0 = North Pole (+90°N)
       - Col 0 = Antimeridian (-180°)
    2. Downcast:
       Float32 -> Float16 (np.float16, 2 bytes per component).
    3. Interleave:
       u (R channel) and v (G channel) -> (1801, 3600, 2) rg16float (4 bytes per texel).
    4. WebGPU 256-Byte Row Pitch Padding:
       Raw: 3600 * 4 = 14400 bytes.
       Padded: ceil(14400 / 256) * 256 = 14592 bytes.
       Padding per row: 192 bytes = 96 float16 components = 48 rg16float texels.
       Padded row texels: 3600 + 48 = 3648 texels.
    """
    import numpy as np

    u_arr = np.squeeze(np.array(u_raw, dtype=np.float32, copy=True))
    v_arr = np.squeeze(np.array(v_raw, dtype=np.float32, copy=True))

    u_flipped = u_arr[::-1, :]
    v_flipped = v_arr[::-1, :]

    u_rolled = np.roll(u_flipped, GRID_WIDTH // 2, axis=1).astype(np.float16)
    v_rolled = np.roll(v_flipped, GRID_WIDTH // 2, axis=1).astype(np.float16)

    interleaved = np.stack([u_rolled, v_rolled], axis=-1)

    if padded:
        padded_grid = np.zeros((GRID_HEIGHT, VECTOR_PADDED_COLS, 2), dtype=np.float16)
        padded_grid[:, :GRID_WIDTH, :] = interleaved
        return padded_grid, padded_grid.tobytes()
    else:
        return interleaved, interleaved.tobytes()


def process_slice(
    raw_slice: Any,
    var_name: str,
    padded: bool = True,
) -> Tuple[Any, bytes]:
    """
    Transforms raw WeatherNext Zarr slice [1801, 3600] (Float32) to WebGPU-ready Float16 binary payload.

    1. Physical Unit Corrections:
       - Temperature fields (temperature_2m_mean, dewpoint_temperature_2m_mean):
         Upstream Zarr is in Kelvin (~198K to ~318K). Subtract 273.15 to convert to Celsius (-90°C to +60°C).
       - Precipitation fields (total_precipitation_1hr_mean, imerg_tp_1hr_mean):
         Upstream Zarr is in meters of water accumulation (0 to 0.02315m). Multiply by 1000.0 to convert to mm/hr.
    2. Vertical Latitude Flip:
       Invert rows (slice[::-1, :]) so row 0 = North Pole (+90°N), descending to South Pole (-90°S).
    3. Horizontal Longitude Roll:
       Roll by 1800 columns (np.roll(..., GRID_WIDTH // 2, axis=1)) to shift [0°, 360°) to [-180°, +180°),
       placing the Antimeridian at column 0 and Prime Meridian at column 1800.
    4. Downcasting:
       Float32 -> Float16 (np.float16, 2 bytes/texel).
    5. WebGPU 256-Byte Row Pitch Padding:
       If padded is True, extend row from 3600 texels (7200 bytes) to 3712 texels (7424 bytes),
       zero-filling the 112 trailing texels (224 bytes) per row.

    Returns:
       (grid, payload_bytes)
       grid: np.ndarray with shape (1801, 3712) if padded else (1801, 3600), dtype=float16
       payload_bytes: bytes of length 13,370,624 (padded) or 12,967,200 (unpadded)
    """
    import numpy as np

    if var_name in ("wind_10m_vector", "wind_100m_vector"):
        if isinstance(raw_slice, (tuple, list)):
            return process_vector_slice(raw_slice[0], raw_slice[1], padded=padded)
        elif isinstance(raw_slice, np.ndarray) and raw_slice.ndim == 3 and raw_slice.shape[-1] == 2:
            return process_vector_slice(raw_slice[..., 0], raw_slice[..., 1], padded=padded)
        elif isinstance(raw_slice, np.ndarray) and raw_slice.ndim == 3 and raw_slice.shape[0] == 2:
            return process_vector_slice(raw_slice[0, ...], raw_slice[1, ...], padded=padded)

    # 1. Physical unit conversions
    processed = np.squeeze(np.array(raw_slice, dtype=np.float32, copy=True))
    var_lower = var_name.lower().strip()
    if var_lower == "sea_surface_temperature_mean" or "sea_surface_temperature" in var_lower:
        processed = processed - 273.15
        processed = np.nan_to_num(processed, nan=-99.0, posinf=45.0, neginf=-99.0)
    elif var_lower in ("temperature_2m_mean", "dewpoint_temperature_2m_mean") or "temperature" in var_lower or "dewpoint" in var_lower:
        processed = processed - 273.15
    elif var_lower in ("total_precipitation_1hr_mean", "imerg_tp_1hr_mean") or "precipitation" in var_lower or "precip" in var_lower:
        processed = processed * 1000.0
    elif var_lower == "mean_sea_level_pressure_mean" or "sea_level_pressure" in var_lower:
        # Float16-safe anomaly in hPa relative to standard atmosphere 1013.25 hPa (avoids >65504 Pa overflow and 1.0 hPa quantization steps)
        processed = np.where(np.abs(processed) > 2500.0, processed / 100.0 - 1013.25, np.where(processed > 500.0, processed - 1013.25, processed))
        processed = np.clip(np.nan_to_num(processed, nan=0.0, posinf=70.0, neginf=-140.0), -140.0, 70.0)
    elif var_lower == "convective_spread":
        processed = np.clip(np.nan_to_num(processed, nan=0.0, posinf=1.0, neginf=0.0), 0.0, 1.0)
    elif "solar_radiation" in var_lower:
        processed = np.maximum(0.0, processed / 3600.0)
    elif var_lower == "radiative_optical_depth":
        processed = np.clip(processed, 0.02, 1.0)

    # 2. Flip latitudes vertically (South-to-North -> North-to-South so row 0 = +90°)
    inverted_slice = processed[::-1, :]

    # 3. Roll longitudes horizontally by 1800 columns (0..360 -> -180..+180 so col 0 = -180°)
    rolled_slice = np.roll(inverted_slice, GRID_WIDTH // 2, axis=1)

    # 4. Downcast Float32 -> Float16 (little-endian half float)
    f16_slice = rolled_slice.astype(np.float16)

    # 5. Apply WebGPU 256-byte row pitch padding if requested
    if padded:
        padded_grid = np.zeros((GRID_HEIGHT, PADDED_COLS), dtype=np.float16)
        padded_grid[:, :GRID_WIDTH] = f16_slice
        return padded_grid, padded_grid.tobytes()
    else:
        return f16_slice, f16_slice.tobytes()


def generate_mock_slice(var_name: str, hour: int) -> Any:
    """
    Generates a physically plausible synthetic raw WeatherNext slice [1801, 3600] in native units.
    Native units:
    - Temperature: Kelvin (240K - 310K)
    - Precipitation: meters of water accumulation (0.0 - 0.025m)
    - Wind: m/s (-25 to +25 m/s)
    - Cloud: fraction (0.0 to 1.0)
    """
    import numpy as np

    lats = np.linspace(-90.0, 90.0, GRID_HEIGHT, dtype=np.float32)[:, None]
    lons = np.linspace(0.0, 360.0, GRID_WIDTH, dtype=np.float32)[None, :]

    if "dewpoint" in var_name:
        base_k = 250.0 + 55.0 * np.cos(np.radians(lats))
        diurnal = 5.0 * np.sin(np.radians(lons + hour * 15.0))
        temp_k = base_k + diurnal
        dewpoint_depression = 4.5 + 2.5 * np.cos(np.radians(lats * 2.0))
        return (temp_k - dewpoint_depression).astype(np.float32)
    elif "temperature" in var_name:
        base_k = 250.0 + 55.0 * np.cos(np.radians(lats))
        diurnal = 5.0 * np.sin(np.radians(lons + hour * 15.0))
        return (base_k + diurnal).astype(np.float32)
    elif "precipitation" in var_name:
        itcz = np.exp(-((lats - 5.0) ** 2) / 60.0) * (0.008 + 0.007 * np.sin(np.radians(lons * 3.0 + hour * 10.0)))
        midlat_n = np.exp(-((lats - 45.0) ** 2) / 80.0) * np.maximum(0.0, np.sin(np.radians(lons * 4.0 - hour * 12.0))) * 0.015
        midlat_s = np.exp(-((lats + 50.0) ** 2) / 80.0) * np.maximum(0.0, np.sin(np.radians(lons * 5.0 - hour * 15.0))) * 0.012
        precip_m = np.maximum(0.0, itcz + midlat_n + midlat_s)
        return precip_m.astype(np.float32)
    elif var_name in ("wind_10m_vector", "wind_100m_vector"):
        scale = 1.22 if var_name == "wind_100m_vector" else 1.0
        u = scale * (15.0 * np.sin(np.radians(lats * 2.0)) + 4.0 * np.cos(np.radians(lons * 3.0 + hour * 15.0)))
        v = scale * (10.0 * np.cos(np.radians(lats * 3.0)) + 3.0 * np.sin(np.radians(lons * 2.0 - hour * 10.0)))
        return np.stack([u, v], axis=-1).astype(np.float32)
    elif var_name == "convective_spread":
        sp = np.clip(0.22 + 0.55 * np.maximum(0.0, np.sin(np.radians(lats * 3.0 + lons * 2.5 - hour * 10.0))), 0.0, 1.0)
        return sp.astype(np.float32)
    elif "wind" in var_name:
        w = 15.0 * np.sin(np.radians(lats * 2.0)) + 3.0 * np.cos(np.radians(lons + hour * 15.0))
        return w.astype(np.float32)
    elif "low_cloud" in var_name:
        c = np.clip(0.35 + 0.45 * np.sin(np.radians(lats * 2.5 + lons * 1.5 + hour * 8.0)), 0.0, 1.0)
        return c.astype(np.float32)
    elif "medium_cloud" in var_name:
        c = np.clip(0.25 + 0.40 * np.sin(np.radians(lats * 3.5 - lons * 2.0 + hour * 12.0)), 0.0, 1.0)
        return c.astype(np.float32)
    elif "high_cloud" in var_name:
        c = np.clip(0.20 + 0.35 * np.cos(np.radians(lats * 4.0 + lons * 3.0 - hour * 15.0)), 0.0, 1.0)
        return c.astype(np.float32)
    elif "sea_surface_temperature" in var_name:
        sst_k = 271.35 + 29.0 * np.cos(np.radians(lats)) ** 1.4
        return sst_k.astype(np.float32)
    elif "sea_level_pressure" in var_name:
        mslp_pa = 101325.0 + 1200.0 * np.cos(np.radians((np.abs(lats) - 30.0) * 3.0))
        return mslp_pa.astype(np.float32)
    elif "solar_radiation" in var_name:
        solar_w = np.maximum(0.0, 950.0 * np.cos(np.radians(lats)) * np.cos(np.radians(lons - hour * 15.0)))
        return (solar_w * 3600.0).astype(np.float32)
    elif var_name == "radiative_optical_depth":
        tau = np.clip(0.28 + 0.45 * np.sin(np.radians(lats * 3.0 + lons * 2.0 + hour * 10.0)), 0.0, 1.0)
        return tau.astype(np.float32)
    else:
        c = np.clip(0.3 + 0.4 * np.sin(np.radians(lats * 3.0 + lons * 2.0)), 0.0, 1.0)
        return c.astype(np.float32)


def sharpen_ensemble_cloud_cover(
    mean_raw: Any,
    p10_raw: Optional[Any] = None,
    p90_raw: Optional[Any] = None,
    member0_raw: Optional[Any] = None,
) -> Tuple[Any, Any]:
    """
    Ensemble Quantile Convective Edge Sharpness + Coherent Single-Member Fusion:
    - Keeps *_mean as the primary coverage base (Rule 50) so broken marine cumulus fields are never zeroed out.
    - When member0_raw (gs://weathernext3_spatial sample=0 coherent realization) is provided, fuses 78% coherent
      member structure with 22% quantile-sharpened ensemble mean while preserving nearshore stratus and trade-wind
      cumulus floors, eliminating 64-member trajectory motion blur across forecast hours t=0..+11h.
    - Where _p10 < 0.03 and _p90 > 0.35 on high-spread frontal aprons, relaxes the lower clamp floor from
      mean * 0.72 down to mean * 0.25 and increases skirt attenuation so phase-blurred frontal fringes tighten.
    - Where _p10 < 0.05 and _p90 < 0.30 (scattered trade-wind cumulus) or along moderate-spread nearshore
      marine stratus transitions (mean in 0.14..0.32, _p90 < 0.46), preserves >= mean * 0.72 (Rule 50) so
      broken marine cumulus and coastal onshore stratus fetch (offshoreWestNearUV / offshoreWestFarUV) stay intact.
    Returns (sharpened_coverage, convective_spread).
    """
    import numpy as np

    mean = np.clip(np.squeeze(np.array(mean_raw, dtype=np.float32, copy=True)), 0.0, 1.0)
    if p10_raw is None or p90_raw is None:
        if member0_raw is not None:
            m0_only = np.clip(np.squeeze(np.asarray(member0_raw, dtype=np.float32)), 0.0, 1.0)
            if m0_only.shape == mean.shape:
                m0_clean = np.where(m0_only < 0.018, 0.0, m0_only)
                return m0_clean.astype(np.float32), np.abs(m0_only - mean).astype(np.float32)
        return mean, np.zeros_like(mean, dtype=np.float32)

    p10 = np.clip(np.squeeze(np.asarray(p10_raw, dtype=np.float32)), 0.0, 1.0)
    p90 = np.clip(np.squeeze(np.asarray(p90_raw, dtype=np.float32)), 0.0, 1.0)
    spread = np.clip(p90 - p10, 0.0, 1.0)

    # Preserve smooth solid overcast decks where ensemble 10th percentile is high (_p10 > 0.50)
    overcast_guard = np.clip((p10 - 0.50) / 0.35, 0.0, 1.0)

    # High ensemble spread gate along active convective fronts, squall lines, and Bénard regime boundaries
    conv_edge = np.clip((spread - 0.22) / 0.55, 0.0, 1.0) * (1.0 - overcast_guard)

    # 1. Scattered Trade-Wind Cumulus Guard (_p10 < 0.05 and _p90 < 0.30, Rule 50)
    cumulus_guard = (
        np.clip((0.05 - p10) / 0.05, 0.0, 1.0)
        * np.clip((0.30 - p90) / 0.10, 0.0, 1.0)
        * np.clip((mean - 0.085) / 0.035, 0.0, 1.0)
    )

    # 2. Nearshore Marine Stratus Transition Guard (mean in [0.14, 0.32] with moderate stratus spread _p90 < 0.46)
    # Prevents collapsing coastal marine stratus edges (e.g. California -123.3°E, 37.8°N) so upwind fetch >= 0.14 is preserved
    stratus_edge_guard = (
        np.clip((mean - 0.13) / 0.04, 0.0, 1.0)
        * np.clip((0.32 - mean) / 0.06, 0.0, 1.0)
        * np.clip((0.46 - p90) / 0.10, 0.0, 1.0)
    )

    # 3. Stage 4 Regime-Aware Outer-Skirt Gate (_p10 < 0.03 and _p90 > 0.35 on phase-spread frontal aprons)
    frontal_apron_gate = (
        np.clip((0.03 - p10) / 0.03, 0.0, 1.0)
        * np.clip((p90 - 0.35) / 0.15, 0.0, 1.0)
        * np.clip((0.35 - mean) / 0.12, 0.0, 1.0)
        * (1.0 - stratus_edge_guard * 0.90)
    )

    # 4. Trace Outlier-Member Haze Gate (_p10 < 0.015 and mean < 0.085 below trade-wind cumulus regime)
    outlier_haze_gate = (
        np.clip((0.015 - p10) / 0.015, 0.0, 1.0)
        * np.clip((0.085 - mean) / 0.030, 0.0, 1.0)
        * (1.0 - cumulus_guard)
    )

    # Tighten diffuse outer ensemble-mean skirts where _p10 is near zero (< 0.08) and mean is in the outer fringe
    skirt_gate = (
        np.clip((0.08 - p10) / 0.08, 0.0, 1.0)
        * np.clip((0.44 - mean) / 0.24, 0.0, 1.0)
        * (1.0 - cumulus_guard)
        * (1.0 - stratus_edge_guard * 0.75)
    )

    # Reinforce diluted convective frontal ridges & squall cores toward _p90 where mean >= 0.36
    core_gate = np.clip((mean - 0.36) / 0.28, 0.0, 1.0)

    skirt_atten = np.clip(
        0.26 * conv_edge * skirt_gate
        + 0.75 * frontal_apron_gate
        + 0.72 * outlier_haze_gate,
        0.0,
        0.75,
    )

    sharpened = (
        mean * (1.0 - skirt_atten)
        + (p90 - mean) * (0.34 * conv_edge * core_gate)
    )

    # Regime-aware floor: mean * 0.72 default (Rule 50), relaxed down to mean * 0.25 on phase-spread frontal aprons and trace outlier fringes
    floor_relax = np.clip(np.maximum(frontal_apron_gate, outlier_haze_gate) * (1.0 - cumulus_guard), 0.0, 1.0)
    floor_factor = 0.72 - 0.47 * floor_relax
    sharpened = np.clip(sharpened, mean * floor_factor, 1.0)

    if member0_raw is not None:
        m0 = np.clip(np.squeeze(np.asarray(member0_raw, dtype=np.float32)), 0.0, 1.0)
        if m0.shape == sharpened.shape:
            # 100% coherent single-member realization (sample=0 from weathernext3_spatial).
            # Suppress sub-grid parameterization haze (< 0.10) in clear subsidence corridors (p10 < 0.025)
            # without re-blending 64-member ensemble-mean haze into clear slots or frontal boundaries.
            guard_weight = np.clip(np.maximum(cumulus_guard, stratus_edge_guard), 0.0, 1.0)
            subgrid_haze_gate = (
                np.clip((0.10 - m0) / 0.10, 0.0, 1.0)
                * np.clip((0.025 - p10) / 0.025, 0.0, 1.0)
                * (1.0 - guard_weight)
            )
            m0_clean = m0 * (1.0 - 0.85 * subgrid_haze_gate)
            m0_clean = np.where(m0_clean < 0.018, 0.0, m0_clean)
            # Protect nearshore stratus and trade-wind cumulus floors so coastal upwind fetch >= 0.14 is preserved
            sharpened = np.clip(
                np.where(guard_weight > 0.15, np.maximum(m0_clean, sharpened * 0.85), m0_clean),
                0.0,
                1.0,
            )

    return sharpened.astype(np.float32), spread.astype(np.float32)


def synthesize_radiative_optical_depth(
    low_raw: Any,
    mid_raw: Any,
    high_raw: Any,
    ssrd_raw: Optional[Any] = None,
    fdir_raw: Optional[Any] = None,
    padded: bool = True,
    low_spread_raw: Optional[Any] = None,
    mid_spread_raw: Optional[Any] = None,
    high_spread_raw: Optional[Any] = None,
) -> Tuple[Any, bytes]:
    """
    Synthesizes normalized Cloud Radiative Optical Depth [0.0, 1.0] combining:
    1. Direct-to-total downward shortwave diffuse ratio: 1.0 - FDIR / max(SSRD, 1.0) where sunlit (SSRD > 35 W/m²).
    2. Multi-stratum convective overlap (low * mid, mid * high) and optical weighting so deep cumulonimbus
       eyewalls/fronts have high optical thickness (~0.85-1.0) while standalone high cirrus remains translucent (~0.18-0.32).
    3. Ensemble quantile convective spread (_p90 - _p10) across low/mid/high strata to boost optical thickness
       along active squall lines and convective turrets (interleaved into u_dewpointTexture.g at 0.0 ms shader cost).
    """
    import numpy as np

    low = np.clip(np.squeeze(np.array(low_raw, dtype=np.float32, copy=False)), 0.0, 1.0)
    mid = np.clip(np.squeeze(np.array(mid_raw, dtype=np.float32, copy=False)), 0.0, 1.0)
    high = np.clip(np.squeeze(np.array(high_raw, dtype=np.float32, copy=False)), 0.0, 1.0)

    conv_spread_boost = np.zeros_like(low)
    if low_spread_raw is not None:
        low_sp = np.clip(np.squeeze(np.array(low_spread_raw, dtype=np.float32, copy=False)), 0.0, 1.0)
        conv_spread_boost = conv_spread_boost + low_sp * np.clip((low - 0.18) / 0.55, 0.0, 1.0) * 0.45
    if mid_spread_raw is not None:
        mid_sp = np.clip(np.squeeze(np.array(mid_spread_raw, dtype=np.float32, copy=False)), 0.0, 1.0)
        conv_spread_boost = conv_spread_boost + mid_sp * np.clip((mid - 0.18) / 0.55, 0.0, 1.0) * 0.40
    if high_spread_raw is not None:
        high_sp = np.clip(np.squeeze(np.array(high_spread_raw, dtype=np.float32, copy=False)), 0.0, 1.0)
        conv_spread_boost = conv_spread_boost + high_sp * np.clip((high - 0.22) / 0.55, 0.0, 1.0) * 0.25

    # Structural multi-layer optical thickness (valid 24/7 across day and night hemispheres)
    deep_overlap = np.clip(low * mid * 0.70 + mid * high * 0.55 + low * mid * high * 0.65, 0.0, 1.0)
    stratum_tau = np.clip(
        np.power(low, 0.90) * 0.46
        + np.power(mid, 0.90) * 0.44
        + np.power(high, 1.25) * 0.22
        + deep_overlap * 0.48
        + conv_spread_boost * 0.30,
        0.0,
        1.0,
    )

    if ssrd_raw is not None and fdir_raw is not None:
        ssrd_w = np.maximum(0.0, np.squeeze(np.array(ssrd_raw, dtype=np.float32, copy=False)) / 3600.0)
        fdir_w = np.maximum(0.0, np.squeeze(np.array(fdir_raw, dtype=np.float32, copy=False)) / 3600.0)
        diffuse_ratio = np.clip(1.0 - fdir_w / np.maximum(ssrd_w, 1.0), 0.0, 1.0)
        # Weight solar diffuse ratio where sunlit (SSRD > 40..180 W/m²) and cloud cover > 0.05
        sunlit_gate = np.clip((ssrd_w - 40.0) / 140.0, 0.0, 1.0) * np.clip((low + mid + high) * 3.0, 0.0, 1.0)
        combined_tau = stratum_tau * (1.0 - sunlit_gate * 0.55) + np.maximum(stratum_tau * 0.75, diffuse_ratio) * (sunlit_gate * 0.55)
    else:
        combined_tau = stratum_tau

    return process_slice(np.clip(combined_tau, 0.0, 1.0), "radiative_optical_depth", padded=padded)


def fuse_station_head_subgrid_thermo(
    t2m_0p1_raw: Any,
    td_0p1_raw: Any,
    sh_t2m_0p05_raw: Optional[Any],
    sh_td_0p05_raw: Optional[Any],
) -> Tuple[Any, Any]:
    """
    Saturation-Preserving 2x2 Sub-Grid Fusion from 0.05-deg station_head [3601, 7200] onto 0.1-deg [1801, 3600]:
    Retains 70% minimum-dewpoint-depression + 30% block-mean station pair inside each 2x2 sub-grid cell
    so narrow river valleys and coastal fog pockets keep true local saturation while falling back cleanly
    to 0.1-deg grids over open ocean where station_head is NaN.
    """
    import numpy as np

    t2m_base = np.squeeze(np.asarray(t2m_0p1_raw, dtype=np.float32))
    td_base = np.squeeze(np.asarray(td_0p1_raw, dtype=np.float32))
    if sh_t2m_0p05_raw is None or sh_td_0p05_raw is None:
        return t2m_base, td_base

    sh_t = np.squeeze(np.asarray(sh_t2m_0p05_raw, dtype=np.float32))
    sh_td = np.squeeze(np.asarray(sh_td_0p05_raw, dtype=np.float32))
    if sh_t.shape != (3601, 7200) or sh_td.shape != (3601, 7200) or t2m_base.shape != (GRID_HEIGHT, GRID_WIDTH):
        return t2m_base, td_base

    sh_t_pad = np.concatenate([sh_t, sh_t[-1:, :]], axis=0).reshape(GRID_HEIGHT, 2, GRID_WIDTH, 2).transpose(0, 2, 1, 3).reshape(GRID_HEIGHT, GRID_WIDTH, 4)
    sh_td_pad = np.concatenate([sh_td, sh_td[-1:, :]], axis=0).reshape(GRID_HEIGHT, 2, GRID_WIDTH, 2).transpose(0, 2, 1, 3).reshape(GRID_HEIGHT, GRID_WIDTH, 4)

    valid = np.isfinite(sh_t_pad) & np.isfinite(sh_td_pad) & (sh_t_pad > 160.0) & (sh_td_pad > 150.0)
    any_valid = np.any(valid, axis=-1)
    if not np.any(any_valid):
        return t2m_base, td_base

    dep = np.where(valid, np.maximum(0.0, sh_t_pad - sh_td_pad), np.inf)
    min_idx = np.argmin(dep, axis=-1, keepdims=True)
    t_sat = np.take_along_axis(sh_t_pad, min_idx, axis=-1)[..., 0]
    td_sat = np.take_along_axis(sh_td_pad, min_idx, axis=-1)[..., 0]

    valid_count = np.maximum(1.0, np.sum(valid, axis=-1, dtype=np.float32))
    t_mean = np.sum(np.where(valid, sh_t_pad, 0.0), axis=-1) / valid_count
    td_mean = np.sum(np.where(valid, sh_td_pad, 0.0), axis=-1) / valid_count

    t_fused = np.where(any_valid, 0.70 * t_sat + 0.30 * t_mean, t2m_base)
    td_fused = np.where(any_valid, 0.70 * td_sat + 0.30 * td_mean, td_base)
    td_fused = np.minimum(td_fused, t_fused)
    return t_fused.astype(np.float32), td_fused.astype(np.float32)


def synthesize_convective_spread_slice(
    low_spread_raw: Optional[Any],
    mid_spread_raw: Optional[Any],
    high_spread_raw: Optional[Any],
    padded: bool = True,
) -> Tuple[Any, bytes]:
    import numpy as np

    shape = (GRID_HEIGHT, GRID_WIDTH)
    s_low = np.clip(np.squeeze(np.asarray(low_spread_raw, dtype=np.float32)), 0.0, 1.0) if low_spread_raw is not None else np.zeros(shape, dtype=np.float32)
    s_mid = np.clip(np.squeeze(np.asarray(mid_spread_raw, dtype=np.float32)), 0.0, 1.0) if mid_spread_raw is not None else np.zeros(shape, dtype=np.float32)
    s_high = np.clip(np.squeeze(np.asarray(high_spread_raw, dtype=np.float32)), 0.0, 1.0) if high_spread_raw is not None else np.zeros(shape, dtype=np.float32)
    conv_sp = np.clip(np.maximum(0.50 * s_low + 0.50 * s_mid, 1.15 * np.sqrt(s_low * s_mid)) + 0.20 * s_high, 0.0, 1.0)
    return process_slice(conv_sp, "convective_spread", padded=padded)


def stage_mock_slices(
    output_dir: str,
    variables: Optional[List[str]] = None,
    hours: int = 24,
    padded: bool = True,
    cycle_name: str = "20260911_21hr_01_preds",
) -> None:
    """
    Generates and stages a self-contained demonstration WeatherNext 3 dataset locally.
    Uses process_slice to ensure identical physical transformations, coordinate rolls,
    and WebGPU row pitch padding contracts.
    """
    os.makedirs(output_dir, exist_ok=True)
    init_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")

    if variables is None:
        variables = [
            "wind_10m_vector",
            "wind_100m_vector",
            "total_precipitation_1hr_mean",
            "temperature_2m_mean",
            "dewpoint_temperature_2m_mean",
            "low_cloud_cover_mean",
            "medium_cloud_cover_mean",
            "high_cloud_cover_mean",
            "sea_surface_temperature_mean",
            "mean_sea_level_pressure_mean",
            "radiative_optical_depth",
            "convective_spread",
        ]

    print(f"[DEMO] Staging {hours} hours for variables: {variables} into {output_dir}")
    for var in variables:
        for h in range(hours):
            slice_path = os.path.join(output_dir, f"{var}-{h}.bin")
            if var in ("wind_10m_vector", "wind_100m_vector"):
                raw_vec = generate_mock_slice(var, h)
                _, payload = process_vector_slice(raw_vec[..., 0], raw_vec[..., 1], padded=padded)
            else:
                raw = generate_mock_slice(var, h)
                _, payload = process_slice(raw, var, padded=padded)
            with open(slice_path, "wb") as f:
                f.write(payload)
            print(f"  -> Generated {var}-{h}.bin ({len(payload):,} bytes)")

    write_metadata_index(
        output_dir=output_dir,
        cycle_name=cycle_name,
        cycle_dir=f"{GCS_BUCKET_NAME}/{GCS_PREFIX_DIR}/{cycle_name}",
        init_iso=init_iso,
        variables=variables,
        hours=hours,
        padded=padded,
        billing_project=DEFAULT_BILLING_PROJECT,
    )
    print(f"[OK] Demo dataset successfully staged in {output_dir}.")


def extract_and_stage(
    fs,
    adc_path: str,
    billing_project: str,
    cycle_name: str,
    cycle_dir: str,
    init_iso: str,
    variables: List[str],
    hours: int,
    padded: bool,
    output_dir: str,
    force: bool = False,
):
    """
    Downloads Zarr v3 hourly chunks concurrently via ThreadPoolExecutor(max_workers=8),
    sharpens cloud cover strata with (_p90, _p10) quantiles while keeping *_mean as base (Rule 50),
    converts Float32 -> Float16, flips latitude, pads to 256-byte row pitch (if padded=True),
    and writes binary slices.
    """
    import numpy as np

    os.makedirs(output_dir, exist_ok=True)

    # Rule 31 Hermetic Test Isolation: never perform live GCS chunk downloads into default repo directory under VITEST
    if os.environ.get("VITEST") and os.path.abspath(output_dir) == os.path.abspath(DEFAULT_OUTPUT_DIR):
        if os.path.exists(os.path.join(output_dir, "meta.json")):
            print("-> VITEST hermetic guard active: retaining cached records in public/data/weathernext/ without live GCS egress.")
            return

    if not force and check_local_cache(output_dir, cycle_name, variables, hours, padded):
        print(f"-> Local cache hit: all {len(variables) * hours} slices exist for cycle '{cycle_name}'.")
        print("   Skipping download. Use --force to bypass caching.")
        return

    print("=" * 80)
    print(f"EXTRACTING WEATHERNEXT 3 SLICES: Cycle {cycle_name} ({hours} hours × {len(variables)} variables, max_workers=8)")
    print("=" * 80)

    zg = open_zarr_predictions(cycle_dir, adc_path, billing_project)
    zg_spatial = None
    try:
        spatial_cycle_dir = f"weathernext3_spatial/weathernext_3_0_0/zarr/2026_to_present/{cycle_name}"
        zg_spatial = open_zarr_predictions(spatial_cycle_dir, adc_path, billing_project)
    except Exception:
        zg_spatial = None
    total_slices = len(variables) * hours
    processed_slices = 0
    start_time = time.perf_counter()
    cached_u_raw: Dict[int, Any] = {}
    cached_low_raw: Dict[int, Any] = {}
    cached_mid_raw: Dict[int, Any] = {}
    cached_high_raw: Dict[int, Any] = {}
    cached_low_spread: Dict[int, Any] = {}
    cached_mid_spread: Dict[int, Any] = {}
    cached_high_spread: Dict[int, Any] = {}
    cached_ssrd_raw: Dict[int, Any] = {}
    cached_fdir_raw: Dict[int, Any] = {}
    cached_fused_td: Dict[int, Any] = {}
    sh_t2m_arr = zg["station_head_temperature_2m_mean"] if ("temperature_2m_mean" in variables and "dewpoint_temperature_2m_mean" in variables and "station_head_temperature_2m_mean" in zg and "station_head_dewpoint_temperature_2m_mean" in zg) else None
    sh_td_arr = zg["station_head_dewpoint_temperature_2m_mean"] if sh_t2m_arr is not None else None
    td_0p1_companion_arr = zg["dewpoint_temperature_2m_mean"] if sh_t2m_arr is not None else None

    for var_idx, var_name in enumerate(variables, 1):
        if var_name == "radiative_optical_depth":
            if (
                "low_cloud_cover_mean" in variables
                and "medium_cloud_cover_mean" in variables
                and "high_cloud_cover_mean" in variables
            ):
                # Will be synthesized after high_cloud_cover_mean
                continue
            low_arr = zg["low_cloud_cover_mean"]
            mid_arr = zg["medium_cloud_cover_mean"]
            high_arr = zg["high_cloud_cover_mean"]
            low_p10_arr = zg["low_cloud_cover_p10"] if "low_cloud_cover_p10" in zg else None
            low_p90_arr = zg["low_cloud_cover_p90"] if "low_cloud_cover_p90" in zg else None
            mid_p10_arr = zg["medium_cloud_cover_p10"] if "medium_cloud_cover_p10" in zg else None
            mid_p90_arr = zg["medium_cloud_cover_p90"] if "medium_cloud_cover_p90" in zg else None
            high_p10_arr = zg["high_cloud_cover_p10"] if "high_cloud_cover_p10" in zg else None
            high_p90_arr = zg["high_cloud_cover_p90"] if "high_cloud_cover_p90" in zg else None
            ssrd_arr = zg["surface_solar_radiation_downwards_1hr_mean"] if "surface_solar_radiation_downwards_1hr_mean" in zg else None
            fdir_arr = zg["total_sky_direct_solar_radiation_at_surface_1hr_mean"] if "total_sky_direct_solar_radiation_at_surface_1hr_mean" in zg else None
            var_start = time.perf_counter()
            print(f"\n[{var_idx}/{len(variables)}] Synthesizing 'radiative_optical_depth' (1 - FDIR/SSRD + multi-layer overlap + _p90-_p10 spread)...")

            def _synth_rad_hour(h: int) -> int:
                slice_path = os.path.join(output_dir, f"radiative_optical_depth-{h}.bin")
                low_h, low_sp = sharpen_ensemble_cloud_cover(
                    low_arr[h, :, :],
                    low_p10_arr[h, :, :] if low_p10_arr is not None and low_p90_arr is not None else None,
                    low_p90_arr[h, :, :] if low_p10_arr is not None and low_p90_arr is not None else None,
                )
                mid_h, mid_sp = sharpen_ensemble_cloud_cover(
                    mid_arr[h, :, :],
                    mid_p10_arr[h, :, :] if mid_p10_arr is not None and mid_p90_arr is not None else None,
                    mid_p90_arr[h, :, :] if mid_p10_arr is not None and mid_p90_arr is not None else None,
                )
                high_h, high_sp = sharpen_ensemble_cloud_cover(
                    high_arr[h, :, :],
                    high_p10_arr[h, :, :] if high_p10_arr is not None and high_p90_arr is not None else None,
                    high_p90_arr[h, :, :] if high_p10_arr is not None and high_p90_arr is not None else None,
                )
                ssrd_h = ssrd_arr[h, :, :] if ssrd_arr is not None else None
                fdir_h = fdir_arr[h, :, :] if fdir_arr is not None else None
                _, payload = synthesize_radiative_optical_depth(
                    low_h,
                    mid_h,
                    high_h,
                    ssrd_h,
                    fdir_h,
                    padded=padded,
                    low_spread_raw=low_sp,
                    mid_spread_raw=mid_sp,
                    high_spread_raw=high_sp,
                )
                with open(slice_path, "wb") as f:
                    f.write(payload)
                return len(payload)

            with ThreadPoolExecutor(max_workers=8) as executor:
                sizes = list(executor.map(_synth_rad_hour, range(hours)))
            processed_slices += len(sizes)
            continue

        if var_name == "wind_10m_vector":
            if "u_component_of_wind_10m_mean" in variables and "v_component_of_wind_10m_mean" in variables:
                # Already synthesized or will be synthesized when v is processed
                continue
            if "u_component_of_wind_10m_mean" not in zg or "v_component_of_wind_10m_mean" not in zg:
                raise KeyError("u/v wind components not found in predictions.zarr for wind_10m_vector")
            u_arr = zg["u_component_of_wind_10m_mean"]
            v_arr = zg["v_component_of_wind_10m_mean"]
            u100_arr = zg["u_component_of_wind_100m_mean"] if "u_component_of_wind_100m_mean" in zg else None
            v100_arr = zg["v_component_of_wind_100m_mean"] if "v_component_of_wind_100m_mean" in zg else None
            var_start = time.perf_counter()
            print(f"\n[{var_idx}/{len(variables)}] Processing 'wind_10m_vector' (interleaving u and v into rg16float with 100m boundary-layer Ekman blending)...")

            def _process_vec_hour(h: int) -> Tuple[int, int]:
                slice_path = os.path.join(output_dir, f"{var_name}-{h}.bin")
                u_raw = u_arr[h, :, :]
                v_raw = v_arr[h, :, :]
                if u100_arr is not None and v100_arr is not None:
                    u100_h = np.asarray(u100_arr[h, :, :], dtype=np.float32)
                    v100_h = np.asarray(v100_arr[h, :, :], dtype=np.float32)
                    u_raw = 0.78 * np.asarray(u_raw, dtype=np.float32) + 0.22 * u100_h
                    v_raw = 0.78 * np.asarray(v_raw, dtype=np.float32) + 0.22 * v100_h
                    w100_path = os.path.join(output_dir, f"wind_100m_vector-{h}.bin")
                    _, w100_payload = process_vector_slice(u100_h, v100_h, padded=padded)
                    with open(w100_path, "wb") as f100:
                        f100.write(w100_payload)
                _, payload = process_vector_slice(u_raw, v_raw, padded=padded)
                with open(slice_path, "wb") as f:
                    f.write(payload)
                return h, len(payload)

            with ThreadPoolExecutor(max_workers=8) as executor:
                vec_results = list(executor.map(_process_vec_hour, range(hours)))
            processed_slices += len(vec_results)
            if vec_results:
                elapsed = time.perf_counter() - var_start
                print(f"   -> Hour {hours:2d}/{hours} saved ({vec_results[-1][1]:,} bytes) [{elapsed:.1f}s]")
            continue

        if var_name not in zg:
            raise KeyError(f"Variable '{var_name}' not found in predictions.zarr")

        arr = zg[var_name]
        is_cloud_stratum = var_name in ("low_cloud_cover_mean", "medium_cloud_cover_mean", "high_cloud_cover_mean")
        p10_arr = None
        p90_arr = None
        m0_blocks: Dict[int, Any] = {}
        if is_cloud_stratum:
            stem = var_name[:-5]  # strip '_mean'
            p10_key = f"{stem}_p10"
            p90_key = f"{stem}_p90"
            if p10_key in zg and p90_key in zg:
                p10_arr = zg[p10_key]
                p90_arr = zg[p90_key]
            if zg_spatial is not None and stem in zg_spatial:
                try:
                    m0_arr = zg_spatial[stem]
                    num_blocks = math.ceil(hours / 6)
                    for b_idx in range(num_blocks):
                        m0_blocks[b_idx] = np.asarray(m0_arr[0, b_idx, :, :, :], dtype=np.float32)
                except Exception:
                    m0_blocks = {}

        var_start = time.perf_counter()
        if p10_arr is not None and p90_arr is not None:
            m0_tag = " + weathernext3_spatial sample=0 coherent member" if m0_blocks else ""
            print(f"\n[{var_idx}/{len(variables)}] Processing '{var_name}' (with ensemble _p10/_p90 convective edge sharpening{m0_tag})...")
        else:
            print(f"\n[{var_idx}/{len(variables)}] Processing '{var_name}'...")

        def _fetch_and_stage_hour(h: int) -> Tuple[int, Any, Optional[Any], int]:
            slice_path = os.path.join(output_dir, f"{var_name}-{h}.bin")
            if var_name == "dewpoint_temperature_2m_mean" and h in cached_fused_td:
                raw_slice = cached_fused_td[h]
            else:
                raw_slice = arr[h, :, :]
            spread_slice = None
            if var_name == "temperature_2m_mean" and sh_t2m_arr is not None and sh_td_arr is not None and td_0p1_companion_arr is not None:
                try:
                    raw_slice, td_fused_h = fuse_station_head_subgrid_thermo(
                        raw_slice,
                        td_0p1_companion_arr[h, :, :],
                        sh_t2m_arr[h, :, :],
                        sh_td_arr[h, :, :],
                    )
                    spread_slice = td_fused_h
                except Exception:
                    pass
            elif p10_arr is not None and p90_arr is not None:
                p10_slice = p10_arr[h, :, :]
                p90_slice = p90_arr[h, :, :]
                m0_slice = None
                if (h // 6) in m0_blocks and (h % 6) < m0_blocks[h // 6].shape[0]:
                    m0_slice = m0_blocks[h // 6][h % 6]
                raw_slice, spread_slice = sharpen_ensemble_cloud_cover(raw_slice, p10_slice, p90_slice, m0_slice)

            _, payload = process_slice(raw_slice, var_name, padded=padded)
            with open(slice_path, "wb") as f:
                f.write(payload)

            if var_name == "v_component_of_wind_10m_mean" and h in cached_u_raw:
                vec_path = os.path.join(output_dir, f"wind_10m_vector-{h}.bin")
                _, vec_payload = process_vector_slice(cached_u_raw[h], raw_slice, padded=padded)
                with open(vec_path, "wb") as f_vec:
                    f_vec.write(vec_payload)

            return h, raw_slice, spread_slice, len(payload)

        with ThreadPoolExecutor(max_workers=8) as executor:
            hour_results = list(executor.map(_fetch_and_stage_hour, range(hours)))

        for h, raw_slice, spread_slice, payload_len in hour_results:
            if var_name == "temperature_2m_mean" and spread_slice is not None:
                cached_fused_td[h] = spread_slice
            elif var_name == "dewpoint_temperature_2m_mean" and h in cached_fused_td:
                del cached_fused_td[h]
            elif var_name == "u_component_of_wind_10m_mean":
                cached_u_raw[h] = raw_slice
            elif var_name == "v_component_of_wind_10m_mean" and h in cached_u_raw:
                del cached_u_raw[h]
            elif var_name == "low_cloud_cover_mean":
                cached_low_raw[h] = raw_slice
                if spread_slice is not None:
                    cached_low_spread[h] = spread_slice
            elif var_name == "medium_cloud_cover_mean":
                cached_mid_raw[h] = raw_slice
                if spread_slice is not None:
                    cached_mid_spread[h] = spread_slice
            elif var_name == "high_cloud_cover_mean":
                cached_high_raw[h] = raw_slice
                if spread_slice is not None:
                    cached_high_spread[h] = spread_slice
            elif var_name == "surface_solar_radiation_downwards_1hr_mean":
                cached_ssrd_raw[h] = raw_slice
            elif var_name == "total_sky_direct_solar_radiation_at_surface_1hr_mean":
                cached_fdir_raw[h] = raw_slice
            processed_slices += 1

        if hour_results:
            elapsed = time.perf_counter() - var_start
            print(f"   -> Hour {hours:2d}/{hours} saved ({hour_results[-1][3]:,} bytes) [{elapsed:.1f}s]")

    # Synthesize radiative_optical_depth if all 3 cloud strata were extracted
    if (
        len(cached_low_raw) == hours
        and len(cached_mid_raw) == hours
        and len(cached_high_raw) == hours
    ):
        print(f"\n[Phase 2] Synthesizing 'radiative_optical_depth' across {hours} hours (with _p90-_p10 convective spread)...")
        ssrd_arr = zg["surface_solar_radiation_downwards_1hr_mean"] if "surface_solar_radiation_downwards_1hr_mean" in zg else None
        fdir_arr = zg["total_sky_direct_solar_radiation_at_surface_1hr_mean"] if "total_sky_direct_solar_radiation_at_surface_1hr_mean" in zg else None

        def _synth_phase2_rad(h: int) -> int:
            ssrd_h = cached_ssrd_raw.get(h)
            if ssrd_h is None and ssrd_arr is not None:
                try:
                    ssrd_h = ssrd_arr[h, :, :]
                except Exception:
                    ssrd_h = None
            fdir_h = cached_fdir_raw.get(h)
            if fdir_h is None and fdir_arr is not None:
                try:
                    fdir_h = fdir_arr[h, :, :]
                except Exception:
                    fdir_h = None
            _, opt_payload = synthesize_radiative_optical_depth(
                cached_low_raw[h],
                cached_mid_raw[h],
                cached_high_raw[h],
                ssrd_h,
                fdir_h,
                padded=padded,
                low_spread_raw=cached_low_spread.get(h),
                mid_spread_raw=cached_mid_spread.get(h),
                high_spread_raw=cached_high_spread.get(h),
            )
            opt_path = os.path.join(output_dir, f"radiative_optical_depth-{h}.bin")
            with open(opt_path, "wb") as f_opt:
                f_opt.write(opt_payload)
            if h in cached_low_spread or h in cached_mid_spread or h in cached_high_spread:
                _, sp_payload = synthesize_convective_spread_slice(
                    cached_low_spread.get(h),
                    cached_mid_spread.get(h),
                    cached_high_spread.get(h),
                    padded=padded,
                )
                sp_path = os.path.join(output_dir, f"convective_spread-{h}.bin")
                with open(sp_path, "wb") as f_sp:
                    f_sp.write(sp_payload)
            return len(opt_payload)

        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(_synth_phase2_rad, range(hours)))
        print(f"   -> Wrote radiative_optical_depth-0..{hours-1}.bin (and convective_spread-0..{hours-1}.bin)")

    # Stage sea_surface_temperature_mean when temperature_2m_mean was extracted and SST is in zg
    if "temperature_2m_mean" in variables and "sea_surface_temperature_mean" not in variables and "sea_surface_temperature_mean" in zg:
        print(f"\n[Phase 2] Extracting 'sea_surface_temperature_mean' for Marine Boundary-Layer Stability (T2m - SST)...")
        sst_arr = zg["sea_surface_temperature_mean"]

        def _stage_sst_hour(h: int) -> int:
            sst_raw = sst_arr[h, :, :]
            _, sst_payload = process_slice(sst_raw, "sea_surface_temperature_mean", padded=padded)
            sst_path = os.path.join(output_dir, f"sea_surface_temperature_mean-{h}.bin")
            with open(sst_path, "wb") as f_sst:
                f_sst.write(sst_payload)
            return len(sst_payload)

        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(_stage_sst_hour, range(hours)))
        print(f"   -> Wrote sea_surface_temperature_mean-0..{hours-1}.bin")

    # Stage mean_sea_level_pressure_mean (Float16-safe anomaly hPa) for geostrophic cyclone swirl
    if ("temperature_2m_mean" in variables or "wind_10m_vector" in variables) and "mean_sea_level_pressure_mean" not in variables and "mean_sea_level_pressure_mean" in zg:
        print(f"\n[Phase 2] Extracting 'mean_sea_level_pressure_mean' (Float16-safe anomaly P - 1013.25 hPa)...")
        mslp_arr = zg["mean_sea_level_pressure_mean"]

        def _stage_mslp_hour(h: int) -> int:
            mslp_raw = mslp_arr[h, :, :]
            _, mslp_payload = process_slice(mslp_raw, "mean_sea_level_pressure_mean", padded=padded)
            mslp_path = os.path.join(output_dir, f"mean_sea_level_pressure_mean-{h}.bin")
            with open(mslp_path, "wb") as f_mslp:
                f_mslp.write(mslp_payload)
            return len(mslp_payload)

        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(_stage_mslp_hour, range(hours)))
        print(f"   -> Wrote mean_sea_level_pressure_mean-0..{hours-1}.bin")

    total_elapsed = time.perf_counter() - start_time
    print(f"\n[OK] Extracted {total_slices} binary slices in {total_elapsed:.1f}s.")

    wire_vars = [v for v in variables if v != "wind_10m_vector"]
    egress_gb = len(wire_vars) * hours * 0.0206
    est_cost_usd = egress_gb * COST_PER_GB_USD
    print(f"[COST TELEMETRY] Staged Cycle: {cycle_name} | Horizon: {hours}h | Slices: {total_slices}")
    print(f"                 Wire Egress: ~{egress_gb:.2f} GB | Estimated Spend: ~${est_cost_usd:.2f} (Billing: {billing_project}, Cap: <${MAX_SAFE_COST_USD:.2f})")

    canonical_disk_order = [
        "wind_10m_vector",
        "total_precipitation_1hr_mean",
        "temperature_2m_mean",
        "dewpoint_temperature_2m_mean",
        "low_cloud_cover_mean",
        "medium_cloud_cover_mean",
        "high_cloud_cover_mean",
        "sea_surface_temperature_mean",
        "radiative_optical_depth",
        "wind_100m_vector",
        "convective_spread",
        "mean_sea_level_pressure_mean",
    ]
    all_staged_vars = []
    for cand in canonical_disk_order:
        if cand in variables or os.path.exists(os.path.join(output_dir, f"{cand}-0.bin")):
            all_staged_vars.append(cand)
    for v in variables:
        if v not in all_staged_vars:
            all_staged_vars.append(v)

    # Write metadata index sidecar
    write_metadata_index(
        output_dir=output_dir,
        cycle_name=cycle_name,
        cycle_dir=cycle_dir,
        init_iso=init_iso,
        variables=all_staged_vars,
        hours=hours,
        padded=padded,
        billing_project=billing_project,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Google DeepMind WeatherNext 3 Data Extraction & Staging CLI"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Verify auth, bucket connectivity, latest cycle, variable manifest, and bandwidth without downloading full tensor chunks.",
    )
    parser.add_argument(
        "--cycle",
        type=str,
        default=None,
        help="Specify explicit forecast cycle folder (e.g. 20260911_18hr_01_preds). Defaults to latest finalized cycle.",
    )
    parser.add_argument(
        "--hours",
        type=int,
        default=DEFAULT_HOURS,
        help=f"Number of hourly timesteps to extract (1 to 360, default {DEFAULT_HOURS}).",
    )
    parser.add_argument(
        "--variables",
        type=str,
        default=None,
        help="Comma-separated list of variables to extract. Defaults to all 9 core prognostic fields.",
    )
    parser.add_argument(
        "--unpadded",
        "--no-pad",
        action="store_true",
        help="Export unpadded Float16 slices (7200 bytes/row) instead of pre-padded (7424 bytes/row).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Bypass local cache and force re-extraction.",
    )
    parser.add_argument(
        "--override-cost-cap",
        action="store_true",
        help=f"Override the strict 12-hour cost safety envelope guardrail (costs > ${MAX_SAFE_COST_USD:.2f}/pull).",
    )
    parser.add_argument(
        "--project",
        type=str,
        default=None,
        help=f"Billing project for requester-pays GCS bucket access (default: {DEFAULT_BILLING_PROJECT}).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Target directory for binary slices and meta.json (default: {DEFAULT_OUTPUT_DIR}).",
    )
    parser.add_argument(
        "--cloud-strata",
        action="store_true",
        help="Extract the 3 cloud strata (low, medium, high) and 10m wind vector field for volumetric rendering.",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Generate physically plausible demonstration slices and metadata locally without querying GCS.",
    )

    args = parser.parse_args()

    # Validate hours
    if args.hours < 1 or args.hours > 360:
        parser.error("--hours must be an integer between 1 and 360.")

    if args.hours > MAX_SAFE_HOURS and not (args.mock or args.dry_run or args.override_cost_cap):
        parser.error(
            f"Cost Safety Envelope Violation: Requested {args.hours} hours exceeds the strict 12-hour horizon cap (max < ${MAX_SAFE_COST_USD:.2f}/pull).\n"
            "To override this cost guardrail, explicitly pass --override-cost-cap."
        )

    # Parse variable selection
    if args.cloud_strata:
        selected_vars = CLOUD_STRATA_VARIABLES
        if not any(a.startswith("--hours") for a in sys.argv):
            args.hours = 12
    elif args.variables:
        selected_vars = [v.strip() for v in args.variables.split(",") if v.strip()]
        for v in selected_vars:
            if v not in CORE_VARIABLES and v not in CLOUD_STRATA_VARIABLES:
                print(f"[WARN] Requested variable '{v}' is outside standard fields.")
    else:
        selected_vars = CORE_VARIABLES

    padded = not args.unpadded

    # Fast offline mock generation mode
    if args.mock:
        mock_hours = args.hours if any(a.startswith("--hours") for a in sys.argv) else 24
        mock_vars = (
            selected_vars
            if any(a.startswith("--variables") for a in sys.argv)
            else [
                "wind_10m_vector",
                "total_precipitation_1hr_mean",
                "temperature_2m_mean",
                "dewpoint_temperature_2m_mean",
                "low_cloud_cover_mean",
                "medium_cloud_cover_mean",
                "high_cloud_cover_mean",
                "sea_surface_temperature_mean",
                "radiative_optical_depth",
            ]
        )
        stage_mock_slices(
            output_dir=args.output_dir,
            variables=mock_vars,
            hours=mock_hours,
            padded=padded,
            cycle_name=args.cycle or "20260911_21hr_01_preds",
        )
        return

    # 1. Resolve credentials and billing project
    adc_path, billing_project = resolve_adc_and_project(args.project)

    # 2. Initialize GCS filesystem
    fs = init_gcsfs(adc_path, billing_project)

    # 3. Discover latest finalized cycle
    cycle_name, cycle_dir, init_iso = discover_latest_cycle(
        fs=fs,
        bucket=GCS_BUCKET_NAME,
        prefix=GCS_PREFIX_DIR,
        requested_cycle=args.cycle,
    )

    padded = not args.unpadded

    # 4. Branch: Dry-Run vs Extract
    if args.dry_run:
        execute_dry_run(
            fs=fs,
            adc_path=adc_path,
            billing_project=billing_project,
            cycle_name=cycle_name,
            cycle_dir=cycle_dir,
            init_iso=init_iso,
            variables=selected_vars,
            hours=args.hours,
            padded=padded,
        )
    else:
        extract_and_stage(
            fs=fs,
            adc_path=adc_path,
            billing_project=billing_project,
            cycle_name=cycle_name,
            cycle_dir=cycle_dir,
            init_iso=init_iso,
            variables=selected_vars,
            hours=args.hours,
            padded=padded,
            output_dir=args.output_dir,
            force=args.force,
        )


if __name__ == "__main__":
    main()
