// ============================================================================
// File: src/core/workers/decodeTasks.ts
// Pure, deterministic binary decoding, resampling, and Float16 packing routines
// shared between Web Workers (decodeWorker.ts) and main-thread fallback.
// Zero WGSL changes; bit-exact parity with Phase 2 rg16float/rgba16float layouts.
// ============================================================================

import { decodeFloat16, encodeFloat16 } from '../math/float16';

const _f16EncF32 = new Float32Array(1);
const _f16EncU32 = new Uint32Array(_f16EncF32.buffer);
function encodeFloat16Fast(val: number): number {
  if (val === 0) return 0;
  _f16EncF32[0] = val;
  const bits = _f16EncU32[0];
  const sign = (bits >>> 16) & 0x8000;
  const exp = ((bits >>> 23) & 0xff) - 127 + 15;
  const mant = bits & 0x007fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    const sub = (mant | 0x00800000) >>> (1 - exp);
    return sign | ((sub + 0x00001000) >>> 13);
  }
  if (exp >= 31) {
    return sign | 0x7c00 | (mant ? 0x0200 : 0);
  }
  return sign | ((exp << 10) + ((mant + 0x00001000) >>> 13));
}

const FLOAT16_DEC_LUT = new Float32Array(65536);
for (let i = 0; i < 65536; i++) {
  FLOAT16_DEC_LUT[i] = decodeFloat16(i);
}

const PRECULL_COL_BINS_3600 = (() => {
  const bins = new Uint8Array(3600);
  for (let c = 0; c < 3600; c++) {
    const b = Math.floor((c * 225) / 3600);
    bins[c] = b > 224 ? 224 : b;
  }
  return bins;
})();

function downsampleColBin(c: number, width: number): number {
  if (width === 3600) return PRECULL_COL_BINS_3600[c];
  const bin = Math.floor((c * 225) / width);
  return bin > 224 ? 224 : bin;
}

// Worker-local LRU cache for parent z=10 Terrarium bathymetry tiles
const workerBathyZ10Cache = new Map<string, Promise<Float32Array | null>>();

export interface WeatherNextScalarSpeedRequest {
  type: 'weathernext_scalar_speed';
  vectorBuffer: ArrayBuffer;
}

export interface WeatherNextScalarSpeedResponse {
  type: 'weathernext_scalar_speed';
  scalarBuffer: ArrayBuffer;
}

export interface WeatherNextCloudDualHourRequest {
  type: 'weathernext_cloud_dual_hour';
  url0?: string;
  url1?: string;
  buf0?: ArrayBuffer;
  buf1?: ArrayBuffer;
  width: number;
  height: number;
}

export interface WeatherNextCloudDualHourResponse {
  type: 'weathernext_cloud_dual_hour';
  ok: boolean;
  interleavedBuffer?: ArrayBuffer;
  paddedRowBytes?: number;
  preCullMaxBuffer?: ArrayBuffer;
}

export interface WeatherNextThermoPackRequest {
  type: 'weathernext_thermo_pack';
  kind: 'temp' | 'dew';
  url: string;
  opticalDepthUrlOverride?: string;
}

export interface WeatherNextThermoPackResponse {
  type: 'weathernext_thermo_pack';
  ok: boolean;
  paddedBuffer?: ArrayBuffer;
  texW?: number;
  texH?: number;
  texFormat?: 'r16float' | 'rg16float' | 'rgba16float';
  uploadBytesPerRow?: number;
  packedFlagsMask?: number;
  packedFlagsValue?: number;
  preCullThermoBuffer?: ArrayBuffer;
}

export interface WeatherNextWindPackRequest {
  type: 'weathernext_wind_pack';
  url: string;
  extractSlot0RawU16: boolean;
  jetRawBuffer?: ArrayBuffer;
  jetW?: number;
  jetH?: number;
}

export interface WeatherNextWindPackResponse {
  type: 'weathernext_wind_pack';
  ok: boolean;
  paddedBuffer?: ArrayBuffer;
  rawU16Buffer?: ArrayBuffer;
  interleavedRgbaBuffer?: ArrayBuffer;
  interleavedRowBytesPadded?: number;
  windW?: number;
  windH?: number;
  rowBytesPadded?: number;
}

export interface WindJetInterleaveRequest {
  type: 'wind_jet_interleave';
  surfRawBuffer: ArrayBuffer;
  windW: number;
  windH: number;
  jetRawBuffer: ArrayBuffer;
  jetW: number;
  jetH: number;
}

export interface WindJetInterleaveResponse {
  type: 'wind_jet_interleave';
  interleavedRgbaBuffer: ArrayBuffer;
  rowBytesPadded: number;
  windW: number;
  windH: number;
}

export interface TerrariumDecodeTileRequest {
  type: 'terrarium_decode_tile';
  z: number;
  tx: number;
  ty: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  rgbaBuffer?: ArrayBuffer;
}

export interface TerrariumDecodeTileResponse {
  type: 'terrarium_decode_tile';
  ok: boolean;
  tx: number;
  ty: number;
  elevBuffer?: ArrayBuffer;
}

export interface PackElevationTilesRG16Request {
  type: 'pack_elevation_tiles_rg16';
  tileDimension: number;
  tiles: Array<{
    key: string;
    slot: number;
    elevBuffer: ArrayBuffer;
  }>;
}

export interface PackElevationTilesRG16Response {
  type: 'pack_elevation_tiles_rg16';
  tiles: Array<{
    key: string;
    slot: number;
    f16Buffer: ArrayBuffer;
  }>;
}

export interface GeoTIFFDecodeTilesRequest {
  type: 'geotiff_decode_tiles';
  tiles: Array<{
    cacheKey: string;
    rawBuffer: ArrayBuffer;
    compression: number;
    tileW: number;
    tileH: number;
    sampleFormat: number;
    bitsPerSample: number;
  }>;
}

export interface GeoTIFFDecodeTilesResponse {
  type: 'geotiff_decode_tiles';
  tiles: Array<{
    cacheKey: string;
    elevBuffer: ArrayBuffer;
  }>;
}

export interface WeatherNextSlicePadRequest {
  type: 'weathernext_slice_pad';
  url: string;
  rawRowBytes: number;
  paddedRowBytes: number;
  height: number;
}

export interface WeatherNextSlicePadResponse {
  type: 'weathernext_slice_pad';
  ok: boolean;
  buffer?: ArrayBuffer;
}

