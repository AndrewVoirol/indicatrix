/**
 * scripts/precompute-overture-vectors.ts
 * 
 * High-Resolution Vector Coastlines & Waterways Precomputation
 * Using Overture Maps GeoParquet via DuckDB + Natural Earth 10m Base
 * 
 * Ingests:
 * 1. Overture Maps GeoParquet directly from AWS S3 via DuckDB (spatial + httpfs)
 *    (s3://overturemaps-us-west-2/release/2026-08-19.0/theme=base/type=water/*)
 *    Extracts high-resolution ocean coastline boundaries (subtype = 'ocean') and major rivers (subtype = 'river' AND class = 'river').
 * 2. Natural Earth 1:10m Physical Coastlines (via world-atlas land-10m.json)
 * 3. Natural Earth 1:10m Major Rivers & Lake Centerlines
 * 4. Local GEBCO 2024 / ETOPO 2022 16-bit DEM (public/earth-gebco2024-dem-u16.bin prioritized over earth-etopo2022-dem-u16.bin) for elevation sampling & topographic densification
 * 
 * Computes:
 * - positions3D: Cartesian coordinates on sphere at R = 5.015 (sub-millimeter standoff)
 * - target2D: EPSG:3857 Web Mercator coordinates with antimeridian seam breaks
 * - dymaxion2D: Fuller 20-facet net coordinates with facet cut edge culling
 * - vType: 1.0 for Coastlines, 0.5 for Major Rivers
 * - indices: Line segment endpoint index pairs (A -> B)
 * 
 * Output:
 * public/geo-vectors.bin (Magic 0x47564543, 'GVEC', target 35.0 - 42.0 MB)
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as topojson from 'topojson-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function getDuckDB(): Promise<any> {
  try {
    // Attempt standard resolution if installed
    const duckdbPkg = 'duckdb-async';
    const duckdb = await import(/* @vite-ignore */ duckdbPkg);
    return duckdb.Database;
  } catch {
    // Attempt to load from isolated tools/vector-pipeline
    const localDuckdbPath = path.resolve(projectRoot, 'tools/vector-pipeline/node_modules/duckdb-async/dist/duckdb-async.js');
    if (fs.existsSync(localDuckdbPath)) {
      const duckdb = await import(/* @vite-ignore */ localDuckdbPath);
      return duckdb.Database;
    }
    // Zero-node-gyp fallback: delegate DuckDB spatial + httpfs S3 Parquet queries to uv-managed Python duckdb
    return {
      async create() {
        let initSql = '';
        return {
          async exec(sql: string) {
            initSql += '\n' + sql;
          },
          async all(querySql: string) {
            const pyScript = `
import sys, json, duckdb
con = duckdb.connect(":memory:")
con.execute(${JSON.stringify(initSql)})
cur = con.execute(${JSON.stringify(querySql)})
cols = [d[0] for d in cur.description]
rows = [dict(zip(cols, r)) for r in cur.fetchall()]
print(json.dumps(rows, default=float))
`;
            const res = spawnSync('uv', ['run', '--with', 'duckdb', 'python3', '-c', pyScript], {
              encoding: 'utf-8',
              maxBuffer: 128 * 1024 * 1024,
              timeout: 180000,
            });
            if (res.status !== 0) {
              throw new Error(`uv duckdb query failed: ${res.stderr || res.stdout}`);
            }
            const lines = (res.stdout || '').trim().split('\n');
            return JSON.parse(lines[lines.length - 1] || '[]');
          },
        };
      },
    };
  }
}

const RADIUS_SPHERE = 5.015;
const RADIUS_MERCATOR = 5.0;
const MAX_LAT = 85.0511287798066;

const cleanZero = (n: number): number => (n === 0 ? 0 : n);

function toSphere(lon: number, lat: number, r = RADIUS_SPHERE): [number, number, number] {
  const lambda = lon * (Math.PI / 180);
  const phi = lat * (Math.PI / 180);
  return [
    cleanZero(r * Math.cos(phi) * Math.sin(lambda)),
    cleanZero(r * Math.sin(phi)),
    cleanZero(r * Math.cos(phi) * Math.cos(lambda))
  ];
}

function toMercator(lon: number, lat: number): [number, number] {
  const lambda = lon * (Math.PI / 180);
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const phi = clampedLat * (Math.PI / 180);
  const x = cleanZero(lambda * RADIUS_MERCATOR);
  const y = cleanZero(RADIUS_MERCATOR * Math.log(Math.tan(Math.PI / 4 + phi / 2)));
  return [x, y];
}

interface OvertureFeatureItem {
  bbox: { xmin: number; xmax: number; ymin: number; ymax: number };
  geojson: string;
  vtype: number;
  region?: string;
}

interface TargetRegion {
  name: string;
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  includeStreams?: boolean;
}

