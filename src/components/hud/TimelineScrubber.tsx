// ============================================================================
// File: src/components/hud/TimelineScrubber.tsx
// Atmospheric Chronology & Temporal Scrubber
// Continuous prognostic forecast scrubber from NOW (T+00:00) to +maxForecastHours
// ============================================================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { telemetryStore, useTelemetryLiveTimeline } from '../../core/TelemetryStore';
import { fetchWeatherNextMeta } from '../../core/data/weatherNextMetaLoader';

const PlayIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <polygon points="6 3 20 12 6 21 6 3" />
  </svg>
);

const PauseIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <rect x="14" y="4" width="4" height="16" rx="1" />
    <rect x="6" y="4" width="4" height="16" rx="1" />
  </svg>
);

const RotateCcwIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export interface TimelineScrubberState {
  absoluteMinutes: number;    // 0 to +maxForecastMinutes
  isForecastZone: boolean;    // true if > 0 (prognostic forecast)
  tau: number;                // 0.0-1.0 interpolation within current hour bracket
  bracketHour: number;        // Which forecast hour bracket (0 to maxForecastHours - 1)
  isPlaying: boolean;
}

export interface TimelineScrubberProps {
  onTimeChange?: (state: TimelineScrubberState) => void;
  className?: string;
  initialMinutes?: number;
  value?: number;
  initialPlaying?: boolean;
  initialSpeed?: 1 | 2 | 5 | 10;
  disabled?: boolean;
  maxForecastHours?: number;
  prognosticModel?: string;
  weatherNextDataSource?: any;
}

// Staged WeatherNext 3 default horizon from public/data/weathernext/meta.json (12 steps: H0..H11 -> +11h)
export const DEFAULT_MAX_FORECAST_HOURS = 11;
export const DEFAULT_MAX_FORECAST_MINUTES = DEFAULT_MAX_FORECAST_HOURS * 60;

/**
 * Computes the normalized track position u in [0, 1] for a given forecast minute (0 to +maxForecastMinutes)
 */
export function minutesToTrackPosition(
  minutes: number,
  maxForecastMinutes: number = DEFAULT_MAX_FORECAST_MINUTES
): number {
  if (isNaN(minutes)) return 0;
  const safeMax = Math.max(60, Number.isFinite(maxForecastMinutes) ? maxForecastMinutes : DEFAULT_MAX_FORECAST_MINUTES);
  const m = Math.max(0, Math.min(safeMax, minutes));
  return m / safeMax;
}

/**
 * Computes forecast minutes (0 to +maxForecastMinutes) from normalized track position u in [0, 1]
 */
export function trackPositionToMinutes(
  u: number,
  maxForecastMinutes: number = DEFAULT_MAX_FORECAST_MINUTES
): number {
  if (isNaN(u)) return 0;
  const safeMax = Math.max(60, Number.isFinite(maxForecastMinutes) ? maxForecastMinutes : DEFAULT_MAX_FORECAST_MINUTES);
  const clampedU = Math.max(0, Math.min(1, u));
  const m = clampedU * safeMax;
  // Clean IEEE-754 precision artifacts
  return Math.round(m * 10000) / 10000;
}

/**
 * Computes the full TimelineScrubberState given minutes and playback status
 */
export function computeTimelineState(
  minutes: number,
  isPlaying: boolean,
  maxForecastMinutes: number = DEFAULT_MAX_FORECAST_MINUTES
): TimelineScrubberState {
  const safeMax = Math.max(60, Number.isFinite(maxForecastMinutes) ? maxForecastMinutes : DEFAULT_MAX_FORECAST_MINUTES);
  const maxHours = Math.max(1, Math.round(safeMax / 60));
  const maxBracket = Math.max(0, maxHours - 1);
  const safeMinutes = isNaN(minutes) ? 0 : minutes;
  const rounded = Math.round(safeMinutes * 10000) / 10000;
  const clamped = Math.max(0, Math.min(safeMax, rounded));
  const isForecastZone = clamped > 0;

  let bracketHour = 0;
  let tau = 0.0;

  const totalHours = clamped / 60;
  if (totalHours >= maxHours) {
    bracketHour = maxBracket;
    tau = 1.0;
  } else {
    bracketHour = Math.min(maxBracket, Math.floor(totalHours));
    tau = Math.max(0.0, Math.min(1.0, totalHours - bracketHour));
  }

  return {
    absoluteMinutes: clamped,
    isForecastZone,
    tau,
    bracketHour,
    isPlaying: Boolean(isPlaying),
  };
}

