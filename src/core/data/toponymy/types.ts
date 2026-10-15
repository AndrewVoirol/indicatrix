// ============================================================================
// File: src/core/data/toponymy/types.ts
// Architecture: GPU Signed Distance Field (SDF) Typography & Cartographic Inscriptions
// Description: Type definitions for glyph metrics, SDF atlases, and toponymic labels
// ============================================================================

/**
 * Typographic metric for an individual glyph within the SDF font atlas.
 * Dimensions and bearings are normalized relative to 1.0 em.
 */
export interface GlyphMetric {
  char: string;
  code: number;
  /** Global slot index in the 16x16 (256) atlas grid */
  slotIndex?: number;
  /** UV bounds within the 1024x1024 texture atlas [0.0, 1.0] */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Glyph quad width in em units */
  widthEm: number;
  /** Glyph quad height in em units */
  heightEm: number;
  /** Horizontal bearing from cursor origin to glyph left edge (em) */
  bearingXEm: number;
  /** Vertical bearing from baseline to glyph top edge (em) */
  bearingYEm: number;
  /** Horizontal cursor advance to next glyph (em) */
  advanceEm: number;
  /** Shorthand alias for advanceEm */
  advance?: number;
  /** Font classification: 0 = Archival Serif (Caslon/IM Fell), 1 = Technical DIN / Blueprint */
  fontStyle: number;
}

/**
 * Metadata descriptor for the complete pre-baked dual-style SDF font atlas.
 */
export interface FontAtlasMetadata {
  textureWidth?: number;
  textureHeight?: number;
  atlasWidth: number;
  atlasHeight: number;
  cellSize: number;
  spreadPx: number;
  cols: number;
  rows: number;
  fontSerifName: string;
  fontTechnicalName: string;
  metrics: Map<string, GlyphMetric>;
  glyphs: GlyphMetric[];
}

/**
 * Orientation modes for toponymic manifold labels.
 */
export type LabelOrientationMode =
  | 'billboard'       // 0.0: Screen-aligned billboard anchored to manifold crust
  | 'surface-tangent' // 1.0: Conforms to surface tangent frame (T_lon, T_lat, Normal)
  | 'geodesic-curve'  // 2.0: Per-glyph manifold evaluation curving across globe/unfurl
  | 0
  | 1
  | 2;

/**
 * Cartographic category classification for toponymic labels (M13-P3-T2).
 */
export type ToponymCategory =
  | 'summit'      // Mountain peaks, volcanic cones, massifs
  | 'trench'      // Oceanic trenches, deeps, chasms
  | 'strait'      // Maritime straits, channels, sounds, passages
  | 'cape'        // Promontories, headlands, capes, points
  | 'shield'      // Continental cratons, crystalline shields, plateaus
  | 'range'       // Mountain ranges, cordilleras
  | 'water'       // Oceans, marginal seas, gulfs
  | 'geodetic'    // Survey stations, benchmarks, observatories
  | 'sounding'    // Archival hydrographic bathymetric soundings
  | 'celestial'   // Equator, tropics, prime meridian, polar circles
  | 'continent'   // Continental landmasses (Africa, Eurasia, etc.)
  | 'state';      // Sovereign states, historical realms, territories

/**
 * Hierarchical zoom tier classification (ZOOM_DETAIL_SPEC_LEDGER §5.2).
 * - 'orbital': Macro planetary scale (camDist > 12.0)
 * - 'regional': Continental & sub-continental scale (6.8 <= camDist <= 14.0)
 * - 'local': High-detail inspection scale (camDist <= 8.5)
 */
export type ToponymTier = 'orbital' | 'regional' | 'local' | 1 | 2 | 3;

/**
 * Public descriptor for a toponymic inscription or spot elevation marker.
 */
export interface ToponymLabel {
  id?: string;
  text: string;
  lon: number;
  lat: number;
  elevationMeters?: number;
  /** Cartographic category classification */
  category?: ToponymCategory;
  /** Hierarchical zoom tier */
  tier?: ToponymTier;
  /** Nominal font size in CSS points/pixels (default: 11.0) */
  fontSize?: number;
  /** Font style override: 0 = Archival Serif, 1 = Technical DIN, undefined = auto from theme */
  fontStyle?: number;
  /** Orientation mode (default: 'billboard') */
  orientation?: LabelOrientationMode;
  /** Zoom gating: maximum camera distance at which label remains visible (0.0 = always) */
  minCamDist?: number;
  /** Inking color preset: 0 = Theme ink (sepia/cyanotype/ivory), 1 = Accent, 2 = Custom */
  colorPreset?: number;
  /** Opacity multiplier [0.0, 1.0] (default: 1.0) */
  alpha?: number;
  /** Priority tier for spatial collision gating (Track D / M13-P3-T3): 1 = highest */
  priority?: number;
}

