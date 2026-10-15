// ============================================================================
// File: src/core/data/toponymy/spatialCollision.ts
// Architecture: Screen-Space Spatial Collision Avoidance & Zoom Gating
// Reference: visual_quality_phase_roadmap.md (M13-P3-T3), ZOOM_DETAIL_SPEC_LEDGER.md (§5.2)
// Design Ethos: Library/Museum Archival Inscriptions
// ============================================================================

import {
  ToponymLabel,
  ToponymCategory,
  ScreenRect,
  LabelBoundingBox,
  CollisionAvoidanceOptions,
  CollisionAvoidanceResult,
  CameraProjectionContext,
} from './types';
import { resolveMinCamDist, resolveTier } from './curatedToponyms';
import { getFontAtlasMetadata, FONT_STYLE_SERIF, FONT_STYLE_TECHNICAL } from './fontAtlas';
import { evaluateMacroChartCPU } from '../../math/volumetricMath';

// ----------------------------------------------------------------------------
// Architectural Constants
// ----------------------------------------------------------------------------
/** Sheet neatline inset from viewport edge in CSS pixels */
export const DEFAULT_NEATLINE_INSET_PX = 10.0;
/** Mandatory spatial breathing moat inside neatline boundary in CSS pixels */
export const DEFAULT_NEATLINE_MOAT_PX = 10.0;
/** Mandatory spatial clearance moat around floating HUD instruments */
export const DEFAULT_HUD_MOAT_PX = 10.0;
/** Default horizontal padding buffer between adjacent labels (CSS pixels) */
export const DEFAULT_LABEL_PADDING_X_PX = 8.0;
/** Default vertical padding buffer between adjacent labels (CSS pixels) */
export const DEFAULT_LABEL_PADDING_Y_PX = 4.0;
/** Default 2D spatial hash grid cell dimension in pixels */
export const DEFAULT_SPATIAL_HASH_CELL_SIZE = 64;
/** Default maximum number of placed labels permitted on screen simultaneously */
export const DEFAULT_MAX_PLACED_LABELS = 512;
/** Canonical sphere radius matching engine and shaders */
const CANONICAL_RADIUS = 5.0;

// ----------------------------------------------------------------------------
// 1. Text Metrics & Bounding Box Measurement
// ----------------------------------------------------------------------------
interface LabelDimensions {
  advanceWidth: number;
  ascender: number;
  descender: number;
  width: number;
  height: number;
}

const DIMENSION_CACHE = new Map<string, LabelDimensions>();

/**
 * Computes exact 2D screen-space typographical dimensions for a text string
 * using the SDF font atlas glyph metrics.
 */
export function measureLabelDimensions(
  text: string,
  fontSize: number = 11.0,
  fontStyle: number = FONT_STYLE_SERIF
): LabelDimensions {
  const cacheKey = `${text}:${fontSize.toFixed(2)}:${fontStyle}`;
  const cached = DIMENSION_CACHE.get(cacheKey);
  if (cached) return cached;

  const metadata = getFontAtlasMetadata();
  const metrics = metadata.metrics;

  const normalized = (text || '').normalize('NFC');
  let cursorX = 0.0;
  let maxAscender = 0.85 * fontSize;
  let maxDescender = 0.25 * fontSize;

  const defaultAdvance = fontStyle === FONT_STYLE_TECHNICAL ? 0.60 * fontSize : 0.55 * fontSize;

  for (const char of normalized) {
    if (/[\u0300-\u036f]/.test(char)) continue; // Skip combining marks

    const lookupKey = `${char}:${fontStyle}`;
    let metric = metrics.get(lookupKey) || metrics.get(char);

    if (!metric) {
      const baseChar = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (baseChar && baseChar !== char) {
        metric = metrics.get(`${baseChar}:${fontStyle}`) || metrics.get(baseChar);
      }
    }

    if (metric) {
      const glyphAscender = metric.bearingYEm * fontSize;
      const glyphDescender = (metric.heightEm - metric.bearingYEm) * fontSize;
      if (glyphAscender > maxAscender) maxAscender = glyphAscender;
      if (glyphDescender > maxDescender) maxDescender = glyphDescender;
      cursorX += metric.advanceEm * fontSize;
    } else if (char === ' ') {
      cursorX += 0.35 * fontSize;
    } else {
      cursorX += defaultAdvance;
    }
  }

  const width = Math.max(cursorX, fontSize * 0.5);
  const height = maxAscender + maxDescender;

  const dims: LabelDimensions = {
    advanceWidth: cursorX,
    ascender: maxAscender,
    descender: maxDescender,
    width,
    height,
  };

  if (DIMENSION_CACHE.size < 2048) {
    DIMENSION_CACHE.set(cacheKey, dims);
  }

  return dims;
}

