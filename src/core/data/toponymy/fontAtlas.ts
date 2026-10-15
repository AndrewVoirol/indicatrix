// ============================================================================
// File: src/core/data/toponymy/fontAtlas.ts
// Architecture: GPU Signed Distance Field (SDF) Font Atlas & Typographic Layout
// Description: Dual-style 1024x1024 monochrome SDF font atlas generator and
//              perspective-correct glyph quad layout for manifold inscriptions.
// ============================================================================

import { GlyphMetric, FontAtlasMetadata, ToponymLabel, LabelOrientationMode } from './types';

export const ATLAS_WIDTH = 1024;
export const ATLAS_HEIGHT = 1024;
export const CELL_SIZE = 64;
export const SPREAD_PX = 8;
export const ATLAS_COLS = 16;
export const ATLAS_ROWS = 16;
export const GRID_COLS = ATLAS_COLS;
export const GRID_ROWS = ATLAS_ROWS;
export const TOTAL_SLOTS = ATLAS_COLS * ATLAS_ROWS; // 256 cells

export const FONT_STYLE_SERIF = 0;       // Archival Serif (Caslon / IM Fell English)
export const FONT_STYLE_TECHNICAL = 1;   // Technical DIN / Blueprint Consolas

// Special cartographic unicode characters mapped to dedicated slots
// (Slots 1..8 in Serif, 129..136 in Technical, preventing collision with ASCII 120..127)
export const CARTOGRAPHIC_CHAR_MAP: Record<string, number> = {
  '▲': 1, // Summit marker
  '▼': 2, // Sounding / Trench marker
  '°': 3, // Degree symbol
  '′': 4, // Minute / prime
  '″': 5, // Second / double prime
  '·': 6, // Middle dot
  '—': 7, // Em-dash
  '–': 8, // En-dash
};

/**
 * Computes the 1D squared Euclidean distance transform using the
 * Felzenszwalb-Huttenlocher parabolic lower envelope algorithm in O(N) time.
 */
export function edt1D(f: Float32Array, n: number): Float32Array {
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) {
      k++;
    }
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
  return d;
}

/**
 * Computes the 2D squared Euclidean distance transform by applying 1D EDT
 * along columns, then rows. Runs in O(W * H) linear time.
 */
export function edt2D(grid: Float32Array, width: number, height: number): Float32Array {
  const maxDim = Math.max(width, height);
  const temp = new Float32Array(maxDim);
  const dCols = new Float32Array(width * height);
  const dFinal = new Float32Array(width * height);

  // Column pass
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      temp[y] = grid[y * width + x];
    }
    const colD = edt1D(temp, height);
    for (let y = 0; y < height; y++) {
      dCols[y * width + x] = colD[y];
    }
  }

  // Row pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      temp[x] = dCols[y * width + x];
    }
    const rowD = edt1D(temp, width);
    for (let x = 0; x < width; x++) {
      dFinal[y * width + x] = rowD[x];
    }
  }

  return dFinal;
}

/**
 * Transforms a binary foreground mask into an 8-bit Signed Distance Field (SDF).
 * - Outside boundary:  < 128 (normalized distance < 0.5)
 * - Exact boundary:    = 128 (normalized distance = 0.5)
 * - Inside foreground: > 128 (normalized distance > 0.5)
 */
export function computeBinarySDF(
  mask: Uint8Array,
  width: number,
  height: number,
  spreadPx = SPREAD_PX
): Uint8Array {
  const total = width * height;
  const inside = new Float32Array(total);
  const outside = new Float32Array(total);
  const INF = 1e6;

  for (let i = 0; i < total; i++) {
    const isFg = mask[i] > 0;
    inside[i] = isFg ? 0 : INF;
    outside[i] = isFg ? INF : 0;
  }

  const dIn = edt2D(inside, width, height);
  const dOut = edt2D(outside, width, height);
  const sdf = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    const distToInterior = Math.sqrt(dIn[i]); // 0 inside, >0 outside
    const distToExterior = Math.sqrt(dOut[i]); // >0 inside, 0 outside
    const signedDist = distToExterior - distToInterior;
    // Map [-spread, +spread] to [0.0, 1.0] centered at 0.5
    const norm = Math.max(0.0, Math.min(1.0, 0.5 + signedDist / (2.0 * spreadPx)));
    sdf[i] = Math.round(norm * 255);
  }

  return sdf;
}