/**
 * Raw GPU instance layout for an individual glyph quad (80 bytes = 20 float32s).
 * Conforms to `sdf_text.wgsl` VertexInput specification:
 * - pos_anchor3d:   [x, y, z, fontSize]
 * - pos_target2d:   [mercX, mercY, orientationMode, elevStandoff]
 * - glyph_rect:     [offsetX, offsetY, width, height]
 * - glyph_uv:       [u0, v0, u1, v1]
 * - glyph_style:    [fontStyle, colorPreset, minCamDist, alpha]
 */
export interface GlyphInstanceFloats {
  anchor3dX: number;
  anchor3dY: number;
  anchor3dZ: number;
  fontSize: number;
  target2dX: number;
  target2dY: number;
  orientationMode: number;
  elevStandoff: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  fontStyle: number;
  colorPreset: number;
  minCamDist: number;
  alpha: number;
}

/**
 * 2D Screen-space axis-aligned rectangle (CSS pixels).
 */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Screen-space bounding box for an individual toponym label including margins and spatial metadata.
 */
export interface LabelBoundingBox {
  label: ToponymLabel;
  labelId: string;
  text: string;
  /** Anchor coordinate in screen CSS pixels */
  screenX: number;
  screenY: number;
  /** Bounding box extents in screen CSS pixels including padding */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  /** Priority rating (1 = highest) */
  priority: number;
  /** Hierarchical zoom tier */
  tier: 'orbital' | 'regional' | 'local';
  /** Feature elevation in meters if applicable */
  elevationMeters?: number;
  /** Feature category */
  category?: ToponymCategory;
}

/**
 * Configuration options for the screen-space spatial collision avoidance pipeline (M13-P3-T3).
 */
export interface CollisionAvoidanceOptions {
  viewportWidth: number;
  viewportHeight: number;
  /** Camera distance from planet origin for hierarchical zoom gating */
  camDist?: number;
  /** Horizontal breathing room between adjacent labels in screen pixels (default: 8.0) */
  paddingX?: number;
  /** Vertical breathing room between adjacent labels in screen pixels (default: 4.0) */
  paddingY?: number;
  /** Sheet neatline inset from viewport edge in CSS pixels */
  neatlineInset?: number;
  /** Breathing room moat inside neatline boundary in CSS pixels */
  neatlineMoat?: number;
  /** Floating HUD instrument obstacle rectangles to avoid */
  hudObstacles?: ScreenRect[];
  /** Spatial clearance moat around HUD instruments in CSS pixels */
  hudMoat?: number;
  /** Spatial hash grid cell dimension in pixels (default: 64) */
  cellSize?: number;
  /** Whether zoom gating by camera distance is enforced (default: true) */
  enableZoomGating?: boolean;
  /** Maximum number of labels to place on screen (default: 512) */
  maxLabels?: number;
  /** Manifold unfurl factor [0.0 = sphere, 1.0 = flat sheet] */
  unfurl?: number;
  /** Projection mode (0 = Mode 0, etc.) */
  mode?: number;
}

/**
 * Detailed verification statistics and placed label collection from collision avoidance.
 */
export interface CollisionAvoidanceResult {
  placedLabels: ToponymLabel[];
  placedBoxes: LabelBoundingBox[];
  culledCount: number;
  culledByZoomCount: number;
  culledByCollisionCount: number;
  culledByHUDCount: number;
  culledByNeatlineCount: number;
  culledByLimbCount: number;
  totalCount: number;
}

/**
 * Camera projection matrices and viewport configuration for geodetic-to-screen projection.
 */
export interface CameraProjectionContext {
  /** 4x4 View matrix (column-major) */
  viewMatrix: Float32Array | number[];
  /** 4x4 Projection matrix (column-major) */
  projectionMatrix: Float32Array | number[];
  /** Optional pre-computed 4x4 View-Projection matrix (column-major) */
  viewProjectionMatrix?: Float32Array | number[];
  /** Camera position in world space [x, y, z] */
  cameraPosition: [number, number, number] | { x: number; y: number; z: number };
  /** Viewport dimensions in CSS pixels */
  viewportWidth: number;
  viewportHeight: number;
  /** Near clipping distance (default: 0.1) */
  nearPlane?: number;
  /** Manifold unfurl transition [0.0 = sphere, 1.0 = flat sheet] */
  unfurl?: number;
  /** Projection mode */
  mode?: number;
  /** Sphere radius (default: 5.0) */
  radius?: number;
  /** Optional DEM normal displacement scale matching crust_hydrosphere.wgsl */
  displacementScale?: number;
  /** Optional peak shaping exponent matching crust_hydrosphere.wgsl */
  peakExponent?: number;
}