export type DecodeWorkerRequest =
  | WeatherNextScalarSpeedRequest
  | WeatherNextCloudDualHourRequest
  | WeatherNextThermoPackRequest
  | WeatherNextWindPackRequest
  | WindJetInterleaveRequest
  | TerrariumDecodeTileRequest
  | PackElevationTilesRG16Request
  | GeoTIFFDecodeTilesRequest
  | WeatherNextSlicePadRequest;

export type DecodeWorkerResponse =
  | WeatherNextScalarSpeedResponse
  | WeatherNextCloudDualHourResponse
  | WeatherNextThermoPackResponse
  | WeatherNextWindPackResponse
  | WindJetInterleaveResponse
  | TerrariumDecodeTileResponse
  | PackElevationTilesRG16Response
  | GeoTIFFDecodeTilesResponse
  | WeatherNextSlicePadResponse;

async function fetchValidBinary(url: string): Promise<ArrayBuffer | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers?.get?.('content-type') || '';
    if (ct.includes('text/html') || ct.includes('text/plain')) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

export function extractWeatherNextScalarSpeed(vectorBuffer: ArrayBuffer): ArrayBuffer {
  const isPaddedVector = vectorBuffer.byteLength === 26280192;
  const srcU16 = new Uint16Array(vectorBuffer);
  const dstBuffer = new ArrayBuffer(13370624); // 3712 * 1801 * 2
  const dstU16 = new Uint16Array(dstBuffer);

  const srcStrideU16 = isPaddedVector ? 7296 : 7200;
  const dstStrideU16 = 3712;

  for (let r = 0; r < 1801; r++) {
    const srcRowOff = r * srcStrideU16;
    const dstRowOff = r * dstStrideU16;
    for (let c = 0; c < 3600; c++) {
      const u = FLOAT16_DEC_LUT[srcU16[srcRowOff + c * 2]];
      const v = FLOAT16_DEC_LUT[srcU16[srcRowOff + c * 2 + 1]];
      dstU16[dstRowOff + c] = encodeFloat16(Math.hypot(u, v));
    }
  }
  return dstBuffer;
}

export function interleaveDualHourCloudAndPreCull(
  data0: ArrayBuffer,
  data1: ArrayBuffer,
  width: number,
  height: number
): { interleavedBuffer: ArrayBuffer; paddedRowBytes: number; preCullMaxBuffer: ArrayBuffer } {
  const paddedRowBytes = Math.ceil((width * 4) / 256) * 256;
  const vecColsPadded = paddedRowBytes >> 2;
  const src0 = new Uint16Array(data0);
  const src1 = new Uint16Array(data1);
  const src0RowU16 = data0.byteLength === 13370624 ? 3712 : width;
  const src1RowU16 = data1.byteLength === 13370624 ? 3712 : width;
  const interleaved = new Uint16Array(height * vecColsPadded * 2);
  const preCullDst = new Float32Array(225 * 113);

  const canFastBin = width >= 225 && height >= 113;

  for (let r = 0; r < height; r++) {
    const off0 = r * src0RowU16;
    const off1 = r * src1RowU16;
    const dstOff = r * vecColsPadded * 2;

    if (canFastBin && off0 + width <= src0.length && off1 + width <= src1.length) {
      const iy = Math.min(112, Math.floor((r * 113) / height));
      const binRowOff = iy * 225;
      for (let c = 0; c < width; c++) {
        const u0 = src0[off0 + c];
        const u1 = src1[off1 + c];
        const dstIdx = dstOff + c * 2;
        interleaved[dstIdx] = u0;
        interleaved[dstIdx + 1] = u1;

        const v0 = FLOAT16_DEC_LUT[u0];
        const v1 = FLOAT16_DEC_LUT[u1];
        const val = v0 > v1 ? v0 : v1;
        if (val > 0.0 && val <= 4.0) {
          const cellIdx = binRowOff + downsampleColBin(c, width);
          if (val > preCullDst[cellIdx]) preCullDst[cellIdx] = val;
        }
      }
    } else {
      for (let c = 0; c < width; c++) {
        const dstIdx = dstOff + c * 2;
        interleaved[dstIdx] = src0[off0 + c];
        interleaved[dstIdx + 1] = src1[off1 + c];
      }
    }
  }

  if (!canFastBin) {
    for (let iy = 0; iy < 113; iy++) {
      const r = Math.min(height - 1, Math.floor(((iy + 0.5) * height) / 113));
      const off0 = r * src0RowU16;
      const off1 = r * src1RowU16;
      for (let ix = 0; ix < 225; ix++) {
        const c = Math.min(width - 1, Math.floor(((ix + 0.5) * width) / 225));
        const v0 = off0 + c < src0.length ? FLOAT16_DEC_LUT[src0[off0 + c]] : 1.0;
        const v1 = off1 + c < src1.length ? FLOAT16_DEC_LUT[src1[off1 + c]] : 1.0;
        const val = Math.max(Number.isFinite(v0) ? v0 : 1.0, Number.isFinite(v1) ? v1 : 1.0);
        preCullDst[iy * 225 + ix] = Math.max(0.0, val);
      }
    }
  }

  return {
    interleavedBuffer: interleaved.buffer,
    paddedRowBytes,
    preCullMaxBuffer: preCullDst.buffer,
  };
}

function computeThermoPreCull(
  kind: 'temp' | 'dew',
  buffer: ArrayBuffer,
  width: number,
  height: number,
  isPadded3600: boolean
): ArrayBuffer {
  const dst = new Float32Array(225 * 113);
  const srcU16 = new Uint16Array(buffer, 0, buffer.byteLength >> 1);
  const rowStrideU16 = isPadded3600 ? 3712 : width;
  const isTemp = kind === 'temp';
  dst.fill(isTemp ? 1e6 : -1e6);

  if (width >= 225 && height >= 113) {
    for (let r = 0; r < height; r++) {
      const iy = Math.min(112, Math.floor((r * 113) / height));
      const binRowOff = iy * 225;
      const srcRowOff = r * rowStrideU16;
      if (srcRowOff + width > srcU16.length) break;
      for (let c = 0; c < width; c++) {
        const raw = FLOAT16_DEC_LUT[srcU16[srcRowOff + c]];
        if (Number.isFinite(raw) && raw > -120.0 && raw < 400.0) {
          const celsius = raw > 150.0 ? raw - 273.15 : raw;
          const cellIdx = binRowOff + downsampleColBin(c, width);
          if (isTemp) {
            if (celsius < dst[cellIdx]) dst[cellIdx] = celsius;
          } else {
            if (celsius > dst[cellIdx]) dst[cellIdx] = celsius;
          }
        }
      }
    }
  } else {
    for (let iy = 0; iy < 113; iy++) {
      const r = Math.min(height - 1, Math.floor(((iy + 0.5) * height) / 113));
      const srcRowOff = r * rowStrideU16;
      for (let ix = 0; ix < 225; ix++) {
        const c = Math.min(width - 1, Math.floor(((ix + 0.5) * width) / 225));
        const idx = srcRowOff + c;
        const raw = idx < srcU16.length ? FLOAT16_DEC_LUT[srcU16[idx]] : NaN;
        if (Number.isFinite(raw) && raw > -120.0 && raw < 400.0) {
          dst[iy * 225 + ix] = raw > 150.0 ? raw - 273.15 : raw;
        }
      }
    }
  }

  for (let i = 0; i < 225 * 113; i++) {
    if (isTemp) {
      if (dst[i] > 9e5) dst[i] = -100.0;
    } else {
      if (dst[i] < -9e5) dst[i] = 100.0;
    }
  }

  return dst.buffer;
}