/**
 * Creates a screen-space bounding box for a label anchored at (screenX, screenY),
 * incorporating the required padding buffers.
 */
export function createLabelBoundingBox(
  label: ToponymLabel,
  screenX: number,
  screenY: number,
  paddingX: number = DEFAULT_LABEL_PADDING_X_PX,
  paddingY: number = DEFAULT_LABEL_PADDING_Y_PX
): LabelBoundingBox {
  const fontSize = label.fontSize || 11.0;
  const fontStyle = label.fontStyle !== undefined ? label.fontStyle : FONT_STYLE_SERIF;
  const dims = measureLabelDimensions(label.text, fontSize, fontStyle);

  const minX = screenX - paddingX;
  const maxX = screenX + dims.advanceWidth + paddingX;
  const minY = screenY - dims.ascender - paddingY;
  const maxY = screenY + dims.descender + paddingY;

  return {
    label,
    labelId: label.id || label.text,
    text: label.text,
    screenX,
    screenY,
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    priority: label.priority ?? 999,
    tier: resolveTier(label),
    elevationMeters: label.elevationMeters,
    category: label.category,
  };
}

// ----------------------------------------------------------------------------
// 2. Geodetic-to-Screen Projection & Manifold Transformation
// ----------------------------------------------------------------------------
/**
 * Multiplies a 4-component vector by a column-major 4x4 matrix.
 */
function multiplyMatrix4Vector4(m: Float32Array | number[], v: [number, number, number, number]): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

/**
 * Projects a geodetic coordinate (lonDeg, latDeg) to 2D screen coordinates
 * under manifold unfurl deformations and the current camera view-projection.
 */
