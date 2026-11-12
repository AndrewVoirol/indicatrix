// ============================================================================
// File: src/components/hud/instruments/PrognosticModelCard.tsx
// Consolidated Prognostic Model & NWP Tensor Telemetry Instrument (Requirement R5)
// Consolidates: Model Selector, Variable Selector, Zarr v3 Provenance & Lead Time Scrubber
// Medium-Adaptive SVG: Cream (Synoptic Isobars), Cyanotype (CAD Voronoi Mesh), Tharp (Baroclinic Contours)
// Invariants: §2 (Clearance), §4 (Single-Border Enclosure), §24 (Zero-Recompile)
// ============================================================================

import React, { useRef, useState, useCallback, useMemo } from 'react';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { VernierSlider } from '../../ui/VernierSlider';
import { MeteorologicalProvenance } from '../../../core/data/WeatherNextDataSource';
import { useTelemetryLiveTimeline } from '../../../core/TelemetryStore';

export type PrognosticModelBackend =
  | 'noaa-gfs'
  | 'weathernext3'
  | 'google-weathernext3'
  | 'gfs'
  | 'weathernext'
  | 'satellite'
  | 'live-satellite';

export interface PrognosticModelCardProps {
  prognosticModel?: PrognosticModelBackend;
  model?: PrognosticModelBackend;
  onPrognosticModelChange?: (model: PrognosticModelBackend) => void;
  onModelChange?: (model: PrognosticModelBackend) => void;
  prognosticVariable?: string;
  variable?: string;
  onPrognosticVariableChange?: (variable: string) => void;
  onVariableChange?: (variable: string) => void;
  leadTimeHours?: number; // 0 to 240, default 24
  onLeadTimeChange?: (hours: number) => void;
  timelineMinutes?: number;
  onTimelineChange?: (minutes: number) => void;
  weatherNextDataSource?: any;
  onTogglePlanetaryLayer?: (id: string, force?: boolean) => void;
  theme?: 0 | 1 | 2; // 0: Marie Tharp, 1: Cream Rag, 2: Prussian Cyanotype
  isLight?: boolean;
  className?: string;
  provenance?: MeteorologicalProvenance;
  windSpeedMultiplier?: number;
  onWindSpeedMultiplierChange?: (v: number) => void;
  windParticleLifetime?: number;
  onWindParticleLifetimeChange?: (v: number) => void;
  isWindActive?: boolean;
  allowToggleOff?: boolean;
  isActive?: boolean;
}

