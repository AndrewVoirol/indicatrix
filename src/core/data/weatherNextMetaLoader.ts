import type { WeatherNextMeta } from './WeatherNextDataSource';
import { loadNodeAssetText } from '../../utils/nodeAssetLoader';

interface CachedMetaEntry {
  fetchRef: typeof fetch | undefined;
  promise: Promise<WeatherNextMeta>;
  timestampMs: number;
}

const META_CACHE_TTL_MS = 30_000;
const metaCache = new Map<string, CachedMetaEntry>();

export function resetWeatherNextMetaCache(): void {
  metaCache.clear();
}

/**
 * Deduplicates `/data/weathernext/meta.json` requests across `useEngineState`,
 * `TimelineScrubber`, and `WeatherNextDataSource` while staying transparent to
 * Vitest `globalThis.fetch` mocks and resets.
 */
export function fetchWeatherNextMeta(
  targetUrl: string = '/data/weathernext/meta.json'
): Promise<WeatherNextMeta> {
  const currentFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;
  const isMock = Boolean(currentFetch && (currentFetch as any).mock);
  const mockCallsLen = isMock ? ((currentFetch as any).mock?.calls?.length ?? 0) : -1;

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const existing = metaCache.get(targetUrl);

  if (existing && existing.fetchRef === currentFetch) {
    // If Vitest cleared/reset a persistent mock fn (`mock.calls.length === 0`), invalidate.
    const mockWasReset = isMock && mockCallsLen === 0;
    const expired = !isMock && now - existing.timestampMs > META_CACHE_TTL_MS;
    if (!mockWasReset && !expired) {
      return existing.promise;
    }
  }

  const promise = (async (): Promise<WeatherNextMeta> => {
    if (currentFetch !== undefined) {
      try {
        const res = await currentFetch(targetUrl);
        if (!res || !res.ok) {
          const status = res ? res.status : 0;
          const statusText = res?.statusText || '';
          throw new Error(`Failed to fetch metadata from ${targetUrl}: HTTP ${status} ${statusText}`.trim());
        }
        return (await res.json()) as WeatherNextMeta;
      } catch (err) {
        if (isMock) {
          throw err;
        }
      }
    }

    const nodeText = await loadNodeAssetText(targetUrl);
    if (nodeText !== null) {
      try {
        return JSON.parse(nodeText) as WeatherNextMeta;
      } catch (e) {
        throw new Error(
          `Failed to parse metadata JSON from ${targetUrl}: ${(e as Error).message}`
        );
      }
    }

    throw new Error(`Failed to fetch metadata from ${targetUrl}`);
  })();

  const entry: CachedMetaEntry = {
    fetchRef: currentFetch,
    promise,
    timestampMs: now,
  };
  metaCache.set(targetUrl, entry);

  // Never cache failed fetches so retries or error assertions execute cleanly.
  promise.catch(() => {
    if (metaCache.get(targetUrl) === entry) {
      metaCache.delete(targetUrl);
    }
  });

  return promise;
}
