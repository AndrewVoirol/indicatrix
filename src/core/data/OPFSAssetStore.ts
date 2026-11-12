// ============================================================================
// File: src/core/data/OPFSAssetStore.ts
// Version-hashed Origin Private File System (OPFS) binary cache for unpacked
// GPU-ready rg16float DEM mip pyramids + cpuDEMData and WeatherNext Float16
// chunks. Strictly no-ops under process.env.VITEST unless an explicit
// FileSystemDirectoryHandle override is injected by a unit test.
// ============================================================================

export const OPFS_GLOBAL_DEM_SCHEMA = 'rg16f-global-anorm-v1' as const;
export const OPFS_REGIONAL_DEM_SCHEMA = 'rg16f-regional-elevm-v1' as const;
export const OPFS_REGIONAL_COG_TILE_SCHEMA = 'rg16f-regional-cog-tile-v1' as const;
export const OPFS_WEATHERNEXT_CHUNK_SCHEMA = 'wn3-f16-chunk-v1' as const;

export type OPFSSchemaId =
  | typeof OPFS_GLOBAL_DEM_SCHEMA
  | typeof OPFS_REGIONAL_DEM_SCHEMA
  | typeof OPFS_REGIONAL_COG_TILE_SCHEMA
  | typeof OPFS_WEATHERNEXT_CHUNK_SCHEMA;

const OPFS_MAGIC = 0x4f504653; // 'SFPO' little-endian ('OPFS' marker)
const OPFS_FORMAT_VERSION = 1;
const OPFS_CACHE_SUBDIR = 'indicatrix-gpu-cache-v1';