const SPEED_OPTIONS: { id: 1 | 2 | 5 | 10; label: string }[] = [
  { id: 1, label: '1×' },
  { id: 2, label: '2×' },
  { id: 5, label: '5×' },
  { id: 10, label: '10×' },
];

function buildQuickJumpPresets(maxHours: number, modelLabel: string) {
  const base = [
    { label: 'NOW', minutes: 0, title: 'Observation Datum (NOW)', isDatum: true },
  ];
  const forecastHours =
    maxHours <= 12
      ? [
          Math.max(1, Math.round(maxHours * 0.25)),
          Math.max(2, Math.round(maxHours * 0.5)),
          Math.max(3, Math.round(maxHours * 0.75)),
          maxHours,
        ]
      : maxHours <= 48
      ? [6, 12, 24, maxHours]
      : [24, 48, 120, maxHours];
  const uniqueHours = Array.from(new Set(forecastHours.filter((h) => h > 0 && h <= maxHours)));
  return [
    ...base,
    ...uniqueHours.map((h) => ({
      label: `+${h}h`,
      minutes: h * 60,
      title: `${modelLabel} Forecast (+${h} Hours)`,
    })),
  ];
}

export const TimelineScrubber: React.FC<TimelineScrubberProps> = ({
  onTimeChange,
  className = '',
  initialMinutes = 0,
  value,
  initialPlaying = false,
  initialSpeed = 1,
  disabled = false,
  maxForecastHours: propMaxForecastHours,
  prognosticModel,
  weatherNextDataSource,
}) => {
  const [stagedMaxHours, setStagedMaxHours] = useState<number>(() => {
    const dsMeta =
      weatherNextDataSource?.metadata ??
      (typeof window !== 'undefined'
        ? (window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__?.metadata ||
          (window as any).__INDICATRIX_WEATHERNEXT_SOURCE__?.metadata
        : null);
    const endH = dsMeta?.timeHorizon?.endHour;
    if (typeof endH === 'number' && Number.isFinite(endH) && endH >= 1) {
      return Math.round(endH);
    }
    return DEFAULT_MAX_FORECAST_HOURS;
  });

  useEffect(() => {
    if (propMaxForecastHours !== undefined) return;
    const dsMeta =
      weatherNextDataSource?.metadata ??
      (typeof window !== 'undefined'
        ? (window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__?.metadata ||
          (window as any).__INDICATRIX_WEATHERNEXT_SOURCE__?.metadata
        : null);
    const endH = dsMeta?.timeHorizon?.endHour;
    if (typeof endH === 'number' && Number.isFinite(endH) && endH >= 1) {
      setStagedMaxHours(Math.round(endH));
      return;
    }
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
        const parsedEnd =
          typeof data?.timeHorizon?.endHour === 'number'
            ? data.timeHorizon.endHour
            : Array.isArray(data?.validPredictionHours) && data.validPredictionHours.length > 0
            ? data.validPredictionHours[data.validPredictionHours.length - 1]
            : undefined;
        if (typeof parsedEnd === 'number' && Number.isFinite(parsedEnd) && parsedEnd >= 1) {
          setStagedMaxHours(Math.round(parsedEnd));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [propMaxForecastHours, weatherNextDataSource]);

  const effectiveMaxHours = Math.max(
    1,
    Math.round(propMaxForecastHours !== undefined ? propMaxForecastHours : stagedMaxHours)
  );
  const effectiveMaxMinutes = effectiveMaxHours * 60;
  const maxMinutesRef = useRef<number>(effectiveMaxMinutes);
  maxMinutesRef.current = effectiveMaxMinutes;

  const isGfsModel = prognosticModel === 'gfs' || prognosticModel === 'noaa-gfs';
  const isSatelliteModel = prognosticModel === 'satellite' || prognosticModel === 'live-satellite';
  const activeModelBadge = isGfsModel ? 'NOAA GFS' : isSatelliteModel ? 'SAT → WN3' : 'WEATHERNEXT 3';
  const activeModelShort = isGfsModel ? 'NOAA GFS' : isSatelliteModel ? 'Sat → WeatherNext' : 'WeatherNext';

  const quickJumpPresets = useMemo(
    () => buildQuickJumpPresets(effectiveMaxHours, activeModelShort),
    [effectiveMaxHours, activeModelShort]
  );

  const forecastTicks = useMemo(() => {
    if (effectiveMaxHours <= 12) {
      const step = Math.max(1, Math.round(effectiveMaxHours / 4));
      const majors = new Set<number>([step, step * 2, step * 3, effectiveMaxHours].filter((h) => h > 0 && h <= effectiveMaxHours));
      return {
        majors: Array.from(majors).sort((a, b) => a - b),
        labeled: majors,
        minorCount: effectiveMaxHours,
        minorSkip: (h: number) => majors.has(h),
      };
    }
    const step = effectiveMaxHours <= 48 ? 6 : 24;
    const majors: number[] = [];
    for (let h = step; h < effectiveMaxHours; h += step) majors.push(h);
    majors.push(effectiveMaxHours);
    const labeled = new Set<number>(
      effectiveMaxHours <= 48
        ? [12, 24, 36, effectiveMaxHours].filter((h) => h <= effectiveMaxHours)
        : [48, 120, 180, effectiveMaxHours].filter((h) => h <= effectiveMaxHours)
    );
    return {
      majors,
      labeled,
      minorCount: Math.min(240, effectiveMaxHours),
      minorSkip: (h: number) => h % step === 0,
    };
  }, [effectiveMaxHours]);

  const liveTimeline = useTelemetryLiveTimeline();
  const [internalMinutes, setInternalMinutes] = useState<number>(() => Math.max(0, initialMinutes));
  const [dragMinutes, setDragMinutes] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(initialPlaying);
  const [speed, setSpeed] = useState<1 | 2 | 5 | 10>(initialSpeed);
  const [isHovered, setIsHovered] = useState<boolean>(false);

  const trackRef = useRef<HTMLDivElement>(null);
  const cachedRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const lastHandledNativeEventRef = useRef<Event | null>(null);

  const refreshCachedRect = useCallback(() => {
    const el = trackRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) {
      cachedRectRef.current = null;
      return null;
    }
    const snap = { left: r.left, top: r.top, width: r.width, height: r.height };
    cachedRectRef.current = snap;
    return snap;
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    refreshCachedRect();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      refreshCachedRect();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [refreshCachedRect]);

  useEffect(() => {
    telemetryStore.setLiveTimeline(null);
    return () => {
      telemetryStore.setLiveTimeline(null);
    };
  }, []);

  useEffect(() => {
    if (!isDraggingRef.current && !isPlaying) {
      telemetryStore.setLiveTimeline(null);
    }
  }, [value, isPlaying]);

  const resolvedMinutesSource =
    dragMinutes !== null
      ? dragMinutes
      : (isDraggingRef.current || isPlaying) && liveTimeline?.isScrubbing
      ? liveTimeline.timelineMinutes
      : value !== undefined
      ? value
      : liveTimeline?.isScrubbing
      ? liveTimeline.timelineMinutes
      : internalMinutes;

  // Synchronized refs for smooth requestAnimationFrame loop
  const minutesRef = useRef<number>(Math.max(0, resolvedMinutesSource));
  const isPlayingRef = useRef<boolean>(isPlaying);
  const speedRef = useRef<1 | 2 | 5 | 10>(speed);
  const onTimeChangeRef = useRef(onTimeChange);

  const currentMinutes = Math.max(0, Math.min(effectiveMaxMinutes, resolvedMinutesSource));
  minutesRef.current = currentMinutes;
  isPlayingRef.current = isPlaying;
  speedRef.current = speed;
  onTimeChangeRef.current = onTimeChange;

  const emitTimeChange = useCallback((min: number, playing: boolean, isScrubbing: boolean = false) => {
    const state = computeTimelineState(min, playing, maxMinutesRef.current);
    if (isScrubbing) {
      telemetryStore.setLiveTimeline({
        tau: state.tau,
        timelineMinutes: state.absoluteMinutes,
        bracketHour: state.bracketHour,
        isScrubbing: true,
      });
    } else {
      telemetryStore.setLiveTimeline(null);
    }
    onTimeChangeRef.current?.(state);
  }, []);

  const updateMinutes = useCallback(
    (newMinutes: number, isContinuousDrag: boolean = false) => {
      const safeMinutes = Number.isFinite(newMinutes) ? newMinutes : 0;
      const clamped = Math.max(0, Math.min(maxMinutesRef.current, safeMinutes));
      if (isContinuousDrag) {
        setDragMinutes(clamped);
      } else {
        setDragMinutes(null);
      }
      if (value === undefined) {
        setInternalMinutes(clamped);
      }
      minutesRef.current = clamped;
      emitTimeChange(clamped, isPlayingRef.current, isContinuousDrag);
    },
    [value, emitTimeChange]
  );

  // 120 FPS requestAnimationFrame animation loop (decoupled from value updates to prevent frame drops)
  useEffect(() => {
    if (!isPlaying) return;

    let lastTimestamp: number | null = null;
    let animationFrameId: number;

    // Base speed: 20 minutes per second at 1x multiplier (3s per forecast hour)
    const BASE_MINUTES_PER_SECOND = 20;

    const frame = (timestamp: number) => {
      if (lastTimestamp !== null) {
        const dtSec = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
        const deltaMinutes = BASE_MINUTES_PER_SECOND * speedRef.current * dtSec;
        const maxMin = maxMinutesRef.current;
        let next = minutesRef.current + deltaMinutes;

        // Loop seamlessly within [0, maxMin]
        if (next > maxMin) {
          next = (next - maxMin) % maxMin;
        }

        minutesRef.current = next;
        setDragMinutes(next);
        if (value === undefined) {
          setInternalMinutes(next);
        }
        const state = computeTimelineState(next, true, maxMin);
        telemetryStore.setLiveTimeline({
          tau: state.tau,
          timelineMinutes: state.absoluteMinutes,
          bracketHour: state.bracketHour,
          isScrubbing: true,
        });
        onTimeChangeRef.current?.(state);
      }
      lastTimestamp = timestamp;
      animationFrameId = requestAnimationFrame(frame);
    };

    animationFrameId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(animationFrameId);
      setDragMinutes(null);
      telemetryStore.setLiveTimeline(null);
    };
  }, [isPlaying, value]);

  const prevModelRef = useRef<string | undefined>(prognosticModel);

  useEffect(() => {
    if (prevModelRef.current === prognosticModel) return;
    prevModelRef.current = prognosticModel;
    if (prognosticModel === undefined) return;
    const isWn =
      prognosticModel === 'weathernext3' ||
      prognosticModel === 'google-weathernext3' ||
      prognosticModel === 'weathernext';
    if (!isWn) {
      if (isPlayingRef.current || isPlaying) {
        setIsPlaying(false);
        isPlayingRef.current = false;
      }
      isDraggingRef.current = false;
      lastHandledNativeEventRef.current = null;
      setDragMinutes(null);
      setInternalMinutes(0);
      minutesRef.current = 0;
      telemetryStore.setLiveTimeline(null);
    }
  }, [prognosticModel, isPlaying]);

  useEffect(() => {
    if (disabled) {
      if (isPlayingRef.current || isPlaying) {
        setIsPlaying(false);
        isPlayingRef.current = false;
      }
      isDraggingRef.current = false;
      lastHandledNativeEventRef.current = null;
      setDragMinutes(null);
      setInternalMinutes(0);
      minutesRef.current = 0;
      telemetryStore.setLiveTimeline(null);
    }
  }, [disabled, isPlaying]);

  const togglePlayback = useCallback(() => {
    if (disabled) return;
    const nextPlaying = !isPlaying;
    setIsPlaying(nextPlaying);
    isPlayingRef.current = nextPlaying;
    if (!nextPlaying) {
      setDragMinutes(null);
    }
    emitTimeChange(minutesRef.current, nextPlaying, false);
  }, [disabled, isPlaying, emitTimeChange]);

  const handlePointerCoord = useCallback(
    (clientX: number, isContinuousDrag: boolean = true) => {
      if (!trackRef.current || disabled) return;
      const rect = cachedRectRef.current ?? refreshCachedRect();
      if (!rect || rect.width <= 0) return;
      const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const u = relX / rect.width;
      const calculatedMinutes = trackPositionToMinutes(u, maxMinutesRef.current);
      updateMinutes(calculatedMinutes, isContinuousDrag);
    },
    [disabled, refreshCachedRect, updateMinutes]
  );

  const finalizeDrag = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    lastHandledNativeEventRef.current = null;
    const settled = minutesRef.current;
    setDragMinutes(null);
    emitTimeChange(settled, isPlayingRef.current, false);
  }, [emitTimeChange]);

  // Window-level pointer tracking for unbroken dragging outside element boundary
  useEffect(() => {
    const handleGlobalPointerMove = (e: PointerEvent) => {
      if (!isDraggingRef.current) return;
      if (lastHandledNativeEventRef.current === e) return;
      lastHandledNativeEventRef.current = e;
      handlePointerCoord(e.clientX, true);
    };
    const handleGlobalPointerUp = () => {
      finalizeDrag();
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
    };
  }, [handlePointerCoord, finalizeDrag]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    isDraggingRef.current = true;
    refreshCachedRect();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      // Ignore if setPointerCapture is unsupported
    }
    handlePointerCoord(e.clientX, true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || disabled) return;
    if (lastHandledNativeEventRef.current === e.nativeEvent) return;
    lastHandledNativeEventRef.current = e.nativeEvent;
    handlePointerCoord(e.clientX, true);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // Ignore if releasePointerCapture is unsupported
    }
    finalizeDrag();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = e.shiftKey ? 15 : 60;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      updateMinutes(currentMinutes - step);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      updateMinutes(currentMinutes + step);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      updateMinutes(currentMinutes - 360); // -6 hours
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      updateMinutes(currentMinutes + 360); // +6 hours
    } else if (e.key === 'Home' || e.key === '0' || e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      updateMinutes(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      updateMinutes(effectiveMaxMinutes);
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlayback();
    }
  };

  const handleStepperNudge = (dir: -1 | 1) => {
    if (disabled) return;
    updateMinutes(currentMinutes + dir * 60);
  };

  const thumbPositionPct = useMemo(() => {
    return minutesToTrackPosition(currentMinutes, effectiveMaxMinutes) * 100;
  }, [currentMinutes, effectiveMaxMinutes]);

  // Readout telemetry formatting
  const readout = useMemo(() => {
    const safeMin = Math.max(0, Number.isFinite(currentMinutes) ? currentMinutes : 0);
    const rounded = Math.round(safeMin);
    if (rounded === 0) {
      return {
        badge: isGfsModel && disabled ? '0H SNAPSHOT' : 'DATUM',
        badgeColor: 'border-[var(--theme-text-accent)] text-[var(--theme-text-accent)] bg-[var(--theme-text-accent-10)]',
        primary: 'NOW',
        secondary: isGfsModel && disabled ? '0h Analysis Snapshot (T+00:00)' : 'Observation Datum (T+00:00)',
        zoneText: 'Observation Datum',
        accentClass: 'text-[var(--theme-text-accent)] border-[var(--theme-text-accent-40)] bg-[var(--theme-text-accent-10)]',
      };
    } else {
      const totalHours = rounded / 60;
      const maxBracket = Math.max(0, effectiveMaxHours - 1);
      const bracketHour = Math.min(maxBracket, Math.floor(totalHours));
      const m = totalHours >= effectiveMaxHours ? 60 : rounded % 60;
      const tau = (m / 60).toFixed(2);
      const hoursStr = rounded % 60 === 0 ? `+${Math.floor(totalHours)}h` : `+${Math.floor(totalHours)}h ${rounded % 60}m`;
      return {
        badge: activeModelBadge,
        badgeColor: 'border-[var(--theme-status-sage-50)] text-[var(--theme-status-sage)] bg-[var(--theme-status-sage-15)]',
        primary: hoursStr,
        secondary: `Bracket H${bracketHour}..${bracketHour + 1} • τ=${tau}`,
        zoneText: `${activeModelShort} Forecast (+${effectiveMaxHours}h)`,
        accentClass: 'text-[var(--theme-status-sage)] border-[var(--theme-status-sage-40)] bg-[var(--theme-status-sage-10)]',
      };
    }
  }, [currentMinutes, effectiveMaxHours, activeModelBadge, activeModelShort]);

  return (
    <div
      className={`p-3 rounded-[2px] border border-[var(--theme-panel-border)] bg-[var(--theme-panel-bg)] text-[var(--theme-text-primary)] select-none space-y-2.5 transition-colors ${
        disabled ? 'opacity-50 pointer-events-none' : ''
      } ${className}`}
    >
      {/* -------------------------------------------------------------------- */}
      {/* 1. Header: Title, Telemetry & Fine-increment Steppers                */}
      {/* -------------------------------------------------------------------- */}
      <div className="flex items-center justify-between gap-2 text-micro font-mono">
        <div className="flex flex-col min-w-0 pr-1">
          <div className="flex items-center gap-1.5">
            <span className="font-bold uppercase tracking-wider text-[var(--theme-text-primary)] truncate text-body">
              Chronometric Scrubber
            </span>
            <span
              className={`text-nano font-bold uppercase px-1.5 py-px rounded-[1px] border shrink-0 transition-colors ${readout.badgeColor}`}
            >
              {readout.badge}
            </span>
          </div>
          <span className="text-nano opacity-70 text-[var(--theme-text-secondary)] truncate hidden sm:inline">
            {readout.secondary}
          </span>
        </div>

        {/* Value readout and Steppers */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => handleStepperNudge(-1)}
            disabled={disabled || currentMinutes <= 0}
            title="Step backward (-1h forecast)"
            className="tactile-press w-5 h-5 rounded-[1px] border border-[var(--theme-control-border)] bg-[var(--theme-control-bg)] hover:bg-[var(--theme-control-hover-bg)] text-[var(--theme-text-accent)] disabled:opacity-35 flex items-center justify-center font-bold text-body leading-none select-none transition-colors"
          >
            -
          </button>

          <span className={`font-mono font-bold tabular-nums text-body min-w-[50px] text-center px-1.5 py-0.5 rounded-[1px] border shadow-2xs transition-colors ${readout.accentClass}`}>
            {readout.primary}
          </span>

          <button
            type="button"
            onClick={() => handleStepperNudge(1)}
            disabled={disabled || currentMinutes >= effectiveMaxMinutes}
            title="Step forward (+1h forecast)"
            className="tactile-press w-5 h-5 rounded-[1px] border border-[var(--theme-control-border)] bg-[var(--theme-control-bg)] hover:bg-[var(--theme-control-hover-bg)] text-[var(--theme-text-accent)] disabled:opacity-35 flex items-center justify-center font-bold text-body leading-none select-none transition-colors"
          >
            +
          </button>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 2. Forecast Horizon Labels Header                                    */}
      {/* -------------------------------------------------------------------- */}
      <div className="relative h-4 text-nano font-mono text-[var(--theme-text-secondary)] px-0.5">
        <div className="absolute left-0.5 top-0 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--theme-text-accent)] shrink-0" />
          <span className="uppercase tracking-tight hidden sm:inline">Datum · NOW (T+00:00)</span>
          <span className="uppercase tracking-tight sm:hidden">NOW</span>
        </div>

        <div className="absolute right-0.5 top-0 flex items-center justify-end gap-1">
          <span className="uppercase tracking-tight hidden sm:inline">
            {isGfsModel && disabled
              ? 'Single-Snapshot Analysis (0h)'
              : `Forecast · ${activeModelShort} (+${effectiveMaxHours}h)`}
          </span>
          <span className="uppercase tracking-tight sm:hidden">
            {isGfsModel && disabled ? '0h Only' : `+${effectiveMaxHours}h`}
          </span>
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--theme-status-sage,#34d399)] shrink-0" />
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 3. Continuous Forecast Horizontal Slider Track                       */}
      {/* -------------------------------------------------------------------- */}
      <div className="relative pt-4 pb-1">
        <div
          ref={trackRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Atmospheric Timeline Scrubber"
          aria-valuemin={0}
          aria-valuemax={effectiveMaxMinutes}
          aria-valuenow={Math.round(currentMinutes)}
          aria-valuetext={`${readout.badge} ${readout.primary}`}
          data-testid="timeline-scrubber-track"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
          onPointerEnter={() => setIsHovered(true)}
          onPointerLeave={() => setIsHovered(false)}
          className={`relative w-full h-8 rounded-[2px] border flex items-center cursor-pointer select-none touch-none bg-[var(--theme-card-bg)] border-[var(--theme-card-border)] transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-[var(--theme-text-accent)] ${
            isHovered ? 'border-[var(--theme-card-border-hover)]' : ''
          }`}
        >
          {/* Forecast Track (NOW to +effectiveMaxHours, 100% width) */}
          <div
            className={`h-full relative overflow-hidden flex-1 transition-colors duration-150 ${
              currentMinutes > 0
                ? 'bg-[var(--theme-status-sage-15)] shadow-[inset_0_0_10px_var(--theme-control-active-ring)]'
                : 'bg-[var(--theme-status-slate-5)]'
            }`}
          >
            {/* Hourly & Major ticks in Forecast Track */}
            {forecastTicks.majors.map((h) => {
              const tickPct = (h / effectiveMaxHours) * 100;
              const isEnd = h === effectiveMaxHours;
              const showTickLabel = forecastTicks.labeled.has(h);
              return (
                <div
                  key={`forecast-major-tick-${h}`}
                  className="absolute top-0 bottom-0 border-l border-[var(--theme-control-border)] pointer-events-none"
                  style={{ left: `${tickPct}%` }}
                >
                  {showTickLabel && (
                    <span
                      className={`absolute bottom-0.5 text-nano font-mono text-[var(--theme-text-secondary)] opacity-60 hidden sm:inline ${
                        isEnd ? 'right-0.5' : 'left-0.5'
                      }`}
                    >
                      +{h}h
                    </span>
                  )}
                </div>
              );
            })}

            {/* Fine hourly ticks using theme-adaptive tick token */}
            {Array.from({ length: forecastTicks.minorCount }).map((_, idx) => {
              if (idx === 0 || forecastTicks.minorSkip(idx)) return null;
              const tickPct = (idx / forecastTicks.minorCount) * 100;
              return (
                <div
                  key={`forecast-minor-tick-${idx}`}
                  className="absolute top-1 bottom-1 w-[1px] pointer-events-none"
                  style={{ left: `${tickPct}%`, backgroundColor: 'var(--theme-slider-tick, rgba(240, 237, 230, 0.25))' }}
                />
              );
            })}
          </div>

          {/* Prominent NOW Datum Marker at 0% */}
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-[var(--theme-text-accent)] shadow-[0_0_8px_var(--theme-text-accent)] z-10 pointer-events-none"
            style={{ left: '0%' }}
          >
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-[var(--theme-text-accent)] rotate-45" />
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-[var(--theme-text-accent)] rotate-45" />
            <div className="absolute -top-3.5 left-0 px-1 py-px rounded-[1px] bg-[var(--theme-panel-bg)] border border-[var(--theme-text-accent)] text-[var(--theme-text-accent)] text-nano font-mono font-bold uppercase tracking-wider leading-none shadow-xs">
              NOW
            </div>
          </div>

          {/* Reticle Thumb Indicator */}
          <div
            className="absolute top-0 bottom-0 -translate-x-1/2 flex items-center justify-center pointer-events-none z-20"
            style={{ left: `${thumbPositionPct}%` }}
          >
            <div
              className={`w-2.5 h-7 rounded-[1px] shadow-[var(--theme-panel-shadow)] flex items-center justify-center transition-all ${
                currentMinutes > 0
                  ? 'bg-[var(--theme-status-sage)] border border-[var(--theme-status-sage)] shadow-[0_0_10px_var(--theme-control-active-ring)] text-[var(--theme-text-inverse)]'
                  : 'bg-[var(--theme-slider-thumb-bg)] border border-[var(--theme-slider-thumb-border)] shadow-[0_0_8px_var(--theme-text-accent)]'
              }`}
            >
              <div className="w-[1px] h-3.5 bg-black/40" />
            </div>
          </div>
        </div>

        {/* Accessible Range Input for Automated Tests (tabIndex=-1 and aria-hidden to prevent duplicate A11y tree node) */}
        <input
          type="range"
          min={0}
          max={effectiveMaxMinutes}
          step={1}
          value={Math.round(currentMinutes)}
          disabled={disabled}
          tabIndex={-1}
          aria-hidden="true"
          aria-label="Timeline Scrubber (Test Only)"
          onChange={(e) => {
            const val = parseFloat(e.target.value);
            if (Number.isFinite(val)) updateMinutes(val);
          }}
          onInput={(e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            if (Number.isFinite(val)) updateMinutes(val);
          }}
          data-testid="timeline-native-slider"
          className="sr-only"
        />
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 4. Controls Dock: Play/Pause, Loop Status & Playback Speed Selector   */}
      {/* -------------------------------------------------------------------- */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-[var(--theme-panel-border-50)]">
        {/* Play/Pause & Reset to Datum */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={togglePlayback}
            disabled={disabled}
            aria-label={isPlaying ? 'Pause timeline animation' : 'Play timeline animation'}
            className={`tactile-btn font-mono font-bold text-nano px-2 py-1 rounded-[2px] border transition-all flex items-center gap-1.5 ${
              isPlaying
                ? 'bg-[var(--theme-control-active-bg)] border-[var(--theme-control-active-border)] text-[var(--theme-control-active-text)] ring-1 ring-[var(--theme-control-active-ring)] shadow-xs'
                : 'bg-[var(--theme-control-bg)] border-[var(--theme-control-border)] text-[var(--theme-text-primary)] hover:bg-[var(--theme-control-hover-bg)]'
            }`}
          >
            {isPlaying ? (
              <>
                <PauseIcon className="w-3 h-3 text-[var(--theme-text-accent)]" />
                <span>PAUSE</span>
              </>
            ) : (
              <>
                <PlayIcon className="w-3 h-3 text-[var(--theme-text-accent)]" />
                <span>PLAY</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => updateMinutes(0)}
            disabled={disabled || currentMinutes === 0}
            title="Reset to NOW observation datum (T+00:00)"
            className="tactile-btn font-mono font-bold text-nano px-1.5 py-1 rounded-[2px] border border-[var(--theme-control-border)] bg-[var(--theme-control-bg)] hover:bg-[var(--theme-control-hover-bg)] text-[var(--theme-text-secondary)] hover:text-[var(--theme-text-primary)] flex items-center gap-1 disabled:opacity-40 transition-colors"
          >
            <RotateCcwIcon className="w-2.5 h-2.5" />
            <span className="hidden sm:inline">DATUM</span>
          </button>
        </div>

        {/* Speed Selector */}
        <div className="flex items-center gap-1">
          <span className="text-nano font-mono text-[var(--theme-text-secondary)] opacity-80 hidden sm:inline mr-0.5">
            SPEED:
          </span>
          <div className="inline-flex items-center p-0.5 rounded-[2px] border bg-[var(--theme-control-bg)] border-[var(--theme-control-border)] gap-0.5">
            {SPEED_OPTIONS.map((opt) => {
              const isSelected = speed === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={isSelected}
                  onClick={() => {
                    setSpeed(opt.id);
                    speedRef.current = opt.id;
                  }}
                  className={`tactile-btn font-mono font-bold text-nano px-1.5 py-0.5 rounded-[1px] transition-all ${
                    isSelected
                      ? 'bg-[var(--theme-control-active-bg)] text-[var(--theme-control-active-text)] border border-[var(--theme-control-active-border)] shadow-xs'
                      : 'text-[var(--theme-text-secondary)] hover:text-[var(--theme-text-primary)] hover:bg-[var(--theme-control-hover-bg)] border border-transparent'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 5. Quick-Jump Presets Bar                                            */}
      {/* -------------------------------------------------------------------- */}
      <div className="flex items-center justify-between gap-1 pt-0.5">
        {quickJumpPresets.map((preset) => {
          const isActive = Math.abs(currentMinutes - preset.minutes) < 3;
          return (
            <button
              key={preset.label}
              type="button"
              disabled={disabled}
              aria-pressed={isActive}
              title={preset.title}
              onClick={() => updateMinutes(preset.minutes)}
              className={`tactile-btn text-nano font-mono font-bold px-1.5 py-0.5 rounded-[1px] border transition-all flex-1 text-center truncate ${
                isActive
                  ? 'bg-[var(--theme-control-active-bg)] border-[var(--theme-control-active-border)] text-[var(--theme-control-active-text)] shadow-xs font-semibold'
                  : 'bg-[var(--theme-control-bg-60)] border-[var(--theme-control-border-60)] text-[var(--theme-text-secondary)] hover:text-[var(--theme-text-primary)] hover:bg-[var(--theme-control-hover-bg)]'
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
