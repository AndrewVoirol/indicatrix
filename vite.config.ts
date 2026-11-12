import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mountWorktreeAssets } from './scripts/mount-worktree-assets.ts';

import type { IncomingMessage, ServerResponse } from 'http';
import { spawn } from 'child_process';

export function isPlanetaryIngestionFrozen(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = String(env.INDICATRIX_FREEZE_INGESTION || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || Boolean(env.VITEST);
}

export interface ParsedByteRange {
  ok: boolean;
  start: number;
  end: number;
}

export function parseByteRangeHeader(rangeHeader: string, totalSize: number): ParsedByteRange | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return null;
  }
  const spec = rangeHeader.slice('bytes='.length).trim();
  // Multi-range requests or empty range specs -> 416 if malformed, or fall back cleanly
  if (!spec || spec.includes(',')) {
    return { ok: false, start: 0, end: 0 };
  }
  const dashIdx = spec.indexOf('-');
  if (dashIdx === -1) {
    return { ok: false, start: 0, end: 0 };
  }

  const startStr = spec.slice(0, dashIdx).trim();
  const endStr = spec.slice(dashIdx + 1).trim();

  if (totalSize <= 0) {
    return { ok: false, start: 0, end: 0 };
  }

  // Suffix byte-range-spec: bytes=-N
  if (startStr === '') {
    if (!/^\d+$/.test(endStr)) return { ok: false, start: 0, end: 0 };
    const suffixLen = Number(endStr);
    if (!Number.isSafeInteger(suffixLen) || suffixLen <= 0) {
      return { ok: false, start: 0, end: 0 };
    }
    const start = Math.max(0, totalSize - suffixLen);
    return { ok: true, start, end: totalSize - 1 };
  }

  if (!/^\d+$/.test(startStr)) {
    return { ok: false, start: 0, end: 0 };
  }
  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) {
    return { ok: false, start: 0, end: 0 };
  }

  // Open-ended byte-range-spec: bytes=N-
  if (endStr === '') {
    return { ok: true, start, end: totalSize - 1 };
  }

  if (!/^\d+$/.test(endStr)) {
    return { ok: false, start: 0, end: 0 };
  }
  const rawEnd = Number(endStr);
  if (!Number.isSafeInteger(rawEnd) || rawEnd < start) {
    return { ok: false, start: 0, end: 0 };
  }

  return { ok: true, start, end: Math.min(rawEnd, totalSize - 1) };
}

function inferPublicAssetMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.webp':
      return 'image/webp';
    case '.png':
      return 'image/png';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.dds':
    case '.bin':
    default:
      return 'application/octet-stream';
  }
}

