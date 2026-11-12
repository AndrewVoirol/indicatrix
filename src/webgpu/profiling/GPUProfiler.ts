// ============================================================================
// File: src/webgpu/profiling/GPUProfiler.ts
// Description: Non-blocking asynchronous triple-buffered GPUQuerySet timestamp profiler
// Architecture: 32-query capacity (16 pass slots), zero-GC readback, TBDR union span & exclusive tail telemetry
// ============================================================================

export const PROFILER_QUERY_CAPACITY = 32;
export const QUERY_BYTES = 8; // uint64
export const PROFILER_BUFFER_SIZE = PROFILER_QUERY_CAPACITY * QUERY_BYTES; // 256 bytes
export const PROFILER_SLOT_COUNT = PROFILER_QUERY_CAPACITY / 2; // 16 pass slots

export enum ProfilerPassSlot {
  Compute = 0,            // Queries 0, 1: Particle Compute Simulation (physics_sim.wgsl)
  SwissRelief = 1,        // Queries 2, 3: Consolidated Scene / Swiss Relief Shading
  Lines = 2,              // Queries 4, 5: Delaunay Wireframe Lines
  Ribbons = 3,            // Queries 6, 7: Vector Line Ribbons
  Contours = 4,           // Queries 8, 9: Isoline Contours
  Points = 5,             // Queries 10, 11: Point Sprites
  Reserved1 = 6,          // Queries 12, 13: Volumetric Clouds Raymarch (0.5x)
  Reserved2 = 7,          // Queries 14, 15: Paper Substrate Haptics & Composition
  WindCompute = 8,        // Queries 16, 17: Wind Particle Compute (wind_particles.wgsl)
  HorizonCompute = 9,     // Queries 18, 19: Horizon Occlusion Compute (horizon_occlusion.wgsl)
  CloudAdvection = 10,    // Queries 20, 21: Cloud Advection Compute (cloud_advection.wgsl)
  DrainageCompute = 11,   // Queries 22, 23: Drainage Synthesis Compute (drainage_accumulation.wgsl)
  CDLODCompute = 12,      // Queries 24, 25: CDLOD Culling Compute (culling.wgsl)
  CloudProxy = 13,        // Queries 26, 27: Cloud Proxy Front + Back Depth Passes
  VolumetricUpsample = 14,// Queries 28, 29: Volumetric Clouds Bilateral Upsample (1.0x)
  PostCloudOverlay = 15,  // Queries 30, 31: Post-Cloud Toponymy & Jet Stream Pass
}

export const PROFILER_PASS_NAMES: readonly string[] = [
  'Particle Compute',
  'Swiss Relief Shading',
  'Delaunay Wireframe Lines',
  'Vector Line Ribbons',
  'Isoline Contours',
  'Point Sprites',
  'Volumetric Clouds Raymarch',
  'Paper Substrate Haptics',
  'Wind Particle Compute',
  'Horizon Occlusion Compute',
  'Cloud Advection Compute',
  'Drainage Synthesis Compute',
  'CDLOD Culling Compute',
  'Cloud Proxy Depth',
  'Volumetric Clouds Upsample',
  'Post-Cloud Toponymy & Jet',
];

export interface KernelProfileReport {
  passName: string;
  gpuTimeNs: bigint;
  gpuTimeUs: number;
  gpuTimeMs: number;
  exclusiveEndDeltaMs: number;
}

export interface FrameProfileReport {
  timestamp: number;
  computeMs: number;
  renderMs: number;
  reliefMs: number;
  linesMs: number;
  ribbonsMs: number;
  contoursMs: number;
  pointsMs: number;
  volumetricMs?: number;
  substrateMs?: number;
  particleComputeMs?: number;
  windComputeMs?: number;
  horizonComputeMs?: number;
  cloudAdvectionMs?: number;
  drainageComputeMs?: number;
  cdlodComputeMs?: number;
  cloudProxyMs?: number;
  volumetricUpsampleMs?: number;
  postCloudOverlayMs?: number;
  totalGpuMs: number;
  unionSpanMs: number;
  exclusiveEndDeltaMs: Record<string, number>;
  frameIndex?: number;
}

