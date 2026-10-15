// ============================================================================
// File: scripts/refresh-planetary-data.ts
// Canonical Planetary Data Ingestion & Refresh Orchestrator
// Updates:
//   1. public/data/gfs-wind-latest.bin & gfs-cloud-*-latest.bin ($0.00 NOAA GFS)
//   2. public/data/radar-loop-latest.bin ($0.00 RainViewer Doppler Radar)
//   3. public/data/tle-starlink.json ($0.00 CelesTrak Starlink & ISS TLE Ephemeris)
//   4. public/data/weathernext/*.bin (Optional --with-weathernext, gated at >= 24h age)
//   5. public/data/ingestion-status.json (Authoritative HUD Freshness Telemetry)
// ============================================================================

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { fetchOrGenerateGFS } from './fetch-or-generate-gfs-wind';
import { fetchOrGenerateGFSClouds } from './fetch-or-generate-gfs-clouds';
import { fetchOrGenerateTLE } from './fetch-or-generate-tle-starlink';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataDir = path.join(projectRoot, 'public/data');
const lockFilePath = path.join(dataDir, '.refresh.lock');
const statusFilePath = path.join(dataDir, 'ingestion-status.json');

export interface FeedTelemetry {
  lastPulledUTC: string | null;
  lastAttemptUTC: string;
  modelCycle?: string;
  forecastInitUTC?: string;
  totalHours?: number;
  frameCount?: number;
  satelliteCount?: number;
  ageHours: number | null;
  status: 'ok' | 'stale' | 'error';
  message?: string;
}

export interface IngestionStatusManifest {
  updatedAtUTC: string;
  scheduler: string;
  weatherNextGateHours: number;
  freeFeedGateHours: number;
  feeds: {
    weathernext3: FeedTelemetry;
    gfs: FeedTelemetry;
    radar: FeedTelemetry;
    starlink: FeedTelemetry;
  };
}

export interface RefreshOptions {
  withWeatherNext?: boolean;
  forceWeatherNext?: boolean;
  maxWeatherNextAgeHours?: number;
  autoGateFreeFeeds?: boolean;
  maxFreeFeedAgeHours?: number;
}

function computeAgeHours(isoTimestamp: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!isoTimestamp) return null;
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Number(((nowMs - parsed) / 3600000).toFixed(2)));
}

