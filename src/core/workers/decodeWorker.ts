// ============================================================================
// File: src/core/workers/decodeWorker.ts
// Web Worker entry point for off-main-thread WeatherNext Float16 interleaving,
// Terrarium PNG Web Mercator resampling, GeoTIFF DEFLATE/sample decoding, and
// rg16float GPUTileCache buffer preparation using zero-copy Transferables.
// ============================================================================

import { executeDecodeTask, type DecodeWorkerRequest, type DecodeWorkerResponse } from './decodeTasks';

export interface WorkerEnvelopeRequest {
  id: number;
  payload: DecodeWorkerRequest;
}

export interface WorkerEnvelopeResponse {
  id: number;
  ok: boolean;
  payload?: DecodeWorkerResponse;
  error?: string;
}

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerEnvelopeRequest>) => void) | null;
  postMessage: (message: WorkerEnvelopeResponse, transfer?: Transferable[]) => void;
};

workerScope.onmessage = async (ev: MessageEvent<WorkerEnvelopeRequest>) => {
  const { id, payload } = ev.data;
  try {
    const { response, transfer } = await executeDecodeTask(payload);
    workerScope.postMessage({ id, ok: true, payload: response }, transfer);
  } catch (err) {
    workerScope.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