async function handleThermoPack(req: WeatherNextThermoPackRequest): Promise<WeatherNextThermoPackResponse> {
  let buffer = await fetchValidBinary(req.url);
  if (!buffer) {
    if (req.kind === 'temp' && req.url === '/data/weathernext/temperature_2m_mean-0.bin') {
      buffer = await fetchValidBinary('/data/weathernext/temp-00.bin');
    } else if (req.kind === 'dew' && req.url === '/data/weathernext/dewpoint_temperature_2m_mean-0.bin') {
      buffer = await fetchValidBinary('/data/weathernext/dewpoint-00.bin');
    }
  }
  if (!buffer || buffer.byteLength < 2) {
    return { type: 'weathernext_thermo_pack', ok: false };
  }

  const bytesPerTexel = 2;
  let texW = 3600;
  let texH = 1801;
  const isPadded3600 = buffer.byteLength === 13370624;

  if (isPadded3600) {
    texW = 3600;
    texH = 1801;
  } else if (buffer.byteLength === 1440 * 721 * bytesPerTexel) {
    texW = 1440;
    texH = 721;
  } else if (buffer.byteLength === 360 * 181 * bytesPerTexel) {
    texW = 360;
    texH = 181;
  } else if (buffer.byteLength !== 3600 * 1801 * bytesPerTexel) {
    texW = Math.max(1, Math.round(Math.sqrt(buffer.byteLength / (2 * bytesPerTexel))));
    texH = Math.max(1, Math.floor(buffer.byteLength / (texW * bytesPerTexel)));
  }

  const rowBytesRaw = texW * bytesPerTexel;
  const bytesPerRow = Math.ceil(rowBytesRaw / 256) * 256;
  const preCullThermoBuffer = computeThermoPreCull(req.kind, buffer, texW, texH, isPadded3600);

  if (req.kind === 'temp') {
    let sstBuf: ArrayBuffer | null = null;
    let mslpBuf: ArrayBuffer | null = null;
    let spreadBuf: ArrayBuffer | null = null;
    if (isPadded3600 && req.url.includes('temperature_2m_mean-')) {
      const fetch13M = async (u: string) => {
        const b = await fetchValidBinary(u);
        return b && b.byteLength === 13370624 ? b : null;
      };
      [sstBuf, mslpBuf, spreadBuf] = await Promise.all([
        fetch13M(req.url.replace('temperature_2m_mean-', 'sea_surface_temperature_mean-')),
        fetch13M(req.url.replace('temperature_2m_mean-', 'mean_sea_level_pressure_mean-')),
        fetch13M(req.url.replace('temperature_2m_mean-', 'convective_spread-')),
      ]);
    }

    if (isPadded3600 && (mslpBuf || spreadBuf)) {
      const rgbaColsPadded = 3616;
      const srcR = new Uint16Array(buffer);
      const srcG = sstBuf ? new Uint16Array(sstBuf) : null;
      const srcB = mslpBuf ? new Uint16Array(mslpBuf) : null;
      const srcA = spreadBuf ? new Uint16Array(spreadBuf) : null;
      const interleaved = new Uint16Array(texH * rgbaColsPadded * 4);
      for (let r = 0; r < texH; r++) {
        const srcRowOff = r * 3712;
        const dstRowOff = r * rgbaColsPadded * 4;
        for (let c = 0; c < texW; c++) {
          const dstIdx = dstRowOff + c * 4;
          const rBits = srcR[srcRowOff + c];
          const rawGBits = srcG ? srcG[srcRowOff + c] : rBits;
          const isSentinelSST = (rawGBits & 0x8000) !== 0 && (rawGBits & 0x7fff) > 0x4500;
          interleaved[dstIdx] = rBits;
          interleaved[dstIdx + 1] = isSentinelSST ? rBits : rawGBits;
          interleaved[dstIdx + 2] = srcB ? srcB[srcRowOff + c] : 0;
          interleaved[dstIdx + 3] = srcA ? srcA[srcRowOff + c] : 0;
        }
      }
      return {
        type: 'weathernext_thermo_pack',
        ok: true,
        paddedBuffer: interleaved.buffer,
        texW,
        texH,
        texFormat: 'rgba16float',
        uploadBytesPerRow: 28928,
        packedFlagsMask: 2,
        packedFlagsValue: mslpBuf && spreadBuf ? 2 : 0,
        preCullThermoBuffer,
      };
    }

    if (isPadded3600 && sstBuf) {
      const vecColsPadded = 3648;
      const srcR = new Uint16Array(buffer);
      const srcG = new Uint16Array(sstBuf);
      const interleaved = new Uint16Array(texH * vecColsPadded * 2);
      for (let r = 0; r < texH; r++) {
        const srcRowOff = r * 3712;
        const dstRowOff = r * vecColsPadded * 2;
        for (let c = 0; c < texW; c++) {
          const dstIdx = dstRowOff + c * 2;
          const rBits = srcR[srcRowOff + c];
          const gBits = srcG[srcRowOff + c];
          const isSentinelSST = (gBits & 0x8000) !== 0 && (gBits & 0x7fff) > 0x4500;
          interleaved[dstIdx] = rBits;
          interleaved[dstIdx + 1] = isSentinelSST ? rBits : gBits;
        }
      }
      return {
        type: 'weathernext_thermo_pack',
        ok: true,
        paddedBuffer: interleaved.buffer,
        texW,
        texH,
        texFormat: 'rg16float',
        uploadBytesPerRow: 14592,
        packedFlagsMask: 2,
        packedFlagsValue: 0,
        preCullThermoBuffer,
      };
    }

    if (isPadded3600) {
      return {
        type: 'weathernext_thermo_pack',
        ok: true,
        paddedBuffer: buffer,
        texW,
        texH,
        texFormat: 'r16float',
        uploadBytesPerRow: bytesPerRow,
        packedFlagsMask: 2,
        packedFlagsValue: 0,
        preCullThermoBuffer,
      };
    }

    const padded = new Uint8Array(bytesPerRow * texH);
    const srcU8 = new Uint8Array(buffer);
    for (let r = 0; r < texH; r++) {
      padded.set(srcU8.subarray(r * rowBytesRaw, (r + 1) * rowBytesRaw), r * bytesPerRow);
    }
    return {
      type: 'weathernext_thermo_pack',
      ok: true,
      paddedBuffer: padded.buffer,
      texW,
      texH,
      texFormat: 'r16float',
      uploadBytesPerRow: bytesPerRow,
      packedFlagsMask: 2,
      packedFlagsValue: 0,
      preCullThermoBuffer,
    };
  }

  // kind === 'dew'
  let optBuf: ArrayBuffer | null = null;
  let w100Buf: ArrayBuffer | null = null;
  if (isPadded3600 && req.url.includes('dewpoint_temperature_2m_mean-')) {
    const optUrl =
      req.opticalDepthUrlOverride ??
      req.url.replace('dewpoint_temperature_2m_mean-', 'radiative_optical_depth-');
    const w100Url = req.url.replace('dewpoint_temperature_2m_mean-', 'wind_100m_vector-');
    const [oCandidate, wCandidate] = await Promise.all([
      fetchValidBinary(optUrl),
      fetchValidBinary(w100Url),
    ]);
    if (oCandidate && oCandidate.byteLength === 13370624) optBuf = oCandidate;
    if (wCandidate && (wCandidate.byteLength === 26280192 || wCandidate.byteLength === 25934400)) {
      w100Buf = wCandidate;
    }
  }

  if (isPadded3600 && w100Buf) {
    const rgbaColsPadded = 3616;
    const srcR = new Uint16Array(buffer);
    const srcG = optBuf ? new Uint16Array(optBuf) : null;
    const srcW100 = new Uint16Array(w100Buf);
    const w100RowU16 = w100Buf.byteLength === 26280192 ? 7296 : 7200;
    const interleaved = new Uint16Array(texH * rgbaColsPadded * 4);
    for (let r = 0; r < texH; r++) {
      const srcRowOff = r * 3712;
      const wRowOff = r * w100RowU16;
      const dstRowOff = r * rgbaColsPadded * 4;
      for (let c = 0; c < texW; c++) {
        const dstIdx = dstRowOff + c * 4;
        const wIdx = wRowOff + c * 2;
        interleaved[dstIdx] = srcR[srcRowOff + c];
        interleaved[dstIdx + 1] = srcG ? srcG[srcRowOff + c] : 0;
        interleaved[dstIdx + 2] = srcW100[wIdx];
        interleaved[dstIdx + 3] = srcW100[wIdx + 1];
      }
    }
    return {
      type: 'weathernext_thermo_pack',
      ok: true,
      paddedBuffer: interleaved.buffer,
      texW,
      texH,
      texFormat: 'rgba16float',
      uploadBytesPerRow: 28928,
      packedFlagsMask: 4,
      packedFlagsValue: 4,
      preCullThermoBuffer,
    };
  }

  if (isPadded3600 && optBuf) {
    const vecColsPadded = 3648;
    const srcR = new Uint16Array(buffer);
    const srcG = new Uint16Array(optBuf);
    const interleaved = new Uint16Array(texH * vecColsPadded * 2);
    for (let r = 0; r < texH; r++) {
      const srcRowOff = r * 3712;
      const dstRowOff = r * vecColsPadded * 2;
      for (let c = 0; c < texW; c++) {
        const dstIdx = dstRowOff + c * 2;
        interleaved[dstIdx] = srcR[srcRowOff + c];
        interleaved[dstIdx + 1] = srcG[srcRowOff + c];
      }
    }
    return {
      type: 'weathernext_thermo_pack',
      ok: true,
      paddedBuffer: interleaved.buffer,
      texW,
      texH,
      texFormat: 'rg16float',
      uploadBytesPerRow: 14592,
      packedFlagsMask: 4,
      packedFlagsValue: 0,
      preCullThermoBuffer,
    };
  }

  if (isPadded3600) {
    return {
      type: 'weathernext_thermo_pack',
      ok: true,
      paddedBuffer: buffer,
      texW,
      texH,
      texFormat: 'r16float',
      uploadBytesPerRow: bytesPerRow,
      packedFlagsMask: 4,
      packedFlagsValue: 0,
      preCullThermoBuffer,
    };
  }

  const padded = new Uint8Array(bytesPerRow * texH);
  const srcU8 = new Uint8Array(buffer);
  for (let r = 0; r < texH; r++) {
    padded.set(srcU8.subarray(r * rowBytesRaw, (r + 1) * rowBytesRaw), r * bytesPerRow);
  }
  return {
    type: 'weathernext_thermo_pack',
    ok: true,
    paddedBuffer: padded.buffer,
    texW,
    texH,
    texFormat: 'r16float',
    uploadBytesPerRow: bytesPerRow,
    packedFlagsMask: 4,
    packedFlagsValue: 0,
    preCullThermoBuffer,
  };
}

