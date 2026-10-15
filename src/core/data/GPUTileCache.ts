// ============================================================================
// File: src/core/data/GPUTileCache.ts
// Architecture: 64-Slot Texture2DArray GPU Tile Cache with Zero-GC LRU Eviction
// Description: Manages a 64-slot 256x256 Float16 (rgba16float) GPUTexture array
//              for high-resolution Cloud-Optimized GeoTIFF (COG) elevation tiles.
//              Guarantees zero per-frame typed array allocation, LRU slot reuse,
//              and direct device.queue.writeTexture subresource updates.
// ============================================================================

import { encodeFloat16 } from '../math/float16';

export interface TileBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

export interface GPUTileSlot {
  slotIndex: number;
  key: string;
  bounds: TileBounds;
  lod: number;
  x: number;
  y: number;
  uvScaleX: number;
  uvScaleY: number;
  lastUsed: number;
  isAllocated: boolean;
  hasData: boolean;
}

export interface GPUTileCacheStats {
  capacity: number;
  allocated: number;
  hits: number;
  misses: number;
  evictions: number;
  totalUploads: number;
}

export class GPUTileCache {
  public static readonly DEFAULT_CAPACITY: number = 64;
  public static readonly TILE_DIMENSION: number = 256;
  public static readonly CHANNELS: number = 4;
  public static readonly BYTES_PER_ROW: number = 256 * 4 * 2; // 2048 bytes (256-byte aligned)
  public static readonly ROWS_PER_IMAGE: number = 256;
  public static readonly FLOATS_PER_SLOT_DESCRIPTOR: number = 8; // bounds (vec4<f32>) + meta (vec4<f32>)

  public readonly capacity: number;
  public readonly tileDimension: number;

  private device: GPUDevice | null = null;
  private gpuTexture: GPUTexture | null = null;
  private gpuTextureView: GPUTextureView | null = null;
  private slotViews: (GPUTextureView | null)[] = [];
  private slotDescriptorBuffer: GPUBuffer | null = null;

  // Zero-GC: Static mirror buffer preallocated for tile Float16 conversion
  private readonly f16UploadBuffer: Uint16Array;

  // Zero-GC: Static mirror buffer preallocated for 64-slot shader descriptor table (64 * 8 floats = 2048 bytes)
  private readonly slotDescriptorData: Float32Array;
  private readonly sortedSlotIndices: Int32Array;
  private activeUploadedSlotCount: number = 0;
  private activeClusterSlotCount: number = 0;
  private readonly activeClusterBounds: Float32Array = new Float32Array(4);

  // LRU State
  private readonly slots: GPUTileSlot[];
  private readonly keyToSlot: Map<string, number> = new Map();
  private accessCounter: number = 0;

  // Telemetry metrics
  private hits: number = 0;
  private misses: number = 0;
  private evictions: number = 0;
  private totalUploads: number = 0;

  constructor(capacity: number = GPUTileCache.DEFAULT_CAPACITY, tileDimension: number = GPUTileCache.TILE_DIMENSION) {
    this.capacity = capacity;
    this.tileDimension = tileDimension;

    // 256 * 256 * 4 channels = 262,144 uint16 elements (512 KB)
    this.f16UploadBuffer = new Uint16Array(this.tileDimension * this.tileDimension * GPUTileCache.CHANNELS);
    this.slotDescriptorData = new Float32Array(this.capacity * GPUTileCache.FLOATS_PER_SLOT_DESCRIPTOR);
    this.sortedSlotIndices = new Int32Array(this.capacity);

    this.slots = Array.from({ length: this.capacity }, (_, i) => ({
      slotIndex: i,
      key: '',
      bounds: { minLon: 0, maxLon: 0, minLat: 0, maxLat: 0 },
      lod: 0,
      x: 0,
      y: 0,
      uvScaleX: 1.0,
      uvScaleY: 1.0,
      lastUsed: 0,
      isAllocated: false,
      hasData: false,
    }));

    this.slotViews = new Array(this.capacity).fill(null);
  }

  public initialize(device: GPUDevice): void {
    this.device = device;

    // Create 64-layer 2D array texture
    this.gpuTexture = device.createTexture({
      label: 'gpu_tile_cache_array',
      size: [this.tileDimension, this.tileDimension, this.capacity],
      mipLevelCount: 1,
      format: 'rgba16float',
      usage: (typeof GPUTextureUsage !== 'undefined'
        ? (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST)
        : (4 | 8)),
    });

    this.gpuTextureView = this.gpuTexture.createView({
      dimension: '2d-array',
    });

    for (let i = 0; i < this.capacity; i++) {
      this.slotViews[i] = this.gpuTexture.createView({
        dimension: '2d',
        baseArrayLayer: i,
        arrayLayerCount: 1,
      });
    }
  }