export function projectGeodeticToScreen(
  lonDeg: number,
  latDeg: number,
  ctx: CameraProjectionContext,
  elevationMeters: number = 0
): {
  visible: boolean;
  screenX: number;
  screenY: number;
  facing: number;
  camDist: number;
  cullReason?: 'limb' | 'near' | 'frustum' | 'invalid';
} {
  const DEG_TO_RAD = Math.PI / 180.0;
  const lonRad = lonDeg * DEG_TO_RAD;
  const latRad = latDeg * DEG_TO_RAD;
  const radius = ctx.radius || CANONICAL_RADIUS;
  const unfurl = Math.max(0.0, Math.min(1.0, ctx.unfurl ?? 0.0));

  // 1. Manifold coordinate evaluation
  let worldX: number;
  let worldY: number;
  let worldZ: number;
  let normalX: number;
  let normalY: number;
  let normalZ: number;

  if (unfurl <= 0.0001) {
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    const cosLon = Math.cos(lonRad);
    const sinLon = Math.sin(lonRad);
    worldX = radius * cosLat * sinLon;
    worldY = radius * sinLat;
    worldZ = radius * cosLat * cosLon;
    normalX = worldX / radius;
    normalY = worldY / radius;
    normalZ = worldZ / radius;
  } else {
    const macro = evaluateMacroChartCPU(lonRad, latRad, 0.0, unfurl, radius);
    worldX = macro.pos[0];
    worldY = macro.pos[1];
    worldZ = macro.pos[2];
    normalX = macro.normal[0];
    normalY = macro.normal[1];
    normalZ = macro.normal[2];
  }

  // 1b. DEM Crust Elevation Conformance
  if (elevationMeters !== 0 && ctx.displacementScale !== undefined) {
    const dispScale = ctx.displacementScale * 2.8;
    const exponent = Math.max(0.2, Math.min(4.0, ctx.peakExponent ?? 1.4));
    const demV = 0.5 - latRad / Math.PI;
    const poleDist = Math.abs(demV - 0.5) * 2.0;
    const tPole = Math.max(0.0, Math.min(1.0, (poleDist - 0.85) / (0.98 - 0.85)));
    const poleAtten = 1.0 - tPole * tPole * (3.0 - 2.0 * tPole);
    let normalDisp = 0.0;
    if (elevationMeters >= 0.0) {
      const normH = Math.max(0.0, Math.min(1.0, elevationMeters / 8848.0));
      normalDisp = Math.pow(normH, exponent) * dispScale * poleAtten;
    } else {
      const normD = Math.max(0.0, Math.min(1.0, -elevationMeters / 10924.0));
      const shelfD = normD / (1.0 + 1.5 * (1.0 - normD));
      normalDisp = -shelfD * dispScale * poleAtten;
    }
    const totalDisp = normalDisp + 0.0015;
    worldX += normalX * totalDisp;
    worldY += normalY * totalDisp;
    worldZ += normalZ * totalDisp;
  }

  // Camera coordinates extraction (handles Object, Array, Float32Array, Float64Array)
  let camX: number;
  let camY: number;
  let camZ: number;
  const cp = ctx.cameraPosition as any;
  if (Array.isArray(cp) || cp instanceof Float32Array || cp instanceof Float64Array || ('0' in cp && typeof cp[0] === 'number')) {
    camX = cp[0];
    camY = cp[1];
    camZ = cp[2];
  } else if (cp && typeof cp.x === 'number') {
    camX = cp.x;
    camY = cp.y;
    camZ = cp.z;
  } else {
    camX = 0;
    camY = 0;
    camZ = 15;
  }

  // 2. Horizon limb backface culling on spherical manifold (matches sdf_text.wgsl vs_main)
  const toCamX = camX - worldX;
  const toCamY = camY - worldY;
  const toCamZ = camZ - worldZ;
  const camDist = Math.hypot(toCamX, toCamY, toCamZ);

  if (camDist < 1e-4) {
    return { visible: false, screenX: 0, screenY: 0, facing: 0, camDist, cullReason: 'invalid' };
  }

  const uCamX = toCamX / camDist;
  const uCamY = toCamY / camDist;
  const uCamZ = toCamZ / camDist;
  const facing = normalX * uCamX + normalY * uCamY + normalZ * uCamZ;

  const sphereFactor = 1.0 - Math.min(1.0, Math.max(0.0, (unfurl - 0.0) / 0.35));
  if (sphereFactor > 0.5 && facing < 0.22) {
    return { visible: false, screenX: 0, screenY: 0, facing, camDist, cullReason: 'limb' };
  }

  // 3. View-Projection Transformation to Clip Space (Zero-GC scalar multiplication)
  let clipX: number;
  let clipY: number;
  let clipZ: number;
  let clipW: number;

  const vm = ctx.viewMatrix;
  const pm = ctx.projectionMatrix;
  const vnX = vm ? vm[0] * normalX + vm[4] * normalY + vm[8] * normalZ : 0.0;
  const vnY = vm ? vm[1] * normalX + vm[5] * normalY + vm[9] * normalZ : 0.0;
  const projScaleX = pm ? Math.max(0.25, Math.abs(pm[0])) : 1.5;

  if (ctx.viewProjectionMatrix) {
    const m = ctx.viewProjectionMatrix;
    clipX = m[0] * worldX + m[4] * worldY + m[8] * worldZ + m[12];
    clipY = m[1] * worldX + m[5] * worldY + m[9] * worldZ + m[13];
    clipZ = m[2] * worldX + m[6] * worldY + m[10] * worldZ + m[14];
    clipW = m[3] * worldX + m[7] * worldY + m[11] * worldZ + m[15];
  } else {
    const vx = vm[0] * worldX + vm[4] * worldY + vm[8] * worldZ + vm[12];
    const vy = vm[1] * worldX + vm[5] * worldY + vm[9] * worldZ + vm[13];
    const vz = vm[2] * worldX + vm[6] * worldY + vm[10] * worldZ + vm[14];
    const vw = vm[3] * worldX + vm[7] * worldY + vm[11] * worldZ + vm[15];

    clipX = pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12] * vw;
    clipY = pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13] * vw;
    clipZ = pm[2] * vx + pm[6] * vy + pm[10] * vz + pm[14] * vw;
    clipW = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15] * vw;
  }

  const nearPlane = Math.max(ctx.nearPlane ?? 0.1, 0.00002);
  if (clipW < nearPlane) {
    return { visible: false, screenX: 0, screenY: 0, facing, camDist, cullReason: 'near' };
  }

  // 4. Perspective Divide to Normalized Device Coordinates (NDC)
  const invW = 1.0 / clipW;
  const ndcX = clipX * invW;
  const ndcY = clipY * invW;
  const ndcZ = clipZ * invW;

  // Frustum margin culling
  if (ndcX < -1.4 || ndcX > 1.4 || ndcY < -1.4 || ndcY > 1.4 || ndcZ > 1.0) {
    return { visible: false, screenX: 0, screenY: 0, facing, camDist, cullReason: 'frustum' };
  }

  // 5. Screen-Space Pixel Transformation
  const screenX = (ndcX * 0.5 + 0.5) * ctx.viewportWidth;
  const screenY = (1.0 - (ndcY * 0.5 + 0.5)) * ctx.viewportHeight;

  return {
    visible: true,
    screenX,
    screenY,
    facing,
    camDist,
    vnX,
    vnY,
    clipW,
    projScaleX,
  } as any;
}

