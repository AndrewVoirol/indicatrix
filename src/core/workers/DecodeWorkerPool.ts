// ============================================================================
// File: src/core/workers/DecodeWorkerPool.ts
// 2-Worker least-busy Transferable ArrayBuffer pool for WeatherNext, Terrarium,
// GeoTIFF, and rg16float tile buffer preparation. Automatically falls back to
// inline execution under Vitest / non-Worker environments unless a custom
// Worker factory is explicitly supplied.
// ============================================================================

import {
  executeDecodeTask,
  type DecodeWorkerRequest,
  type DecodeWorkerResponse,
} from './decodeTasks';
import type { WorkerEnvelopeRequest, WorkerEnvelopeResponse } from './decodeWorker';

export interface WorkerLike {
  onmessage: ((ev: MessageEvent<WorkerEnvelopeResponse>) => void) | null;
  onerror?: ((ev: ErrorEvent) => void) | null;
  postMessage: (message: WorkerEnvelopeRequest, transfer?: Transferable[]) => void;
  terminate: () => void;
}

export interface DecodeWorkerPoolOptions {
  poolSize?: number;
  workerFactory?: () => WorkerLike;
  allowWorkersInVitest?: boolean;
}

interface WorkerSlot {
  worker: WorkerLike;
  inFlight: number;
}

interface PendingJob {
  workerIdx: number;
  resolve: (res: DecodeWorkerResponse) => void;
  reject: (err: Error) => void;
}

function isVitestEnv(): boolean {
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  return Boolean(proc?.env?.VITEST);
}

export class DecodeWorkerPool {
  public readonly poolSize: number;
  private readonly workerFactory?: () => WorkerLike;
  private readonly allowWorkersInVitest: boolean;
  private slots: WorkerSlot[] | null = null;
  private workerInitFailed = false;
  private nextJobId = 1;
  private rrCursor = 0;
  private readonly pending = new Map<number, PendingJob>();

  constructor(options: DecodeWorkerPoolOptions = {}) {
    this.poolSize = Math.max(1, options.poolSize ?? 2);
    this.workerFactory = options.workerFactory;
    this.allowWorkersInVitest = Boolean(options.allowWorkersInVitest);
  }

  public canUseWorkers(): boolean {
    if (this.workerInitFailed) return false;
    if (isVitestEnv() && !this.allowWorkersInVitest && !this.workerFactory) {
      return false;
    }
    if (this.workerFactory) return true;
    return typeof Worker === 'function';
  }

  private ensureWorkers(): WorkerSlot[] | null {
    if (!this.canUseWorkers()) return null;
    if (this.slots) return this.slots;

    try {
      const created: WorkerSlot[] = [];
      for (let i = 0; i < this.poolSize; i++) {
        const w: WorkerLike = this.workerFactory
          ? this.workerFactory()
          : (new Worker(new URL('./decodeWorker.ts', import.meta.url), {
              type: 'module',
            }) as unknown as WorkerLike);
        const slot: WorkerSlot = { worker: w, inFlight: 0 };
        const slotIndex = i;

        w.onmessage = (ev: MessageEvent<WorkerEnvelopeResponse>) => {
          const msg = ev.data;
          const job = this.pending.get(msg.id);
          if (!job) return;
          this.pending.delete(msg.id);
          if (this.slots && this.slots[slotIndex]) {
            this.slots[slotIndex].inFlight = Math.max(0, this.slots[slotIndex].inFlight - 1);
          }
          if (msg.ok && msg.payload) {
            job.resolve(msg.payload);
          } else {
            job.reject(new Error(msg.error || 'DecodeWorker task failed'));
          }
        };

        w.onerror = (err: ErrorEvent) => {
          // Reject any pending jobs routed to this worker slot
          for (const [id, job] of this.pending.entries()) {
            if (job.workerIdx === slotIndex) {
              this.pending.delete(id);
              slot.inFlight = 0;
              job.reject(new Error(err?.message || 'DecodeWorker runtime error'));
            }
          }
        };

        created.push(slot);
      }
      this.slots = created;
      return created;
    } catch {
      this.workerInitFailed = true;
      this.slots = null;
      return null;
    }
  }

  private pickLeastBusySlot(slots: WorkerSlot[]): number {
    let bestIdx = this.rrCursor % slots.length;
    let minLoad = slots[bestIdx].inFlight;
    for (let i = 1; i < slots.length; i++) {
      const idx = (this.rrCursor + i) % slots.length;
      if (slots[idx].inFlight < minLoad) {
        bestIdx = idx;
        minLoad = slots[idx].inFlight;
      }
    }
    this.rrCursor = (bestIdx + 1) % slots.length;
    return bestIdx;
  }

  public async run<T extends DecodeWorkerResponse = DecodeWorkerResponse>(
    payload: DecodeWorkerRequest,
    transfer: Transferable[] = []
  ): Promise<T> {
    const slots = this.ensureWorkers();
    if (!slots) {
      const { response } = await executeDecodeTask(payload);
      return response as T;
    }

    const slotIdx = this.pickLeastBusySlot(slots);
    const slot = slots[slotIdx];
    const id = this.nextJobId++;
    slot.inFlight++;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        workerIdx: slotIdx,
        resolve: resolve as (res: DecodeWorkerResponse) => void,
        reject,
      });
      try {
        slot.worker.postMessage({ id, payload }, transfer);
      } catch (err) {
        this.pending.delete(id);
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public getActiveWorkerCount(): number {
    return this.slots ? this.slots.length : 0;
  }

  public getPendingTaskCount(): number {
    return this.pending.size;
  }

  public dispose(): void {
    if (this.slots) {
      for (const s of this.slots) {
        try {
          s.worker.terminate();
        } catch {}
      }
      this.slots = null;
    }
    for (const [, job] of this.pending.entries()) {
      job.reject(new Error('DecodeWorkerPool disposed'));
    }
    this.pending.clear();
  }
}

export const decodeWorkerPool = new DecodeWorkerPool({ poolSize: 2 });