async function handleWindPack(req: WeatherNextWindPackRequest): Promise<WeatherNextWindPackResponse> {
  let buffer = await fetchValidBinary(req.url);
  if (!buffer && req.url.includes('wind_10m_vector')) {
    buffer = await fetchValidBinary('/data/gfs-wind-latest.bin');
  }
  if (!buffer) {
    return { type: 'weathernext_wind_pack', ok: false };
  }

  const len = buffer.byteLength;
  let windW = 360;
  let windH = 181;
  let rowBytesRaw = 1440;
  let rowBytesPadded = 1536;
  let paddedBuffer: ArrayBuffer;

  if (len === 26280192) {
    windW = 3600;
    windH = 1801;
    rowBytesRaw = 14400;
    rowBytesPadded = 14592;
    paddedBuffer = buffer;
  } else if (len === 25934400) {
    windW = 3600;
    windH = 1801;
    rowBytesRaw = 14400;
    rowBytesPadded = 14592;
    const padded = new Uint8Array(rowBytesPadded * windH);
    const src = new Uint8Array(buffer);
    for (let y = 0; y < windH; y++) {
      padded.set(src.subarray(y * rowBytesRaw, (y + 1) * rowBytesRaw), y * rowBytesPadded);
    }
    paddedBuffer = padded.buffer;
  } else if (len === 4245248) {
    windW = 1440;
    windH = 721;
    rowBytesRaw = 5760;
    rowBytesPadded = 5888;
    paddedBuffer = buffer;
  } else if (len === 4152960) {
    windW = 1440;
    windH = 721;
    rowBytesRaw = 5760;
    rowBytesPadded = 5888;
    const padded = new Uint8Array(rowBytesPadded * windH);
    const src = new Uint8Array(buffer);
    for (let y = 0; y < windH; y++) {
      padded.set(src.subarray(y * rowBytesRaw, (y + 1) * rowBytesRaw), y * rowBytesPadded);
    }
    paddedBuffer = padded.buffer;
  } else if (len === 278016) {
    windW = 360;
    windH = 181;
    rowBytesRaw = 1440;
    rowBytesPadded = 1536;
    paddedBuffer = buffer;
  } else if (len === 260640) {
    windW = 360;
    windH = 181;
    rowBytesRaw = 1440;
    rowBytesPadded = 1536;
    const padded = new Uint8Array(rowBytesPadded * windH);
    const src = new Uint8Array(buffer);
    for (let y = 0; y < windH; y++) {
      padded.set(src.subarray(y * rowBytesRaw, (y + 1) * rowBytesRaw), y * rowBytesPadded);
    }
    paddedBuffer = padded.buffer;
  } else {
    const bytesPerTexel = 4;
    windW = Math.max(1, Math.round(Math.sqrt(len / (2 * bytesPerTexel))));
    windH = Math.max(1, Math.floor(len / (windW * bytesPerTexel)));
    rowBytesRaw = windW * bytesPerTexel;
    rowBytesPadded = Math.ceil(rowBytesRaw / 256) * 256;
    const padded = new Uint8Array(rowBytesPadded * windH);
    const src = new Uint8Array(buffer);
    for (let y = 0; y < windH; y++) {
      padded.set(src.subarray(y * rowBytesRaw, (y + 1) * rowBytesRaw), y * rowBytesPadded);
    }
    paddedBuffer = padded.buffer;
  }

  let rawU16Buffer: ArrayBuffer | undefined;
  let interleavedRgbaBuffer: ArrayBuffer | undefined;
  let interleavedRowBytesPadded: number | undefined;
  if (req.extractSlot0RawU16) {
    const rawU16 = new Uint16Array(windW * windH * 2);
    const paddedU16 = new Uint16Array(paddedBuffer, 0, Math.floor(paddedBuffer.byteLength / 2));
    const rowU16Stride = rowBytesPadded >> 1;
    for (let y = 0; y < windH; y++) {
      const srcRow = y * rowU16Stride;
      rawU16.set(paddedU16.subarray(srcRow, srcRow + windW * 2), y * windW * 2);
    }
    rawU16Buffer = rawU16.buffer;

    if (
      req.jetRawBuffer &&
      typeof req.jetW === 'number' &&
      typeof req.jetH === 'number' &&
      req.jetW > 0 &&
      req.jetH > 0
    ) {
      const merged = interleaveSurfaceWindAndJet(
        rawU16,
        windW,
        windH,
        new Uint16Array(req.jetRawBuffer),
        req.jetW,
        req.jetH
      );
      interleavedRgbaBuffer = merged.interleavedRgbaBuffer;
      interleavedRowBytesPadded = merged.rowBytesPadded;
    }
  }

  return {
    type: 'weathernext_wind_pack',
    ok: true,
    paddedBuffer,
    rawU16Buffer,
    interleavedRgbaBuffer,
    interleavedRowBytesPadded,
    windW,
    windH,
    rowBytesPadded,
  };
}

