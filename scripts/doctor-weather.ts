#!/usr/bin/env node
/**
 * scripts/doctor-weather.ts
 *
 * Automated diagnostic CLI for Google DeepMind WeatherNext 3 Data Pipeline:
 * 1. Checks Application Default Credentials (ADC) and ~/.zshenv configuration.
 * 2. Verifies requester-pays GCS connectivity and billing project 'antigravity-agent-1765655548'.
 * 3. Inspects local staged files in public/data/weathernext/ (meta.json and binary slices).
 * 4. Audits byte lengths and WebGPU 256-byte row pitch padding contracts (Invariants §40 & §73).
 *
 * Exit code 0 if all required staged files and WebGPU stride invariants pass.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { WEATHERNEXT_GRID_SPEC } from '../src/core/data/WeatherNextDataSource';
import { mountWorktreeAssets } from './mount-worktree-assets';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WEATHERNEXT_DATA_DIR = path.join(PROJECT_ROOT, 'public', 'data', 'weathernext');

// Scalar Float16 constants
const SCALAR_WIDTH = 3600;
const SCALAR_HEIGHT = 1801;
const SCALAR_RAW_ROW_BYTES = SCALAR_WIDTH * 2; // 7200
const SCALAR_PADDED_ROW_BYTES = Math.ceil(SCALAR_RAW_ROW_BYTES / 256) * 256; // 7424
const SCALAR_PADDED_SLICE_BYTES = SCALAR_PADDED_ROW_BYTES * SCALAR_HEIGHT; // 13,370,624
const SCALAR_UNPADDED_SLICE_BYTES = SCALAR_RAW_ROW_BYTES * SCALAR_HEIGHT; // 12,967,200

// Vector rg16float constants
const VECTOR_RAW_ROW_BYTES = SCALAR_WIDTH * 4; // 14400
const VECTOR_PADDED_ROW_BYTES = Math.ceil(VECTOR_RAW_ROW_BYTES / 256) * 256; // 14592
const VECTOR_PADDED_SLICE_BYTES = VECTOR_PADDED_ROW_BYTES * SCALAR_HEIGHT; // 26,280,192
const VECTOR_UNPADDED_SLICE_BYTES = VECTOR_RAW_ROW_BYTES * SCALAR_HEIGHT; // 25,934,400

interface CheckResult {
  category: string;
  name: string;
  passed: boolean;
  warning?: boolean;
  message: string;
  details?: string;
}

const results: CheckResult[] = [];

function recordCheck(category: string, name: string, passed: boolean, message: string, details?: string, warning: boolean = false) {
  results.push({ category, name, passed, warning, message, details });
}

// ---------------------------------------------------------------------------
// 1. ADC Credentials & Billing Project Resolution
// ---------------------------------------------------------------------------
function checkCredentials() {
  const zshenvPath = path.join(os.homedir(), '.zshenv');
  let adcFromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  let projectFromEnv = process.env.CLOUDSDK_CORE_PROJECT;

  if (fs.existsSync(zshenvPath)) {
    try {
      const content = fs.readFileSync(zshenvPath, 'utf-8');
      if (!adcFromEnv) {
        const mAdc = content.match(/GOOGLE_APPLICATION_CREDENTIALS=["']?([^"'\s]+)/);
        if (mAdc) adcFromEnv = mAdc[1];
      }
      if (!projectFromEnv) {
        const mProj = content.match(/CLOUDSDK_CORE_PROJECT=["']?([^"'\s]+)/);
        if (mProj) projectFromEnv = mProj[1];
      }
    } catch {
      // Ignore read errors
    }
  }

  const defaultAdcPath = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  const candidateAdc = adcFromEnv ? path.resolve(adcFromEnv.replace(/^~/, os.homedir())) : defaultAdcPath;

  const adcExists = fs.existsSync(candidateAdc);
  if (adcExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidateAdc, 'utf-8'));
      const isValid = Boolean(parsed.client_id || parsed.type === 'service_account' || parsed.refresh_token);
      recordCheck(
        'Auth',
        'Google Cloud ADC',
        isValid,
        isValid ? `Valid credentials present at ${candidateAdc}` : `Invalid JSON structure in ${candidateAdc}`
      );
    } catch (err: any) {
      recordCheck('Auth', 'Google Cloud ADC', false, `Failed to parse ADC JSON at ${candidateAdc}: ${err.message}`);
    }
  } else {
    recordCheck(
      'Auth',
      'Google Cloud ADC',
      false,
      `ADC file not found at ${candidateAdc}. (Run 'gcloud auth application-default login' for live fetch)`,
      undefined,
      true // Mark as warning because local mock mode does not require ADC
    );
  }

  const effectiveProject = projectFromEnv || 'antigravity-agent-1765655548';
  recordCheck(
    'Auth',
    'Billing Project',
    true,
    `Configured requester-pays billing project: ${effectiveProject}`
  );
}

// ---------------------------------------------------------------------------
// 2. GCS Requester-Pays Bucket Probe
// ---------------------------------------------------------------------------
function checkGCSConnectivity() {
  try {
    const probeCmd = `uv run --with zarr --with gcsfs --with numpy python scripts/fetch-weathernext3.py --dry-run`;
    const stdout = execSync(probeCmd, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 35000, stdio: ['pipe', 'pipe', 'pipe'] });
    const passed = stdout.includes('[OK] DRY-RUN VERIFICATION PASSED');
    recordCheck(
      'GCS',
      'Bucket Access & Sentinel',
      passed,
      passed ? 'Successfully connected to WeatherNext 3 bucket and verified cycle sentinel' : 'Dry-run did not complete successfully',
      stdout.slice(0, 300)
    );
  } catch (err: any) {
    recordCheck(
      'GCS',
      'Bucket Access & Sentinel',
      false,
      'Live GCS dry-run check could not reach bucket or timed out (offline mock mode unaffected)',
      err.message,
      true // Warning only
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Staged Local Dataset Inspection (public/data/weathernext/)
// ---------------------------------------------------------------------------
function checkStagedDataset() {
  // Mount worktree assets from canonical root if in linked worktree
  try {
    mountWorktreeAssets(PROJECT_ROOT);
  } catch {}

  const dirExists = fs.existsSync(WEATHERNEXT_DATA_DIR);
  recordCheck(
    'Storage',
    'Data Directory',
    dirExists,
    dirExists ? `Found public/data/weathernext/` : `Directory missing: ${WEATHERNEXT_DATA_DIR}`
  );

  if (!dirExists) return;

  const metaPath = path.join(WEATHERNEXT_DATA_DIR, 'meta.json');
  const metaExists = fs.existsSync(metaPath);
  recordCheck(
    'Metadata',
    'meta.json Sidecar',
    metaExists,
    metaExists ? 'meta.json present' : 'meta.json missing'
  );

  let meta: any = null;
  if (metaExists) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const validSource = meta.source === 'Google DeepMind WeatherNext 3';
      const validDims = meta.gridDimensions?.width === 3600 && meta.gridDimensions?.height === 1801;
      const validHours = typeof meta.timeHorizon?.totalHours === 'number' && meta.timeHorizon.totalHours > 0;
      const hasVectorEncoding = Boolean(meta.vectorTextureEncoding);

      recordCheck('Metadata', 'Source & Model', validSource, `Source: ${meta.source} (${meta.model || 'N/A'})`);
      recordCheck('Metadata', 'Grid Dimensions', validDims, `Dimensions: ${meta.gridDimensions?.width}x${meta.gridDimensions?.height} (0.1° resolution)`);
      recordCheck('Metadata', 'Time Horizon', validHours, `Total hours: ${meta.timeHorizon?.totalHours} (valid: 0..${(meta.timeHorizon?.totalHours || 1) - 1})`);
      recordCheck('Metadata', 'Vector Encoding Info', hasVectorEncoding, hasVectorEncoding ? 'rg16float vector encoding documented' : 'vectorTextureEncoding section missing');

      const sampleSlicePath = path.join(WEATHERNEXT_DATA_DIR, 'low_cloud_cover_mean-0.bin');
      if (meta.ingestedAtUTC && fs.existsSync(sampleSlicePath)) {
        const metaIngestMs = Date.parse(meta.ingestedAtUTC);
        const sliceMtimeMs = fs.statSync(sampleSlicePath).mtimeMs;
        if (!Number.isNaN(metaIngestMs)) {
          const driftHours = Math.abs(sliceMtimeMs - metaIngestMs) / 3600000;
          const parityOk = driftHours <= 1.0;
          recordCheck(
            'Metadata',
            'Metadata / Slice Timestamp Parity',
            parityOk,
            parityOk
              ? `meta.json (${meta.forecastRunCycle || meta.ingestedAtUTC}) matches binary slice mtime (Δ=${(driftHours * 60).toFixed(1)}m)`
              : `Split-brain mismatch: meta.json ingestedAtUTC (${meta.ingestedAtUTC}) differs from binary slice mtime (${new Date(sliceMtimeMs).toISOString()}) by ${driftHours.toFixed(1)}h`
          );
        }
      }
    } catch (err: any) {
      recordCheck('Metadata', 'meta.json Parse', false, `JSON parse error: ${err.message}`);
    }
  }

  // Check staged binary slices
  const targetVars: string[] = meta?.variables && Array.isArray(meta.variables) && meta.variables.length > 0
    ? meta.variables
    : [
        'total_precipitation_1hr_mean',
        'temperature_2m_mean',
        'dewpoint_temperature_2m_mean',
        'low_cloud_cover_mean',
        'medium_cloud_cover_mean',
        'high_cloud_cover_mean',
        'wind_10m_vector',
        'sea_surface_temperature_mean',
        'radiative_optical_depth',
      ];

  const hoursToCheck = meta?.timeHorizon?.totalHours || 24;
  let totalChecked = 0;
  let totalValid = 0;
  const missingFiles: string[] = [];
  const corruptFiles: string[] = [];

  for (const v of targetVars) {
    const isVector = v === 'wind_10m_vector' || v.endsWith('_vector');
    const expectedPadded = isVector ? VECTOR_PADDED_SLICE_BYTES : SCALAR_PADDED_SLICE_BYTES;
    const expectedRaw = isVector ? VECTOR_UNPADDED_SLICE_BYTES : SCALAR_UNPADDED_SLICE_BYTES;

    for (let h = 0; h < Math.min(hoursToCheck, 24); h++) {
      totalChecked++;
      const filename = `${v}-${h}.bin`;
      const filePath = path.join(WEATHERNEXT_DATA_DIR, filename);

      if (!fs.existsSync(filePath)) {
        missingFiles.push(filename);
        continue;
      }

      const stat = fs.statSync(filePath);
      if (stat.size === expectedPadded || stat.size === expectedRaw) {
        totalValid++;
      } else {
        corruptFiles.push(`${filename} (size: ${stat.size} bytes, expected ${expectedPadded} or ${expectedRaw})`);
      }
    }
  }

  const allValid = missingFiles.length === 0 && corruptFiles.length === 0;
  const hoursLabel = Math.min(hoursToCheck, 24);
  recordCheck(
    'Slices',
    `Staged Binary Slices (0..${hoursLabel - 1}h)`,
    allValid,
    allValid
      ? `All ${totalValid}/${totalChecked} slices validated (${targetVars.length} variables × ${hoursLabel}h)`
      : `${totalValid}/${totalChecked} valid. Missing: ${missingFiles.length}, Size mismatch: ${corruptFiles.length}`,
    missingFiles.length > 0 ? `First missing: ${missingFiles.slice(0, 5).join(', ')}` : undefined
  );
}

// ---------------------------------------------------------------------------
// 4. WebGPU Stride & Zero-Padding Contract (Invariants §40 & §73)
// ---------------------------------------------------------------------------
function checkWebGPUStrideInvariants() {
  // 1. Mathematical checks
  const scalarRawPitch = SCALAR_WIDTH * 2; // 7200
  const scalarPaddedPitch = Math.ceil(scalarRawPitch / 256) * 256; // 7424
  const scalarPadding = scalarPaddedPitch - scalarRawPitch; // 224

  const vectorRawPitch = SCALAR_WIDTH * 4; // 14400
  const vectorPaddedPitch = Math.ceil(vectorRawPitch / 256) * 256; // 14592
  const vectorPadding = vectorPaddedPitch - vectorRawPitch; // 192

  recordCheck(
    'WebGPU',
    'Scalar 256-Byte Stride Invariant',
    scalarPaddedPitch % 256 === 0 && scalarPaddedPitch === 7424 && scalarPadding === 224,
    `Scalar: Raw ${scalarRawPitch}B -> Hardware ${scalarPaddedPitch}B (pad: ${scalarPadding}B)`
  );

  recordCheck(
    'WebGPU',
    'Vector 256-Byte Stride Invariant',
    vectorPaddedPitch % 256 === 0 && vectorPaddedPitch === 14592 && vectorPadding === 192,
    `Vector: Raw ${vectorRawPitch}B -> Hardware ${vectorPaddedPitch}B (pad: ${vectorPadding}B)`
  );

  // 2. Sample staged slice padding verification
  const sampleScalarPath = path.join(WEATHERNEXT_DATA_DIR, 'total_precipitation_1hr_mean-0.bin');
  if (fs.existsSync(sampleScalarPath)) {
    const stat = fs.statSync(sampleScalarPath);
    if (stat.size === SCALAR_PADDED_SLICE_BYTES) {
      const fd = fs.openSync(sampleScalarPath, 'r');
      const padBuffer = Buffer.alloc(scalarPadding);
      let nonZeroCount = 0;

      // Sample 10 evenly spaced rows
      for (let r = 0; r < SCALAR_HEIGHT; r += Math.floor(SCALAR_HEIGHT / 10)) {
        const padOffset = r * scalarPaddedPitch + scalarRawPitch;
        fs.readSync(fd, padBuffer, 0, scalarPadding, padOffset);
        for (let b = 0; b < scalarPadding; b++) {
          if (padBuffer[b] !== 0) nonZeroCount++;
        }
      }
      fs.closeSync(fd);

      recordCheck(
        'WebGPU',
        'Scalar Stride Zero-Padding Sampling',
        nonZeroCount === 0,
        nonZeroCount === 0
          ? `Sampled row padding strictly zero-filled (10 rows × 224B)`
          : `Corrupt padding: found ${nonZeroCount} non-zero bytes in scalar row padding`
      );
    }
  }

  const sampleVectorPath = path.join(WEATHERNEXT_DATA_DIR, 'wind_10m_vector-0.bin');
  if (fs.existsSync(sampleVectorPath)) {
    const stat = fs.statSync(sampleVectorPath);
    if (stat.size === VECTOR_PADDED_SLICE_BYTES) {
      const fd = fs.openSync(sampleVectorPath, 'r');
      const padBuffer = Buffer.alloc(vectorPadding);
      let nonZeroCount = 0;

      for (let r = 0; r < SCALAR_HEIGHT; r += Math.floor(SCALAR_HEIGHT / 10)) {
        const padOffset = r * vectorPaddedPitch + vectorRawPitch;
        fs.readSync(fd, padBuffer, 0, vectorPadding, padOffset);
        for (let b = 0; b < vectorPadding; b++) {
          if (padBuffer[b] !== 0) nonZeroCount++;
        }
      }
      fs.closeSync(fd);

      recordCheck(
        'WebGPU',
        'Vector Stride Zero-Padding Sampling',
        nonZeroCount === 0,
        nonZeroCount === 0
          ? `Sampled vector row padding strictly zero-filled (10 rows × 192B)`
          : `Corrupt padding: found ${nonZeroCount} non-zero bytes in vector row padding`
      );
    }
  }

  const sampleCloudPath = path.join(WEATHERNEXT_DATA_DIR, 'low_cloud_cover_mean-0.bin');
  if (fs.existsSync(sampleCloudPath)) {
    const stat = fs.statSync(sampleCloudPath);
    if (stat.size === SCALAR_PADDED_SLICE_BYTES) {
      const fd = fs.openSync(sampleCloudPath, 'r');
      const padBuffer = Buffer.alloc(scalarPadding);
      let nonZeroCount = 0;

      for (let r = 0; r < SCALAR_HEIGHT; r += Math.floor(SCALAR_HEIGHT / 10)) {
        const padOffset = r * scalarPaddedPitch + scalarRawPitch;
        fs.readSync(fd, padBuffer, 0, scalarPadding, padOffset);
        for (let b = 0; b < scalarPadding; b++) {
          if (padBuffer[b] !== 0) nonZeroCount++;
        }
      }
      fs.closeSync(fd);

      recordCheck(
        'WebGPU',
        'Cloud Strata Stride Zero-Padding Sampling',
        nonZeroCount === 0,
        nonZeroCount === 0
          ? `Sampled cloud row padding strictly zero-filled (10 rows × 224B)`
          : `Corrupt padding: found ${nonZeroCount} non-zero bytes in cloud row padding`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Live Satellite Dataset & Stride Parity (satellite-meta.json + 4 Strata)
// ---------------------------------------------------------------------------
export const SATELLITE_SLICE_SPECS: Array<{ key: string; filename: string }> = [
  { key: 'low', filename: 'satellite-cloud-low-latest.bin' },
  { key: 'mid', filename: 'satellite-cloud-mid-latest.bin' },
  { key: 'high', filename: 'satellite-cloud-high-latest.bin' },
  { key: 'radiative_optical_depth', filename: 'satellite-radiative-optical-depth-latest.bin' },
];

export function checkSatelliteDataset(
  dataDir: string = path.join(PROJECT_ROOT, 'public', 'data'),
  sink: CheckResult[] = results
): CheckResult[] {
  const localChecks: CheckResult[] = [];
  const push = (
    category: string,
    name: string,
    passed: boolean,
    message: string,
    details?: string,
    warning: boolean = false
  ) => {
    const item: CheckResult = { category, name, passed, warning, message, details };
    localChecks.push(item);
    sink.push(item);
  };

  const metaPath = path.join(dataDir, 'satellite-meta.json');
  const metaExists = fs.existsSync(metaPath);
  push(
    'Satellite',
    'satellite-meta.json Sidecar',
    metaExists,
    metaExists ? 'satellite-meta.json present' : `Missing ${metaPath}`
  );
  if (!metaExists) return localChecks;

  let meta: any = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (err: any) {
    push('Satellite', 'satellite-meta.json Parse', false, `JSON parse error: ${err.message}`);
    return localChecks;
  }

  const validSource = typeof meta.source === 'string' && meta.source.includes('NASA EOSDIS GIBS');
  const validDims =
    meta.gridDimensions?.width === SCALAR_WIDTH &&
    meta.gridDimensions?.height === SCALAR_HEIGHT &&
    meta.gridDimensions?.resolutionDeg === 0.1;
  const validEncoding =
    meta.textureEncoding?.format === 'r16float' &&
    meta.textureEncoding?.paddedRowBytes === SCALAR_PADDED_ROW_BYTES &&
    meta.textureEncoding?.sliceByteLength === SCALAR_PADDED_SLICE_BYTES;
  const obsMs = Date.parse(meta.observationTimestampUTC || '');
  const ingestMs = Date.parse(meta.ingestedAtUTC || '');
  const validTimestamps = !Number.isNaN(obsMs) && !Number.isNaN(ingestMs);

  push('Satellite', 'Source & Constellation', validSource, `Source: ${meta.source || 'N/A'}`);
  push(
    'Satellite',
    'Grid & R16Float Stride Spec',
    validDims && validEncoding,
    `Grid ${meta.gridDimensions?.width}×${meta.gridDimensions?.height} (${meta.gridDimensions?.resolutionDeg}°) · ${meta.textureEncoding?.format} (${meta.textureEncoding?.sliceByteLength}B)`
  );
  push(
    'Satellite',
    'Observation & Ingest Timestamps',
    validTimestamps,
    validTimestamps
      ? `Observed ${meta.observationTimestampUTC} · Ingested ${meta.ingestedAtUTC}`
      : 'Invalid or missing observationTimestampUTC / ingestedAtUTC'
  );

  const scalarPadding = SCALAR_PADDED_ROW_BYTES - SCALAR_RAW_ROW_BYTES; // 224B
  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  let padViolations = 0;
  let allZeroSlices = 0;

  for (const spec of SATELLITE_SLICE_SPECS) {
    const slicePath = path.join(dataDir, spec.filename);
    if (!fs.existsSync(slicePath)) {
      missing.push(spec.filename);
      continue;
    }
    const stat = fs.statSync(slicePath);
    const metaExpectedBytes = meta.strata?.[spec.key]?.byteLength ?? SCALAR_PADDED_SLICE_BYTES;
    if (stat.size !== SCALAR_PADDED_SLICE_BYTES || metaExpectedBytes !== SCALAR_PADDED_SLICE_BYTES) {
      sizeMismatch.push(`${spec.filename} (${stat.size}B, meta=${metaExpectedBytes}B, expected ${SCALAR_PADDED_SLICE_BYTES}B)`);
      continue;
    }

    const fd = fs.openSync(slicePath, 'r');
    try {
      const padBuf = Buffer.alloc(scalarPadding);
      const dataBuf = Buffer.alloc(256);
      let nonZeroData = 0;
      for (let r = 0; r < SCALAR_HEIGHT; r += Math.floor(SCALAR_HEIGHT / 10)) {
        const rowStart = r * SCALAR_PADDED_ROW_BYTES;
        fs.readSync(fd, dataBuf, 0, dataBuf.length, rowStart);
        for (let b = 0; b < dataBuf.length; b++) {
          if (dataBuf[b] !== 0) nonZeroData++;
        }
        const padOffset = rowStart + SCALAR_RAW_ROW_BYTES;
        fs.readSync(fd, padBuf, 0, scalarPadding, padOffset);
        for (let b = 0; b < scalarPadding; b++) {
          if (padBuf[b] !== 0) padViolations++;
        }
      }
      if (nonZeroData === 0) {
        allZeroSlices++;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  const slicesPresent = missing.length === 0;
  const slicesValid = slicesPresent && sizeMismatch.length === 0 && padViolations === 0 && allZeroSlices === 0;

  push(
    'Satellite',
    'Live Satellite Binary Slices (4×FP16)',
    slicesValid,
    slicesValid
      ? `All 4/4 Live Satellite slices validated (13,370,624B, 224B zero-pad, non-zero payload)`
      : !slicesPresent
      ? `Missing Live Satellite binaries (${missing.length}/4): run 'npm run satellite:fetch' or 'npm run satellite:mock'`
      : `Size mismatch: ${sizeMismatch.length}, Pad violations: ${padViolations}, Empty slices: ${allZeroSlices}`,
    sizeMismatch.length > 0 ? sizeMismatch.join('; ') : missing.length > 0 ? missing.join(', ') : undefined,
    !slicesPresent && sizeMismatch.length === 0 // Missing gitignored .bin on fresh clone warns unless corrupt
  );

  const lowSlicePath = path.join(dataDir, 'satellite-cloud-low-latest.bin');
  if (!Number.isNaN(ingestMs) && fs.existsSync(lowSlicePath)) {
    const sliceMtimeMs = fs.statSync(lowSlicePath).mtimeMs;
    const driftHours = Math.abs(sliceMtimeMs - ingestMs) / 3600000;
    const parityOk = driftHours <= 1.0;
    push(
      'Satellite',
      'Metadata / Binary Timestamp Parity',
      parityOk,
      parityOk
        ? `satellite-meta.json matches binary mtime (Δ=${(driftHours * 60).toFixed(1)}m)`
        : `Split-brain mismatch: satellite-meta.json (${meta.ingestedAtUTC}) differs from binary mtime (${new Date(sliceMtimeMs).toISOString()}) by ${driftHours.toFixed(1)}h`
    );
  }

  return localChecks;
}

// ---------------------------------------------------------------------------
// 6. NOAA GFS Operational Snapshot Parity (gfs-wind-meta.json + GFS Slices)
// ---------------------------------------------------------------------------
export function checkGfsDataset(
  dataDir: string = path.join(PROJECT_ROOT, 'public', 'data'),
  sink: CheckResult[] = results
): CheckResult[] {
  const localChecks: CheckResult[] = [];
  const push = (
    category: string,
    name: string,
    passed: boolean,
    message: string,
    details?: string,
    warning: boolean = false
  ) => {
    const item: CheckResult = { category, name, passed, warning, message, details };
    localChecks.push(item);
    sink.push(item);
  };

  const metaPath = path.join(dataDir, 'gfs-wind-meta.json');
  const metaExists = fs.existsSync(metaPath);
  push('NOAA GFS', 'gfs-wind-meta.json Sidecar', metaExists, metaExists ? 'gfs-wind-meta.json present' : `Missing ${metaPath}`);
  if (!metaExists) return localChecks;

  let meta: any = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (err: any) {
    push('NOAA GFS', 'gfs-wind-meta.json Parse', false, `JSON parse error: ${err.message}`);
    return localChecks;
  }

  const validGrid =
    meta.gridDimensions?.lonPoints === 1440 &&
    meta.gridDimensions?.latPoints === 721 &&
    meta.gridDimensions?.resolutionDeg === 0.25;
  const hasRunInfo = Boolean(meta.modelRunDate && meta.modelRunCycle);

  push(
    'NOAA GFS',
    'Grid & Operational Cycle',
    validGrid && hasRunInfo,
    `Run ${meta.modelRunDate || 'N/A'} ${meta.modelRunCycle || ''} · ${meta.gridDimensions?.lonPoints}×${meta.gridDimensions?.latPoints} (${meta.gridDimensions?.resolutionDeg}°)`
  );

  const gfsFiles = [
    'gfs-wind-latest.bin',
    'gfs-wind-500hpa-latest.bin',
    'gfs-jetstream-latest.bin',
    'gfs-cloud-low-latest.bin',
    'gfs-cloud-mid-latest.bin',
    'gfs-cloud-high-latest.bin',
  ];
  const missing = gfsFiles.filter((f) => !fs.existsSync(path.join(dataDir, f)));
  const empty = gfsFiles.filter((f) => {
    const p = path.join(dataDir, f);
    return fs.existsSync(p) && fs.statSync(p).size === 0;
  });
  const slicesOk = missing.length === 0 && empty.length === 0;
  push(
    'NOAA GFS',
    'Staged GFS Wind & Cloud Binaries',
    slicesOk,
    slicesOk
      ? `All ${gfsFiles.length}/${gfsFiles.length} GFS 0.25° wind & cloud slices present`
      : `Missing: ${missing.length}, Empty: ${empty.length} (run 'npm run refresh:planetary')`,
    missing.length > 0 ? missing.join(', ') : undefined,
    missing.length > 0 && empty.length === 0
  );

  return localChecks;
}

// ---------------------------------------------------------------------------
// Main Diagnostics Runner
// ---------------------------------------------------------------------------
export async function runDiagnostics(): Promise<number> {
  results.length = 0;
  console.log('='.repeat(80));
  console.log('INDICATRIX ENGINE: WEATHERNEXT 3 · LIVE SATELLITE · NOAA GFS HEALTH AUDIT');
  console.log('='.repeat(80));

  checkCredentials();
  checkGCSConnectivity();
  checkStagedDataset();
  checkWebGPUStrideInvariants();
  checkSatelliteDataset();
  checkGfsDataset();

  console.log(`\n${'CATEGORY'.padEnd(12)} ${'CHECK'.padEnd(36)} ${'STATUS'.padEnd(10)} ${'DETAILS'}`);
  console.log('-'.repeat(96));

  let failureCount = 0;
  let warningCount = 0;

  for (const r of results) {
    const status = r.passed ? '\x1b[32m[PASS]\x1b[0m' : r.warning ? '\x1b[33m[WARN]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
    if (!r.passed && !r.warning) failureCount++;
    if (!r.passed && r.warning) warningCount++;

    console.log(`${r.category.padEnd(12)} ${r.name.padEnd(36)} ${status.padEnd(19)} ${r.message}`);
    if (r.details) {
      console.log(`             └─> ${r.details}`);
    }
  }

  console.log('-'.repeat(96));
  if (failureCount === 0) {
    console.log(`\x1b[32m[OK] WEATHERNEXT 3 HEALTH AUDIT PASSED\x1b[0m (${results.length} checks, ${warningCount} warnings).`);
    return 0;
  } else {
    console.log(`\x1b[31m[ERROR] WEATHERNEXT 3 HEALTH AUDIT FAILED\x1b[0m (${failureCount} blocking failures, ${warningCount} warnings).`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDiagnostics().then((code) => {
    process.exit(code);
  });
}