export function createPublicAssetRangeMiddleware(
  publicDir: string,
  options: { freezeIngestion?: boolean } = {}
) {
  const resolvedPublicRoot = path.resolve(publicDir);
  const frozenGfsSnapshotCache = new Map<string, { body: Buffer; mtimeUTC: string; etag: string }>();

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      next();
      return;
    }

    let rawUrl = '';
    try {
      rawUrl = decodeURIComponent((req.url || '').split('?')[0] || '');
    } catch {
      rawUrl = (req.url || '').split('?')[0] || '';
    }
    if (!rawUrl || rawUrl.startsWith('/@') || rawUrl.startsWith('/src/') || rawUrl.startsWith('/__workbench')) {
      next();
      return;
    }

    const relPath = rawUrl.replace(/^\/+/, '');
    const resolvedPath = path.resolve(resolvedPublicRoot, relPath);
    if (resolvedPath !== resolvedPublicRoot && !resolvedPath.startsWith(resolvedPublicRoot + path.sep)) {
      next();
      return;
    }

    const isBinaryGuardExt =
      rawUrl.endsWith('.bin') || rawUrl.endsWith('.cog.tif') || rawUrl.endsWith('.cog');

    let stat: fs.Stats | null = null;
    try {
      if (fs.existsSync(resolvedPath)) {
        const candidate = fs.statSync(resolvedPath);
        if (candidate.isFile()) {
          stat = candidate;
        }
      }
    } catch {
      stat = null;
    }

    if (!stat) {
      if (isBinaryGuardExt) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end(`Binary asset not found: ${rawUrl}`);
        return;
      }
      next();
      return;
    }

    const isFrozenGfsAsset =
      Boolean(options.freezeIngestion) &&
      (relPath.startsWith('data/gfs-') || relPath === 'data/ingestion-status.json');

    let pinnedSnapshot = isFrozenGfsAsset ? frozenGfsSnapshotCache.get(relPath) ?? null : null;
    if (isFrozenGfsAsset && !pinnedSnapshot) {
      try {
        const body = fs.readFileSync(resolvedPath);
        pinnedSnapshot = {
          body,
          mtimeUTC: stat.mtime.toUTCString(),
          etag: `W/"${body.byteLength.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`,
        };
        frozenGfsSnapshotCache.set(relPath, pinnedSnapshot);
      } catch {
        pinnedSnapshot = null;
      }
    }

    const totalSize = pinnedSnapshot ? pinnedSnapshot.body.byteLength : stat.size;
    const etag = pinnedSnapshot
      ? pinnedSnapshot.etag
      : `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const lastModified = pinnedSnapshot ? pinnedSnapshot.mtimeUTC : stat.mtime.toUTCString();
    const contentType = inferPublicAssetMime(resolvedPath);

    res.setHeader('Accept-Ranges', 'bytes');

    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
    if (rangeHeader) {
      const parsed = parseByteRangeHeader(rangeHeader, totalSize);
      if (!parsed || !parsed.ok) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        res.setHeader('Content-Length', '0');
        res.end();
        return;
      }

      const { start, end } = parsed;
      const chunkLength = end - start + 1;
      res.statusCode = 206;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', String(chunkLength));
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', lastModified);

      if (method === 'HEAD') {
        res.end();
        return;
      }

      if (pinnedSnapshot) {
        res.end(pinnedSnapshot.body.subarray(start, end + 1));
        return;
      }

      const stream = fs.createReadStream(resolvedPath, { start, end });
      stream.on('error', () => {
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
      stream.pipe(res);
      return;
    }

    if (method === 'HEAD' || pinnedSnapshot) {
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(totalSize));
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', lastModified);
      if (method === 'HEAD') {
        res.end();
      } else {
        res.end(pinnedSnapshot!.body);
      }
      return;
    }

    next();
  };
}

const extraDevPlugins: PluginOption[] = [];

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [
    tailwindcss(),
    react(),
    ...extraDevPlugins,
    {
      name: 'worktree-asset-guard',
      configureServer(server) {
        const freezeIngestion = isPlanetaryIngestionFrozen();
        try {
          mountWorktreeAssets(import.meta.dirname);
        } catch {}

        // Hourly background GFS refresh in dev-serve, strictly disabled when INDICATRIX_FREEZE_INGESTION is set
        if (!freezeIngestion && !process.env.CI && process.env.NODE_ENV !== 'test') {
          const refreshIntervalMs = 60 * 60 * 1000;
          const timer = setInterval(() => {
            if (isPlanetaryIngestionFrozen()) return;
            const refreshScript = path.join(import.meta.dirname, 'scripts', 'refresh-planetary-data.ts');
            if (!fs.existsSync(refreshScript)) return;
            const child = spawn(process.execPath, ['--import', 'tsx', refreshScript, '--auto'], {
              cwd: import.meta.dirname,
              stdio: 'ignore',
              env: { ...process.env },
            });
            child.unref();
          }, refreshIntervalMs);
          timer.unref?.();
          server.httpServer?.once('close', () => clearInterval(timer));
        }

        server.middlewares.use(
          createPublicAssetRangeMiddleware(path.join(import.meta.dirname, 'public'), {
            freezeIngestion,
          })
        );
      },
      configurePreviewServer(server) {
        const freezeIngestion = isPlanetaryIngestionFrozen();
        const distDir = path.join(import.meta.dirname, 'dist');
        const publicDir = path.join(import.meta.dirname, 'public');
        const assetRoot = fs.existsSync(distDir) ? distDir : publicDir;
        server.middlewares.use(
          createPublicAssetRangeMiddleware(assetRoot, {
            freezeIngestion,
          })
        );
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    }
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/scheduler')) {
            return 'react-vendor';
          }
          if (id.includes('src/components/hud')) {
            return 'hud-components';
          }
        }
      }
    }
  }
});