export function interleaveSurfaceWindAndJet(
  surfU16: Uint16Array,
  windW: number,
  windH: number,
  jetU16: Uint16Array,
  jetW: number,
  jetH: number
): { interleavedRgbaBuffer: ArrayBuffer; rowBytesPadded: number } {
  const rowBytesRaw = windW * 8; // 4 x Float16 = 8 bytes per texel
  const rowBytesPadded = Math.ceil(rowBytesRaw / 256) * 256;
  const rowU16Stride = rowBytesPadded >> 1;
  const interleavedU16 = new Uint16Array(rowU16Stride * windH);

  const x0Arr = new Int32Array(windW);
  const x1Arr = new Int32Array(windW);
  const txArr = new Float32Array(windW);
  const jetScaleX = windW > 1 ? (jetW - 1) / (windW - 1) : 0;
  for (let x = 0; x < windW; x++) {
    const uSrc = x * jetScaleX;
    const x0 = Math.min(jetW - 1, Math.floor(uSrc));
    x0Arr[x] = x0 * 2;
    x1Arr[x] = Math.min(jetW - 1, x0 + 1) * 2;
    txArr[x] = uSrc - x0;
  }

  const jetScaleY = windH > 1 ? (jetH - 1) / (windH - 1) : 0;
  for (let y = 0; y < windH; y++) {
    const vSrc = y * jetScaleY;
    const y0 = Math.min(jetH - 1, Math.floor(vSrc));
    const y1 = Math.min(jetH - 1, y0 + 1);
    const ty = vSrc - y0;
    const oneMinusTy = 1.0 - ty;
    const surfRowOff = y * windW * 2;
    const jetRow0Off = y0 * jetW * 2;
    const jetRow1Off = y1 * jetW * 2;
    const dstRowOff = y * rowU16Stride;

    for (let x = 0; x < windW; x++) {
      const jx0 = x0Arr[x];
      const jx1 = x1Arr[x];
      const tx = txArr[x];
      const oneMinusTx = 1.0 - tx;

      const u00 = FLOAT16_DEC_LUT[jetU16[jetRow0Off + jx0]];
      const v00 = FLOAT16_DEC_LUT[jetU16[jetRow0Off + jx0 + 1]];
      const u10 = FLOAT16_DEC_LUT[jetU16[jetRow0Off + jx1]];
      const v10 = FLOAT16_DEC_LUT[jetU16[jetRow0Off + jx1 + 1]];
      const u01 = FLOAT16_DEC_LUT[jetU16[jetRow1Off + jx0]];
      const v01 = FLOAT16_DEC_LUT[jetU16[jetRow1Off + jx0 + 1]];
      const u11 = FLOAT16_DEC_LUT[jetU16[jetRow1Off + jx1]];
      const v11 = FLOAT16_DEC_LUT[jetU16[jetRow1Off + jx1 + 1]];

      const uTop = u00 * oneMinusTx + u10 * tx;
      const uBot = u01 * oneMinusTx + u11 * tx;
      const vTop = v00 * oneMinusTx + v10 * tx;
      const vBot = v01 * oneMinusTx + v11 * tx;

      const uJet = encodeFloat16Fast(uTop * oneMinusTy + uBot * ty);
      let vJet = encodeFloat16Fast(vTop * oneMinusTy + vBot * ty);
      // Avoid (0.0, 1.0) hardware rg16float default swizzle collision (0x0000, 0x3C00)
      if ((uJet & 0x7fff) === 0 && vJet === 0x3c00) {
        vJet = 0x3c02;
      }

      const dstIdx = dstRowOff + x * 4;
      interleavedU16[dstIdx] = surfU16[surfRowOff + x * 2];
      interleavedU16[dstIdx + 1] = surfU16[surfRowOff + x * 2 + 1];
      interleavedU16[dstIdx + 2] = uJet;
      interleavedU16[dstIdx + 3] = vJet;
    }
  }

  return {
    interleavedRgbaBuffer: interleavedU16.buffer,
    rowBytesPadded,
  };
}