  public hasTile(key: string): boolean {
    return this.keyToSlot.has(key);
  }

  public getSlot(key: string): number {
    const slotIdx = this.keyToSlot.get(key);
    if (slotIdx !== undefined) {
      this.hits++;
      this.slots[slotIdx].lastUsed = ++this.accessCounter;
      return slotIdx;
    }
    this.misses++;
    return -1;
  }

  public getSlotMetadata(slotIndex: number): GPUTileSlot | null {
    if (slotIndex >= 0 && slotIndex < this.capacity) {
      return this.slots[slotIndex];
    }
    return null;
  }

  public allocateSlot(
    key: string,
    bounds: TileBounds,
    lod: number = 0,
    x: number = 0,
    y: number = 0,
    uvScaleX: number = 1.0,
    uvScaleY: number = 1.0
  ): number {
    // 1. If key already exists in cache, touch and return existing slot
    const existing = this.keyToSlot.get(key);
    if (existing !== undefined) {
      const slot = this.slots[existing];
      slot.bounds = bounds;
      slot.lod = lod;
      slot.x = x;
      slot.y = y;
      slot.uvScaleX = uvScaleX;
      slot.uvScaleY = uvScaleY;
      slot.lastUsed = ++this.accessCounter;
      return existing;
    }

    // 2. Search for unallocated slot
    for (let i = 0; i < this.capacity; i++) {
      if (!this.slots[i].isAllocated) {
        const slot = this.slots[i];
        slot.isAllocated = true;
        slot.hasData = false;
        slot.key = key;
        slot.bounds = bounds;
        slot.lod = lod;
        slot.x = x;
        slot.y = y;
        slot.uvScaleX = uvScaleX;
        slot.uvScaleY = uvScaleY;
        slot.lastUsed = ++this.accessCounter;
        this.keyToSlot.set(key, i);
        return i;
      }
    }

    // 3. LRU Eviction: Find slot with minimum lastUsed timestamp
    let lruIndex = 0;
    let minLastUsed = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      if (this.slots[i].lastUsed < minLastUsed) {
        minLastUsed = this.slots[i].lastUsed;
        lruIndex = i;
      }
    }

    const evictedSlot = this.slots[lruIndex];
    this.keyToSlot.delete(evictedSlot.key);
    this.evictions++;

    evictedSlot.key = key;
    evictedSlot.bounds = bounds;
    evictedSlot.lod = lod;
    evictedSlot.x = x;
    evictedSlot.y = y;
    evictedSlot.uvScaleX = uvScaleX;
    evictedSlot.uvScaleY = uvScaleY;
    evictedSlot.lastUsed = ++this.accessCounter;
    evictedSlot.hasData = false;
    this.keyToSlot.set(key, lruIndex);