export interface RegionalBoundsMeta {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

export interface GlobalDEMPyramidRecord {
  schema: typeof OPFS_GLOBAL_DEM_SCHEMA;
  versionTag: string;
  width: number;
  height: number;
  mipLevelCount: number;
  cpuDEMData: Int16Array;
  mipLevels: Uint8Array[];
}

export interface RegionalDEMPyramidRecord {
  schema: typeof OPFS_REGIONAL_DEM_SCHEMA;
  versionTag: string;
  id: string;
  width: number;
  height: number;
  mipLevelCount: number;
  bounds: RegionalBoundsMeta;
  has30mGroundTruth: boolean;
  hasFinerLevel0?: boolean;
  level0LatDegPerPx?: number;
  mipLevels: Uint8Array[];
}

export interface RegionalCOGTileRecord {
  schema: typeof OPFS_REGIONAL_COG_TILE_SCHEMA;
  versionTag: string;
  id: string;
  lod: number;
  tileX: number;
  tileY: number;
  bounds: RegionalBoundsMeta;
  uvScaleX: number;
  uvScaleY: number;
  rg16Data: Uint16Array;
}

export interface WeatherNextChunkRecord {
  schema: typeof OPFS_WEATHERNEXT_CHUNK_SCHEMA;
  versionTag: string;
  variable: string;
  hourOffset: number;
  channels: number;
  data: Uint16Array;
}

export interface OPFSAssetStoreOptions {
  rootDirOverride?: FileSystemDirectoryHandle | null;
  allowInVitest?: boolean;
}

function align8(n: number): number {
  return (n + 7) & ~7;
}

export function isVitestRuntime(): boolean {
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  return Boolean(proc?.env?.VITEST);
}

/**
 * Deterministic 64-bit (dual 32-bit FNV-1a) hash formatted as 16 lowercase hex chars.
 */
export function hashCacheDescriptor(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c ^ ((i & 0xff) << 8);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function sanitizeKeyToken(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'asset';
}

export function computeExpectedRG16MipByteLengths(
  width: number,
  height: number,
  mipLevelCount: number
): number[] {
  const lengths: number[] = [];
  for (let mip = 0; mip < mipLevelCount; mip++) {
    const mw = Math.max(1, width >> mip);
    const mh = Math.max(1, height >> mip);
    lengths.push(mw * mh * 4); // rg16float = 4 bytes per texel
  }
  return lengths;
}

interface EnvelopeHeader {
  schema: OPFSSchemaId;
  versionTag: string;
  sectionChecksums?: number[];
  width?: number;
  height?: number;
  mipLevelCount?: number;
  cpuDemInt16Length?: number;
  mipByteLengths?: number[];
  id?: string;
  bounds?: RegionalBoundsMeta;
  has30mGroundTruth?: boolean;
  hasFinerLevel0?: boolean;
  level0LatDegPerPx?: number;
  variable?: string;
  hourOffset?: number;
  channels?: number;
  u16Length?: number;
  lod?: number;
  tileX?: number;
  tileY?: number;
  uvScaleX?: number;
  uvScaleY?: number;
}

const ZERO_PAD_8 = new Uint8Array(8);

export function computeSectionDigest(bytes: Uint8Array): number {
  const len = bytes.byteLength;
  let hash = (0x811c9dc5 ^ len) >>> 0;
  if (len === 0) return hash;

  const headEnd = Math.min(len, 64);
  for (let i = 0; i < headEnd; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  if (len <= 4096) {
    for (let i = headEnd; i < len; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  const tailStart = Math.max(headEnd, len - 64);
  const step = Math.max(1, Math.floor((tailStart - headEnd) / 4096));
  for (let i = headEnd; i < tailStart; i += step) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  for (let i = tailStart; i < len; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function encodeEnvelopeChunks(header: EnvelopeHeader, sections: ArrayBufferView[]): Uint8Array[] {
  const sectionViews = sections.map(
    (sec) => new Uint8Array(sec.buffer, sec.byteOffset, sec.byteLength)
  );
  const fullHeader: EnvelopeHeader = {
    ...header,
    sectionChecksums: sectionViews.map((v) => computeSectionDigest(v)),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(fullHeader));
  const fixedPrefix = 16; // magic(4), formatVer(4), jsonLen(4), totalPayloadBytes(4)
  const payloadOffset = align8(fixedPrefix + jsonBytes.byteLength);
  let totalPayloadBytes = 0;
  for (const view of sectionViews) {
    totalPayloadBytes = align8(totalPayloadBytes) + view.byteLength;
  }

  const headerChunk = new Uint8Array(payloadOffset);
  const dv = new DataView(headerChunk.buffer);
  dv.setUint32(0, OPFS_MAGIC, true);
  dv.setUint32(4, OPFS_FORMAT_VERSION, true);
  dv.setUint32(8, jsonBytes.byteLength, true);
  dv.setUint32(12, totalPayloadBytes, true);
  headerChunk.set(jsonBytes, fixedPrefix);

  const chunks: Uint8Array[] = [headerChunk];
  let relCursor = 0;
  for (const view of sectionViews) {
    const aligned = align8(relCursor);
    const padLen = aligned - relCursor;
    if (padLen > 0) {
      chunks.push(ZERO_PAD_8.subarray(0, padLen));
    }
    if (view.byteLength > 0) {
      chunks.push(view);
    }
    relCursor = aligned + view.byteLength;
  }
  return chunks;
}

function verifySectionChecksum(
  header: EnvelopeHeader,
  sectionIndex: number,
  view: Uint8Array
): boolean {
  if (!Array.isArray(header.sectionChecksums)) return true;
  if (sectionIndex >= header.sectionChecksums.length) return false;
  return computeSectionDigest(view) === header.sectionChecksums[sectionIndex];
}

function decodeEnvelope(buffer: ArrayBuffer): { header: EnvelopeHeader; payloadOffset: number } | null {
  if (!buffer || buffer.byteLength < 16) return null;
  const dv = new DataView(buffer);
  const magic = dv.getUint32(0, true);
  const formatVer = dv.getUint32(4, true);
  const jsonLen = dv.getUint32(8, true);
  const totalPayloadBytes = dv.getUint32(12, true);

  if (magic !== OPFS_MAGIC || formatVer !== OPFS_FORMAT_VERSION) return null;
  if (jsonLen === 0 || jsonLen > 65536) return null;
  const payloadOffset = align8(16 + jsonLen);
  if (payloadOffset + totalPayloadBytes > buffer.byteLength) return null;

  try {
    const jsonText = new TextDecoder().decode(new Uint8Array(buffer, 16, jsonLen));
    const header = JSON.parse(jsonText) as EnvelopeHeader;
    if (!header || typeof header.schema !== 'string' || typeof header.versionTag !== 'string') {
      return null;
    }
    return { header, payloadOffset };
  } catch {
    return null;
  }
}

export class OPFSAssetStore {
  private readonly rootDirOverride: FileSystemDirectoryHandle | null;
  private readonly allowInVitest: boolean;
  private cacheDirPromise: Promise<FileSystemDirectoryHandle | null> | null = null;

  constructor(options: OPFSAssetStoreOptions = {}) {
    this.rootDirOverride = options.rootDirOverride ?? null;
    this.allowInVitest = Boolean(options.allowInVitest);
  }

  public isEnabled(): boolean {
    if (isVitestRuntime() && !this.allowInVitest) {
      return false;
    }
    if (this.rootDirOverride) {
      return true;
    }
    return Boolean(
      typeof navigator !== 'undefined' &&
        navigator.storage &&
        typeof navigator.storage.getDirectory === 'function'
    );
  }

  public buildFilename(schema: OPFSSchemaId, assetKey: string, versionTag: string): string {
    const digest = hashCacheDescriptor(`${schema}|${assetKey}|${versionTag}`);
    return `${schema}__${sanitizeKeyToken(assetKey)}__${digest}.opfsbin`;
  }

  private async getCacheDirectory(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.isEnabled()) return null;
    if (!this.cacheDirPromise) {
      this.cacheDirPromise = (async () => {
        try {
          const root = this.rootDirOverride ?? (await navigator.storage.getDirectory());
          return await root.getDirectoryHandle(OPFS_CACHE_SUBDIR, { create: true });
        } catch {
          return null;
        }
      })();
    }
    return this.cacheDirPromise;
  }

  private async readBinaryFile(filename: string): Promise<ArrayBuffer | null> {
    const dir = await this.getCacheDirectory();
    if (!dir) return null;
    try {
      const fileHandle = await dir.getFileHandle(filename, { create: false });
      const file = await fileHandle.getFile();
      return await file.arrayBuffer();
    } catch {
      return null;
    }
  }

  private async writeBinaryChunks(filename: string, chunks: Uint8Array[]): Promise<boolean> {
    const dir = await this.getCacheDirectory();
    if (!dir) return false;
    let fileCreated = false;
    let writable: FileSystemWritableFileStream | null = null;
    try {
      const fileHandle = await dir.getFileHandle(filename, { create: true });
      fileCreated = true;
      writable = await fileHandle.createWritable();
      for (const chunk of chunks) {
        if (chunk.byteLength > 0) {
          await writable.write(chunk as unknown as BufferSource);
        }
      }
      await writable.close();
      writable = null;
      return true;
    } catch {
      if (writable && typeof writable.abort === 'function') {
        await writable.abort().catch(() => {});
      }
      if (fileCreated) {
        await dir.removeEntry(filename).catch(() => {});
      }
      return false;
    }
  }

  public async deleteEntry(schema: OPFSSchemaId, assetKey: string, versionTag: string): Promise<boolean> {
    const dir = await this.getCacheDirectory();
    if (!dir) return false;
    const filename = this.buildFilename(schema, assetKey, versionTag);
    try {
      await dir.removeEntry(filename);
      return true;
    } catch {
      return false;
    }
  }

  public async getGlobalDEMPyramid(
    assetKey: string,
    versionTag: string
  ): Promise<GlobalDEMPyramidRecord | null> {
    if (!this.isEnabled()) return null;
    const filename = this.buildFilename(OPFS_GLOBAL_DEM_SCHEMA, assetKey, versionTag);
    const buffer = await this.readBinaryFile(filename);
    if (!buffer) return null;

    const decoded = decodeEnvelope(buffer);
    if (!decoded) {
      await this.deleteEntry(OPFS_GLOBAL_DEM_SCHEMA, assetKey, versionTag);
      return null;
    }

    const { header, payloadOffset } = decoded;
    if (
      header.schema !== OPFS_GLOBAL_DEM_SCHEMA ||
      header.versionTag !== versionTag ||
      !header.width ||
      !header.height ||
      !header.mipLevelCount ||
      typeof header.cpuDemInt16Length !== 'number' ||
      !Array.isArray(header.mipByteLengths)
    ) {
      await this.deleteEntry(OPFS_GLOBAL_DEM_SCHEMA, assetKey, versionTag);
      return null;
    }

    const expectedMipLengths = computeExpectedRG16MipByteLengths(
      header.width,
      header.height,
      header.mipLevelCount
    );
    if (expectedMipLengths.length !== header.mipByteLengths.length) {
      await this.deleteEntry(OPFS_GLOBAL_DEM_SCHEMA, assetKey, versionTag);
      return null;
    }

    let relOffset = 0;
    const cpuBytes = header.cpuDemInt16Length * 2;
    if (payloadOffset + cpuBytes > buffer.byteLength) {
      await this.deleteEntry(OPFS_GLOBAL_DEM_SCHEMA, assetKey, versionTag);
      return null;
    }
    const cpuView = new Uint8Array(buffer, payloadOffset + relOffset, cpuBytes);
    if (!verifySectionChecksum(header, 0, cpuView)) {
      await this.deleteEntry(OPFS_GLOBAL_DEM_SCHEMA, assetKey, versionTag);
      return null;
    }
    const cpuDEMData = new Int16Array(buffer, payloadOffset + relOffset, header.cpuDemInt16Length);
    relOffset = align8(relOffset + cpuBytes);

    const mipLevels: Uint8Array[] = [];
    for (let mip = 0; mip < expectedMipLengths.length; mip++) {
      const byteLen = expectedMipLengths[mip];
      if (header.mipByteLengths[mip] !== byteLen || payloadOffset + relOffset + byteLen > buffer.byteLength) {
        await this.deleteEntry(OPFS_GLOBAL_DEM_SCHEMA, assetKey, versionTag);
        return null;
      }
      const mipView = new Uint8Array(buffer, payloadOffset + relOffset, byteLen);
      if (!verifySectionChecksum(header, mip + 1, mipView)) {
        await this.deleteEntry(OPFS_GLOBAL_DEM_SCHEMA, assetKey, versionTag);
        return null;
      }
      mipLevels.push(mipView);
      relOffset = align8(relOffset + byteLen);
    }

    return {
      schema: OPFS_GLOBAL_DEM_SCHEMA,
      versionTag,
      width: header.width,
      height: header.height,
      mipLevelCount: header.mipLevelCount,
      cpuDEMData,
      mipLevels,
    };
  }

  public async putGlobalDEMPyramid(
    assetKey: string,
    record: Omit<GlobalDEMPyramidRecord, 'schema'>
  ): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const expectedMipLengths = computeExpectedRG16MipByteLengths(
      record.width,
      record.height,
      record.mipLevelCount
    );
    if (record.mipLevels.length !== expectedMipLengths.length) return false;
    for (let i = 0; i < expectedMipLengths.length; i++) {
      if (record.mipLevels[i].byteLength !== expectedMipLengths[i]) return false;
    }

    const chunks = encodeEnvelopeChunks(
      {
        schema: OPFS_GLOBAL_DEM_SCHEMA,
        versionTag: record.versionTag,
        width: record.width,
        height: record.height,
        mipLevelCount: record.mipLevelCount,
        cpuDemInt16Length: record.cpuDEMData.length,
        mipByteLengths: expectedMipLengths,
      },
      [record.cpuDEMData, ...record.mipLevels]
    );
    const filename = this.buildFilename(OPFS_GLOBAL_DEM_SCHEMA, assetKey, record.versionTag);
    return this.writeBinaryChunks(filename, chunks);
  }

  public async getRegionalDEMPyramid(
    assetKey: string,
    versionTag: string
  ): Promise<RegionalDEMPyramidRecord | null> {
    if (!this.isEnabled()) return null;
    const filename = this.buildFilename(OPFS_REGIONAL_DEM_SCHEMA, assetKey, versionTag);
    const buffer = await this.readBinaryFile(filename);
    if (!buffer) return null;

    const decoded = decodeEnvelope(buffer);
    if (!decoded) {
      await this.deleteEntry(OPFS_REGIONAL_DEM_SCHEMA, assetKey, versionTag);
      return null;
    }

    const { header, payloadOffset } = decoded;
    if (
      header.schema !== OPFS_REGIONAL_DEM_SCHEMA ||
      header.versionTag !== versionTag ||
      !header.id ||
      !header.width ||
      !header.height ||
      !header.mipLevelCount ||
      !header.bounds ||
      !Array.isArray(header.mipByteLengths)
    ) {
      await this.deleteEntry(OPFS_REGIONAL_DEM_SCHEMA, assetKey, versionTag);
      return null;
    }

    const expectedMipLengths = computeExpectedRG16MipByteLengths(
      header.width,
      header.height,
      header.mipLevelCount
    );
    if (expectedMipLengths.length !== header.mipByteLengths.length) {
      await this.deleteEntry(OPFS_REGIONAL_DEM_SCHEMA, assetKey, versionTag);
      return null;
    }

    let relOffset = 0;
    const mipLevels: Uint8Array[] = [];
    for (let mip = 0; mip < expectedMipLengths.length; mip++) {
      const byteLen = expectedMipLengths[mip];
      if (header.mipByteLengths[mip] !== byteLen || payloadOffset + relOffset + byteLen > buffer.byteLength) {
        await this.deleteEntry(OPFS_REGIONAL_DEM_SCHEMA, assetKey, versionTag);
        return null;
      }
      const mipView = new Uint8Array(buffer, payloadOffset + relOffset, byteLen);
      if (!verifySectionChecksum(header, mip, mipView)) {
        await this.deleteEntry(OPFS_REGIONAL_DEM_SCHEMA, assetKey, versionTag);
        return null;
      }
      mipLevels.push(mipView);
      relOffset = align8(relOffset + byteLen);
    }

    return {
      schema: OPFS_REGIONAL_DEM_SCHEMA,
      versionTag,
      id: header.id,
      width: header.width,
      height: header.height,
      mipLevelCount: header.mipLevelCount,
      bounds: header.bounds,
      has30mGroundTruth: Boolean(header.has30mGroundTruth),
      ...(header.hasFinerLevel0 !== undefined ? { hasFinerLevel0: Boolean(header.hasFinerLevel0) } : {}),
      ...(typeof header.level0LatDegPerPx === 'number' && Number.isFinite(header.level0LatDegPerPx)
        ? { level0LatDegPerPx: header.level0LatDegPerPx }
        : {}),
      mipLevels,
    };
  }

  public async putRegionalDEMPyramid(
    assetKey: string,
    record: Omit<RegionalDEMPyramidRecord, 'schema'>
  ): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const expectedMipLengths = computeExpectedRG16MipByteLengths(
      record.width,
      record.height,
      record.mipLevelCount
    );
    if (record.mipLevels.length !== expectedMipLengths.length) return false;
    for (let i = 0; i < expectedMipLengths.length; i++) {
      if (record.mipLevels[i].byteLength !== expectedMipLengths[i]) return false;
    }

    const chunks = encodeEnvelopeChunks(
      {
        schema: OPFS_REGIONAL_DEM_SCHEMA,
        versionTag: record.versionTag,
        id: record.id,
        width: record.width,
        height: record.height,
        mipLevelCount: record.mipLevelCount,
        bounds: record.bounds,
        has30mGroundTruth: record.has30mGroundTruth,
        ...(record.hasFinerLevel0 !== undefined ? { hasFinerLevel0: record.hasFinerLevel0 } : {}),
        ...(typeof record.level0LatDegPerPx === 'number' && Number.isFinite(record.level0LatDegPerPx)
          ? { level0LatDegPerPx: record.level0LatDegPerPx }
          : {}),
        mipByteLengths: expectedMipLengths,
      },
      record.mipLevels
    );
    const filename = this.buildFilename(OPFS_REGIONAL_DEM_SCHEMA, assetKey, record.versionTag);
    return this.writeBinaryChunks(filename, chunks);
  }

  public async getWeatherNextChunk(
    assetKey: string,
    versionTag: string
  ): Promise<WeatherNextChunkRecord | null> {
    if (!this.isEnabled()) return null;
    const filename = this.buildFilename(OPFS_WEATHERNEXT_CHUNK_SCHEMA, assetKey, versionTag);
    const buffer = await this.readBinaryFile(filename);
    if (!buffer) return null;

    const decoded = decodeEnvelope(buffer);
    if (!decoded) {
      await this.deleteEntry(OPFS_WEATHERNEXT_CHUNK_SCHEMA, assetKey, versionTag);
      return null;
    }
    const { header, payloadOffset } = decoded;
    if (
      header.schema !== OPFS_WEATHERNEXT_CHUNK_SCHEMA ||
      header.versionTag !== versionTag ||
      typeof header.variable !== 'string' ||
      typeof header.hourOffset !== 'number' ||
      typeof header.channels !== 'number' ||
      typeof header.u16Length !== 'number'
    ) {
      await this.deleteEntry(OPFS_WEATHERNEXT_CHUNK_SCHEMA, assetKey, versionTag);
      return null;
    }

    const byteLen = header.u16Length * 2;
    if (payloadOffset + byteLen > buffer.byteLength) {
      await this.deleteEntry(OPFS_WEATHERNEXT_CHUNK_SCHEMA, assetKey, versionTag);
      return null;
    }
    const dataView = new Uint8Array(buffer, payloadOffset, byteLen);
    if (!verifySectionChecksum(header, 0, dataView)) {
      await this.deleteEntry(OPFS_WEATHERNEXT_CHUNK_SCHEMA, assetKey, versionTag);
      return null;
    }

    return {
      schema: OPFS_WEATHERNEXT_CHUNK_SCHEMA,
      versionTag,
      variable: header.variable,
      hourOffset: header.hourOffset,
      channels: header.channels,
      data: new Uint16Array(buffer, payloadOffset, header.u16Length),
    };
  }

  public async putWeatherNextChunk(
    assetKey: string,
    record: Omit<WeatherNextChunkRecord, 'schema'>
  ): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const chunks = encodeEnvelopeChunks(
      {
        schema: OPFS_WEATHERNEXT_CHUNK_SCHEMA,
        versionTag: record.versionTag,
        variable: record.variable,
        hourOffset: record.hourOffset,
        channels: record.channels,
        u16Length: record.data.length,
      },
      [record.data]
    );
    const filename = this.buildFilename(OPFS_WEATHERNEXT_CHUNK_SCHEMA, assetKey, record.versionTag);
    return this.writeBinaryChunks(filename, chunks);
  }

  public async getRegionalCOGTile(
    tileKey: string,
    versionTag: string
  ): Promise<RegionalCOGTileRecord | null> {
    if (!this.isEnabled()) return null;
    const filename = this.buildFilename(OPFS_REGIONAL_COG_TILE_SCHEMA, tileKey, versionTag);
    const buffer = await this.readBinaryFile(filename);
    if (!buffer) return null;

    const decoded = decodeEnvelope(buffer);
    if (!decoded) {
      await this.deleteEntry(OPFS_REGIONAL_COG_TILE_SCHEMA, tileKey, versionTag);
      return null;
    }
    const { header, payloadOffset } = decoded;
    if (
      header.schema !== OPFS_REGIONAL_COG_TILE_SCHEMA ||
      header.versionTag !== versionTag ||
      typeof header.id !== 'string' ||
      typeof header.lod !== 'number' ||
      typeof header.tileX !== 'number' ||
      typeof header.tileY !== 'number' ||
      typeof header.uvScaleX !== 'number' ||
      typeof header.uvScaleY !== 'number' ||
      header.u16Length !== 256 * 256 * 2 ||
      !header.bounds ||
      typeof header.bounds.minLon !== 'number' ||
      typeof header.bounds.maxLon !== 'number' ||
      typeof header.bounds.minLat !== 'number' ||
      typeof header.bounds.maxLat !== 'number'
    ) {
      await this.deleteEntry(OPFS_REGIONAL_COG_TILE_SCHEMA, tileKey, versionTag);
      return null;
    }

    const byteLen = header.u16Length * 2;
    if (payloadOffset + byteLen > buffer.byteLength) {
      await this.deleteEntry(OPFS_REGIONAL_COG_TILE_SCHEMA, tileKey, versionTag);
      return null;
    }
    const dataView = new Uint8Array(buffer, payloadOffset, byteLen);
    if (!verifySectionChecksum(header, 0, dataView)) {
      await this.deleteEntry(OPFS_REGIONAL_COG_TILE_SCHEMA, tileKey, versionTag);
      return null;
    }

    return {
      schema: OPFS_REGIONAL_COG_TILE_SCHEMA,
      versionTag,
      id: header.id,
      lod: header.lod,
      tileX: header.tileX,
      tileY: header.tileY,
      bounds: {
        minLon: header.bounds.minLon,
        maxLon: header.bounds.maxLon,
        minLat: header.bounds.minLat,
        maxLat: header.bounds.maxLat,
      },
      uvScaleX: header.uvScaleX,
      uvScaleY: header.uvScaleY,
      rg16Data: new Uint16Array(buffer, payloadOffset, header.u16Length),
    };
  }

  public async putRegionalCOGTile(
    tileKey: string,
    record: Omit<RegionalCOGTileRecord, 'schema'>
  ): Promise<boolean> {
    if (!this.isEnabled()) return false;
    if (!record?.rg16Data || record.rg16Data.length !== 256 * 256 * 2) return false;
    const chunks = encodeEnvelopeChunks(
      {
        schema: OPFS_REGIONAL_COG_TILE_SCHEMA,
        versionTag: record.versionTag,
        id: record.id,
        lod: record.lod,
        tileX: record.tileX,
        tileY: record.tileY,
        bounds: record.bounds,
        uvScaleX: record.uvScaleX,
        uvScaleY: record.uvScaleY,
        u16Length: record.rg16Data.length,
      },
      [record.rg16Data]
    );
    const filename = this.buildFilename(OPFS_REGIONAL_COG_TILE_SCHEMA, tileKey, record.versionTag);
    return this.writeBinaryChunks(filename, chunks);
  }

  private prefetchedGlobalDEM = new Map<
    string,
    {
      promise: Promise<{ versionTag: string; record: GlobalDEMPyramidRecord | null; elapsedMs: number }>;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  /**
   * Starts reading the OPFS global DEM pyramid in parallel with requestAdapter() / pipeline
   * creation so warm reloads upload to VRAM immediately (< 100 ms) once engine.initialize() resolves.
   */
  public prefetchGlobalDEMPyramid(
    url: string
  ): Promise<{ versionTag: string; record: GlobalDEMPyramidRecord | null; elapsedMs: number }> {
    if (!this.isEnabled()) {
      return Promise.resolve({ versionTag: `${url}|global-dem-v1`, record: null, elapsedMs: 0 });
    }
    const existing = this.prefetchedGlobalDEM.get(url);
    if (existing) return existing.promise;

    const promise = (async () => {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      let versionTag = await probeAssetVersionTag(url, 'global-dem-v1');
      if (versionTag.includes('|status-') && url.endsWith('-u16.bin')) {
        const fbUrl = url.replace('-u16.bin', '.webp');
        const fbTag = await probeAssetVersionTag(fbUrl, 'global-dem-v1');
        if (!fbTag.includes('|status-')) {
          versionTag = fbTag;
        }
      }
      const record = await this.getGlobalDEMPyramid(url, versionTag);
      const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
      return { versionTag, record, elapsedMs };
    })();

    const timer = setTimeout(() => {
      this.prefetchedGlobalDEM.delete(url);
    }, 8000);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.prefetchedGlobalDEM.set(url, { promise, timer });
    return promise;
  }

  public async consumePrefetchedGlobalDEMPyramid(
    url: string
  ): Promise<{ versionTag: string; record: GlobalDEMPyramidRecord | null; elapsedMs: number } | null> {
    const entry = this.prefetchedGlobalDEM.get(url);
    if (!entry) return null;
    this.prefetchedGlobalDEM.delete(url);
    if (entry.timer !== null) clearTimeout(entry.timer);
    return entry.promise;
  }
}

export const opfsAssetStore = new OPFSAssetStore();

/**
 * Probes lightweight HTTP HEAD headers to derive a deterministic asset version tag
 * (ETag / Content-Length + Last-Modified) without downloading multi-hundred-MB bodies.
 */
export async function probeAssetVersionTag(url: string, fallbackTag = 'v1'): Promise<string> {
  if (isVitestRuntime() || typeof fetch !== 'function') {
    return `${url}|${fallbackTag}`;
  }
  const isMock = Boolean((fetch as unknown as { mock?: unknown }).mock);
  if (isMock) {
    return `${url}|${fallbackTag}`;
  }
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return `${url}|status-${res.status}|${fallbackTag}`;
    const etag = res.headers?.get?.('etag') || '';
    const len = res.headers?.get?.('content-length') || '';
    const mtime = res.headers?.get?.('last-modified') || '';
    const stamp = [etag, len, mtime].filter(Boolean).join(':');
    return stamp ? `${url}|${stamp}` : `${url}|${fallbackTag}`;
  } catch {
    return `${url}|${fallbackTag}`;
  }
}

/**
 * Asynchronous background GPU mip-pyramid extraction for cold OPFS cache seeding.
 * Isolated here so WebGPUEngine.ts contains zero CPU staging readback tokens.
 */
export async function readbackGPUTextureRG16MipPyramid(
  device: GPUDevice | null | undefined,
  texture: GPUTexture,
  width: number,
  height: number,
  mipLevelCount: number
): Promise<Uint8Array[] | null> {
  if (
    !device ||
    typeof GPUBufferUsage === 'undefined' ||
    typeof GPUMapMode === 'undefined' ||
    typeof device.createCommandEncoder !== 'function'
  ) {
    return null;
  }

  const mipSpecs: Array<{
    mw: number;
    mh: number;
    rawRowBytes: number;
    paddedRowBytes: number;
    offset: number;
  }> = [];

  let totalBytes = 0;
  for (let mip = 0; mip < mipLevelCount; mip++) {
    const mw = Math.max(1, width >> mip);
    const mh = Math.max(1, height >> mip);
    const rawRowBytes = mw * 4;
    const paddedRowBytes = Math.ceil(rawRowBytes / 256) * 256;
    mipSpecs.push({ mw, mh, rawRowBytes, paddedRowBytes, offset: totalBytes });
    totalBytes += paddedRowBytes * mh;
  }

  if (totalBytes <= 0) return null;

  let stagingBuf: GPUBuffer | null = null;
  try {
    stagingBuf = device.createBuffer({
      label: 'opfs_rg16_mip_readback_staging',
      size: totalBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const encoder = device.createCommandEncoder({ label: 'opfs_rg16_mip_readback_encoder' });
    for (let mip = 0; mip < mipLevelCount; mip++) {
      const spec = mipSpecs[mip];
      encoder.copyTextureToBuffer(
        { texture, mipLevel: mip },
        {
          buffer: stagingBuf,
          offset: spec.offset,
          bytesPerRow: spec.paddedRowBytes,
          rowsPerImage: spec.mh,
        },
        [spec.mw, spec.mh, 1]
      );
    }
    device.queue.submit([encoder.finish()]);

    if (typeof stagingBuf.mapAsync !== 'function') {
      stagingBuf.destroy();
      return null;
    }

    await stagingBuf.mapAsync(GPUMapMode.READ);
    const mapped = stagingBuf.getMappedRange(0, totalBytes);
    const mappedU8 = new Uint8Array(mapped);

    const mipLevels: Uint8Array[] = [];
    for (let mip = 0; mip < mipLevelCount; mip++) {
      const { mh, rawRowBytes, paddedRowBytes, offset } = mipSpecs[mip];
      const compact = new Uint8Array(rawRowBytes * mh);
      if (paddedRowBytes === rawRowBytes) {
        compact.set(mappedU8.subarray(offset, offset + rawRowBytes * mh));
      } else {
        for (let y = 0; y < mh; y++) {
          const srcRow = offset + y * paddedRowBytes;
          compact.set(mappedU8.subarray(srcRow, srcRow + rawRowBytes), y * rawRowBytes);
        }
      }
      mipLevels.push(compact);
    }

    stagingBuf.unmap();
    stagingBuf.destroy();
    return mipLevels;
  } catch {
    try {
      stagingBuf?.destroy();
    } catch {}
    return null;
  }
}