// ----------------------------------------------------------------------------
// 3. Hierarchical Priority Ordering & Sorting
// ----------------------------------------------------------------------------
/**
 * Category prominence hierarchy for cartographic establishing weight.
 * Planetary references establish the map before local details.
 */
const CATEGORY_WEIGHT: Record<ToponymCategory, number> = {
  continent: 1,
  water: 2,
  celestial: 3,
  state: 4,
  summit: 5,
  trench: 6,
  strait: 7,
  cape: 8,
  shield: 9,
  range: 10,
  sounding: 11,
  geodetic: 12,
};

/**
 * Compares two toponym labels for priority-ordered placement:
 * 1. Tier Rank: orbital (1) > regional (2) > local (3)
 * 2. Explicit Priority: 1 = highest, 2, 3...
 * 3. Category Prominence: Continents/Oceans > Summits > Soundings
 * 4. Elevation Prominence: Higher summits win; deeper soundings win
 * 5. Deterministic ID string comparison (prevents frame jitter)
 */
export function compareToponymPriority(a: ToponymLabel, b: ToponymLabel): number {
  // 1. Tier Rank
  const tierA = resolveTier(a);
  const tierB = resolveTier(b);
  const tierRankA = tierA === 'orbital' ? 1 : tierA === 'regional' ? 2 : 3;
  const tierRankB = tierB === 'orbital' ? 1 : tierB === 'regional' ? 2 : 3;
  if (tierRankA !== tierRankB) {
    return tierRankA - tierRankB;
  }

  // 2. Explicit Priority Rating
  const prioA = a.priority ?? 999;
  const prioB = b.priority ?? 999;
  if (prioA !== prioB) {
    return prioA - prioB;
  }

  // 3. Category Prominence Weight
  const catWeightA = a.category ? CATEGORY_WEIGHT[a.category] ?? 50 : 50;
  const catWeightB = b.category ? CATEGORY_WEIGHT[b.category] ?? 50 : 50;
  if (catWeightA !== catWeightB) {
    return catWeightA - catWeightB;
  }

  // 4. Elevation Prominence
  if (a.category === 'summit' && b.category === 'summit') {
    const elevA = a.elevationMeters ?? 0;
    const elevB = b.elevationMeters ?? 0;
    if (elevA !== elevB) return elevB - elevA; // Higher mountain wins
  }
  if ((a.category === 'trench' || a.category === 'sounding') && (b.category === 'trench' || b.category === 'sounding')) {
    const elevA = a.elevationMeters ?? 0;
    const elevB = b.elevationMeters ?? 0;
    if (elevA !== elevB) return elevA - elevB; // Deeper sounding (-10994m < -5000m) wins
  }

  // 5. Deterministic tie-breaker
  const idA = a.id || a.text;
  const idB = b.id || b.text;
  return idA.localeCompare(idB);
}

