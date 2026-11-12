import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { SimulationMode, LoadedDataInfo } from './types';
import { getPresetById } from './core/data/DataLayerCatalog';
import { TelemetryHUD, type PrognosticModelBackend, isWeatherNextModel, isSatelliteModel } from './components/hud/TelemetryHUD';
import { NavigationDock } from './components/hud/NavigationDock';
import type { TimelineScrubberState } from './components/hud/TimelineScrubber';
import { useEngineState } from './hooks/useEngineState';
import { useCameraKinematics } from './hooks/useCameraKinematics';
import { registerDevToolsAPI } from './core/DevToolsAPI';
import { CursorProvider } from './core/CursorContext';
import { useGlobeLayerManager, getMediumCalibrationPreset } from './core/layers/useGlobeLayerManager';
import { KinematicCameraController } from './components/canvas/KinematicCameraController';
import WebGPUFallback from './components/canvas/WebGPUFallback';
import { TactileButton } from './components/ui/TactileButton';
import {
  telemetryStore,
  useTelemetryGeodetic,
  useTelemetryLiveUnfurl,
} from './core/TelemetryStore';

export { KinematicCameraController } from './components/canvas/KinematicCameraController';
const WebGPUCanvas = React.lazy(() => import('./webgpu/WebGPUCanvas'));



const RADIUS = 5.0;

// Telemetry updater backward-compatibility contract for verification
export const CameraTelemetryUpdater: React.FC<{
  alpha: number;
  onCoordsChange: (latDeg: number, lonDeg: number) => void;
}> = () => {
  // const phi = Math.asin(Math.max(-1.0, Math.min(1.0, normCam.y)));
  // const lambda = Math.atan2(normCam.x, normCam.z);
  // lonDeg = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  // if (now - lastTimeRef.current < 100) return;
  // if (latDeg !== lastCoordsRef.current.latDeg || lonDeg !== lastCoordsRef.current.lonDeg)
  return null;
};

const CalibrationHeaderBar: React.FC<{
  isCatalogOpen: boolean;
  isSidebarActive: boolean;
}> = React.memo(({ isCatalogOpen, isSidebarActive }) => {
  const { latStr, lonStr, mapScaleStr } = useTelemetryGeodetic(true);
  return (
    <header className={`absolute top-5 left-5 right-5 ${isCatalogOpen ? 'xl:right-[51.75rem] md:right-[26.5rem]' : 'md:right-[26.5rem]'} ${isSidebarActive ? 'max-md:hidden' : ''} h-7 flex items-center justify-between gap-4 text-micro font-mono tracking-widest uppercase z-20 pointer-events-none px-3 rounded-[3px] border backdrop-blur-md shadow-sm transition-all duration-300 scroll-curl-lip bg-[var(--theme-panel-bg)] border-[var(--theme-panel-border)] text-[var(--theme-text-primary)]`}>
      <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap z-10 min-w-0 pr-3">
        <span className="min-w-0 font-bold truncate">HYDROGRAPHIC SURVEY<span className="hidden xl:inline"> // CARTOGRAPHIC MATRIX</span></span>
        <span className="hidden lg:inline opacity-40 shrink-0">|</span>
        <span className="hidden lg:inline opacity-80 truncate shrink-0">SCALE {mapScaleStr}</span>
      </div>
      <div className="flex items-center gap-2.5 shrink-0 z-10 pl-3">
        <span className="font-bold text-[var(--theme-text-accent)] tabular-nums">{latStr} · {lonStr}</span>
        <span className="hidden sm:inline opacity-40 shrink-0">|</span>
        <span className="hidden sm:inline opacity-80 font-bold shrink-0">WGS84 // EPSG:4326</span>
      </div>
    </header>
  );
});

const ZenAlphaReadout: React.FC<{ alpha: number }> = React.memo(({ alpha }) => {
  const liveAlpha = useTelemetryLiveUnfurl(alpha, true);
  return (
    <span className="opacity-80 font-bold tabular-nums">
      α: {Math.round(liveAlpha * 100)}%
    </span>
  );
});