    return lruIndex;
  }

  public uploadElevationTile(
    slotIndex: number,
    elevData: Float32Array
  ): boolean {
    if (!this.device || !this.gpuTexture) return false;
    if (slotIndex < 0 || slotIndex >= this.capacity) return false;

    const count = this.tileDimension * this.tileDimension;
    const f16 = this.f16UploadBuffer;

    // Elevation decoding & encoding parity (Full range [-10924m .. +8848m])
    // Channel B encodes continuous shoreline land mask ramp [-15m .. +15m] -> [0.0 .. 1.0]
    for (let i = 0; i < count; i++) {
      const elev = elevData[i];
      const rNorm = Math.max(0.0, Math.min(1.0, elev / 8848.0));
      const gNorm = Math.max(0.0, Math.min(1.0, -elev / 10924.0));
      const bNorm = Math.max(0.0, Math.min(1.0, (elev + 15.0) / 30.0));
      const aNorm = Math.max(0.0, Math.min(1.0, (elev + 10924.0) / 19772.0));

      const baseIdx = i * 4;
      f16[baseIdx + 0] = encodeFloat16(rNorm);
      f16[baseIdx + 1] = encodeFloat16(gNorm);
      f16[baseIdx + 2] = encodeFloat16(bNorm);
      f16[baseIdx + 3] = encodeFloat16(aNorm);
    }

    this.device.queue.writeTexture(
      {
        texture: this.gpuTexture,
        origin: { x: 0, y: 0, z: slotIndex },
      },
      f16.buffer,
      {
        bytesPerRow: GPUTileCache.BYTES_PER_ROW,
        rowsPerImage: GPUTileCache.ROWS_PER_IMAGE,
        offset: 0,
      },
      [this.tileDimension, this.tileDimension, 1]
    );

    const slot = this.slots[slotIndex];
    if (slot.isAllocated) {
      slot.hasData = true;
    }
    this.totalUploads++;
    this.syncSlotDescriptorBuffer();
    return true;
  }

  /**
   * Rebuilds the zero-GC 64-slot descriptor table sorted by descending LOD and
   * computes the 4-bit cardinal neighbor adjacency mask (1=W, 2=S, 4=E, 8=N) so
   * adjacent 256x256 tiles stitch with zero internal feather seams.
   */
  public syncSlotDescriptorBuffer(_device?: GPUDevice): void {
    let count = 0;
    let anchorSlot: GPUTileSlot | null = null;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s.isAllocated && s.hasData && s.bounds.maxLon > s.bounds.minLon && s.bounds.maxLat > s.bounds.minLat) {
        this.sortedSlotIndices[count++] = i;
        if (!anchorSlot || s.lastUsed > anchorSlot.lastUsed) {
          anchorSlot = s;
        }
      }
    }

    const anchorLon = anchorSlot ? 0.5 * (anchorSlot.bounds.minLon + anchorSlot.bounds.maxLon) : 0;
    const anchorLat = anchorSlot ? 0.5 * (anchorSlot.bounds.minLat + anchorSlot.bounds.maxLat) : 0;
    const isNearAnchor = (s: GPUTileSlot): boolean => {
      if (!anchorSlot) return true;
      const cLon = 0.5 * (s.bounds.minLon + s.bounds.maxLon);
      const cLat = 0.5 * (s.bounds.minLat + s.bounds.maxLat);
      return Math.abs(cLon - anchorLon) <= 6.0 && Math.abs(cLat - anchorLat) <= 6.0;
    };

    // Insertion sort active indices: active geographic cluster first, then descending LOD, then descending lastUsed
    for (let i = 1; i < count; i++) {
      const curIdx = this.sortedSlotIndices[i];
      const curSlot = this.slots[curIdx];
      const curCluster = isNearAnchor(curSlot) ? 1 : 0;
      let j = i - 1;
      while (j >= 0) {
        const prevSlot = this.slots[this.sortedSlotIndices[j]];
        const prevCluster = isNearAnchor(prevSlot) ? 1 : 0;
        if (
          prevCluster < curCluster ||
          (prevCluster === curCluster &&
            (prevSlot.lod < curSlot.lod ||
              (prevSlot.lod === curSlot.lod &&
                (Math.abs(prevSlot.bounds.maxLat - curSlot.bounds.maxLat) > 1e-4
                  ? prevSlot.bounds.maxLat < curSlot.bounds.maxLat
                  : prevSlot.bounds.minLon > curSlot.bounds.minLon))))
        ) {
          this.sortedSlotIndices[j + 1] = this.sortedSlotIndices[j];
          j--;
        } else {
          break;
        }
      }
      this.sortedSlotIndices[j + 1] = curIdx;
    }

    this.activeUploadedSlotCount = count;
    this.slotDescriptorData.fill(0);
    this.activeClusterBounds.fill(0);

    let clusterCount = 0;
    let cMinLon = Infinity;
    let cMinLat = Infinity;
    let cMaxLon = -Infinity;
    let cMaxLat = -Infinity;
    const topClusterLod = count > 0 ? this.slots[this.sortedSlotIndices[0]].lod : -1;

    const eps = 1e-3;
    for (let rank = 0; rank < count; rank++) {
      const s = this.slots[this.sortedSlotIndices[rank]];
      const b = s.bounds;
      if (isNearAnchor(s) && s.lod === topClusterLod) {
        clusterCount++;
        if (b.minLon < cMinLon) cMinLon = b.minLon;
        if (b.minLat < cMinLat) cMinLat = b.minLat;
        if (b.maxLon > cMaxLon) cMaxLon = b.maxLon;
        if (b.maxLat > cMaxLat) cMaxLat = b.maxLat;
      }
      let edgeMask = 0;

      // Check whether any other active uploaded tile at equal or higher LOD shares each cardinal border
      for (let otherRank = 0; otherRank < count; otherRank++) {
        if (otherRank === rank) continue;
        const other = this.slots[this.sortedSlotIndices[otherRank]];
        if (other.lod < s.lod) continue;
        const ob = other.bounds;
        const latOverlap = Math.min(b.maxLat, ob.maxLat) - Math.max(b.minLat, ob.minLat) > eps;
        const lonOverlap = Math.min(b.maxLon, ob.maxLon) - Math.max(b.minLon, ob.minLon) > eps;

        if (latOverlap) {
          if (ob.maxLon >= b.minLon - eps && ob.minLon < b.minLon - eps) edgeMask |= 1; // West neighbor
          if (ob.minLon <= b.maxLon + eps && ob.maxLon > b.maxLon + eps) edgeMask |= 4; // East neighbor
        }
        if (lonOverlap) {
          if (ob.maxLat >= b.minLat - eps && ob.minLat < b.minLat - eps) edgeMask |= 2; // South neighbor
          if (ob.minLat <= b.maxLat + eps && ob.maxLat > b.maxLat + eps) edgeMask |= 8; // North neighbor
        }
      }

      const base = rank * GPUTileCache.FLOATS_PER_SLOT_DESCRIPTOR;
      this.slotDescriptorData[base + 0] = b.minLon;
      this.slotDescriptorData[base + 1] = b.minLat;
      this.slotDescriptorData[base + 2] = b.maxLon;
      this.slotDescriptorData[base + 3] = b.maxLat;
      this.slotDescriptorData[base + 4] = (s.lod & 63) + edgeMask * 64.0;
      this.slotDescriptorData[base + 5] = s.slotIndex;
      this.slotDescriptorData[base + 6] = s.uvScaleX;
      this.slotDescriptorData[base + 7] = s.uvScaleY;
    }

    this.activeClusterSlotCount = clusterCount;
    if (clusterCount > 0 && Number.isFinite(cMinLon)) {
      this.activeClusterBounds[0] = cMinLon;
      this.activeClusterBounds[1] = cMinLat;
      this.activeClusterBounds[2] = cMaxLon;
      this.activeClusterBounds[3] = cMaxLat;
    }

    if (this.device && typeof this.device.createBuffer === 'function' && this.device.queue && typeof this.device.queue.writeBuffer === 'function') {
      if (!this.slotDescriptorBuffer && count > 0) {
        this.slotDescriptorBuffer = this.device.createBuffer({
          label: 'gpu_tile_cache_slot_descriptors',
          size: this.slotDescriptorData.byteLength,
          usage: (typeof GPUBufferUsage !== 'undefined'
            ? (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
            : (128 | 8)),
        });
      }
      if (this.slotDescriptorBuffer) {
        this.device.queue.writeBuffer(this.slotDescriptorBuffer, 0, this.slotDescriptorData.buffer, this.slotDescriptorData.byteOffset, this.slotDescriptorData.byteLength);
      }
    }
  }

  public getSlotDescriptorBuffer(): GPUBuffer | null {
    return this.slotDescriptorBuffer;
  }

  public getSlotDescriptorData(): Float32Array {
    return this.slotDescriptorData;
  }

  public getActiveUploadedSlotCount(): number {
    return this.activeUploadedSlotCount;
  }

  public getActiveClusterSlotCount(): number {
    return this.activeClusterSlotCount;
  }

  public getActiveClusterBounds(): Float32Array {
    return this.activeClusterBounds;
  }

  public getTexture(): GPUTexture | null {
    return this.gpuTexture;
  }

  public getArrayView(): GPUTextureView | null {
    return this.gpuTextureView;
  }

  public getSlotView(slotIndex: number): GPUTextureView | null {
    if (slotIndex >= 0 && slotIndex < this.capacity) {
      return this.slotViews[slotIndex];
    }
    return null;
  }

  public getStats(): GPUTileCacheStats {
    let allocated = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.slots[i].isAllocated) allocated++;
    }
    return {
      capacity: this.capacity,
      allocated,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      totalUploads: this.totalUploads,
    };
  }

  public clear(): void {
    this.keyToSlot.clear();
    for (let i = 0; i < this.capacity; i++) {
      this.slots[i].isAllocated = false;
      this.slots[i].hasData = false;
      this.slots[i].key = '';
      this.slots[i].lastUsed = 0;
      this.slots[i].uvScaleX = 1.0;
      this.slots[i].uvScaleY = 1.0;
    }
    this.activeUploadedSlotCount = 0;
    this.slotDescriptorData.fill(0);
    if (this.slotDescriptorBuffer && this.device?.queue?.writeBuffer) {
      try {
        this.device.queue.writeBuffer(this.slotDescriptorBuffer, 0, this.slotDescriptorData.buffer, this.slotDescriptorData.byteOffset, this.slotDescriptorData.byteLength);
      } catch {}
    }
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.totalUploads = 0;
    this.accessCounter = 0;
  }

  public destroy(): void {
    this.clear();
    if (this.slotDescriptorBuffer) {
      try {
        this.slotDescriptorBuffer.destroy();
      } catch {}
      this.slotDescriptorBuffer = null;
    }
    if (this.gpuTexture) {
      try {
        this.gpuTexture.destroy();
      } catch {}
      this.gpuTexture = null;
      this.gpuTextureView = null;
      this.slotViews.fill(null);
    }
    this.device = null;
  }
}