// ----------------------------------------------------------------------------
// 4. 2D Spatial Hash Grid
// ----------------------------------------------------------------------------
/**
 * High-performance 2D spatial hash grid for screen-space AABB collision querying.
 * Reuses internal cell bucket arrays across frames to ensure Zero-GC per frame.
 */
export class SpatialHash2D {
  private cellSize: number;
  private cols: number = 0;
  private rows: number = 0;
  private viewportWidth: number = 0;
  private viewportHeight: number = 0;
  private cells: number[][] = [];
  private poolCapacity: number = 0;

  constructor(cellSize: number = DEFAULT_SPATIAL_HASH_CELL_SIZE) {
    this.cellSize = Math.max(16, cellSize);
  }

  /**
   * Resizes or reconfigures the spatial hash dimensions for a viewport.
   */
  public resize(viewportWidth: number, viewportHeight: number): void {
    if (this.viewportWidth === viewportWidth && this.viewportHeight === viewportHeight) {
      return;
    }
    this.viewportWidth = Math.max(1, viewportWidth);
    this.viewportHeight = Math.max(1, viewportHeight);
    this.cols = Math.ceil(this.viewportWidth / this.cellSize);
    this.rows = Math.ceil(this.viewportHeight / this.cellSize);
    const totalCells = this.cols * this.rows;

    if (totalCells > this.poolCapacity) {
      for (let i = this.poolCapacity; i < totalCells; i++) {
        this.cells.push([]);
      }
      this.poolCapacity = totalCells;
    }
  }

  /**
   * Clears all cell contents without allocating new arrays.
   */
  public clear(): void {
    const totalCells = this.cells.length;
    for (let i = 0; i < totalCells; i++) {
      this.cells[i].length = 0;
    }
  }

  /**
   * Inserts a placed bounding box index into the spatial hash cells it spans.
   */
  public insert(boxIndex: number, box: LabelBoundingBox): void {
    if (this.cols <= 0 || this.rows <= 0) return;
    if (!Number.isFinite(box.minX) || !Number.isFinite(box.minY) || !Number.isFinite(box.maxX) || !Number.isFinite(box.maxY)) return;
    if (box.maxX < 0 || box.minX >= this.viewportWidth || box.maxY < 0 || box.minY >= this.viewportHeight) return;

    const c0 = Math.max(0, Math.min(this.cols - 1, Math.floor(box.minX / this.cellSize)));
    const c1 = Math.max(0, Math.min(this.cols - 1, Math.floor(box.maxX / this.cellSize)));
    const r0 = Math.max(0, Math.min(this.rows - 1, Math.floor(box.minY / this.cellSize)));
    const r1 = Math.max(0, Math.min(this.rows - 1, Math.floor(box.maxY / this.cellSize)));

    for (let r = r0; r <= r1; r++) {
      const rowOffset = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        this.cells[rowOffset + c].push(boxIndex);
      }
    }
  }

  /**
   * Checks whether a candidate bounding box intersects any previously placed box.
   */
  public collides(box: LabelBoundingBox, placedBoxes: LabelBoundingBox[]): boolean {
    if (this.cols <= 0 || this.rows <= 0) return false;
    if (!Number.isFinite(box.minX) || !Number.isFinite(box.minY) || !Number.isFinite(box.maxX) || !Number.isFinite(box.maxY)) return false;
    if (box.maxX < 0 || box.minX >= this.viewportWidth || box.maxY < 0 || box.minY >= this.viewportHeight) return false;

    const c0 = Math.max(0, Math.min(this.cols - 1, Math.floor(box.minX / this.cellSize)));
    const c1 = Math.max(0, Math.min(this.cols - 1, Math.floor(box.maxX / this.cellSize)));
    const r0 = Math.max(0, Math.min(this.rows - 1, Math.floor(box.minY / this.cellSize)));
    const r1 = Math.max(0, Math.min(this.rows - 1, Math.floor(box.maxY / this.cellSize)));

    for (let r = r0; r <= r1; r++) {
      const rowOffset = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        const cell = this.cells[rowOffset + c];
        for (let i = 0; i < cell.length; i++) {
          const otherIdx = cell[i];
          const other = placedBoxes[otherIdx];

          // AABB Intersection Test
          if (
            box.minX < other.maxX &&
            box.maxX > other.minX &&
            box.minY < other.maxY &&
            box.maxY > other.minY
          ) {
            return true; // Overlap detected
          }
        }
      }
    }

    return false;
  }
}

