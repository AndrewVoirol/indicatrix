/**
 * ArchivalPigmentation.ts
 *
 * Canonical spectral Doppler radar echo formulation for the Indicatrix Engine
 * (`crust_hydrosphere.wgsl` 10 km WeatherNext 3 `total_precipitation_1hr_mean` overlay).
 *
 * Architecture Invariants:
 *   monochrome blue stains never collide with hydrology ink or obscure terrain beneath 3D clouds.
 * - Theme 2 (Prussian Cyanotype 1842) enforces strict cold actinic cyan-white echoes (B >= G >= R,
 *   zero warm yellow/orange/gold bleed ), while Themes 0 & 1 render meteorological
 *   spectral Doppler echoes.
 */

/**
 * 2D pseudo-random hash function matching WGSL hashPaper2D.
 */
export function hashPaper2D(px: number | [number, number], py?: number): number {
  let x: number, y: number;
  if (Array.isArray(px)) {
    x = px[0];
    y = px[1];
  } else {
    x = px;
    y = py ?? 0;
  }
  const dot = x * 127.1 + y * 311.7;
  const s = Math.sin(dot) * 43758.5453123;
  return s - Math.floor(s);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Samples meteorological spectral Doppler radar echoes (Themes 0 & 1) or
 * strictly monochromatic cold actinic cyan-white echoes on Prussian Cyanotype (Theme 2).
 *
 * @param precipRate - Precipitation intensity in mm/hr
 * @param theme - Active cartographic medium (0: Marie Tharp, 1: Cream Rag, 2: Prussian Cyanotype)
 * @returns RGBA Doppler color [r, g, b, a]
 */
export function sample_spectral_doppler(
  precipRate: number,
  theme: number = 0
): [number, number, number, number] {
  if (precipRate < 0.1) {
    return [0.0, 0.0, 0.0, 0.0];
  }

  const mix3 = (
    c1: [number, number, number],
    c2: [number, number, number],
    t: number
  ): [number, number, number] => [
    c1[0] * (1.0 - t) + c2[0] * t,
    c1[1] * (1.0 - t) + c2[1] * t,
    c1[2] * (1.0 - t) + c2[2] * t,
  ];

  if (theme === 2) {
    // Theme 2 (Prussian Cyanotype 1842): Strictly cold actinic cyan-to-chalk ramp (B >= G >= R)
    const cCobalt: [number, number, number]   = [0.110, 0.306, 0.502]; // #1C4E80
    const cCerulean: [number, number, number] = [0.220, 0.510, 0.769]; // #3882C4
    const cCyan: [number, number, number]     = [0.416, 0.769, 0.941]; // #6AC4F0
    const cBleached: [number, number, number] = [0.737, 0.910, 1.000]; // #BCE8FF
    const cChalk: [number, number, number]    = [0.961, 0.980, 1.000]; // #F5FAFF

    let color: [number, number, number];
    let alpha = 0.72;

    if (precipRate < 1.0) {
      const t = (precipRate - 0.1) / 0.9;
      color = mix3(cCobalt, cCerulean, t);
      alpha = 0.36 * (1.0 - t) + 0.58 * t;
    } else if (precipRate < 2.5) {
      const t = (precipRate - 1.0) / 1.5;
      color = mix3(cCerulean, cCyan, t);
      alpha = 0.58 * (1.0 - t) + 0.72 * t;
    } else if (precipRate < 7.5) {
      const t = (precipRate - 2.5) / 5.0;
      color = mix3(cCyan, cBleached, t);
      alpha = 0.72 * (1.0 - t) + 0.82 * t;
    } else if (precipRate < 15.0) {
      const t = (precipRate - 7.5) / 7.5;
      color = mix3(cBleached, cChalk, t * 0.65);
      alpha = 0.82 * (1.0 - t) + 0.88 * t;
    } else {
      const t = clamp((precipRate - 15.0) / 35.0, 0.0, 1.0);
      color = mix3(mix3(cBleached, cChalk, 0.65), cChalk, t);
      alpha = 0.88 * (1.0 - t) + 0.94 * t;
    }

    return [color[0], color[1], color[2], alpha];
  }

  const cLightBlue: [number, number, number] = [0.25, 0.60, 1.00];
  const cGreen: [number, number, number]     = [0.00, 0.78, 0.20];
  const cYellow: [number, number, number]    = [1.00, 0.85, 0.00];
  const cOrange: [number, number, number]    = [1.00, 0.47, 0.00];
  const cRed: [number, number, number]       = [0.90, 0.00, 0.00];
  const cMagenta: [number, number, number]   = [0.78, 0.00, 0.78];

  let color: [number, number, number];
  let alpha = 0.75;

  if (precipRate < 1.0) {
    const t = (precipRate - 0.1) / 0.9;
    color = mix3([cLightBlue[0] * 0.8, cLightBlue[1] * 0.8, cLightBlue[2] * 0.8], cLightBlue, t);
    alpha = 0.40 * (1.0 - t) + 0.65 * t;
  } else if (precipRate < 2.5) {
    const t = (precipRate - 1.0) / 1.5;
    color = mix3(cLightBlue, cGreen, t);
    alpha = 0.65 * (1.0 - t) + 0.75 * t;
  } else if (precipRate < 7.5) {
    const t = (precipRate - 2.5) / 5.0;
    color = mix3(cGreen, cYellow, t);
    alpha = 0.75 * (1.0 - t) + 0.80 * t;
  } else if (precipRate < 15.0) {
    const t = (precipRate - 7.5) / 7.5;
    color = mix3(cYellow, cOrange, t);
    alpha = 0.80 * (1.0 - t) + 0.85 * t;
  } else if (precipRate < 30.0) {
    const t = (precipRate - 15.0) / 15.0;
    color = mix3(cOrange, cRed, t);
    alpha = 0.85 * (1.0 - t) + 0.90 * t;
  } else {
    const t = clamp((precipRate - 30.0) / 20.0, 0.0, 1.0);
    color = mix3(cRed, cMagenta, t);
    alpha = 0.90 * (1.0 - t) + 0.95 * t;
  }

  return [color[0], color[1], color[2], alpha];
}

export const sampleSpectralDoppler = sample_spectral_doppler;
