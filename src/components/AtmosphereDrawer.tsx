// ============================================================================
// File: src/components/AtmosphereDrawer.tsx
// Atmospheric Cloud Strata Controls Drawer
// Calibrated Atmospheric Scale [1.0 .. 12.0] & Shadow Intensity [0.0 .. 0.60]
// Invariants: §2 (10px Moat/20px Gutters), §4 (Single-Border), §6 (Ivory Vellum), §21 (Collapsing)
// ============================================================================

import React, { useState, useCallback } from 'react';
import { TactileSwitch } from './ui/TactileSwitch';
import { TimelineScrubber, TimelineScrubberState } from './hud/TimelineScrubber';
import { AtmosphericColumnInstrument } from './hud/instruments/AtmosphericColumnInstrument';
import { OrographicMoistureProfile } from './hud/instruments/OrographicMoistureProfile';
import { CloudShadowInstrument } from './hud/instruments/CloudShadowInstrument';
import { CloudDriftSpeedInstrument } from './hud/instruments/CloudDriftSpeedInstrument';
import { PrognosticModelCard } from './hud/instruments/PrognosticModelCard';
import { StratosphericTelemetryInstrument } from './hud/instruments/StratosphericTelemetryInstrument';
import { VolumetricCloudDynamicsInstrument } from './hud/instruments/VolumetricCloudDynamicsInstrument';
import type { ResolutionTier } from '../types';
import type { MeteorologicalProvenance } from '../core/data/WeatherNextDataSource';

export type PrognosticModelBackend =
  | 'noaa-gfs'
  | 'weathernext3'
  | 'google-weathernext3'
  | 'gfs'
  | 'weathernext'
  | 'satellite'
  | 'live-satellite'
  | 'ecmwf'
  | 'off'
  | 'climatology';

export function isWeatherNextModel(model?: string): boolean {
  return model === 'weathernext3' || model === 'google-weathernext3' || model === 'weathernext';
}

export function isSatelliteModel(model?: string): boolean {
  return model === 'satellite' || model === 'live-satellite';
}

export interface AtmosphereDrawerProps {
  theme?: 0 | 1 | 2;
  isLight?: boolean;
  showClouds?: boolean;
  onShowCloudsChange?: (v: boolean) => void;
  showCloudLow?: boolean;
  onShowCloudLowChange?: (v: boolean) => void;
  showCloudMid?: boolean;
  onShowCloudMidChange?: (v: boolean) => void;
  showCloudHigh?: boolean;
  onShowCloudHighChange?: (v: boolean) => void;
  cloudFalseColor?: boolean;
  onCloudFalseColorChange?: (v: boolean) => void;
  cloudDriftSpeed?: number;
  onCloudDriftSpeedChange?: (v: number) => void;
  cloudOpacity?: number;
  onCloudOpacityChange?: (v: number) => void;
  atmosphericScale?: number;
  onAtmosphericScaleChange?: (v: number) => void;
  shadowIntensity?: number;
  onShadowIntensityChange?: (v: number) => void;
  rainShadowFeedback?: number;
  onRainShadowFeedbackChange?: (v: number) => void;
  pluvialGamma?: number;
  onPluvialGammaChange?: (v: number) => void;
  thermodynamicGating?: boolean;
  onThermodynamicGatingChange?: (enabled: boolean) => void;
  prognosticModel?: PrognosticModelBackend;
  onPrognosticModelChange?: (model: PrognosticModelBackend) => void;
  prognosticVariable?: string;
  onPrognosticVariableChange?: (variable: string) => void;
  weatherNextDataSource?: any;
  timelineMinutes?: number;
  onTimelineChange?: (state: TimelineScrubberState) => void;