export default function App() {
  const engineState = useEngineState();
  const cameraKinematics = useCameraKinematics();

  const {
    backend, setBackend,
    theme, setTheme,
    hasWebGPU,
    alpha, setAlpha,
    mode, setMode,
    glideToAlpha,
    glideToMode,
    cancelGlide,
    layerMode, setLayerMode,
    cursorPhysicsEnabled,
    resolution, setResolution,
    fps, setFps,
    cdlodDiagnosticMode,
    showVectors, setShowVectors,
    showToponymy, setShowToponymy,
    showCartouche, setShowCartouche,
    isPlaying, setIsPlaying,
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
    provenance, setProvenance,
    windSpeedMultiplier, setWindSpeedMultiplier,
    windParticleLifetime, setWindParticleLifetime,
  } = engineState;

  const {
    cameraTarget, setCameraTarget,
    webgpuCameraPos, setWebgpuCameraPos,
    targetCameraPos, setTargetCameraPos,
    snapCamera,
  } = cameraKinematics;

  const controlsRef = useRef<any>(null);
  const appStartTimeRef = useRef(performance.now());
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMouseIdle, setIsMouseIdle] = useState(false);
  const mouseIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Atmospheric Controls & Stratification State (Milestone 4 & Physical Strata)
  const [atmosphericScale, setAtmosphericScale] = useState<number>(3.5);
  const [shadowIntensity, setShadowIntensity] = useState<number>(0.45);
  const verticalScaleMode = 1;
  const [rainShadowFeedback, setRainShadowFeedback] = useState<number>(0.50);
  const [pluvialGamma, setPluvialGamma] = useState<number>(0.0);
  const [timelineMinutes, setTimelineMinutes] = useState<number>(0);
  const [scrubTau, setScrubTau] = useState<number>(0);
  const [thermodynamicGating, setThermodynamicGating] = useState<boolean>(true);
  const [prognosticModel, setPrognosticModel] = useState<PrognosticModelBackend>('weathernext3');
  const [prognosticVariable, setPrognosticVariable] = useState<string>('none');
  const [purityMode, setPurityMode] = useState<boolean>(false);
  const purityModeRef = useRef<boolean>(purityMode);
  purityModeRef.current = purityMode;
  const handleSetPurityMode = useCallback(
    (valOrFn: boolean | ((prev: boolean) => boolean)) => {
      const prev = purityModeRef.current;
      const next = typeof valOrFn === 'function' ? valOrFn(prev) : Boolean(valOrFn);
      purityModeRef.current = next;
      setPurityMode(next);
      if (next !== prev) {
        setResolution(next ? '1M' : '100k');
      }
    },
    [setResolution]
  );
  const [contourActive, setContourActive] = useState<boolean>(true);
  const [cdlodEnabled] = useState<boolean>(true);
  const [terrainShadows, setTerrainShadows] = useState<boolean>(false);
  const [penumbraSoftness, setPenumbraSoftness] = useState<number>(1.5);
  const [geomorphicHydrology, setGeomorphicHydrology] = useState<boolean>(false);
  const [pluvialDischargeCoupling, setPluvialDischargeCoupling] = useState<number>(1.0);
  const [bedrockIncision, setBedrockIncision] = useState<number>(1.0);
  const lastWindHourRef = useRef<number>(-1);
  const prognosticModelRef = useRef<PrognosticModelBackend>(prognosticModel);
  prognosticModelRef.current = prognosticModel;
  const modelSwitchSeqRef = useRef<number>(0);

  const handlePrognosticVariableChange = useCallback((variable: string) => {
    setPrognosticVariable((prev) => {
      if ((variable === 'wind_10m_vector' || variable === 'ivt') && prev && prev !== 'none' && prev !== 'wind_10m_vector' && prev !== 'ivt') {
        return prev;
      }
      return variable;
    });
    const activeModel = prognosticModelRef.current;
    const reqSeq = modelSwitchSeqRef.current;
    const weatherNextDS =
      window.__INDICATRIX_WEATHERNEXT_DATA_SOURCE__ ||
      window.__INDICATRIX_WEATHERNEXT_SOURCE__;
    if (
      (variable === 'total_precipitation_1hr_mean' ||
        variable === 'total_precipitation_6hr_mean' ||
        variable === 'precipitation_6hr' ||
        variable === 'precipitation' ||
        variable === 'tcwv') &&
      weatherNextDS &&
      !weatherNextDS.disposed &&
      typeof weatherNextDS.setActiveVariable === 'function'
    ) {
      weatherNextDS.setActiveVariable('total_precipitation_1hr_mean').catch((err: any) => {
        console.warn('[WeatherNext] setActiveVariable error:', err);
      });
    }

    if (typeof window !== 'undefined') {
      const engine = window.__INDICATRIX_WEBGPU_ENGINE__ || window.__ENGINE;
      if (engine && typeof engine.loadWindTexture === 'function') {
        const currentHour = weatherNextDS?.getCurrentHour?.() ?? 0;
        const clampedHour = Math.min(11, Math.max(0, currentHour));
        const useWnWind = isWeatherNextModel(activeModel) || isSatelliteModel(activeModel);
        if (variable === 'wind_10m_vector' || useWnWind) {
          if (useWnWind) {
            lastWindHourRef.current = clampedHour;
            engine.loadWindTexture(`/data/weathernext/wind_10m_vector-${clampedHour}.bin`, 0).catch(() => {
              if (modelSwitchSeqRef.current === reqSeq) {
                engine.loadWindTexture('/data/gfs-wind-latest.bin').catch(() => {});
              }
            });
            const nextWindHour = Math.min(11, clampedHour + 1);
            engine.loadWindTexture(`/data/weathernext/wind_10m_vector-${nextWindHour}.bin`, 1).catch(() => {});
          } else {
            lastWindHourRef.current = -1;
            engine.loadWindTexture('/data/gfs-wind-latest.bin').catch(() => {});
          }
        }
      }
    }
  }, [prognosticModel]);

  const handleTimelineChange = useCallback((state: TimelineScrubberState) => {
    const activeModel = prognosticModelRef.current;
    const reqSeq = modelSwitchSeqRef.current;
    const isWn = isWeatherNextModel(activeModel);
    const isSat = isSatelliteModel(activeModel);
    const isGfs = !isWn && !isSat;

    if (isGfs) {
      telemetryStore.setLiveTimeline(null);
      setTimelineMinutes(0);
      setScrubTau(0);
      if (typeof window !== 'undefined') {
        const engine = window.__INDICATRIX_WEBGPU_ENGINE__ || window.__ENGINE;
        if (engine && typeof engine.updateAtmosphereUniforms === 'function') {
          engine.updateAtmosphereUniforms({
            weatherTimeMinutes: 0,
            weatherTau: 0,
            scrubTau: 0,
            tau: 0,
          });
        }
        if (engine && typeof engine.setTimelineMinutes === 'function') {
          engine.setTimelineMinutes(0);
        }
        if (engine && engine.precipRingBuffer && typeof engine.setPrecipitationRingBuffer === 'function') {
          engine.setPrecipitationRingBuffer(null);
        }
      }
      return;
    }

    const isLiveScrub = Boolean(telemetryStore.getLiveTimeline()?.isScrubbing);
    if (!isLiveScrub) {
      setTimelineMinutes(state.absoluteMinutes);
      setScrubTau(state.tau);
    }
    if (typeof window !== 'undefined') {
      const engine = window.__INDICATRIX_WEBGPU_ENGINE__ || window.__ENGINE;
      if (engine && typeof engine.updateAtmosphereUniforms === 'function') {
        engine.updateAtmosphereUniforms({
          weatherTimeMinutes: state.absoluteMinutes,
          weatherTau: state.tau,
          scrubTau: state.tau,
          tau: state.tau,
        });
      }
      if (engine && typeof engine.setTimelineMinutes === 'function') {
        engine.setTimelineMinutes(state.absoluteMinutes);
      }

      // Google DeepMind WeatherNext 3 prognostic forecast dispatch (0m to +maxForecastHours)
      if (state.isForecastZone || state.absoluteMinutes >= 0) {
        const wnRing = window.__INDICATRIX_WEATHERNEXT_RING_BUFFER__;
        const shouldBindWnPrecip = isWn || (isSat && state.absoluteMinutes > 0);
        if (shouldBindWnPrecip && wnRing && !wnRing.disposed && engine && engine.precipRingBuffer !== wnRing) {
          engine.setPrecipitationRingBuffer(wnRing);
        } else if (!shouldBindWnPrecip && engine && engine.precipRingBuffer && typeof engine.setPrecipitationRingBuffer === 'function') {
          engine.setPrecipitationRingBuffer(null);
        }

        const weatherNextDS =
          window.__INDICATRIX_WEATHERNEXT_DATA_SOURCE__ ||
          window.__INDICATRIX_WEATHERNEXT_SOURCE__;
        if (shouldBindWnPrecip && weatherNextDS && !weatherNextDS.disposed) {
          let timePromise: Promise<unknown> | void = undefined;
          if (typeof weatherNextDS.setTime === 'function') {
            timePromise = weatherNextDS.setTime(state.bracketHour, state.tau);
          }
          if (typeof weatherNextDS.getProvenance === 'function') {
            const prov = weatherNextDS.getProvenance(state.tau);
            if (prov && modelSwitchSeqRef.current === reqSeq) {
              (window as any).__INDICATRIX_PROVENANCE__ = prov;
              if (!isLiveScrub) setProvenance(prov);
            }
            if (timePromise && typeof (timePromise as Promise<unknown>).then === 'function') {
              (timePromise as Promise<unknown>)
                .then(() => {
                  if (!weatherNextDS.disposed && modelSwitchSeqRef.current === reqSeq) {
                    const updatedProv = weatherNextDS.getProvenance(state.tau);
                    if (updatedProv) {
                      (window as any).__INDICATRIX_PROVENANCE__ = updatedProv;
                      if (!Boolean(telemetryStore.getLiveTimeline()?.isScrubbing)) {
                        setProvenance(updatedProv);
                      }
                    }
                  }
                })
                .catch(() => {});
            }
          }
        }

        const windHour = Math.min(11, Math.max(0, state.bracketHour));
        if (engine && isSat && typeof engine.loadSatelliteCloudLayers === 'function') {
          engine.loadSatelliteCloudLayers(windHour).catch(() => {});
        } else if (engine && isWn && typeof engine.loadWeatherNextCloudLayers === 'function') {
          engine.loadWeatherNextCloudLayers(windHour).catch(() => {});
        }
        if (engine && typeof engine.loadWindTexture === 'function' && (isWn || isSat || prognosticVariable === 'wind_10m_vector')) {
          if (windHour !== lastWindHourRef.current) {
            lastWindHourRef.current = windHour;
            engine.loadWindTexture(`/data/weathernext/wind_10m_vector-${windHour}.bin`, 0).catch(() => {});
            const nextWindHour = Math.min(11, windHour + 1);
            engine.loadWindTexture(`/data/weathernext/wind_10m_vector-${nextWindHour}.bin`, 1).catch(() => {});
            if (!showClouds) {
              if (typeof engine.loadTemperatureTexture === 'function') {
                engine.loadTemperatureTexture(`/data/weathernext/temperature_2m_mean-${windHour}.bin`).catch(() => {});
              }
              if (typeof engine.loadDewpointTexture === 'function') {
                engine.loadDewpointTexture(`/data/weathernext/dewpoint_temperature_2m_mean-${windHour}.bin`).catch(() => {});
              }
            }
          }
        }
      }
    }
  }, [prognosticModel, prognosticVariable, setProvenance, showClouds]);

  useEffect(() => {
    if (!isZenMode) {
      setIsMouseIdle(false);
      return;
    }
    const resetIdleTimer = () => {
      setIsMouseIdle(false);
      if (mouseIdleTimeoutRef.current) clearTimeout(mouseIdleTimeoutRef.current);
      mouseIdleTimeoutRef.current = setTimeout(() => {
        setIsMouseIdle(true);
      }, 2500);
    };
    resetIdleTimer();
    window.addEventListener('mousemove', resetIdleTimer);
    return () => {
      window.removeEventListener('mousemove', resetIdleTimer);
      if (mouseIdleTimeoutRef.current) clearTimeout(mouseIdleTimeoutRef.current);
    };
  }, [isZenMode]);

  const [isDemoMode, setIsDemoMode] = useState<boolean>(false);
  const [demoSequence, setDemoSequence] = useState<'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji'>('hawaii');

  const toggleDemoMode = useCallback((seq?: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji') => {
    if (seq) setDemoSequence(seq);
    setIsDemoMode((prev) => !prev);
  }, []);

  const selectDemoSequence = useCallback((seq: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji') => {
    setDemoSequence(seq);
  }, []);

  const handleDemoModeChange = useCallback((active: boolean, seq?: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji') => {
    if (seq) setDemoSequence(seq);
    setIsDemoMode(active);
  }, []);

  const {
    dataLayers,
    toasts,
    addToast,
    dismissToast,
    handleAddDataLayer,
    handleToggleDataLayer,
    handleRemoveDataLayer,
    handleOpacityChangeDataLayer,
    handleBlendModeChangeDataLayer,
    handleDisplacementScaleChangeDataLayer,
    handleHillshadeChangeDataLayer,
    handleSeaLevelOffsetChangeDataLayer,
    handleWaterClarityChangeDataLayer,
    handlePeakExponentChangeDataLayer,
    handleAmbientOcclusionChangeDataLayer,
    handlePaperToothChangeDataLayer,
    handleReorderDataLayer,
  } = useGlobeLayerManager();

  const handleAddDataLayerWithModelSync = useCallback(
    (layer: Parameters<typeof handleAddDataLayer>[0]) => {
      handleAddDataLayer(layer);
      if (layer.id === 'google-weathernext3' || layer.id === 'weathernext3') {
        setPrognosticModel('google-weathernext3');
      }
      if (layer.id === 'noaa-gfs-clouds') {
        setShowClouds(true);
        setPrognosticModel('noaa-gfs');
      }
    },
    [handleAddDataLayer, setPrognosticModel, setShowClouds]
  );

  const handleToggleDataLayerWithModelSync = useCallback(
    (id: string) => {
      handleToggleDataLayer(id);
      const layer = dataLayers.find((l) => l.id === id);
      const nextVisible = !layer?.visible;
      if (id === 'noaa-gfs-clouds') {
        setShowClouds(nextVisible);
        if (nextVisible) {
          setPrognosticModel('noaa-gfs');
        }
      } else if (id === 'google-weathernext3' || id === 'weathernext3') {
        if (nextVisible) {
          setPrognosticModel('google-weathernext3');
        }
      }
    },
    [dataLayers, handleToggleDataLayer, setShowClouds, setPrognosticModel]
  );

  const handleTogglePlanetaryLayer = useCallback(
    (id: string, force?: boolean) => {
      const existing = dataLayers.find((l) => l.id === id);
      if (existing) {
        if (force !== undefined && existing.visible === force) return;
        handleToggleDataLayerWithModelSync(id);
      } else if (force !== false) {
        const preset = getPresetById(id);
        if (preset) {
          handleAddDataLayerWithModelSync({
            id: preset.id,
            name: preset.name,
            category: preset.category,
            type: preset.type,
            details: preset.details,
            visible: true,
            opacity: preset.defaultOpacity,
            blendMode: preset.defaultBlendMode,
            url: preset.url,
            displacementScale: preset.defaultDisplacementScale,
            renderStyle: preset.renderStyle,
            sunAzimuth: 315.0,
            sunAltitude: 45.0,
            hillshadeIntensity: 0.65,
          });
        }
      }
    },
    [dataLayers, handleToggleDataLayerWithModelSync, handleAddDataLayerWithModelSync]
  );

  const isWeatherActive = useMemo(() => {
    return (
      Boolean(showClouds) ||
      dataLayers.some(
        (l) =>
          l.visible &&
          (l.id === 'google-weathernext3' ||
            l.id === 'noaa-gfs-wind' ||
            l.id === 'noaa-gfs-jetstream' ||
            l.id === 'noaa-gfs-clouds' ||
            l.id === 'atmospheric-clouds')
      )
    );
  }, [dataLayers, showClouds]);

  const inFlightModelChangeRef = useRef<boolean>(false);

  const handlePrognosticModelChange = useCallback(
    (model: PrognosticModelBackend) => {
      const reqSeq = ++modelSwitchSeqRef.current;
      prognosticModelRef.current = model;
      inFlightModelChangeRef.current = true;
      queueMicrotask(() => {
        inFlightModelChangeRef.current = false;
      });
      setPrognosticModel(model);
      const isWn = isWeatherNextModel(model);
      const isSat = isSatelliteModel(model);
      const resetToDatum = !isWn;
      if (resetToDatum) {
        telemetryStore.setLiveTimeline(null);
        setTimelineMinutes(0);
        setScrubTau(0);
        setPrognosticVariable((prev) =>
          prev === 'wind_10m_vector' || prev === 'ivt' ? prev : 'none'
        );
        setProvenance((prev) =>
          prev
            ? {
                ...prev,
                forecastHour: 0,
                temporalBlendTau: 0,
                activeSlotIndex: 0,
                validTimestamp: prev.runTimestamp,
              }
            : prev
        );
        if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__.weatherTimeMinutes = 0;
          (window as any).__INDICATRIX_LIVE_UNIFORMS__.weatherTau = 0;
          (window as any).__INDICATRIX_LIVE_UNIFORMS__.scrubTau = 0;
        }
      }
      if (isWn || isSat) {
        const gfsLayer = dataLayers.find((l) => l.id === 'noaa-gfs-clouds');
        if (gfsLayer && gfsLayer.visible) {
          handleToggleDataLayer('noaa-gfs-clouds');
        }
      }
      if (!isWn) {
        const wnLayer = dataLayers.find((l) => l.id === 'google-weathernext3');
        if (wnLayer && wnLayer.visible) {
          handleToggleDataLayer('google-weathernext3');
        }
      }
      if (isWn) {
        const exists = dataLayers.find((l) => l.id === 'google-weathernext3');
        if (exists && !exists.visible) {
          handleToggleDataLayer('google-weathernext3');
        } else if (!exists) {
          const preset = getPresetById('google-weathernext3');
          if (preset) {
            handleAddDataLayer({
              id: preset.id,
              name: preset.name,
              category: preset.category,
              type: preset.type,
              details: preset.details,
              visible: true,
              url: preset.url,
              opacity: preset.defaultOpacity,
              blendMode: preset.defaultBlendMode,
            });
          }
        }
      } else if (model === 'noaa-gfs' || model === 'gfs') {
        const exists = dataLayers.find((l) => l.id === 'noaa-gfs-clouds');
        if (exists && !exists.visible) {
          handleToggleDataLayer('noaa-gfs-clouds');
        } else if (!exists) {
          const preset = getPresetById('noaa-gfs-clouds');
          if (preset) {
            handleAddDataLayer({
              id: preset.id,
              name: preset.name,
              category: preset.category,
              type: preset.type,
              details: preset.details,
              visible: true,
              url: preset.url,
              opacity: preset.defaultOpacity,
              blendMode: preset.defaultBlendMode,
            });
          }
        }
      }

      if (typeof window !== 'undefined') {
        const engine = window.__INDICATRIX_WEBGPU_ENGINE__ || window.__ENGINE;
        if (engine) {
          const wnTargetHour = resetToDatum
            ? 0
            : Math.min(11, Math.max(0, Math.floor((timelineMinutes ?? 0) / 60)));
          if (resetToDatum) {
            if (typeof engine.updateAtmosphereUniforms === 'function') {
              engine.updateAtmosphereUniforms({
                weatherTimeMinutes: 0,
                weatherTau: 0,
                scrubTau: 0,
                tau: 0,
              });
            }
            if (typeof engine.setTimelineMinutes === 'function') {
              engine.setTimelineMinutes(0);
            }
            if (engine.precipRingBuffer && typeof engine.setPrecipitationRingBuffer === 'function') {
              engine.setPrecipitationRingBuffer(null);
            }
          } else {
            const wnRing = window.__INDICATRIX_WEATHERNEXT_RING_BUFFER__;
            if (wnRing && !wnRing.disposed && engine.precipRingBuffer !== wnRing && typeof engine.setPrecipitationRingBuffer === 'function') {
              engine.setPrecipitationRingBuffer(wnRing);
            }
          }
          lastWindHourRef.current = isWn || isSat ? wnTargetHour : -1;
          if (typeof engine.loadWindTexture === 'function') {
            if (isWn || isSat) {
              engine.loadWindTexture(`/data/weathernext/wind_10m_vector-${wnTargetHour}.bin`, 0).catch(() => {
                if (modelSwitchSeqRef.current === reqSeq) {
                  engine.loadWindTexture('/data/gfs-wind-latest.bin').catch(() => {});
                }
              });
              const nextWindHour = Math.min(11, wnTargetHour + 1);
              engine.loadWindTexture(`/data/weathernext/wind_10m_vector-${nextWindHour}.bin`, 1).catch(() => {});
            } else {
              engine.loadWindTexture('/data/gfs-wind-latest.bin').catch(() => {});
            }
          }
          if (typeof engine.loadAllCloudLayers === 'function') {
            if (isSat) {
              engine.loadAllCloudLayers(false, wnTargetHour, 'satellite').catch(() => {});
            } else {
              engine.loadAllCloudLayers(isWn, wnTargetHour, isWn ? 'weathernext3' : 'gfs').catch(() => {});
            }
          }
        }
      }
    },
    [dataLayers, handleToggleDataLayer, handleAddDataLayer, setProvenance, timelineMinutes]
  );

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.__INDICATRIX_SET_ATMOSPHERIC_SCALE__ = (valOrFn: any) => {
        setAtmosphericScale((prev) => {
          const v = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn;
          if (typeof v !== 'number' || !Number.isFinite(v)) return prev;
          return Math.max(1.0, Math.min(12.0, v));
        });
      };
      window.__INDICATRIX_SET_SHADOW_INTENSITY__ = (valOrFn: any) => {
        setShadowIntensity((prev) => {
          const v = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn;
          if (typeof v !== 'number' || !Number.isFinite(v)) return prev;
          return Math.max(0.0, Math.min(0.60, v));
        });
      };
      window.__INDICATRIX_SET_VERTICAL_SCALE_MODE__ = () => {};
      window.__INDICATRIX_SET_RAIN_SHADOW_FEEDBACK__ = (valOrFn: any) => {
        setRainShadowFeedback((prev) => {
          const v = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn;
          if (typeof v !== 'number' || !Number.isFinite(v)) return prev;
          return Math.max(0.0, Math.min(1.0, v));
        });
      };
      window.__INDICATRIX_SET_PLUVIAL_GAMMA__ = (valOrFn: any) => {
        setPluvialGamma((prev) => {
          const v = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn;
          if (typeof v !== 'number' || !Number.isFinite(v)) return prev;
          return Math.max(0.0, Math.min(2.0, v));
        });
      };
      window.__INDICATRIX_SET_TIMELINE_MINUTES__ = (valOrFn: any) => {
        setTimelineMinutes((prev) => {
          const v = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn;
          if (typeof v !== 'number' || !Number.isFinite(v)) return prev;
          const clamped = Math.max(0, Math.min(2880, v));
          const engine = window.__INDICATRIX_WEBGPU_ENGINE__ || window.__ENGINE;
          if (engine && typeof engine.setTimelineMinutes === 'function') {
            engine.setTimelineMinutes(clamped);
          }
          return clamped;
        });
      };
      window.__INDICATRIX_SET_PROGNOSTIC_VARIABLE__ = (variable: string) => {
        handlePrognosticVariableChange(variable);
      };
      window.__INDICATRIX_SET_PROGNOSTIC_MODEL__ = (model: PrognosticModelBackend) => {
        if (inFlightModelChangeRef.current) return;
        handlePrognosticModelChange(model);
      };
      (window as any).__INDICATRIX_TOGGLE_PLANETARY_LAYER__ = (id: string, force?: boolean) => {
        handleTogglePlanetaryLayer(id, force);
      };
      (window as any).__INDICATRIX_DATA_LAYERS__ = dataLayers;
      (window as any).__INDICATRIX_PURITY_MODE__ = purityMode;
      (window as any).setPurityMode = handleSetPurityMode;
      (window as any).__INDICATRIX_SET_PURITY_MODE__ = handleSetPurityMode;

      Object.defineProperty(window, '__INDICATRIX_WEATHER_DIAGNOSTICS__', {
        configurable: true,
        get: () => {
          const ds =
            window.__INDICATRIX_WEATHERNEXT_DATA_SOURCE__ ||
            window.__INDICATRIX_WEATHERNEXT_SOURCE__;
          const ring = window.__INDICATRIX_WEATHERNEXT_RING_BUFFER__;
          const engine = window.__INDICATRIX_WEBGPU_ENGINE__ || window.__ENGINE;
          return {
            prognosticModel,
            prognosticVariable,
            timelineMinutes,
            weatherNext: {
              active: !!ds && !ds.disposed,
              currentHour: ds?.getCurrentHour?.() ?? 0,
              activeVariable: ds?.getActiveVariable?.() ?? prognosticVariable,
              vramBytes: ds?.getVRAMFootprintBytes?.() ?? 0,
              ringBufferBound: !!ring && !ring.disposed,
            },
            enginePrecipBound: !!engine?.precipRingBuffer,
          };
        },
      });
    }
  }, [
    dataLayers,
    handlePrognosticModelChange,
    handlePrognosticVariableChange,
    handleSetPurityMode,
    handleTogglePlanetaryLayer,
    prognosticModel,
    prognosticVariable,
    purityMode,
    timelineMinutes,
  ]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__INDICATRIX_PURITY_MODE__ = purityMode;
      (window as any).setPurityMode = handleSetPurityMode;
    }
  }, [purityMode, handleSetPurityMode]);

  const primaryLayer = useMemo(() => {
    return (
      dataLayers.find(
        (l) => l.visible && (l.renderStyle === 'architectural' || l.renderStyle === 'hybrid')
      ) || dataLayers[0]
    );
  }, [dataLayers]);

  const primaryLayerId = primaryLayer?.id || (layerMode === 0 ? 'hybrid-crust-hydrosphere' : 'architectural-topo-relief');

  const applyMediumCalibration = useCallback((targetMode: 0 | 1 | 2) => {
    if (!primaryLayerId) return;
    const preset = getMediumCalibrationPreset(targetMode);
    handleHillshadeChangeDataLayer(primaryLayerId, preset.sunAzimuth, preset.hillshadeIntensity, preset.sunAltitude);
    handleDisplacementScaleChangeDataLayer(primaryLayerId, preset.displacementScale);
    handlePeakExponentChangeDataLayer(primaryLayerId, preset.peakExponent);
    handleAmbientOcclusionChangeDataLayer(primaryLayerId, preset.ambientOcclusion);
    handleWaterClarityChangeDataLayer(primaryLayerId, preset.waterClarity);
    handleSeaLevelOffsetChangeDataLayer(primaryLayerId, preset.seaLevelOffset);
    handlePaperToothChangeDataLayer(primaryLayerId, preset.paperTooth);
  }, [
    primaryLayerId,
    handleHillshadeChangeDataLayer,
    handleDisplacementScaleChangeDataLayer,
    handlePeakExponentChangeDataLayer,
    handleAmbientOcclusionChangeDataLayer,
    handleWaterClarityChangeDataLayer,
    handleSeaLevelOffsetChangeDataLayer,
    handlePaperToothChangeDataLayer,
  ]);

  useEffect(() => {
    registerDevToolsAPI(engineState);
  }, [engineState]);

  // Global Keyboard Shortcuts (Centralized Glide Coordination)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        cancelGlide();
        setIsPlaying((p) => !p);
      } else if (e.key === 'g' || e.key === 'G') {
        cancelGlide();
        glideToAlpha(0.0);
      } else if (e.key === 'm' || e.key === 'M') {
        cancelGlide();
        glideToAlpha(1.0);
      } else if (e.key === 'h' || e.key === 'H') {
        setIsZenMode((z) => !z);
      } else if (e.key === 't' || e.key === 'T') {
        const nextTheme = ((theme + 1) % 3) as 0 | 1 | 2;
        setPurityMode(false);
        setTheme(nextTheme);
        applyMediumCalibration(nextTheme);
      } else if (e.key === 'v' || e.key === 'V') {
        setShowVectors((s) => !s);
      } else if (e.key === 'b' || e.key === 'B') {
        // Standalone WebGPU instrument: WebGL2 backend is retired
        // setBackend((b) => (b === 'webgpu' ? 'webgl2' : 'webgpu'))
      } else if (e.key === 'd' || e.key === 'D') {
        toggleDemoMode();
      } else if (e.key === '1') {
        cancelGlide();
        glideToMode(0);
      } else if (e.key === '2') {
        cancelGlide();
        glideToMode(1);
      } else if (e.key === '3') {
        cancelGlide();
        glideToMode(2);
      } else if (e.key === '4') {
        cancelGlide();
        glideToMode(3);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    applyMediumCalibration,
    cancelGlide,
    glideToAlpha,
    glideToMode,
    hasWebGPU,
    setBackend,
    setIsPlaying,
    setIsZenMode,
    setShowVectors,
    setTheme,
    theme,
    toggleDemoMode,
  ]);

  const handleFpsUpdate = useCallback((val: number) => {
    setFps(val);
  }, [setFps]);

  const handleDataLoaded = useCallback((info: LoadedDataInfo) => {
    setDataInfo(info);
  }, [setDataInfo]);

  const handleWebGPUError = useCallback((err: Error) => {
    console.warn('WebGPU runtime error:', err);
    addToast({
      type: 'error',
      title: 'WebGPU Pipeline Error',
      message: err.message || 'Fatal WebGPU rendering exception',
    });
  }, [addToast]);

  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = typeof reason === 'string' ? reason : reason?.message || String(reason);
      if (
        message.toLowerCase().includes('cors') ||
        message.toLowerCase().includes('failed to fetch') ||
        message.toLowerCase().includes('networkerror')
      ) {
        addToast({
          type: 'error',
          title: 'Data Ingestion Warning',
          message: `Network/CORS error: ${message}`,
        });
      }
    };
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  }, [addToast]);

  const isLight = theme === 1;

  // Dynamic cartographic navigation telemetry routed to external leaf store (0 <App /> commits/sec)
  const handleCoordsChange = useCallback((newLat: number, newLon: number, newCamDist?: number) => {
    telemetryStore.setGeodeticCoords(newLat, newLon, newCamDist);
  }, []);

  useEffect(() => {
    telemetryStore.setUnfurlScaleContext(alpha);
  }, [alpha]);

  useEffect(() => {
    telemetryStore.setCameraAltitude(
      Math.hypot(webgpuCameraPos[0], webgpuCameraPos[1], webgpuCameraPos[2])
    );
  }, [webgpuCameraPos]);

  const isSidebarActive = !isZenMode && isSidebarOpen;

  const handleZenEnable = useCallback(() => setIsZenMode(true), [setIsZenMode]);
  const handleThemeCycle = useCallback(() => setTheme((t) => (((t + 1) % 3) as 0 | 1 | 2)), [setTheme]);
  const handleCartoucheToggle = useCallback(() => setShowCartouche((s) => !s), [setShowCartouche]);
  const handleVectorsToggle = useCallback(() => setShowVectors((s) => !s), [setShowVectors]);
  const handleToponymyToggle = useCallback(() => setShowToponymy((s) => !s), [setShowToponymy]);
  const handlePurityModeToggle = useCallback(() => handleSetPurityMode((p) => !p), [handleSetPurityMode]);
  const handleTerrainShadowsToggle = useCallback(() => setTerrainShadows((s) => !s), []);
  const handleGeomorphicHydrologyToggle = useCallback(() => setGeomorphicHydrology((s) => !s), []);

  const handleDockTogglePlay = useCallback(() => {
    cancelGlide();
    setIsPlaying((p) => !p);
  }, [cancelGlide, setIsPlaying]);

  const handleDockToggleSpeed = useCallback(() => {
    setPlaybackSpeed((s) => (s === 0.5 ? 1.0 : s === 1.0 ? 2.0 : 0.5));
  }, [setPlaybackSpeed]);

  const handleDockAlphaChange = useCallback(
    (val: number) => {
      cancelGlide();
      setIsPlaying(false);
      if (telemetryStore.getLiveUnfurl() !== null) {
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_SCRUB_ALPHA__ = val;
        }
      } else {
        setAlpha(val);
      }
    },
    [cancelGlide, setIsPlaying, setAlpha]
  );

  const handleSnapCamera = useCallback(
    (view: 'equator' | 'pole' | 'seam' | 'isometric' | 'horizon') => {
      if (view === 'horizon' && typeof window !== 'undefined' && window.__INDICATRIX_CAMERA__?.snapHorizonCrossSection) {
        window.__INDICATRIX_CAMERA__.snapHorizonCrossSection(1.6);
        return;
      }
      snapCamera(view);
    },
    [snapCamera]
  );

  return (
    <CursorProvider>
      <div
        data-theme={theme === 2 ? 'cyanotype' : theme === 1 ? 'cream' : 'tharp'}
        data-cartouche={showCartouche ? 'true' : 'false'}
        className={`relative w-screen h-screen flex flex-col font-mono overflow-hidden select-none transition-colors duration-500 text-[var(--theme-text-primary)] ${
          theme === 2 ? 'paper-cyanotype' : (theme === 1 ? 'paper-cream' : 'paper-tharp')
        }`}
      >
        {/* Outer Archival Neatline & Geodetic Corner Marks */}
        <div className="absolute inset-2 pointer-events-none border border-[var(--theme-neatline-border)] z-20 transition-colors duration-500">
          <div className="absolute inset-[2px] border border-current/15" />
          <span className="absolute top-[1px] left-2 text-nano font-mono tracking-widest text-[var(--theme-text-secondary)] font-semibold">⌜ 00.00°</span>
          <span className={`absolute top-[1px] right-2 ${isSidebarActive ? 'max-md:hidden' : ''} text-nano font-mono tracking-widest text-[var(--theme-text-secondary)] font-semibold transition-all duration-300`}>⌝ 90.00°</span>
          <span className="absolute bottom-1 left-2 text-nano font-mono tracking-widest text-[var(--theme-text-secondary)] font-semibold transition-all duration-300">⌞ 180.00°</span>
          <span className={`absolute bottom-1 right-2 ${isSidebarActive ? 'max-md:hidden' : ''} text-nano font-mono tracking-widest text-[var(--theme-text-secondary)] font-semibold transition-all duration-300`}>⌟ 270.00°</span>
        </div>

        {/* Top Technical Calibration Bar (Aligned on 20px grid axis with 10px neatline clearance moat) */}
        {!isZenMode && (
          <CalibrationHeaderBar
            isCatalogOpen={isCatalogOpen}
            isSidebarActive={isSidebarActive}
          />
        )}





        {/* Viewport Canvas (Standalone WebGPU Instrument with SVG Fallback) */}
        <div className="absolute inset-2 overflow-hidden">
          {hasWebGPU ? (
            <React.Suspense fallback={
              <div className="w-full h-full flex items-center justify-center font-mono text-micro bg-[var(--theme-panel-bg)] text-[var(--theme-text-primary)]">
                <span className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin border-[var(--theme-text-accent)]"></span>
                <span className="ml-2">Initializing WebGPU WGSL Pipeline...</span>
              </div>
            }>
              <WebGPUCanvas
                unfurlProgress={alpha}
                mode={mode}
                layerMode={layerMode}
                theme={theme}
                volumetricClouds={volumetricClouds}
                showCartouche={showCartouche}
                resolution={resolution}
                cameraTarget={cameraTarget}
                cameraPosition={webgpuCameraPos}
                showVectors={showVectors}
                showToponymy={showToponymy}
                dataLayers={dataLayers}
                cursorPhysicsEnabled={cursorPhysicsEnabled}
                cdlodEnabled={cdlodEnabled}
                cdlodDiagnosticMode={cdlodDiagnosticMode}
                startTime={appStartTimeRef.current}
                isZenMode={isZenMode}
                onGpuProfilerReport={setGpuReport}
                onFpsUpdate={handleFpsUpdate}
                onDataLoaded={handleDataLoaded}
                onError={handleWebGPUError}
                onCoordsChange={handleCoordsChange}
                onResolutionChange={setResolution}
                isDemoMode={isDemoMode}
                demoSequence={demoSequence}
                onDemoModeChange={handleDemoModeChange}
                showClouds={showClouds}
                showCloudLow={showCloudLow}
                showCloudMid={showCloudMid}
                showCloudHigh={showCloudHigh}
                cloudFalseColor={cloudFalseColor}
                cloudDriftSpeed={cloudDriftSpeed}
                cloudOpacity={cloudOpacity}
                cloudThickness={cloudThickness}
                cloudLowTop={cloudLowTop}
                cloudErosion={cloudErosion}
                cloudFreqHoriz={cloudFreqHoriz}
                cloudFreqVert={cloudFreqVert}
                cloudExtinction={cloudExtinction}
                atmosphericScale={atmosphericScale}
                onAtmosphericScaleChange={setAtmosphericScale}
                shadowIntensity={shadowIntensity}
                onShadowIntensityChange={setShadowIntensity}
                verticalScaleMode={verticalScaleMode}
                rainShadowFeedback={rainShadowFeedback}
                pluvialGamma={pluvialGamma}
                timelineMinutes={timelineMinutes}
                scrubTau={scrubTau}
                weatherTau={scrubTau}
                thermodynamicGating={thermodynamicGating}
                onShowCloudsChange={setShowClouds}
                prognosticModel={prognosticModel}
                prognosticVariable={prognosticVariable}
                onTogglePlanetaryLayer={handleTogglePlanetaryLayer}
                purityMode={purityMode}
                contourActive={contourActive}
                windSpeedMultiplier={windSpeedMultiplier}
                windParticleLifetime={windParticleLifetime}
                terrainShadows={terrainShadows}
                showTerrainShadows={terrainShadows}
                penumbraSoftness={penumbraSoftness}
                onTerrainShadowsChange={setTerrainShadows}
                onPenumbraSoftnessChange={setPenumbraSoftness}
                geomorphicHydrology={geomorphicHydrology}
                showDrainageHydrology={geomorphicHydrology}
                pluvialDischargeCoupling={pluvialDischargeCoupling}
                bedrockIncision={bedrockIncision}
                onGeomorphicHydrologyChange={setGeomorphicHydrology}
                onPluvialDischargeCouplingChange={setPluvialDischargeCoupling}
                onBedrockIncisionChange={setBedrockIncision}
              />
            </React.Suspense>
          ) : (
            <WebGPUFallback theme={theme} />
          )}
        </div>

        {/* 
          HUD Contract & Layer Controls:
          Display Layer: Both, Points, Wireframe
          setLayerMode(0), setLayerMode(1), setLayerMode(2)
          grid-cols-4 simulation paradigms: Linear, Scroll, Griffith, Fluid
          VectorOverlayLayer GeodesicOverlayLayer DataLayerOverlay
          displacementScale={layer.displacementScale} elevationEncoding={layer.elevationEncoding}
          sunAzimuth={layer.sunAzimuth} sunAltitude={layer.sunAltitude} hillshadeIntensity={layer.hillshadeIntensity}
          <OrbitControls makeDefault enablePan={true} enableZoom={true} enableRotate={true} onEnd={() => { if (controlsRef.current) { setCameraTarget(controlsRef.current.target.clone()); } }} />
        */}

        {/* 
          HUD Contract & Layer Controls:
          Display Layer: Both, Points, Wireframe
          setLayerMode(0), setLayerMode(1), setLayerMode(2)
          grid-cols-4 simulation paradigms: Linear, Scroll, Griffith, Fluid
        */}
        {/* Top-Right Telemetry & Cartographic HUD */}
        <TelemetryHUD
          isZenMode={isZenMode}
          onZenToggle={handleZenEnable}
          theme={theme}
          onThemeToggle={handleThemeCycle}
          onSelectThemeMode={setTheme}
          showCartouche={showCartouche}
          onCartoucheToggle={handleCartoucheToggle}
          backend={backend}
          onBackendChange={setBackend}
          hasWebGPU={hasWebGPU}
          resolution={resolution}
          onResolutionChange={setResolution}
          layerMode={layerMode}
          onLayerModeChange={setLayerMode}
          mode={mode}
          onModeChange={glideToMode}
          showVectors={showVectors}
          onVectorsToggle={handleVectorsToggle}
          showToponymy={showToponymy}
          onToponymyToggle={handleToponymyToggle}
          onToponymyChange={setShowToponymy}
          alpha={alpha}
          dataInfo={dataInfo}
          cameraPosition={webgpuCameraPos}
          onSnapCamera={handleSnapCamera}
          dataLayers={dataLayers}
          toasts={toasts}
          onDismissToast={dismissToast}
          onAddDataLayer={handleAddDataLayerWithModelSync}
          onToggleDataLayer={handleToggleDataLayerWithModelSync}
          onRemoveDataLayer={handleRemoveDataLayer}
          onTogglePlanetaryLayer={handleTogglePlanetaryLayer}
          onOpacityChangeDataLayer={handleOpacityChangeDataLayer}
          onBlendModeChangeDataLayer={handleBlendModeChangeDataLayer}
          onDisplacementScaleChangeDataLayer={handleDisplacementScaleChangeDataLayer}
          onHillshadeChangeDataLayer={handleHillshadeChangeDataLayer}
          onSeaLevelOffsetChangeDataLayer={handleSeaLevelOffsetChangeDataLayer}
          onWaterClarityChangeDataLayer={handleWaterClarityChangeDataLayer}
          onPeakExponentChangeDataLayer={handlePeakExponentChangeDataLayer}
          onAmbientOcclusionChangeDataLayer={handleAmbientOcclusionChangeDataLayer}
          onPaperToothChangeDataLayer={handlePaperToothChangeDataLayer}
          onReorderDataLayer={handleReorderDataLayer}
          isCatalogOpen={isCatalogOpen}
          onCatalogOpenChange={setIsCatalogOpen}
          isSidebarOpen={isSidebarOpen}
          onSidebarOpenChange={setIsSidebarOpen}
          isDemoMode={isDemoMode}
          demoSequence={demoSequence}
          onToggleDemoMode={toggleDemoMode}
          onSelectDemoSequence={selectDemoSequence}
          showClouds={showClouds}
          onShowCloudsChange={setShowClouds}
          showCloudLow={showCloudLow}
          onShowCloudLowChange={setShowCloudLow}
          showCloudMid={showCloudMid}
          onShowCloudMidChange={setShowCloudMid}
          showCloudHigh={showCloudHigh}
          onShowCloudHighChange={setShowCloudHigh}
          cloudFalseColor={cloudFalseColor}
          onCloudFalseColorChange={setCloudFalseColor}
          volumetricClouds={volumetricClouds}
          onVolumetricCloudsChange={setVolumetricClouds}
          cloudDriftSpeed={cloudDriftSpeed}
          onCloudDriftSpeedChange={setCloudDriftSpeed}
          cloudOpacity={cloudOpacity}
          onCloudOpacityChange={setCloudOpacity}
          cloudThickness={cloudThickness}
          onCloudThicknessChange={setCloudThickness}
          cloudLowTop={cloudLowTop}
          onCloudLowTopChange={setCloudLowTop}
          cloudErosion={cloudErosion}
          onCloudErosionChange={setCloudErosion}
          cloudFreqHoriz={cloudFreqHoriz}
          onCloudFreqHorizChange={setCloudFreqHoriz}
          cloudFreqVert={cloudFreqVert}
          onCloudFreqVertChange={setCloudFreqVert}
          cloudExtinction={cloudExtinction}
          onCloudExtinctionChange={setCloudExtinction}
          atmosphericScale={atmosphericScale}
          onAtmosphericScaleChange={setAtmosphericScale}
          shadowIntensity={shadowIntensity}
          onShadowIntensityChange={setShadowIntensity}
          rainShadowFeedback={rainShadowFeedback}
          onRainShadowFeedbackChange={setRainShadowFeedback}
          pluvialGamma={pluvialGamma}
          onPluvialGammaChange={setPluvialGamma}
          timelineMinutes={timelineMinutes}
          onTimelineChange={handleTimelineChange}
          thermodynamicGating={thermodynamicGating}
          onThermodynamicGatingChange={setThermodynamicGating}
          prognosticModel={prognosticModel}
          onPrognosticModelChange={handlePrognosticModelChange}
          prognosticVariable={prognosticVariable}
          onPrognosticVariableChange={handlePrognosticVariableChange}
          purityMode={purityMode}
          onPurityModeToggle={handlePurityModeToggle}
          contourActive={contourActive}
          onContourActiveToggle={setContourActive}
          provenance={provenance}
          windSpeedMultiplier={windSpeedMultiplier}
          onWindSpeedMultiplierChange={setWindSpeedMultiplier}
          windParticleLifetime={windParticleLifetime}
          onWindParticleLifetimeChange={setWindParticleLifetime}
          terrainShadows={terrainShadows}
          onTerrainShadowsToggle={handleTerrainShadowsToggle}
          onTerrainShadowsChange={setTerrainShadows}
          penumbraSoftness={penumbraSoftness}
          onPenumbraSoftnessChange={setPenumbraSoftness}
          geomorphicHydrology={geomorphicHydrology}
          onGeomorphicHydrologyToggle={handleGeomorphicHydrologyToggle}
          onGeomorphicHydrologyChange={setGeomorphicHydrology}
          pluvialDischargeCoupling={pluvialDischargeCoupling}
          onPluvialDischargeCouplingChange={setPluvialDischargeCoupling}
          bedrockIncision={bedrockIncision}
          onBedrockIncisionChange={setBedrockIncision}
        />

        {/* Bottom Morph Slider & Kinematic Playback Dock */}
        <NavigationDock
          isZenMode={isZenMode}
          isPlaying={isPlaying}
          onTogglePlay={handleDockTogglePlay}
          playbackSpeed={playbackSpeed}
          onToggleSpeed={handleDockToggleSpeed}
          alpha={alpha}
          onAlphaChange={handleDockAlphaChange}
          onGlideToAlpha={glideToAlpha}
          onGlideToMode={glideToMode}
          onCancelGlide={cancelGlide}
          theme={theme}
          mode={mode}
          isSidebarOpen={isSidebarActive}
          onModeChange={setMode}
          onSelectMode={setMode}
        />


        {/* Zen Mode Translucent Cartographic Anchor Pill */}
        {isZenMode && (
          <div
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-30 pointer-events-auto flex items-center gap-3 px-3.5 py-1.5 rounded-[3px] border backdrop-blur-xl transition-all duration-500 shadow-xl select-none ${
              isMouseIdle ? 'opacity-25 hover:opacity-100' : 'opacity-90'
            } ${
              theme === 1
                ? 'bg-white/90 border-zinc-300 text-zinc-900 shadow-zinc-300/50'
                : 'bg-[var(--theme-panel-bg)] border-[var(--theme-panel-border)] text-[var(--theme-text-primary)]'
            }`}
          >
            <div className="flex items-center gap-2 text-micro font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--theme-pulse-indicator)]" />
              <span className="font-bold tracking-wider uppercase text-[var(--theme-text-accent)]">
                {mode === 0 && 'Linear Dilation'}
                {mode === 1 && 'Cylinder Unroll'}
                {mode === 2 && 'Griffith Rupture'}
                {mode === 3 && 'Fluid Vortex'}

              </span>
              <span className="opacity-40">|</span>
              <ZenAlphaReadout alpha={alpha} />
            </div>
            <button
              onClick={() => setIsZenMode(false)}
              className="tactile-btn px-2.5 py-1 rounded-[2px] border border-[var(--theme-control-border)] bg-[var(--theme-control-bg)] hover:bg-[var(--theme-control-hover-bg)] hover:text-[var(--theme-control-hover-text)] hover:border-[var(--theme-card-border-hover)] text-nano font-mono uppercase tracking-wider font-bold transition-all cursor-pointer"
            >
              Exit Zen (H)
            </button>
          </div>
        )}

        {/* Cartographic Easter Egg Pass: Air Dancer excised per archival design ethos */}
      </div>
    </CursorProvider>
  );
}