// ----------------------------------------------------------------------------
// 5. Neatline Moat & HUD Clearance Checks
// ----------------------------------------------------------------------------
/**
 * Evaluates whether a candidate bounding box violates the sheet neatline boundary
 * or neatline spatial breathing moat.
 */
export function violatesNeatlineMoat(
  box: LabelBoundingBox,
  viewportWidth: number,
  viewportHeight: number,
  neatlineInset: number = DEFAULT_NEATLINE_INSET_PX,
  neatlineMoat: number = DEFAULT_NEATLINE_MOAT_PX
): boolean {
  const margin = neatlineInset + neatlineMoat;
  return (
    box.minX < margin ||
    box.maxX > viewportWidth - margin ||
    box.minY < margin ||
    box.maxY > viewportHeight - margin
  );
}

/**
 * Evaluates whether a candidate bounding box intersects any floating HUD instrument
 * including the mandatory 10px breathing moat.
 */
export function collidesWithHUDObstacles(
  box: LabelBoundingBox,
  obstacles: ScreenRect[] = [],
  hudMoat: number = DEFAULT_HUD_MOAT_PX
): boolean {
  for (let i = 0; i < obstacles.length; i++) {
    const obs = obstacles[i];
    const obsMinX = obs.x - hudMoat;
    const obsMinY = obs.y - hudMoat;
    const obsMaxX = obs.x + obs.width + hudMoat;
    const obsMaxY = obs.y + obs.height + hudMoat;

    if (
      box.minX < obsMaxX &&
      box.maxX > obsMinX &&
      box.minY < obsMaxY &&
      box.maxY > obsMinY
    ) {
      return true; // Collides with HUD moat
    }
  }
  return false;
}

/**
 * Returns canonical default HUD obstacle zones for standard desktop viewport layouts.
 */
export function getDefaultHUDObstacles(viewportWidth: number, viewportHeight: number): ScreenRect[] {
  return [
    // Top Technical Calibration Bar
    {
      x: 10,
      y: 10,
      width: Math.max(720, viewportWidth - 390),
      height: 52,
    },
    // Left Navigation & Layer Dock
    {
      x: 10,
      y: 10,
      width: 240,
      height: 52,
    },
    // Right Instrument Sidebar Drawer
    {
      x: Math.max(10, viewportWidth - 365),
      y: 10,
      width: 355,
      height: Math.max(100, viewportHeight - 20),
    },
    // Bottom Kinematic Scrubber & Navigation Dock
    {
      x: 10,
      y: Math.max(10, viewportHeight - 92),
      width: Math.max(380, viewportWidth - 390),
      height: 82,
    },
  ];
}

// ----------------------------------------------------------------------------
// 6. Master Collision Avoidance & Zoom Gating Resolver
// ----------------------------------------------------------------------------
/**
 * Stateful zero-GC collision avoidance manager for continuous interactive frame rendering.
 */
export class ToponymCollisionResolver {
  private spatialHash: SpatialHash2D;
  private placedBoxes: LabelBoundingBox[] = [];
  private placedLabels: ToponymLabel[] = [];
  private lastCandidateSource: ToponymLabel[] | null = null;
  private cachedSortedCandidates: ToponymLabel[] = [];

  constructor(cellSize: number = DEFAULT_SPATIAL_HASH_CELL_SIZE) {
    this.spatialHash = new SpatialHash2D(cellSize);
  }