export function sanitizeMaritimeCutouts256(merc: Float32Array): void {
  const cutoutMask = new Uint8Array(256 * 256);
  let hasCutout = false;
  for (let r = 0; r < 256; r++) {
    const r0 = Math.max(0, r - 3);
    const r1 = Math.min(255, r + 3);
    for (let c = 0; c < 256; c++) {
      const idx = r * 256 + c;
      const v = merc[idx];
      if (v >= -0.25 && v <= 0.05) {
        let nearLand = false;
        const c0 = Math.max(0, c - 3);
        const c1 = Math.min(255, c + 3);
        for (let nr = r0; nr <= r1 && !nearLand; nr++) {
          const rowOff = nr * 256;
          for (let nc = c0; nc <= c1; nc++) {
            if (merc[rowOff + nc] > 0.5) {
              nearLand = true;
              break;
            }
          }
        }
        if (!nearLand) {
          cutoutMask[idx] = 1;
          hasCutout = true;
        }
      }
    }
  }
  if (!hasCutout) return;
  for (let r = 0; r < 256; r++) {
    const r0 = Math.max(0, r - 3);
    const r1 = Math.min(255, r + 3);
    for (let c = 0; c < 256; c++) {
      const idx = r * 256 + c;
      if (merc[idx] < -0.25) {
        const c0 = Math.max(0, c - 3);
        const c1 = Math.min(255, c + 3);
        let nearCutout = false;
        for (let nr = r0; nr <= r1 && !nearCutout; nr++) {
          const rowOff = nr * 256;
          for (let nc = c0; nc <= c1; nc++) {
            if (cutoutMask[rowOff + nc]) {
              nearCutout = true;
              break;
            }
          }
        }
        if (nearCutout) {
          merc[idx] = 0.0;
        }
      }
    }
  }
}

let consecutiveTerrariumFetchErrors = 0;
let terrariumCooldownUntilMs = 0;

async function fetchTerrariumWithBreaker(url: string): Promise<Response | null> {
  const now = Date.now();
  if (now < terrariumCooldownUntilMs) {
    return null;
  }
  try {
    const fetchOpts: RequestInit = { mode: 'cors' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      fetchOpts.signal = AbortSignal.timeout(2500);
    }
    const res = await fetch(url, fetchOpts);
    consecutiveTerrariumFetchErrors = 0;
    terrariumCooldownUntilMs = 0;
    return res;
  } catch {
    consecutiveTerrariumFetchErrors++;
    if (consecutiveTerrariumFetchErrors >= 2) {
      terrariumCooldownUntilMs = Date.now() + 15000;
    }
    return null;
  }
}