export const PrognosticModelCard: React.FC<PrognosticModelCardProps> = ({
  prognosticModel: propModel,
  model: propModelAlias,
  onPrognosticModelChange,
  onModelChange,
  prognosticVariable: propVariable,
  variable: propVariableAlias,
  onPrognosticVariableChange,
  onVariableChange,
  leadTimeHours: propLeadTimeHours,
  onLeadTimeChange,
  timelineMinutes: propTimelineMinutes,
  onTimelineChange,
  weatherNextDataSource,
  onTogglePlanetaryLayer,
  theme: propTheme,
  isLight = false,
  className = '',
  provenance,
  windSpeedMultiplier: propWindSpeed,
  onWindSpeedMultiplierChange,
  windParticleLifetime: propWindLifetime,
  onWindParticleLifetimeChange,
  isWindActive = false,
  allowToggleOff = false,
  isActive = true,
}) => {
  const liveTimeline = useTelemetryLiveTimeline(isActive);
  const timelineMinutes = liveTimeline !== null ? liveTimeline.timelineMinutes : propTimelineMinutes;
  // 1. Dual-mode state management (Controlled with internal fallback)
  const [internalModel, setInternalModel] = useState<PrognosticModelBackend>('weathernext3');
  const [internalVariable, setInternalVariable] = useState<string>('total_precipitation_1hr_mean');
  const [internalLeadTime, setInternalLeadTime] = useState<number>(24);
  const [lastPulledLabel, setLastPulledLabel] = useState<string>('2026-11-11 04:43Z');
  const [satelliteObservedLabel, setSatelliteObservedLabel] = useState<string>('2026-11-11 16:39Z');
  const [gfsCycleLabel, setGfsCycleLabel] = useState<string>('20261111 12Z · f000');
  const [gfsIngestedLabel, setGfsIngestedLabel] = useState<string>('2026-11-11 16:38Z');

  React.useEffect(() => {
    if (typeof fetch !== 'function') return;
    if (
      (typeof navigator !== 'undefined' && /jsdom|HappyDOM/i.test(navigator.userAgent || '')) ||
      (typeof process !== 'undefined' && process.env?.VITEST && !(fetch as any)?.mock)
    ) {
      return;
    }
    let cancelled = false;
    Promise.resolve(fetch('/data/ingestion-status.json'))
      .then((res) => (res && res.ok && typeof res.json === 'function' ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const ts =
          data?.sources?.weathernext3?.ingestedAtUTC ||
          data?.feeds?.weathernext3?.lastPulledUTC ||
          data?.sources?.gfs?.ingestedAtUTC ||
          data?.feeds?.gfs?.lastPulledUTC ||
          data?.updatedAtUTC;
        if (typeof ts === 'string' && ts.includes('T')) {
          setLastPulledLabel(`${ts.slice(0, 10)} ${ts.slice(11, 16)}Z`);
        }
      })
      .catch(() => {});
    Promise.resolve(fetch('/data/weathernext/meta.json'))
      .then((res) => (res && res.ok && typeof res.json === 'function' ? res.json() : null))
      .then((wnData) => {
        if (cancelled || !wnData) return;
        const wnTs = wnData?.ingestedAtUTC;
        if (typeof wnTs === 'string' && wnTs.includes('T')) {
          setLastPulledLabel(`${wnTs.slice(0, 10)} ${wnTs.slice(11, 16)}Z`);
        }
      })
      .catch(() => {});
    Promise.resolve(fetch('/data/satellite-meta.json'))
      .then((res) => (res && res.ok && typeof res.json === 'function' ? res.json() : null))
      .then((satData) => {
        if (cancelled || !satData) return;
        const satTs = satData?.observationTimestampUTC || satData?.ingestedAtUTC;
        if (typeof satTs === 'string' && satTs.includes('T')) {
          setSatelliteObservedLabel(`${satTs.slice(0, 10)} ${satTs.slice(11, 16)}Z`);
        }
      })
      .catch(() => {});
    Promise.resolve(fetch('/data/gfs-wind-meta.json'))
      .then((res) => (res && res.ok && typeof res.json === 'function' ? res.json() : null))
      .then((gfsData) => {
        if (cancelled || !gfsData) return;
        if (gfsData?.modelRunDate && gfsData?.modelRunCycle) {
          const fh = typeof gfsData.forecastHour === 'string' ? gfsData.forecastHour.split(' ')[0] : 'f000';
          setGfsCycleLabel(`${gfsData.modelRunDate} ${gfsData.modelRunCycle} · ${fh}`);
        }
        const gfsTs = gfsData?.ingestedAtUTC;
        if (typeof gfsTs === 'string' && gfsTs.includes('T')) {
          setGfsIngestedLabel(`${gfsTs.slice(0, 10)} ${gfsTs.slice(11, 16)}Z`);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const rawModel =
    propModel !== undefined
      ? propModel
      : propModelAlias !== undefined
      ? propModelAlias
      : internalModel;

  const rawVariable =
    propVariable !== undefined
      ? propVariable
      : propVariableAlias !== undefined
      ? propVariableAlias
      : internalVariable;

  // Calculate lead time from prop, timelineMinutes, or internal state
  const leadTimeHours = useMemo(() => {
    if (propLeadTimeHours !== undefined && Number.isFinite(propLeadTimeHours)) {
      return Math.max(0, Math.min(240, Math.round(propLeadTimeHours / 6) * 6));
    }
    if (timelineMinutes !== undefined && Number.isFinite(timelineMinutes)) {
      if (timelineMinutes <= 0) return 0;
      return Math.max(0, Math.min(240, Math.floor(timelineMinutes / 60)));
    }
    return internalLeadTime;
  }, [propLeadTimeHours, timelineMinutes, internalLeadTime]);

  const activeTheme: 0 | 1 | 2 =
    propTheme !== undefined ? propTheme : isLight ? 1 : 0;

  // 2. Model Normalization & Synonyms
  const normalizedModel = useMemo<PrognosticModelBackend>(() => {
    if (rawModel === 'google-weathernext3' || rawModel === 'weathernext' || rawModel === 'weathernext3') {
      return 'weathernext3';
    }
    if (rawModel === 'satellite' || rawModel === 'live-satellite') {
      return 'satellite';
    }
    return 'gfs';
  }, [rawModel]);

  const isWeatherNext = normalizedModel === 'weathernext3';
  const isSatellite = normalizedModel === 'satellite';

  // 3. Variable Normalization & Synonyms
  const normalizedVariable = useMemo<string>(() => {
    if (rawVariable === 'none' || rawVariable === 'off') {
      return 'none';
    }
    if (
      rawVariable === 'tcwv' ||
      rawVariable === 'total_precipitation_1hr_mean' ||
      rawVariable === 'total_precipitation_6hr_mean' ||
      rawVariable === 'precipitation_6hr' ||
      rawVariable === 'precipitation'
    ) {
      return 'total_precipitation_1hr_mean';
    }
    if (rawVariable === 'cape' || rawVariable === 'temperature_2m_mean') {
      return 'temperature_2m_mean';
    }
    if (rawVariable === 'ivt' || rawVariable === 'wind_10m_vector') {
      return 'wind_10m_vector';
    }
    if (rawVariable === 'z500' || rawVariable === 'geopotential_500hpa') {
      return 'geopotential_500hpa';
    }
    return rawVariable || 'total_precipitation_1hr_mean';
  }, [rawVariable]);

  // Decoupled Wind Dynamics Visibility: active when wind variable is selected OR wind layer active
  const isWindVariable =
    normalizedVariable === 'wind_10m_vector' ||
    normalizedVariable === 'ivt' ||
    normalizedVariable.toLowerCase().includes('wind');

  const showWindDynamics = isWindVariable || Boolean(isWindActive);

  // Wind Advection Dynamics State & Direct Zero-Placebo Dispatch
  const [internalWindSpeed, setInternalWindSpeed] = useState<number>(1.0);
  const curWindSpeed = propWindSpeed !== undefined && Number.isFinite(propWindSpeed) ? propWindSpeed : internalWindSpeed;
  const handleWindSpeedChange = useCallback(
    (val: number) => {
      if (typeof val !== 'number' || !Number.isFinite(val)) return;
      const clamped = Math.max(0.1, Math.min(10.0, val));
      setInternalWindSpeed(clamped);
      onWindSpeedMultiplierChange?.(clamped);
      if (typeof window !== 'undefined') {
        if (typeof (window as any).__INDICATRIX_SET_WIND_SPEED_MULTIPLIER__ === 'function') {
          (window as any).__INDICATRIX_SET_WIND_SPEED_MULTIPLIER__(clamped);
        }
        const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__ || (window as any).__ENGINE;
        if (engine && typeof engine.setWindSpeedMultiplier === 'function') {
          engine.setWindSpeedMultiplier(clamped);
        }
      }
    },
    [onWindSpeedMultiplierChange]
  );

  const [internalWindLifetime, setInternalWindLifetime] = useState<number>(6.0);
  const curWindLifetime = propWindLifetime !== undefined && Number.isFinite(propWindLifetime) ? propWindLifetime : internalWindLifetime;
  const handleWindLifetimeChange = useCallback(
    (val: number) => {
      if (typeof val !== 'number' || !Number.isFinite(val)) return;
      const clamped = Math.max(1.0, Math.min(12.0, val));
      setInternalWindLifetime(clamped);
      onWindParticleLifetimeChange?.(clamped);
      if (typeof window !== 'undefined') {
        if (typeof (window as any).__INDICATRIX_SET_WIND_PARTICLE_LIFETIME__ === 'function') {
          (window as any).__INDICATRIX_SET_WIND_PARTICLE_LIFETIME__(clamped);
        }
        const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__ || (window as any).__ENGINE;
        if (engine && typeof engine.setWindParticleLifetime === 'function') {
          engine.setWindParticleLifetime(clamped);
        }
      }
    },
    [onWindParticleLifetimeChange]
  );

    // 5. Model & Variable Change Dispatchers
  const handleModelSelect = (nextModel: PrognosticModelBackend) => {
    setInternalModel(nextModel);
    onPrognosticModelChange?.(nextModel);
    onModelChange?.(nextModel);
    if (
      !onPrognosticModelChange &&
      !onModelChange &&
      typeof window !== 'undefined' &&
      (window as any).__INDICATRIX_SET_PROGNOSTIC_MODEL__
    ) {
      (window as any).__INDICATRIX_SET_PROGNOSTIC_MODEL__(nextModel);
    }
  };

  const handleVariableSelect = (nextVar: string) => {
    if (nextVar === 'wind_10m_vector' || nextVar === 'ivt') {
      const windCurrentlyOn =
        Boolean(isWindActive) || (Boolean(allowToggleOff) && normalizedVariable === 'wind_10m_vector');
      if (windCurrentlyOn) {
        onTogglePlanetaryLayer?.('noaa-gfs-wind', false);
        if (typeof window !== 'undefined') {
          const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
          live.showSurfaceWinds = false;
          live.showWind = false;
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
        }
        if (normalizedVariable === 'wind_10m_vector') {
          const offVar = allowToggleOff ? 'none' : 'total_precipitation_1hr_mean';
          setInternalVariable(offVar);
          onPrognosticVariableChange?.(offVar);
          onVariableChange?.(offVar);
        }
        return;
      }
      setInternalVariable(nextVar);
      onPrognosticVariableChange?.(nextVar);
      onVariableChange?.(nextVar);
      onTogglePlanetaryLayer?.('noaa-gfs-wind', true);
      if (typeof window !== 'undefined') {
        const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
        live.showSurfaceWinds = true;
        live.showWind = true;
        (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
      }
      if (
        !onPrognosticVariableChange &&
        !onVariableChange &&
        typeof window !== 'undefined' &&
        (window as any).__INDICATRIX_SET_PROGNOSTIC_VARIABLE__
      ) {
        (window as any).__INDICATRIX_SET_PROGNOSTIC_VARIABLE__(nextVar);
      }
      return;
    }

    const effectiveVar =
      Boolean(allowToggleOff) && normalizedVariable === nextVar ? 'none' : nextVar;
    setInternalVariable(effectiveVar);
    onPrognosticVariableChange?.(effectiveVar);
    onVariableChange?.(effectiveVar);
    if (
      !onPrognosticVariableChange &&
      !onVariableChange &&
      typeof window !== 'undefined' &&
      (window as any).__INDICATRIX_SET_PROGNOSTIC_VARIABLE__
    ) {
      (window as any).__INDICATRIX_SET_PROGNOSTIC_VARIABLE__(effectiveVar);
    }
  };


  // Model resolution and specification badges
  const modelMetadata = useMemo(() => {
    if (normalizedModel === 'weathernext3') {
      return { name: 'WeatherNext AI', res: '0.1° / 10km', tensor: 'GraphCast GNN / Zarr v3', badge: '0.1° AI' };
    }
    if (normalizedModel === 'satellite') {
      return {
        name: leadTimeHours > 0 ? 'Sat → WeatherNext AI' : 'NASA GIBS Live',
        res: '0.1° / IR+Vis',
        tensor: 'VIIRS Band I5 (11.45µm) · MODIS/VIIRS CTH & CF',
        badge: leadTimeHours > 0 ? 'SAT→AI' : 'LIVE SAT',
      };
    }
    return { name: 'NOAA GFS', res: '13km / 0.25°', tensor: 'Finite-Volume Cubed-Sphere', badge: '0.25° GFS' };
  }, [normalizedModel, leadTimeHours]);

  const themeClass = activeTheme === 0 ? 'prognostic-model-tharp' : activeTheme === 1 ? 'prognostic-model-cream' : 'prognostic-model-cyanotype';

  return (
    <div
      data-instrument="prognostic-model"
      aria-label="Prognostic Forecast Lead Time and NWP Tensor Grid"
      className={`p-2 rounded-[3px] border shadow-sm transition-all space-y-3 bg-[var(--theme-card-bg)] border-[var(--theme-card-border)] text-[var(--theme-text-primary)] ${themeClass} ${className}`}
    >
      {/* 1. Status Header & Lead Time */}
      <div className="flex items-start justify-between text-micro font-mono border-b border-[var(--theme-card-border-50)] pb-2 mb-2">
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--theme-pulse-indicator)] animate-pulse shrink-0" />
            <span className="font-bold tracking-wider text-[var(--theme-text-accent)] uppercase truncate">
              PROGNOSTIC MODEL
            </span>
          </div>
          <span className="text-nano text-[var(--theme-text-muted)] truncate pl-3" title="Numerical Weather Prediction & Tensor Telemetry">
            NWP & Tensor Telemetry
          </span>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-nano shrink-0">
          <span className="font-bold tabular-nums text-[var(--theme-text-primary)] pt-0.5">
            {modelMetadata.badge}
          </span>
          <span className="opacity-40">•</span>
          <span className="text-[var(--theme-text-secondary)]">Lead:</span>
          <span className="font-bold tabular-nums text-[var(--theme-text-accent)] text-micro bg-[var(--theme-instrument-caliper-badge-bg)] text-[var(--theme-instrument-caliper-badge-text)] px-1 rounded-[1px]">
            T+{leadTimeHours}h
          </span>
        </div>
      </div>

      {/* 2. Controls: Model & Variable */}
      <div className="space-y-2.5">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-nano font-mono px-0.5">
            <span className="font-bold text-[var(--theme-text-secondary)] uppercase tracking-wider">
              Simulation Engine
            </span>
            <span className="text-[var(--theme-text-muted)] text-nano">
              {modelMetadata.name} ({modelMetadata.res})
            </span>
          </div>
          <SegmentedControl<PrognosticModelBackend>
            size="sm"
            value={normalizedModel}
            onChange={handleModelSelect}
            className="grid grid-cols-3 gap-1 w-full font-mono text-body tracking-wider"
            options={[
              {
                id: 'weathernext3',
                domId: 'sidebar-model-weathernext',
                label: 'WeatherNext 3',
                sublabel: 'Graph Neural Net',
                title: 'Google DeepMind WeatherNext 3',
                className: 'w-full',
              },
              {
                id: 'satellite',
                domId: 'sidebar-model-satellite',
                label: 'Live Satellite',
                sublabel: 'NASA GIBS IR+Vis',
                title: 'NASA EOSDIS GIBS VIIRS Band I5 (11.45µm) + MODIS/VIIRS L2 CTH & CF 3D Cloud Retrievals',
                className: 'w-full',
              },
              {
                id: 'gfs',
                domId: 'sidebar-model-gfs',
                label: 'NOAA GFS',
                sublabel: 'Finite-Volume',
                title: 'NOAA GFS FV3',
                className: 'w-full',
              },
            ]}
          />
        </div>

      </div>

      {/* 3. Interactive Variable Matrix */}
      {isWeatherNext && (
        <div className="space-y-1 pt-1 border-t border-[var(--theme-card-border-30)] mt-2.5">
          <div className="flex items-center justify-between text-nano font-mono px-0.5 pb-1">
            <span className="font-bold text-[var(--theme-text-secondary)] uppercase tracking-wider">
              Prognostic Matrix
            </span>
            <span className="text-[var(--theme-text-muted)] text-nano">
              {(() => {
                const windActive = normalizedVariable === 'wind_10m_vector' || Boolean(isWindActive);
                if (normalizedVariable === 'wind_10m_vector' || (normalizedVariable === 'none' && windActive)) {
                  return '10m Velocity Vector';
                }
                if (normalizedVariable === 'none') {
                  return 'Overlay Off';
                }
                const scalarLabel =
                  normalizedVariable === 'temperature_2m_mean'
                    ? '2m Ambient Surface'
                    : normalizedVariable === 'geopotential_500hpa'
                    ? '500hPa Geopotential'
                    : 'Total Column Water';
                return windActive ? `${scalarLabel} + 10m Wind` : scalarLabel;
              })()}
            </span>
          </div>
          
          <div className="grid grid-cols-2 grid-rows-2 gap-[2px] w-full h-[144px]" role="group" aria-label="Prognostic Variable">
            {/* RAIN */}
            <button
              id="sidebar-variable-rain"
              type="button"
              aria-pressed={normalizedVariable === 'total_precipitation_1hr_mean'}
              onClick={() => handleVariableSelect('total_precipitation_1hr_mean')}
              className={`relative flex flex-col justify-between p-1.5 text-left rounded-[2px] overflow-hidden transition-all duration-300 outline-none border focus:ring-1 focus:ring-[var(--theme-text-accent)] ${
                normalizedVariable === 'total_precipitation_1hr_mean'
                  ? 'bg-[var(--theme-card-bg)] border-[var(--theme-text-accent)] shadow-[0_0_8px_var(--theme-panel-shadow)]'
                  : 'bg-[var(--theme-instrument-viewport-bg)] border-[var(--theme-instrument-viewport-border)] opacity-60 hover:opacity-100 hover:bg-[var(--theme-card-bg)]'
              }`}
            >
              <div className="relative z-10 w-full">
                <div className="font-mono text-micro font-bold text-[var(--theme-text-primary)] leading-tight tracking-wide">PRECIPITATION</div>
                <div className="font-mono text-pico text-[var(--theme-text-muted)] leading-tight mt-[2px]">Total Column Pluvial Mass</div>
              </div>
              <div className="relative z-10 font-mono text-pico text-[var(--theme-instrument-ink-secondary)] opacity-70">kg/m² (Σ)</div>
              
              {isActive && (
                <svg viewBox="0 0 140 70" className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="xMidYMid slice">
                  <defs>
                    <linearGradient id="rain-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--theme-text-accent)" stopOpacity="0.4" />
                      <stop offset="100%" stopColor="var(--theme-text-accent)" stopOpacity="0.05" />
                    </linearGradient>
                  </defs>
                  <g transform="translate(112, 38) scale(0.85)">
                    <path d="M 0,-15 L 25,-5 L 0,5 L -25,-5 Z" fill="url(#rain-grad)" stroke="var(--theme-text-accent)" strokeWidth="0.5" opacity="0.6"/>
                    <path d="M 0,-15 L 0,15 L -25,5 L -25,-5 Z" fill="url(#rain-grad)" stroke="var(--theme-text-accent)" strokeWidth="0.25" opacity="0.4"/>
                    <path d="M 0,-15 L 0,15 L 25,5 L 25,-5 Z" fill="url(#rain-grad)" stroke="var(--theme-text-accent)" strokeWidth="0.25" opacity="0.2"/>
                    
                    {/* Grid Base */}
                    <path d="M 0,15 L 25,5 L 0,-5 L -25,5 Z" fill="none" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="0.5" opacity="0.4" strokeDasharray="1,1"/>
                    <path d="M -12.5,10 L 12.5,0 M -12.5,0 L 12.5,10 M 0,15 L 0,-5 M -25,5 L 25,5" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="0.25" opacity="0.3"/>
                    
                    {/* Rain Stippling inside volume */}
                    <path d="M -10,-2 L -10,10 M 0,-5 L 0,5 M 10,-2 L 10,10 M -5,2 L -5,8 M 5,2 L 5,8" stroke="var(--theme-text-accent)" strokeWidth="0.75" strokeDasharray="1,2" opacity="0.8" strokeLinecap="round" />
                    
                    {/* Integral Brackets */}
                    <path d="M -30,-5 L -33,-5 L -33,15 L -30,15" fill="none" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="0.5" opacity="0.5" />
                    <text x="-37" y="8" fill="var(--theme-instrument-ink-secondary)" fontSize="8" fontFamily="serif" opacity="0.8">∫</text>
                  </g>
                </svg>
              )}
            </button>

            {/* TEMP */}
            <button
              id="sidebar-variable-temp"
              type="button"
              aria-pressed={normalizedVariable === 'temperature_2m_mean'}
              onClick={() => handleVariableSelect('temperature_2m_mean')}
              className={`relative flex flex-col justify-between p-1.5 text-left rounded-[2px] overflow-hidden transition-all duration-300 outline-none border focus:ring-1 focus:ring-[var(--theme-status-amber)] ${
                normalizedVariable === 'temperature_2m_mean'
                  ? 'bg-[var(--theme-card-bg)] border-[var(--theme-status-amber)] shadow-[0_0_8px_var(--theme-panel-shadow)]'
                  : 'bg-[var(--theme-instrument-viewport-bg)] border-[var(--theme-instrument-viewport-border)] opacity-60 hover:opacity-100 hover:bg-[var(--theme-card-bg)]'
              }`}
            >
              <div className="relative z-10 w-full">
                <div className="font-mono text-micro font-bold text-[var(--theme-text-primary)] leading-tight tracking-wide">TEMPERATURE</div>
                <div className="font-mono text-pico text-[var(--theme-text-muted)] leading-tight mt-[2px]">2m Surface Thermal Flux</div>
              </div>
              <div className="relative z-10 w-full text-right font-mono text-pico text-[var(--theme-instrument-ink-secondary)] opacity-70">°C / K</div>
              
              {isActive && (
                <svg viewBox="0 0 140 70" className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="xMidYMid slice">
                  <defs>
                    <linearGradient id="temp-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--theme-status-amber)" stopOpacity="0.4" />
                      <stop offset="100%" stopColor="var(--theme-status-amber)" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  <g transform="translate(52, 6) scale(0.82)">
                    {/* Gaussian Distribution Plot */}
                    <path d="M 0,60 Q 20,60 35,40 T 50,15 T 65,40 T 80,60" fill="url(#temp-fill)" opacity="0.6" />
                    <path d="M 0,60 Q 20,60 35,40 T 50,15 T 65,40 T 80,60" fill="none" stroke="var(--theme-status-amber)" strokeWidth="1.5" opacity="0.9" />
                    
                    {/* Plot Axes & Ticks */}
                    <path d="M -10,60 L 90,60" fill="none" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="0.5" opacity="0.5" />
                    <line x1="50" y1="15" x2="50" y2="60" stroke="var(--theme-status-amber)" strokeWidth="0.5" strokeDasharray="2,2" opacity="0.6" />
                    <text x="52" y="22" fill="var(--theme-status-amber)" fontSize="5" fontFamily="monospace" opacity="0.9">μ</text>
                    
                    <line x1="65" y1="40" x2="65" y2="60" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="0.5" strokeDasharray="1,1" opacity="0.6" />
                    <text x="67" y="48" fill="var(--theme-instrument-ink-secondary)" fontSize="5" fontFamily="monospace" opacity="0.9">+1σ</text>
                    
                    {/* Baseline gradient */}
                    <path d="M -10,40 L 90,40" fill="none" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="0.25" opacity="0.3" strokeDasharray="1,2" />
                  </g>
                </svg>
              )}
            </button>

            {/* WIND */}
            <button
              id="sidebar-variable-wind"
              type="button"
              aria-pressed={normalizedVariable === 'wind_10m_vector' || Boolean(isWindActive)}
              onClick={() => handleVariableSelect('wind_10m_vector')}
              className={`relative flex flex-col justify-between p-1.5 text-left rounded-[2px] overflow-hidden transition-all duration-300 outline-none border focus:ring-1 focus:ring-[var(--theme-status-sage)] ${
                normalizedVariable === 'wind_10m_vector' || Boolean(isWindActive)
                  ? 'bg-[var(--theme-card-bg)] border-[var(--theme-status-sage)] shadow-[0_0_8px_var(--theme-panel-shadow)]'
                  : 'bg-[var(--theme-instrument-viewport-bg)] border-[var(--theme-instrument-viewport-border)] opacity-60 hover:opacity-100 hover:bg-[var(--theme-card-bg)]'
              }`}
            >
              <div className="relative z-10 w-full">
                <div className="font-mono text-micro font-bold text-[var(--theme-text-primary)] leading-tight tracking-wide">SURFACE WIND</div>
                <div className="font-mono text-pico text-[var(--theme-text-muted)] leading-tight mt-[2px]">10m Velocity Vector Field</div>
              </div>
              <div className="relative z-10 font-mono text-pico text-[var(--theme-instrument-ink-secondary)] opacity-70">m/s (uv)</div>
              
              {isActive && (
                <svg viewBox="0 0 140 70" className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="xMidYMid slice">
                  <defs>
                    <linearGradient id="wind-grad1" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="var(--theme-status-sage)" stopOpacity="0.1" />
                      <stop offset="100%" stopColor="var(--theme-status-sage)" stopOpacity="0.9" />
                    </linearGradient>
                    <linearGradient id="wind-grad2" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="var(--theme-status-sage)" stopOpacity="0.0" />
                      <stop offset="100%" stopColor="var(--theme-status-sage)" stopOpacity="0.6" />
                    </linearGradient>
                  </defs>
                  <g transform="translate(66, 22) scale(0.82)">
                    <path d="M 0,35 C 20,10 50,15 70,35" fill="none" stroke="url(#wind-grad1)" strokeWidth="1.5" />
                    <polygon points="70,35 66,29 63,33" fill="var(--theme-status-sage)" />
                    
                    <path d="M -15,45 C 5,20 35,25 55,45" fill="none" stroke="url(#wind-grad2)" strokeWidth="1" strokeDasharray="3,2" />
                    <polygon points="55,45 51,39 48,43" fill="var(--theme-status-sage)" opacity="0.6" />
                    
                    <path d="M -30,55 C -10,30 20,35 40,55" fill="none" stroke="url(#wind-grad2)" strokeWidth="0.5" strokeDasharray="1,2" opacity="0.7"/>
                    <polygon points="40,55 36,49 33,53" fill="var(--theme-status-sage)" opacity="0.4" />
                    
                    <path d="M 75,18 A 5 5 0 1 1 70,13" fill="none" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="0.5" opacity="0.6" />
                    <polygon points="70,13 72,10 74,14" fill="var(--theme-instrument-ink-secondary)" opacity="0.6" />
                    <text x="56" y="16" fill="var(--theme-instrument-ink-secondary)" fontSize="5" fontFamily="monospace" opacity="0.8">∇×V</text>
                  </g>
                </svg>
              )}
            </button>

            {/* HEIGHT */}
            <button
              id="sidebar-variable-z500"
              type="button"
              aria-pressed={normalizedVariable === 'geopotential_500hpa'}
              onClick={() => handleVariableSelect('geopotential_500hpa')}
              className={`relative flex flex-col justify-between p-1.5 text-left rounded-[2px] overflow-hidden transition-all duration-300 outline-none border focus:ring-1 focus:ring-[var(--theme-text-accent)] ${
                normalizedVariable === 'geopotential_500hpa'
                  ? 'bg-[var(--theme-card-bg)] border-[var(--theme-text-accent)] shadow-[0_0_8px_var(--theme-panel-shadow)]'
                  : 'bg-[var(--theme-instrument-viewport-bg)] border-[var(--theme-instrument-viewport-border)] opacity-60 hover:opacity-100 hover:bg-[var(--theme-card-bg)]'
              }`}
            >
              <div className="relative z-10 w-full">
                <div className="font-mono text-micro font-bold text-[var(--theme-text-primary)] leading-tight tracking-wide">Z500 HEIGHT</div>
                <div className="font-mono text-pico text-[var(--theme-text-muted)] leading-tight mt-[2px]">500 hPa Geopotential</div>
              </div>
              <div className="relative z-10 font-mono text-pico text-[var(--theme-instrument-ink-secondary)] opacity-70">Z (gpm)</div>
              
              {isActive && (
                <svg viewBox="0 0 140 70" className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="xMidYMid slice">
                  <defs>
                    <radialGradient id="height-grad" cx="50%" cy="100%" r="100%">
                      <stop offset="0%" stopColor="var(--theme-text-accent)" stopOpacity="0.2" />
                      <stop offset="100%" stopColor="var(--theme-text-accent)" stopOpacity="0.0" />
                    </radialGradient>
                  </defs>
                  <g transform="translate(70, 5) scale(0.85)">
                    {/* Hypsometric Gradient Fill */}
                    <path d="M -10,30 C 20,10 50,10 80,30 L 80,74 L -10,74 Z" fill="url(#height-grad)" opacity="0.6" />
                    
                    {/* Contour Lines */}
                    <path d="M -10,30 C 20,10 50,10 80,30" fill="none" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="0.5" opacity="0.3" strokeDasharray="2,2" />
                    <path d="M 0,40 C 25,25 45,25 70,40" fill="none" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="0.75" opacity="0.5" />
                    <path d="M 10,50 C 30,40 40,40 60,50" fill="none" stroke="var(--theme-text-accent)" strokeWidth="1" opacity="0.8" />
                    <path d="M 20,60 C 27,55 33,55 40,60" fill="none" stroke="var(--theme-instrument-ink-secondary)" strokeWidth="1.25" opacity="1.0" strokeDasharray="4,2" />
                    
                    {/* Ridge Axis */}
                    <path d="M 35,20 L 35,70" fill="none" stroke="var(--theme-text-accent)" strokeWidth="0.75" strokeDasharray="1,2" opacity="0.6" />
                    <polygon points="35,20 33,24 37,24" fill="var(--theme-text-accent)" opacity="0.6" />
                    
                    {/* Data Labels */}
                    <rect x="25" y="37" width="20" height="6" fill="var(--theme-card-bg)" stroke="none" opacity="0.8" />
                    <text x="35" y="42" fill="var(--theme-instrument-ink-secondary)" textAnchor="middle" fontSize="4.5" fontFamily="monospace" opacity="0.9">5800</text>
                    
                    <text x="35" y="62" fill="var(--theme-text-accent)" textAnchor="middle" fontSize="6" fontFamily="monospace" fontWeight="bold">H</text>
                  </g>
                </svg>
              )}
            </button>
          </div>
        </div>
      )}

      {!isWeatherNext && (showWindDynamics || Boolean(onTogglePlanetaryLayer)) && (
        <div className="pt-2 mt-2 border-t border-[var(--theme-card-border-30)]">
          <button
            id="sidebar-surface-wind-toggle"
            type="button"
            aria-pressed={Boolean(isWindActive) || normalizedVariable === 'wind_10m_vector'}
            onClick={() => handleVariableSelect('wind_10m_vector')}
            className={`w-full flex items-center justify-between px-2 py-1.5 text-left rounded-[2px] transition-all duration-200 outline-none border focus:ring-1 focus:ring-[var(--theme-status-sage)] ${
              Boolean(isWindActive) || normalizedVariable === 'wind_10m_vector'
                ? 'bg-[var(--theme-card-bg)] border-[var(--theme-status-sage)] shadow-[0_0_8px_var(--theme-panel-shadow)]'
                : 'bg-[var(--theme-instrument-viewport-bg)] border-[var(--theme-instrument-viewport-border)] opacity-75 hover:opacity-100 hover:bg-[var(--theme-card-bg)]'
            }`}
          >
            <div className="flex flex-col">
              <span className="font-mono text-micro font-bold text-[var(--theme-text-primary)] leading-tight tracking-wide">
                SURFACE WIND
              </span>
              <span className="font-mono text-pico text-[var(--theme-text-muted)] leading-tight">
                10m Velocity Vector Field ({normalizedModel === 'satellite' ? 'WN3 10m' : 'GFS 10m'})
              </span>
            </div>
            <span className="font-mono text-nano font-bold uppercase px-1.5 py-0.5 rounded-[1px] border border-[var(--theme-control-border)] bg-[var(--theme-control-bg)] text-[var(--theme-text-secondary)]">
              {Boolean(isWindActive) || normalizedVariable === 'wind_10m_vector' ? 'ACTIVE · m/s' : 'OFF · m/s'}
            </span>
          </button>
        </div>
      )}

      {showWindDynamics && (
        <div className="pt-2 mt-2 border-t border-[var(--theme-card-border-30)] space-y-3">
          <VernierSlider
            id="wind-speed-multiplier-slider"
            label="Vector Wind Flow Advection"
            sublabel="Eulerian speed multiplier (Base: 1.0×)"
            value={curWindSpeed}
            onChange={handleWindSpeedChange}
            min={0.1}
            max={10.0}
            step={0.1}
            readout={`${curWindSpeed.toFixed(1)}×`}
          />
          <VernierSlider
            id="wind-particle-lifetime-slider"
            label="Streamline Particle Lifetime"
            sublabel="Dissipation bounds (Base: 6.0s)"
            value={curWindLifetime}
            onChange={handleWindLifetimeChange}
            min={1.0}
            max={12.0}
            step={0.5}
            readout={`${curWindLifetime.toFixed(1)}s`}
          />
        </div>
      )}

      {/* 5. Integrated Data Provenance */}
      {isWeatherNext && (
        <div className="p-2 rounded-[2px] border border-[var(--theme-control-border-60)] bg-[var(--theme-control-bg-40)] space-y-1.5 font-mono text-nano text-[var(--theme-text-muted)] mt-1.5">
          {/* Top Status Banner */}
          <div className="flex items-center justify-between border-b border-[var(--theme-control-border-30)] pb-1.5 mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[var(--theme-status-sage)] font-bold">● GCS Zarr v3</span>
              <span>•</span>
              <span>3-Slot Ring Buffer</span>
            </div>
            <span className="font-bold text-[var(--theme-text-primary)]">
              {leadTimeHours > 0 ? `+${leadTimeHours}h Forecast` : '0h Analysis'}
            </span>
          </div>

          {/* Detailed Provenance Metadata Grid */}
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-micro opacity-85">
            <div className="flex items-center justify-between">
              <span className="text-[var(--theme-text-secondary)]">Resolution:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">
                {provenance ? `${provenance.spatialResolutionDeg}° (~10 km)` : '0.1° (~10 km)'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--theme-text-secondary)]">Chunk Spec:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">256×256 FP16</span>
            </div>
            <div className="col-span-2 flex items-center justify-between">
              <span className="text-[var(--theme-text-secondary)]">Cycle:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">
                {provenance?.runTimestamp ? (provenance.runTimestamp.includes('T') ? provenance.runTimestamp.slice(11, 13) + 'Z Hybrid' : provenance.runTimestamp) : '00Z Hybrid'}
              </span>
            </div>
            <div className="col-span-2 flex items-center justify-between pt-0.5 border-t border-[var(--theme-control-border-20)]">
              <span className="text-[var(--theme-text-secondary)]">Last Pulled:</span>
              <span className="font-bold text-[var(--theme-text-primary)] truncate" title={lastPulledLabel}>
                {lastPulledLabel}
              </span>
            </div>
            {provenance && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--theme-text-secondary)]">Temporal Blend:</span>
                  <span className="font-bold text-[var(--theme-text-primary)]">
                    τ={(liveTimeline !== null ? liveTimeline.tau : provenance.temporalBlendTau).toFixed(2)} (Slot {provenance.activeSlotIndex})
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--theme-text-secondary)]">Valid Prediction:</span>
                  <span className="font-bold text-[var(--theme-text-primary)] truncate max-w-[85px]" title={provenance.validTimestamp}>
                    {provenance.validTimestamp.includes('T') ? provenance.validTimestamp.slice(11, 16) + 'Z' : provenance.validTimestamp}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {isSatellite && (
        <div className="p-2 rounded-[2px] border border-[var(--theme-control-border-60)] bg-[var(--theme-control-bg-40)] space-y-1.5 font-mono text-nano text-[var(--theme-text-muted)] mt-1.5">
          <div className="flex items-center justify-between border-b border-[var(--theme-control-border-30)] pb-1.5 mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[var(--theme-status-sage)] font-bold">● NASA EOSDIS GIBS</span>
              <span>•</span>
              <span>3D IR+Vis Retrieval</span>
            </div>
            <span className="font-bold text-[var(--theme-text-primary)]">
              {leadTimeHours > 0 ? `+${leadTimeHours}h WN3 Handoff` : '0h Observed NOW'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-micro opacity-85">
            <div className="flex items-center justify-between">
              <span className="text-[var(--theme-text-secondary)]">Resolution:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">0.1° (~10 km)</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--theme-text-secondary)]">Strata:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">FP16 Low/Mid/High + τ</span>
            </div>
            <div className="col-span-2 flex items-center justify-between">
              <span className="text-[var(--theme-text-secondary)]">Constellation:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">VIIRS 11.45µm · MODIS/VIIRS CTH & CF</span>
            </div>
            <div className="col-span-2 flex items-center justify-between pt-0.5 border-t border-[var(--theme-control-border-20)]">
              <span className="text-[var(--theme-text-secondary)]">Observed UTC:</span>
              <span className="font-bold text-[var(--theme-text-primary)] truncate" title={satelliteObservedLabel}>
                {satelliteObservedLabel}
              </span>
            </div>
            <div className="col-span-2 flex items-center justify-between pt-0.5 border-t border-[var(--theme-control-border-20)]">
              <span className="text-[var(--theme-text-secondary)]">Forecast Handoff:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">
                {leadTimeHours > 0 ? `Active → WeatherNext 3 (+${leadTimeHours}h)` : 'NOW Observed (Scrub +1h → AI)'}
              </span>
            </div>
          </div>
        </div>
      )}

      {!isWeatherNext && !isSatellite && (
        <div className="p-2 rounded-[2px] border border-[var(--theme-control-border-60)] bg-[var(--theme-control-bg-40)] space-y-1.5 font-mono text-nano text-[var(--theme-text-muted)] mt-1.5">
          <div className="flex items-center justify-between border-b border-[var(--theme-control-border-30)] pb-1.5 mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[var(--theme-status-sage)] font-bold">● NOAA NOMADS 0.25°</span>
              <span>•</span>
              <span>FV3 Operational</span>
            </div>
            <span className="font-bold text-[var(--theme-text-primary)]">0h Analysis</span>
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-micro opacity-85">
            <div className="flex items-center justify-between">
              <span className="text-[var(--theme-text-secondary)]">Resolution:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">0.25° (1440×721)</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--theme-text-secondary)]">Levels:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">10m · 500 · 250 hPa</span>
            </div>
            <div className="col-span-2 flex items-center justify-between">
              <span className="text-[var(--theme-text-secondary)]">Run Cycle:</span>
              <span className="font-bold text-[var(--theme-text-primary)]">{gfsCycleLabel}</span>
            </div>
            <div className="col-span-2 flex items-center justify-between pt-0.5 border-t border-[var(--theme-control-border-20)]">
              <span className="text-[var(--theme-text-secondary)]">Ingested UTC:</span>
              <span className="font-bold text-[var(--theme-text-primary)] truncate" title={gfsIngestedLabel}>
                {gfsIngestedLabel}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PrognosticModelCard;