  /**
   * Resolves screen-space collisions and zoom gating for a set of candidate labels.
   */
  public resolve(
    labels: ToponymLabel[],
    options: CollisionAvoidanceOptions,
    projectionCtx?: CameraProjectionContext
  ): CollisionAvoidanceResult {
    const {
      viewportWidth,
      viewportHeight,
      camDist,
      paddingX = DEFAULT_LABEL_PADDING_X_PX,
      paddingY = DEFAULT_LABEL_PADDING_Y_PX,
      neatlineInset = DEFAULT_NEATLINE_INSET_PX,
      neatlineMoat = DEFAULT_NEATLINE_MOAT_PX,
      hudObstacles = [],
      hudMoat = DEFAULT_HUD_MOAT_PX,
      enableZoomGating = true,
      maxLabels = DEFAULT_MAX_PLACED_LABELS,
    } = options;

    this.spatialHash.resize(viewportWidth, viewportHeight);
    this.spatialHash.clear();
    this.placedBoxes.length = 0;
    this.placedLabels.length = 0;

    let culledByZoomCount = 0;
    let culledByCollisionCount = 0;
    let culledByHUDCount = 0;
    let culledByNeatlineCount = 0;
    let culledByLimbCount = 0;

    // 1. Zoom gating pre-filter & priority sorting (cached across frames)
    let sortedCandidates: ToponymLabel[];
    if (this.lastCandidateSource === labels && this.cachedSortedCandidates.length === labels.length) {
      sortedCandidates = this.cachedSortedCandidates;
    } else {
      sortedCandidates = [...labels].sort(compareToponymPriority);
      this.cachedSortedCandidates = sortedCandidates;
      this.lastCandidateSource = labels;
    }

    for (let i = 0; i < sortedCandidates.length; i++) {
      if (this.placedLabels.length >= maxLabels) break;

      const label = sortedCandidates[i];

      // A. Zoom Gating Check
      if (enableZoomGating && camDist !== undefined && Number.isFinite(camDist)) {
        const minCam = resolveMinCamDist(label);
        if (minCam > 0.0 && camDist > minCam) {
          culledByZoomCount++;
          continue;
        }
      }

      // B. Screen-Space Projection
      let screenX: number;
      let screenY: number;
      let projResult: any = null;

      if (projectionCtx) {
        const proj = projectGeodeticToScreen(label.lon, label.lat, projectionCtx, label.elevationMeters ?? 0);
        if (!proj.visible) {
          if (proj.cullReason === 'limb') culledByLimbCount++;
          continue;
        }
        screenX = proj.screenX;
        screenY = proj.screenY;
        projResult = proj;
      } else if ((label as any).screenX !== undefined && (label as any).screenY !== undefined) {
        screenX = (label as any).screenX;
        screenY = (label as any).screenY;
      } else {
        // Fallback default normalized projection if no camera context provided
        screenX = ((label.lon + 180.0) / 360.0) * viewportWidth;
        screenY = ((90.0 - label.lat) / 180.0) * viewportHeight;
      }

      // C. Bounding Box Construction
      let box = createLabelBoundingBox(label, screenX, screenY, paddingX, paddingY);

      if (projectionCtx && projResult) {
        const effCamDist = camDist ?? projResult.camDist ?? 10.0;
        const tBoost = Math.max(0.0, Math.min(1.0, (effCamDist - 5.10) / (10.50 - 5.10)));
        const smoothBoost = tBoost * tBoost * (3.0 - 2.0 * tBoost);
        const closeZoomBoost = 1.65 + (1.08 - 1.65) * smoothBoost;
        const rawAdvance = Math.max(1.0, box.width - 2.0 * paddingX);
        const rawHeight = Math.max(1.0, box.height - 2.0 * paddingY);
        const boostedAdvance = rawAdvance * closeZoomBoost;
        const boostedHeight = rawHeight * closeZoomBoost * 1.15;
        const effPadX = Math.max(paddingX, 12.0);
        const effPadY = Math.max(paddingY, 8.0);

        // Check if the right end of the label overhangs the spherical horizon limb
        const unfurlVal = Math.max(0.0, Math.min(1.0, projectionCtx.unfurl ?? options.unfurl ?? 0.0));
        const sphereFactor = 1.0 - Math.min(1.0, Math.max(0.0, unfurlVal / 0.35));
        if (sphereFactor > 0.5 && projResult.clipW !== undefined && projResult.projScaleX !== undefined) {
          const endNdcDx = (boostedAdvance * 2.0) / Math.max(1.0, viewportWidth);
          const endViewDx = (endNdcDx * projResult.clipW) / projResult.projScaleX;
          const rad = projectionCtx.radius || CANONICAL_RADIUS;
          const endDiscX = (projResult.vnX ?? 0.0) + endViewDx / rad;
          const endDiscY = projResult.vnY ?? 0.0;
          if (endDiscX * endDiscX + endDiscY * endDiscY >= 0.88) {
            culledByLimbCount++;
            continue;
          }
        }

        box = {
          ...box,
          minX: screenX - effPadX,
          maxX: screenX + boostedAdvance + effPadX,
          minY: screenY - boostedHeight * 0.78 - effPadY,
          maxY: screenY + boostedHeight * 0.22 + effPadY,
          width: boostedAdvance + 2.0 * effPadX,
          height: boostedHeight + 2.0 * effPadY,
        };
      }

      // D. Neatline Boundary & Moat Clearance
      if (violatesNeatlineMoat(box, viewportWidth, viewportHeight, neatlineInset, neatlineMoat)) {
        culledByNeatlineCount++;
        continue;
      }

      // E. Floating HUD Obstacle Clearance
      if (collidesWithHUDObstacles(box, hudObstacles, hudMoat)) {
        culledByHUDCount++;
        continue;
      }

      // F. 2D Spatial Hash Collision Check (Zero Label Overlap Invariant)
      if (this.spatialHash.collides(box, this.placedBoxes)) {
        culledByCollisionCount++;
        continue;
      }

      // G. Candidate Placed!
      const boxIndex = this.placedBoxes.length;
      this.placedBoxes.push(box);
      this.placedLabels.push(label);
      this.spatialHash.insert(boxIndex, box);
    }

    const culledCount =
      culledByZoomCount +
      culledByCollisionCount +
      culledByHUDCount +
      culledByNeatlineCount +
      culledByLimbCount;

    return {
      placedLabels: [...this.placedLabels],
      placedBoxes: [...this.placedBoxes],
      culledCount,
      culledByZoomCount,
      culledByCollisionCount,
      culledByHUDCount,
      culledByNeatlineCount,
      culledByLimbCount,
      totalCount: labels.length,
    };
  }
}