async function getWorkerSlippyBathyZ10(tx10: number, ty10: number): Promise<Float32Array | null> {
  const key10 = `${tx10}:${ty10}`;
  let p = workerBathyZ10Cache.get(key10);
  if (p) return p;
  if (workerBathyZ10Cache.size >= 64) {
    const oldest = workerBathyZ10Cache.keys().next().value;
    if (oldest !== undefined) workerBathyZ10Cache.delete(oldest);
  }
  const url10 = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/${tx10}/${ty10}.png`;
  p = (async () => {
    try {
      const res = await fetchTerrariumWithBreaker(url10);
      if (!res || !res.ok || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
        return null;
      }
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const osc = new OffscreenCanvas(256, 256);
      const ctx = osc.getContext('2d');
      if (!ctx) {
        bmp.close?.();
        return null;
      }
      ctx.drawImage(bmp, 0, 0, 256, 256);
      bmp.close?.();
      const rgba = ctx.getImageData(0, 0, 256, 256).data;
      const merc10 = new Float32Array(256 * 256);
      for (let i = 0; i < 256 * 256; i++) {
        merc10[i] = (rgba[i * 4] * 256.0 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256.0) - 32768.0;
      }
      sanitizeMaritimeCutouts256(merc10);
      return merc10;
    } catch {
      return null;
    }
  })();
  workerBathyZ10Cache.set(key10, p);
  return p;
}

async function handleTerrariumDecodeTile(req: TerrariumDecodeTileRequest): Promise<TerrariumDecodeTileResponse> {
  const { z, tx, ty, minLat, maxLat } = req;
  let rgba: Uint8Array | Uint8ClampedArray | null = null;

  if (req.rgbaBuffer && req.rgbaBuffer.byteLength >= 256 * 256 * 4) {
    rgba = new Uint8Array(req.rgbaBuffer);
  } else {
    try {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`;
      const res = await fetchTerrariumWithBreaker(url);
      if (!res || !res.ok || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
        return { type: 'terrarium_decode_tile', ok: false, tx, ty };
      }
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const osc = new OffscreenCanvas(256, 256);
      const ctx = osc.getContext('2d');
      if (!ctx) {
        bmp.close?.();
        return { type: 'terrarium_decode_tile', ok: false, tx, ty };
      }
      ctx.drawImage(bmp, 0, 0, 256, 256);
      bmp.close?.();
      rgba = ctx.getImageData(0, 0, 256, 256).data;
    } catch {
      return { type: 'terrarium_decode_tile', ok: false, tx, ty };
    }
  }

  const mercElev = new Float32Array(256 * 256);
  for (let i = 0; i < 256 * 256; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    mercElev[i] = (r * 256.0 + g + b / 256.0) - 32768.0;
  }

  if (z <= 10) {
    sanitizeMaritimeCutouts256(mercElev);
  } else if (!req.rgbaBuffer) {
    let hasWater = false;
    for (let i = 0; i < 256 * 256; i++) {
      if (mercElev[i] <= 0.05) {
        hasWater = true;
        break;
      }
    }
    if (hasWater) {
      const shift = z - 10;
      const scale = 1 << shift;
      const tx10 = tx >> shift;
      const ty10 = ty >> shift;
      const subX = tx & (scale - 1);
      const subY = ty & (scale - 1);
      const merc10 = await getWorkerSlippyBathyZ10(tx10, ty10);
      if (merc10) {
        const landMask = new Uint8Array(256 * 256);
        for (let i = 0; i < 256 * 256; i++) {
          if (mercElev[i] > 0.15) landMask[i] = 1;
        }
        for (let row = 0; row < 256; row++) {
          const v10 = Math.max(0.0, Math.min(255.0, ((subY + (row + 0.5) / 256.0) / scale) * 256.0 - 0.5));
          const y0 = Math.floor(v10);
          const y1 = Math.min(255, y0 + 1);
          const wy = v10 - y0;
          const r0 = y0 * 256;
          const r1 = y1 * 256;
          const dstRow = row * 256;
          for (let col = 0; col < 256; col++) {
            const idx = dstRow + col;
            if (mercElev[idx] <= 0.05) {
              const u10 = Math.max(0.0, Math.min(255.0, ((subX + (col + 0.5) / 256.0) / scale) * 256.0 - 0.5));
              const x0 = Math.floor(u10);
              const x1 = Math.min(255, x0 + 1);
              const wx = u10 - x0;
              const b0 = merc10[r0 + x0] * (1.0 - wx) + merc10[r0 + x1] * wx;
              const b1 = merc10[r1 + x0] * (1.0 - wx) + merc10[r1 + x1] * wx;
              const bathyVal = b0 * (1.0 - wy) + b1 * wy;
              if (bathyVal < -0.25) {
                let adjLand = false;
                const ry0 = Math.max(0, row - 1);
                const ry1 = Math.min(255, row + 1);
                const cx0 = Math.max(0, col - 1);
                const cx1 = Math.min(255, col + 1);
                for (let ny = ry0; ny <= ry1 && !adjLand; ny++) {
                  for (let nx = cx0; nx <= cx1; nx++) {
                    if (landMask[ny * 256 + nx]) {
                      adjLand = true;
                      break;
                    }
                  }
                }
                mercElev[idx] = adjLand ? Math.max(bathyVal * 0.25, -4.5) : bathyVal;
              }
            }
          }
        }
      }
    }
  }

  const n = 1 << z;
  const eqElev = new Float32Array(256 * 256);
  const latSpan = maxLat - minLat;
  for (let row = 0; row < 256; row++) {
    const rowLat = maxLat - (row / 255.0) * latSpan;
    const phi = (rowLat * Math.PI) / 180.0;
    const yGlobal = ((1.0 - Math.log(Math.tan(phi) + 1.0 / Math.cos(phi)) / Math.PI) * 0.5) * n;
    const yMerc = Math.max(0.0, Math.min(255.0, (yGlobal - ty) * 255.0));
    const y0 = Math.floor(yMerc);
    const y1 = Math.min(255, y0 + 1);
    const wy = yMerc - y0;
    const off0 = y0 * 256;
    const off1 = y1 * 256;
    const dstOff = row * 256;
    for (let col = 0; col < 256; col++) {
      const e0 = mercElev[off0 + col];
      const e1 = mercElev[off1 + col];
      eqElev[dstOff + col] =
        (e0 <= 0.15 || e1 <= 0.15) && Math.abs(e0 - e1) > 8.0
          ? Math.min(e0, e1)
          : e0 * (1.0 - wy) + e1 * wy;
    }
  }

  return {
    type: 'terrarium_decode_tile',
    ok: true,
    tx,
    ty,
    elevBuffer: eqElev.buffer,
  };
}

export function packElevationTileToRG16Buffer(elevData: Float32Array, tileDimension = 256): ArrayBuffer {
  const count = tileDimension * tileDimension;
  const f16 = new Uint16Array(count * 2);
  for (let i = 0; i < count; i++) {
    const elev = elevData[i];
    const bNorm =
      elev > 0.15
        ? 0.5 + 0.5 * Math.max(0.0, Math.min(1.0, (elev - 0.15) / 1.35))
        : 0.5 * (1.0 - Math.max(0.0, Math.min(1.0, (0.15 - elev) / 0.13)));
    const clampedElev = Math.max(-10924.0, Math.min(8848.0, elev));
    const baseIdx = i * 2;
    f16[baseIdx] = encodeFloat16(bNorm);
    f16[baseIdx + 1] = encodeFloat16(clampedElev);
  }
  return f16.buffer;
}

async function decompressCOGBytes(data: Uint8Array, compression: number): Promise<Uint8Array> {
  if (compression === 1 || typeof DecompressionStream === 'undefined') {
    return data;
  }
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      void writer.write(data as unknown as BufferSource).catch(() => {});
      void writer.close().catch(() => {});
      const reader = ds.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.length;
        }
      }
      const out = new Uint8Array(total);
      let ptr = 0;
      for (const c of chunks) {
        out.set(c, ptr);
        ptr += c.length;
      }
      return out;
    } catch {
      // Try next format
    }
  }
  return data;
}