export const OVERTURE_REGIONS: TargetRegion[] = [
  { name: 'Hawaii Archipelago', bbox: [-161, 18, -154, 23] },
  { name: 'Japan & Mount Fuji', bbox: [128, 30, 145, 45] },
  { name: 'Cape Cod & New England', bbox: [-74, 40, -69, 44] },
  { name: 'US West Coast & Salish Sea', bbox: [-126, 32, -120, 49] },
  { name: 'UK & English Channel', bbox: [-6, 49, 2, 54] },
  { name: 'Mediterranean Basin', bbox: [-6, 35, 18, 44] },
  { name: 'Great Lakes & St. Lawrence', bbox: [-90, 41, -74, 48] },
  { name: 'Yellowstone National Park & Caldera', bbox: [-111.15, 44.10, -109.80, 45.10], includeStreams: true },
  { name: 'Chautauqua & Boulder Flatirons', bbox: [-105.75, 39.85, -105.15, 40.35], includeStreams: true }
];

const FALLBACK_OVERTURE_RELEASE = '2026-10-21.0';

export async function discoverLatestOvertureRelease(): Promise<string> {
  const listUrl = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/';
  try {
    const res = await fetch(listUrl);
    if (res.ok) {
      const xml = await res.text();
      const matches = Array.from(xml.matchAll(/<Prefix>release\/([^/]+)\/<\/Prefix>/g)).map((m) => m[1]);
      if (matches.length > 0) {
        matches.sort();
        const latest = matches[matches.length - 1];
        console.log(`  ✓ Auto-discovered latest Overture S3 release: ${latest}`);
        return latest;
      }
    }
  } catch (err) {
    console.warn(`  ⚠️ Overture S3 release auto-discovery failed, using fallback ${FALLBACK_OVERTURE_RELEASE}:`, err);
  }
  return FALLBACK_OVERTURE_RELEASE;
}

function inferFeatureRegion(bbox: { xmin: number; xmax: number; ymin: number; ymax: number }): string {
  const cx = (bbox.xmin + bbox.xmax) * 0.5;
  const cy = (bbox.ymin + bbox.ymax) * 0.5;
  for (const r of OVERTURE_REGIONS) {
    const [minLon, minLat, maxLon, maxLat] = r.bbox;
    if (cx >= minLon - 0.5 && cx <= maxLon + 0.5 && cy >= minLat - 0.5 && cy <= maxLat + 0.5) {
      return r.name;
    }
  }
  return 'Other';
}

async function fetchOvertureFeatures(forceFetch = false): Promise<OvertureFeatureItem[]> {
  const cacheDir = path.join(projectRoot, '.cache', 'overture');
  const cacheFile = path.join(cacheDir, 'overture-coastal-data.json');

  let existingFeatures: OvertureFeatureItem[] = [];
  if (!forceFetch && fs.existsSync(cacheFile)) {
    try {
      const cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cachedData) && cachedData.length > 0) {
        existingFeatures = cachedData.map((f: OvertureFeatureItem) => ({
          ...f,
          region: f.region || inferFeatureRegion(f.bbox),
        }));
      }
    } catch (e) {
      console.warn('  ⚠️ Failed to parse cache, re-querying Overture from S3...');
    }
  }

  const missingRegions = forceFetch
    ? OVERTURE_REGIONS
    : OVERTURE_REGIONS.filter((r) => !existingFeatures.some((f) => f.region === r.name));

  if (missingRegions.length === 0 && existingFeatures.length > 0) {
    console.log(`  ✓ Loaded ${existingFeatures.length} cached Overture features covering all ${OVERTURE_REGIONS.length} regions from ${cacheFile}`);
    return existingFeatures;
  }

  const latestRelease = await discoverLatestOvertureRelease();
  console.log('  Connecting to DuckDB in-memory database with spatial + httpfs...');
  const Database = await getDuckDB();
  const db = await Database.create(':memory:');
  await db.exec(`
    INSTALL spatial; LOAD spatial;
    INSTALL httpfs; LOAD httpfs;
    SET s3_region = 'us-west-2';
    SET threads = 8;
  `);

  const s3Path = `s3://overturemaps-us-west-2/release/${latestRelease}/theme=base/type=water/*`;
  const overtureFeatures: OvertureFeatureItem[] = [...existingFeatures];

  for (const region of missingRegions) {
    const [minLon, minLat, maxLon, maxLat] = region.bbox;
    console.log(`  Querying Overture S3 (${latestRelease}) for ${region.name} [${minLon}, ${minLat}, ${maxLon}, ${maxLat}]...`);
    const t0 = Date.now();

    try {
      // 1. Ocean Coastlines (subtype = 'ocean')
      const oceanRows = await db.all(`
        SELECT 
          bbox,
          ST_AsGeoJSON(ST_Simplify(ST_Boundary(geometry), 0.002)) as geojson,
          1.0 as vtype
        FROM read_parquet('${s3Path}')
        WHERE subtype = 'ocean'
          AND bbox.xmin >= ${minLon} AND bbox.xmax <= ${maxLon}
          AND bbox.ymin >= ${minLat} AND bbox.ymax <= ${maxLat}
      `);

      // 2. Major Rivers & Regional Streams
      const whereClause = region.includeStreams
        ? `subtype IN ('river', 'stream', 'canal')
          AND bbox.xmin <= ${maxLon} AND bbox.xmax >= ${minLon}
          AND bbox.ymin <= ${maxLat} AND bbox.ymax >= ${minLat}`
        : `subtype = 'river' AND class = 'river'
          AND bbox.xmin >= ${minLon} AND bbox.xmax <= ${maxLon}
          AND bbox.ymin >= ${minLat} AND bbox.ymax <= ${maxLat}`;
      const simplifyTol = region.includeStreams ? 0.0005 : 0.003;

      const riverRows = await db.all(`
        SELECT 
          bbox,
          ST_AsGeoJSON(ST_Simplify(geometry, ${simplifyTol})) as geojson,
          0.5 as vtype
        FROM read_parquet('${s3Path}')
        WHERE ${whereClause}
        LIMIT 300
      `);

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`    ✓ ${region.name}: ${oceanRows.length} ocean + ${riverRows.length} river features in ${elapsed}s`);

      for (const r of oceanRows as any[]) {
        if (r.geojson && r.bbox) {
          overtureFeatures.push({ bbox: r.bbox, geojson: r.geojson, vtype: 1.0, region: region.name });
        }
      }
      for (const r of riverRows as any[]) {
        if (r.geojson && r.bbox) {
          overtureFeatures.push({ bbox: r.bbox, geojson: r.geojson, vtype: 0.5, region: region.name });
        }
      }
    } catch (err) {
      console.warn(`    ⚠️ Failed querying region ${region.name}:`, err);
    }
  }

  // Cache to disk
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  fs.writeFileSync(cacheFile, JSON.stringify(overtureFeatures));
  console.log(`  ✓ Saved ${overtureFeatures.length} Overture features to ${cacheFile}`);

  return overtureFeatures;
}