function acquireLock(maxLockAgeMs: number = 20 * 60 * 1000): boolean {
  try {
    if (fs.existsSync(lockFilePath)) {
      const stat = fs.statSync(lockFilePath);
      if (Date.now() - stat.mtimeMs < maxLockAgeMs) {
        return false;
      }
      fs.unlinkSync(lockFilePath);
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      lockFilePath,
      JSON.stringify({ pid: process.pid, startedAtUTC: new Date().toISOString() }),
      'utf8'
    );
    return true;
  } catch {
    return true;
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

export function buildIngestionStatusManifest(
  nowIso: string = new Date().toISOString(),
  wnGateHours: number = 24,
  freeGateHours: number = 3,
  errors: Partial<Record<'weathernext3' | 'gfs' | 'radar' | 'starlink', string>> = {}
): IngestionStatusManifest {
  const nowMs = Date.parse(nowIso) || Date.now();

  // 1. WeatherNext 3 Telemetry
  let wnPulledUTC: string | null = null;
  let wnCycle: string | undefined;
  let wnInitUTC: string | undefined;
  let wnTotalHours: number | undefined;
  const wnMetaPath = path.join(dataDir, 'weathernext/meta.json');
  if (fs.existsSync(wnMetaPath)) {
    try {
      const wnMeta = JSON.parse(fs.readFileSync(wnMetaPath, 'utf8'));
      wnPulledUTC = wnMeta.ingestedAtUTC || fs.statSync(wnMetaPath).mtime.toISOString();
      wnCycle = wnMeta.forecastRunCycle;
      wnInitUTC = wnMeta.forecastInitTimestamp;
      wnTotalHours = wnMeta.timeHorizon?.totalHours ?? 12;
    } catch {
      // Ignore parse error
    }
  }
  const wnAge = computeAgeHours(wnPulledUTC, nowMs);
  const wnStatus: 'ok' | 'stale' | 'error' = errors.weathernext3
    ? 'error'
    : wnAge === null || wnAge > wnGateHours * 1.5
    ? 'stale'
    : 'ok';

  // 2. NOAA GFS Telemetry
  let gfsPulledUTC: string | null = null;
  let gfsCycle: string | undefined;
  let gfsInitUTC: string | undefined;
  const gfsMetaPath = path.join(dataDir, 'gfs-wind-meta.json');
  const gfsBinPath = path.join(dataDir, 'gfs-wind-latest.bin');
  if (fs.existsSync(gfsMetaPath)) {
    try {
      const gfsMeta = JSON.parse(fs.readFileSync(gfsMetaPath, 'utf8'));
      gfsPulledUTC = gfsMeta.generatedAt || gfsMeta.ingestedAtUTC || fs.statSync(gfsMetaPath).mtime.toISOString();
      gfsCycle = gfsMeta.cycle ? `${gfsMeta.cycle}Z` : undefined;
      gfsInitUTC = gfsMeta.forecastTime || gfsMeta.generatedAt;
    } catch {
      // Fallback to bin mtime
    }
  }
  if (!gfsPulledUTC && fs.existsSync(gfsBinPath)) {
    gfsPulledUTC = fs.statSync(gfsBinPath).mtime.toISOString();
  }
  const gfsAge = computeAgeHours(gfsPulledUTC, nowMs);
  const gfsStatus: 'ok' | 'stale' | 'error' = errors.gfs
    ? 'error'
    : gfsAge === null || gfsAge > 12
    ? 'stale'
    : 'ok';

  // 3. RainViewer Live Doppler Radar Telemetry
  let radarPulledUTC: string | null = null;
  let radarFrames: number | undefined;
  const radarMetaPath = path.join(dataDir, 'radar-loop-meta.json');
  if (fs.existsSync(radarMetaPath)) {
    try {
      const radarMeta = JSON.parse(fs.readFileSync(radarMetaPath, 'utf8'));
      radarPulledUTC = radarMeta.generatedAt || fs.statSync(radarMetaPath).mtime.toISOString();
      radarFrames = radarMeta.frameCount;
    } catch {
      // Ignore
    }
  }
  const radarAge = computeAgeHours(radarPulledUTC, nowMs);
  const radarStatus: 'ok' | 'stale' | 'error' = errors.radar
    ? 'error'
    : radarAge === null || radarAge > 12
    ? 'stale'
    : 'ok';

  // 4. CelesTrak Starlink & ISS TLE Telemetry
  let tlePulledUTC: string | null = null;
  let tleCount: number | undefined;
  const tlePath = path.join(dataDir, 'tle-starlink.json');
  if (fs.existsSync(tlePath)) {
    try {
      tlePulledUTC = fs.statSync(tlePath).mtime.toISOString();
      const tleData = JSON.parse(fs.readFileSync(tlePath, 'utf8'));
      if (Array.isArray(tleData)) {
        tleCount = tleData.length;
      }
    } catch {
      // Ignore
    }
  }
  const tleAge = computeAgeHours(tlePulledUTC, nowMs);
  const tleStatus: 'ok' | 'stale' | 'error' = errors.starlink
    ? 'error'
    : tleAge === null || tleAge > 24
    ? 'stale'
    : 'ok';

  const manifest: IngestionStatusManifest = {
    updatedAtUTC: nowIso,
    scheduler: 'canonical-planetary-orchestrator',
    weatherNextGateHours: wnGateHours,
    freeFeedGateHours: freeGateHours,
    feeds: {
      weathernext3: {
        lastPulledUTC: wnPulledUTC,
        lastAttemptUTC: nowIso,
        modelCycle: wnCycle,
        forecastInitUTC: wnInitUTC,
        totalHours: wnTotalHours,
        ageHours: wnAge,
        status: wnStatus,
        ...(errors.weathernext3 ? { message: errors.weathernext3 } : {}),
      },
      gfs: {
        lastPulledUTC: gfsPulledUTC,
        lastAttemptUTC: nowIso,
        modelCycle: gfsCycle,
        forecastInitUTC: gfsInitUTC,
        ageHours: gfsAge,
        status: gfsStatus,
        ...(errors.gfs ? { message: errors.gfs } : {}),
      },
      radar: {
        lastPulledUTC: radarPulledUTC,
        lastAttemptUTC: nowIso,
        frameCount: radarFrames,
        ageHours: radarAge,
        status: radarStatus,
        ...(errors.radar ? { message: errors.radar } : {}),
      },
      starlink: {
        lastPulledUTC: tlePulledUTC,
        lastAttemptUTC: nowIso,
        satelliteCount: tleCount,
        ageHours: tleAge,
        status: tleStatus,
        ...(errors.starlink ? { message: errors.starlink } : {}),
      },
    },
  };

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(statusFilePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  } catch {
    // Non-fatal in read-only environments
  }

  return manifest;
}

export async function refreshAllPlanetaryData(
  options: RefreshOptions = {}
): Promise<{ gfsBytes: number; tleSatellites: number; ingestionStatus: IngestionStatusManifest }> {
  const isTest = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
  const maxWnAgeHours = options.maxWeatherNextAgeHours ?? 24;
  const maxFreeAgeHours = options.maxFreeFeedAgeHours ?? 3;
  const errors: Partial<Record<'weathernext3' | 'gfs' | 'radar' | 'starlink', string>> = {};

  if (!isTest && !acquireLock()) {
    console.log('[SKIP] Another planetary refresh is currently in progress (.refresh.lock active).');
    const existingManifest = buildIngestionStatusManifest(new Date().toISOString(), maxWnAgeHours, maxFreeAgeHours);
    const gfsPath = path.join(dataDir, 'gfs-wind-latest.bin');
    const tlePath = path.join(dataDir, 'tle-starlink.json');
    return {
      gfsBytes: fs.existsSync(gfsPath) ? fs.statSync(gfsPath).size : 0,
      tleSatellites: existingManifest.feeds.starlink.satelliteCount ?? 0,
      ingestionStatus: existingManifest,
    };
  }

  try {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Starting canonical planetary data refresh...`);

    const preManifest = buildIngestionStatusManifest(timestamp, maxWnAgeHours, maxFreeAgeHours);
    const shouldSkipFree =
      !isTest &&
      Boolean(options.autoGateFreeFeeds) &&
      preManifest.feeds.gfs.ageHours !== null &&
      preManifest.feeds.gfs.ageHours < maxFreeAgeHours;

    if (shouldSkipFree) {
      console.log(
        `[SKIP] Free GFS/Radar/TLE feeds are fresh (${preManifest.feeds.gfs.ageHours}h old < ${maxFreeAgeHours}h gate).`
      );
    } else {
      // 1. Refresh NOAA GFS Wind Grid ($0.00)
      console.log('--- Step 1/4: Ingesting NOAA GFS Wind Velocity Field ($0.00) ---');
      try {
        await fetchOrGenerateGFS();
      } catch (err: any) {
        errors.gfs = err?.message || String(err);
        console.warn('[WARN] GFS Wind refresh error:', errors.gfs);
      }

      // 2. Refresh NOAA GFS Cloud Grids ($0.00)
      console.log('--- Step 2/4: Ingesting NOAA GFS Multi-Stratum Cloud Field ($0.00) ---');
      try {
        await fetchOrGenerateGFSClouds();
        console.log('[OK] GFS Cloud Grids generated.');
      } catch (err: any) {
        console.warn('[WARN] GFS Cloud refresh error:', err?.message || String(err));
      }

      // 3. Refresh Live Doppler Radar ($0.00)
      console.log('--- Step 3/4: Ingesting Live Doppler Radar Mosaics ($0.00) ---');
      try {
        const { fetchLiveRadarLoop } = await import('./fetch-live-radar');
        await fetchLiveRadarLoop({ dryRun: isTest, forceWrite: !isTest });
        console.log('[OK] Live Doppler Radar loop generated.');
      } catch (err: any) {
        errors.radar = err?.message || String(err);
        console.warn('[WARN] Live Doppler Radar refresh deferred:', errors.radar);
      }

      // 4. Refresh CelesTrak Starlink & ISS TLEs ($0.00)
      console.log('--- Step 4/4: Ingesting CelesTrak Starlink & ISS TLE Constellation ($0.00) ---');
      try {
        await fetchOrGenerateTLE();
      } catch (err: any) {
        errors.starlink = err?.message || String(err);
        console.warn('[WARN] Starlink TLE refresh error:', errors.starlink);
      }
    }

    // Optional Step 5: WeatherNext 3 Paid GCS Pull (Strictly Gated at >= 24 Hours Age)
    if (options.withWeatherNext && !isTest) {
      const wnAge = preManifest.feeds.weathernext3.ageHours;
      const shouldPullWn =
        Boolean(options.forceWeatherNext) || wnAge === null || wnAge >= maxWnAgeHours;

      if (!shouldPullWn) {
        console.log(
          `[SKIP] WeatherNext 3 is fresh (${wnAge?.toFixed(1)}h old < ${maxWnAgeHours}h cost gate) — $0.00 spent.`
        );
      } else {
        console.log(
          `--- Step 5: WeatherNext 3 age is ${wnAge !== null ? `${wnAge.toFixed(1)}h` : 'missing'} (>= ${maxWnAgeHours}h gate). Pulling 12h cycle... ---`
        );
        try {
          const homeDir = process.env.HOME || '/Users/andrewvoirol';
          const uvCandidates = [
            path.join(homeDir, '.local/bin/uv'),
            '/opt/homebrew/bin/uv',
            '/usr/local/bin/uv',
            'uv',
          ];
          const uvBin = uvCandidates.find((p) => p === 'uv' || fs.existsSync(p)) || 'uv';
          execFileSync(
            uvBin,
            [
              'run',
              '--with',
              'zarr',
              '--with',
              'gcsfs',
              '--with',
              'numpy',
              'python',
              path.join(projectRoot, 'scripts/fetch-weathernext3.py'),
              '--hours',
              '12',
            ],
            { cwd: projectRoot, stdio: 'inherit', timeout: 10 * 60 * 1000 }
          );
        } catch (err: any) {
          errors.weathernext3 = err?.message || String(err);
          console.warn('[WARN] WeatherNext 3 refresh failed:', errors.weathernext3);
        }
      }
    }

    const gfsPath = path.join(projectRoot, 'public/data/gfs-wind-latest.bin');
    const gfsStats = fs.statSync(gfsPath);
    console.log(`[OK] GFS Wind Grid: ${gfsStats.size} bytes written to ${gfsPath}`);

    const tlePath = path.join(projectRoot, 'public/data/tle-starlink.json');
    const tleData = JSON.parse(fs.readFileSync(tlePath, 'utf8'));
    console.log(`[OK] Starlink/ISS TLEs: ${tleData.length} satellites written to ${tlePath}`);

    const ingestionStatus = buildIngestionStatusManifest(
      new Date().toISOString(),
      maxWnAgeHours,
      maxFreeAgeHours,
      errors
    );
    console.log(`[${ingestionStatus.updatedAtUTC}] Canonical planetary data refresh complete.`);

    return {
      gfsBytes: gfsStats.size,
      tleSatellites: tleData.length,
      ingestionStatus,
    };
  } finally {
    if (!isTest) {
      releaseLock();
    }
  }
}

// Run if executed directly
if (process.argv[1] && process.argv[1].endsWith('refresh-planetary-data.ts')) {
  const args = new Set(process.argv.slice(2));
  refreshAllPlanetaryData({
    withWeatherNext: args.has('--with-weathernext'),
    forceWeatherNext: args.has('--force-weathernext'),
    autoGateFreeFeeds: args.has('--auto'),
  }).catch((err) => {
    console.error('Planetary data refresh failed:', err);
    process.exit(1);
  });
}
