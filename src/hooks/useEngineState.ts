import { useState, useEffect, useRef, useCallback } from 'react';
import { isWebGPUSupported } from '../webgpu/support';
import { ThemeManager, ThemePalette, ThemeMode } from '../core/themes';

import { LoadedDataInfo, SimulationMode, ResolutionTier } from '../types';
import { MeteorologicalProvenance } from '../core/data/WeatherNextDataSource';
import { telemetryStore } from '../core/TelemetryStore';
import { fetchWeatherNextMeta } from '../core/data/weatherNextMetaLoader';

export type { SimulationMode, LoadedDataInfo, ResolutionTier, MeteorologicalProvenance };

export function useEngineState() {
  const [backend, setBackend] = useState<'webgl2' | 'webgpu'>(
    typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'webgl2'
  );
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const tm = ThemeManager.getInstance();
    tm.setMode(1);
    return 1;
  }); // 0 = Tharp, 1 = Cream, 2 = Cyanotype
  const [themePalette, setThemePalette] = useState<ThemePalette>(ThemeManager.getInstance().getPalette());
  const [hasWebGPU, setHasWebGPU] = useState<boolean>(false);
  const [alpha, setAlphaState] = useState(0);
  const alphaValRef = useRef(0);
  alphaValRef.current = alpha;
  const setAlpha = useCallback((v: number | ((prev: number) => number)) => {
    const prev = alphaValRef.current;
    const next = typeof v === 'function' ? v(prev) : v;
    const clamped = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : prev;
    alphaValRef.current = clamped;
    telemetryStore.setLiveUnfurl(null);
    telemetryStore.setUnfurlScaleContext(clamped);
    setAlphaState(clamped);
  }, []);
  const [mode, setMode] = useState<SimulationMode>(0); // Default to Mode 0 (Linear Mix)
  const [layerMode, setLayerMode] = useState<0 | 1 | 2>(0); // Default to 0 (Both: Points + Hairlines)
  const [cursorPhysicsEnabled, setCursorPhysicsEnabled] = useState<boolean>(false);
  const [resolution, setResolution] = useState<ResolutionTier>('100k');
  const fps = telemetryStore.getFps();
  const setFps = useCallback((v: number | ((prev: number) => number)) => {
    const next = typeof v === 'function' ? v(telemetryStore.getFps()) : v;
    telemetryStore.setFps(next);
  }, []);
  const [isHudOpen, setIsHudOpen] = useState(true);

  // Cartographic Overlays state
  const [showVectors, setShowVectors] = useState<boolean>(true);
  const [showToponymy, setShowToponymyState] = useState<boolean>(true);
  const setShowToponymy = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setShowToponymyState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.showToponymy = val;
      }
      return val;
    });
  }, []);

  // Archival Cartographic Detail Toggles
  const [showCartouche, setShowCartouche] = useState<boolean>(true);

  // Auto-morph playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playDirection, setPlayDirection] = useState<1 | -1>(1);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [isZenMode, setIsZenMode] = useState<boolean>(false);
  const playbackClockRef = useRef<number>(0);
  const wasPlayingRef = useRef<boolean>(false);

  // GPU Profiler Telemetry (delegated to leaf TelemetryStore — 0 <App /> commits)
  const gpuReport = telemetryStore.getGpuReport();
  const setGpuReport = useCallback((v: any) => {
    const next = typeof v === 'function' ? v(telemetryStore.getGpuReport()) : v;
    telemetryStore.setGpuReport(next);
  }, []);

  // Atmospheric Cloud Strata State (Milestone 5)
  const [showClouds, setShowCloudsState] = useState<boolean>(true);
  const [showCloudLow, setShowCloudLowState] = useState<boolean>(true);
  const [showCloudMid, setShowCloudMidState] = useState<boolean>(true);
  const [showCloudHigh, setShowCloudHighState] = useState<boolean>(true);
  const [cloudDriftSpeed, setCloudDriftSpeedState] = useState<number>(500);
  const [cloudOpacity, setCloudOpacityState] = useState<number>(0.8);
  const [cloudFalseColor, setCloudFalseColorState] = useState<boolean>(false);
  const [volumetricClouds, setVolumetricCloudsState] = useState<boolean>(true);
  const [cloudThickness, setCloudThicknessState] = useState<number>(0.19);
  const [cloudLowTop, setCloudLowTopState] = useState<number>(0.45);
  const [cloudErosion, setCloudErosionState] = useState<number>(0.85);
  const [cloudFreqHoriz, setCloudFreqHorizState] = useState<number>(32.0);
  const [cloudFreqVert, setCloudFreqVertState] = useState<number>(12.0);
  const [cloudExtinction, setCloudExtinctionState] = useState<number>(28.0);

  const setShowClouds = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    if (typeof v === 'boolean' && typeof window !== 'undefined') {
      if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) {
        (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
      }
      (window as any).__INDICATRIX_LIVE_UNIFORMS__.showClouds = v;
    }
    setShowCloudsState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        }
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.showClouds = val;
      }
      return val;
    });
  }, []);
  const setShowCloudLow = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setShowCloudLowState(v);
  }, []);
  const setShowCloudMid = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setShowCloudMidState(v);
  }, []);
  const setShowCloudHigh = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setShowCloudHighState(v);
  }, []);
  const setCloudFalseColor = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCloudFalseColorState(v);
  }, []);
  const setVolumetricClouds = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setVolumetricCloudsState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        }
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.volumetricClouds = val;
      }
      return val;
    });
  }, []);
  const setCloudDriftSpeed = useCallback((v: number | ((prev: number) => number)) => {
    setCloudDriftSpeedState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      return Math.max(0, Math.min(2000, val));
    });
  }, []);
  const setCloudOpacity = useCallback((v: number | ((prev: number) => number)) => {
    setCloudOpacityState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      return Math.max(0.1, Math.min(1.0, val));
    });
  }, []);
  const setCloudThickness = useCallback((v: number | ((prev: number) => number)) => {
    setCloudThicknessState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      const clamped = Math.max(0.04, Math.min(0.35, val));
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudThickness = clamped;
      }
      return clamped;
    });
  }, []);
  const setCloudLowTop = useCallback((v: number | ((prev: number) => number)) => {
    setCloudLowTopState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      const clamped = Math.max(0.05, Math.min(0.60, val));
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudLowTop = clamped;
      }
      return clamped;
    });
  }, []);
  const setCloudErosion = useCallback((v: number | ((prev: number) => number)) => {
    setCloudErosionState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      const clamped = Math.max(0.0, Math.min(2.0, val));
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudErosionStr = clamped;
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudErosion = clamped;
      }
      return clamped;
    });
  }, []);
  const setCloudFreqHoriz = useCallback((v: number | ((prev: number) => number)) => {
    setCloudFreqHorizState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      const clamped = Math.max(4.0, Math.min(96.0, val));
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudFreqHoriz = clamped;
      }
      return clamped;
    });
  }, []);
  const setCloudFreqVert = useCallback((v: number | ((prev: number) => number)) => {
    setCloudFreqVertState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      const clamped = Math.max(2.0, Math.min(32.0, val));
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudFreqVert = clamped;
      }
      return clamped;
    });
  }, []);
  const setCloudExtinction = useCallback((v: number | ((prev: number) => number)) => {
    setCloudExtinctionState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      const clamped = Math.max(1.0, Math.min(100.0, val));
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudExtinction = clamped;
      }
      return clamped;
    });
  }, []);

  const setCloudOptions = useCallback((
    options: Partial<{
      showClouds: boolean;
      showCloudLow: boolean;
      showCloudMid: boolean;
      showCloudHigh: boolean;
      cloudDriftSpeed: number;
      cloudOpacity: number;
      cloudFalseColor: boolean;
      cloudThickness: number;
      cloudLowTop: number;
      cloudErosion: number;
      cloudErosionStr: number;
      cloudFreqHoriz: number;
      cloudFreqVert: number;
      cloudExtinction: number;
    }>
  ) => {
    if (options.showClouds !== undefined) {
      setShowCloudsState(options.showClouds);
      if (typeof window !== 'undefined') {
        if (!(window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {};
        }
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.showClouds = options.showClouds;
      }
    }
    if (options.showCloudLow !== undefined) setShowCloudLowState(options.showCloudLow);
    if (options.showCloudMid !== undefined) setShowCloudMidState(options.showCloudMid);
    if (options.showCloudHigh !== undefined) setShowCloudHighState(options.showCloudHigh);
    if (options.cloudFalseColor !== undefined) setCloudFalseColorState(options.cloudFalseColor);
    if (options.cloudDriftSpeed !== undefined && typeof options.cloudDriftSpeed === 'number' && Number.isFinite(options.cloudDriftSpeed)) {
      setCloudDriftSpeedState(Math.max(0, Math.min(2000, options.cloudDriftSpeed)));
    }
    if (options.cloudOpacity !== undefined && typeof options.cloudOpacity === 'number' && Number.isFinite(options.cloudOpacity)) {
      setCloudOpacityState(Math.max(0.1, Math.min(1.0, options.cloudOpacity)));
    }
    if (options.cloudThickness !== undefined && typeof options.cloudThickness === 'number' && Number.isFinite(options.cloudThickness)) {
      setCloudThickness(options.cloudThickness);
    }
    if (options.cloudLowTop !== undefined && typeof options.cloudLowTop === 'number' && Number.isFinite(options.cloudLowTop)) {
      setCloudLowTop(options.cloudLowTop);
    }
    const erosion = options.cloudErosionStr ?? options.cloudErosion;
    if (erosion !== undefined && typeof erosion === 'number' && Number.isFinite(erosion)) {
      setCloudErosion(erosion);
    }
    if (options.cloudFreqHoriz !== undefined && typeof options.cloudFreqHoriz === 'number' && Number.isFinite(options.cloudFreqHoriz)) {
      setCloudFreqHoriz(options.cloudFreqHoriz);
    }
    if (options.cloudFreqVert !== undefined && typeof options.cloudFreqVert === 'number' && Number.isFinite(options.cloudFreqVert)) {
      setCloudFreqVert(options.cloudFreqVert);
    }
    if (options.cloudExtinction !== undefined && typeof options.cloudExtinction === 'number' && Number.isFinite(options.cloudExtinction)) {
      setCloudExtinction(options.cloudExtinction);
    }
  }, [setCloudThickness, setCloudLowTop, setCloudErosion, setCloudFreqHoriz, setCloudFreqVert, setCloudExtinction]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__INDICATRIX_CLOUD_STATE__ = {
        showClouds,
        showCloudLow,
        showCloudMid,
        showCloudHigh,
        cloudDriftSpeed,
        cloudOpacity,
        cloudFalseColor,
        cloudThickness,
        cloudLowTop,
        cloudErosion,
        cloudFreqHoriz,
        cloudFreqVert,
        cloudExtinction,
      };
      (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__ = setCloudOptions;
    }
  }, [showClouds, showCloudLow, showCloudMid, showCloudHigh, cloudDriftSpeed, cloudOpacity, cloudFalseColor, cloudThickness, cloudLowTop, cloudErosion, cloudFreqHoriz, cloudFreqVert, cloudExtinction, setCloudOptions]);

  const [cdlodDiagnosticMode, setCdlodDiagnosticModeState] = useState<number>(0);

  const setCdlodDiagnosticMode = useCallback((mode: number | ((prev: number) => number)) => {
    setCdlodDiagnosticModeState((prev) => {
      const val = typeof mode === 'function' ? mode(prev) : mode;
      const resolved = typeof val === 'number' && Number.isFinite(val) ? Math.max(0, Math.min(3, Math.round(val))) : 0;
      if (typeof window !== 'undefined') {
        (window as any).__INDICATRIX_CDLOD_DIAGNOSTIC_MODE__ = resolved;
        window.dispatchEvent(new CustomEvent('indicatrix:cdlod-diag', { detail: resolved }));
      }
      return resolved;
    });
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__INDICATRIX_CDLOD_DIAGNOSTIC_MODE__ = cdlodDiagnosticMode;
      (window as any).__INDICATRIX_SET_CDLOD_DIAGNOSTIC_MODE__ = setCdlodDiagnosticMode;
    }
  }, [cdlodDiagnosticMode, setCdlodDiagnosticMode]);

  // Provenance & Wind Advection Telemetry State (Phase 3 Requirement)
  const [provenance, setProvenanceState] = useState<MeteorologicalProvenance>({
    modelName: 'Google DeepMind WeatherNext 3',
    runTimestamp: '2026-10-24T10:00:00Z',
    validTimestamp: '2026-10-24T10:00:00Z',
    forecastHour: 0,
    spatialResolutionDeg: 0.1,
    temporalBlendTau: 0.0,
    activeSlotIndex: 0,
    strata: {
      surface10m: true,
      jetStream250hPa: true,
    },
  });

  useEffect(() => {
    if (typeof fetch !== 'function') return;
    if (
      (typeof navigator !== 'undefined' && /jsdom|HappyDOM/i.test(navigator.userAgent || '')) ||
      (typeof process !== 'undefined' && process.env?.VITEST && !(fetch as any)?.mock)
    ) {
      return;
    }
    let cancelled = false;
    fetchWeatherNextMeta('/data/weathernext/meta.json')
      .then((data) => {
        if (cancelled || !data) return;
        const initTs = data?.forecastInitTimestamp;
        if (typeof initTs === 'string' && initTs.includes('T')) {
          setProvenanceState((prev) =>
            prev.forecastHour === 0
              ? { ...prev, runTimestamp: initTs, validTimestamp: initTs }
              : { ...prev, runTimestamp: initTs }
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setProvenance = useCallback((prov: Partial<MeteorologicalProvenance> | ((prev: MeteorologicalProvenance) => MeteorologicalProvenance)) => {
    setProvenanceState((prev) => {
      const next = typeof prov === 'function' ? prov(prev) : { ...prev, ...prov };
      if (typeof window !== 'undefined') {
        (window as any).__INDICATRIX_PROVENANCE__ = next;
      }
      return next;
    });
  }, []);

  const [windSpeedMultiplier, setWindSpeedMultiplierState] = useState<number>(1.0);
  const setWindSpeedMultiplier = useCallback((v: number | ((prev: number) => number)) => {
    setWindSpeedMultiplierState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      const clamped = Math.max(0.1, Math.min(10.0, val));
      if (typeof window !== 'undefined') {
        const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__ || (window as any).__ENGINE;
        if (engine && typeof engine.setWindSpeedMultiplier === 'function') {
          engine.setWindSpeedMultiplier(clamped);
        }
        if ((window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__.windSpeedMultiplier = clamped;
        }
      }
      return clamped;
    });
  }, []);

  const [windParticleLifetime, setWindParticleLifetimeState] = useState<number>(6.0);
  const setWindParticleLifetime = useCallback((v: number | ((prev: number) => number)) => {
    setWindParticleLifetimeState((prev) => {
      const val = typeof v === 'function' ? v(prev) : v;
      if (typeof val !== 'number' || !Number.isFinite(val)) return prev;
      const clamped = Math.max(0.5, Math.min(20.0, val));
      if (typeof window !== 'undefined') {
        const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__ || (window as any).__ENGINE;
        if (engine && typeof engine.setWindParticleLifetime === 'function') {
          engine.setWindParticleLifetime(clamped);
        }
        if ((window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__.windParticleLifetime = clamped;
        }
      }
      return clamped;
    });
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__INDICATRIX_SET_WIND_SPEED_MULTIPLIER__ = setWindSpeedMultiplier;
      (window as any).__INDICATRIX_SET_WIND_PARTICLE_LIFETIME__ = setWindParticleLifetime;
      (window as any).__INDICATRIX_SET_PROVENANCE__ = setProvenance;
      (window as any).__INDICATRIX_PROVENANCE__ = provenance;
    }
  }, [setWindSpeedMultiplier, setWindParticleLifetime, setProvenance, provenance]);

  const [dataInfo, setDataInfo] = useState<LoadedDataInfo>({ 
    pointCount: 100000, 
    lineCount: 300000,
    format: 'BIN (Zero-Copy)',
    loadTimeMs: 0,
    vramMb: 4.57
  });

  // Keep ThemeManager in sync
  useEffect(() => {
    const unsubscribe = ThemeManager.getInstance().subscribe((palette) => {
      setThemeState(palette.mode);
      setThemePalette(palette);
    });
    return unsubscribe;
  }, []);

  const setTheme = useCallback((newMode: ThemeMode | ((prev: ThemeMode) => ThemeMode)) => {
    const resolvedMode = typeof newMode === 'function' ? newMode(ThemeManager.getInstance().getMode()) : newMode;
    ThemeManager.getInstance().setMode(resolvedMode);
  }, []);

  useEffect(() => {
    isWebGPUSupported().then((supported) => {
      setHasWebGPU(supported);
      if (supported) {
        setBackend('webgpu');
      }
    });
  }, []);

  // Auto-morph loop: decoupled continuous accumulator + UI-level quintic smootherstep easing
  useEffect(() => {
    if (!isPlaying) {
      wasPlayingRef.current = false;
      if (typeof window !== 'undefined') {
        (window as any).__INDICATRIX_ANIM_ALPHA__ = undefined;
      }
      return;
    }

    // Invert current alpha so playback starts seamlessly from the current slider position
    const invertQuintic = (target: number): number => {
      if (target <= 0.0) return 0.0;
      if (target >= 1.0) return 1.0;

      // Cubic initial guess near flat boundaries where S_5'(t) -> 0
      let t = target;
      if (target <= 0.05) {
        t = Math.cbrt(target / 10.0);
      } else if (target >= 0.95) {
        t = 1.0 - Math.cbrt((1.0 - target) / 10.0);
      }

      for (let i = 0; i < 4; i++) {
        const t2 = t * t;
        const t3 = t2 * t;
        const oneMinusT = 1.0 - t;
        const f = t3 * (t * (t * 6.0 - 15.0) + 10.0) - target;
        const df = 30.0 * t2 * oneMinusT * oneMinusT;
        const d2f = 60.0 * t * oneMinusT * (1.0 - 2.0 * t);
        const denom = 2.0 * df * df - f * d2f;
        if (Math.abs(denom) < 1e-12) break;
        const step = (2.0 * f * df) / denom;
        t = Math.max(0.0, Math.min(1.0, t - step));
      }
      return t;
    };

    const evaluateEase = (t: number): number => {
      const c = Math.max(0.0, Math.min(1.0, t));
      return c * c * c * (c * (c * 6.0 - 15.0) + 10.0);
    };

    if (!wasPlayingRef.current) {
      wasPlayingRef.current = true;
      playbackClockRef.current = invertQuintic(alphaRef.current);
      if (playbackClockRef.current >= 1.0 && playDirection > 0) {
        setPlayDirection(-1);
      } else if (playbackClockRef.current <= 0.0 && playDirection < 0) {
        setPlayDirection(1);
      }
    }

    let animId: number;
    let lastT = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastT) * 0.001;
      lastT = now;
      const step = dt * 0.20 * playbackSpeed * playDirection;
      playbackClockRef.current += step;
      if (playbackClockRef.current >= 1.0) {
        playbackClockRef.current = 1.0;
        setPlayDirection(-1);
      } else if (playbackClockRef.current <= 0.0) {
        playbackClockRef.current = 0.0;
        setPlayDirection(1);
      }

      const easedAlpha = evaluateEase(playbackClockRef.current);
      alphaRef.current = easedAlpha;

      if (typeof window !== 'undefined') {
        (window as any).__INDICATRIX_ANIM_ALPHA__ = easedAlpha;
      }

      // Leaf TelemetryStore sync (120 Hz sextant tracking with 0 <App /> Virtual DOM commits/sec)
      telemetryStore.setLiveUnfurl(easedAlpha);

      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animId);
      if (typeof window !== 'undefined') {
        (window as any).__INDICATRIX_ANIM_ALPHA__ = undefined;
      }
      // Guard against overwriting manual drag value on unmount
      if (typeof window === 'undefined' || (window as any).__INDICATRIX_SCRUB_ALPHA__ === undefined) {
        setAlpha(evaluateEase(playbackClockRef.current));
      } else {
        telemetryStore.setLiveUnfurl(null);
      }
    };
  }, [isPlaying, playDirection, playbackSpeed, setAlpha]);

  // Centralized glide kinematics & mode coordination (R4)
  const glideAnimRef = useRef<number | null>(null);
  const alphaRef = useRef(alpha);
  if (glideAnimRef.current === null && !isPlaying) {
    alphaRef.current = telemetryStore.getLiveUnfurl() ?? alpha;
  }
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const cancelGlide = useCallback(() => {
    const wasGliding = glideAnimRef.current !== null;
    if (glideAnimRef.current !== null) {
      cancelAnimationFrame(glideAnimRef.current);
      glideAnimRef.current = null;
    }
    if (wasGliding) {
      if (typeof window !== 'undefined') {
        (window as any).__INDICATRIX_SCRUB_ALPHA__ = undefined;
      }
      telemetryStore.setLiveUnfurl(null);
    }
  }, []);

  const glideToAlpha = useCallback((targetAlpha: number, duration: number = 650) => {
    cancelGlide();
    setIsPlaying(false);
    const startAlpha = alphaRef.current;
    const clampedTarget = Math.max(0.0, Math.min(1.0, targetAlpha));
    if (Math.abs(startAlpha - clampedTarget) < 0.0001) return;
    const startTime = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1.0, elapsed / duration);
      // Quintic smootherstep easing
      const ease = progress * progress * progress * (progress * (progress * 6.0 - 15.0) + 10.0);
      const cur = startAlpha + (clampedTarget - startAlpha) * ease;
      alphaRef.current = cur;
      if (typeof window !== 'undefined') {
        (window as any).__INDICATRIX_SCRUB_ALPHA__ = cur;
      }
      if (progress < 1.0) {
        telemetryStore.setLiveUnfurl(cur);
        glideAnimRef.current = requestAnimationFrame(animate);
      } else {
        glideAnimRef.current = null;
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_SCRUB_ALPHA__ = undefined;
        }
        alphaRef.current = clampedTarget;
        setAlpha(clampedTarget);
      }
    };
    glideAnimRef.current = requestAnimationFrame(animate);
  }, [cancelGlide, setAlpha]);

  const glideToMode = useCallback((targetMode: SimulationMode) => {
    if (modeRef.current === targetMode) return;
    cancelGlide();
    setIsPlaying(false);

    if (alphaRef.current < 0.01) {
      modeRef.current = targetMode;
      setMode(targetMode);
      if (typeof window !== 'undefined') {
        (window as any).__INDICATRIX_MODE__ = targetMode;
      }
      return;
    }

    const startAlpha = alphaRef.current;
    const startTime = performance.now();
    let switchedMode = false;

    const animate = (now: number) => {
      const elapsed = now - startTime;
      if (elapsed < 250) {
        // Phase 1: 250ms cubic ease-in to alpha = 0.00
        const p = Math.min(1.0, elapsed / 250);
        const easeIn = p * p * p;
        const curAlpha = Math.max(0.0, startAlpha * (1.0 - easeIn));
        alphaRef.current = curAlpha;
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_SCRUB_ALPHA__ = curAlpha;
        }
        telemetryStore.setLiveUnfurl(curAlpha);
        glideAnimRef.current = requestAnimationFrame(animate);
      } else if (elapsed < 280) {
        // Singularity point: 30ms dwell window at alpha = 0.000 for clean mode handover
        if (!switchedMode) {
          modeRef.current = targetMode;
          setMode(targetMode);
          if (typeof window !== 'undefined') {
            (window as any).__INDICATRIX_MODE__ = targetMode;
          }
          switchedMode = true;
        }
        alphaRef.current = 0.0;
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_SCRUB_ALPHA__ = 0.0;
        }
        telemetryStore.setLiveUnfurl(0.0);
        glideAnimRef.current = requestAnimationFrame(animate);
      } else if (elapsed < 630) {
        // Phase 2: 350ms cubic ease-out restore to startAlpha
        if (!switchedMode) {
          modeRef.current = targetMode;
          setMode(targetMode);
          if (typeof window !== 'undefined') {
            (window as any).__INDICATRIX_MODE__ = targetMode;
          }
          switchedMode = true;
        }
        const p = Math.min(1.0, (elapsed - 280) / 350);
        const q = 1.0 - p;
        const easeOut = 1.0 - q * q * q;
        const curAlpha = Math.min(1.0, startAlpha * easeOut);
        alphaRef.current = curAlpha;
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_SCRUB_ALPHA__ = curAlpha;
        }
        telemetryStore.setLiveUnfurl(curAlpha);
        glideAnimRef.current = requestAnimationFrame(animate);
      } else {
        if (!switchedMode) {
          modeRef.current = targetMode;
          setMode(targetMode);
          if (typeof window !== 'undefined') {
            (window as any).__INDICATRIX_MODE__ = targetMode;
          }
        }
        glideAnimRef.current = null;
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_SCRUB_ALPHA__ = undefined;
          (window as any).__INDICATRIX_MODE__ = undefined;
        }
        alphaRef.current = startAlpha;
        setAlpha(startAlpha);
      }
    };
    glideAnimRef.current = requestAnimationFrame(animate);
  }, [cancelGlide, setAlpha]);

  useEffect(() => {
    if (isPlaying) {
      cancelGlide();
    }
  }, [isPlaying, cancelGlide]);

  useEffect(() => {
    return () => {
      if (glideAnimRef.current !== null) {
        cancelAnimationFrame(glideAnimRef.current);
        glideAnimRef.current = null;
      }
    };
  }, []);

  return {
    backend, setBackend,
    theme, setTheme,
    themePalette,
    hasWebGPU, setHasWebGPU,
    alpha, setAlpha,
    mode, setMode,
    layerMode, setLayerMode,
    cursorPhysicsEnabled, setCursorPhysicsEnabled,
    resolution, setResolution,
    fps, setFps,
    isHudOpen, setIsHudOpen,
    showVectors, setShowVectors,
    showToponymy, setShowToponymy,
    showCartouche, setShowCartouche,
    isPlaying, setIsPlaying,
    playDirection, setPlayDirection,
    playbackSpeed, setPlaybackSpeed,
    isZenMode, setIsZenMode,
    gpuReport, setGpuReport,
    dataInfo, setDataInfo,
    showClouds, setShowClouds,
    showCloudLow, setShowCloudLow,
    showCloudMid, setShowCloudMid,
    showCloudHigh, setShowCloudHigh,
    cloudDriftSpeed, setCloudDriftSpeed,
    cloudOpacity, setCloudOpacity,
    cloudFalseColor, setCloudFalseColor,
    volumetricClouds, setVolumetricClouds,
    cloudThickness, setCloudThickness,
    cloudLowTop, setCloudLowTop,
    cloudErosion, setCloudErosion,
    cloudFreqHoriz, setCloudFreqHoriz,
    cloudFreqVert, setCloudFreqVert,
    cloudExtinction, setCloudExtinction,
    setCloudOptions,
    cdlodDiagnosticMode, setCdlodDiagnosticMode,
    provenance, setProvenance,
    windSpeedMultiplier, setWindSpeedMultiplier,
    windParticleLifetime, setWindParticleLifetime,
    glideToAlpha,
    glideToMode,
    cancelGlide,
  };
}

export type EngineStateHook = ReturnType<typeof useEngineState>;