/**
 * Functional stateless entrypoint for screen-space spatial collision avoidance (M13-P3-T3).
 */
export function resolveToponymCollisions(
  labels: ToponymLabel[],
  options: CollisionAvoidanceOptions,
  projectionCtx?: CameraProjectionContext
): CollisionAvoidanceResult {
  const resolver = new ToponymCollisionResolver(options.cellSize);
  return resolver.resolve(labels, options, projectionCtx);
}

// ----------------------------------------------------------------------------
// 7. Verification Utilities (Invariant Certification)
// ----------------------------------------------------------------------------
/**
 * Rigorously verifies the Zero Label Overlap Invariant across all placed bounding boxes.
 */
export function verifyZeroLabelOverlap(boxes: LabelBoundingBox[]): {
  overlapFree: boolean;
  violations: Array<{ a: string; b: string }>;
} {
  const violations: Array<{ a: string; b: string }> = [];

  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];

      // Strict AABB overlap test
      if (
        a.minX < b.maxX &&
        a.maxX > b.minX &&
        a.minY < b.maxY &&
        a.maxY > b.minY
      ) {
        violations.push({ a: a.labelId, b: b.labelId });
      }
    }
  }

  return {
    overlapFree: violations.length === 0,
    violations,
  };
}

/**
 * Verifies that all placed bounding boxes maintain the mandatory neatline breathing moat.
 */
export function verifyNeatlineClearance(
  boxes: LabelBoundingBox[],
  viewportWidth: number,
  viewportHeight: number,
  neatlineMargin: number = DEFAULT_NEATLINE_INSET_PX + DEFAULT_NEATLINE_MOAT_PX
): { compliant: boolean; violations: string[] } {
  const violations: string[] = [];

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (
      box.minX < neatlineMargin ||
      box.maxX > viewportWidth - neatlineMargin ||
      box.minY < neatlineMargin ||
      box.maxY > viewportHeight - neatlineMargin
    ) {
      violations.push(box.labelId);
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}

/**
 * Verifies that all placed bounding boxes maintain the mandatory 10px HUD moat clearance.
 */
export function verifyHUDClearance(
  boxes: LabelBoundingBox[],
  obstacles: ScreenRect[] = [],
  hudMoat: number = DEFAULT_HUD_MOAT_PX
): { compliant: boolean; violations: string[] } {
  const violations: string[] = [];

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (collidesWithHUDObstacles(box, obstacles, hudMoat)) {
      violations.push(box.labelId);
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}
