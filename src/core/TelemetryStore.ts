import { useSyncExternalStore } from 'react';

export interface TelemetryLodStats {
  activeNodes: number;
  culledNodes: number;
  indirectDrawCalls: number;
  maxLodLevel: number;
  activeSlippyTiles: number;
}

export interface TelemetryGeodeticSnapshot {
  latDeg: number;
  lonDeg: number;
  latStr: string;
  lonStr: string;
  mapScaleStr: string;
  cameraAltitude: number;
  cursorCoords: { lon: number; lat: number } | null;
}

export interface TelemetryLiveTimelineSnapshot {
  tau: number;
  timelineMinutes: number;
  bracketHour: number;
  isScrubbing: boolean;
}

type Listener = () => void;

type Topic =
  | 'fps'
  | 'gpuReport'
  | 'geodetic'
  | 'lodStats'
  | 'liveUnfurl'
  | 'liveTimeline';

const RADIUS = 5.0;

export function formatGeodeticTelemetry(
  latDeg: number,
  lonDeg: number,
  camDist: number,
  unfurlAlpha: number
): { latStr: string; lonStr: string; mapScaleStr: string } {
  const safeLat = Number.isFinite(latDeg) ? Math.round(latDeg) : 0;
  const safeLon = Number.isFinite(lonDeg) ? Math.round(lonDeg) : 0;
  const latStr = `${Math.abs(safeLat).toString().padStart(2, '0')}°00'${safeLat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(safeLon).toString().padStart(3, '0')}°00'${safeLon >= 0 ? 'E' : 'W'}`;
  const activeCamDist = Number.isFinite(camDist) ? camDist : 15.0;
  const altitudeRatio = Math.max(0.002, (activeCamDist - RADIUS) / (15.0 - RADIUS));
  const baseScaleDenom = Math.max(50000, Math.round((127420000 * altitudeRatio) / 10000) * 10000);
  const mapScaleStr =
    unfurlAlpha < 0.01
      ? `1 : ${baseScaleDenom.toLocaleString('en-US')}`
      : `1 : ${Math.round(baseScaleDenom / Math.max(0.2, Math.cos((safeLat * Math.PI) / 180))).toLocaleString('en-US')}`;
  return { latStr, lonStr, mapScaleStr };
}

const DEFAULT_LOD_STATS: TelemetryLodStats = Object.freeze({
  activeNodes: 0,
  culledNodes: 0,
  indirectDrawCalls: 0,
  maxLodLevel: 0,
  activeSlippyTiles: 0,
});

const initialFormatted = formatGeodeticTelemetry(0, 0, 15.0, 0);

const DEFAULT_GEODETIC: TelemetryGeodeticSnapshot = Object.freeze({
  latDeg: 0,
  lonDeg: 0,
  latStr: initialFormatted.latStr,
  lonStr: initialFormatted.lonStr,
  mapScaleStr: initialFormatted.mapScaleStr,
  cameraAltitude: 15.0,
  cursorCoords: null,
});

class TelemetryStoreImpl {
  private fps: number = 60;
  private gpuReport: any = null;
  private geodetic: TelemetryGeodeticSnapshot = DEFAULT_GEODETIC;
  private lodStats: TelemetryLodStats = DEFAULT_LOD_STATS;
  private liveUnfurl: number | null = null;
  private liveTimeline: TelemetryLiveTimelineSnapshot | null = null;
  private currentUnfurlForScale: number = 0;

  private readonly listeners: Record<Topic, Set<Listener>> = {
    fps: new Set(),
    gpuReport: new Set(),
    geodetic: new Set(),
    lodStats: new Set(),
    liveUnfurl: new Set(),
    liveTimeline: new Set(),
  };

  private emit(topic: Topic): void {
    const bucket = this.listeners[topic];
    if (bucket.size === 0) return;
    bucket.forEach((fn) => fn());
  }

  public subscribeTopic = (topic: Topic) => (listener: Listener): (() => void) => {
    this.listeners[topic].add(listener);
    return () => {
      this.listeners[topic].delete(listener);
    };
  };