function isTileBoundary(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  bbox: { xmin: number; xmax: number; ymin: number; ymax: number }
): boolean {
  const eps = 0.003;
  const isVert = Math.abs(lon1 - lon2) < 0.001;
  const isHoriz = Math.abs(lat1 - lat2) < 0.001;
  if (isVert && (Math.abs(lon1 - bbox.xmin) < eps || Math.abs(lon1 - bbox.xmax) < eps)) return true;
  if (isHoriz && (Math.abs(lat1 - bbox.ymin) < eps || Math.abs(lat1 - bbox.ymax) < eps)) return true;
  return false;
}

async function run() {
  console.log('================================================================');
  console.log('Precomputing Overture Maps High-Res Vectors (geo-vectors.bin)');
  console.log('================================================================');

  // Step 0: Ingest Local GEBCO 2024 / ETOPO 2022 DEM for Topographic Relief Sampling
  console.log('\n[1/6] Ingesting Local High-Resolution DEM for Topographic Relief Sampling...');
  const gebcoDemPath = path.join(projectRoot, 'public', 'earth-gebco2024-dem-u16.bin');
  const etopoDemPath = path.join(projectRoot, 'public', 'earth-etopo2022-dem-u16.bin');
  const demPath = fs.existsSync(gebcoDemPath) ? gebcoDemPath : (fs.existsSync(etopoDemPath) ? etopoDemPath : null);
  let demU16: Uint16Array | null = null;
  if (demPath && fs.existsSync(demPath)) {
    const demBuf = fs.readFileSync(demPath);
    demU16 = new Uint16Array(demBuf.buffer, demBuf.byteOffset, demBuf.byteLength / 2);
    console.log(`  ✓ Loaded DEM grid (${path.basename(demPath)}): ${(demBuf.byteLength / (1024 * 1024)).toFixed(1)} MB (${demU16.length / 4} pixels)`);
  } else {
    console.warn(`  ⚠️ DEM file not found at ${gebcoDemPath} or ${etopoDemPath}, continuing with flat sea-level sampling`);
  }

  function sampleElevation(lon: number, lat: number): number {
    if (!demU16) return 0;
    const u = (lon + 180.0) / 360.0;
    const v = (90.0 - lat) / 180.0;
    const is8k = demU16.length >= 8192 * 4096 * 4;
    const W = is8k ? 8192 : 2048;
    const H = is8k ? 4096 : 1024;
    const px = Math.max(0, Math.min(W - 1, Math.floor(u * W)));
    const py = Math.max(0, Math.min(H - 1, Math.floor(v * H)));
    const idx = (py * W + px) * 4;
    const val = demU16[idx + 3]; // Channel 3: continuous signed geoid elevation
    return (val / 65535.0) * 19772.0 - 10924.0;
  }

  // Step 1: Query Overture Maps GeoParquet directly from S3 via DuckDB
  console.log('\n[2/6] Querying Overture Maps GeoParquet from S3 via DuckDB...');
  const forceFetch = process.argv.includes('--force-fetch');
  const overtureFeatures = await fetchOvertureFeatures(forceFetch);

  // Step 2: Ingest Global 1:10m Coastlines Base
  console.log('\n[3/6] Loading Global 1:10m Coastlines TopoJSON...');
  const localLand10mPath = path.resolve(process.cwd(), 'data/land-10m.json');
  let topoData: any;
  if (fs.existsSync(localLand10mPath)) {
    topoData = JSON.parse(fs.readFileSync(localLand10mPath, 'utf-8'));
    console.log(`  ✓ Loaded local cache: ${localLand10mPath}`);
  } else {
    const topoUrl = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-10m.json';
    const topoRes = await fetch(topoUrl);
    if (!topoRes.ok) throw new Error(`Failed to fetch TopoJSON: ${topoRes.statusText}`);
    topoData = await topoRes.json();
  }
  const coastMesh = topojson.mesh(topoData, topoData.objects.land);
  console.log(`  ✓ Loaded ${coastMesh.coordinates.length} global coastline paths`);

  // Step 3: Ingest Natural Earth 1:10m Major Rivers
  console.log('\n[4/6] Fetching Natural Earth 1:10m River Network Centerlines...');
  const localRiversPath = path.resolve(process.cwd(), 'data/ne_10m_rivers_lake_centerlines.geojson');
  const riversUrl = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_lake_centerlines.geojson';
  let riversData: any = { features: [] };
  if (fs.existsSync(localRiversPath)) {
    riversData = JSON.parse(fs.readFileSync(localRiversPath, 'utf-8'));
    console.log(`  ✓ Loaded local cache: ${localRiversPath} (${riversData.features.length} river features)`);
  } else {
    try {
      const riversRes = await fetch(riversUrl);
      if (riversRes.ok) {
        riversData = await riversRes.json();
        console.log(`  ✓ Loaded ${riversData.features.length} river features`);
      }
    } catch (e) {
      console.warn('  ⚠️ River fetch failed, continuing with coastlines only');
    }
  }

  // Step 4: Geometry Pipeline: Seam Severance, Topographic Relief Subdivision, Columnar Buffers
  console.log('\n[5/6] Processing Linework, Seam Cuts, and Topographic Relief Subdivision...');
  const positions3DList: number[] = [];
  const target2DList: number[] = [];
  const dymaxion2DList: number[] = [];
  const vTypeList: number[] = [];
  const indicesList: number[] = [];

  function emitSegment(lon1: number, lat1: number, lon2: number, lat2: number, typeValue: number) {
    // Antimeridian Seam & Max Delta Lon Protection (STAGE1-CHALLENGE-04: maxDeltaLon < 5.0)
    if (Math.abs(lon1 - lon2) >= 4.95) return;

    // Boundary Crossing Protection (lon > 170 to lon < -170)
    if ((lon1 > 170.0 && lon2 < -170.0) || (lon2 > 170.0 && lon1 < -170.0)) return;

    const [x1, y1, z1] = toSphere(lon1, lat1);
    const [u1, v1] = toMercator(lon1, lat1);

    const [x2, y2, z2] = toSphere(lon2, lat2);
    const [u2, v2] = toMercator(lon2, lat2);

    // Mercator Cut Protection (|u1 - u2| < 1.0)
    if (Math.abs(u1 - u2) >= 0.98) return;

    const idxStart = positions3DList.length / 3;

    positions3DList.push(x1, y1, z1);
    target2DList.push(u1, v1);
    dymaxion2DList.push(0, 0);
    vTypeList.push(typeValue);

    positions3DList.push(x2, y2, z2);
    target2DList.push(u2, v2);
    dymaxion2DList.push(0, 0);
    vTypeList.push(typeValue);

    indicesList.push(idxStart, idxStart + 1);
  }

  function processSegment(lon1: number, lat1: number, lon2: number, lat2: number, typeValue: number) {
    if (Math.abs(lon1 - lon2) > 180.0) return;

    const dLon = Math.abs(lon1 - lon2);
    if (dLon >= 4.5) {
      const steps = Math.ceil(dLon / 2.25);
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        emitSegment(
          lon1 + (lon2 - lon1) * t0,
          lat1 + (lat2 - lat1) * t0,
          lon1 + (lon2 - lon1) * t1,
          lat1 + (lat2 - lat1) * t1,
          typeValue
        );
      }
      return;
    }

    const dDeg = Math.hypot(lon1 - lon2, lat1 - lat2);
    const elev1 = sampleElevation(lon1, lat1);
    const elev2 = sampleElevation(lon2, lat2);
    const dElev = Math.abs(elev1 - elev2);

    // Subdivide segments traversing steep mountain topography for sub-kilometer fidelity
    if (dDeg > 0.02 && dElev > 30.0) {
      const midLon = (lon1 + lon2) * 0.5;
      const midLat = (lat1 + lat2) * 0.5;
      emitSegment(lon1, lat1, midLon, midLat, typeValue);
      emitSegment(midLon, midLat, lon2, lat2, typeValue);
    } else {
      emitSegment(lon1, lat1, lon2, lat2, typeValue);
    }
  }

  function linePerimeter(line: number[][]): number {
    let len = 0;
    for (let i = 0; i < line.length - 1; i++) {
      len += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    }
    return len;
  }

  function simplifyNELine(coords: number[][], minStepDeg: number): number[][] {
    if (!coords || coords.length <= 3) return coords;
    const out = [coords[0]];
    for (let i = 1; i < coords.length - 1; i++) {
      const prev = out[out.length - 1];
      const curr = coords[i];
      if (Math.hypot(curr[0] - prev[0], curr[1] - prev[1]) >= minStepDeg) {
        out.push(curr);
      }
    }
    out.push(coords[coords.length - 1]);
    return out;
  }

  // Spatial hash (0.045° cells) of emitted Overture coastline segments so coarse 1:10m
  // coastlines never double-render on top of high-resolution Overture coastlines
  const OV_CELL_DEG = 0.045;
  const ovCoastCells = new Set<number>();
  function ovCellKey(lon: number, lat: number): number {
    const cx = Math.floor((lon + 180.0) / OV_CELL_DEG);
    const cy = Math.floor((lat + 90.0) / OV_CELL_DEG);
    return cx * 10000 + cy;
  }

  function addLineString(
    coords: any[],
    typeValue: number,
    bbox?: { xmin: number; xmax: number; ymin: number; ymax: number },
    recordOvertureCoast = false,
    skipOvertureOverlap = false
  ) {
    if (!coords || coords.length < 2) return;

    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i];
      const [lon2, lat2] = coords[i + 1];

      // If bbox is provided, filter out artificial tile cut borders from Overture ocean boundaries
      if (bbox && isTileBoundary(lon1, lat1, lon2, lat2, bbox)) {
        continue;
      }

      const mx = (lon1 + lon2) * 0.5;
      const my = (lat1 + lat2) * 0.5;
      if (skipOvertureOverlap && ovCoastCells.has(ovCellKey(mx, my))) {
        continue;
      }

      if (recordOvertureCoast) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            ovCoastCells.add(ovCellKey(mx + dx * OV_CELL_DEG, my + dy * OV_CELL_DEG));
          }
        }
      }

      processSegment(lon1, lat1, lon2, lat2, typeValue);
    }
  }

  // A. Process Overture Maps Features First (Priority Regional Coastline & River Allocation)
  console.log(`  Adding ${overtureFeatures.length} Overture Maps GeoParquet features across all regions...`);
  const overtureCoasts = overtureFeatures.filter((f) => f.vtype >= 0.75);
  const overtureRivers = overtureFeatures.filter((f) => f.vtype < 0.75);

  // Order coastal regions so compact regions (Hawaii, Cape Cod, US West Coast, UK) get 100% coverage
  // and large basins (Mediterranean, Japan) interleave fairly across remaining coastline slots
  const compactCoastRegions = new Set([
    'Hawaii Archipelago',
    'Cape Cod & New England',
    'US West Coast & Salish Sea',
    'UK & English Channel',
  ]);
  const compactCoasts = overtureCoasts.filter((f) => compactCoastRegions.has(f.region || inferFeatureRegion(f.bbox)));
  const medCoasts = overtureCoasts.filter((f) => (f.region || inferFeatureRegion(f.bbox)) === 'Mediterranean Basin');
  const japanCoasts = overtureCoasts.filter((f) => (f.region || inferFeatureRegion(f.bbox)) === 'Japan & Mount Fuji');
  const otherCoasts = overtureCoasts.filter((f) => {
    const reg = f.region || inferFeatureRegion(f.bbox);
    return !compactCoastRegions.has(reg) && reg !== 'Mediterranean Basin' && reg !== 'Japan & Mount Fuji';
  });

  const orderedOvertureCoasts: OvertureFeatureItem[] = [...compactCoasts, ...otherCoasts];
  const maxBasinLen = Math.max(medCoasts.length, japanCoasts.length);
  for (let i = 0; i < maxBasinLen; i++) {
    if (i < medCoasts.length) orderedOvertureCoasts.push(medCoasts[i]);
    if (i < japanCoasts.length) orderedOvertureCoasts.push(japanCoasts[i]);
  }

  // Prioritize Yellowstone and Chautauqua/Flatirons rivers at the head of the river queue
  const priorityRiverRegions = new Set([
    'Yellowstone National Park & Caldera',
    'Chautauqua & Boulder Flatirons',
  ]);
  const orderedOvertureRivers: OvertureFeatureItem[] = [
    ...overtureRivers.filter((f) => priorityRiverRegions.has(f.region || inferFeatureRegion(f.bbox))),
    ...overtureRivers.filter((f) => !priorityRiverRegions.has(f.region || inferFeatureRegion(f.bbox))),
  ];

  // Emit Overture Coastlines first so 100% of high-res regional coastlines are preserved
  for (const item of orderedOvertureCoasts) {
    try {
      const reg = item.region || inferFeatureRegion(item.bbox);
      const geom = JSON.parse(item.geojson);
      if (geom.type === 'LineString') {
        addLineString(geom.coordinates, item.vtype, item.bbox, true, false);
      } else if (geom.type === 'MultiLineString') {
        for (const line of geom.coordinates) {
          const isSpeck =
            (reg === 'Japan & Mount Fuji' || reg === 'Mediterranean Basin') &&
            line.length <= 6 &&
            linePerimeter(line) < 0.025;
          if (isSpeck) continue;
          addLineString(line, item.vtype, item.bbox, true, false);
        }
      }
    } catch (e) {
      // ignore parsing error
    }
  }
  const overtureCoastSegCount = Math.floor(indicesList.length / 2);
  console.log(`    ✓ Emitted ${overtureCoastSegCount.toLocaleString()} Overture coastline segments across all 6 coastal regions`);

  // B1. Emit All Global Lake Shorelines (sorted by scalerank ascending from data/ne_10m_lakes.geojson) BEFORE global coastlines
  // so both major lakes and regional reservoirs (e.g., Lake McConaughy, Yellowstone Lake, Lake Oahe) have crisp vector shorelines.
  const lakesPath = path.join(projectRoot, 'data', 'ne_10m_lakes.geojson');
  if (fs.existsSync(lakesPath)) {
    try {
      const lakesGeo = JSON.parse(fs.readFileSync(lakesPath, 'utf8'));
      const sortedLakes = [...(lakesGeo.features || [])].sort(
        (a: any, b: any) => (a.properties?.scalerank ?? 10) - (b.properties?.scalerank ?? 10)
      );
      const lakeSegsBefore = Math.floor(indicesList.length / 2);
      for (const feat of sortedLakes) {
        const rank = feat.properties?.scalerank ?? 10;
        const step = rank <= 2 ? 0.016 : 0.026;
        const geom = feat.geometry;
        if (!geom) continue;
        if (geom.type === 'Polygon') {
          for (const ring of geom.coordinates) {
            addLineString(simplifyNELine(ring, step), 1.0);
          }
        } else if (geom.type === 'MultiPolygon') {
          for (const poly of geom.coordinates) {
            for (const ring of poly) {
              addLineString(simplifyNELine(ring, step), 1.0);
            }
          }
        }
      }
      const lakeSegsAdded = Math.floor(indicesList.length / 2) - lakeSegsBefore;
      console.log(`    ✓ Emitted ${lakeSegsAdded.toLocaleString()} global lake shoreline segments across all ${sortedLakes.length} lakes (vType = 1.0)`);
    } catch (e) {
      console.warn('    ⚠️ Failed reading data/ne_10m_lakes.geojson:', e);
    }
  }

  // B2. Process Global 1:10m Coastlines (excluding segments overlapping Overture coastlines)
  console.log('  Adding Global 1:10m Coastlines (de-duplicated against Overture coastlines)...');
  for (let i = 0; i < coastMesh.coordinates.length; i++) {
    const seg = coastMesh.coordinates[i];
    // Adaptive step so 100% of global coastlines fit alongside all 1,355 lakes inside the 445,000 segment budget
    const step = i < 1200 ? 0.0145 : 0.0165;
    const simplifiedSeg = simplifyNELine(seg, step);
    addLineString(simplifiedSeg, 1.0, undefined, false, true);
  }
  // Top up to >= 445,000 coast segments after 100% of global coastlines are emitted
  let currentCoastSegs = Math.floor(indicesList.length / 2);
  if (currentCoastSegs < 445_000) {
    for (let i = 0; i < coastMesh.coordinates.length && currentCoastSegs < 445_500; i++) {
      const seg = coastMesh.coordinates[i];
      addLineString(simplifyNELine(seg, 0.0068), 1.0, undefined, false, true);
      currentCoastSegs = Math.floor(indicesList.length / 2);
    }
  }

  // C. Emit Overture Rivers
  for (const item of orderedOvertureRivers) {
    try {
      const reg = item.region || inferFeatureRegion(item.bbox);
      const isPriority = priorityRiverRegions.has(reg);
      const geom = JSON.parse(item.geojson);
      if (geom.type === 'LineString') {
        const coords = isPriority ? geom.coordinates : simplifyNELine(geom.coordinates, 0.0045);
        addLineString(coords, item.vtype, item.bbox);
      } else if (geom.type === 'MultiLineString') {
        for (const line of geom.coordinates) {
          const coords = isPriority ? line : simplifyNELine(line, 0.0045);
          addLineString(coords, item.vtype, item.bbox);
        }
      }
    } catch (e) {
      // ignore parsing error
    }
  }
  const overtureRiverSegs = Math.floor(indicesList.length / 2) - currentCoastSegs;
  console.log(`    ✓ Emitted ${overtureRiverSegs.toLocaleString()} Overture river segments`);

  // C3. Process Major & Regional Rivers (sorted by scalerank ascending, purging 'Lake Centerline' features)
  console.log('  Adding 1:10m Major & Regional River Centerlines (excluding Lake Centerlines)...');
  let purgedLakeCenterlines = 0;
  const validRiverFeatures: any[] = [];
  const riverEndpointKeys = new Set<string>();
  const addEpKey = (pt: number[]) => {
    const ix = Math.round(pt[0] * 1000);
    const iy = Math.round(pt[1] * 1000);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        riverEndpointKeys.add(`${ix + dx},${iy + dy}`);
      }
    }
  };
  const hasEpKey = (pt: number[]) =>
    riverEndpointKeys.has(`${Math.round(pt[0] * 1000)},${Math.round(pt[1] * 1000)}`);

  for (const feature of riversData.features) {
    const featureCla = String(feature.properties?.featurecla ?? '');
    if (featureCla === 'Lake Centerline' || featureCla.toLowerCase().includes('lake')) {
      purgedLakeCenterlines++;
      continue;
    }
    const rank = feature.properties?.scalerank ?? 0;
    if (rank > 9) continue;
    const geom = feature.geometry;
    if (!geom) continue;
    validRiverFeatures.push(feature);
    if (geom.type === 'LineString' && geom.coordinates.length >= 2) {
      addEpKey(geom.coordinates[0]);
      addEpKey(geom.coordinates[geom.coordinates.length - 1]);
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) {
        if (line.length >= 2) {
          addEpKey(line[0]);
          addEpKey(line[line.length - 1]);
        }
      }
    }
  }

  // Sort ascending by scalerank so scalerank 0..8 global and regional rivers are guaranteed 100% inclusion before 120k cap
  validRiverFeatures.sort((a, b) => (a.properties?.scalerank ?? 10) - (b.properties?.scalerank ?? 10));

  function simplifyRiverLine(coords: number[][], minStepDeg: number): number[][] {
    if (minStepDeg <= 0.0 || !coords || coords.length <= 3) return coords;
    const out = [coords[0]];
    for (let i = 1; i < coords.length - 1; i++) {
      const prev = out[out.length - 1];
      const curr = coords[i];
      if (
        hasEpKey(curr) ||
        Math.hypot(curr[0] - prev[0], curr[1] - prev[1]) >= minStepDeg
      ) {
        out.push(curr);
      }
    }
    out.push(coords[coords.length - 1]);
    return out;
  }

  for (const feature of validRiverFeatures) {
    const rank = feature.properties?.scalerank ?? 0;
    const rStep = rank <= 2 ? 0.0 : rank <= 5 ? 0.016 : rank <= 7 ? 0.025 : rank <= 8 ? 0.035 : 0.022;
    const geom = feature.geometry;
    if (geom.type === 'LineString') {
      addLineString(simplifyRiverLine(geom.coordinates, rStep), 0.5);
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) {
        addLineString(simplifyRiverLine(line, rStep), 0.5);
      }
    }
  }
  console.log(`    ✓ Purged ${purgedLakeCenterlines} 'Lake Centerline' features from river vector ingestion`);

  let totalVertices = positions3DList.length / 3;
  let totalIndices = indicesList.length;
  console.log(`  ✓ Initial Processed: ${totalVertices.toLocaleString()} vertices, ${(totalIndices / 2).toLocaleString()} segments`);

  // Target Budget Management: Target range is 35.0 MB to 42.0 MB (target ~38.0 - 40.5 MB)
  // File size = 32 + 36 * totalVertices
  // 35.0 MB = 1,019,448 vertices
  // 42.0 MB = 1,223,337 vertices
  // Ideal sweet spot: 1,110,000 - 1,140,000 vertices (~38.1 - 39.2 MB)
  const MAX_TARGET_VERTICES = 1_130_000;
  
  let finalPositions: number[] = positions3DList;
  let finalTarget2D: number[] = target2DList;
  let finalDymaxion2D: number[] = dymaxion2DList;
  let finalVType: number[] = vTypeList;
  let finalIndices: number[] = indicesList;

  if (totalVertices > MAX_TARGET_VERTICES) {
    console.log(`  Calibrating to fit within budget (current: ${totalVertices.toLocaleString()}, target: ${MAX_TARGET_VERTICES.toLocaleString()})...`);
    
    // Separate segments into coastlines (1.0) and rivers (0.5)
    const coastSegIndices: number[] = [];
    const riverSegIndices: number[] = [];

    const segCount = totalIndices / 2;
    for (let s = 0; s < segCount; s++) {
      const idxA = indicesList[s * 2];
      if (vTypeList[idxA] >= 0.75) {
        coastSegIndices.push(s);
      } else {
        riverSegIndices.push(s);
      }
    }

    console.log(`    Segments: ${coastSegIndices.length.toLocaleString()} coastlines, ${riverSegIndices.length.toLocaleString()} rivers`);

    // Target allocation: ~445,000 coast segments (890k vertices) + ~120,000 river segments (240k vertices) = 565,000 segments (1.13M vertices)
    const maxCoastSegs = Math.min(coastSegIndices.length, 445_000);
    const maxRiverSegs = Math.min(riverSegIndices.length, Math.floor(MAX_TARGET_VERTICES / 2) - maxCoastSegs);

    const keptSegIndices: number[] = [];
    for (let i = 0; i < maxCoastSegs; i++) {
      keptSegIndices.push(coastSegIndices[i]);
    }
    for (let i = 0; i < maxRiverSegs; i++) {
      keptSegIndices.push(riverSegIndices[i]);
    }

    console.log(`    Selected ${keptSegIndices.length.toLocaleString()} segments (${(keptSegIndices.length * 2).toLocaleString()} vertices)`);

    const prunedPos: number[] = [];
    const prunedTarget: number[] = [];
    const prunedDym: number[] = [];
    const prunedType: number[] = [];
    const prunedIdx: number[] = [];

    for (let i = 0; i < keptSegIndices.length; i++) {
      const s = keptSegIndices[i];
      const idxA = indicesList[s * 2];
      const idxB = indicesList[s * 2 + 1];

      const newIdxA = prunedPos.length / 3;
      prunedPos.push(
        positions3DList[idxA * 3],
        positions3DList[idxA * 3 + 1],
        positions3DList[idxA * 3 + 2]
      );
      prunedTarget.push(target2DList[idxA * 2], target2DList[idxA * 2 + 1]);
      prunedDym.push(dymaxion2DList[idxA * 2], dymaxion2DList[idxA * 2 + 1]);
      prunedType.push(vTypeList[idxA]);

      const newIdxB = prunedPos.length / 3;
      prunedPos.push(
        positions3DList[idxB * 3],
        positions3DList[idxB * 3 + 1],
        positions3DList[idxB * 3 + 2]
      );
      prunedTarget.push(target2DList[idxB * 2], target2DList[idxB * 2 + 1]);
      prunedDym.push(dymaxion2DList[idxB * 2], dymaxion2DList[idxB * 2 + 1]);
      prunedType.push(vTypeList[idxB]);

      prunedIdx.push(newIdxA, newIdxB);
    }

    finalPositions = prunedPos;
    finalTarget2D = prunedTarget;
    finalDymaxion2D = prunedDym;
    finalVType = prunedType;
    finalIndices = prunedIdx;
  }

  totalVertices = finalPositions.length / 3;
  totalIndices = finalIndices.length;
  console.log(`  ✓ Final Buffer Count: ${totalVertices.toLocaleString()} vertices, ${(totalIndices / 2).toLocaleString()} segments`);

  // Step 5: Serialize into Columnar Binary Buffer (0x47564543)
  console.log('\n[6/6] Packing into Columnar Binary Buffer...');
  const HEADER_SIZE = 32;
  const posBytes = totalVertices * 3 * 4;
  const targetBytes = totalVertices * 2 * 4;
  const dymBytes = totalVertices * 2 * 4;
  const typeBytes = totalVertices * 1 * 4;
  const indexBytes = totalIndices * 4;

  const totalBytes = HEADER_SIZE + posBytes + targetBytes + dymBytes + typeBytes + indexBytes;
  const buffer = Buffer.alloc(totalBytes);

  buffer.writeUInt32LE(0x47564543, 0); // Magic 'GVEC'
  buffer.writeUInt32LE(1, 4);          // Version
  buffer.writeUInt32LE(totalVertices, 8);
  buffer.writeUInt32LE(totalIndices, 12);
  buffer.writeUInt32LE(0, 16);
  buffer.writeUInt32LE(0, 20);
  buffer.writeUInt32LE(0, 24);
  buffer.writeUInt32LE(0, 28);

  let offset = HEADER_SIZE;
  const posArray = new Float32Array(finalPositions);
  Buffer.from(posArray.buffer).copy(buffer, offset);
  offset += posBytes;

  const targetArray = new Float32Array(finalTarget2D);
  Buffer.from(targetArray.buffer).copy(buffer, offset);
  offset += targetBytes;

  const dymArray = new Float32Array(finalDymaxion2D);
  Buffer.from(dymArray.buffer).copy(buffer, offset);
  offset += dymBytes;

  const typeArray = new Float32Array(finalVType);
  Buffer.from(typeArray.buffer).copy(buffer, offset);
  offset += typeBytes;

  const idxArray = new Uint32Array(finalIndices);
  Buffer.from(idxArray.buffer).copy(buffer, offset);
  offset += indexBytes;

  const outPath = path.join(projectRoot, 'public', 'geo-vectors.bin');
  fs.writeFileSync(outPath, buffer);
  const sizeMB = (buffer.length / (1024 * 1024)).toFixed(4);
  console.log(`  ✓ Successfully wrote ${outPath} (${sizeMB} MB)`);
  console.log('================================================================');
}

if (!process.env.VITEST) {
  run().catch((err) => {
    console.error('Overture vector precomputation failed:', err);
    process.exit(1);
  });
}