export class GPUProfiler {
  private device: GPUDevice;
  private querySet: GPUQuerySet | null = null;
  private resolveBuffer: GPUBuffer | null = null;
  private ringBuffers: GPUBuffer[] = [];
  private ringSlotStates: ('IDLE' | 'PENDING_GPU' | 'PENDING_MAP' | 'MAPPED')[] = [];
  private ringSlotMapPromises: (Promise<void> | null)[] = [];
  private ringIndex: number = 0;
  private readonly ringSize: number = 3; // Triple buffering
  private supported: boolean = false;
  private enabled: boolean = false;
  private latestReport: FrameProfileReport | null = null;
  private latestKernelReports: KernelProfileReport[] = [];
  private activePassesMask: number = 0;
  private ringSlotPassMasks: number[] = [];
  private readonly ringSlotFrames = new Int32Array(3);
  private reportListener: ((report: FrameProfileReport, kernels: KernelProfileReport[]) => void) | null = null;

  // Pre-allocated zero-GC scratch memory & pass timestamp descriptors
  private readonly scratchBuffer = new ArrayBuffer(PROFILER_BUFFER_SIZE);
  private readonly scratchBytes = new Uint8Array(this.scratchBuffer);
  private readonly scratchTimestamps: BigUint64Array;
  private readonly scratchActiveSlots = new Int32Array(PROFILER_SLOT_COUNT);
  private readonly scratchDeltaNs: BigUint64Array;
  private readonly scratchExclusiveNs: BigUint64Array;
  private passTimestampDescriptors: GPUComputePassTimestampWrites[] = [];
  private passBeginDescriptors: GPUComputePassTimestampWrites[] = [];
  private passEndDescriptors: GPUComputePassTimestampWrites[] = [];

  constructor(device: GPUDevice) {
    this.device = device;
    this.scratchTimestamps = new BigUint64Array(this.scratchBuffer);
    this.scratchDeltaNs = new BigUint64Array(PROFILER_SLOT_COUNT);
    this.scratchExclusiveNs = new BigUint64Array(PROFILER_SLOT_COUNT);

    if (device?.features?.has && device.features.has('timestamp-query') && typeof device.createQuerySet === 'function') {
      const bufferUsage = typeof GPUBufferUsage !== 'undefined'
        ? GPUBufferUsage
        : {
            MAP_READ: 0x0001,
            COPY_SRC: 0x0004,
            COPY_DST: 0x0008,
            QUERY_RESOLVE: 0x0200,
          };

      this.supported = true;
      this.enabled = true;
      this.querySet = device.createQuerySet({
        type: 'timestamp',
        count: PROFILER_QUERY_CAPACITY,
      });

      this.resolveBuffer = device.createBuffer({
        size: PROFILER_BUFFER_SIZE,
        usage: bufferUsage.QUERY_RESOLVE | bufferUsage.COPY_SRC,
      });

      for (let i = 0; i < this.ringSize; i++) {
        this.ringBuffers.push(
          device.createBuffer({
            size: PROFILER_BUFFER_SIZE,
            usage: bufferUsage.MAP_READ | bufferUsage.COPY_DST,
          })
        );
        this.ringSlotStates.push('IDLE');
        this.ringSlotMapPromises.push(null);
        this.ringSlotPassMasks.push(0);
        this.ringSlotFrames[i] = 0;
      }

      for (let slot = 0; slot < PROFILER_SLOT_COUNT; slot++) {
        this.passTimestampDescriptors.push({
          querySet: this.querySet,
          beginningOfPassWriteIndex: slot * 2,
          endOfPassWriteIndex: slot * 2 + 1,
        });
        this.passBeginDescriptors.push({
          querySet: this.querySet,
          beginningOfPassWriteIndex: slot * 2,
        });
        this.passEndDescriptors.push({
          querySet: this.querySet,
          endOfPassWriteIndex: slot * 2 + 1,
        });
      }
    }
  }