  public readonly subscribeFps = this.subscribeTopic('fps');
  public readonly subscribeGpuReport = this.subscribeTopic('gpuReport');
  public readonly subscribeGeodetic = this.subscribeTopic('geodetic');
  public readonly subscribeLodStats = this.subscribeTopic('lodStats');
  public readonly subscribeLiveUnfurl = this.subscribeTopic('liveUnfurl');
  public readonly subscribeLiveTimeline = this.subscribeTopic('liveTimeline');

  public getFps = (): number => this.fps;
  public getGpuReport = (): any => this.gpuReport;
  public getGeodetic = (): TelemetryGeodeticSnapshot => this.geodetic;
  public getLodStats = (): TelemetryLodStats => this.lodStats;
  public getLiveUnfurl = (): number | null => this.liveUnfurl;
  public getLiveTimeline = (): TelemetryLiveTimelineSnapshot | null => this.liveTimeline;

  public setFps(nextFps: number): void {
    if (!Number.isFinite(nextFps)) return;
    const rounded = Math.round(nextFps);
    if (this.fps === rounded) return;
    this.fps = rounded;
    this.emit('fps');
  }

  public setGpuReport(report: any): void {
    if (this.gpuReport === report) return;
    this.gpuReport = report;
    this.emit('gpuReport');
  }

  public setUnfurlScaleContext(alpha: number): void {
    if (!Number.isFinite(alpha)) return;
    const clamped = Math.max(0, Math.min(1, alpha));
    if (Math.abs(this.currentUnfurlForScale - clamped) < 0.005) return;
    this.currentUnfurlForScale = clamped;
    const formatted = formatGeodeticTelemetry(
      this.geodetic.latDeg,
      this.geodetic.lonDeg,
      this.geodetic.cameraAltitude,
      clamped
    );
    if (formatted.mapScaleStr !== this.geodetic.mapScaleStr) {
      this.geodetic = {
        ...this.geodetic,
        mapScaleStr: formatted.mapScaleStr,
      };
      this.emit('geodetic');
    }
  }

  public setGeodeticCoords(latDeg: number, lonDeg: number, camDist?: number): void {
    const nextAlt =
      camDist !== undefined && Number.isFinite(camDist) ? camDist : this.geodetic.cameraAltitude;
    const formatted = formatGeodeticTelemetry(
      latDeg,
      lonDeg,
      nextAlt,
      this.liveUnfurl ?? this.currentUnfurlForScale
    );
    if (
      this.geodetic.latDeg === latDeg &&
      this.geodetic.lonDeg === lonDeg &&
      Math.abs(this.geodetic.cameraAltitude - nextAlt) < 0.001 &&
      this.geodetic.mapScaleStr === formatted.mapScaleStr
    ) {
      return;
    }
    this.geodetic = {
      ...this.geodetic,
      latDeg,
      lonDeg,
      latStr: formatted.latStr,
      lonStr: formatted.lonStr,
      mapScaleStr: formatted.mapScaleStr,
      cameraAltitude: nextAlt,
    };
    this.emit('geodetic');
  }

  public setCursorCoords(coords: { lon: number; lat: number } | null): void {
    const prev = this.geodetic.cursorCoords;
    if (prev === null && coords === null) return;
    if (
      prev !== null &&
      coords !== null &&
      Math.abs(prev.lon - coords.lon) < 0.0005 &&
      Math.abs(prev.lat - coords.lat) < 0.0005
    ) {
      return;
    }
    this.geodetic = {
      ...this.geodetic,
      cursorCoords: coords ? { lon: coords.lon, lat: coords.lat } : null,
    };
    this.emit('geodetic');
  }

  public setCameraAltitude(camDist: number): void {
    if (!Number.isFinite(camDist)) return;
    if (Math.abs(this.geodetic.cameraAltitude - camDist) < 0.002) return;
    const formatted = formatGeodeticTelemetry(
      this.geodetic.latDeg,
      this.geodetic.lonDeg,
      camDist,
      this.liveUnfurl ?? this.currentUnfurlForScale
    );
    this.geodetic = {
      ...this.geodetic,
      cameraAltitude: camDist,
      mapScaleStr: formatted.mapScaleStr,
    };
    this.emit('geodetic');
  }

