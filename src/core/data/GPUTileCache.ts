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
  public static readonly CHANNELS: number = 2;
  public static readonly BYTES_PER_ROW: number = 256 * 2 * 2; // 1024 bytes (256-byte aligned)
  public static readonly ROWS_PER_IMAGE: number = 256;
  public static readonly FLOATS_PER_SLOT_DESCRIPTOR: number = 8; // bounds (vec4<f32>) + meta (vec4<f32>)

  public readonly capacity: number;
  public readonly tileDimension: number;
  public readonly mipLevelCount: number;

  private device: GPUDevice | null = null;
  private gpuTexture: GPUTexture | null = null;
  private gpuTextureView: GPUTextureView | null = null;
  private slotViews: (GPUTextureView | null)[] = [];
  private slotDescriptorBuffer: GPUBuffer | null = null;
  private mipBindGroupLayout: GPUBindGroupLayout | null = null;
  private mipPipeline: GPURenderPipeline | null = null;
  private mipSampler: GPUSampler | null = null;

  // Zero-GC: Static mirror buffer preallocated for tile Float16 conversion ([bHalf, aHalf])
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
    this.mipLevelCount = Math.floor(Math.log2(Math.max(1, tileDimension))) + 1;

    // 256 * 256 * 2 channels = 131,072 uint16 elements (256 KB)
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
    this.mipBindGroupLayout = null;
    this.mipPipeline = null;
    this.mipSampler = null;

    // Create 64-layer 2D array texture (rg16float with 9 mip levels = 21.33 MiB)
    this.gpuTexture = device.createTexture({
      label: 'gpu_tile_cache_array',
      size: [this.tileDimension, this.tileDimension, this.capacity],
      mipLevelCount: this.mipLevelCount,
      format: 'rg16float',
      usage: (typeof GPUTextureUsage !== 'undefined'
        ? (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT)
        : (4 | 8 | 16)),
    });

    this.gpuTextureView = this.gpuTexture.createView({
      dimension: '2d-array',
    });

    for (let i = 0; i < this.capacity; i++) {
      this.slotViews[i] = this.gpuTexture.createView({
        dimension: '2d',
        baseArrayLayer: i,
        arrayLayerCount: 1,
        baseMipLevel: 0,
        mipLevelCount: 1,
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
    elevData: Float32Array,
    skipSync: boolean = false
  ): boolean {
    if (!this.device || !this.gpuTexture) return false;
    if (slotIndex < 0 || slotIndex >= this.capacity) return false;

    const count = this.tileDimension * this.tileDimension;
    const f16 = this.f16UploadBuffer;

    // Elevation decoding & encoding parity (Full range [-10924m .. +8848m])
    // Compacted rg16float layout: .r = bNorm (coastal/fjord confidence mask), .g = signed elevMeters in [-10924m .. +8848m]
    //   0.0 = sea-level water (<= +0.02m, covering 0.00m AWS Terrarium bays/estuaries & negative depths)
    //   0.5 = neutral intertidal (+0.15m)
    //   1.0 = coastal land (>= +1.50m)
    for (let i = 0; i < count; i++) {
      const elev = elevData[i];
      const bNorm = elev > 0.15
        ? 0.5 + 0.5 * Math.max(0.0, Math.min(1.0, (elev - 0.15) / 1.35))
        : 0.5 * (1.0 - Math.max(0.0, Math.min(1.0, (0.15 - elev) / 0.13)));
      const clampedElev = Math.max(-10924.0, Math.min(8848.0, elev));

      const baseIdx = i * 2;
      f16[baseIdx + 0] = encodeFloat16(bNorm);
      f16[baseIdx + 1] = encodeFloat16(clampedElev);
    }

    this.device.queue.writeTexture(
      {
        texture: this.gpuTexture,
        mipLevel: 0,
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
    this.generateSlotMips(slotIndex);

    const slot = this.slots[slotIndex];
    if (slot.isAllocated) {
      slot.hasData = true;
    }
    this.totalUploads++;
    if (!skipSync) {
      this.syncSlotDescriptorBuffer();
    }
    return true;
  }

  /**
   * Uploads a worker-prepared Float16 rg16float buffer ([bHalf, elevHalf]) to mip 0
   * and generates mips 1..8 via Phase 2's generateSlotMips GPU pyramid.
   */
  public uploadPackedRG16Tile(
    slotIndex: number,
    f16Data: Uint16Array | ArrayBuffer,
    skipSync: boolean = false
  ): boolean {
    if (!this.device || !this.gpuTexture) return false;
    if (slotIndex < 0 || slotIndex >= this.capacity) return false;
    const expectedBytes = GPUTileCache.BYTES_PER_ROW * GPUTileCache.ROWS_PER_IMAGE;
    const buf = f16Data instanceof ArrayBuffer ? f16Data : f16Data.buffer;
    const byteOffset = f16Data instanceof ArrayBuffer ? 0 : f16Data.byteOffset;
    if (buf.byteLength - byteOffset < expectedBytes) return false;

    this.device.queue.writeTexture(
      {
        texture: this.gpuTexture,
        mipLevel: 0,
        origin: { x: 0, y: 0, z: slotIndex },
      },
      buf,
      {
        bytesPerRow: GPUTileCache.BYTES_PER_ROW,
        rowsPerImage: GPUTileCache.ROWS_PER_IMAGE,
        offset: byteOffset,
      },
      [this.tileDimension, this.tileDimension, 1]
    );
    this.generateSlotMips(slotIndex);

    const slot = this.slots[slotIndex];
    if (slot.isAllocated) {
      slot.hasData = true;
    }
    this.totalUploads++;
    if (!skipSync) {
      this.syncSlotDescriptorBuffer();
    }
    return true;
  }

  /**
   * Generates mip levels 1..(mipLevelCount - 1) for a single array layer via Core-WebGPU RENDER_ATTACHMENT fragment blits.
   */
  public generateSlotMips(slotIndex: number): void {
    const dev = this.device;
    const tex = this.gpuTexture;
    if (
      !dev ||
      !tex ||
      this.mipLevelCount <= 1 ||
      slotIndex < 0 ||
      slotIndex >= this.capacity ||
      typeof dev.createRenderPipeline !== 'function' ||
      typeof dev.createBindGroupLayout !== 'function' ||
      typeof dev.createPipelineLayout !== 'function' ||
      typeof dev.createCommandEncoder !== 'function' ||
      typeof dev.createBindGroup !== 'function' ||
      typeof dev.createSampler !== 'function' ||
      typeof dev.createShaderModule !== 'function' ||
      typeof dev.queue?.submit !== 'function'
    ) {
      return;
    }

    if (!this.mipPipeline || !this.mipBindGroupLayout || !this.mipSampler) {
      const module = dev.createShaderModule({
        label: 'gpu_tile_cache_rg16float_mip_blit',
        code: `
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var out: VSOut;
  var p = vec2<f32>(-1.0, -1.0);
  if (vi == 1u) { p = vec2<f32>(3.0, -1.0); }
  else if (vi == 2u) { p = vec2<f32>(-1.0, 3.0); }
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
  return out;
}
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
fn roundF32ToExactF16(val: f32) -> f32 {
  let clamped = clamp(val, -65504.0, 65504.0);
  let bits = bitcast<u32>(clamped);
  let absBits = bits & 0x7fffffffu;
  if (absBits == 0u) { return clamped; }
  let exp32 = (absBits >> 23u) & 0xffu;
  if (exp32 <= 112u) {
    if (exp32 < 102u) { return bitcast<f32>(bits & 0x80000000u); }
    return round(clamped * 16777216.0) * (1.0 / 16777216.0);
  }
  let bias = 0x0fffu + ((bits >> 13u) & 1u);
  return bitcast<f32>((bits + bias) & 0xffffe000u);
}
@fragment fn fs(in: VSOut) -> @location(0) vec2<f32> {
  let c = vec2<i32>(in.pos.xy) * 2;
  let maxC = vec2<i32>(textureDimensions(srcTex, 0)) - vec2<i32>(1);
  let p00 = textureLoad(srcTex, min(c, maxC), 0).rg;
  let p10 = textureLoad(srcTex, min(c + vec2<i32>(1, 0), maxC), 0).rg;
  let p01 = textureLoad(srcTex, min(c + vec2<i32>(0, 1), maxC), 0).rg;
  let p11 = textureLoad(srcTex, min(c + vec2<i32>(1, 1), maxC), 0).rg;
  let mean = (p00 + p10 + p01 + p11) * 0.25;
  let unusedSamp = textureSampleLevel(srcTex, samp, in.uv, 0.0).x * 0.0;
  return vec2<f32>(roundF32ToExactF16(mean.x + unusedSamp), roundF32ToExactF16(mean.y));
}
`,
      });
      this.mipBindGroupLayout = dev.createBindGroupLayout({
        label: 'gpu_tile_cache_rg16float_mip_bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      this.mipPipeline = dev.createRenderPipeline({
        label: 'gpu_tile_cache_rg16float_mip_pipeline',
        layout: dev.createPipelineLayout({
          label: 'gpu_tile_cache_rg16float_mip_pl',
          bindGroupLayouts: [this.mipBindGroupLayout],
        }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rg16float' }] },
        primitive: { topology: 'triangle-list' },
      });
      this.mipSampler = dev.createSampler({
        label: 'gpu_tile_cache_rg16float_mip_sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
    }

    const layout = this.mipBindGroupLayout;
    const encoder = dev.createCommandEncoder({ label: `gpu_tile_cache_mips_slot_${slotIndex}` });
    for (let mip = 1; mip < this.mipLevelCount; mip++) {
      const srcView = tex.createView({
        dimension: '2d',
        baseArrayLayer: slotIndex,
        arrayLayerCount: 1,
        baseMipLevel: mip - 1,
        mipLevelCount: 1,
      });
      const dstView = tex.createView({
        dimension: '2d',
        baseArrayLayer: slotIndex,
        arrayLayerCount: 1,
        baseMipLevel: mip,
        mipLevelCount: 1,
      });
      const bg = dev.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.mipSampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: dstView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      pass.setPipeline(this.mipPipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }
    dev.queue.submit([encoder.finish()]);
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
    const anchorPrefix = anchorSlot && anchorSlot.key.includes(':')
      ? anchorSlot.key.slice(0, anchorSlot.key.indexOf(':'))
      : '';
    const isNearAnchor = (s: GPUTileSlot): boolean => {
      if (!anchorSlot) return true;
      const sPrefix = s.key.includes(':') ? s.key.slice(0, s.key.indexOf(':')) : '';
      if (sPrefix !== anchorPrefix) return false;
      if (sPrefix === 'terrarium') {
        if (s.lod !== anchorSlot.lod) return false;
        if (anchorSlot.lastUsed - s.lastUsed >= 49) return false;
        return Math.abs(s.x - anchorSlot.x) <= 6 && Math.abs(s.y - anchorSlot.y) <= 6;
      }
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
      const inActiveCluster = isNearAnchor(s) && s.lod === topClusterLod;
      if (inActiveCluster) {
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
        if (inActiveCluster && (!isNearAnchor(other) || other.lod !== topClusterLod)) continue;
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
    this.mipBindGroupLayout = null;
    this.mipPipeline = null;
    this.mipSampler = null;
    this.device = null;
  }
}