  public get isSupported(): boolean {
    return this.supported;
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public get currentFrameIndex(): number {
    return this.ringIndex;
  }

  public enable(): void {
    if (this.supported && this.querySet) {
      this.enabled = true;
    }
  }

  public disable(): void {
    this.enabled = false;
    this.activePassesMask = 0;
  }

  public setReportListener(
    listener: ((report: FrameProfileReport, kernels: KernelProfileReport[]) => void) | null
  ): void {
    this.reportListener = listener;
  }

  public getComputeTimestampWrites(passIndex: number = 0): GPUComputePassTimestampWrites | undefined {
    return this.getPassTimestampWrites(passIndex);
  }

  public getRenderTimestampWrites(passIndex: number = 0): GPURenderPassTimestampWrites | undefined {
    const slot = passIndex === 0 ? ProfilerPassSlot.SwissRelief : passIndex;
    return this.getPassTimestampWrites(slot);
  }

  public getPassTimestampWrites(slot: number | ProfilerPassSlot): GPUComputePassTimestampWrites | undefined {
    if (!this.enabled || !this.querySet) return undefined;
    if (slot < 0 || slot >= PROFILER_SLOT_COUNT) return undefined;
    this.activePassesMask |= (1 << slot);
    return this.passTimestampDescriptors[slot];
  }

  public getPassBeginTimestampWrites(slot: number | ProfilerPassSlot): GPUComputePassTimestampWrites | undefined {
    if (!this.enabled || !this.querySet) return undefined;
    if (slot < 0 || slot >= PROFILER_SLOT_COUNT) return undefined;
    this.activePassesMask |= (1 << slot);
    return this.passBeginDescriptors[slot];
  }

  public getPassEndTimestampWrites(slot: number | ProfilerPassSlot): GPUComputePassTimestampWrites | undefined {
    if (!this.enabled || !this.querySet) return undefined;
    if (slot < 0 || slot >= PROFILER_SLOT_COUNT) return undefined;
    this.activePassesMask |= (1 << slot);
    return this.passEndDescriptors[slot];
  }

  public getTimestampWrites(): GPUComputePassTimestampWrites | undefined {
    return this.getComputeTimestampWrites(0);
  }

  private copyMappedTimestamps(readBuffer: GPUBuffer, maxBytes: number): void {
    const mappedRange = readBuffer.getMappedRange();
    const copyBytes = Math.min(maxBytes, this.scratchBytes.byteLength, mappedRange.byteLength);
    this.scratchBytes.fill(0);
    if (copyBytes > 0) {
      this.scratchBytes.set(new Uint8Array(mappedRange, 0, copyBytes));
    }
    readBuffer.unmap();
  }

  public resolveFrame(encoder: GPUCommandEncoder): void {
    if (!this.enabled || !this.querySet || !this.resolveBuffer) {
      this.activePassesMask = 0;
      return;
    }

    const frameMask = this.activePassesMask;
    this.activePassesMask = 0;

    // 1. Select an IDLE staging slot (starting at ringIndex % ringSize so normal sequence is 0, 1, 2)
    // Never overwrite ringSlotPassMasks or copyBufferToBuffer on a PENDING_GPU / PENDING_MAP / MAPPED slot!
    let writeSlot = -1;
    for (let offset = 0; offset < this.ringSize; offset++) {
      const candidate = (this.ringIndex + offset) % this.ringSize;
      if (this.ringSlotStates[candidate] === 'IDLE') {
        writeSlot = candidate;
        break;
      }
    }
    this.ringIndex++;
    const currentFrame = this.ringIndex;

    if (writeSlot !== -1) {
      const destBuffer = this.ringBuffers[writeSlot];
      this.ringSlotPassMasks[writeSlot] = frameMask;
      this.ringSlotFrames[writeSlot] = currentFrame;

      // Resolve all 32 queries into resolveBuffer and copy into IDLE staging slot
      encoder.resolveQuerySet(this.querySet, 0, PROFILER_QUERY_CAPACITY, this.resolveBuffer, 0);
      encoder.copyBufferToBuffer(this.resolveBuffer, 0, destBuffer, 0, PROFILER_BUFFER_SIZE);
      this.ringSlotStates[writeSlot] = 'PENDING_GPU';
    }

    // 2. Ring warmup: wait until at least ringSize frames have been recorded before first readback
    if (this.ringIndex < this.ringSize) {
      return;
    }

    // 3. Initiate non-blocking mapAsync on the oldest PENDING_GPU slot submitted in a PRIOR frame
    // (Even if writeSlot === -1 due to 2-drawable Metal pipelining, this still drains completed GPU slots!)
    let readSlot = -1;
    let oldestFrame = Infinity;
    for (let s = 0; s < this.ringSize; s++) {
      if (this.ringSlotStates[s] === 'PENDING_GPU' && this.ringSlotFrames[s] < currentFrame) {
        if (this.ringSlotFrames[s] < oldestFrame) {
          oldestFrame = this.ringSlotFrames[s];
          readSlot = s;
        }
      }
    }

    if (readSlot !== -1) {
      this.initiateSlotMapAsync(readSlot);
    }
  }

  private initiateSlotMapAsync(readSlot: number): Promise<void> {
    const readBuffer = this.ringBuffers[readSlot];
    if (!readBuffer) return Promise.resolve();

    this.ringSlotStates[readSlot] = 'PENDING_MAP';
    const mapMode = typeof GPUMapMode !== 'undefined' ? GPUMapMode : { READ: 0x0001, WRITE: 0x0002 };
    const mapPromise = readBuffer
      .mapAsync(mapMode.READ)
      .then(() => {
        if (this.ringSlotStates[readSlot] !== 'PENDING_MAP') return;
        this.ringSlotStates[readSlot] = 'MAPPED';
        const slotMask = this.ringSlotPassMasks[readSlot] ?? 0xFFFFFFFF;
        const slotFrame = this.ringSlotFrames[readSlot] ?? 0;
        this.copyMappedTimestamps(readBuffer, PROFILER_BUFFER_SIZE);
        this.ringSlotStates[readSlot] = 'IDLE';

        const timestamps = this.scratchTimestamps;

        let activeCount = 0;
        for (let s = 0; s < PROFILER_SLOT_COUNT; s++) {
          this.scratchDeltaNs[s] = 0n;
          this.scratchExclusiveNs[s] = 0n;
          if ((slotMask & (1 << s)) === 0) continue;
          const t0 = timestamps[s * 2];
          const t1 = timestamps[s * 2 + 1];
          if (t1 >= t0 && t0 > 0n) {
            this.scratchDeltaNs[s] = t1 - t0;
            this.scratchActiveSlots[activeCount++] = s;
          }
        }

        // In-place insertion sort of active slots by hardware begin timestamp (t0), tie-broken by slot index
        for (let i = 1; i < activeCount; i++) {
          const slotKey = this.scratchActiveSlots[i];
          const t0Key = timestamps[slotKey * 2];
          let j = i - 1;
          while (j >= 0) {
            const prevSlot = this.scratchActiveSlots[j];
            const prevT0 = timestamps[prevSlot * 2];
            if (prevT0 > t0Key || (prevT0 === t0Key && prevSlot > slotKey)) {
              this.scratchActiveSlots[j + 1] = prevSlot;
              j--;
            } else {
              break;
            }
          }
          this.scratchActiveSlots[j + 1] = slotKey;
        }

        let minBeginNs = 0n;
        let maxEndNs = 0n;
        if (activeCount > 0) {
          const firstSlot = this.scratchActiveSlots[0];
          minBeginNs = timestamps[firstSlot * 2];
          maxEndNs = minBeginNs;
          for (let i = 0; i < activeCount; i++) {
            const s = this.scratchActiveSlots[i];
            const t0 = timestamps[s * 2];
            const t1 = timestamps[s * 2 + 1];
            const effectiveStart = t0 > maxEndNs ? t0 : maxEndNs;
            const tailNs = t1 > effectiveStart ? (t1 - effectiveStart) : 0n;
            this.scratchExclusiveNs[s] = tailNs;
            if (t1 > maxEndNs) {
              maxEndNs = t1;
            }
          }
        }

        const unionSpanMs = activeCount > 0 ? Number(maxEndNs - minBeginNs) / 1_000_000 : 0;
        const getDeltaMs = (s: number): number => Number(this.scratchDeltaNs[s]) / 1_000_000;
        const getExclusiveMs = (s: number): number => Number(this.scratchExclusiveNs[s]) / 1_000_000;

        const particleComputeMs = getDeltaMs(ProfilerPassSlot.Compute);
        const windComputeMs = getDeltaMs(ProfilerPassSlot.WindCompute);
        const horizonComputeMs = getDeltaMs(ProfilerPassSlot.HorizonCompute);
        const cloudAdvectionMs = getDeltaMs(ProfilerPassSlot.CloudAdvection);
        const drainageComputeMs = getDeltaMs(ProfilerPassSlot.DrainageCompute);
        const cdlodComputeMs = getDeltaMs(ProfilerPassSlot.CDLODCompute);
        const computeMs =
          particleComputeMs +
          windComputeMs +
          horizonComputeMs +
          cloudAdvectionMs +
          drainageComputeMs +
          cdlodComputeMs;

        const reliefMs = getDeltaMs(ProfilerPassSlot.SwissRelief);
        const linesMs = getDeltaMs(ProfilerPassSlot.Lines);
        const ribbonsMs = getDeltaMs(ProfilerPassSlot.Ribbons);
        const contoursMs = getDeltaMs(ProfilerPassSlot.Contours);
        const pointsMs = getDeltaMs(ProfilerPassSlot.Points);
        const volumetricMs = getDeltaMs(ProfilerPassSlot.Reserved1);
        const substrateMs = getDeltaMs(ProfilerPassSlot.Reserved2);
        const cloudProxyMs = getDeltaMs(ProfilerPassSlot.CloudProxy);
        const volumetricUpsampleMs = getDeltaMs(ProfilerPassSlot.VolumetricUpsample);
        const postCloudOverlayMs = getDeltaMs(ProfilerPassSlot.PostCloudOverlay);
        const renderMs =
          reliefMs +
          linesMs +
          ribbonsMs +
          contoursMs +
          pointsMs +
          volumetricMs +
          substrateMs +
          cloudProxyMs +
          volumetricUpsampleMs +
          postCloudOverlayMs;

        const exclusiveEndDeltaMs: Record<string, number> = {};
        const reports: KernelProfileReport[] = new Array(PROFILER_SLOT_COUNT);
        for (let idx = 0; idx < PROFILER_SLOT_COUNT; idx++) {
          const name = PROFILER_PASS_NAMES[idx];
          const deltaNs = this.scratchDeltaNs[idx];
          const deltaUs = Number(deltaNs) / 1000;
          const exclMs = getExclusiveMs(idx);
          exclusiveEndDeltaMs[name] = exclMs;
          reports[idx] = {
            passName: name,
            gpuTimeNs: deltaNs,
            gpuTimeUs: deltaUs,
            gpuTimeMs: deltaUs / 1000,
            exclusiveEndDeltaMs: exclMs,
          };
        }

        const frameReport: FrameProfileReport = {
          timestamp: performance.now(),
          frameIndex: slotFrame,
          computeMs,
          renderMs,
          reliefMs,
          linesMs,
          ribbonsMs,
          contoursMs,
          pointsMs,
          volumetricMs,
          substrateMs,
          particleComputeMs,
          windComputeMs,
          horizonComputeMs,
          cloudAdvectionMs,
          drainageComputeMs,
          cdlodComputeMs,
          cloudProxyMs,
          volumetricUpsampleMs,
          postCloudOverlayMs,
          totalGpuMs: computeMs + renderMs,
          unionSpanMs,
          exclusiveEndDeltaMs,
        };

        this.latestKernelReports = reports;
        this.latestReport = frameReport;
        if (this.reportListener) {
          try {
            this.reportListener(frameReport, reports);
          } catch {}
        }
      })
      .catch(() => {
        this.ringSlotStates[readSlot] = 'IDLE';
      })
      .finally(() => {
        if (this.ringSlotMapPromises[readSlot] === mapPromise) {
          this.ringSlotMapPromises[readSlot] = null;
        }
      });

    this.ringSlotMapPromises[readSlot] = mapPromise;
    return mapPromise;
  }

  /**
   * Drains all submitted PENDING_GPU ring slots and awaits all in-flight mapAsync promises.
   * Call only after `device.queue.submit()` has completed for the current frame.
   */
  public async flushPendingReads(): Promise<void> {
    if (!this.supported) return;
    const pendingGpuSlots: number[] = [];
    for (let s = 0; s < this.ringSize; s++) {
      if (this.ringSlotStates[s] === 'PENDING_GPU') {
        pendingGpuSlots.push(s);
      }
    }
    pendingGpuSlots.sort((a, b) => this.ringSlotFrames[a] - this.ringSlotFrames[b]);
    for (const s of pendingGpuSlots) {
      this.initiateSlotMapAsync(s);
    }
    const activePromises = this.ringSlotMapPromises.filter((p): p is Promise<void> => p !== null);
    if (activePromises.length > 0) {
      await Promise.all(activePromises);
    }
  }

  public getLatestReport(): FrameProfileReport | null {
    return this.latestReport;
  }

  public getKernelReports(): KernelProfileReport[] {
    return this.latestKernelReports;
  }

  public resolveAndRecord(encoder: GPUCommandEncoder, passName: string): Promise<KernelProfileReport | null> {
    if (!this.enabled || !this.querySet || !this.resolveBuffer) {
      return Promise.resolve(null);
    }

    const currentSlot = this.ringIndex % this.ringSize;
    const destBuffer = this.ringBuffers[currentSlot];

    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, destBuffer, 0, 16);

    const readSlot = (this.ringIndex + 1) % this.ringSize;
    const readBuffer = this.ringBuffers[readSlot];

    this.ringIndex++;

    if (this.ringIndex < this.ringSize) {
      return Promise.resolve(null);
    }

    const mapMode = typeof GPUMapMode !== 'undefined' ? GPUMapMode : { READ: 0x0001, WRITE: 0x0002 };
    return readBuffer.mapAsync(mapMode.READ).then(() => {
      this.copyMappedTimestamps(readBuffer, 16);

      const t0 = this.scratchTimestamps[0];
      const t1 = this.scratchTimestamps[1];
      const deltaNs = t1 >= t0 ? t1 - t0 : 0n;
      const deltaUs = Number(deltaNs) / 1000;
      const deltaMs = deltaUs / 1000;

      return {
        passName,
        gpuTimeNs: deltaNs,
        gpuTimeUs: deltaUs,
        gpuTimeMs: deltaMs,
        exclusiveEndDeltaMs: deltaMs,
      };
    }).catch(() => null);
  }

  public dispose(): void {
    if (this.querySet) {
      this.querySet.destroy();
      this.querySet = null;
    }
    if (this.resolveBuffer) {
      this.resolveBuffer.destroy();
      this.resolveBuffer = null;
    }
    for (const buf of this.ringBuffers) {
      buf.destroy();
    }
    this.ringBuffers = [];
    this.ringSlotStates = [];
    this.ringSlotMapPromises = [];
    this.ringSlotFrames.fill(0);
    this.passTimestampDescriptors = [];
    this.passBeginDescriptors = [];
    this.passEndDescriptors = [];
    this.latestReport = null;
    this.latestKernelReports = [];
    this.reportListener = null;
    this.supported = false;
    this.enabled = false;
  }
}