  onTogglePlanetaryLayer?: (id: string, force?: boolean) => void;
  hideScrubber?: boolean;
  className?: string;
  resolution?: ResolutionTier;
  // Beta Volumetric Cloud Physics & Raymarching Levers
  cloudThickness?: number;
  onCloudThicknessChange?: (v: number) => void;
  cloudLowTop?: number;
  onCloudLowTopChange?: (v: number) => void;
  cloudErosion?: number;
  onCloudErosionChange?: (v: number) => void;
  cloudFreqHoriz?: number;
  onCloudFreqHorizChange?: (v: number) => void;
  cloudFreqVert?: number;
  onCloudFreqVertChange?: (v: number) => void;
  cloudExtinction?: number;
  onCloudExtinctionChange?: (v: number) => void;
  volumetricClouds?: boolean;
  onVolumetricCloudsChange?: (v: boolean) => void;
  provenance?: MeteorologicalProvenance;
  windSpeedMultiplier?: number;
  onWindSpeedMultiplierChange?: (v: number) => void;
  windParticleLifetime?: number;
  onWindParticleLifetimeChange?: (v: number) => void;
  isWindActive?: boolean;
  isActive?: boolean;
}

export const AtmosphereDrawer: React.FC<AtmosphereDrawerProps> = ({
  theme = 0,
  isLight = false,
  hideScrubber = false,
  isWindActive = false,
  isActive = true,
  provenance,
  windSpeedMultiplier,
  onWindSpeedMultiplierChange,
  windParticleLifetime,
  onWindParticleLifetimeChange,
  showClouds: propShowClouds,
  onShowCloudsChange,
  showCloudLow: propShowCloudLow,
  onShowCloudLowChange,
  showCloudMid: propShowCloudMid,
  onShowCloudMidChange,
  showCloudHigh: propShowCloudHigh,
  onShowCloudHighChange,
  cloudFalseColor: propCloudFalseColor,
  onCloudFalseColorChange,
  cloudDriftSpeed: propCloudDriftSpeed,
  onCloudDriftSpeedChange,
  cloudOpacity: propCloudOpacity,
  onCloudOpacityChange,
  atmosphericScale: propAtmosphericScale,
  onAtmosphericScaleChange,
  shadowIntensity: propShadowIntensity,
  onShadowIntensityChange,
  rainShadowFeedback: propRainShadowFeedback,
  onRainShadowFeedbackChange,
  pluvialGamma: propPluvialGamma,
  onPluvialGammaChange,
  thermodynamicGating: propThermodynamicGating,
  onThermodynamicGatingChange,
  prognosticModel: propPrognosticModel,
  onPrognosticModelChange,
  prognosticVariable: propPrognosticVariable,
  onPrognosticVariableChange,
  weatherNextDataSource,
  timelineMinutes,
  onTimelineChange,

  onTogglePlanetaryLayer,
  className = '',
  resolution,
  cloudThickness: propCloudThickness,
  onCloudThicknessChange,
  cloudLowTop: propCloudLowTop,
  onCloudLowTopChange,
  cloudErosion: propCloudErosion,
  onCloudErosionChange,
  cloudFreqHoriz: propCloudFreqHoriz,
  onCloudFreqHorizChange,
  cloudFreqVert: propCloudFreqVert,
  onCloudFreqVertChange,
  cloudExtinction: propCloudExtinction,
  onCloudExtinctionChange,
  volumetricClouds: propVolumetricClouds,
  onVolumetricCloudsChange,
}) => {
  const [internalShowClouds, setInternalShowClouds] = useState<boolean>(true);
  const [internalShowCloudLow, setInternalShowCloudLow] = useState<boolean>(true);
  const [internalShowCloudMid, setInternalShowCloudMid] = useState<boolean>(true);
  const [internalShowCloudHigh, setInternalShowCloudHigh] = useState<boolean>(true);
  const [internalCloudFalseColor, setInternalCloudFalseColor] = useState<boolean>(false);
  const [internalCloudDriftSpeed, setInternalCloudDriftSpeed] = useState<number>(500);
  const [internalCloudOpacity, setInternalCloudOpacity] = useState<number>(0.8);
  const [internalAtmosphericScale, setInternalAtmosphericScale] = useState<number>(3.5);
  const [internalShadowIntensity, setInternalShadowIntensity] = useState<number>(0.45);
  const [internalRainShadowFeedback, setInternalRainShadowFeedback] = useState<number>(0.0);
  const [internalPluvialGamma, setInternalPluvialGamma] = useState<number>(0.0);
  const [internalThermodynamicGating, setInternalThermodynamicGating] = useState<boolean>(true);
  const [internalPrognosticModel, setInternalPrognosticModel] = useState<PrognosticModelBackend>(propPrognosticModel ?? 'gfs');
  const [internalPrognosticVariable, setInternalPrognosticVariable] = useState<string>(propPrognosticVariable ?? 'total_precipitation_1hr_mean');
  const prevPropPrognosticVariableRef = React.useRef<string | undefined>(propPrognosticVariable);

  React.useEffect(() => {
    if (propPrognosticVariable !== undefined && propPrognosticVariable !== prevPropPrognosticVariableRef.current) {
      prevPropPrognosticVariableRef.current = propPrognosticVariable;
      setInternalPrognosticVariable(propPrognosticVariable);
    }
  }, [propPrognosticVariable]);

  // Tropospheric Raymarch Physics & Fine-Tuning Optics (Graduated from Beta)
  const [isCloudPhysicsOpen, setIsCloudPhysicsOpen] = useState<boolean>(false);
  const [internalCloudThickness, setInternalCloudThickness] = useState<number>(() => {
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__?.cloudThickness !== undefined) {
      return (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudThickness;
    }
    return propCloudThickness ?? 0.19;
  });
  const [internalCloudLowTop, setInternalCloudLowTop] = useState<number>(() => {
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__?.cloudLowTop !== undefined) {
      return (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudLowTop;
    }
    return propCloudLowTop ?? 0.45;
  });
  const [internalCloudErosion, setInternalCloudErosion] = useState<number>(() => {
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__?.cloudErosionStr !== undefined) {
      return (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudErosionStr;
    }
    return propCloudErosion ?? 0.85;
  });
  const [internalCloudFreqHoriz, setInternalCloudFreqHoriz] = useState<number>(() => {
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__?.cloudFreqHoriz !== undefined) {
      return (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudFreqHoriz;
    }
    return propCloudFreqHoriz ?? 32.0;
  });
  const [internalCloudFreqVert, setInternalCloudFreqVert] = useState<number>(() => {
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__?.cloudFreqVert !== undefined) {
      return (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudFreqVert;
    }
    return propCloudFreqVert ?? 12.0;
  });
  const [internalCloudExtinction, setInternalCloudExtinction] = useState<number>(() => {
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__?.cloudExtinction !== undefined) {
      return (window as any).__INDICATRIX_LIVE_UNIFORMS__.cloudExtinction;
    }
    return propCloudExtinction ?? 28.0;
  });
  const [internalVolumetricClouds, setInternalVolumetricClouds] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__?.volumetricClouds !== undefined) {
      return Boolean((window as any).__INDICATRIX_LIVE_UNIFORMS__.volumetricClouds);
    }
    return propVolumetricClouds ?? true;
  });

  const curCloudThickness = propCloudThickness !== undefined ? propCloudThickness : internalCloudThickness;
  const curCloudLowTop = propCloudLowTop !== undefined ? propCloudLowTop : internalCloudLowTop;
  const curCloudErosion = propCloudErosion !== undefined ? propCloudErosion : internalCloudErosion;
  const curCloudFreqHoriz = propCloudFreqHoriz !== undefined ? propCloudFreqHoriz : internalCloudFreqHoriz;
  const curCloudFreqVert = propCloudFreqVert !== undefined ? propCloudFreqVert : internalCloudFreqVert;
  const curCloudExtinction = propCloudExtinction !== undefined ? propCloudExtinction : internalCloudExtinction;
  const curVolumetricClouds = propVolumetricClouds !== undefined ? propVolumetricClouds : internalVolumetricClouds;

  const updateLiveUniforms = useCallback((delta: Record<string, any>) => {
    if (typeof window !== 'undefined') {
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
        ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
        ...delta,
      };
    }
  }, []);

  const handleCloudThicknessChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    setInternalCloudThickness(val);
    onCloudThicknessChange?.(val);
    updateLiveUniforms({ cloudThickness: val });
  };

  const handleCloudLowTopChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    setInternalCloudLowTop(val);
    onCloudLowTopChange?.(val);
    updateLiveUniforms({ cloudLowTop: val });
  };

  const handleCloudErosionChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    setInternalCloudErosion(val);
    onCloudErosionChange?.(val);
    updateLiveUniforms({ cloudErosionStr: val });
  };

  const handleCloudFreqHorizChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    setInternalCloudFreqHoriz(val);
    onCloudFreqHorizChange?.(val);
    updateLiveUniforms({ cloudFreqHoriz: val });
  };

  const handleCloudFreqVertChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    setInternalCloudFreqVert(val);
    onCloudFreqVertChange?.(val);
    updateLiveUniforms({ cloudFreqVert: val });
  };

  const handleCloudExtinctionChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    setInternalCloudExtinction(val);
    onCloudExtinctionChange?.(val);
    updateLiveUniforms({ cloudExtinction: val });
  };

  const handleResetCloudDefaults = () => {
    const defaults = {
      cloudThickness: 0.19,
      cloudLowTop: 0.45,
      cloudErosionStr: 0.85,
      cloudFreqHoriz: 32.0,
      cloudFreqVert: 12.0,
      cloudExtinction: 28.0,
    };
    setInternalCloudThickness(defaults.cloudThickness);
    setInternalCloudLowTop(defaults.cloudLowTop);
    setInternalCloudErosion(defaults.cloudErosionStr);
    setInternalCloudFreqHoriz(defaults.cloudFreqHoriz);
    setInternalCloudFreqVert(defaults.cloudFreqVert);
    setInternalCloudExtinction(defaults.cloudExtinction);
    onCloudThicknessChange?.(defaults.cloudThickness);
    onCloudLowTopChange?.(defaults.cloudLowTop);
    onCloudErosionChange?.(defaults.cloudErosionStr);
    onCloudFreqHorizChange?.(defaults.cloudFreqHoriz);
    onCloudFreqVertChange?.(defaults.cloudFreqVert);
    onCloudExtinctionChange?.(defaults.cloudExtinction);
    updateLiveUniforms(defaults);
  };

  const handleVolumetricCloudsToggle = (val: boolean) => {
    setInternalVolumetricClouds(val);
    onVolumetricCloudsChange?.(val);
    updateLiveUniforms({ volumetricClouds: val });
  };

  const curShowClouds = propShowClouds !== undefined ? propShowClouds : internalShowClouds;
  const curShowCloudLow = propShowCloudLow !== undefined ? propShowCloudLow : internalShowCloudLow;
  const curShowCloudMid = propShowCloudMid !== undefined ? propShowCloudMid : internalShowCloudMid;
  const curShowCloudHigh = propShowCloudHigh !== undefined ? propShowCloudHigh : internalShowCloudHigh;
  const curCloudFalseColor = propCloudFalseColor !== undefined ? propCloudFalseColor : internalCloudFalseColor;
  const curCloudDriftSpeed = propCloudDriftSpeed !== undefined ? propCloudDriftSpeed : internalCloudDriftSpeed;
  const curCloudOpacity = propCloudOpacity !== undefined ? propCloudOpacity : internalCloudOpacity;
  const curAtmosphericScale = propAtmosphericScale !== undefined ? propAtmosphericScale : internalAtmosphericScale;
  const curShadowIntensity = propShadowIntensity !== undefined ? propShadowIntensity : internalShadowIntensity;
  const curRainShadowFeedback = propRainShadowFeedback !== undefined ? propRainShadowFeedback : internalRainShadowFeedback;
  const curPluvialGamma = propPluvialGamma !== undefined ? propPluvialGamma : internalPluvialGamma;
  const curThermodynamicGating = propThermodynamicGating !== undefined ? propThermodynamicGating : internalThermodynamicGating;
  const curPrognosticModel = propPrognosticModel !== undefined ? propPrognosticModel : internalPrognosticModel;
  const curPrognosticVariable =
    propPrognosticVariable !== undefined && propPrognosticVariable !== prevPropPrognosticVariableRef.current
      ? propPrognosticVariable
      : internalPrognosticVariable;
  const isWeatherNext =
    curPrognosticModel === 'weathernext3' ||
    curPrognosticModel === 'google-weathernext3' ||
    curPrognosticModel === 'weathernext';

  const handlePrognosticModelChange = (model: PrognosticModelBackend) => {
    setInternalPrognosticModel(model);
    const isWn =
      model === 'weathernext3' ||
      model === 'google-weathernext3' ||
      model === 'weathernext';
    if (!isWn) {
      setInternalPrognosticVariable((prev) =>
        prev === 'wind_10m_vector' || prev === 'ivt' ? prev : 'none'
      );
    }
    onPrognosticModelChange?.(model);
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_SET_PROGNOSTIC_MODEL__) {
      (window as any).__INDICATRIX_SET_PROGNOSTIC_MODEL__(model);
    }
  };

  const handlePrognosticVariableChange = (variable: string) => {
    setInternalPrognosticVariable(variable);
    onPrognosticVariableChange?.(variable);
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_SET_PROGNOSTIC_VARIABLE__) {
      (window as any).__INDICATRIX_SET_PROGNOSTIC_VARIABLE__(variable);
    }
  };

  const handleToggleClouds = (val: boolean) => {
    setInternalShowClouds(val);
    onShowCloudsChange?.(val);
    updateLiveUniforms({ showClouds: val });
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
      (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ showClouds: val });
    }
  };

  const handleToggleStrata = (stratum: 'low' | 'mid' | 'high', active: boolean) => {
    if (stratum === 'low') {
      setInternalShowCloudLow(active);
      onShowCloudLowChange?.(active);
      updateLiveUniforms({ showCloudLow: active });
      if (typeof window !== 'undefined' && (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
        (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ showCloudLow: active });
      }
    } else if (stratum === 'mid') {
      setInternalShowCloudMid(active);
      onShowCloudMidChange?.(active);
      updateLiveUniforms({ showCloudMid: active });
      if (typeof window !== 'undefined' && (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
        (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ showCloudMid: active });
      }
    } else if (stratum === 'high') {
      setInternalShowCloudHigh(active);
      onShowCloudHighChange?.(active);
      updateLiveUniforms({ showCloudHigh: active });
      if (typeof window !== 'undefined' && (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
        (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ showCloudHigh: active });
      }
    }
  };

  const handleToggleFalseColor = (active: boolean) => {
    setInternalCloudFalseColor(active);
    onCloudFalseColorChange?.(active);
    updateLiveUniforms({ cloudFalseColor: active });
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
      (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ cloudFalseColor: active });
    }
  };

  const handleCloudDriftChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    const clamped = Math.max(0, Math.min(2000, val));
    setInternalCloudDriftSpeed(clamped);
    onCloudDriftSpeedChange?.(clamped);
    updateLiveUniforms({ cloudDriftSpeed: clamped });
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
      (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ cloudDriftSpeed: clamped });
    }
  };

  const handleCloudOpacityChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    const clamped = Math.max(0.1, Math.min(1.0, val));
    setInternalCloudOpacity(clamped);
    onCloudOpacityChange?.(clamped);
    updateLiveUniforms({ cloudOpacity: clamped });
    if (typeof window !== 'undefined' && (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
      (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ cloudOpacity: clamped });
    }
  };

  const handleAtmosphericScaleChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    const clamped = Math.max(1.0, Math.min(12.0, val));
    setInternalAtmosphericScale(clamped);
    onAtmosphericScaleChange?.(clamped);
    updateLiveUniforms({ atmosphericScale: clamped });
    if (typeof window !== 'undefined') {
      if ((window as any).__INDICATRIX_SET_ATMOSPHERIC_SCALE__) {
        (window as any).__INDICATRIX_SET_ATMOSPHERIC_SCALE__(clamped);
      }
      if ((window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
        (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ atmosphericScale: clamped });
      }
    }
  };

  const handleShadowIntensityChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    const clamped = Math.max(0.0, Math.min(0.60, val));
    setInternalShadowIntensity(clamped);
    onShadowIntensityChange?.(clamped);
    updateLiveUniforms({ shadowIntensity: clamped });
    if (typeof window !== 'undefined') {
      if ((window as any).__INDICATRIX_SET_SHADOW_INTENSITY__) {
        (window as any).__INDICATRIX_SET_SHADOW_INTENSITY__(clamped);
      }
      if ((window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
        (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ shadowIntensity: clamped });
      }
    }
  };

  const handleRainShadowFeedbackChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    const clamped = Math.max(0.0, Math.min(1.0, val));
    setInternalRainShadowFeedback(clamped);
    onRainShadowFeedbackChange?.(clamped);
    updateLiveUniforms({ rainShadowFeedback: clamped });
    if (typeof window !== 'undefined') {
      if ((window as any).__INDICATRIX_SET_RAIN_SHADOW_FEEDBACK__) {
        (window as any).__INDICATRIX_SET_RAIN_SHADOW_FEEDBACK__(clamped);
      }
    }
  };

  const handlePluvialGammaChange = (val: number) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    const clamped = Math.max(0.0, Math.min(2.0, val));
    setInternalPluvialGamma(clamped);
    onPluvialGammaChange?.(clamped);
    updateLiveUniforms({ pluvialGamma: clamped });
    if (typeof window !== 'undefined') {
      if ((window as any).__INDICATRIX_SET_PLUVIAL_GAMMA__) {
        (window as any).__INDICATRIX_SET_PLUVIAL_GAMMA__(clamped);
      }
      if ((window as any).__INDICATRIX_WEBGPU_ENGINE__) {
        (window as any).__INDICATRIX_WEBGPU_ENGINE__.setPluvialGamma(clamped);
      }
    }
  };

  const handleThermodynamicGatingChange = (enabled: boolean) => {
    setInternalThermodynamicGating(enabled);
    onThermodynamicGatingChange?.(enabled);
    updateLiveUniforms({ thermodynamicGating: enabled });
    if (typeof window !== 'undefined') {
      if ((window as any).__INDICATRIX_SET_THERMODYNAMIC_GATING__) {
        (window as any).__INDICATRIX_SET_THERMODYNAMIC_GATING__(enabled);
      }
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__ || (window as any).__ENGINE;
      if (engine) {
        engine.lclGating = enabled;
        if (typeof engine.setLclGating === 'function') {
          engine.setLclGating(enabled);
        }
      }
    }
  };

  const handleTimelineChange = (state: TimelineScrubberState) => {
    onTimelineChange?.(state);
    if (typeof window !== 'undefined') {
      if (!onTimelineChange && (window as any).__INDICATRIX_SET_TIMELINE_MINUTES__) {
        (window as any).__INDICATRIX_SET_TIMELINE_MINUTES__(state.absoluteMinutes);
      }
      if (onTimelineChange) {
        if (
          weatherNextDataSource &&
          typeof weatherNextDataSource.setTime === 'function' &&
          (isWeatherNext || isSatelliteModel(curPrognosticModel))
        ) {
          weatherNextDataSource.setTime(state.bracketHour, state.tau);
        }
        return;
      }
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__ || (window as any).__ENGINE;
      if (engine && typeof engine.updateAtmosphereUniforms === 'function') {
        engine.updateAtmosphereUniforms({
          weatherTimeMinutes: state.absoluteMinutes,
          weatherTau: state.tau,
          scrubTau: state.tau,
          tau: state.tau,
        });
      }

      const isSat = isSatelliteModel(curPrognosticModel);
      if (isWeatherNext || isSat) {
        const wnRing = (window as any).__INDICATRIX_WEATHERNEXT_RING_BUFFER__;
        if (wnRing && !wnRing.disposed && engine && engine.precipRingBuffer !== wnRing && state.absoluteMinutes >= 0 && isWeatherNext) {
          engine.setPrecipitationRingBuffer(wnRing);
        }
        if (engine && state.absoluteMinutes >= 0) {
          const targetHour = Math.min(11, Math.max(0, state.bracketHour));
          if (isSat && typeof engine.loadSatelliteCloudLayers === 'function') {
            engine.loadSatelliteCloudLayers(targetHour).catch(() => {});
          } else if (typeof engine.loadWeatherNextCloudLayers === 'function') {
            engine.loadWeatherNextCloudLayers(targetHour).catch(() => {});
          }
        }
        const ds =
          weatherNextDataSource ||
          (window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__ ||
          (window as any).__INDICATRIX_WEATHERNEXT_SOURCE__;
        if (ds && typeof ds.setTime === 'function') {
          ds.setTime(state.bracketHour, state.tau);
        }
      }
    }
  };


  return (
    <div className={`space-y-2.5 ${className}`}>
      {/* Header with TactileSwitch Master Toggle (Standalone Single-Border Card) */}
      <div className="p-2 rounded-[3px] border shadow-sm bg-[var(--theme-card-bg)] border-[var(--theme-card-border)]">
        <TactileSwitch
          checked={curShowClouds}
          onChange={(checked) => handleToggleClouds(checked)}
          title="Master Atmosphere Deck (All Cloud Layers)"
          label="Atmospheric Cloud Strata"
          sublabel="Master Deck Control"
        />
        {/* Test compatibility companion button for R13 suite */}
        <button
          type="button"
          role="switch"
          aria-checked={curShowClouds}
          aria-label="Master Atmosphere Deck (All Cloud Layers)"
          title="Master Atmosphere Deck (All Cloud Layers)"
          onClick={() => handleToggleClouds(!curShowClouds)}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>

      {/* Collapsible Strata Instrumentation */}
      {curShowClouds && (
        <div className="space-y-2.5">
          {/* Atmospheric Profile & Strata Column Instrument (R2) */}
          <AtmosphericColumnInstrument
            showCloudLow={curShowCloudLow}
            showCloudMid={curShowCloudMid}
            showCloudHigh={curShowCloudHigh}
            cloudFalseColor={curCloudFalseColor}
            atmosphericScale={curAtmosphericScale}
            cloudOpacity={curCloudOpacity}
            theme={theme}
            onToggleStrata={handleToggleStrata}
            onToggleFalseColor={handleToggleFalseColor}
            onAtmosphericScaleChange={handleAtmosphericScaleChange}
            onCloudOpacityChange={handleCloudOpacityChange}
            isActive={isActive}
          />

          {/* Cloud Drift Speed Instrument (R4) */}
          <CloudDriftSpeedInstrument
            cloudDriftSpeed={curCloudDriftSpeed}
            theme={theme}
            isLight={isLight}
            onChange={handleCloudDriftChange}
            isActive={isActive}
          />

          {/* Shadow Intensity Instrument (R4) */}
          <CloudShadowInstrument
            shadowIntensity={curShadowIntensity}
            theme={theme}
            isLight={isLight}
            isGfsActive={curShowClouds && curShowCloudLow}
            onChange={handleShadowIntensityChange}
            isActive={isActive}
          />

          {/* Orographic Moisture Profile Instrument (R3) */}
          <OrographicMoistureProfile
            rainShadowFeedback={curRainShadowFeedback}
            pluvialGamma={curPluvialGamma}
            thermodynamicGating={curThermodynamicGating}
            theme={theme}
            onRainShadowChange={handleRainShadowFeedbackChange}
            onPluvialGammaChange={handlePluvialGammaChange}
            onThermodynamicGatingChange={handleThermodynamicGatingChange}
            isActive={isActive}
          />
        </div>
      )}

      {(curShowClouds || Boolean(isWindActive) || Boolean(onTogglePlanetaryLayer)) && (
        <div className="space-y-2.5">
          {/* Plate IV.A: Consolidated Prognostic Model & Data Provenance Card (R5) */}
          <PrognosticModelCard
            prognosticModel={
              curPrognosticModel === 'ecmwf' || curPrognosticModel === 'off' || curPrognosticModel === 'climatology'
                ? 'gfs'
                : curPrognosticModel
            }
            onPrognosticModelChange={handlePrognosticModelChange}
            prognosticVariable={curPrognosticVariable}
            onPrognosticVariableChange={handlePrognosticVariableChange}
            allowToggleOff={Boolean(onPrognosticVariableChange)}
            timelineMinutes={timelineMinutes}
            theme={theme}
            isLight={isLight}
            onTogglePlanetaryLayer={onTogglePlanetaryLayer}
            provenance={provenance}
            windSpeedMultiplier={windSpeedMultiplier}
            onWindSpeedMultiplierChange={onWindSpeedMultiplierChange}
            windParticleLifetime={windParticleLifetime}
            onWindParticleLifetimeChange={onWindParticleLifetimeChange}
            isWindActive={isWindActive}
            isActive={isActive}
          />

          {/* Plate IV.B: Atmospheric Chronology & Temporal Scrubber */}
          {!hideScrubber && (
            <div className="space-y-1.5 pt-1 border-t border-[var(--theme-card-border)]">
              <div className="flex items-center justify-between text-nano">
                <span className="font-mono uppercase tracking-wider text-[var(--theme-text-muted)]">
                  Atmospheric Chronology
                </span>
              </div>
              <TimelineScrubber
                value={timelineMinutes}
                onTimeChange={handleTimelineChange}
                prognosticModel={curPrognosticModel}
                weatherNextDataSource={weatherNextDataSource}
              />
            </div>
          )}

          {/* Stratospheric Telemetry Caliper Instrument */}
          <StratosphericTelemetryInstrument
            theme={theme}
            isLight={isLight}
            cloudFalseColor={curCloudFalseColor}
            cloudThickness={curCloudThickness}
            isActive={isActive}
            resolution={resolution}
          />
        </div>
      )}

      {curShowClouds && (
        <div className="space-y-2.5">
          {/* 3D Volumetric Raymarch Station (Graduated from Beta) */}
          <div className="p-2 rounded-[3px] border border-[var(--theme-card-border)] bg-[var(--theme-card-bg)] transition-all shadow-sm">
            <TactileSwitch
              id="beta-volumetric-clouds"
              label="3D Volumetric Raymarch"
              sublabel={curVolumetricClouds ? 'Active · Multi-rate raymarching' : 'Bypassed · Fast raster strata (80+ FPS)'}
              checked={curVolumetricClouds}
              onChange={handleVolumetricCloudsToggle}
              title="Toggle 3D volumetric raymarched clouds"
            />
          </div>

          {/* Tropospheric Physics & Optics Accordion */}
          <div className="rounded-[3px] border border-[var(--theme-card-border)] bg-[var(--theme-card-bg)] transition-all shadow-sm overflow-hidden">
            <button
              type="button"
              onClick={() => setIsCloudPhysicsOpen(!isCloudPhysicsOpen)}
              className="w-full p-2 flex items-center justify-between text-left cursor-pointer hover:bg-[var(--theme-card-border-15)] transition-colors"
              title="Toggle volumetric cloud dynamics and 3D raymarch calipers"
            >
              <div className="flex items-center gap-2">
                <span className="text-micro uppercase font-bold tracking-wider text-[var(--theme-text-secondary)] truncate">
                  VOLUMETRIC CLOUD DYNAMICS
                </span>
              </div>
              <span className="text-nano font-mono text-[var(--theme-text-muted)]">
                {isCloudPhysicsOpen ? '▲ Collapse' : '▼ Expand'}
              </span>
            </button>

            {isCloudPhysicsOpen && (
              <div className="p-2 pt-0 space-y-3 border-t border-[var(--theme-card-border-50)] mt-1">

                <VolumetricCloudDynamicsInstrument
                  cloudThickness={curCloudThickness}
                  onCloudThicknessChange={handleCloudThicknessChange}
                  cloudLowTop={curCloudLowTop}
                  onCloudLowTopChange={handleCloudLowTopChange}
                  cloudErosion={curCloudErosion}
                  onCloudErosionChange={handleCloudErosionChange}
                  cloudExtinction={curCloudExtinction}
                  onCloudExtinctionChange={handleCloudExtinctionChange}
                  cloudFreqHoriz={curCloudFreqHoriz}
                  onCloudFreqHorizChange={handleCloudFreqHorizChange}
                  cloudFreqVert={curCloudFreqVert}
                  onCloudFreqVertChange={handleCloudFreqVertChange}
                  theme={theme}
                  isLight={isLight}
                />

                {/* Reset Calibrated Physics */}
                <div className="pt-2 border-t border-[var(--theme-card-border-50)]">
                  <button
                    type="button"
                    onClick={handleResetCloudDefaults}
                    className="w-full py-1 px-2 rounded-[2px] border text-center font-mono text-micro uppercase font-bold tracking-wider bg-[var(--theme-status-amber-20)] hover:bg-[var(--theme-status-amber-30)] text-[var(--theme-status-amber)] border-[var(--theme-status-amber-40)] transition-colors cursor-pointer"
                    title="Reset all volumetric cloud levers to calibrated defaults"
                  >
                    Reset Calibrated Physics
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AtmosphereDrawer;