/**
 * Builds the canonical glyph metric lookup table for the dual-font atlas.
 */
export function createDefaultGlyphMetrics(): Map<string, GlyphMetric> {
  const map = new Map<string, GlyphMetric>();

  // Slot assignment helper:
  // Font 0 (Serif): Slots 0..127 (Rows 0..7)
  // Font 1 (Technical): Slots 128..255 (Rows 8..15)
  function registerChar(
    char: string,
    slotInFont: number,
    fontStyle: number,
    widthEm: number,
    advanceEm: number,
    bearingXEm = 0.05,
    bearingYEm = 0.80,
    heightEm = 0.90
  ) {
    const baseSlot = fontStyle === FONT_STYLE_SERIF ? 0 : 128;
    const globalSlot = baseSlot + slotInFont;
    const col = globalSlot % ATLAS_COLS;
    const row = Math.floor(globalSlot / ATLAS_COLS);

    const u0 = col / ATLAS_COLS;
    const v0 = row / ATLAS_ROWS;
    const u1 = (col + 1) / ATLAS_COLS;
    const v1 = (row + 1) / ATLAS_ROWS;

    const metric: GlyphMetric = {
      char,
      code: char.charCodeAt(0),
      slotIndex: globalSlot,
      u0,
      v0,
      u1,
      v1,
      widthEm,
      heightEm,
      bearingXEm,
      bearingYEm,
      advanceEm,
      advance: advanceEm,
      fontStyle,
    };

    // Key format: `${char}:${fontStyle}`
    map.set(`${char}:${fontStyle}`, metric);
    if (fontStyle === FONT_STYLE_SERIF && !map.has(char)) {
      map.set(char, metric); // Default lookup without explicit font index
    }
  }

  // Register characters for both Serif (0) and Technical Sans/DIN (1)
  for (const style of [FONT_STYLE_SERIF, FONT_STYLE_TECHNICAL]) {
    // Printable ASCII 32..126
    for (let code = 32; code <= 126; code++) {
      const char = String.fromCharCode(code);
      let advance = style === FONT_STYLE_TECHNICAL ? 0.56 : 0.54;
      let width = advance;

      if (char === ' ') {
        advance = 0.35;
        width = 0.01;
      } else if ('ilI.,:\';!|'.includes(char)) {
        advance = style === FONT_STYLE_TECHNICAL ? 0.36 : 0.30;
        width = advance;
      } else if ('1jft()[]'.includes(char)) {
        advance = style === FONT_STYLE_TECHNICAL ? 0.46 : 0.38;
        width = advance;
      } else if ('rsvxyzceao'.includes(char)) {
        advance = style === FONT_STYLE_TECHNICAL ? 0.52 : 0.48;
        width = advance;
      } else if ('mw'.includes(char)) {
        advance = style === FONT_STYLE_TECHNICAL ? 0.72 : 0.74;
        width = advance;
      } else if ('MW@'.includes(char)) {
        advance = style === FONT_STYLE_TECHNICAL ? 0.78 : 0.82;
        width = advance;
      } else if (char >= 'A' && char <= 'Z') {
        advance = style === FONT_STYLE_TECHNICAL ? 0.62 : 0.64;
        width = advance;
      }

      registerChar(char, code, style, width, advance);
    }

    // Cartographic special characters
    for (const [sym, slot] of Object.entries(CARTOGRAPHIC_CHAR_MAP)) {
      let advance = 0.70;
      let width = 0.65;
      let bearingY = 0.75;
      if (sym === '▲' || sym === '▼') {
        advance = 0.75;
        width = 0.70;
        bearingY = 0.72;
      } else if (sym === '°') {
        advance = 0.40;
        width = 0.35;
        bearingY = 0.85;
      } else if (sym === '·') {
        advance = 0.35;
        width = 0.25;
        bearingY = 0.50;
      } else if (sym === '—' || sym === '–') {
        advance = 0.80;
        width = 0.80;
        bearingY = 0.45;
      }
      registerChar(sym, slot, style, width, advance, 0.05, bearingY, 0.75);
    }
  }

  return map;
}

/**
 * Generates procedural SDF raster masks for cartographic glyphs and characters.
 * Ensures the engine has guaranteed high-precision SDF textures even in headless
 * environments without Canvas or DOM APIs.
 */