  public setLodStats(next: TelemetryLodStats): void {
    const cur = this.lodStats;
    if (
      cur.activeNodes === next.activeNodes &&
      cur.culledNodes === next.culledNodes &&
      cur.indirectDrawCalls === next.indirectDrawCalls &&
      cur.maxLodLevel === next.maxLodLevel &&
      cur.activeSlippyTiles === next.activeSlippyTiles
    ) {
      return;
    }
    this.lodStats = { ...next };
    this.emit('lodStats');
  }

  public setLiveUnfurl(alpha: number | null): void {
    if (alpha === null) {
      if (this.liveUnfurl === null) return;
      this.liveUnfurl = null;
      this.emit('liveUnfurl');
      return;
    }
    if (!Number.isFinite(alpha)) return;
    const clamped = Math.max(0, Math.min(1, alpha));
    if (this.liveUnfurl !== null && Math.abs(this.liveUnfurl - clamped) < 0.0002) return;
    this.liveUnfurl = clamped;
    this.currentUnfurlForScale = clamped;
    this.emit('liveUnfurl');
  }

  public setLiveTimeline(next: TelemetryLiveTimelineSnapshot | null): void {
    if (next === null) {
      if (this.liveTimeline === null) return;
      this.liveTimeline = null;
      this.emit('liveTimeline');
      return;
    }
    const prev = this.liveTimeline;
    if (
      prev !== null &&
      prev.isScrubbing === next.isScrubbing &&
      prev.bracketHour === next.bracketHour &&
      Math.abs(prev.timelineMinutes - next.timelineMinutes) < 0.01 &&
      Math.abs(prev.tau - next.tau) < 0.0005
    ) {
      return;
    }
    this.liveTimeline = { ...next };
    this.emit('liveTimeline');
  }

  public reset(): void {
    this.fps = 60;
    this.gpuReport = null;
    this.geodetic = DEFAULT_GEODETIC;
    this.lodStats = DEFAULT_LOD_STATS;
    this.liveUnfurl = null;
    this.liveTimeline = null;
    this.currentUnfurlForScale = 0;
    (Object.keys(this.listeners) as Topic[]).forEach((t) => this.emit(t));
  }
}

export const telemetryStore = new TelemetryStoreImpl();

const noopSubscribe = () => () => {};

export function useTelemetryFps(enabled: boolean = true): number {
  return useSyncExternalStore(
    enabled ? telemetryStore.subscribeFps : noopSubscribe,
    telemetryStore.getFps,
    telemetryStore.getFps
  );
}

export function useTelemetryGpuReport(enabled: boolean = true): any {
  return useSyncExternalStore(
    enabled ? telemetryStore.subscribeGpuReport : noopSubscribe,
    telemetryStore.getGpuReport,
    telemetryStore.getGpuReport
  );
}

export function useTelemetryGeodetic(enabled: boolean = true): TelemetryGeodeticSnapshot {
  return useSyncExternalStore(
    enabled ? telemetryStore.subscribeGeodetic : noopSubscribe,
    telemetryStore.getGeodetic,
    telemetryStore.getGeodetic
  );
}

export function useTelemetryLodStats(enabled: boolean = true): TelemetryLodStats {
  return useSyncExternalStore(
    enabled ? telemetryStore.subscribeLodStats : noopSubscribe,
    telemetryStore.getLodStats,
    telemetryStore.getLodStats
  );
}

export function useTelemetryLiveUnfurl(fallbackAlpha: number, enabled: boolean = true): number {
  const live = useSyncExternalStore(
    enabled ? telemetryStore.subscribeLiveUnfurl : noopSubscribe,
    telemetryStore.getLiveUnfurl,
    telemetryStore.getLiveUnfurl
  );
  return live !== null ? live : fallbackAlpha;
}

export function useTelemetryLiveTimeline(
  enabled: boolean = true
): TelemetryLiveTimelineSnapshot | null {
  return useSyncExternalStore(
    enabled ? telemetryStore.subscribeLiveTimeline : noopSubscribe,
    telemetryStore.getLiveTimeline,
    telemetryStore.getLiveTimeline
  );
}