function decodeCOGSamples(
  bytes: Uint8Array,
  tileW: number,
  tileH: number,
  sampleFormat: number,
  bits: number
): ArrayBuffer {
  const count = tileW * tileH;
  const out = new Float32Array(count);

  if (sampleFormat === 3 && bits === 32 && bytes.byteLength >= count * 4) {
    if (bytes.byteOffset % 4 === 0) {
      out.set(new Float32Array(bytes.buffer, bytes.byteOffset, count));
    } else {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, count * 4);
      for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true);
    }
  } else if (sampleFormat === 2 && bits === 16 && bytes.byteLength >= count * 2) {
    if (bytes.byteOffset % 2 === 0) {
      const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, count);
      for (let i = 0; i < count; i++) out[i] = i16[i];
    } else {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
      for (let i = 0; i < count; i++) out[i] = dv.getInt16(i * 2, true);
    }
  } else if (sampleFormat === 1 && bits === 16 && bytes.byteLength >= count * 2) {
    if (bytes.byteOffset % 2 === 0) {
      const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, count);
      for (let i = 0; i < count; i++) out[i] = u16[i];
    } else {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
      for (let i = 0; i < count; i++) out[i] = dv.getUint16(i * 2, true);
    }
  } else {
    for (let i = 0; i < count; i++) {
      out[i] = i < bytes.length ? bytes[i] : 0;
    }
  }

  return out.buffer;
}

export async function executeDecodeTask(
  req: DecodeWorkerRequest
): Promise<{ response: DecodeWorkerResponse; transfer: Transferable[] }> {
  switch (req.type) {
    case 'weathernext_scalar_speed': {
      const scalarBuffer = extractWeatherNextScalarSpeed(req.vectorBuffer);
      return {
        response: { type: 'weathernext_scalar_speed', scalarBuffer },
        transfer: [scalarBuffer],
      };
    }

    case 'weathernext_cloud_dual_hour': {
      let b0 = req.buf0 ?? null;
      let b1 = req.buf1 ?? null;
      if (!b0 && req.url0) {
        b0 = await fetchValidBinary(req.url0);
      }
      if (!b1 && req.url1) {
        b1 = req.url1 === req.url0 ? b0 : ((await fetchValidBinary(req.url1)) ?? b0);
      }
      const isValidLen = (b: ArrayBuffer | null) =>
        Boolean(b && (b.byteLength === 13370624 || b.byteLength === 12967200 || b.byteLength >= req.width * req.height * 2));
      if (!isValidLen(b0) || !isValidLen(b1)) {
        return {
          response: { type: 'weathernext_cloud_dual_hour', ok: false },
          transfer: [],
        };
      }
      const res = interleaveDualHourCloudAndPreCull(b0!, b1!, req.width, req.height);
      return {
        response: {
          type: 'weathernext_cloud_dual_hour',
          ok: true,
          interleavedBuffer: res.interleavedBuffer,
          paddedRowBytes: res.paddedRowBytes,
          preCullMaxBuffer: res.preCullMaxBuffer,
        },
        transfer: [res.interleavedBuffer, res.preCullMaxBuffer],
      };
    }

    case 'weathernext_thermo_pack': {
      const res = await handleThermoPack(req);
      const transfer: Transferable[] = [];
      if (res.paddedBuffer) transfer.push(res.paddedBuffer);
      if (res.preCullThermoBuffer) transfer.push(res.preCullThermoBuffer);
      return { response: res, transfer };
    }

    case 'weathernext_wind_pack': {
      const res = await handleWindPack(req);
      const transfer: Transferable[] = [];
      if (res.paddedBuffer) transfer.push(res.paddedBuffer);
      if (res.rawU16Buffer) transfer.push(res.rawU16Buffer);
      if (res.interleavedRgbaBuffer) transfer.push(res.interleavedRgbaBuffer);
      return { response: res, transfer };
    }

    case 'wind_jet_interleave': {
      const merged = interleaveSurfaceWindAndJet(
        new Uint16Array(req.surfRawBuffer),
        req.windW,
        req.windH,
        new Uint16Array(req.jetRawBuffer),
        req.jetW,
        req.jetH
      );
      return {
        response: {
          type: 'wind_jet_interleave',
          interleavedRgbaBuffer: merged.interleavedRgbaBuffer,
          rowBytesPadded: merged.rowBytesPadded,
          windW: req.windW,
          windH: req.windH,
        },
        transfer: [merged.interleavedRgbaBuffer],
      };
    }

    case 'terrarium_decode_tile': {
      const res = await handleTerrariumDecodeTile(req);
      return {
        response: res,
        transfer: res.elevBuffer ? [res.elevBuffer] : [],
      };
    }

    case 'pack_elevation_tiles_rg16': {
      const outTiles = req.tiles.map((t) => ({
        key: t.key,
        slot: t.slot,
        f16Buffer: packElevationTileToRG16Buffer(new Float32Array(t.elevBuffer), req.tileDimension),
      }));
      return {
        response: { type: 'pack_elevation_tiles_rg16', tiles: outTiles },
        transfer: outTiles.map((t) => t.f16Buffer),
      };
    }

    case 'geotiff_decode_tiles': {
      const decoded = await Promise.all(
        req.tiles.map(async (t) => {
          const decompressed = await decompressCOGBytes(new Uint8Array(t.rawBuffer), t.compression);
          const elevBuffer = decodeCOGSamples(
            decompressed,
            t.tileW,
            t.tileH,
            t.sampleFormat,
            t.bitsPerSample
          );
          return { cacheKey: t.cacheKey, elevBuffer };
        })
      );
      return {
        response: { type: 'geotiff_decode_tiles', tiles: decoded },
        transfer: decoded.map((d) => d.elevBuffer),
      };
    }

    case 'weathernext_slice_pad': {
      const raw = await fetchValidBinary(req.url);
      const minBytes = req.rawRowBytes * req.height;
      if (!raw || raw.byteLength < minBytes) {
        return {
          response: { type: 'weathernext_slice_pad', ok: false },
          transfer: [],
        };
      }
      const paddedTotal = req.paddedRowBytes * req.height;
      if (
        req.paddedRowBytes <= req.rawRowBytes ||
        raw.byteLength === paddedTotal ||
        raw.byteLength >= minBytes * 2
      ) {
        return {
          response: { type: 'weathernext_slice_pad', ok: true, buffer: raw },
          transfer: [raw],
        };
      }
      const padded = new Uint8Array(paddedTotal);
      const src = new Uint8Array(raw);
      for (let row = 0; row < req.height; row++) {
        const sOff = row * req.rawRowBytes;
        const dOff = row * req.paddedRowBytes;
        padded.set(src.subarray(sOff, sOff + req.rawRowBytes), dOff);
      }
      return {
        response: { type: 'weathernext_slice_pad', ok: true, buffer: padded.buffer },
        transfer: [padded.buffer],
      };
    }
  }
}
