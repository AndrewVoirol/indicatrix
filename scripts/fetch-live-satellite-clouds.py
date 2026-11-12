#!/usr/bin/env python3
"""
NASA EOSDIS GIBS Near-Real-Time 3D Volumetric Satellite Cloud Ingestion CLI
===========================================================================
Fetches near-real-time global satellite observations at 0.1° (3600 × 1801) resolution
from NASA GIBS (EPSG:4326 WMS 1.3.0) and inverts the official NASA 24-bit Colormap XML
lookup tables to physical units:
  1. VIIRS 11.45 µm Thermal Infrared Brightness Temperature (K, 180 - 330 K)
     via NOAA-21, NOAA-20, and Suomi NPP (`VIIRS_Brightness_Temp_BandI5.xml`)
  2. Cloud Top Height (m, 0 - 12,000+ m) via VIIRS NOAA-20 / SNPP & MODIS Aqua / Terra
     (`MODIS_VIIRS_Cloud_Top_Height.xml`)
  3. Cloud Fraction (0.0 - 1.0) via MODIS Aqua / Terra
     (`MODIS_Cloud_Fraction.xml`)

Key Physical & Architectural Invariants:
  - Feathered Rolling 24-Hour Swath Continuity: Composites `today` over `yesterday` (`UTC - 1d`)
    with a 25-pixel (~2.5°) cosine feather across the orbital swath boundary so executions
    at any UTC hour have 99.9%+ global coverage with zero missing-swath wedges.
  - Pass-Normalized Polar Gap Feathering: Uses the synoptically continuous Night thermal IR
    node across its entire valid footprint (~90°N..67°S, avoiding 12h day/night splices at 25°S)
    and feathers into the Day node strictly across genuine polar-day gaps after normalizing
    each pass against its nocturnal vs. daytime clear-sky skin temperature.
  - Inoue/Platt Effective Emissivity & SST Coupling: Converts °C SST to Kelvin, evaluates
    effective 11.45 µm emissivity against `T_cld(Z_top)` so cold thin cirrus maps strictly
    to translucent high cirrus, and restricts vertical convective columns to near-tropopause
    blackbody storm cores.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import io
import json
import os
import re
import time
from typing import Any, Dict, Optional, Tuple
import urllib.request

GRID_WIDTH = 3600
GRID_HEIGHT = 1801
BYTES_PER_TEXEL = 2
RAW_ROW_BYTES = GRID_WIDTH * BYTES_PER_TEXEL  # 7200
PADDED_ROW_BYTES = ((RAW_ROW_BYTES + 255) // 256) * 256  # 7424
PADDED_COLS = PADDED_ROW_BYTES // BYTES_PER_TEXEL  # 3712
PADDED_SLICE_BYTES = GRID_HEIGHT * PADDED_ROW_BYTES  # 13,370,624
UNPADDED_SLICE_BYTES = GRID_HEIGHT * RAW_ROW_BYTES  # 12,967,200

DEFAULT_OUTPUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "public",
    "data",
)

GIBS_WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
GIBS_COLORMAP_BASE = "https://gibs.earthdata.nasa.gov/colormaps/v1.0"

LAYER_SUITES = {
    "viirs_ir_night": (
        "VIIRS_SNPP_Brightness_Temp_BandI5_Night,"
        "VIIRS_NOAA20_Brightness_Temp_BandI5_Night,"
        "VIIRS_NOAA21_Brightness_Temp_BandI5_Night"
    ),
    "viirs_ir_day": (
        "VIIRS_SNPP_Brightness_Temp_BandI5_Day,"
        "VIIRS_NOAA20_Brightness_Temp_BandI5_Day,"
        "VIIRS_NOAA21_Brightness_Temp_BandI5_Day"
    ),
    "cth_night": (
        "MODIS_Terra_Cloud_Top_Height_Night,MODIS_Aqua_Cloud_Top_Height_Night,"
        "VIIRS_SNPP_Cloud_Top_Height_Night,VIIRS_NOAA20_Cloud_Top_Height_Night"
    ),
    "cth_day": (
        "MODIS_Terra_Cloud_Top_Height_Day,MODIS_Aqua_Cloud_Top_Height_Day,"
        "VIIRS_SNPP_Cloud_Top_Height_Day,VIIRS_NOAA20_Cloud_Top_Height_Day"
    ),
    "cf_night": "MODIS_Terra_Cloud_Fraction_Night,MODIS_Aqua_Cloud_Fraction_Night",
    "cf_day": "MODIS_Terra_Cloud_Fraction_Day,MODIS_Aqua_Cloud_Fraction_Day",
}


def build_colormap_lut(xml_filename: str, scale: float = 1.0) -> Any:
    """
    Downloads an official NASA GIBS Colormap XML and builds an O(1) 24-bit RGB lookup table
    mapping `(R << 16) | (G << 8) | B` to physical floating-point quantities.
    """
    import numpy as np

    url = f"{GIBS_COLORMAP_BASE}/{xml_filename}"
    req = urllib.request.Request(url, headers={"User-Agent": "IndicatrixEngine/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        xml_text = resp.read().decode("utf-8", errors="ignore")

    entries = re.findall(r"<ColorMapEntry\s+([^>]+)>", xml_text)
    hash_lut = np.full(1 << 24, np.nan, dtype=np.float32)

    for attr in entries:
        if 'transparent="true"' in attr:
            continue
        m_rgb = re.search(r'rgb="(\d+),(\d+),(\d+)"', attr)
        m_val = re.search(r'value="([^"]+)"', attr)
        if not m_rgb or not m_val:
            continue
        r, g, b = int(m_rgb.group(1)), int(m_rgb.group(2)), int(m_rgb.group(3))
        nums = [float(x) for x in re.findall(r"[-+]?\d*\.?\d+", m_val.group(1))]
        if not nums:
            continue
        val = (sum(nums) / len(nums)) * scale
        hash_lut[(r << 16) | (g << 8) | b] = val

    return hash_lut


def _fetch_single_wms_png(layer_str: str, lut: Any, time_str: Optional[str] = None) -> Optional[Any]:
    import numpy as np
    from PIL import Image

    time_param = f"&TIME={time_str}" if time_str else ""
    url = (
        f"{GIBS_WMS_URL}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
        f"&LAYERS={layer_str}&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE"
        f"&HEIGHT={GRID_HEIGHT}&WIDTH={GRID_WIDTH}&CRS=EPSG:4326&BBOX=-90,-180,90,180"
        f"{time_param}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "IndicatrixEngine/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw_bytes = resp.read()
    except Exception:
        return None

    if len(raw_bytes) < 8 or raw_bytes[:4] != b"\x89PNG":
        return None

    img = np.array(Image.open(io.BytesIO(raw_bytes)).convert("RGBA"), dtype=np.int32)
    keys = (img[..., 0] << 16) | (img[..., 1] << 8) | img[..., 2]
    decoded = lut[keys].copy()
    decoded[img[..., 3] < 64] = np.nan
    return decoded


def fetch_wms_decoded(layers: str, lut: Any, time_str: Optional[str] = None) -> Any:
    """
    Fetches a 3600 × 1801 EPSG:4326 PNG from NASA GIBS WMS and decodes each pixel
    through the 24-bit Colormap LUT into a physical Float32 grid (Row 0 = +90°N, Col 0 = -180°W).
    If a multi-sensor comma-separated WMS request returns a ServiceException XML because one
    individual platform lags behind `time_str` (e.g. SNPP outage or 00:00Z UTC day rollover),
    automatically falls back to per-platform compositing so live sensors never black out.
    """
    import numpy as np

    combined = _fetch_single_wms_png(layers, lut, time_str)
    if combined is not None:
        return combined

    sub_layers = [s.strip() for s in layers.split(",") if s.strip()]
    out = np.full((GRID_HEIGHT, GRID_WIDTH), np.nan, dtype=np.float32)
    if len(sub_layers) <= 1:
        return out

    for sub in sub_layers:
        grid = _fetch_single_wms_png(sub, lut, time_str)
        if grid is not None:
            out = np.where(np.isfinite(grid), grid, out)
    return out


def compute_feathered_mask_weight(valid_mask: Any, feather_px: int = 25) -> Any:
    """
    Computes a smooth [0.0, 1.0] interior weight for a valid swath mask that feathers
    smoothly to 0.0 over `feather_px` before the swath edge, eliminating hard orbital seams.
    """
    import numpy as np

    w = valid_mask.astype(np.float32)
    step = max(1, feather_px // 5)
    for _ in range(5):
        w_h = (w + np.roll(w, step, axis=1) + np.roll(w, -step, axis=1)) / 3.0
        w_u = np.vstack([np.repeat(w_h[0:1, :], step, axis=0), w_h[:-step, :]])
        w_d = np.vstack([w_h[step:, :], np.repeat(w_h[-1:, :], step, axis=0)])
        w = np.minimum(w, (w_h + w_u + w_d) / 3.0)
    w = np.clip((w - 0.12) / 0.88, 0.0, 1.0)
    return (w * w * (3.0 - 2.0 * w)).astype(np.float32)


def fetch_rolling_polar_wms(
    layers: str,
    lut: Any,
    today_str: str,
    yesterday_str: str,
    fallback_day_str: Optional[str] = None,
) -> Any:
    """
    Composites today's polar-orbiting swaths over yesterday's full-day composite with a
    smooth 25-pixel cosine feather at the swath boundary so there are zero missing-swath
    wedges or hard orbital edges regardless of UTC time of day (with optional UTC-2d fill
    at 00:00Z rollover).
    """
    import numpy as np

    today_grid = fetch_wms_decoded(layers, lut, today_str)
    yesterday_grid = fetch_wms_decoded(layers, lut, yesterday_str)
    if np.isfinite(today_grid).any():
        w_today = compute_feathered_mask_weight(np.isfinite(today_grid), feather_px=25)
        merged = np.where(
            np.isfinite(today_grid) & np.isfinite(yesterday_grid),
            w_today * today_grid + (1.0 - w_today) * yesterday_grid,
            np.where(np.isfinite(today_grid), today_grid, yesterday_grid),
        )
    else:
        merged = yesterday_grid

    if fallback_day_str and np.isnan(merged[200:1600, :]).mean() > 0.005:
        fb_grid = fetch_wms_decoded(layers, lut, fallback_day_str)
        if np.isfinite(fb_grid).any():
            w_m = compute_feathered_mask_weight(np.isfinite(merged), feather_px=25)
            merged = np.where(
                np.isfinite(merged) & np.isfinite(fb_grid),
                w_m * merged + (1.0 - w_m) * fb_grid,
                np.where(np.isfinite(merged), merged, fb_grid),
            )
    return merged


def blend_antimeridian_seam(grid: Any, half_width_px: int = 16) -> Any:
    """
    Applies a periodic cosine cross-blend across the ±180° International Date Line
    (`col 0` <-> `col W-1`) to eliminate NASA GIBS daily-granule UTC date-line steps
    over the central Pacific Ocean while leaving interior longitudes untouched.
    """
    import numpy as np

    out = np.asarray(grid, dtype=np.float32).copy()
    w = out.shape[1]
    hw = min(half_width_px, w // 8)
    if hw <= 0:
        return out
    seam_avg = 0.5 * (out[:, 0] + out[:, -1])
    for k in range(hw):
        t = (k + 0.5) / float(hw)
        alpha = 0.5 * (1.0 + np.cos(np.pi * t))  # 1.0 at seam -> 0.0 at k = hw
        out[:, k] = (1.0 - alpha) * out[:, k] + alpha * seam_avg
        out[:, w - 1 - k] = (1.0 - alpha) * out[:, w - 1 - k] + alpha * seam_avg
    return out


def smooth_grid_2d(grid: Any, passes: int = 1) -> Any:
    """
    Applies a crisp [0.12, 0.76, 0.12] LUT de-quantization kernel (wrapping horizontally
    across the antimeridian) to remove 8-bit WMS LUT stair-stepping while preserving sharp
    0.1° (10 km) cumulus street and dry-slot boundaries.
    """
    import numpy as np

    out = np.asarray(grid, dtype=np.float32)
    for _ in range(passes):
        out = 0.76 * out + 0.12 * np.roll(out, 1, axis=1) + 0.12 * np.roll(out, -1, axis=1)
        up = np.vstack([out[0:1, :], out[:-1, :]])
        dn = np.vstack([out[1:, :], out[-1:, :]])
        out = 0.76 * out + 0.12 * up + 0.12 * dn
    return out


def load_reference_surface_temperature_k(output_dir: str) -> Tuple[Any, Any, Any]:
    """
    Loads the staged 0.1° WeatherNext 3 2m air temperature and sea surface temperature
    grids (if present on disk) to serve as separate nocturnal (01:30 LST) and daytime
    (13:30 LST) clear-sky surface skin temperature references in Kelvin plus `is_ocean`.
    """
    import numpy as np

    lats = np.linspace(90.0, -90.0, GRID_HEIGHT, dtype=np.float32)[:, None]
    lat_rad = np.radians(lats)
    cos_lat = np.maximum(0.0, np.cos(lat_rad))
    t_sfc_night_fallback = np.broadcast_to(
        263.5 + 35.5 * (cos_lat ** 1.30),
        (GRID_HEIGHT, GRID_WIDTH),
    ).copy()
    t_sfc_day_fallback = np.broadcast_to(
        266.5 + 37.5 * (cos_lat ** 1.25),
        (GRID_HEIGHT, GRID_WIDTH),
    ).copy()
    is_ocean_fallback = np.ones((GRID_HEIGHT, GRID_WIDTH), dtype=bool)

    wn_dir = os.path.join(output_dir, "weathernext")
    t2m_path = os.path.join(wn_dir, "temperature_2m_mean-0.bin")
    sst_path = os.path.join(wn_dir, "sea_surface_temperature_mean-0.bin")

    if os.path.exists(t2m_path) and os.path.getsize(t2m_path) == PADDED_SLICE_BYTES:
        try:
            t2m_slices = []
            for h in range(12):
                p_h = os.path.join(wn_dir, f"temperature_2m_mean-{h}.bin")
                if os.path.exists(p_h) and os.path.getsize(p_h) == PADDED_SLICE_BYTES:
                    arr_c = (
                        np.fromfile(p_h, dtype=np.float16)
                        .reshape(GRID_HEIGHT, PADDED_COLS)[:, :GRID_WIDTH]
                        .astype(np.float32)
                    )
                    t2m_slices.append(np.where(arr_c < 150.0, arr_c + 273.15, arr_c))
            t2m_stack = np.stack(t2m_slices, axis=0)
            t2m_mean_k = np.mean(t2m_stack, axis=0)
            t2m_night_land_k = (
                np.percentile(t2m_stack, 15, axis=0).astype(np.float32)
                if len(t2m_slices) > 1
                else t2m_slices[0]
            )
            solar_skin_boost_k = 5.5 * (cos_lat ** 1.25)
            t2m_day_land_k = (
                (np.percentile(t2m_stack, 90, axis=0) + solar_skin_boost_k).astype(np.float32)
                if len(t2m_slices) > 1
                else (t2m_slices[0] + solar_skin_boost_k).astype(np.float32)
            )
            if os.path.exists(sst_path) and os.path.getsize(sst_path) == PADDED_SLICE_BYTES:
                sst_raw = (
                    np.fromfile(sst_path, dtype=np.float16)
                    .reshape(GRID_HEIGHT, PADDED_COLS)[:, :GRID_WIDTH]
                    .astype(np.float32)
                )
                # Staged SST binary stores °C (-2..+33 °C over ocean, -99 sentinel on land);
                # also accept Kelvin (268..330 K) for synthetic fixtures.
                is_ocean_c = np.isfinite(sst_raw) & (sst_raw > -5.0) & (sst_raw < 60.0)
                is_ocean_k = np.isfinite(sst_raw) & (sst_raw > 268.0) & (sst_raw < 330.0)
                is_ocean = is_ocean_c | is_ocean_k
                sst_k = np.where(is_ocean_c, sst_raw + 273.15, np.where(is_ocean_k, sst_raw, np.nan))
                t_sfc_ocean_k = 0.88 * sst_k + 0.12 * t2m_mean_k
                t_sfc_night = np.where(is_ocean, t_sfc_ocean_k, t2m_night_land_k)
                t_sfc_day = np.where(is_ocean, t_sfc_ocean_k, t2m_day_land_k)
            else:
                is_ocean = is_ocean_fallback
                t_sfc_night = t2m_night_land_k
                t_sfc_day = t2m_day_land_k

            valid_n = np.isfinite(t_sfc_night) & (t_sfc_night > 180.0) & (t_sfc_night < 345.0)
            valid_d = np.isfinite(t_sfc_day) & (t_sfc_day > 180.0) & (t_sfc_day < 355.0)
            return (
                np.where(valid_n, t_sfc_night, t_sfc_night_fallback).astype(np.float32),
                np.where(valid_d, t_sfc_day, t_sfc_day_fallback).astype(np.float32),
                is_ocean,
            )
        except Exception:
            pass

    return (
        t_sfc_night_fallback.astype(np.float32),
        t_sfc_day_fallback.astype(np.float32),
        is_ocean_fallback,
    )


def merge_day_night_viirs_passes(
    vir_n: Any,
    vir_d: Any,
    cth_n: Any,
    cth_d: Any,
    t_sfc_night_k: Any,
    t_sfc_day_k: Any,
    is_ocean: Any,
    feather_px: int = 38,
) -> Tuple[Any, Any, Any]:
    """
    Normalizes nocturnal (01:30 LST) and daytime (13:30 LST) VIIRS 11.45 µm passes against
    their respective local-time clear-sky skin temperatures BEFORE blending, and uses the
    synoptically continuous Night pass everywhere it has valid data (~90°N..67°S), feathering
    into the normalized Day pass strictly across genuine high-latitude polar-day gaps.
    Returns `(synthetic_equiv_viirs_k, merged_cth_m, ref_t_sfc_night_k)`.
    """
    import numpy as np

    lats = np.linspace(90.0, -90.0, GRID_HEIGHT, dtype=np.float32)[:, None]
    lat_rad = np.radians(lats)
    wv_continuum_k = 2.4 + 2.4 * (np.cos(lat_rad) ** 2)
    thresh_n = np.where(is_ocean, wv_continuum_k, wv_continuum_k + 5.2)
    thresh_d = np.where(is_ocean, wv_continuum_k + 0.4, wv_continuum_k + 3.8)

    net_n = np.where(np.isfinite(vir_n), np.maximum(0.0, (t_sfc_night_k - vir_n) - thresh_n), np.nan)
    net_d = np.where(np.isfinite(vir_d), np.maximum(0.0, (t_sfc_day_k - vir_d) - thresh_d), np.nan)

    w_night = compute_feathered_mask_weight(np.isfinite(net_n), feather_px=feather_px)
    net_merged = np.where(
        np.isfinite(net_n) & np.isfinite(net_d),
        w_night * net_n + (1.0 - w_night) * net_d,
        np.where(np.isfinite(net_n), net_n, net_d),
    )
    equiv_viirs_k = np.where(
        np.isfinite(net_merged),
        t_sfc_night_k - (thresh_n + net_merged),
        np.nan,
    ).astype(np.float32)

    w_cth_n = compute_feathered_mask_weight(np.isfinite(cth_n) & np.isfinite(net_n), feather_px=feather_px)
    merged_cth_m = np.where(
        np.isfinite(cth_n) & np.isfinite(cth_d),
        w_cth_n * cth_n + (1.0 - w_cth_n) * cth_d,
        np.where(np.isfinite(cth_n), cth_n, cth_d),
    ).astype(np.float32)

    return equiv_viirs_k, merged_cth_m, t_sfc_night_k


def merge_day_night_cf_passes(cf_n: Any, cf_d: Any, feather_px: int = 38) -> Any:
    """
    Merges nocturnal (01:30 LST) and daytime (13:30 LST) MODIS Cloud Fraction passes
    using the synoptically continuous Night pass across ~90°N..67°S and feathering into
    the Day pass across polar-day gaps, matching `merge_day_night_viirs_passes`.
    """
    import numpy as np

    w_n = compute_feathered_mask_weight(np.isfinite(cf_n), feather_px=feather_px)
    return np.where(
        np.isfinite(cf_n) & np.isfinite(cf_d),
        w_n * cf_n + (1.0 - w_n) * cf_d,
        np.where(np.isfinite(cf_n), cf_n, cf_d),
    ).astype(np.float32)


def load_subcanopy_cloud_priors(output_dir: str) -> Tuple[Optional[Any], Optional[Any]]:
    """
    Loads staged 0.1° WeatherNext 3 hour-0 boundary-layer (low) and mid-level cloud cover
    grids if present on disk. Used strictly to preserve obscured lower/mid cloud decks
    underneath optically obscuring upper satellite canopies where downward thermal IR cannot
    penetrate, without injecting any cloud into clear-sky satellite slots.
    """
    import numpy as np

    wn_dir = os.path.join(output_dir, "weathernext")
    low_p = os.path.join(wn_dir, "low_cloud_cover_mean-0.bin")
    mid_p = os.path.join(wn_dir, "medium_cloud_cover_mean-0.bin")
    sub_low = None
    sub_mid = None
    try:
        if os.path.exists(low_p) and os.path.getsize(low_p) == PADDED_SLICE_BYTES:
            sub_low = (
                np.fromfile(low_p, dtype=np.float16)
                .reshape(GRID_HEIGHT, PADDED_COLS)[:, :GRID_WIDTH]
                .astype(np.float32)
            )
        if os.path.exists(mid_p) and os.path.getsize(mid_p) == PADDED_SLICE_BYTES:
            sub_mid = (
                np.fromfile(mid_p, dtype=np.float16)
                .reshape(GRID_HEIGHT, PADDED_COLS)[:, :GRID_WIDTH]
                .astype(np.float32)
            )
    except Exception:
        pass
    return sub_low, sub_mid


def stratify_satellite_clouds(
    cth_m: Any,
    cot: Any,
    cf: Any,
    geo_ir_c: Any,
    viirs_ir_k: Any,
    t_sfc_k: Optional[Any] = None,
    is_ocean: Optional[Any] = None,
    subcanopy_low: Optional[Any] = None,
    subcanopy_mid: Optional[Any] = None,
) -> Tuple[Any, Any, Any, Any]:
    """
    Converts VIIRS 11.45 µm Band I5 Brightness Temperature, Cloud Top Height, and optional
    Cloud Optical Thickness / Cloud Fraction into 3 altitude-stratified volumetric cloud
    cover fractions (low, mid, high) and radiative optical depth via Inoue/Platt effective
    IR emissivity (`eps_ir`) so cold semi-transparent cirrus maps strictly to translucent
    high cirrus rather than full-troposphere opaque blocks, while latitude-scaled baroclinic
    storm cores and obscured sub-canopy lower decks preserve multi-layer cyclone depth.
    """
    import numpy as np

    shape = viirs_ir_k.shape
    lats = np.linspace(90.0, -90.0, shape[0], dtype=np.float32)[:, None]
    lat_rad = np.radians(lats)
    cos_lat_sq = np.cos(lat_rad) ** 2
    if t_sfc_k is None:
        t_sfc_k = np.broadcast_to(
            263.5 + 35.5 * (np.maximum(0.0, np.cos(lat_rad)) ** 1.30),
            shape,
        ).astype(np.float32)

    if is_ocean is None:
        is_ocean = np.ones(shape, dtype=bool)

    # 1. Excess 11.45 µm thermal brightness temperature depression above clear-sky continuum
    depr_k = np.where(np.isfinite(viirs_ir_k), np.maximum(0.0, t_sfc_k - viirs_ir_k), 0.0)
    wv_continuum_k = 2.4 + 2.4 * cos_lat_sq
    thresh_k = np.where(is_ocean, wv_continuum_k, wv_continuum_k + 5.2)
    net_depr_k = np.maximum(0.0, depr_k - thresh_k)

    # 2. Effective Cloud Top Height (m): guard warm boundary-layer clouds against stale high-CTH
    #    overlaps while allowing cold/semi-transparent cirrus (net_depr_k >= 6 K) to retain L2 CTH.
    ir_height_m = np.clip(net_depr_k * (1000.0 / 6.1), 0.0, 13500.0)
    cirrus_cth_gate = np.clip((net_depr_k - 5.5) / 8.5, 0.0, 1.0)
    max_plausible_cth = ir_height_m + 2200.0 + 8200.0 * cirrus_cth_gate
    if cth_m is not None:
        cth_clamped = np.minimum(cth_m, max_plausible_cth)
        eff_cth_m = np.where(np.isfinite(cth_m), 0.72 * cth_clamped + 0.28 * ir_height_m, ir_height_m)
    else:
        eff_cth_m = ir_height_m

    # 3. Inoue/Platt effective 11.45 µm cloud emissivity relative to opaque blackbody T_cld(Z_top),
    #    converted to visible-band cloud optical fraction via tau_vis ~= 2.1 * tau_ir (Platt 1973).
    t_trop_k = 197.0 + 22.0 * (np.sin(lat_rad) ** 2)
    t_cld_opaque_k = np.maximum(t_trop_k, t_sfc_k - 0.0062 * eff_cth_m)
    opaque_depr_span_k = np.maximum(
        np.where(is_ocean, 6.4, 10.5),
        (t_sfc_k - thresh_k) - t_cld_opaque_k,
    )
    eps_ir = np.clip(net_depr_k / opaque_depr_span_k, 0.0, 1.0)

    if cot is not None:
        eps_cot = np.where(np.isfinite(cot), 1.0 - np.exp(-np.maximum(0.0, cot) / 2.2), eps_ir)
        eps_eff = np.where(np.isfinite(cot), 0.55 * eps_cot + 0.45 * eps_ir, eps_ir)
    else:
        eps_eff = eps_ir

    if cf is not None:
        cf_valid = np.isfinite(cf)
        cf_clamped = np.clip(np.where(cf_valid, cf, 0.0), 0.0, 1.0)
        # Clear-sky MODIS Cloud Mask gate removes residual clear-air WV continuum noise,
        # while warm ocean boundary-layer cumulus (eff_cth_m < 3.4 km) gains MODIS CF definition.
        clear_cf_gate = np.clip(cf_clamped / 0.04, 0.0, 1.0)
        mbl_ocean_weight = np.where(
            is_ocean & (eff_cth_m < 3400.0) & (net_depr_k > 0.55),
            0.46,
            0.0,
        )
        eps_with_cf = (
            (1.0 - mbl_ocean_weight) * (eps_eff * np.clip(cf_clamped * 1.18 + 0.16, 0.0, 1.0))
            + mbl_ocean_weight * (0.52 * eps_eff + 0.48 * (cf_clamped * 0.84))
        ) * clear_cf_gate
        eps_eff = np.where(cf_valid, np.clip(eps_with_cf, 0.0, 1.0), eps_eff)

    vis_eff = 1.0 - np.power(np.clip(1.0 - eps_eff, 0.0, 1.0), 2.10)
    base_cov = np.where(
        (eps_eff < 0.048) | (net_depr_k <= 0.25),
        0.0,
        np.clip((vis_eff - 0.08) / 0.92, 0.0, 1.0),
    )

    # 4. Latitude-aware deep convective & baroclinic frontal column gate:
    #    Tropopause height scales from ~12.5 km in tropics to ~8.8-9.5 km in extratropical storm tracks,
    #    requiring high thermal blackbody emissivity (`eps_eff > 0.85`) so semi-transparent cirrus never triggers.
    z_trop_m = 7800.0 + 4700.0 * cos_lat_sq
    storm_top_floor_m = z_trop_m - 4100.0
    cold_core = (
        np.clip((eff_cth_m - storm_top_floor_m) / 2200.0, 0.0, 1.0)
        * np.clip((eps_eff - 0.85) / 0.12, 0.0, 1.0)
        * np.clip(((t_trop_k + 30.0) - viirs_ir_k) / 20.0, 0.0, 1.0)
    )
    if cot is not None:
        cot_core_gate = np.where(np.isfinite(cot), np.clip((cot - 12.0) / 16.0, 0.0, 1.0), 1.0)
        cold_core = cold_core * cot_core_gate
    deep_convection = np.clip(np.where(np.isfinite(viirs_ir_k), cold_core, 0.0), 0.0, 1.0)

    # 5. Partition into Low (0 - 2.8 km), Mid (2.4 - 7.5 km), and High (5.6 - 13+ km) strata
    w_low_alt = np.clip((3200.0 - eff_cth_m) / 1300.0, 0.0, 1.0)
    w_low = np.clip(np.maximum(w_low_alt, deep_convection * 0.58), 0.0, 1.0)

    w_mid_alt = (
        np.clip((eff_cth_m - 2000.0) / 1100.0, 0.0, 1.0)
        * np.clip((7600.0 - eff_cth_m) / 1700.0, 0.0, 1.0)
    )
    w_mid = np.clip(np.maximum(w_mid_alt, deep_convection * 0.74), 0.0, 1.0)

    w_high_alt = np.clip((eff_cth_m - 5200.0) / 1800.0, 0.0, 1.0)
    high_ice_translucency = 0.88 + 0.12 * deep_convection
    w_high = np.clip(w_high_alt * high_ice_translucency, 0.0, 1.0)

    low_raw = base_cov * w_low
    mid_raw = base_cov * w_mid
    high_raw = base_cov * w_high

    # Preserve obscured sub-canopy boundary-layer & mid-level cloud decks strictly beneath
    # obscuring upper/mid satellite lids (0.0 injection in clear-sky or unobstructed low slots).
    if subcanopy_low is not None:
        upper_obsc = np.clip(base_cov * np.maximum(w_high * 1.15, w_mid * 0.95) - 0.08, 0.0, 1.0)
        low_raw = np.maximum(low_raw, np.clip(subcanopy_low, 0.0, 1.0) * upper_obsc * 0.86)
    if subcanopy_mid is not None:
        high_only_obsc = np.clip(base_cov * w_high * 1.15 - 0.08, 0.0, 1.0)
        mid_raw = np.maximum(mid_raw, np.clip(subcanopy_mid, 0.0, 1.0) * high_only_obsc * 0.82)

    def _finalize_stratum(arr: Any) -> Any:
        cleaned = np.where(arr < 0.025, 0.0, arr)
        smoothed = np.where(cleaned > 0.0, smooth_grid_2d(cleaned, passes=1), 0.0)
        seamless = blend_antimeridian_seam(smoothed, half_width_px=16)
        return np.nan_to_num(np.clip(seamless, 0.0, 1.0), nan=0.0, posinf=1.0, neginf=0.0).astype(np.float32)

    low_cov = _finalize_stratum(low_raw)
    mid_cov = _finalize_stratum(mid_raw)
    high_cov = _finalize_stratum(high_raw)

    # 6. Full-Range Radiative Optical Depth [0.02, 1.0]:
    #    Inverts effective emissivity (`tau_norm`) so dense frontal bands and liquid stratocumulus
    #    span [0.45..0.98] while detached semi-transparent cirrus stays optically thin (< 0.20).
    tau_norm = np.clip(-np.log(np.clip(1.0 - eps_eff * 0.95, 0.05, 1.0)) / 3.0, 0.0, 1.0)
    rad_opt_depth = np.nan_to_num(
        np.clip(
            blend_antimeridian_seam(
                smooth_grid_2d(
                    0.02
                    + (0.42 + 0.34 * tau_norm) * low_cov
                    + (0.42 + 0.36 * tau_norm) * mid_cov
                    + (0.13 + 0.44 * deep_convection) * high_cov
                    + 0.24 * deep_convection,
                    passes=1,
                ),
                half_width_px=16,
            ),
            0.02,
            1.0,
        ),
        nan=0.02,
        posinf=1.0,
        neginf=0.02,
    ).astype(np.float32)

    return low_cov, mid_cov, high_cov, rad_opt_depth


def encode_webgpu_float16_slice(grid_f32: Any, padded: bool = True) -> bytes:
    """
    Encodes a (1801, 3600) Float32 array into a WebGPU-ready Float16 binary payload.
    """
    import numpy as np

    f16 = np.clip(np.nan_to_num(grid_f32, nan=0.0, posinf=1.0, neginf=0.0), 0.0, 1.0).astype(np.float16)
    if padded:
        padded_grid = np.zeros((GRID_HEIGHT, PADDED_COLS), dtype=np.float16)
        padded_grid[:, :GRID_WIDTH] = f16
        return padded_grid.tobytes()
    return f16.tobytes()


def generate_mock_satellite_strata() -> Tuple[Any, Any, Any, Any]:
    """
    Deterministic offline fallback (--mock or process.env.VITEST per Rule 31).
    """
    import numpy as np

    lats = np.linspace(90.0, -90.0, GRID_HEIGHT, dtype=np.float32)[:, None]
    lons = np.linspace(-180.0, 180.0, GRID_WIDTH, dtype=np.float32)[None, :]

    low = np.clip(
        0.30 * np.exp(-((lats - 28.0) ** 2) / 180.0) * (0.5 + 0.5 * np.cos(np.radians(lons * 3.0)))
        + 0.55 * np.exp(-((lats + 52.0) ** 2) / 140.0) * (0.5 + 0.5 * np.sin(np.radians(lons * 4.0))),
        0.0,
        1.0,
    ).astype(np.float32)
    mid = np.clip(
        0.50 * np.exp(-((lats - 6.0) ** 2) / 55.0) * (0.5 + 0.5 * np.sin(np.radians(lons * 5.0)))
        + 0.45 * np.exp(-((lats - 44.0) ** 2) / 110.0) * np.maximum(0.0, np.cos(np.radians(lons * 4.0))),
        0.0,
        1.0,
    ).astype(np.float32)
    high = np.clip(
        0.60 * np.exp(-((lats - 5.0) ** 2) / 45.0) * np.maximum(0.0, np.sin(np.radians(lons * 3.0)))
        + 0.40 * np.exp(-((np.abs(lats) - 38.0) ** 2) / 90.0) * np.maximum(0.0, np.sin(np.radians(lons * 6.0))),
        0.0,
        1.0,
    ).astype(np.float32)
    rad = np.clip(0.02 + 0.55 * low + 0.45 * mid + 0.25 * high, 0.02, 1.0).astype(np.float32)
    return low, mid, high, rad


def write_outputs(
    output_dir: str,
    low_cov: Any,
    mid_cov: Any,
    high_cov: Any,
    rad_opt: Any,
    padded: bool,
    mode: str,
) -> Dict[str, Any]:
    import numpy as np

    os.makedirs(output_dir, exist_ok=True)
    files = {
        "low": ("satellite-cloud-low-latest.bin", low_cov),
        "mid": ("satellite-cloud-mid-latest.bin", mid_cov),
        "high": ("satellite-cloud-high-latest.bin", high_cov),
        "radiative_optical_depth": ("satellite-radiative-optical-depth-latest.bin", rad_opt),
    }

    stats: Dict[str, Any] = {}
    for key, (fname, arr) in files.items():
        payload = encode_webgpu_float16_slice(arr, padded=padded)
        out_path = os.path.join(output_dir, fname)
        with open(out_path, "wb") as f:
            f.write(payload)
        stats[key] = {
            "file": f"/data/{fname}",
            "byteLength": len(payload),
            "mean": round(float(np.mean(arr)), 4),
            "p90": round(float(np.percentile(arr, 90)), 4),
            "clearSkyFraction": round(float(np.mean(arr < 0.05)), 4),
        }

    now_iso = datetime.now(timezone.utc).isoformat()
    meta = {
        "source": "NASA EOSDIS GIBS (VIIRS NOAA-21/NOAA-20/SNPP Band I5 11.45µm + MODIS/VIIRS L2 CTH & CF)",
        "model": "nasa_gibs_3d_volumetric_composite",
        "mode": mode,
        "ingestedAtUTC": now_iso,
        "observationTimestampUTC": now_iso,
        "gridDimensions": {
            "width": GRID_WIDTH,
            "height": GRID_HEIGHT,
            "resolutionDeg": 0.1,
            "latitudeOrientation": "row_0_north",
            "longitudeOrientation": "col_0_antimeridian_-180",
        },
        "textureEncoding": {
            "format": "r16float",
            "bytesPerTexel": BYTES_PER_TEXEL,
            "rawRowBytes": RAW_ROW_BYTES,
            "paddedRowBytes": PADDED_ROW_BYTES if padded else RAW_ROW_BYTES,
            "isPrePadded": padded,
            "sliceByteLength": PADDED_SLICE_BYTES if padded else UNPADDED_SLICE_BYTES,
        },
        "layers": LAYER_SUITES,
        "strata": stats,
    }

    meta_path = os.path.join(output_dir, "satellite-meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    return meta


def main() -> None:
    import numpy as np

    parser = argparse.ArgumentParser(description="Fetch NASA GIBS 3D Volumetric Satellite Cloud Strata")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR, help="Output directory (default: public/data)")
    parser.add_argument("--unpadded", action="store_true", help="Write unpadded 3600-col slices instead of 3712-col")
    parser.add_argument("--mock", action="store_true", help="Generate deterministic synthetic satellite strata offline")
    parser.add_argument("--force", action="store_true", help="Force download even under VITEST")
    args = parser.parse_args()

    padded = not args.unpadded

    # Rule 31: Retain cached records under process.env.VITEST unless --force or missing
    low_path = os.path.join(args.output_dir, "satellite-cloud-low-latest.bin")
    if os.environ.get("VITEST") and not args.force and os.path.exists(low_path):
        print("[VITEST] Retaining cached satellite-cloud-*-latest.bin slices.")
        return

    if args.mock or (os.environ.get("VITEST") and not args.force):
        low, mid, high, rad = generate_mock_satellite_strata()
        meta = write_outputs(args.output_dir, low, mid, high, rad, padded=padded, mode="mock")
        print(f"[OK] Wrote mock 3D satellite cloud strata to {args.output_dir} ({meta['textureEncoding']['sliceByteLength']:,} B/slice)")
        return

    t0 = time.perf_counter()
    now_utc = datetime.now(timezone.utc)
    today_str = now_utc.strftime("%Y-%m-%d")
    yesterday_str = (now_utc - timedelta(days=1)).strftime("%Y-%m-%d")
    fallback_day_str = (now_utc - timedelta(days=2)).strftime("%Y-%m-%d")

    print(f"[NASA GIBS] Fetching 24-bit physical Colormap XML lookup tables (rolling window: {yesterday_str} -> {today_str})...")
    try:
        with ThreadPoolExecutor(max_workers=3) as ex:
            f_vir_lut = ex.submit(build_colormap_lut, "VIIRS_Brightness_Temp_BandI5.xml", 1.0)
            f_cth_lut = ex.submit(build_colormap_lut, "MODIS_VIIRS_Cloud_Top_Height.xml", 1.0)
            f_cf_lut = ex.submit(build_colormap_lut, "MODIS_Cloud_Fraction.xml", 0.01)

            lut_vir = f_vir_lut.result()
            lut_cth = f_cth_lut.result()
            lut_cf = f_cf_lut.result()

        print("[NASA GIBS] Downloading global 0.1° (3600×1801) rolling 24h VIIRS Band I5 + CTH + MODIS Cloud Fraction retrievals...")
        with ThreadPoolExecutor(max_workers=6) as ex:
            f_vir_n = ex.submit(fetch_rolling_polar_wms, LAYER_SUITES["viirs_ir_night"], lut_vir, today_str, yesterday_str, fallback_day_str)
            f_vir_d = ex.submit(fetch_rolling_polar_wms, LAYER_SUITES["viirs_ir_day"], lut_vir, today_str, yesterday_str, fallback_day_str)
            f_cth_n = ex.submit(fetch_rolling_polar_wms, LAYER_SUITES["cth_night"], lut_cth, today_str, yesterday_str, fallback_day_str)
            f_cth_d = ex.submit(fetch_rolling_polar_wms, LAYER_SUITES["cth_day"], lut_cth, today_str, yesterday_str, fallback_day_str)
            f_cf_n = ex.submit(fetch_rolling_polar_wms, LAYER_SUITES["cf_night"], lut_cf, today_str, yesterday_str, fallback_day_str)
            f_cf_d = ex.submit(fetch_rolling_polar_wms, LAYER_SUITES["cf_day"], lut_cf, today_str, yesterday_str, fallback_day_str)

            vir_n = f_vir_n.result()
            vir_d = f_vir_d.result()
            cth_n = f_cth_n.result()
            cth_d = f_cth_d.result()
            cf_n = f_cf_n.result()
            cf_d = f_cf_d.result()

        t_sfc_night_k, t_sfc_day_k, is_ocean = load_reference_surface_temperature_k(args.output_dir)
        sub_low, sub_mid = load_subcanopy_cloud_priors(args.output_dir)
        viirs_ir_k, cth_m, t_sfc_ref_k = merge_day_night_viirs_passes(
            vir_n=vir_n,
            vir_d=vir_d,
            cth_n=cth_n,
            cth_d=cth_d,
            t_sfc_night_k=t_sfc_night_k,
            t_sfc_day_k=t_sfc_day_k,
            is_ocean=is_ocean,
        )
        cf = merge_day_night_cf_passes(cf_n=cf_n, cf_d=cf_d)

        low_cov, mid_cov, high_cov, rad_opt = stratify_satellite_clouds(
            cth_m=cth_m,
            cot=None,
            cf=cf,
            geo_ir_c=None,
            viirs_ir_k=viirs_ir_k,
            t_sfc_k=t_sfc_ref_k,
            is_ocean=is_ocean,
            subcanopy_low=sub_low,
            subcanopy_mid=sub_mid,
        )
        meta = write_outputs(args.output_dir, low_cov, mid_cov, high_cov, rad_opt, padded=padded, mode="live_nasa_gibs")
        elapsed = time.perf_counter() - t0
        print(
            f"[OK] Staged NASA GIBS 3D Volumetric Satellite Cloud Strata in {elapsed:.1f}s:\n"
            f"     Low  (0-2.5km): mean={meta['strata']['low']['mean']:.3f}, p90={meta['strata']['low']['p90']:.3f}, clear={meta['strata']['low']['clearSkyFraction']*100:.1f}%\n"
            f"     Mid  (2.5-6.5km): mean={meta['strata']['mid']['mean']:.3f}, p90={meta['strata']['mid']['p90']:.3f}, clear={meta['strata']['mid']['clearSkyFraction']*100:.1f}%\n"
            f"     High (6.5-12km): mean={meta['strata']['high']['mean']:.3f}, p90={meta['strata']['high']['p90']:.3f}, clear={meta['strata']['high']['clearSkyFraction']*100:.1f}%\n"
            f"     Optical Depth : mean={meta['strata']['radiative_optical_depth']['mean']:.3f}, p90={meta['strata']['radiative_optical_depth']['p90']:.3f}"
        )
    except Exception as exc:
        print(f"[WARN] Live NASA GIBS fetch encountered an error ({exc}); falling back to existing or synthetic strata.")
        if os.path.exists(low_path):
            print("[OK] Preserved existing cached satellite-cloud-*-latest.bin slices.")
            return
        low, mid, high, rad = generate_mock_satellite_strata()
        write_outputs(args.output_dir, low, mid, high, rad, padded=padded, mode="fallback_mock")


if __name__ == "__main__":
    main()
