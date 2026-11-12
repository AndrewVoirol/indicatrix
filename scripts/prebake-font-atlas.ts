#!/usr/bin/env npx tsx
// ============================================================================
// File: scripts/prebake-font-atlas.ts
// Offline prebaking tool for the 1024x1024 dual-style (Archival Serif +
// Technical DIN) Signed Distance Field (SDF) font atlas.
// Uses node-canvas 2D vector font rasterization so the prebaked binary
// preserves crisp Georgia / DIN Alternate letterforms without spending
// ~60-110 ms running 256 Felzenszwalb-Huttenlocher 2D EDTs on boot.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATLAS_WIDTH,
  ATLAS_HEIGHT,
  encodePrebakedSDFAtlas,
  generateProceduralSDFAtlas,
} from '../src/core/data/toponymy/fontAtlas';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT_DIR, 'public', 'data', 'sdf-font-atlas-1024.bin');

async function installNodeCanvasShim(): Promise<boolean> {
  try {
    const canvasMod = await import('canvas');
    const createCanvas = canvasMod.createCanvas ?? (canvasMod as any).default?.createCanvas;
    if (typeof createCanvas !== 'function') return false;

    class NodeOffscreenCanvas {
      private inner: any;
      public width: number;
      public height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.inner = createCanvas(width, height);
      }
      public getContext(type: string) {
        return this.inner.getContext(type);
      }
    }

    (globalThis as any).OffscreenCanvas = NodeOffscreenCanvas;
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const hasVectorCanvas = await installNodeCanvasShim();
  const pixels = generateProceduralSDFAtlas();
  const binary = encodePrebakedSDFAtlas(pixels);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, binary);
  const elapsedMs = (performance.now() - t0).toFixed(1);

  console.log(
    `[prebake-font-atlas] Wrote ${OUTPUT_PATH} (${binary.byteLength.toLocaleString()} B, ${ATLAS_WIDTH}x${ATLAS_HEIGHT}, vectorCanvas=${hasVectorCanvas}) in ${elapsedMs} ms`
  );
}

main().catch((err) => {
  console.error('[prebake-font-atlas] Failed:', err);
  process.exit(1);
});
