#!/usr/bin/env node
/**
 * scripts/mount-worktree-assets.ts
 *
 * Automated Worktree Asset Shared Mount Manager.
 * Links large gitignored binary payloads (.bin files) from canonical repository root
 * into linked git worktrees, preventing missing asset 404s and HTML SPA route fallbacks.
 *
 * Scans:
 * - public/*.bin
 * - public/regional/*.bin
 * - public/data/*.bin
 * - public/data/weathernext/*.bin
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CURRENT_ROOT = path.resolve(__dirname, '..');

export interface MountResult {
  isWorktree: boolean;
  canonicalRoot: string;
  scannedCount: number;
  linkedCount: number;
  syncedLiveCount: number;
  existingCount: number;
  brokenFixedCount: number;
  errorCount: number;
}

const LIVE_SYNC_REL_FILES = [
  'public/data/weathernext/meta.json',
  'public/data/satellite-meta.json',
  'public/data/gfs-cloud-high-latest.bin',
  'public/data/gfs-cloud-low-latest.bin',
  'public/data/gfs-cloud-mid-latest.bin',
  'public/data/gfs-jetstream-latest.bin',
  'public/data/gfs-wind-latest.bin',
  'public/data/gfs-wind-meta.json',
  'public/data/tle-starlink.json',
  'public/data/ingestion-status.json',
];

function parseJsonIsoMs(filePath: string, keys: string[]): number | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    for (const k of keys) {
      if (typeof parsed?.[k] === 'string') {
        const ms = Date.parse(parsed[k]);
        if (!Number.isNaN(ms)) return ms;
      }
    }
  } catch {}
  return null;
}

export function detectCanonicalRoot(startDir: string = CURRENT_ROOT): { isWorktree: boolean; canonicalRoot: string } {
  try {
    const gitCommon = execSync('git rev-parse --git-common-dir', {
      cwd: startDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const resolvedCanonical = path.resolve(startDir, gitCommon, '..');
    const isWorktree = path.resolve(resolvedCanonical) !== path.resolve(startDir);
    return { isWorktree, canonicalRoot: resolvedCanonical };
  } catch {
    // If git fails, check if .git is a file
    const dotGit = path.join(startDir, '.git');
    if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
      try {
        const content = fs.readFileSync(dotGit, 'utf-8');
        const match = content.match(/gitdir:\s*(.*)/);
        if (match) {
          const gitDir = path.resolve(startDir, match[1].trim());
          const candidate = path.resolve(gitDir, '../../..');
          return { isWorktree: true, canonicalRoot: candidate };
        }
      } catch {}
    }
    return { isWorktree: false, canonicalRoot: startDir };
  }
}

export function mountWorktreeAssets(targetDir: string = CURRENT_ROOT): MountResult {
  const { isWorktree, canonicalRoot } = detectCanonicalRoot(targetDir);

  const result: MountResult = {
    isWorktree,
    canonicalRoot,
    scannedCount: 0,
    linkedCount: 0,
    syncedLiveCount: 0,
    existingCount: 0,
    brokenFixedCount: 0,
    errorCount: 0,
  };

  if (!isWorktree) {
    return result;
  }

  const assetDirs = [
    'public',
    path.join('public', 'regional'),
    path.join('public', 'data'),
    path.join('public', 'data', 'weathernext'),
  ];

  for (const relDir of assetDirs) {
    const sourceDir = path.join(canonicalRoot, relDir);
    const destDir = path.join(targetDir, relDir);

    if (!fs.existsSync(sourceDir)) continue;
    fs.mkdirSync(destDir, { recursive: true });

    let files: string[] = [];
    try {
      files = fs.readdirSync(sourceDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (
        !file.endsWith('.bin') ||
        file === 'gfs-multistratum-latest.bin' ||
        file === 'radar-loop-latest.bin' ||
        file.startsWith('u_component_of_wind_10m_mean-') ||
        file.startsWith('v_component_of_wind_10m_mean-') ||
        file.startsWith('total_cloud_cover_mean-')
      ) {
        continue;
      }
      result.scannedCount++;

      const sourceFile = path.join(sourceDir, file);
      const destFile = path.join(destDir, file);

      let statOrLstat: fs.Stats | null = null;
      try {
        statOrLstat = fs.lstatSync(destFile);
      } catch {
        statOrLstat = null;
      }

      if (statOrLstat) {
        if (statOrLstat.isSymbolicLink()) {
          // Check if symlink target exists
          try {
            const targetPath = fs.realpathSync(destFile);
            if (fs.existsSync(targetPath)) {
              result.existingCount++;
              continue;
            }
          } catch {}
          // Broken symlink - remove and relink
          try {
            fs.unlinkSync(destFile);
            fs.symlinkSync(sourceFile, destFile);
            result.brokenFixedCount++;
          } catch {
            result.errorCount++;
          }
        } else {
          // Regular file already exists in worktree
          result.existingCount++;
        }
      } else {
        // File doesn't exist in worktree - create symlink
        try {
          fs.symlinkSync(sourceFile, destFile);
          result.linkedCount++;
        } catch {
          result.errorCount++;
        }
      }
    }
  }

  // Keep live planetary feed files & WeatherNext meta.json in lockstep with canonicalRoot
  // when canonicalRoot has newer background-ingested feeds than the worktree checkout.
  const freezeVal = String(process.env.INDICATRIX_FREEZE_INGESTION || '').toLowerCase();
  const isFrozen = freezeVal === '1' || freezeVal === 'true';
  const isTest = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
  if (!isTest && !isFrozen) {
    const canonWnMs = parseJsonIsoMs(path.join(canonicalRoot, 'public/data/weathernext/meta.json'), ['ingestedAtUTC', 'forecastInitTimestamp']);
    const localWnMs = parseJsonIsoMs(path.join(targetDir, 'public/data/weathernext/meta.json'), ['ingestedAtUTC', 'forecastInitTimestamp']);
    if (canonWnMs !== null && (localWnMs === null || canonWnMs > localWnMs)) {
      try {
        const srcMeta = path.join(canonicalRoot, 'public/data/weathernext/meta.json');
        const dstMeta = path.join(targetDir, 'public/data/weathernext/meta.json');
        fs.mkdirSync(path.dirname(dstMeta), { recursive: true });
        fs.copyFileSync(srcMeta, dstMeta);
        result.syncedLiveCount++;
      } catch {
        result.errorCount++;
      }
    }

    const canonStatusMs = parseJsonIsoMs(path.join(canonicalRoot, 'public/data/ingestion-status.json'), ['updatedAtUTC']);
    const localStatusMs = parseJsonIsoMs(path.join(targetDir, 'public/data/ingestion-status.json'), ['updatedAtUTC']);
    if (canonStatusMs !== null && (localStatusMs === null || canonStatusMs > localStatusMs)) {
      for (const relFile of LIVE_SYNC_REL_FILES) {
        if (relFile === 'public/data/weathernext/meta.json') continue;
        const src = path.join(canonicalRoot, relFile);
        const dst = path.join(targetDir, relFile);
        if (!fs.existsSync(src)) continue;
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          const st = fs.existsSync(dst) ? fs.lstatSync(dst) : null;
          if (st?.isSymbolicLink()) fs.unlinkSync(dst);
          fs.copyFileSync(src, dst);
          result.syncedLiveCount++;
        } catch {
          result.errorCount++;
        }
      }
    }
  }

  return result;
}

export function syncWorktreeLiveFeedsToCanonical(worktreeDir: string = CURRENT_ROOT): number {
  const { isWorktree, canonicalRoot } = detectCanonicalRoot(worktreeDir);
  if (!isWorktree) return 0;
  let copied = 0;
  for (const relFile of LIVE_SYNC_REL_FILES) {
    const src = path.join(worktreeDir, relFile);
    const dst = path.join(canonicalRoot, relFile);
    if (!fs.existsSync(src)) continue;
    try {
      if (fs.realpathSync(src) === (fs.existsSync(dst) ? fs.realpathSync(dst) : '')) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied++;
    } catch {}
  }
  return copied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('[mount-worktree-assets] Scanning repository structure...');
  const res = mountWorktreeAssets();
  if (res.isWorktree) {
    console.log(`[mount-worktree-assets] Linked git worktree detected.`);
    console.log(`[mount-worktree-assets] Canonical root: ${res.canonicalRoot}`);
    console.log(
      `[mount-worktree-assets] Slices scanned: ${res.scannedCount} | Linked: ${res.linkedCount} | Live synced: ${res.syncedLiveCount} | Existing: ${res.existingCount} | Broken fixed: ${res.brokenFixedCount}`
    );
  } else {
    console.log(`[mount-worktree-assets] Running in canonical repository root. No external symlinks required.`);
  }
}