/**
 * Complete 5x7 bitmap glyph table (each row is a 5-bit integer from MSB bit 4 to LSB bit 0)
 * providing deterministic, genuine letterforms in headless Node environments without DOM/Canvas,
 * while browser environments use high-resolution 2D Canvas font rasterization.
 */
const ASCII_5X7_BITMAPS: Record<string, readonly [number, number, number, number, number, number, number]> = {
  'A': [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  'B': [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  'C': [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  'D': [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  'E': [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  'F': [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  'G': [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  'H': [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  'I': [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  'J': [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
  'K': [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  'L': [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  'M': [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  'N': [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  'O': [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  'P': [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  'Q': [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  'R': [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  'S': [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  'T': [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  'U': [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  'V': [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  'W': [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  'X': [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  'Y': [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  'Z': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  'a': [0b00000, 0b00000, 0b01110, 0b00001, 0b01111, 0b10001, 0b01111],
  'b': [0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
  'c': [0b00000, 0b00000, 0b01110, 0b10001, 0b10000, 0b10001, 0b01110],
  'd': [0b00001, 0b00001, 0b01111, 0b10001, 0b10001, 0b10001, 0b01111],
  'e': [0b00000, 0b00000, 0b01110, 0b10001, 0b11111, 0b10000, 0b01110],
  'f': [0b00110, 0b01001, 0b01000, 0b11100, 0b01000, 0b01000, 0b01000],
  'g': [0b00000, 0b01111, 0b10001, 0b10001, 0b01111, 0b00001, 0b01110],
  'h': [0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b10001],
  'i': [0b00100, 0b00000, 0b01100, 0b00100, 0b00100, 0b00100, 0b01110],
  'j': [0b00010, 0b00000, 0b00110, 0b00010, 0b00010, 0b10010, 0b01100],
  'k': [0b10000, 0b10000, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010],
  'l': [0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  'm': [0b00000, 0b00000, 0b11010, 0b10101, 0b10101, 0b10001, 0b10001],
  'n': [0b00000, 0b00000, 0b11110, 0b10001, 0b10001, 0b10001, 0b10001],
  'o': [0b00000, 0b00000, 0b01110, 0b10001, 0b10001, 0b10001, 0b01110],
  'p': [0b00000, 0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000],
  'q': [0b00000, 0b01111, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001],
  'r': [0b00000, 0b00000, 0b10110, 0b11001, 0b10000, 0b10000, 0b10000],
  's': [0b00000, 0b00000, 0b01111, 0b10000, 0b01110, 0b00001, 0b11110],
  't': [0b01000, 0b01000, 0b11100, 0b01000, 0b01000, 0b01001, 0b00110],
  'u': [0b00000, 0b00000, 0b10001, 0b10001, 0b10001, 0b10011, 0b01101],
  'v': [0b00000, 0b00000, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  'w': [0b00000, 0b00000, 0b10001, 0b10001, 0b10101, 0b10101, 0b01010],
  'x': [0b00000, 0b00000, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001],
  'y': [0b00000, 0b10001, 0b10001, 0b10001, 0b01111, 0b00001, 0b01110],
  'z': [0b00000, 0b00000, 0b11111, 0b00010, 0b00100, 0b01000, 0b11111],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  '.': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
  ',': [0b00000, 0b00000, 0b00000, 0b00000, 0b00110, 0b00100, 0b01000],
  ':': [0b00000, 0b00110, 0b00110, 0b00000, 0b00110, 0b00110, 0b00000],
  ';': [0b00000, 0b00110, 0b00110, 0b00000, 0b00110, 0b00100, 0b01000],
  '/': [0b00001, 0b00010, 0b00100, 0b00100, 0b01000, 0b10000, 0b00000],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
  '?': [0b01110, 0b10001, 0b00010, 0b00100, 0b00100, 0b00000, 0b00100],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100],
  '\'': [0b00100, 0b00100, 0b01000, 0b00000, 0b00000, 0b00000, 0b00000],
  '"': [0b01010, 0b01010, 0b10100, 0b00000, 0b00000, 0b00000, 0b00000],
};

function rasterizeGlyphMaskFromBitmap(char: string, style: number, cellMask: Uint8Array): void {
  const rows = ASCII_5X7_BITMAPS[char] || ASCII_5X7_BITMAPS[char.toUpperCase()] || ASCII_5X7_BITMAPS['?'];
  if (!rows) return;
  const padX = 14;
  const padY = 10;
  const availW = CELL_SIZE - 2 * padX; // 36
  const availH = CELL_SIZE - 2 * padY; // 44
  for (let y = 0; y < availH; y++) {
    const r = Math.min(6, Math.floor((y * 7) / availH));
    const rowBits = rows[r];
    for (let x = 0; x < availW; x++) {
      const c = Math.min(4, Math.floor((x * 5) / availW));
      const bit = (rowBits >> (4 - c)) & 1;
      if (bit) {
        cellMask[(padY + y) * CELL_SIZE + (padX + x)] = 255;
      }
    }
  }
  // Add subtle horizontal serif terminals on top/bottom rows for FONT_STYLE_SERIF
  if (style === FONT_STYLE_SERIF && /[A-Z]/.test(char)) {
    for (let x = padX - 2; x < padX + availW + 2; x++) {
      if (x >= 1 && x < CELL_SIZE - 1) {
        if (cellMask[padY * CELL_SIZE + x] > 0) {
          cellMask[padY * CELL_SIZE + (x - 1)] = 255;
          cellMask[padY * CELL_SIZE + (x + 1)] = 255;
        }
        const botY = padY + availH - 1;
        if (cellMask[botY * CELL_SIZE + x] > 0) {
          cellMask[botY * CELL_SIZE + (x - 1)] = 255;
          cellMask[botY * CELL_SIZE + (x + 1)] = 255;
        }
      }
    }
  }
}

export function generateProceduralSDFAtlas(): Uint8Array {
  const atlas = new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT);
  // Default background to 0 (outside)
  atlas.fill(0);

  const metrics = createDefaultGlyphMetrics();

  // Attempt high-resolution 2D Canvas font rasterization when running in browser/Chromium
  let canvasCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  try {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = CELL_SIZE;
      c.height = CELL_SIZE;
      canvasCtx = c.getContext('2d', { willReadFrequently: true });
    } else if (typeof OffscreenCanvas !== 'undefined') {
      const oc = new OffscreenCanvas(CELL_SIZE, CELL_SIZE);
      canvasCtx = oc.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
    }
  } catch {
    canvasCtx = null;
  }

  // Draw geometric masks for cartographic symbols and true letterforms for all glyphs
  for (const [key, metric] of metrics.entries()) {
    if (!key.includes(':')) continue;
    const [char, styleStr] = key.split(':');
    const style = parseInt(styleStr, 10);
    const col = Math.floor(metric.u0 * ATLAS_COLS);
    const row = Math.floor(metric.v0 * ATLAS_ROWS);
    const startX = col * CELL_SIZE;
    const startY = row * CELL_SIZE;

    const cellMask = new Uint8Array(CELL_SIZE * CELL_SIZE);
    const half = CELL_SIZE / 2;

    if (char === '▲') {
      // Equilateral summit triangle pointing upwards
      for (let y = 0; y < CELL_SIZE; y++) {
        for (let x = 0; x < CELL_SIZE; x++) {
          const ny = (CELL_SIZE - 1 - y) / CELL_SIZE; // 0 at bottom, 1 at top
          const nx = (x - half) / (CELL_SIZE * 0.45);
          if (ny >= 0.20 && ny <= 0.80 && Math.abs(nx) <= (0.80 - ny)) {
            cellMask[y * CELL_SIZE + x] = 255;
          }
        }
      }
    } else if (char === '▼') {
      // Inverted trench sounding triangle pointing downwards
      for (let y = 0; y < CELL_SIZE; y++) {
        for (let x = 0; x < CELL_SIZE; x++) {
          const ny = y / CELL_SIZE; // 0 at top, 1 at bottom
          const nx = (x - half) / (CELL_SIZE * 0.45);
          if (ny >= 0.20 && ny <= 0.80 && Math.abs(nx) <= (0.80 - ny)) {
            cellMask[y * CELL_SIZE + x] = 255;
          }
        }
      }
    } else if (char === '°') {
      // Hollow degree circle near top
      const cy = CELL_SIZE * 0.30;
      const cx = half;
      const rOuter = CELL_SIZE * 0.15;
      const rInner = CELL_SIZE * 0.075;
      for (let y = 0; y < CELL_SIZE; y++) {
        for (let x = 0; x < CELL_SIZE; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d <= rOuter && d >= rInner) {
            cellMask[y * CELL_SIZE + x] = 255;
          }
        }
      }
    } else if (char === '′' || char === '″') {
      // Prime / Double-Prime angular minute/second ticks near top
      const offsets = char === '″' ? [-6, 6] : [0];
      for (const ox of offsets) {
        for (let y = 10; y <= 26; y++) {
          const t = (y - 10) / 16.0;
          const cx = half + ox + (1.0 - t) * 3.0;
          for (let x = 0; x < CELL_SIZE; x++) {
            if (Math.abs(x - cx) <= 2.2) {
              cellMask[y * CELL_SIZE + x] = 255;
            }
          }
        }
      }
    } else if (char === '·') {
      // Geodetic center dot
      const cy = half;
      const cx = half;
      const r = CELL_SIZE * 0.08;
      for (let y = 0; y < CELL_SIZE; y++) {
        for (let x = 0; x < CELL_SIZE; x++) {
          if (Math.hypot(x - cx, y - cy) <= r) {
            cellMask[y * CELL_SIZE + x] = 255;
          }
        }
      }
    } else if (char === '—' || char === '–' || char === '-') {
      // Horizontal bar
      const barH = style === FONT_STYLE_SERIF ? CELL_SIZE * 0.07 : CELL_SIZE * 0.085;
      const barW = char === '—' ? CELL_SIZE * 0.80 : CELL_SIZE * 0.55;
      const cy = half;
      for (let y = 0; y < CELL_SIZE; y++) {
        for (let x = 0; x < CELL_SIZE; x++) {
          if (Math.abs(y - cy) <= barH * 0.5 && Math.abs(x - half) <= barW * 0.5) {
            cellMask[y * CELL_SIZE + x] = 255;
          }
        }
      }
    } else if (char !== ' ') {
      let rasterizedByCanvas = false;
      if (canvasCtx) {
        try {
          canvasCtx.clearRect(0, 0, CELL_SIZE, CELL_SIZE);
          canvasCtx.fillStyle = '#ffffff';
          canvasCtx.textAlign = 'center';
          canvasCtx.textBaseline = 'middle';
          canvasCtx.font =
            style === FONT_STYLE_SERIF
              ? 'bold 46px Georgia, "Times New Roman", Caslon, serif'
              : '700 44px "DIN Alternate", "Helvetica Neue", Arial, sans-serif';
          canvasCtx.fillText(char, half, half + 2);
          const imgData = canvasCtx.getImageData(0, 0, CELL_SIZE, CELL_SIZE).data;
          let activePx = 0;
          for (let p = 0; p < CELL_SIZE * CELL_SIZE; p++) {
            const a = imgData[p * 4 + 3];
            if (a >= 64) {
              cellMask[p] = 255;
              activePx++;
            }
          }
          if (activePx > 4) {
            rasterizedByCanvas = true;
          }
        } catch {
          rasterizedByCanvas = false;
        }
      }
      if (!rasterizedByCanvas) {
        rasterizeGlyphMaskFromBitmap(char, style, cellMask);
      }
    }

    // Compute Signed Distance Field for this cell
    const cellSDF = computeBinarySDF(cellMask, CELL_SIZE, CELL_SIZE, SPREAD_PX);

    // Blit cellSDF into the 1024x1024 master atlas
    for (let cy = 0; cy < CELL_SIZE; cy++) {
      const dstY = startY + cy;
      const srcRowOffset = cy * CELL_SIZE;
      const dstRowOffset = dstY * ATLAS_WIDTH + startX;
      for (let cx = 0; cx < CELL_SIZE; cx++) {
        atlas[dstRowOffset + cx] = cellSDF[srcRowOffset + cx];
      }
    }
  }

  return atlas;
}

/**
 * Pre-allocated singleton for font atlas metadata.
 */
let cachedMetadata: FontAtlasMetadata | null = null;

export function getFontAtlasMetadata(): FontAtlasMetadata {
  if (!cachedMetadata) {
    const metrics = createDefaultGlyphMetrics();
    const glyphs: GlyphMetric[] = [];

    // Ensure all 256 slots are populated
    for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
      const col = slot % ATLAS_COLS;
      const row = Math.floor(slot / ATLAS_COLS);
      const style = slot < 128 ? FONT_STYLE_SERIF : FONT_STYLE_TECHNICAL;
      const localSlot = slot < 128 ? slot : slot - 128;

      let found: GlyphMetric | undefined;
      for (const m of metrics.values()) {
        if (m.slotIndex === slot) {
          found = m;
          break;
        }
      }

      if (found) {
        glyphs.push(found);
      } else {
        glyphs.push({
          char: String.fromCharCode(localSlot),
          code: localSlot,
          slotIndex: slot,
          u0: col / ATLAS_COLS,
          v0: row / ATLAS_ROWS,
          u1: (col + 1) / ATLAS_COLS,
          v1: (row + 1) / ATLAS_ROWS,
          widthEm: 0.55,
          heightEm: 0.90,
          bearingXEm: 0.05,
          bearingYEm: 0.80,
          advanceEm: 0.55,
          fontStyle: style,
        });
      }
    }

    cachedMetadata = {
      atlasWidth: ATLAS_WIDTH,
      atlasHeight: ATLAS_HEIGHT,
      cellSize: CELL_SIZE,
      spreadPx: SPREAD_PX,
      cols: ATLAS_COLS,
      rows: ATLAS_ROWS,
      fontSerifName: 'IM Fell English, Caslon, serif',
      fontTechnicalName: 'DIN Alternate, Consolas, monospace',
      metrics,
      glyphs,
    };
  }
  return cachedMetadata;
}

/**
 * Retrieves the metric for a specific character and font style.
 */
export function getGlyphMetric(char: string, fontStyle = FONT_STYLE_SERIF): GlyphMetric | undefined {
  const metadata = getFontAtlasMetadata();
  const lookupKey = `${char}:${fontStyle}`;
  return metadata.metrics.get(lookupKey) || metadata.metrics.get(char);
}

export const FONT_ATLAS_METADATA: FontAtlasMetadata = getFontAtlasMetadata();

/**
 * Projects a geodetic (lon, lat) coordinate to canonical 3D sphere pos and 2D Mercator pos.
 */
export function projectGeodeticToManifold(
  lonDeg: number,
  latDeg: number,
  radius = 5.0
): { sphere3D: [number, number, number]; mercator2D: [number, number] } {
  const DEG_TO_RAD = Math.PI / 180.0;
  const lonRad = lonDeg * DEG_TO_RAD;
  const latRad = latDeg * DEG_TO_RAD;

  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const cosLon = Math.cos(lonRad);
  const sinLon = Math.sin(lonRad);

  const sphere3D: [number, number, number] = [
    radius * cosLat * sinLon,
    radius * sinLat,
    radius * cosLat * cosLon,
  ];

  const clampedLat = Math.max(-1.4835, Math.min(1.4835, latRad));
  const mercY = Math.log(Math.tan(Math.PI * 0.25 + clampedLat * 0.5)) * radius;
  const mercX = lonRad * radius;

  return { sphere3D, mercator2D: [mercX, mercY] };
}

/**
 * Converts a collection of ToponymLabels into a continuous Float32Array
 * of glyph quad instances conforming to `sdf_text.wgsl`.
 *
 * Stride per instance: 20 float32s (80 bytes)
 * Attributes per glyph instance:
 * - 0..3:   pos_anchor3d [x, y, z, fontSizePx]
 * - 4..7:   pos_target2d [mercX, mercY, orientationMode, elevStandoff]
 * - 8..11:  glyph_rect   [offsetX_px, offsetY_px, width_px, height_px]
 * - 12..15: glyph_uv     [u0, v0, u1, v1]
 * - 16..19: glyph_style  [fontStyle, colorPreset, minCamDist, alpha]
 */
export function layoutToponymLabels(
  labels: ToponymLabel[],
  targetBuffer?: Float32Array
): { instances: Float32Array; glyphCount: number } {
  const metadata = getFontAtlasMetadata();
  const metrics = metadata.metrics;

  // First pass: count total printable glyphs
  let totalGlyphs = 0;
  for (let i = 0; i < labels.length; i++) {
    const text = (labels[i].text || '').normalize('NFC');
    for (const char of text) {
      if (char !== ' ' && !/[\u0300-\u036f]/.test(char)) totalGlyphs++;
    }
  }

  const FLOATS_PER_GLYPH = 20;
  const maxGlyphs = targetBuffer
    ? Math.floor(targetBuffer.length / FLOATS_PER_GLYPH)
    : totalGlyphs;
  const out = targetBuffer ?? new Float32Array(totalGlyphs * FLOATS_PER_GLYPH);

  let glyphIndex = 0;

  for (let i = 0; i < labels.length; i++) {
    if (glyphIndex >= maxGlyphs) break;
    const label = labels[i];
    const { sphere3D, mercator2D } = projectGeodeticToManifold(label.lon, label.lat, 5.0);
    const fontSize = label.fontSize || 11.0;
    const fontStyle = label.fontStyle !== undefined ? label.fontStyle : FONT_STYLE_SERIF;
    const colorPreset = label.colorPreset || 0.0;
    const minCamDist =
      label.minCamDist !== undefined
        ? label.minCamDist
        : label.tier === 'regional' || (label.tier as any) === 2
        ? 14.0
        : label.tier === 'local' || (label.tier as any) === 3
        ? 8.5
        : 0.0;
    const alpha = label.alpha !== undefined ? label.alpha : 1.0;

    let orientationVal = 0.0; // Billboard
    if (label.orientation === 'surface-tangent' || (label.orientation as any) === 1) orientationVal = 1.0;
    else if (label.orientation === 'geodesic-curve' || (label.orientation as any) === 2) orientationVal = 2.0;

    const elevStandoff = 0.0015; // Strictly <= 0.002 

    // Layout glyphs along baseline
    let cursorX = 0.0;
    const text = (label.text || '').normalize('NFC');

    for (const char of text) {
      if (glyphIndex >= maxGlyphs) break;

      // Skip standalone combining marks without advance or rendering
      if (/[\u0300-\u036f]/.test(char)) continue;

      const lookupKey = `${char}:${fontStyle}`;
      let metric = metrics.get(lookupKey) || metrics.get(char);

      // Graceful fallback for decomposed Unicode diacritics (e.g. 'á' -> 'a', 'í' -> 'i')
      if (!metric) {
        const baseChar = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (baseChar && baseChar !== char) {
          metric = metrics.get(`${baseChar}:${fontStyle}`) || metrics.get(baseChar);
        }
      }
      metric = metric || metrics.get('?');

      if (!metric) {
        cursorX += fontSize * 0.5;
        continue;
      }

      if (char === ' ') {
        cursorX += metric.advanceEm * fontSize;
        continue;
      }

      // Isotropic 1:1 square cell quad mapping: preserves exact letterform proportions
      // and uniform 360-degree SDF halo thickness without horizontal compression.
      const advancePx = metric.advanceEm * fontSize;
      const cellQuadSize = 1.28 * fontSize;
      const glyphW = cellQuadSize;
      const glyphH = cellQuadSize;
      const glyphOffsetX = cursorX + 0.5 * advancePx - 0.5 * glyphW;
      const glyphOffsetY = -(metric.bearingYEm + 0.19) * fontSize;

      const offset = glyphIndex * FLOATS_PER_GLYPH;

      // 0..3: pos_anchor3d
      out[offset + 0] = sphere3D[0];
      out[offset + 1] = sphere3D[1];
      out[offset + 2] = sphere3D[2];
      out[offset + 3] = fontSize;

      // 4..7: pos_target2d
      out[offset + 4] = mercator2D[0];
      out[offset + 5] = mercator2D[1];
      out[offset + 6] = orientationVal;
      out[offset + 7] = elevStandoff;

      // 8..11: glyph_rect
      out[offset + 8] = glyphOffsetX;
      out[offset + 9] = glyphOffsetY;
      out[offset + 10] = glyphW;
      out[offset + 11] = glyphH;

      // 12..15: glyph_uv
      out[offset + 12] = metric.u0;
      out[offset + 13] = metric.v0;
      out[offset + 14] = metric.u1;
      out[offset + 15] = metric.v1;

      // 16..19: glyph_style
      out[offset + 16] = fontStyle;
      out[offset + 17] = colorPreset;
      out[offset + 18] = minCamDist;
      out[offset + 19] = alpha;

      cursorX += advancePx;
      glyphIndex++;
    }
  }

  return { instances: out, glyphCount: glyphIndex };
}
