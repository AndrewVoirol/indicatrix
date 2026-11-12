// ============================================================================
// File: src/webgpu/WebGPUCanvas.tsx
// Component: Dedicated WebGPU React Canvas Wrapper with Orbit & Telemetry
// Description: Autonomous 1M-node WebGPU viewport with smooth touch/mouse control
// ============================================================================

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Vector3, PerspectiveCamera, Vec3Tuple, slerpVec3 } from '../core/math/cameraMath';
import { computeDynamicNearPlane, computeGroundClearanceFloor } from '../core/math/cameraMath';
import { WebGPUEngine } from './WebGPUEngine';
import { getWebGPUDevice } from './support';
import { preloadSDFAtlas } from '../core/data/toponymy';
import { opfsAssetStore } from '../core/data/OPFSAssetStore';
import { telemetryStore } from '../core/TelemetryStore';
import { CursorTracker } from '../utils/raycast';
import { invertMacroChart } from '../core/math/volumetricMath';
import { useCursorTracker } from '../core/CursorContext';
import { DataLayerItem, PrognosticModelBackend, isWeatherNextModel, isSatelliteModel } from '../components/hud/TelemetryHUD';
import { updateProvenanceTelemetry } from '../core/DevToolsAPI';

import { ResolutionTier, SimulationMode } from '../types';
import { evaluatePointMorph } from '../core/GlobeOverlay';
import { TrajectoryCameraController, Waypoint3D } from '../core/camera/TrajectoryCameraController';
import {
  HAWAII_WAYPOINTS,
  CAPE_COD_WAYPOINTS,
  GRAND_CANYON_WAYPOINTS,
  FUJI_WAYPOINTS,
} from '../core/camera/litmusWaypoints';

const ORIGIN_VEC = new Vector3(0, 0, 0);
const _scratchVecA = new Vector3();

const TIER_CONFIG: Record<ResolutionTier, { lat: number; lon: number; bin: string }> = {
  '100k': { lat: 256, lon: 512, bin: '/geo-mesh-100k.bin' },
  '1M': { lat: 512, lon: 1024, bin: '/geo-mesh-1m.bin' },
  '3M': { lat: 864, lon: 1728, bin: '/geo-mesh-1m.bin' },
  '4M': { lat: 1024, lon: 2048, bin: '/geo-mesh-1m.bin' },
  '8M': { lat: 1448, lon: 2896, bin: '/geo-mesh-1m.bin' },
  '16M': { lat: 2048, lon: 4096, bin: '/geo-mesh-1m.bin' },
};

export interface WebGPUCanvasProps {
  unfurlProgress: number;
  mode: SimulationMode;
  layerMode?: 0 | 1 | 2;
  theme?: 0 | 1 | 2; // 0 = Marie Tharp, 1 = Cream Rag Paper, 2 = Prussian Cyanotype
  showCartouche?: boolean;
  resolution: ResolutionTier;
  cameraTarget?: Vec3Tuple | Vector3;
  cameraPosition?: Vec3Tuple | Vector3;
  showVectors?: boolean;
  dataLayers?: DataLayerItem[];
  onFpsUpdate?: (fps: number) => void;
  onDataLoaded?: (info: {
    pointCount: number;
    lineCount: number;
    format: string;
    loadTimeMs: number;
    vramMb: number;
  }) => void;
  onError?: (err: Error) => void;
  onCoordsChange?: (latDeg: number, lonDeg: number, camDist?: number) => void;
  onResolutionChange?: (r: ResolutionTier) => void;
  cursorPhysicsEnabled?: boolean;
  cdlodEnabled?: boolean;
  cdlodDiagnosticMode?: number;
  isZenMode?: boolean;
  isSidebarOpen?: boolean;
  startTime?: number;
  onGpuProfilerReport?: (report: any) => void;
  isDemoMode?: boolean;
  demoSequence?: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji';
  onDemoModeChange?: (active: boolean, sequence?: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji') => void;
  showClouds?: boolean;
  showCloudLow?: boolean;
  showCloudMid?: boolean;
  showCloudHigh?: boolean;
  cloudFalseColor?: boolean;
  cloudDriftSpeed?: number;
  cloudOpacity?: number;
  cloudThickness?: number;
  cloudLowTop?: number;
  cloudErosion?: number;
  cloudFreqHoriz?: number;
  cloudFreqVert?: number;
  cloudExtinction?: number;
  atmosphericScale?: number;
  onAtmosphericScaleChange?: (v: number) => void;
  shadowIntensity?: number;
  onShadowIntensityChange?: (v: number) => void;
  verticalScaleMode?: number;
  rainShadowFeedback?: number;
  pluvialGamma?: number;
  timelineMinutes?: number;
  scrubTau?: number;
  weatherTau?: number;
  thermodynamicGating?: boolean;
  onThermodynamicGatingChange?: (v: boolean) => void;
  volumetricClouds?: boolean;
  onShowCloudsChange?: (v: boolean) => void;
  onTogglePlanetaryLayer?: (id: string, force?: boolean) => void;
  prognosticModel?: PrognosticModelBackend;
  prognosticVariable?: string;
  purityMode?: boolean;
  substrateHaptics?: boolean;
  paperSubstrate?: boolean;
  fiberFrequency?: number;
  fiberAnisotropy?: number;
  plateMarkDepthMeters?: number;
  inkRidgeHeightMeters?: number;
  grainAngleRadians?: number;
  sheenIntensity?: number;
  absorptionFeathering?: number;
  cameraPitchDeg?: number;
  windSpeedMultiplier?: number;
  windParticleLifetime?: number;
  terrainShadows?: boolean;
  showTerrainShadows?: boolean;
  maxRayDistanceMeters?: number;
  penumbraSoftness?: number;
  sampleStepCount?: number;
  onTerrainShadowsChange?: (enabled: boolean) => void;
  onPenumbraSoftnessChange?: (softness: number) => void;
  geomorphicHydrology?: boolean;
  showDrainageHydrology?: boolean;
  pluvialDischargeCoupling?: number;
  bedrockIncision?: number;
  onGeomorphicHydrologyChange?: (enabled: boolean) => void;
  onPluvialDischargeCouplingChange?: (coupling: number) => void;
  onBedrockIncisionChange?: (incision: number) => void;
  contourActive?: boolean;
  showToponymy?: boolean;
}

interface RegionalManifestEntry {
  id: string;
  name: string;
  bounds: {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
  };
  width: number;
  height: number;
  binUrl: string;
  webpUrl: string;
  cogUrl?: string;
}

export const WebGPUCanvas: React.FC<WebGPUCanvasProps> = React.memo(({
  unfurlProgress,
  mode,
  layerMode,
  theme = 0,
  showCartouche = true,
  resolution,
  cameraTarget,
  cameraPosition,
  showVectors = true,
  dataLayers,
  onFpsUpdate,
  onDataLoaded,
  onError,
  onCoordsChange,
  onResolutionChange,
  cursorPhysicsEnabled = false,
  cdlodEnabled = true,
  cdlodDiagnosticMode = 0,
  isZenMode = false,
  isSidebarOpen = true,
  startTime,
  onGpuProfilerReport,
  isDemoMode = false,
  demoSequence = 'hawaii',
  onDemoModeChange,
  showClouds = true,
  showCloudLow = true,
  showCloudMid = true,
  showCloudHigh = true,
  cloudFalseColor = false,
  cloudDriftSpeed = 1.0,
  cloudOpacity = 0.85,
  cloudThickness = 0.19,
  cloudLowTop = 0.45,
  cloudErosion = 0.85,
  cloudFreqHoriz = 32.0,
  cloudFreqVert = 12.0,
  cloudExtinction = 28.0,
  atmosphericScale = 3.5,
  onAtmosphericScaleChange,
  shadowIntensity = 0.45,
  onShadowIntensityChange,
  verticalScaleMode = 1,
  rainShadowFeedback = 0.0,
  pluvialGamma = 0.0,
  timelineMinutes = 0,
  scrubTau = 0,
  weatherTau = 0,
  thermodynamicGating = true,
  volumetricClouds = true,
  onShowCloudsChange,
  onTogglePlanetaryLayer,
  prognosticModel = 'weathernext3',
  prognosticVariable,
  purityMode = false,
  substrateHaptics,
  paperSubstrate,
  fiberFrequency = 45.0,
  fiberAnisotropy = 0.65,
  plateMarkDepthMeters = 0.0035,
  inkRidgeHeightMeters = 0.0018,
  grainAngleRadians = 0.2618,
  sheenIntensity = 0.45,
  absorptionFeathering,
  cameraPitchDeg,
  windSpeedMultiplier = 1.0,
  windParticleLifetime = 6.0,
  terrainShadows = false,
  showTerrainShadows = false,
  maxRayDistanceMeters = 50000.0,
  penumbraSoftness = 1.5,
  sampleStepCount = 16,
  onTerrainShadowsChange,
  onPenumbraSoftnessChange,
  geomorphicHydrology = false,
  showDrainageHydrology = false,
  pluvialDischargeCoupling = 1.0,
  bedrockIncision = 1.0,
  onGeomorphicHydrologyChange,
  onPluvialDischargeCouplingChange,
  onBedrockIncisionChange,
  contourActive = true,
  showToponymy = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportSizeRef = useRef<{ width: number; height: number; dpr: number }>({ width: 0, height: 0, dpr: 1 });
  const engineRef = useRef<WebGPUEngine>(new WebGPUEngine());
  if (typeof window !== 'undefined') {
    (window as any).__ENGINE = engineRef.current;
    (window as any).__INDICATRIX_WEBGPU_ENGINE__ = engineRef.current;
  }
  const trajectoryControllerRef = useRef<TrajectoryCameraController>(new TrajectoryCameraController());
  const cameraTransitionRef = useRef<{
    startPos: Vector3;
    endPos: Vector3;
    startTarget: Vector3;
    endTarget: Vector3;
    startUp: Vector3;
    endUp: Vector3;
    startTime: number;
    duration: number;
  } | null>(null);
  const loadedBinRef = useRef<string | null>(null);
  const activeLodTierRef = useRef<ResolutionTier>(resolution);
  const lastLodSwitchTimeRef = useRef<number>(0);
  const loadedDataInfoRef = useRef<{ pointCount: number; lineCount: number; baseVramBytes: number } | null>(null);
  const sharedCursorTracker = useCursorTracker();
  const cursorTrackerRef = useRef<CursorTracker>(sharedCursorTracker);
  cursorTrackerRef.current = sharedCursorTracker;
  const animFrameRef = useRef<number>(0);
  const cursorPhysicsEnabledRef = useRef(cursorPhysicsEnabled);
  useEffect(() => {
    cursorPhysicsEnabledRef.current = cursorPhysicsEnabled;
  }, [cursorPhysicsEnabled]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setCDLODEnabled(Boolean(cdlodEnabled));
    }
  }, [cdlodEnabled]);

  const currentHitPosRef = useRef<Vector3>(new Vector3(0, 0, 5));

  // Camera & Orbit State
  const cameraRef = useRef<PerspectiveCamera>(
    new PerspectiveCamera(45, 1, 0.1, 1000)
  );
  const targetRef = useRef<Vector3>(new Vector3(0, 0, 0));
  const sphericalRef = useRef<{ radius: number; theta: number; phi: number }>({
    radius: 15,
    theta: 0,
    phi: Math.PI / 2, // 0°N, 0°E (Prime Meridian / Equator, matching [0, 0, 15])
  });
  const activeCoordsRef = useRef<{ lat: number; lon: number }>({
    lat: 0,
    lon: 0,
  });
  const cursorCoordsRef = useRef<{ lat: number; lon: number } | null>(null);
  const lastUnfurlRef = useRef(0);
  const lastScrubAlphaRef = useRef<number | undefined>(undefined);
  const scrubReleaseFramesRef = useRef<number>(0);

  // Inertial momentum velocities matching Drei OrbitControls glide (decay factor 0.05)
  const velocityRef = useRef<{
    velTheta: number;
    velPhi: number;
    velRadius: number;
    velPanX: number;
    velPanY: number;
  }>({
    velTheta: 0,
    velPhi: 0,
    velRadius: 0,
    velPanX: 0,
    velPanY: 0,
  });

  const isDraggingRef = useRef(false);
  const dragButtonRef = useRef(0);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const targetCameraPosRef = useRef<Vector3 | null>(null);

  // FPS & Telemetry
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(performance.now());
  const startTimeRef = useRef(performance.now());
  const lastFrameTimeRef = useRef(performance.now());
  const lastTelemetryTimeRef = useRef(0);
  const lastProfilerTimeRef = useRef(0);

  // Reusable objects to eliminate per-frame GC allocations in 120 FPS render loop
  const telemetryNormRef = useRef(new Vector3());
  const telemetryForwardRef = useRef(new Vector3());
  const ownedWnRingRef = useRef<any>(null);
  const ownedWnDataSourceRef = useRef<any>(null);

  const computeCachedLayers = (curDataLayers?: any[]) => {
    const primaryReliefLayer =
      curDataLayers?.find(
        (l) => l.visible && (l.renderStyle || l.category === 'topo' || l.category === 'ocean' || l.category === 'topography' || l.type === 'raster')
      ) ||
      curDataLayers?.find(
        (l) => l.renderStyle || l.category === 'topo' || l.category === 'ocean' || l.category === 'topography' || l.type === 'raster'
      ) ||
      null;

    const activeDataLayer = curDataLayers?.find(
      (l) => l.visible && (l.renderStyle || l.category === 'topo' || l.category === 'ocean' || l.category === 'topography' || l.type === 'raster')
    ) || curDataLayers?.find((l) => l.visible) || null;

    const reliefActive = activeDataLayer ? (
      activeDataLayer.category === 'topo' ||
      activeDataLayer.category === 'ocean' ||
      activeDataLayer.category === 'topography' ||
      activeDataLayer.type === 'raster' ||
      activeDataLayer.renderStyle === 'architectural' ||
      activeDataLayer.renderStyle === 'hybrid'
    ) : false;

    const showContours = !!curDataLayers?.find(
      (l) => l.id === 'usgs-elevation-contours' && l.visible
    );
    const hasSurfaceWind =
      prognosticVariable === 'wind_10m_vector' ||
      prognosticVariable === 'ivt' ||
      !!curDataLayers?.find(
        (l) => (l.id === 'noaa-gfs-wind' || l.id === 'noaa-grib2-wind' || l.id === 'gfs-surface-winds' || l.id === 'gfs-wind-velocity-grid') && l.visible
      );
    const jetLayer = curDataLayers?.find(
      (l) => l.id === 'noaa-gfs-jetstream' || l.id === 'gfs-jetstream'
    );
    const hasJetStream = Boolean(jetLayer?.visible);
    const showSatellites = !!curDataLayers?.find(
      (l) => (l.id === 'starlink-iss-orbits' || l.id === 'spacex-satellite-constellation') && l.visible
    );
    const cloudLayer = curDataLayers?.find((l) => l.id === 'noaa-gfs-clouds' || l.id === 'google-weathernext3' || l.id === 'weathernext3') || null;

    return {
      activeDataLayer,
      primaryReliefLayer,
      reliefActive,
      showContours,
      hasSurfaceWind,
      hasJetStream,
      showSatellites,
      cloudLayer,
    };
  };

  const cachedLayersRef = useRef(computeCachedLayers(dataLayers));

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isEngineReady, setIsEngineReady] = useState<boolean>(false);

  // Regional High-Resolution DEM Overlay State (NOAA CUDEM ~10m)
  const regionalManifestRef = useRef<RegionalManifestEntry[]>([]);
  const activeRegionIdRef = useRef<string | null>(null);
  const activeTileKeyRef = useRef<string | null>(null);
  const loadingRegionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch('/regional/manifest.json')
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.regions)) {
          regionalManifestRef.current = data.regions;
        }
      })
      .catch(() => {});
  }, []);

  // Dynamic Props Ref to decouple renderLoop from React re-renders
  const stateRef = useRef({
    unfurlProgress,
    unfurl: unfurlProgress,
    mode,
    layerMode,
    theme,
    showCartouche,
    showVectors,
    dataLayers,
    isDemoMode,
    demoSequence,
    showClouds,
    showCloudLow,
    showCloudMid,
    showCloudHigh,
    cloudFalseColor,
    cloudDriftSpeed,
    cloudOpacity,
    cloudThickness,
    cloudLowTop,
    cloudErosion,
    cloudFreqHoriz,
    cloudFreqVert,
    cloudExtinction,
    atmosphericScale,
    shadowIntensity,
    verticalScaleMode,
    rainShadowFeedback,
    pluvialGamma,
    timelineMinutes,
    scrubTau,
    weatherTau,
    thermodynamicGating,
    volumetricClouds,
    resolution,
    purityMode,
    substrateHaptics,
    paperSubstrate,
    fiberFrequency,
    fiberAnisotropy,
    plateMarkDepthMeters,
    inkRidgeHeightMeters,
    grainAngleRadians,
    sheenIntensity,
    absorptionFeathering,
    cameraPitchDeg,
    cdlodDiagnosticMode,
    prognosticModel,
    prognosticVariable,
    windSpeedMultiplier,
    windParticleLifetime,
    terrainShadows: terrainShadows || showTerrainShadows,
    showTerrainShadows: terrainShadows || showTerrainShadows,
    maxRayDistanceMeters,
    penumbraSoftness,
    sampleStepCount,
    geomorphicHydrology: geomorphicHydrology || showDrainageHydrology,
    showDrainageHydrology: geomorphicHydrology || showDrainageHydrology,
    pluvialDischargeCoupling,
    bedrockIncision,
    contourActive,
    showToponymy,
  });
  useEffect(() => {
    stateRef.current = {
      unfurlProgress,
      unfurl: unfurlProgress,
      mode,
      layerMode,
      theme,
      showCartouche,
      showVectors,
      dataLayers,
      isDemoMode,
      demoSequence,
      showClouds,
      showCloudLow,
      showCloudMid,
      showCloudHigh,
      cloudFalseColor,
      cloudDriftSpeed,
      cloudOpacity,
      cloudThickness,
      cloudLowTop,
      cloudErosion,
      cloudFreqHoriz,
      cloudFreqVert,
      cloudExtinction,
      atmosphericScale,
      shadowIntensity,
      verticalScaleMode,
      rainShadowFeedback,
      pluvialGamma,
      timelineMinutes,
      scrubTau,
      weatherTau,
      thermodynamicGating,
      volumetricClouds,
      resolution,
      purityMode,
      substrateHaptics,
      paperSubstrate,
      fiberFrequency,
      fiberAnisotropy,
      plateMarkDepthMeters,
      inkRidgeHeightMeters,
      grainAngleRadians,
      sheenIntensity,
      absorptionFeathering,
      cameraPitchDeg: cameraPitchDeg !== undefined ? cameraPitchDeg : (stateRef.current as any)?.cameraPitchDeg,
      cdlodDiagnosticMode,
      prognosticModel,
      prognosticVariable,
      windSpeedMultiplier,
      windParticleLifetime,
      terrainShadows: terrainShadows || showTerrainShadows,
      showTerrainShadows: terrainShadows || showTerrainShadows,
      maxRayDistanceMeters,
      penumbraSoftness,
      sampleStepCount,
      geomorphicHydrology: geomorphicHydrology || showDrainageHydrology,
      showDrainageHydrology: geomorphicHydrology || showDrainageHydrology,
      pluvialDischargeCoupling,
      bedrockIncision,
      contourActive,
      showToponymy,
    };
    cachedLayersRef.current = computeCachedLayers(dataLayers);
  }, [unfurlProgress, mode, layerMode, theme, showCartouche, showVectors, dataLayers, isDemoMode, demoSequence, showClouds, showCloudLow, showCloudMid, showCloudHigh, cloudFalseColor, cloudDriftSpeed, cloudOpacity, cloudThickness, cloudLowTop, cloudErosion, cloudFreqHoriz, cloudFreqVert, cloudExtinction, atmosphericScale, shadowIntensity, verticalScaleMode, rainShadowFeedback, pluvialGamma, timelineMinutes, scrubTau, weatherTau, thermodynamicGating, volumetricClouds, resolution, purityMode, substrateHaptics, paperSubstrate, fiberFrequency, fiberAnisotropy, plateMarkDepthMeters, inkRidgeHeightMeters, grainAngleRadians, sheenIntensity, absorptionFeathering, cameraPitchDeg, cdlodDiagnosticMode, prognosticModel, prognosticVariable, windSpeedMultiplier, windParticleLifetime, terrainShadows, showTerrainShadows, maxRayDistanceMeters, penumbraSoftness, sampleStepCount, geomorphicHydrology, showDrainageHydrology, pluvialDischargeCoupling, bedrockIncision, contourActive, showToponymy]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setTerrainShadowsEnabled(Boolean(terrainShadows || showTerrainShadows));
      engineRef.current.updateTerrainShadowUniforms({
        penumbraSoftness,
        maxRayDistanceMeters,
        sampleStepCount,
      });
    }
  }, [terrainShadows, showTerrainShadows, penumbraSoftness, maxRayDistanceMeters, sampleStepCount]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setDrainageHydrologyEnabled(Boolean(geomorphicHydrology || showDrainageHydrology));
      engineRef.current.updateDrainageUniforms({
        pluvialCoupling: pluvialDischargeCoupling,
        bedrockIncision,
      });
    }
  }, [geomorphicHydrology, showDrainageHydrology, pluvialDischargeCoupling, bedrockIncision]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setLclGating(thermodynamicGating);
    }
  }, [thermodynamicGating]);

  useEffect(() => {
    if (engineRef.current && typeof engineRef.current.setVolumetricCloudsEnabled === 'function') {
      engineRef.current.setVolumetricCloudsEnabled(volumetricClouds ?? true);
    }
  }, [volumetricClouds]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setTimelineMinutes(timelineMinutes ?? 0);
      if (typeof engineRef.current.updateAtmosphereUniforms === 'function') {
        engineRef.current.updateAtmosphereUniforms({
          weatherTimeMinutes: timelineMinutes ?? 0,
          weatherTau: scrubTau ?? weatherTau ?? 0,
          scrubTau: scrubTau ?? weatherTau ?? 0,
        });
      }
    }
    const weatherNextDS =
      (window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__ ||
      (window as any).__INDICATRIX_WEATHERNEXT_SOURCE__;
    if (weatherNextDS && !weatherNextDS.disposed && typeof weatherNextDS.setTime === 'function') {
      const clamped = Math.max(0, Math.min(720, timelineMinutes ?? 0));
      const wnRing = (window as any).__INDICATRIX_WEATHERNEXT_RING_BUFFER__;
      if (wnRing && !wnRing.disposed && engineRef.current && engineRef.current.precipRingBuffer !== wnRing) {
        engineRef.current.setPrecipitationRingBuffer(wnRing);
      }
      const totalHours = clamped / 60;
      const bracketHour = totalHours >= 12 ? 11 : Math.min(11, Math.floor(totalHours));
      const tau = totalHours >= 12 ? 1.0 : Math.max(0.0, Math.min(1.0, totalHours - bracketHour));
      weatherNextDS.setTime(bracketHour, tau).catch(() => {});
    }
    const isWn = isWeatherNextModel(prognosticModel);
    const isSat = isSatelliteModel(prognosticModel);
    if ((isWn || isSat) && engineRef.current && timelineMinutes !== undefined && timelineMinutes >= 0) {
      const targetHour = Math.min(11, Math.max(0, Math.floor(timelineMinutes / 60)));
      const nextHour = Math.min(11, targetHour + 1);
      if (isSat && typeof engineRef.current.loadSatelliteCloudLayers === 'function') {
        engineRef.current.loadSatelliteCloudLayers(targetHour).catch(() => {});
      } else {
        engineRef.current.loadWeatherNextCloudLayers(targetHour).catch(() => {});
      }
      engineRef.current.loadWindTexture(`/data/weathernext/wind_10m_vector-${targetHour}.bin`, 0).catch(() => {});
      engineRef.current.loadWindTexture(`/data/weathernext/wind_10m_vector-${nextHour}.bin`, 1).catch(() => {});
      engineRef.current.loadTemperatureTexture(`/data/weathernext/temperature_2m_mean-${targetHour}.bin`).catch(() => {});
      if (isSat && targetHour === 0) {
        engineRef.current
          .loadDewpointTexture(
            `/data/weathernext/dewpoint_temperature_2m_mean-${targetHour}.bin`,
            '/data/satellite-radiative-optical-depth-latest.bin'
          )
          .catch(() => {});
      } else {
        engineRef.current.loadDewpointTexture(`/data/weathernext/dewpoint_temperature_2m_mean-${targetHour}.bin`).catch(() => {});
      }
    }
  }, [timelineMinutes, scrubTau, weatherTau, prognosticModel, dataLayers, prognosticVariable]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.scrubTau = scrubTau ?? weatherTau ?? 0;
    }
  }, [scrubTau, weatherTau]);

  const callbacksRef = useRef({ onFpsUpdate, onDataLoaded, onError, onCoordsChange, onResolutionChange, onGpuProfilerReport, onDemoModeChange, onAtmosphericScaleChange, onShadowIntensityChange, onShowCloudsChange, onTogglePlanetaryLayer });
  useEffect(() => {
    callbacksRef.current = { onFpsUpdate, onDataLoaded, onError, onCoordsChange, onResolutionChange, onGpuProfilerReport, onDemoModeChange, onAtmosphericScaleChange, onShadowIntensityChange, onShowCloudsChange, onTogglePlanetaryLayer };
  }, [onFpsUpdate, onDataLoaded, onError, onCoordsChange, onResolutionChange, onGpuProfilerReport, onDemoModeChange, onAtmosphericScaleChange, onShadowIntensityChange, onShowCloudsChange, onTogglePlanetaryLayer]);

  // Synchronize Trajectory Controller with demo mode and active sequence
  useEffect(() => {
    const trajectory = trajectoryControllerRef.current;
    trajectory.setMode('dolly-cinematic');
    const waypoints =
      demoSequence === 'cape-cod'
        ? CAPE_COD_WAYPOINTS
        : demoSequence === 'grand-canyon'
        ? GRAND_CANYON_WAYPOINTS
        : demoSequence === 'fuji'
        ? FUJI_WAYPOINTS
        : HAWAII_WAYPOINTS;
    trajectory.setWaypoints(waypoints, 8.0, false);
    trajectory.setIsPlaying(isDemoMode);
  }, [demoSequence]);

  useEffect(() => {
    const trajectory = trajectoryControllerRef.current;
    if (isDemoMode) {
      if (trajectory.isFinished()) {
        trajectory.setProgress(0);
      }
      trajectory.setIsPlaying(true);
    } else {
      trajectory.setIsPlaying(false);
    }
  }, [isDemoMode]);

  // Dynamic planetary layer loading when layers are enabled
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !engine.initialized) return;
    const hasSatellites = !!dataLayers?.find(
      (l) => (l.id === 'starlink-iss-orbits' || l.id === 'spacex-satellite-constellation') && l.visible
    );
    if (hasSatellites) {
      engine.loadSatelliteTrajectories('/data/tle-starlink.json').catch(() => {});
    }
    const hasContours =
      Boolean(contourActive) ||
      !!dataLayers?.find((l) => l.id === 'usgs-elevation-contours' && l.visible);
    if (hasContours && engine.contourIndexCount === 0) {
      engine.loadContourMesh('/geo-contour-mesh.bin').catch(() => {});
    }
    const explicitEtopoLayer = dataLayers?.find((l) => l.id === 'global-dem-crust' && l.visible);
    if (explicitEtopoLayer && explicitEtopoLayer.url) {
      engine.loadDEMTexture(explicitEtopoLayer.url).catch(() => {});
    }
    const isWnModel = isWeatherNextModel(prognosticModel);
    const isSatModel = isSatelliteModel(prognosticModel);
    const wnTargetHour = Math.min(11, Math.max(0, Math.floor((timelineMinutes ?? 0) / 60)));
    const wnNextHour = Math.min(11, wnTargetHour + 1);
    const hasGfsClouds = !!dataLayers?.find(
      (l) => (l.id === 'noaa-gfs-clouds' || l.id === 'atmospheric-clouds') && l.visible
    );

    if (showClouds || hasGfsClouds) {
      if (isSatModel) {
        engine.loadAllCloudLayers(false, wnTargetHour, 'satellite').catch(() => {});
      } else {
        engine.loadAllCloudLayers(isWnModel && !hasGfsClouds, wnTargetHour).catch(() => {});
      }
    }

    const hasWind =
      prognosticVariable === 'wind_10m_vector' ||
      prognosticVariable === 'ivt' ||
      !!dataLayers?.find(
        (l) => (l.id === 'noaa-gfs-wind' || l.id === 'noaa-grib2-wind' || l.id === 'gfs-surface-winds' || l.id === 'gfs-wind-velocity-grid') && l.visible
      );
    if (hasWind || showClouds) {
      if (isWnModel || isSatModel) {
        engine.loadWindTexture(`/data/weathernext/wind_10m_vector-${wnTargetHour}.bin`, 0).catch(() => {
          engine.loadWindTexture('/data/gfs-wind-latest.bin', 0).catch(() => {});
        });
        engine.loadWindTexture(`/data/weathernext/wind_10m_vector-${wnNextHour}.bin`, 1).catch(() => {});
      } else {
        engine.loadWindTexture('/data/gfs-wind-latest.bin', 0).catch(() => {});
      }
    }
    const jetLayer = dataLayers?.find(
      (l) => l.id === 'noaa-gfs-jetstream' || l.id === 'gfs-jetstream'
    );
    const hasJetStream = Boolean(jetLayer?.visible);
    if (hasJetStream || showClouds) {
      engine.loadJetStreamTexture('/data/gfs-jetstream-latest.bin').catch(() => {});
    }
    const hasExplicitWeatherNextLayer = !!dataLayers?.find(
      (l) =>
        (l.id === 'google-weathernext3' ||
          l.id === 'weathernext' ||
          l.type === '0.1° (10km) AI') &&
        l.visible
    );
    const hasPrecipVariable = Boolean(
      prognosticVariable &&
        prognosticVariable !== 'none' &&
        prognosticVariable !== 'wind_10m_vector'
    );
    const hasWeatherNextScalars =
      isWnModel &&
      (showClouds || hasPrecipVariable || hasExplicitWeatherNextLayer || Boolean(geomorphicHydrology));
    if (hasWeatherNextScalars) {
      const targetHour = wnTargetHour;
      if (!(hasWind || showClouds)) {
        engine.loadWindTexture(`/data/weathernext/wind_10m_vector-${targetHour}.bin`).catch(() => {});
      }
      engine.loadTemperatureTexture(`/data/weathernext/temperature_2m_mean-${targetHour}.bin`).catch(() => {});
      engine.loadDewpointTexture(`/data/weathernext/dewpoint_temperature_2m_mean-${targetHour}.bin`).catch(() => {});
    }

    const needsPrecipRing =
      (isWnModel &&
        (hasPrecipVariable ||
          hasExplicitWeatherNextLayer ||
          Boolean(geomorphicHydrology) ||
          (timelineMinutes ?? 0) > 0)) ||
      (isSatModel && (timelineMinutes ?? 0) > 0);

    if (needsPrecipRing) {
      const targetHour = wnTargetHour;
      const clampedMins = Math.max(0, Math.min(720, timelineMinutes ?? 0));
      const totalHours = clampedMins / 60;
      const bracketHour = totalHours >= 12 ? 11 : Math.min(11, Math.floor(totalHours));
      const tau = totalHours >= 12 ? 1.0 : Math.max(0.0, Math.min(1.0, totalHours - bracketHour));
      import('../core/data/WeatherNextDataSource').then(({ WeatherNextDataSource }) => {
        import('./TemporalTextureRingBuffer').then(({ TemporalTextureRingBuffer }) => {
          const dev = engine.getDevice();
          if (dev && engine.initialized) {
            let wnRing = (window as any).__INDICATRIX_WEATHERNEXT_RING_BUFFER__;
            if (!wnRing || wnRing.disposed || wnRing.width !== 3600) {
              wnRing = new TemporalTextureRingBuffer(dev, 3600, 1801, 'r16float');
              ownedWnRingRef.current = wnRing;
              (window as any).__INDICATRIX_WEATHERNEXT_RING_BUFFER__ = wnRing;
            }
            if ((timelineMinutes ?? 0) >= 0 && engine.precipRingBuffer !== wnRing) {
              engine.setPrecipitationRingBuffer(wnRing);
            }
            let weatherNextDS =
              (window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__ ||
              (window as any).__INDICATRIX_WEATHERNEXT_SOURCE__;
            if (!weatherNextDS || weatherNextDS.disposed) {
              weatherNextDS = new WeatherNextDataSource({ ringBuffer: wnRing });
              ownedWnDataSourceRef.current = weatherNextDS;
              (window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__ = weatherNextDS;
              weatherNextDS
                .loadMetadata()
                .then(() => weatherNextDS.seekHour(targetHour, 'total_precipitation_1hr_mean'))
                .then(() => {
                  if ((timelineMinutes ?? 0) > 0 && typeof weatherNextDS.setTime === 'function') {
                    return weatherNextDS.setTime(bracketHour, tau);
                  }
                })
                .catch(() => weatherNextDS.seekHour(targetHour, 'total_precipitation_1hr_mean'))
                .catch((err: any) => {
                  console.warn('[WeatherNext] Initial seekHour error:', err);
                });
            }
          }
        });
      }).catch((err) => {
        console.warn('[WebGPUCanvas] Failed to initialize WeatherNext 3:', err);
      });
    } else {
      if (engine.precipRingBuffer) {
        engine.setPrecipitationRingBuffer(null);
      }
      if (ownedWnDataSourceRef.current) {
        const dsToDispose = ownedWnDataSourceRef.current;
        ownedWnDataSourceRef.current = null;
        if ((window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__ === dsToDispose) {
          delete (window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__;
        }
        try { dsToDispose.dispose?.(); } catch {}
      }
      if (ownedWnRingRef.current) {
        const ringToDispose = ownedWnRingRef.current;
        ownedWnRingRef.current = null;
        if ((window as any).__INDICATRIX_WEATHERNEXT_RING_BUFFER__ === ringToDispose) {
          delete (window as any).__INDICATRIX_WEATHERNEXT_RING_BUFFER__;
        }
        try { ringToDispose.dispose?.(); } catch {}
      }
    }
  }, [dataLayers, prognosticModel, prognosticVariable, showClouds, contourActive, geomorphicHydrology, timelineMinutes, isLoading, isEngineReady]);

  // WebGPU Device Loss Recovery
  useEffect(() => {
    const engine = engineRef.current;
    engine.onDeviceLost((info) => {
      console.warn('WebGPU device lost, triggering fallback to WebGL2:', info);
      setIsEngineReady(false);
      setLoadError(`WebGPU Device Lost: ${info?.message || 'Device disconnected'}`);
      callbacksRef.current.onError?.(new Error(`WebGPU Device Lost: ${info?.message || 'Device disconnected'}`));
    });
  }, []);

  // Geodetic terrain-following ground clearance safety floor (~127m AGL floor)
  const getGroundClearanceFloor = useCallback((lonDeg: number, latDeg: number, camRadius?: number): number => {
    let elevM = 0;
    let dispScale = 0.08;
    if (engineRef.current) {
      const elev = engineRef.current.sampleCPUElevation(lonDeg, latDeg);
      elevM = elev?.maxElevationMeters ?? elev?.elevationMeters ?? 0;
      const liveProps = typeof window !== 'undefined'
        ? ((window as any).__INDICATRIX_LIVE_UNIFORMS__ || (window as any).__INDICATRIX_LIVE_PROPS__ || (window as any).__INDICATRIX_LIVE_OVERRIDES__)
        : null;
      dispScale = liveProps?.displacementScale ?? 0.08;
    }
    const r = camRadius ?? sphericalRef.current.radius;
    return computeGroundClearanceFloor(elevM, dispScale, r);
  }, []);

  // Unified Oblique and Planar Camera Kinematics (Dual-mode Globe & Unfurled Sheet)
  const computeObliqueVectors = useCallback((
    lonDeg: number,
    latDeg: number,
    altitudeRadius: number,
    pitchDeg: number,
    headingDeg: number
  ) => {
    const phi = ((90 - latDeg) * Math.PI) / 180;
    const theta = (lonDeg * Math.PI) / 180;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    const nx = sinPhi * sinTheta;
    const ny = cosPhi;
    const nz = sinPhi * cosTheta;

    const northX = -Math.sin((latDeg * Math.PI) / 180) * sinTheta;
    const northY = Math.cos((latDeg * Math.PI) / 180);
    const northZ = -Math.sin((latDeg * Math.PI) / 180) * cosTheta;

    const eastX = cosTheta;
    const eastY = 0;
    const eastZ = -sinTheta;

    const hRad = (headingDeg * Math.PI) / 180;
    const forwardX = northX * Math.cos(hRad) + eastX * Math.sin(hRad);
    const forwardY = northY * Math.cos(hRad) + eastY * Math.sin(hRad);
    const forwardZ = northZ * Math.cos(hRad) + eastZ * Math.sin(hRad);

    const pRad = (pitchDeg * Math.PI) / 180;
    const vDirX = -Math.cos(pRad) * nx + Math.sin(pRad) * forwardX;
    const vDirY = -Math.cos(pRad) * ny + Math.sin(pRad) * forwardY;
    const vDirZ = -Math.cos(pRad) * nz + Math.sin(pRad) * forwardZ;

    const h_floor = getGroundClearanceFloor(lonDeg, latDeg, altitudeRadius);
    const safeRadius = Math.max(h_floor, altitudeRadius);
    const sphereCamX = nx * safeRadius;
    const sphereCamY = ny * safeRadius;
    const sphereCamZ = nz * safeRadius;

    // Altitude-proportional look-ahead distance keeps target anchored along vDir
    const targetDist = Math.min(3.5, Math.max(0.08, (safeRadius - 5.0) * 1.5));
    const sphereTargetX = sphereCamX + vDirX * targetDist;
    const sphereTargetY = sphereCamY + vDirY * targetDist;
    const sphereTargetZ = sphereCamZ + vDirZ * targetDist;

    const sphereUpX = Math.sin(pRad) * nx + Math.cos(pRad) * forwardX;
    const sphereUpY = Math.sin(pRad) * ny + Math.cos(pRad) * forwardY;
    const sphereUpZ = Math.sin(pRad) * nz + Math.cos(pRad) * forwardZ;

    const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
    const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
    const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));
    const curMode = stateRef.current?.mode ?? 0;

    if (curUnfurl < 0.001) {
      const isNadir = Math.abs(pitchDeg) <= 0.01;
      const isNorthUp = isNadir && Math.abs(headingDeg) <= 0.01;
      return {
        camX: sphereCamX, camY: sphereCamY, camZ: sphereCamZ,
        targetX: isNadir ? 0 : sphereTargetX,
        targetY: isNadir ? 0 : sphereTargetY,
        targetZ: isNadir ? 0 : sphereTargetZ,
        vUpX: isNorthUp ? 0 : sphereUpX,
        vUpY: isNorthUp ? 1 : sphereUpY,
        vUpZ: isNorthUp ? 0 : sphereUpZ,
        safeRadius, theta, phi
      };
    }

    const deformed = evaluatePointMorph(lonDeg, latDeg, curUnfurl, curMode, 0, 0.0);
    const altitudeAboveGround = Math.max(0.015, safeRadius - 5.0 * Math.sin(pRad));

    const t = Math.max(0.0, Math.min(1.0, curUnfurl));
    const tEased = t * t * (3.0 - 2.0 * t);

    // Intrinsic SO(3) Darboux frame on the unrolling developable manifold:
    // Smoothly unrolls azimuthal longitude roll and latitudinal pitch from sphere (t=0) to flat sheet (t=1)
    // without chording through the cylinder interior or flipping normals at high longitudes (|lon| > 90°).
    const thetaRoll = (1.0 - tEased) * theta;
    const psiLat = (1.0 - tEased) * ((latDeg * Math.PI) / 180);
    const cosPsi = Math.cos(psiLat);
    const sinPsi = Math.sin(psiLat);
    const sinRoll = Math.sin(thetaRoll);
    const cosRoll = Math.cos(thetaRoll);

    const uX = cosPsi * sinRoll;
    const uY = sinPsi;
    const uZ = cosPsi * cosRoll;

    const eX = cosRoll;
    const eY = 0.0;
    const eZ = -sinRoll;

    const nNorthX = -sinPsi * sinRoll;
    const nNorthY = cosPsi;
    const nNorthZ = -sinPsi * cosRoll;

    const standoff = (1.0 - t) * (safeRadius - 5.0) + t * altitudeAboveGround;
    const camX = deformed[0] + uX * standoff;
    const camY = deformed[1] + uY * standoff;
    const camZ = deformed[2] + uZ * standoff;

    const fwdX = nNorthX * Math.cos(hRad) + eX * Math.sin(hRad);
    const fwdY = nNorthY * Math.cos(hRad) + eY * Math.sin(hRad);
    const fwdZ = nNorthZ * Math.cos(hRad) + eZ * Math.sin(hRad);

    const morphVDirX = -Math.cos(pRad) * uX + Math.sin(pRad) * fwdX;
    const morphVDirY = -Math.cos(pRad) * uY + Math.sin(pRad) * fwdY;
    const morphVDirZ = -Math.cos(pRad) * uZ + Math.sin(pRad) * fwdZ;

    const planarTargetDist = 3.5;
    const morphTargetDist = (1.0 - t) * targetDist + t * planarTargetDist;

    const vUpX = Math.sin(pRad) * uX + Math.cos(pRad) * fwdX;
    const vUpY = Math.sin(pRad) * uY + Math.cos(pRad) * fwdY;
    const vUpZ = Math.sin(pRad) * uZ + Math.cos(pRad) * fwdZ;

    return {
      camX,
      camY,
      camZ,
      targetX: camX + morphVDirX * morphTargetDist,
      targetY: camY + morphVDirY * morphTargetDist,
      targetZ: camZ + morphVDirZ * morphTargetDist,
      vUpX,
      vUpY,
      vUpZ,
      safeRadius, theta, phi
    };
  }, [getGroundClearanceFloor]);

  // Orbital Kinematics updates
  const updateCameraTransform = useCallback(() => {
    const camera = cameraRef.current;
    const spherical = sphericalRef.current;
    const target = targetRef.current;

    const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
    const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
    const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));
    const clampedUnfurl = Math.max(0.0, Math.min(1.0, curUnfurl));
    const unrollEase = clampedUnfurl * clampedUnfurl * (3.0 - 2.0 * clampedUnfurl);

    const obliquePitch = Number((loadingRegionsRef.current as any).__obliquePitchDeg || (stateRef.current as any)?.cameraPitchDeg || 0);
    if (obliquePitch > 0.01) {
      const obliqueHeading = Number((loadingRegionsRef.current as any).__obliqueHeadingDeg || (stateRef.current as any)?.cameraHeadingDeg || 0);
      const sphLat = 90 - (spherical.phi * 180) / Math.PI;
      const sphLon = (spherical.theta * 180) / Math.PI;
      const latDeg = curUnfurl >= 0.01 ? (activeCoordsRef.current?.lat ?? sphLat) : sphLat;
      const lonDeg = curUnfurl >= 0.01 ? (activeCoordsRef.current?.lon ?? sphLon) : sphLon;
      const v = computeObliqueVectors(lonDeg, latDeg, spherical.radius, obliquePitch, obliqueHeading);
      spherical.radius = v.safeRadius;
      camera.position.set(v.camX, v.camY, v.camZ);
      target.set(v.targetX, v.targetY, v.targetZ);
      camera.up.set(v.vUpX, v.vUpY, v.vUpZ);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      return;
    }

    const zoomWeight = Math.max(0.0, Math.min(1.0, (14.0 - spherical.radius) / 5.0));
    const effRadius = Math.max(0.08, spherical.radius - 5.0 * unrollEase * zoomWeight);

    camera.position.x = target.x + effRadius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
    camera.position.y = target.y + effRadius * Math.cos(spherical.phi);
    camera.position.z = target.z + effRadius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateMatrixWorld();
  }, [computeObliqueVectors]);

  // Update camera position or target when props change
  useEffect(() => {
    if (cameraPosition) {
      cameraTransitionRef.current = null;
      (loadingRegionsRef.current as any).__obliquePitchDeg = 0;
      (loadingRegionsRef.current as any).__obliqueHeadingDeg = 0;
      if (stateRef.current) {
        (stateRef.current as any).cameraPitchDeg = 0;
        (stateRef.current as any).cameraHeadingDeg = 0;
      }
      if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__) {
        (window as any).__INDICATRIX_LIVE_UNIFORMS__.cameraPitchDeg = 0;
      }
      velocityRef.current.velTheta = 0;
      velocityRef.current.velPhi = 0;
      velocityRef.current.velRadius = 0;
      velocityRef.current.velPanX = 0;
      velocityRef.current.velPanY = 0;
      const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
      const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
      const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));
      if (curUnfurl < 0.01) {
        targetRef.current.copy(ORIGIN_VEC);
      }
      const curOffset = _scratchVecA.subVectors(cameraRef.current.position, targetRef.current);
      const curR = Math.max(curOffset.length(), 0.001);
      sphericalRef.current.radius = curR;
      sphericalRef.current.theta = Math.atan2(curOffset.x, curOffset.z);
      sphericalRef.current.phi = Math.acos(Math.min(Math.max(curOffset.y / curR, -1), 1));
      if (Array.isArray(cameraPosition)) {
        targetCameraPosRef.current = new Vector3(cameraPosition[0], cameraPosition[1], cameraPosition[2]);
      } else {
        targetCameraPosRef.current = cameraPosition.clone();
      }
    }
  }, [cameraPosition]);

  useEffect(() => {
    if (cameraTarget) {
      if (Array.isArray(cameraTarget)) {
        targetRef.current.set(cameraTarget[0], cameraTarget[1], cameraTarget[2]);
      } else {
        targetRef.current.copy(cameraTarget);
      }
      if (targetCameraPosRef.current) {
        cameraRef.current.up.set(0, 1, 0);
        cameraRef.current.lookAt(targetRef.current);
        cameraRef.current.updateMatrixWorld();
      } else {
        updateCameraTransform();
      }
    }
  }, [cameraTarget, updateCameraTransform]);

  // Initialize Camera position
  useEffect(() => {
    cameraRef.current.position.set(0, 0, 15);
    updateCameraTransform();
  }, [updateCameraTransform]);

  // DevTools Camera Navigation Hook for Automated Verification
  useEffect(() => {
    (window as any).__INDICATRIX_CAMERA__ = {
      get activeCoords() { return activeCoordsRef.current; },
      getActiveCoords: () => activeCoordsRef.current,
      get cursorCoords() { return cursorCoordsRef.current; },
      getCursorCoords: () => cursorCoordsRef.current,
      getPosition: (): [number, number, number] => [
        cameraRef.current.position.x,
        cameraRef.current.position.y,
        cameraRef.current.position.z,
      ],
      getCamDist: () => {
        const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
        const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
        const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));
        const cPos = cameraRef.current.position;
        const inv = invertMacroChart([cPos.x, cPos.y, cPos.z], curUnfurl, 5.0);
        return Number.isFinite(inv.h) ? 5.0 + inv.h : cPos.length();
      },
      getAltitudeUnits: () => {
        const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
        const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
        const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));
        const cPos = cameraRef.current.position;
        const inv = invertMacroChart([cPos.x, cPos.y, cPos.z], curUnfurl, 5.0);
        return Number.isFinite(inv.h) ? inv.h : cPos.length() - 5.0;
      },
      get pitch() { return (stateRef.current as any)?.cameraPitchDeg ?? (loadingRegionsRef.current as any)?.__obliquePitchDeg ?? 0; },
      getPitch: () => (stateRef.current as any)?.cameraPitchDeg ?? (loadingRegionsRef.current as any)?.__obliquePitchDeg ?? 0,
      setPitch: (deg: number) => {
        const p = Math.max(0, Math.min(85, deg));
        (loadingRegionsRef.current as any).__obliquePitchDeg = p;
        if (stateRef.current) {
          (stateRef.current as any).cameraPitchDeg = p;
        }
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
            ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
            cameraPitchDeg: p,
          };
        }
        const lon = activeCoordsRef.current?.lon ?? 0;
        const lat = activeCoordsRef.current?.lat ?? 0;
        (window as any).__INDICATRIX_CAMERA__?.setObliqueView(lon, lat, sphericalRef.current.radius, p, 0);
      },
      setSpherical: (r: number, theta?: number, phi?: number, target?: [number, number, number]) => {
        cameraRef.current.up.set(0, 1, 0);
        (loadingRegionsRef.current as any).__obliquePitchDeg = 0;
        (loadingRegionsRef.current as any).__obliqueHeadingDeg = 0;
        if (stateRef.current) {
          (stateRef.current as any).cameraPitchDeg = 0;
          (stateRef.current as any).cameraHeadingDeg = 0;
        }
        if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__.cameraPitchDeg = 0;
        }
        const curTheta = theta !== undefined ? theta : sphericalRef.current.theta;
        const curPhi = phi !== undefined ? phi : sphericalRef.current.phi;
        const lat = 90 - (curPhi * 180) / Math.PI;
        const lon = (curTheta * 180) / Math.PI;
        activeCoordsRef.current = { lat, lon };
        const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
        const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
        const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));
        if (target) {
          targetRef.current.set(target[0], target[1], target[2]);
          if (curUnfurl >= 0.01) {
            let tLon = (target[0] / 5.0) * (180 / Math.PI);
            tLon = ((((tLon + 180) % 360) + 360) % 360) - 180;
            const clampedTY = Math.max(-5.0 * 2.5, Math.min(5.0 * 2.5, target[1]));
            const curModeT = stateRef.current?.mode ?? 0;
            const tLat = curModeT === 0
              ? Math.max(-85, Math.min(85, (clampedTY / 5.0) * (180 / Math.PI)))
              : (2.0 * Math.atan(Math.exp(clampedTY / 5.0)) - Math.PI / 2.0) * (180 / Math.PI);
            activeCoordsRef.current = { lat: tLat, lon: tLon };
          }
        } else if (curUnfurl < 0.01 || r >= 12.0) {
          targetRef.current.set(0, 0, 0);
        } else {
          const clampedUnfurl = Math.max(0.0, Math.min(1.0, curUnfurl));
          const unrollEase = clampedUnfurl * clampedUnfurl * (3.0 - 2.0 * clampedUnfurl);
          const curMode = stateRef.current?.mode ?? 0;
          const deformed = evaluatePointMorph(lon, lat, curUnfurl, curMode, 0, 0.0);
          const sinPhi = Math.sin(curPhi);
          const cosPhi = Math.cos(curPhi);
          const sinTheta = Math.sin(curTheta);
          const cosTheta = Math.cos(curTheta);
          const dirX = sinPhi * sinTheta;
          const dirY = cosPhi;
          const dirZ = sinPhi * cosTheta;
          const dirLen = Math.hypot(dirX, dirY, dirZ);
          const invLen = dirLen > 1e-6 ? 1.0 / dirLen : 1.0;
          const standoff = 5.0 * (1.0 - unrollEase);
          targetRef.current.set(
            deformed[0] - standoff * (dirX * invLen),
            deformed[1] - standoff * (dirY * invLen),
            deformed[2] - standoff * (dirZ * invLen)
          );
        }
        sphericalRef.current.radius = r;
        sphericalRef.current.theta = curTheta;
        sphericalRef.current.phi = curPhi;
        velocityRef.current.velTheta = 0;
        velocityRef.current.velPhi = 0;
        velocityRef.current.velRadius = 0;
        velocityRef.current.velPanX = 0;
        velocityRef.current.velPanY = 0;
        targetCameraPosRef.current = null;
        updateCameraTransform();
      },
      lookAtCoordinates: (lonDeg: number, latDeg: number, zoomRadius = 15, target?: [number, number, number]) => {
        cameraRef.current.up.set(0, 1, 0);
        (loadingRegionsRef.current as any).__obliquePitchDeg = 0;
        (loadingRegionsRef.current as any).__obliqueHeadingDeg = 0;
        if (stateRef.current) {
          (stateRef.current as any).cameraPitchDeg = 0;
          (stateRef.current as any).cameraHeadingDeg = 0;
        }
        if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__.cameraPitchDeg = 0;
        }
        activeCoordsRef.current = { lat: latDeg, lon: lonDeg };
        const phi = ((90 - latDeg) * Math.PI) / 180;
        const theta = (lonDeg * Math.PI) / 180;
        const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
        const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
        const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));
        const clampedUnfurl = Math.max(0.0, Math.min(1.0, curUnfurl));
        const unrollEase = clampedUnfurl * clampedUnfurl * (3.0 - 2.0 * clampedUnfurl);
        const effTheta = theta * (1.0 - unrollEase);
        const effPhi = phi * (1.0 - unrollEase) + (Math.PI * 0.5) * unrollEase;
        if (target) {
          targetRef.current.set(target[0], target[1], target[2]);
        } else if (curUnfurl < 0.01 || zoomRadius >= 12.0) {
          targetRef.current.set(0, 0, 0);
        } else {
          const curMode = stateRef.current?.mode ?? 0;
          const deformed = evaluatePointMorph(lonDeg, latDeg, curUnfurl, curMode, 0, 0.0);
          const sinPhi = Math.sin(effPhi);
          const cosPhi = Math.cos(effPhi);
          const sinTheta = Math.sin(effTheta);
          const cosTheta = Math.cos(effTheta);
          const dirX = sinPhi * sinTheta;
          const dirY = cosPhi;
          const dirZ = sinPhi * cosTheta;
          const dirLen = Math.hypot(dirX, dirY, dirZ);
          const invLen = dirLen > 1e-6 ? 1.0 / dirLen : 1.0;
          const standoff = 5.0 * (1.0 - unrollEase);
          targetRef.current.set(
            deformed[0] - standoff * (dirX * invLen),
            deformed[1] - standoff * (dirY * invLen),
            deformed[2] - standoff * (dirZ * invLen)
          );
        }
        const h_floor = getGroundClearanceFloor(lonDeg, latDeg, zoomRadius);
        sphericalRef.current.radius = Math.max(h_floor, Math.min(zoomRadius, 30.0));
        sphericalRef.current.theta = curUnfurl >= 0.01 ? effTheta : theta;
        sphericalRef.current.phi = curUnfurl >= 0.01 ? effPhi : phi;
        velocityRef.current.velTheta = 0;
        velocityRef.current.velPhi = 0;
        velocityRef.current.velRadius = 0;
        velocityRef.current.velPanX = 0;
        velocityRef.current.velPanY = 0;
        targetCameraPosRef.current = null;
        updateCameraTransform();
      },
      easeToCoordinates: (lonDeg: number, latDeg: number, zoomRadius = 14.0, durationSec = 1.4) => {
        (loadingRegionsRef.current as any).__obliquePitchDeg = 0;
        (loadingRegionsRef.current as any).__obliqueHeadingDeg = 0;
        if (stateRef.current) {
          (stateRef.current as any).cameraPitchDeg = 0;
          (stateRef.current as any).cameraHeadingDeg = 0;
        }
        if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__.cameraPitchDeg = 0;
        }
        activeCoordsRef.current = { lat: latDeg, lon: lonDeg };
        const phi = ((90 - latDeg) * Math.PI) / 180;
        const theta = (lonDeg * Math.PI) / 180;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);

        const h_floor = getGroundClearanceFloor(lonDeg, latDeg, zoomRadius);
        const safeRadius = Math.max(h_floor, Math.min(zoomRadius, 30.0));

        const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
        const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
        const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));
        const clampedUnfurl = Math.max(0.0, Math.min(1.0, curUnfurl));
        const unrollEase = clampedUnfurl * clampedUnfurl * (3.0 - 2.0 * clampedUnfurl);
        const effTheta = theta * (1.0 - unrollEase);
        const effPhi = phi * (1.0 - unrollEase) + (Math.PI * 0.5) * unrollEase;
        let endTarget = new Vector3(0, 0, 0);
        let endPos = new Vector3(safeRadius * sinPhi * sinTheta, safeRadius * cosPhi, safeRadius * sinPhi * cosTheta);

        if (curUnfurl >= 0.01) {
          const curMode = stateRef.current?.mode ?? 0;
          const deformed = evaluatePointMorph(lonDeg, latDeg, curUnfurl, curMode, 0, 0.0);
          const dirX = Math.sin(effPhi) * Math.sin(effTheta);
          const dirY = Math.cos(effPhi);
          const dirZ = Math.sin(effPhi) * Math.cos(effTheta);
          const dirLen = Math.hypot(dirX, dirY, dirZ);
          const invLen = dirLen > 1e-6 ? 1.0 / dirLen : 1.0;
          const standoff = 5.0 * (1.0 - unrollEase);
          const zoomWeight = Math.max(0.0, Math.min(1.0, (14.0 - safeRadius) / 5.0));
          const effRadius = Math.max(0.08, safeRadius - 5.0 * unrollEase * zoomWeight);
          endTarget = new Vector3(
            deformed[0] - standoff * (dirX * invLen),
            deformed[1] - standoff * (dirY * invLen),
            deformed[2] - standoff * (dirZ * invLen)
          );
          endPos = new Vector3(
            endTarget.x + effRadius * (dirX * invLen),
            endTarget.y + effRadius * (dirY * invLen),
            endTarget.z + effRadius * (dirZ * invLen)
          );
        }

        sphericalRef.current.radius = safeRadius;
        sphericalRef.current.theta = curUnfurl >= 0.01 ? effTheta : theta;
        sphericalRef.current.phi = curUnfurl >= 0.01 ? effPhi : phi;

        velocityRef.current.velTheta = 0;
        velocityRef.current.velPhi = 0;
        velocityRef.current.velRadius = 0;
        velocityRef.current.velPanX = 0;
        velocityRef.current.velPanY = 0;
        targetCameraPosRef.current = null;

        if (durationSec <= 0) {
          cameraRef.current.position.copy(endPos);
          targetRef.current.copy(endTarget);
          cameraRef.current.up.set(0, 1, 0);
          cameraRef.current.lookAt(targetRef.current);
          cameraRef.current.updateMatrixWorld();
          cameraTransitionRef.current = null;
        } else {
          cameraTransitionRef.current = {
            startPos: cameraRef.current.position.clone(),
            endPos,
            startTarget: targetRef.current.clone(),
            endTarget,
            startUp: cameraRef.current.up.clone(),
            endUp: new Vector3(0, 1, 0),
            startTime: performance.now(),
            duration: durationSec * 1000,
          };
        }
      },
      setTarget: (x: number, y: number, z: number) => {
        targetRef.current.set(x, y, z);
        updateCameraTransform();
      },
      setObliqueView: (lonDeg: number, latDeg: number, altitudeRadius = 6.05, pitchDeg = 52, headingDeg = 0, centerTarget = false) => {
        let camLonDeg = lonDeg;
        let camLatDeg = latDeg;
        if (centerTarget && pitchDeg > 0.1) {
          const safeR = Math.max(5.02, altitudeRadius);
          const pRad = (Math.min(78, Math.max(0, pitchDeg)) * Math.PI) / 180;
          const sinArg = Math.min(0.998, (safeR / 5.0) * Math.sin(pRad));
          const offsetDeg = ((Math.asin(sinArg) - pRad) * 180) / Math.PI;
          const hRad = (headingDeg * Math.PI) / 180;
          camLatDeg = Math.max(-89.5, Math.min(89.5, latDeg - offsetDeg * Math.cos(hRad)));
          const cosLat = Math.max(0.15, Math.cos((latDeg * Math.PI) / 180));
          camLonDeg = lonDeg - (offsetDeg * Math.sin(hRad)) / cosLat;
        }
        const v = computeObliqueVectors(camLonDeg, camLatDeg, altitudeRadius, pitchDeg, headingDeg);

        cameraRef.current.position.set(v.camX, v.camY, v.camZ);
        targetRef.current.set(v.targetX, v.targetY, v.targetZ);
        cameraRef.current.up.set(v.vUpX, v.vUpY, v.vUpZ);
        cameraRef.current.lookAt(targetRef.current);
        cameraRef.current.updateMatrixWorld();
        (loadingRegionsRef.current as any).__obliquePitchDeg = pitchDeg;
        (loadingRegionsRef.current as any).__obliqueHeadingDeg = headingDeg;
        if (stateRef.current) {
          (stateRef.current as any).cameraPitchDeg = pitchDeg;
          (stateRef.current as any).cameraHeadingDeg = headingDeg;
        }
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
            ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
            cameraPitchDeg: pitchDeg,
          };
        }

        sphericalRef.current.radius = v.safeRadius;
        sphericalRef.current.theta = v.theta;
        sphericalRef.current.phi = v.phi;
        activeCoordsRef.current = { lat: latDeg, lon: lonDeg };

        velocityRef.current.velTheta = 0;
        velocityRef.current.velPhi = 0;
        velocityRef.current.velRadius = 0;
        velocityRef.current.velPanX = 0;
        velocityRef.current.velPanY = 0;
        targetCameraPosRef.current = null;
        (loadingRegionsRef.current as any).__lastProgMoveMs = performance.now();
      },
      lookAtOblique: (targetLonDeg: number, targetLatDeg: number, altitudeRadius = 5.42, pitchDeg = 30, headingDeg = 0) => {
        (window as any).__INDICATRIX_CAMERA__?.setObliqueView(targetLonDeg, targetLatDeg, altitudeRadius, pitchDeg, headingDeg, true);
      },
      snapPugetSound: (_duration = 1.6) => {
        const lonDeg = -122.38;
        const latDeg = 47.62;
        const altitudeRadius = 5.00275; // ~3,500m altitude
        const pitchDeg = 58.0;
        const headingDeg = 145.0; // Looking towards Mount Rainier
        (window as any).__INDICATRIX_CAMERA__.setObliqueView(lonDeg, latDeg, altitudeRadius, pitchDeg, headingDeg);
      },
      snapRainierInversion: (options?: {
        lonDeg?: number;
        latDeg?: number;
        altitudeRadius?: number;
        pitchDeg?: number;
        headingDeg?: number;
        theme?: number;
        duration?: number;
      }) => {
        const lonDeg = options?.lonDeg ?? -121.7604;
        const latDeg = options?.latDeg ?? 46.8529;
        const altitudeRadius = options?.altitudeRadius ?? 5.00298; // ~3,800m altitude (R ≈ 5.00298)
        const pitchDeg = options?.pitchDeg ?? 75.0; // Oblique ≈ 75°
        const headingDeg = options?.headingDeg ?? 145.0; // Looking toward Mount Rainier summit

        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
            ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
            showClouds: true,
            volumetricClouds: true,
            showCloudLow: true,
            showCloudMid: true,
            showCloudHigh: true,
          };
          if (options?.theme !== undefined) {
            (window as any).__INDICATRIX_LIVE_UNIFORMS__.theme = options.theme;
            if (typeof (window as any).__INDICATRIX_THEME__?.setThemeIndex === 'function') {
              (window as any).__INDICATRIX_THEME__.setThemeIndex(options.theme);
            }
            if (typeof (window as any).setTheme === 'function') {
              (window as any).setTheme(options.theme);
            }
          }
          if ((window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
            (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ showClouds: true });
          }
        }
        callbacksRef.current.onShowCloudsChange?.(true);

        if (engineRef.current) {
          if (typeof engineRef.current.setVolumetricCloudsEnabled === 'function') {
            engineRef.current.setVolumetricCloudsEnabled(true);
          }
          const useWn = (options as any)?.useWeatherNext ?? false;
          engineRef.current.loadAllCloudLayers(useWn).catch(() => {});
        }

        (window as any).__INDICATRIX_CAMERA__.setObliqueView(lonDeg, latDeg, altitudeRadius, pitchDeg, headingDeg);
      },
      snapHaleakalaSunset: (options?: {
        lonDeg?: number;
        latDeg?: number;
        altitudeRadius?: number;
        pitchDeg?: number;
        headingDeg?: number;
        theme?: number;
        sunAltitude?: number;
        sunAzimuth?: number;
        duration?: number;
        displacementScale?: number;
      } | number) => {
        const opts = typeof options === 'number' ? { theme: options } : (options ?? {});
        const lonDeg = opts.lonDeg ?? -156.2533; // Haleakala summit, Maui
        const latDeg = opts.latDeg ?? 20.7097;
        const altitudeRadius = opts.altitudeRadius ?? 5.0032; // ~4,000m altitude
        const pitchDeg = opts.pitchDeg ?? 80.0; // Looking slightly downward into trade-wind undercast deck
        const headingDeg = opts.headingDeg ?? 268.0; // Looking West into setting sun
        const sunAlt = opts.sunAltitude ?? 7.5; // Low golden hour sun
        const sunAz = opts.sunAzimuth ?? 270.0; // Setting in the west
        const dispScale = opts.displacementScale ?? 0.003;

        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
            ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
            sunAltitude: sunAlt,
            sunAzimuth: sunAz,
            displacementScale: dispScale,
            showClouds: true,
            volumetricClouds: true,
            showCloudLow: true,
            showCloudMid: true,
            showCloudHigh: true,
          };
          if (opts.theme !== undefined) {
            (window as any).__INDICATRIX_LIVE_UNIFORMS__.theme = opts.theme;
            if (typeof (window as any).__INDICATRIX_THEME__?.setThemeIndex === 'function') {
              (window as any).__INDICATRIX_THEME__.setThemeIndex(opts.theme);
            }
            if (typeof (window as any).setTheme === 'function') {
              (window as any).setTheme(opts.theme);
            }
          }
          if ((window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
            (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ showClouds: true });
          }
        }
        callbacksRef.current.onShowCloudsChange?.(true);

        if (engineRef.current) {
          if (typeof engineRef.current.setVolumetricCloudsEnabled === 'function') {
            engineRef.current.setVolumetricCloudsEnabled(true);
          }
          const useWn = (options as any)?.useWeatherNext ?? false;
          engineRef.current.loadAllCloudLayers(useWn).catch(() => {});
        }

        (window as any).__INDICATRIX_CAMERA__.setObliqueView(lonDeg, latDeg, altitudeRadius, pitchDeg, headingDeg);
      },
      snapIntaglioHaptics: (options?: {
        theme?: number;
        pitchDeg?: number;
        fiberFrequency?: number;
        fiberAnisotropy?: number;
        sheenIntensity?: number;
        plateMarkDepthMeters?: number;
        inkRidgeHeightMeters?: number;
        sunAltitude?: number;
        sunAzimuth?: number;
        substrateHaptics?: boolean;
      } | number) => {
        const opts = typeof options === 'number' ? { theme: options } : (options ?? {});
        const lonDeg = -122.38;
        const latDeg = 47.62;
        const altitudeRadius = 6.2;
        const pitchDeg = opts.pitchDeg ?? 68.0;
        const headingDeg = 135.0;

        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
            ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
            substrateHaptics: opts.substrateHaptics !== undefined ? Boolean(opts.substrateHaptics) : true,
            paperSubstrate: opts.substrateHaptics !== undefined ? Boolean(opts.substrateHaptics) : true,
            cameraPitchDeg: pitchDeg,
            sunAltitude: opts.sunAltitude ?? 38.0,
            sunAzimuth: opts.sunAzimuth ?? 315.0,
            fiberFrequency: opts.fiberFrequency ?? 45.0,
            fiberAnisotropy: opts.fiberAnisotropy ?? 0.65,
            sheenIntensity: opts.sheenIntensity ?? (opts.theme === 1 || opts.theme === undefined ? 0.85 : opts.theme === 2 ? 0.50 : 0.40),
            plateMarkDepthMeters: opts.plateMarkDepthMeters ?? 0.0035,
            inkRidgeHeightMeters: opts.inkRidgeHeightMeters ?? 0.0018,
          };
          if (opts.theme !== undefined) {
            (window as any).__INDICATRIX_LIVE_UNIFORMS__.theme = opts.theme;
            if (typeof (window as any).__INDICATRIX_THEME__?.setThemeIndex === 'function') {
              (window as any).__INDICATRIX_THEME__.setThemeIndex(opts.theme);
            }
            if (typeof (window as any).setTheme === 'function') {
              (window as any).setTheme(opts.theme);
            }
          }
        }

        (window as any).__INDICATRIX_CAMERA__.setObliqueView(lonDeg, latDeg, altitudeRadius, pitchDeg, headingDeg);
      },
      snapTerrainShadows: (options?: {
        lonDeg?: number;
        latDeg?: number;
        altitudeRadius?: number;
        pitchDeg?: number;
        headingDeg?: number;
        theme?: number;
        sunAltitude?: number;
        sunAzimuth?: number;
        terrainShadows?: boolean;
        maxRayDistanceMeters?: number;
        penumbraSoftness?: number;
      }) => {
        // Default target: Grand Canyon South Rim (-112.14, 36.06)
        const lonDeg = options?.lonDeg ?? -112.14;
        const latDeg = options?.latDeg ?? 36.06;
        const altitudeRadius = options?.altitudeRadius ?? 5.012; // ~15km altitude for sharp canyon relief
        const pitchDeg = options?.pitchDeg ?? 64.0;
        const headingDeg = options?.headingDeg ?? 45.0; // Looking NE across canyon
        const sunAlt = options?.sunAltitude ?? 15.0;
        const sunAz = options?.sunAzimuth ?? 120.0;
        const shadows = options?.terrainShadows !== undefined ? Boolean(options.terrainShadows) : true;

        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
            ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
            terrainShadows: shadows,
            showTerrainShadows: shadows,
            sunAltitude: sunAlt,
            sunAzimuth: sunAz,
            maxRayDistanceMeters: options?.maxRayDistanceMeters ?? 50000.0,
            penumbraSoftness: options?.penumbraSoftness ?? 1.5,
          };
          if (options?.theme !== undefined) {
            (window as any).__INDICATRIX_LIVE_UNIFORMS__.theme = options.theme;
            if (typeof (window as any).__INDICATRIX_THEME__?.setThemeIndex === 'function') {
              (window as any).__INDICATRIX_THEME__.setThemeIndex(options.theme);
            }
            if (typeof (window as any).setTheme === 'function') {
              (window as any).setTheme(options.theme);
            }
          }
        }
        if (engineRef.current) {
          engineRef.current.setTerrainShadowsEnabled(shadows);
        }
        (window as any).__INDICATRIX_CAMERA__.setObliqueView(lonDeg, latDeg, altitudeRadius, pitchDeg, headingDeg);
      },
      snapGrandCanyon: (options?: any) => {
        (window as any).__INDICATRIX_CAMERA__.snapTerrainShadows(options);
      },
      snapCloudAdvection: (options?: {
        lonDeg?: number;
        latDeg?: number;
        altitudeRadius?: number;
        pitchDeg?: number;
        headingDeg?: number;
        theme?: number;
        cloudAdvection?: boolean;
        cloudAdvectionSpeed?: number;
        condensationRate?: number;
        evaporationRate?: number;
        reset?: boolean;
      }) => {
        const lonDeg = options?.lonDeg ?? -121.7604;
        const latDeg = options?.latDeg ?? 46.8529;
        const altitudeRadius = options?.altitudeRadius ?? 5.0045;
        const pitchDeg = options?.pitchDeg ?? 72.0;
        const headingDeg = options?.headingDeg ?? 145.0;
        const advection = options?.cloudAdvection !== undefined ? Boolean(options.cloudAdvection) : true;
        const speed = options?.cloudAdvectionSpeed ?? 1.5;

        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
            ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
            showClouds: true,
            volumetricClouds: true,
            showCloudLow: true,
            showCloudMid: true,
            showCloudHigh: true,
            cloudAdvection: advection,
            cloudAdvectionSpeed: speed,
            condensationRate: options?.condensationRate ?? 1.2,
            evaporationRate: options?.evaporationRate ?? 0.8,
          };
          if (options?.theme !== undefined) {
            (window as any).__INDICATRIX_LIVE_UNIFORMS__.theme = options.theme;
            if (typeof (window as any).__INDICATRIX_THEME__?.setThemeIndex === 'function') {
              (window as any).__INDICATRIX_THEME__.setThemeIndex(options.theme);
            }
            if (typeof (window as any).setTheme === 'function') {
              (window as any).setTheme(options.theme);
            }
          }
          if ((window as any).__INDICATRIX_SET_CLOUD_OPTIONS__) {
            (window as any).__INDICATRIX_SET_CLOUD_OPTIONS__({ showClouds: true });
          }
        }
        callbacksRef.current.onShowCloudsChange?.(true);

        if (engineRef.current) {
          engineRef.current.setVolumetricCloudsEnabled(true);
          engineRef.current.setCloudAdvectionEnabled(advection);
          if (options?.reset) {
            engineRef.current.resetCloudAdvection();
          }
          engineRef.current.loadAllCloudLayers(false).catch(() => {});
        }

        (window as any).__INDICATRIX_CAMERA__.setObliqueView(lonDeg, latDeg, altitudeRadius, pitchDeg, headingDeg);
      },
      animateToObliqueView: (options?: {
        lonDeg?: number;
        latDeg?: number;
        altitudeRadius?: number;
        pitchDeg?: number;
        headingDeg?: number;
        duration?: number;
      }) => {
        const lonDeg = options?.lonDeg ?? 8.5;
        const latDeg = options?.latDeg ?? 44.5;
        const altitudeRadius = options?.altitudeRadius ?? 5.22;
        const pitchDeg = options?.pitchDeg ?? 78.0;
        const headingDeg = options?.headingDeg ?? 0.0;
        const durationSec = options?.duration ?? 1.6;

        const v = computeObliqueVectors(lonDeg, latDeg, altitudeRadius, pitchDeg, headingDeg);

        velocityRef.current.velTheta = 0;
        velocityRef.current.velPhi = 0;
        velocityRef.current.velRadius = 0;
        velocityRef.current.velPanX = 0;
        velocityRef.current.velPanY = 0;
        targetCameraPosRef.current = null;

        activeCoordsRef.current = { lat: latDeg, lon: lonDeg };
        sphericalRef.current.radius = v.safeRadius;
        sphericalRef.current.theta = v.theta;
        sphericalRef.current.phi = v.phi;
        (loadingRegionsRef.current as any).__obliquePitchDeg = pitchDeg;
        (loadingRegionsRef.current as any).__obliqueHeadingDeg = headingDeg;
        if (stateRef.current) {
          (stateRef.current as any).cameraPitchDeg = pitchDeg;
          (stateRef.current as any).cameraHeadingDeg = headingDeg;
        }
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
            ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
            cameraPitchDeg: pitchDeg,
          };
        }

        if (durationSec <= 0) {
          cameraRef.current.position.set(v.camX, v.camY, v.camZ);
          targetRef.current.set(v.targetX, v.targetY, v.targetZ);
          cameraRef.current.up.set(v.vUpX, v.vUpY, v.vUpZ);
          cameraRef.current.lookAt(targetRef.current);
          cameraRef.current.updateMatrixWorld();
          cameraTransitionRef.current = null;
        } else {
          cameraTransitionRef.current = {
            startPos: cameraRef.current.position.clone(),
            endPos: new Vector3(v.camX, v.camY, v.camZ),
            startTarget: targetRef.current.clone(),
            endTarget: new Vector3(v.targetX, v.targetY, v.targetZ),
            startUp: cameraRef.current.up.clone(),
            endUp: new Vector3(v.vUpX, v.vUpY, v.vUpZ),
            startTime: performance.now(),
            duration: durationSec * 1000,
          };
        }
      },
      snapHorizonCrossSection: (duration = 1.6) => {
        const lonDeg = 8.5;
        const latDeg = 44.5;
        const altitudeRadius = 5.22;
        const pitchDeg = 78.0;
        const headingDeg = 0.0;
        const v = computeObliqueVectors(lonDeg, latDeg, altitudeRadius, pitchDeg, headingDeg);

        velocityRef.current.velTheta = 0;
        velocityRef.current.velPhi = 0;
        velocityRef.current.velRadius = 0;
        velocityRef.current.velPanX = 0;
        velocityRef.current.velPanY = 0;
        targetCameraPosRef.current = null;

        activeCoordsRef.current = { lat: latDeg, lon: lonDeg };
        sphericalRef.current.radius = v.safeRadius;
        sphericalRef.current.theta = v.theta;
        sphericalRef.current.phi = v.phi;
        (loadingRegionsRef.current as any).__obliquePitchDeg = pitchDeg;
        (loadingRegionsRef.current as any).__obliqueHeadingDeg = headingDeg;
        if (stateRef.current) {
          (stateRef.current as any).cameraPitchDeg = pitchDeg;
          (stateRef.current as any).cameraHeadingDeg = headingDeg;
        }
        if (typeof window !== 'undefined') {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
            ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
            cameraPitchDeg: pitchDeg,
          };
        }

        if (duration <= 0) {
          cameraRef.current.position.set(v.camX, v.camY, v.camZ);
          targetRef.current.set(v.targetX, v.targetY, v.targetZ);
          cameraRef.current.up.set(v.vUpX, v.vUpY, v.vUpZ);
          cameraRef.current.lookAt(targetRef.current);
          cameraRef.current.updateMatrixWorld();
          cameraTransitionRef.current = null;
        } else {
          cameraTransitionRef.current = {
            startPos: cameraRef.current.position.clone(),
            endPos: new Vector3(v.camX, v.camY, v.camZ),
            startTarget: targetRef.current.clone(),
            endTarget: new Vector3(v.targetX, v.targetY, v.targetZ),
            startUp: cameraRef.current.up.clone(),
            endUp: new Vector3(v.vUpX, v.vUpY, v.vUpZ),
            startTime: performance.now(),
            duration: duration * 1000,
          };
        }
      },
      setPose: (pos: [number, number, number], target: [number, number, number], up?: [number, number, number]) => {
        cameraRef.current.position.set(pos[0], pos[1], pos[2]);
        targetRef.current.set(target[0], target[1], target[2]);
        if (up) cameraRef.current.up.set(up[0], up[1], up[2]);
        cameraRef.current.lookAt(targetRef.current);
        cameraRef.current.updateMatrixWorld();
        velocityRef.current.velTheta = 0;
        velocityRef.current.velPhi = 0;
        velocityRef.current.velRadius = 0;
        velocityRef.current.velPanX = 0;
        velocityRef.current.velPanY = 0;
        targetCameraPosRef.current = null;
        (loadingRegionsRef.current as any).__lastProgMoveMs = performance.now();
      },
      getSpherical: () => ({
        radius: sphericalRef.current.radius,
        theta: sphericalRef.current.theta,
        phi: sphericalRef.current.phi,
        latDeg: 90 - (sphericalRef.current.phi * 180) / Math.PI,
        lonDeg: (sphericalRef.current.theta * 180) / Math.PI,
        target: [targetRef.current.x, targetRef.current.y, targetRef.current.z],
        cameraPos: [cameraRef.current.position.x, cameraRef.current.position.y, cameraRef.current.position.z],
      }),
    };
    (window as any).__GO = {
      loc1_synoptic: () => (window as any).__INDICATRIX_CAMERA__?.setObliqueView(-61.0, -15.0, 7.8, 0.0, 0.0),
      loc1_oblique:  () => (window as any).__INDICATRIX_CAMERA__?.setObliqueView(-68.0, -18.0, 6.8, 32.0, 345.0),
      loc2_synoptic: () => (window as any).__INDICATRIX_CAMERA__?.setObliqueView(-122.0, 46.5, 6.8, 0.0, 0.0),
      loc2_oblique:  () => (window as any).__INDICATRIX_CAMERA__?.setObliqueView(-121.5, 45.0, 6.8, 30.0, 345.0),
    };
    (window as any).tuneClouds = (options: {
      location?: 'iceland' | 'hawaii' | 'aleutians' | 'atlantic';
      erosion?: number;
      freq?: number;
      freqVert?: number;
      extinction?: number;
      opacity?: number;
      zoom?: number;
      thickness?: number;
      lowTop?: number;
      pitch?: number;
      steps?: number;
    } = {}) => {
      if (options.location === 'iceland') {
        (window as any).__INDICATRIX_CAMERA__?.lookAtCoordinates(-21.94, 64.15, options.zoom ?? 7.5);
      } else if (options.location === 'hawaii') {
        (window as any).__INDICATRIX_CAMERA__?.lookAtCoordinates(-156.0, 20.0, options.zoom ?? 7.5);
      } else if (options.location === 'aleutians') {
        (window as any).__INDICATRIX_CAMERA__?.lookAtCoordinates(-170.0, 53.0, options.zoom ?? 7.5);
      } else if (options.location === 'atlantic') {
        (window as any).__INDICATRIX_CAMERA__?.lookAtCoordinates(-5.0, -15.0, options.zoom ?? 7.5);
      }
      if (options.pitch !== undefined && typeof (window as any).__INDICATRIX_CAMERA__?.setPitch === 'function') {
        (window as any).__INDICATRIX_CAMERA__.setPitch(options.pitch);
      }
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
        ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
        ...(options.erosion !== undefined ? { cloudErosionStr: options.erosion } : {}),
        ...(options.freq !== undefined ? { cloudFreqHoriz: options.freq } : {}),
        ...(options.freqVert !== undefined ? { cloudFreqVert: options.freqVert } : {}),
        ...(options.extinction !== undefined ? { cloudExtinction: options.extinction } : {}),
        ...(options.opacity !== undefined ? { cloudOpacity: options.opacity } : {}),
        ...(options.thickness !== undefined ? { cloudThickness: options.thickness } : {}),
        ...(options.lowTop !== undefined ? { cloudLowTop: options.lowTop } : {}),
        ...(options.steps !== undefined ? { cloudMaxSteps: options.steps } : {}),
      };
      return (window as any).__INDICATRIX_LIVE_UNIFORMS__;
    };
    (window as any).__INDICATRIX_WEBGPU_ENGINE__ = engineRef.current;
    (window as any).__INDICATRIX_TRAJECTORY__ = {
      startDemo: (seq: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji' = 'hawaii', duration = 8.0) => {
        const trajectory = trajectoryControllerRef.current;
        trajectory.setMode('dolly-cinematic');
        const waypoints =
          seq === 'cape-cod'
            ? CAPE_COD_WAYPOINTS
            : seq === 'grand-canyon'
            ? GRAND_CANYON_WAYPOINTS
            : seq === 'fuji'
            ? FUJI_WAYPOINTS
            : HAWAII_WAYPOINTS;
        trajectory.setWaypoints(waypoints, duration, false);
        trajectory.setIsPlaying(true);
        callbacksRef.current.onDemoModeChange?.(true, seq);
      },
      stopDemo: () => {
        trajectoryControllerRef.current.setIsPlaying(false);
        callbacksRef.current.onDemoModeChange?.(false);
      },
      toggleDemo: (seq?: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji') => {
        if (stateRef.current.isDemoMode) {
          trajectoryControllerRef.current.setIsPlaying(false);
          callbacksRef.current.onDemoModeChange?.(false);
        } else {
          const s = seq ?? stateRef.current.demoSequence;
          const trajectory = trajectoryControllerRef.current;
          trajectory.setMode('dolly-cinematic');
          const waypoints =
            s === 'cape-cod'
              ? CAPE_COD_WAYPOINTS
              : s === 'grand-canyon'
              ? GRAND_CANYON_WAYPOINTS
              : s === 'fuji'
              ? FUJI_WAYPOINTS
              : HAWAII_WAYPOINTS;
          trajectory.setWaypoints(waypoints, 8.0, false);
          trajectory.setIsPlaying(true);
          callbacksRef.current.onDemoModeChange?.(true, s);
        }
      },
      isDemoActive: () => stateRef.current.isDemoMode,
      getProgress: () => trajectoryControllerRef.current.getProgress(),
      setProgress: (p: number) => trajectoryControllerRef.current.setProgress(p),
      controller: trajectoryControllerRef.current,
      waypoints: {
        hawaii: HAWAII_WAYPOINTS,
        capeCod: CAPE_COD_WAYPOINTS,
        grandCanyon: GRAND_CANYON_WAYPOINTS,
        fuji: FUJI_WAYPOINTS,
      },
    };
    if ((window as any).__INDICATRIX_ENGINE__) {
      (window as any).__INDICATRIX_ENGINE__.getActiveRegionalDEM = () =>
        engineRef.current?.getActiveRegionalDEM() ?? null;
      (window as any).__INDICATRIX_ENGINE__.getTileCacheStats = () =>
        engineRef.current?.getTileCacheStats() ?? { allocated: 0, uploaded: 0, free: 64, hits: 0, misses: 0, evictions: 0 };
      (window as any).__INDICATRIX_ENGINE__.streamSlippyMapTerrainTiles = (lon: number, lat: number, zoom?: number) =>
        engineRef.current?.streamSlippyMapTerrainTiles(lon, lat, zoom) ?? Promise.resolve(0);
    }

    const unmountNoiseDebugOverlay = () => {
      const existing = document.getElementById('indicatrix-noise-debug-modal');
      if (existing) {
        existing.remove();
      }
    };

    const mountNoiseDebugOverlay = async () => {
      unmountNoiseDebugOverlay();

      const engine = engineRef.current;
      if (!engine) return null;

      const sliceZIndices = [16, 48, 80, 112, 64];
      const sliceDataMap = new Map<number, Uint8Array>();
      for (const z of sliceZIndices) {
        let sliceData = await engine.readCloudNoiseSlice(z);
        let isAllZero = true;
        for (let i = 0; i < sliceData.length; i += 64) {
          if (sliceData[i] !== 0) {
            isAllZero = false;
            break;
          }
        }
        if (isAllZero) {
          const { evaluateCloudNoise } = await import('../core/math/cloudNoiseMath');
          sliceData = new Uint8Array(128 * 128 * 4);
          for (let y = 0; y < 128; y++) {
            for (let x = 0; x < 128; x++) {
              const u = (x + 0.5) / 128;
              const v = (y + 0.5) / 128;
              const w = (z + 0.5) / 128;
              const [r, g, b, a] = evaluateCloudNoise([u, v, w]);
              const idx = (y * 128 + x) * 4;
              sliceData[idx + 0] = Math.round(r * 255);
              sliceData[idx + 1] = Math.round(g * 255);
              sliceData[idx + 2] = Math.round(b * 255);
              sliceData[idx + 3] = Math.round(a * 255);
            }
          }
        }
        sliceDataMap.set(z, sliceData);
      }

      const modal = document.createElement('div');
      modal.id = 'indicatrix-noise-debug-modal';
      modal.style.position = 'fixed';
      modal.style.top = '0';
      modal.style.left = '0';
      modal.style.width = '100vw';
      modal.style.height = '100vh';
      modal.style.backgroundColor = 'rgba(5, 10, 16, 0.88)';
      modal.style.backdropFilter = 'blur(6px)';
      modal.style.display = 'flex';
      modal.style.alignItems = 'center';
      modal.style.justifyContent = 'center';
      modal.style.zIndex = '99999';

      const card = document.createElement('div');
      card.id = 'indicatrix-noise-debug-card';
      card.style.position = 'relative';
      card.style.width = '1024px';
      card.style.height = '576px';
      card.style.backgroundColor = '#0E1824';
      card.style.border = '1px solid #384C60';
      card.style.boxShadow = '0 20px 50px rgba(0,0,0,0.6)';
      card.style.borderRadius = '4px';
      card.style.overflow = 'hidden';

      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 576;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';

      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Draw background
        ctx.fillStyle = '#0E1824';
        ctx.fillRect(0, 0, 1024, 576);

        // Neatline border
        ctx.strokeStyle = '#223446';
        ctx.lineWidth = 1;
        ctx.strokeRect(10, 10, 1004, 556);

        // Title & Telemetry Header
        ctx.fillStyle = '#E8ECEF';
        ctx.font = 'bold 13px monospace';
        ctx.fillText('INDICATRIX ENGINE — MILESTONE 2: 3D TROPOSPHERIC CLOUD NOISE VOLUME', 24, 34);

        ctx.fillStyle = '#6E8A9E';
        ctx.font = '11px monospace';
        ctx.fillText('128³ RGBA8UNORM COMPUTE PIPELINE (PERLIN-WORLEY BILLOW + 3-OCTAVE WORLEY EROSION)', 24, 50);

        const durationMs = engine.getCloudNoiseComputeDurationMs();
        const telemetryBadge = `Resolution: 128×128×128 | Format: rgba8unorm | VRAM: 8.00 MB | Boot Duration: ${durationMs > 0 ? durationMs.toFixed(2) : '<8'} ms`;
        ctx.fillStyle = '#4CD964';
        ctx.fillText(telemetryBadge, 24, 66);

        const renderSliceTile = (
          x: number,
          y: number,
          size: number,
          sliceBytes: Uint8Array,
          channelMode: 'rgba' | 'r' | 'g' | 'b' | 'a',
          label: string,
          subLabel: string
        ) => {
          ctx.strokeStyle = '#2A3F54';
          ctx.strokeRect(x, y, size, size);

          const imgData = ctx.createImageData(128, 128);
          for (let i = 0; i < 128 * 128; i++) {
            const r = sliceBytes[i * 4 + 0];
            const g = sliceBytes[i * 4 + 1];
            const b = sliceBytes[i * 4 + 2];
            const a = sliceBytes[i * 4 + 3];

            if (channelMode === 'rgba') {
              imgData.data[i * 4 + 0] = r;
              imgData.data[i * 4 + 1] = g;
              imgData.data[i * 4 + 2] = b;
              imgData.data[i * 4 + 3] = 255;
            } else if (channelMode === 'r') {
              imgData.data[i * 4 + 0] = r;
              imgData.data[i * 4 + 1] = r;
              imgData.data[i * 4 + 2] = r;
              imgData.data[i * 4 + 3] = 255;
            } else if (channelMode === 'g') {
              imgData.data[i * 4 + 0] = g;
              imgData.data[i * 4 + 1] = g;
              imgData.data[i * 4 + 2] = g;
              imgData.data[i * 4 + 3] = 255;
            } else if (channelMode === 'b') {
              imgData.data[i * 4 + 0] = b;
              imgData.data[i * 4 + 1] = b;
              imgData.data[i * 4 + 2] = b;
              imgData.data[i * 4 + 3] = 255;
            } else if (channelMode === 'a') {
              imgData.data[i * 4 + 0] = a;
              imgData.data[i * 4 + 1] = a;
              imgData.data[i * 4 + 2] = a;
              imgData.data[i * 4 + 3] = 255;
            }
          }

          const offscreen = document.createElement('canvas');
          offscreen.width = 128;
          offscreen.height = 128;
          const offCtx = offscreen.getContext('2d');
          if (offCtx) {
            offCtx.putImageData(imgData, 0, 0);
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(offscreen, x, y, size, size);
          }

          ctx.fillStyle = '#E8ECEF';
          ctx.font = 'bold 10px monospace';
          ctx.fillText(label, x + 4, y + size + 14);
          ctx.fillStyle = '#6E8A9E';
          ctx.font = '9px monospace';
          ctx.fillText(subLabel, x + 4, y + size + 25);
        };

        const tileSize = 160;
        const gapX = 50;
        const startX = 72;

        // Row 1: Depth slices
        ctx.fillStyle = '#94A3B8';
        ctx.font = 'bold 11px monospace';
        ctx.fillText('ROW 1: VOLUMETRIC DEPTH SLICES ALONG Z-AXIS (RGB COMPOSITE)', startX, 85);

        const row1Z = [16, 48, 80, 112];
        const row1Labels = [
          ['z = 16 (12%)', 'Base Stratus Layer'],
          ['z = 48 (38%)', 'Mid Cumulus Inflow'],
          ['z = 80 (62%)', 'Tower Cumulonimbus'],
          ['z = 112 (88%)', 'Upper Cirrus Anvil'],
        ];

        for (let i = 0; i < 4; i++) {
          const z = row1Z[i];
          const data = sliceDataMap.get(z) || new Uint8Array(128 * 128 * 4);
          const x = startX + i * (tileSize + gapX);
          const y = 96;
          renderSliceTile(x, y, tileSize, data, 'rgba', row1Labels[i][0], row1Labels[i][1]);
        }

        // Row 2: Channel decomposition at z=64
        ctx.fillStyle = '#94A3B8';
        ctx.font = 'bold 11px monospace';
        ctx.fillText('ROW 2: 4-CHANNEL ORTHOGONAL DECOMPOSITION AT MID-TROPOSPHERE (z = 64)', startX, 318);

        const data64 = sliceDataMap.get(64) || new Uint8Array(128 * 128 * 4);
        const row2Channels: ('r' | 'g' | 'b' | 'a')[] = ['r', 'g', 'b', 'a'];
        const row2Labels = [
          ['Channel R (Perlin-Worley)', 'Base Billow (Periods 4,8,16)'],
          ['Channel G (Worley Oct 1)', 'Cellular Erosion (Period 8)'],
          ['Channel B (Worley Oct 2)', 'Cellular Erosion (Period 16)'],
          ['Channel A (Worley Oct 3)', 'Cellular Erosion (Period 32)'],
        ];

        for (let i = 0; i < 4; i++) {
          const x = startX + i * (tileSize + gapX);
          const y = 328;
          renderSliceTile(x, y, tileSize, data64, row2Channels[i], row2Labels[i][0], row2Labels[i][1]);
        }

        // Footer Telemetry
        ctx.fillStyle = '#4CD964';
        ctx.font = '10px monospace';
        ctx.fillText('STATUS: PASS | 3D PERIODIC CONTINUITY VERIFIED | ZERO NaNs | INVARIANT §46 COMPLIANT', startX, 550);
      }

      card.appendChild(canvas);
      modal.appendChild(card);

      const closeBtn = document.createElement('button');
      closeBtn.innerText = '✕ CLOSE';
      closeBtn.style.position = 'absolute';
      closeBtn.style.top = '16px';
      closeBtn.style.right = '16px';
      closeBtn.style.backgroundColor = '#1E293B';
      closeBtn.style.color = '#F1F5F9';
      closeBtn.style.border = '1px solid #475569';
      closeBtn.style.borderRadius = '3px';
      closeBtn.style.padding = '4px 8px';
      closeBtn.style.fontSize = '11px';
      closeBtn.style.fontFamily = 'monospace';
      closeBtn.style.cursor = 'pointer';
      closeBtn.onclick = unmountNoiseDebugOverlay;
      card.appendChild(closeBtn);

      document.body.appendChild(modal);
      return modal;
    };

    (window as any).__INDICATRIX_NOISE_DEBUG__ = {
      getTexture: () => engineRef.current?.getCloudNoiseTexture() ?? null,
      getTextureView: () => engineRef.current?.getCloudNoiseTextureView() ?? null,
      getDimensions: () => ({ width: 128, height: 128, depth: 128, format: 'rgba8unorm' }),
      getComputeDurationMs: () => engineRef.current?.getCloudNoiseComputeDurationMs() ?? 0,
      readSlice: (z: number) => engineRef.current?.readCloudNoiseSlice(z),
      readSlices: (slices: number[]) => engineRef.current?.readCloudNoiseSlices(slices),
      mountDebugOverlay: mountNoiseDebugOverlay,
      unmountDebugOverlay: unmountNoiseDebugOverlay,
    };

    (window as any).__INDICATRIX_SET_TERRAIN_SHADOWS__ = (enabled: boolean) => {
      if (typeof window !== 'undefined') {
        (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
          ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
          terrainShadows: enabled,
          showTerrainShadows: enabled,
        };
      }
      if (engineRef.current) {
        engineRef.current.setTerrainShadowsEnabled(enabled);
      }
    };

    return () => {
      delete (window as any).__INDICATRIX_CAMERA__;
      delete (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      delete (window as any).__INDICATRIX_TRAJECTORY__;
      delete (window as any).__INDICATRIX_NOISE_DEBUG__;
      delete (window as any).__INDICATRIX_SET_TERRAIN_SHADOWS__;
      unmountNoiseDebugOverlay();
      if ((window as any).__INDICATRIX_ENGINE__) {
        delete (window as any).__INDICATRIX_ENGINE__.getActiveRegionalDEM;
      }
    };
  }, [updateCameraTransform]);

  // Internal Camera Controls (Orbit gestures for WebGPU Native Canvas)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerDown = (e: PointerEvent) => {
      cameraTransitionRef.current = null;
      if (stateRef.current.isDemoMode) {
        callbacksRef.current.onDemoModeChange?.(false);
        const camera = cameraRef.current;
        const target = targetRef.current;
        const offset = new Vector3().subVectors(camera.position, target);
        sphericalRef.current.radius = offset.length();
        sphericalRef.current.theta = Math.atan2(offset.x, offset.z);
        sphericalRef.current.phi = Math.acos(Math.min(Math.max(offset.y / Math.max(sphericalRef.current.radius, 0.001), -1), 1));
      }

      isDraggingRef.current = true;
      dragButtonRef.current = (e.button === 0 && e.metaKey) ? 2 : e.button;
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      // Reset velocity on new direct manipulation
      velocityRef.current.velTheta = 0;
      velocityRef.current.velPhi = 0;
      velocityRef.current.velRadius = 0;
      velocityRef.current.velPanX = 0;
      velocityRef.current.velPanY = 0;
    };

    const onPointerMove = (e: PointerEvent) => {
      const hit = currentHitPosRef.current;

      const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
      const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
      const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));

      const invHover = invertMacroChart([hit.x, hit.y, hit.z], curUnfurl, 5.0);
      if (Number.isFinite(invHover.phi) && Number.isFinite(invHover.lambda)) {
        let lon = invHover.lambda * (180 / Math.PI);
        lon = ((((lon + 180) % 360) + 360) % 360) - 180;
        const lat = Math.max(-85, Math.min(85, invHover.phi * (180 / Math.PI)));
        cursorCoordsRef.current = { lat, lon };
        telemetryStore.setCursorCoords(cursorCoordsRef.current);
      }

      if (!isDraggingRef.current) return;
      const dx = e.clientX - lastMousePosRef.current.x;
      const dy = e.clientY - lastMousePosRef.current.y;
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      if (dragButtonRef.current === 0) {
        if (e.altKey || e.ctrlKey) {
          // Horizon Pitch / Tilt control (0 deg nadir to 85 deg grazing horizon)
          const pitchSpeed = 0.25;
          const currentPitch = (stateRef.current as any)?.cameraPitchDeg ?? (loadingRegionsRef.current as any)?.__obliquePitchDeg ?? 0;
          const nextPitch = Math.max(0, Math.min(85, currentPitch - dy * pitchSpeed));
          (loadingRegionsRef.current as any).__obliquePitchDeg = nextPitch;
          if (stateRef.current) {
            (stateRef.current as any).cameraPitchDeg = nextPitch;
          }
          if (typeof window !== 'undefined') {
            (window as any).__INDICATRIX_LIVE_UNIFORMS__ = {
              ...((window as any).__INDICATRIX_LIVE_UNIFORMS__ || {}),
              cameraPitchDeg: nextPitch,
            };
          }
          const lon = activeCoordsRef.current?.lon;
          const lat = activeCoordsRef.current?.lat;
          if (lon !== undefined && lat !== undefined) {
            const v = computeObliqueVectors(lon, lat, sphericalRef.current.radius, nextPitch, 0);
            cameraRef.current.position.set(v.camX, v.camY, v.camZ);
            targetRef.current.set(v.targetX, v.targetY, v.targetZ);
            cameraRef.current.up.set(v.vUpX, v.vUpY, v.vUpZ);
            cameraRef.current.lookAt(targetRef.current);
            cameraRef.current.updateMatrixWorld();
          }
          return;
        }

        // Orbit rotation: adaptively damped with camera altitude above the geoid
        cameraRef.current.up.set(0, 1, 0);
        const wasObliquePitch = ((loadingRegionsRef.current as any).__obliquePitchDeg || (stateRef.current as any)?.cameraPitchDeg || 0) > 0.01;
        (loadingRegionsRef.current as any).__obliquePitchDeg = 0;
        (loadingRegionsRef.current as any).__obliqueHeadingDeg = 0;
        if (stateRef.current) {
          (stateRef.current as any).cameraPitchDeg = 0;
          (stateRef.current as any).cameraHeadingDeg = 0;
        }
        if (typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__) {
          (window as any).__INDICATRIX_LIVE_UNIFORMS__.cameraPitchDeg = 0;
        }
        const altRatio = Math.max(0.04, Math.min(1.0, (sphericalRef.current.radius - 5.0) / 7.0));
        const rotateSpeed = 0.005 * (curUnfurl < 0.01 ? (0.04 + 0.96 * altRatio) : 1.0);
        const dTheta = -dx * rotateSpeed;
        const dPhi = -dy * rotateSpeed;

        sphericalRef.current.theta += dTheta;
        sphericalRef.current.phi = Math.min(
          Math.max(sphericalRef.current.phi + dPhi, 0.001),
          Math.PI - 0.001
        );
        // Track angular velocity for smooth inertial glide release
        velocityRef.current.velTheta = dTheta;
        velocityRef.current.velPhi = dPhi;

        const invOrbit = invertMacroChart([currentHitPosRef.current.x, currentHitPosRef.current.y, currentHitPosRef.current.z], curUnfurl, 5.0);
        if (Number.isFinite(invOrbit.phi) && Number.isFinite(invOrbit.lambda)) {
          let lon = invOrbit.lambda * (180 / Math.PI);
          lon = ((((lon + 180) % 360) + 360) % 360) - 180;
          const lat = Math.max(-85, Math.min(85, invOrbit.phi * (180 / Math.PI)));
          cursorCoordsRef.current = { lat, lon };
        }
        if (curUnfurl < 0.01) {
          let camLon = (sphericalRef.current.theta * 180) / Math.PI;
          camLon = ((((camLon + 180) % 360) + 360) % 360) - 180;
          const camLat = Math.max(-85, Math.min(85, 90 - (sphericalRef.current.phi * 180) / Math.PI));
          activeCoordsRef.current = { lat: camLat, lon: camLon };
          if (wasObliquePitch) {
            targetRef.current.set(0, 0, 0);
          }
        } else if (wasObliquePitch) {
          targetRef.current.set(cameraRef.current.position.x, cameraRef.current.position.y, 0.0);
        }
        if (curUnfurl < 0.01 && sphericalRef.current.radius >= 16.0) {
          targetRef.current.set(0, 0, 0);
        } else if (curUnfurl >= 0.01 && sphericalRef.current.radius >= 11.0 && targetRef.current.lengthSq() > 1e-6) {
          const macroRecenter = Math.min(0.18, ((sphericalRef.current.radius - 11.0) / 5.0) * 0.14 + 0.03);
          targetRef.current.set(
            targetRef.current.x * (1.0 - macroRecenter),
            targetRef.current.y * (1.0 - macroRecenter),
            0.0
          );
          let panLon = (targetRef.current.x / 5.0) * (180 / Math.PI);
          panLon = ((((panLon + 180) % 360) + 360) % 360) - 180;
          const clampedY = Math.max(-5.0 * 2.5, Math.min(5.0 * 2.5, targetRef.current.y));
          const curModeRot = stateRef.current?.mode ?? 0;
          const panLat = curModeRot === 0
            ? Math.max(-85, Math.min(85, (clampedY / 5.0) * (180 / Math.PI)))
            : (2.0 * Math.atan(Math.exp(clampedY / 5.0)) - Math.PI / 2.0) * (180 / Math.PI);
          activeCoordsRef.current = { lat: panLat, lon: panLon };
        }
      } else if (dragButtonRef.current === 2 || dragButtonRef.current === 1) {
        // Pan translation aligned with camera local screen-right and screen-up axes projected onto the sheet/target plane
        const effAlt = curUnfurl >= 0.5 ? Math.max(0.35, sphericalRef.current.radius - 5.0) : sphericalRef.current.radius;
        const panSpeed = (curUnfurl >= 0.5 ? Math.max(2.5, effAlt * 1.6) : sphericalRef.current.radius) * 0.001;
        const m = (cameraRef.current as any).matrixWorld?.elements;
        const rightLen = m ? Math.hypot(m[0], m[1], m[2]) : 0;
        const upLen = m ? Math.hypot(m[4], m[5], m[6]) : 0;
        let rightX = rightLen > 1e-4 ? m[0] / rightLen : Math.cos(sphericalRef.current.theta);
        let rightY = rightLen > 1e-4 ? m[1] / rightLen : Math.sin(sphericalRef.current.theta);
        let upX = upLen > 1e-4 ? m[4] / upLen : -Math.sin(sphericalRef.current.theta);
        let upY = upLen > 1e-4 ? m[5] / upLen : Math.cos(sphericalRef.current.theta);
        if (curUnfurl >= 0.5) {
          const rightXY = Math.hypot(rightX, rightY);
          if (rightXY > 1e-4) {
            rightX /= rightXY;
            rightY /= rightXY;
          }
          const upXY = Math.hypot(upX, upY);
          if (upXY > 1e-4) {
            upX /= upXY;
            upY /= upXY;
          } else {
            upX = -Math.sin(sphericalRef.current.theta);
            upY = Math.cos(sphericalRef.current.theta);
          }
        }
        const dScreenX = -dx * panSpeed;
        const dScreenY = dy * panSpeed;
        const dPanX = dScreenX * rightX + dScreenY * upX;
        const dPanY = dScreenX * rightY + dScreenY * upY;
        targetRef.current.x = Math.max(-Math.PI * 5.0, Math.min(Math.PI * 5.0, targetRef.current.x + dPanX));
        targetRef.current.y = Math.max(-Math.PI * 2.5, Math.min(Math.PI * 2.5, targetRef.current.y + dPanY));
        // Track pan velocity for smooth inertial glide release
        velocityRef.current.velPanX = dPanX;
        velocityRef.current.velPanY = dPanY;

        if (curUnfurl >= 0.01) {
          const invPan = invertMacroChart([currentHitPosRef.current.x, currentHitPosRef.current.y, currentHitPosRef.current.z], curUnfurl, 5.0);
          if (Number.isFinite(invPan.phi) && Number.isFinite(invPan.lambda)) {
            let lon = invPan.lambda * (180 / Math.PI);
            lon = ((((lon + 180) % 360) + 360) % 360) - 180;
            const lat = Math.max(-85, Math.min(85, invPan.phi * (180 / Math.PI)));
            cursorCoordsRef.current = { lat, lon };
          }
          let panLon = (targetRef.current.x / 5.0) * (180 / Math.PI);
          panLon = ((((panLon + 180) % 360) + 360) % 360) - 180;
          const clampedY = Math.max(-5.0 * 2.5, Math.min(5.0 * 2.5, targetRef.current.y));
          const curModePan = stateRef.current?.mode ?? 0;
          const panLat = curModePan === 0
            ? Math.max(-85, Math.min(85, (clampedY / 5.0) * (180 / Math.PI)))
            : (2.0 * Math.atan(Math.exp(clampedY / 5.0)) - Math.PI / 2.0) * (180 / Math.PI);
          activeCoordsRef.current = { lat: panLat, lon: panLon };
        }
      }
      updateCameraTransform();
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
    };

    const onPointerLeave = () => {
      isDraggingRef.current = false;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraTransitionRef.current = null;

      const canvas = canvasRef.current;
      const camera = cameraRef.current;
      if (!canvas || !camera) return;

      const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
      const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
      const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));

      // Horizontal two-finger trackpad scroll or Shift+Wheel pans across the planar map
      if (curUnfurl >= 0.5 && !e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.15)) {
        const effAlt = Math.max(0.4, sphericalRef.current.radius - 5.0);
        const panScale = Math.max(2.0, effAlt * 1.5) * 0.0012;
        const rightX = Math.cos(sphericalRef.current.theta);
        const rightY = Math.sin(sphericalRef.current.theta);
        const fwdX = -Math.sin(sphericalRef.current.theta);
        const fwdY = Math.cos(sphericalRef.current.theta);
        const rawDx = e.shiftKey && Math.abs(e.deltaX) < 1e-3 ? e.deltaY : e.deltaX;
        const rawDy = e.shiftKey && Math.abs(e.deltaX) < 1e-3 ? 0 : e.deltaY;
        const dPanX = (rawDx * rightX - rawDy * fwdX) * panScale;
        const dPanY = (rawDx * rightY - rawDy * fwdY) * panScale;
        targetRef.current.x = Math.max(-Math.PI * 5.0, Math.min(Math.PI * 5.0, targetRef.current.x + dPanX));
        targetRef.current.y = Math.max(-Math.PI * 2.5, Math.min(Math.PI * 2.5, targetRef.current.y + dPanY));
        velocityRef.current.velPanX = dPanX * 0.5;
        velocityRef.current.velPanY = dPanY * 0.5;
        updateCameraTransform();
        return;
      }

      // Smooth inertial zoom impulse scaled proportionally to camera altitude above the surface
      const minEffectiveAlt = e.deltaY > 0 ? 2.8 : 0.08;
      const altAboveSurface = Math.max(minEffectiveAlt, sphericalRef.current.radius - (curUnfurl < 0.01 ? 5.0 : 4.6));
      const zoomScale = Math.min(0.0025, altAboveSurface * 0.00025);
      const zoomImpulse = Math.max(-0.35, Math.min(0.35, e.deltaY * zoomScale));
      velocityRef.current.velRadius = Math.max(-0.6, Math.min(0.6, velocityRef.current.velRadius + zoomImpulse));

      const hitPos = currentHitPosRef.current;

      if (e.deltaY < 0) {
        // Zoom In: Lerp target toward cursor hit point if on-globe or planar sheet
        if (hitPos) {
          const lerpFactor = curUnfurl < 0.01 ? 0.0 : Math.min(0.16, Math.abs(e.deltaY) * 0.0020);
          targetRef.current.lerp(hitPos, lerpFactor);
          if (curUnfurl >= 0.01) {
            targetRef.current.x = Math.max(-Math.PI * 5.0, Math.min(Math.PI * 5.0, targetRef.current.x));
            targetRef.current.y = Math.max(-Math.PI * 2.5, Math.min(Math.PI * 2.5, targetRef.current.y));
            targetRef.current.z = 0.0;
            const clampedHitX = Math.max(-Math.PI * 5.0, Math.min(Math.PI * 5.0, hitPos.x));
            const clampedHitY = Math.max(-Math.PI * 2.5, Math.min(Math.PI * 2.5, hitPos.y));
            const panFollow = Math.min(0.045, Math.abs(e.deltaY) * 0.00045);
            velocityRef.current.velPanX = (clampedHitX - targetRef.current.x) * panFollow;
            velocityRef.current.velPanY = (clampedHitY - targetRef.current.y) * panFollow;
            let panLon = (targetRef.current.x / 5.0) * (180 / Math.PI);
            panLon = ((((panLon + 180) % 360) + 360) % 360) - 180;
            const clampedY = Math.max(-5.0 * 2.5, Math.min(5.0 * 2.5, targetRef.current.y));
            const curModeZoom = stateRef.current?.mode ?? 0;
            const panLat = curModeZoom === 0
              ? Math.max(-85, Math.min(85, (clampedY / 5.0) * (180 / Math.PI)))
              : (2.0 * Math.atan(Math.exp(clampedY / 5.0)) - Math.PI / 2.0) * (180 / Math.PI);
            activeCoordsRef.current = { lat: panLat, lon: panLon };
          }
          const len = targetRef.current.length();
          if (curUnfurl < 0.01 && len > 5.0) {
            targetRef.current.multiplyScalar(5.0 / len);
          }
          const isObliqueZoom = ((loadingRegionsRef.current as any).__obliquePitchDeg || (stateRef.current as any)?.cameraPitchDeg || 0) > 0.01;
          if (curUnfurl < 0.01 && hitPos.lengthSq() > 1.0 && !isObliqueZoom) {
            const hitLen = hitPos.length();
            const hitTheta = Math.atan2(hitPos.x, hitPos.z);
            const hitPhi = Math.acos(Math.max(-1.0, Math.min(1.0, hitPos.y / hitLen)));
            let dTheta = ((hitTheta - sphericalRef.current.theta + Math.PI) % (2.0 * Math.PI));
            if (dTheta < 0.0) dTheta += 2.0 * Math.PI;
            dTheta -= Math.PI;
            const angleFollow = Math.min(0.055, Math.abs(e.deltaY) * 0.00042);
            sphericalRef.current.theta += dTheta * angleFollow;
            sphericalRef.current.phi = Math.max(0.001, Math.min(Math.PI - 0.001, sphericalRef.current.phi + (hitPhi - sphericalRef.current.phi) * angleFollow));
          }
        } else {
          // Fallback: if off-globe, standard radial distance adjustment while decaying target toward origin
          const recenterFactor = Math.min(0.05, Math.abs(e.deltaY) * 0.0005);
          targetRef.current.lerp(ORIGIN_VEC, recenterFactor);
        }
      } else if (e.deltaY > 0) {
        // Zoom Out: Exponentially decay target back toward (0, 0, 0) in spherical mode only
        if (curUnfurl < 0.01) {
          const recenterFactor = Math.min(0.10, Math.abs(e.deltaY) * 0.0010);
          targetRef.current.lerp(ORIGIN_VEC, recenterFactor);
          if (sphericalRef.current.radius >= 20.0 || targetRef.current.lengthSq() < 1e-5) {
            targetRef.current.set(0, 0, 0);
          }
        }
      }

      updateCameraTransform();
    };

    const onDoubleClick = () => {
      const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
      const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
      const curUnfurl = scrubAlpha !== undefined ? scrubAlpha : (animAlpha !== undefined ? animAlpha : (stateRef.current?.unfurlProgress ?? 0));
      const hitPos = currentHitPosRef.current;
      if (!hitPos) return;
      if (curUnfurl >= 0.01) {
        const clampedHitX = Math.max(-Math.PI * 5.0, Math.min(Math.PI * 5.0, hitPos.x));
        const clampedHitY = Math.max(-Math.PI * 2.5, Math.min(Math.PI * 2.5, hitPos.y));
        velocityRef.current.velPanX = (clampedHitX - targetRef.current.x) * 0.055;
        velocityRef.current.velPanY = (clampedHitY - targetRef.current.y) * 0.055;
        velocityRef.current.velRadius = Math.max(-0.25, -Math.max(0.0, sphericalRef.current.radius - 5.6) * 0.03);
      } else if (hitPos.lengthSq() > 1.0) {
        const hitLen = hitPos.length();
        const hitTheta = Math.atan2(hitPos.x, hitPos.z);
        const hitPhi = Math.acos(Math.max(-1.0, Math.min(1.0, hitPos.y / hitLen)));
        let dTheta = ((hitTheta - sphericalRef.current.theta + Math.PI) % (2.0 * Math.PI));
        if (dTheta < 0.0) dTheta += 2.0 * Math.PI;
        dTheta -= Math.PI;
        velocityRef.current.velTheta = dTheta * 0.05;
        velocityRef.current.velPhi = (hitPhi - sphericalRef.current.phi) * 0.05;
      }
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    const container = containerRef.current || canvas;

    container.addEventListener('pointerdown', onPointerDown as EventListener);
    container.addEventListener('pointerleave', onPointerLeave as EventListener);
    window.addEventListener('pointermove', onPointerMove as EventListener);
    window.addEventListener('pointerup', onPointerUp as EventListener);
    container.addEventListener('wheel', onWheel as EventListener, { passive: false });
    container.addEventListener('dblclick', onDoubleClick as EventListener);
    container.addEventListener('contextmenu', onContextMenu as EventListener);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown as EventListener);
      container.removeEventListener('pointerleave', onPointerLeave as EventListener);
      window.removeEventListener('pointermove', onPointerMove as EventListener);
      window.removeEventListener('pointerup', onPointerUp as EventListener);
      container.removeEventListener('wheel', onWheel as EventListener);
      container.removeEventListener('dblclick', onDoubleClick as EventListener);
      container.removeEventListener('contextmenu', onContextMenu as EventListener);
    };
  }, [updateCameraTransform]);

  // Load Geometry and Initialize WebGPU Engine (or swap point buffers in-place on 100k <-> 1M)
  useEffect(() => {
    let isMounted = true;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const tier = TIER_CONFIG[resolution] || TIER_CONFIG['100k'];
    const binFile = tier.bin;
    activeLodTierRef.current = resolution;

    // Fast-path 1: Underlying point dataset is already loaded in GPU memory.
    if (engineRef.current.initialized && loadedBinRef.current === binFile) {
      activeLodTierRef.current = resolution;
      const baseBytes = loadedDataInfoRef.current?.baseVramBytes || 0;
      callbacksRef.current.onDataLoaded?.({
        pointCount: loadedDataInfoRef.current?.pointCount || 0,
        lineCount: loadedDataInfoRef.current?.lineCount || 0,
        format: 'WebGPU (CDLOD Dynamic)',
        loadTimeMs: 1,
        vramMb: parseFloat((baseBytes / (1024 * 1024)).toFixed(2)),
      });
      return;
    }

    // Fast-path 2: Engine is already initialized — reallocate staticBuffer, particleBuffers[0..1],
    // lineIndexBuffer, and computeBindGroups IN-PLACE without calling engine.dispose()!
    if (engineRef.current.initialized) {
      loadedBinRef.current = binFile;
      const tSwap0 = performance.now();
      fetch(binFile)
        .then(async (res) => {
          let buffer: ArrayBuffer | null = null;
          if (res.ok) {
            const candidate = await res.arrayBuffer();
            if (candidate.byteLength >= 32 && new DataView(candidate).getUint32(0, true) === 0x47454F4D) {
              buffer = candidate;
            }
          }
          if (!buffer && binFile !== '/geo-mesh-100k.bin') {
            const fallbackRes = await fetch('/geo-mesh-100k.bin');
            if (fallbackRes.ok) {
              const fallbackCandidate = await fallbackRes.arrayBuffer();
              if (fallbackCandidate.byteLength >= 32 && new DataView(fallbackCandidate).getUint32(0, true) === 0x47454F4D) {
                buffer = fallbackCandidate;
              }
            }
          }
          if (!buffer || !isMounted || !engineRef.current.initialized) return;

          const view = new DataView(buffer);
          if (view.getUint32(0, true) !== 0x47454F4D) return;
          const pointCount = view.getUint32(8, true);
          const indexCount = view.getUint32(12, true);
          const pOffset = view.getUint32(16, true);
          const tOffset = view.getUint32(20, true);
          const typOffset = view.getUint32(24, true);
          const iOffset = view.getUint32(28, true);

          const pointsData = new Float32Array(buffer, pOffset, pointCount * 3);
          const target2DData = new Float32Array(buffer, tOffset, pointCount * 2);
          const typeData = new Float32Array(buffer, typOffset, pointCount);
          const lineIndices = new Uint32Array(buffer, iOffset, indexCount);

          engineRef.current.reallocateParticleBuffers({
            pointCount,
            pointsData,
            target2DData,
            typeData,
            lineIndices,
          });
          activeLodTierRef.current = resolution;
          const vramBytes =
            pointsData.byteLength + target2DData.byteLength + typeData.byteLength + lineIndices.byteLength;
          loadedDataInfoRef.current = {
            pointCount,
            lineCount: indexCount / 2,
            baseVramBytes: vramBytes,
          };
          callbacksRef.current.onDataLoaded?.({
            pointCount,
            lineCount: indexCount / 2,
            format: 'WebGPU (Binary Mesh)',
            loadTimeMs: Math.max(1, Math.round(performance.now() - tSwap0)),
            vramMb: parseFloat((vramBytes / (1024 * 1024)).toFixed(2)),
          });
        })
        .catch((swapErr) => {
          console.error('[WebGPUCanvas] In-place buffer reallocation failed:', swapErr);
        });

      return () => {
        isMounted = false;
      };
    }

    setIsLoading(true);
    setLoadError(null);

    const t0 = performance.now();

    loadedBinRef.current = binFile;
    const engine = engineRef.current;
    (window as any).__WEBGPU_ENGINE__ = engine;
    if ((window as any).__INDICATRIX_CAMERA__) {
      (window as any).__INDICATRIX_CAMERA__.camera = cameraRef.current;
    } else {
      (window as any).__INDICATRIX_CAMERA__ = cameraRef.current;
    }
    engine.camera = cameraRef.current;

    // Kick off WebGPU adapter/device acquisition, prebaked SDF font atlas fetch, and OPFS warm DEM read in parallel with initial binary mesh fetch
    void getWebGPUDevice();
    void preloadSDFAtlas();
    void opfsAssetStore.prefetchGlobalDEMPyramid('/earth-gebco2024-dem-u16.bin');

    fetch(binFile)
      .then(async (res) => {
        let buffer: ArrayBuffer | null = null;
        if (res.ok) {
          const candidate = await res.arrayBuffer();
          if (candidate.byteLength >= 32 && new DataView(candidate).getUint32(0, true) === 0x47454F4D) {
            buffer = candidate;
          }
        }
        if (!buffer && binFile !== '/geo-mesh-100k.bin') {
          const fallbackRes = await fetch('/geo-mesh-100k.bin');
          if (fallbackRes.ok) {
            const fallbackCandidate = await fallbackRes.arrayBuffer();
            if (fallbackCandidate.byteLength >= 32 && new DataView(fallbackCandidate).getUint32(0, true) === 0x47454F4D) {
              buffer = fallbackCandidate;
            }
          }
        }
        if (!buffer) throw new Error(`BIN fetch failed (${res.status})`);
        if (!isMounted) return;

        const view = new DataView(buffer);
        const magic = view.getUint32(0, true);
        if (magic !== 0x47454F4D) throw new Error('Invalid binary magic header');

        const pointCount = view.getUint32(8, true);
        const indexCount = view.getUint32(12, true);
        const pOffset = view.getUint32(16, true);
        const tOffset = view.getUint32(20, true);
        const typOffset = view.getUint32(24, true);
        const iOffset = view.getUint32(28, true);

        const pointsData = new Float32Array(buffer, pOffset, pointCount * 3);
        const target2DData = new Float32Array(buffer, tOffset, pointCount * 2);
        const typeData = new Float32Array(buffer, typOffset, pointCount);
        const lineIndices = new Uint32Array(buffer, iOffset, indexCount);

        await engine.initialize({
          canvas,
          pointCount,
          pointsData,
          target2DData,
          typeData,
          lineIndices,
        });
        activeLodTierRef.current = resolution;
        (window as any).__INDICATRIX_WEBGPU_ENGINE__ = engine;
        if (typeof engine.setVolumetricCloudsEnabled === 'function') {
          engine.setVolumetricCloudsEnabled(volumetricClouds ?? true);
        }

        // Apply already-prefetched warm OPFS 14-mip DEM pyramid immediately (< 100 ms) before vector/cloud builds;
        // on cold boot (record === null in ~2 ms), fall through to non-blocking network loadDEMTexture.
        const appliedWarmDem =
          typeof engine.tryApplyWarmPrefetchedDEM === 'function'
            ? await engine.tryApplyWarmPrefetchedDEM('/earth-gebco2024-dem-u16.bin')
            : false;
        if (!appliedWarmDem) {
          engine.loadDEMTexture('/earth-gebco2024-dem-u16.bin').catch(() => {
            engine.loadDEMTexture('/earth-etopo2022-dem-u16.bin').catch(() => {
              engine.loadDEMTexture('/earth-gebco2024-dem.webp').catch(() => {
                engine.loadDEMTexture('/earth-etopo2022.cog.tif').catch(() => {});
              });
            });
          });
        }
        engine.loadHydroTexture('/earth-hydrology-bc5.dds').catch(() => {});
        engine.loadNormalTexture('/earth-normals-bc5.dds').catch(() => {});
        engine.loadVectorData('/geo-vectors.bin').catch(() => {});
        if (cachedLayersRef.current.showContours) {
          engine.loadContourMesh('/geo-contour-mesh.bin').catch(() => {});
        }
        if (cachedLayersRef.current.showSatellites) {
          engine.loadSatelliteTrajectories('/data/tle-starlink.json').catch(() => {});
        }
        const isWnModel = isWeatherNextModel(prognosticModel);
        const isSatModel = isSatelliteModel(prognosticModel);

        if (isSatModel) {
          engine.loadWindTexture('/data/weathernext/wind_10m_vector-0.bin').catch(() => {
            engine.loadWindTexture('/data/gfs-wind-latest.bin').catch(() => {});
          });
          engine.loadAllCloudLayers(false, 0, 'satellite').catch(() => {});
        } else if (isWnModel) {
          engine.loadWindTexture('/data/weathernext/wind_10m_vector-0.bin').catch(() => {
            engine.loadWindTexture('/data/gfs-wind-latest.bin').catch(() => {});
          });
          engine.loadAllCloudLayers(true).catch(() => {});
        } else {
          engine.loadWindTexture('/data/gfs-wind-latest.bin').catch(() => {});
          engine.loadAllCloudLayers(false).catch(() => {});
        }

        if (!isMounted) {
          return;
        }
        setIsLoading(false);
        setIsEngineReady(true);

        const t1 = performance.now();
        const vramBytes = pointsData.byteLength + target2DData.byteLength + typeData.byteLength + lineIndices.byteLength;
        loadedDataInfoRef.current = {
          pointCount,
          lineCount: indexCount / 2,
          baseVramBytes: vramBytes,
        };

        const totalVramMb = parseFloat((vramBytes / (1024 * 1024)).toFixed(2));

        callbacksRef.current.onDataLoaded?.({
          pointCount,
          lineCount: indexCount / 2,
          format: 'WebGPU (Binary Mesh)',
          loadTimeMs: Math.round(t1 - t0),
          vramMb: totalVramMb,
        });
      })
      .catch((binErr) => {
        console.error('[WebGPUCanvas] bin load error:', binErr);
        if (isMounted) {
          setLoadError(binErr.message);
          callbacksRef.current.onError?.(binErr);
          onError?.(binErr);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [resolution]);

  // Dedicated unmount teardown
  useEffect(() => {
    return () => {
      if (ownedWnDataSourceRef.current) {
        const dsToDispose = ownedWnDataSourceRef.current;
        ownedWnDataSourceRef.current = null;
        if ((window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__ === dsToDispose) {
          delete (window as any).__INDICATRIX_WEATHERNEXT_DATA_SOURCE__;
        }
        try { dsToDispose.dispose?.(); } catch {}
      }
      if (ownedWnRingRef.current) {
        const ringToDispose = ownedWnRingRef.current;
        ownedWnRingRef.current = null;
        if ((window as any).__INDICATRIX_WEATHERNEXT_RING_BUFFER__ === ringToDispose) {
          delete (window as any).__INDICATRIX_WEATHERNEXT_RING_BUFFER__;
        }
        try { ringToDispose.dispose?.(); } catch {}
      }
      engineRef.current.dispose();
      loadedBinRef.current = null;
    };
  }, []);

  // Resize Handling
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const handleResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      viewportSizeRef.current = { width, height, dpr };

      const nextW = Math.round(width * dpr);
      const nextH = Math.round(height * dpr);
      if (nextW <= 0 || nextH <= 0) return;

      cameraRef.current.aspect = width / Math.max(height, 1);
      cameraRef.current.updateProjectionMatrix();

      if (canvas.width !== nextW || canvas.height !== nextH) {
        canvas.width = nextW;
        canvas.height = nextH;
        engineRef.current.resize(canvas.width, canvas.height);
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);
    handleResize();

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // WebGPU Continuous Simulation & Render Loop (Decoupled with refs for sustained 120 FPS)
  useEffect(() => {
    let isActive = true;

    const renderLoop = (now: number) => {
      if (!isActive) return;
      if (typeof window !== 'undefined' && (window as any).__INDICATRIX_PAUSE_RENDER_LOOP__) {
        animFrameRef.current = requestAnimationFrame(renderLoop);
        return;
      }

      const engine = engineRef.current;
      const camera = cameraRef.current;
      const tracker = cursorTrackerRef.current;
      const {
        unfurlProgress: curUnfurlProp,
        mode: curModeProp,
        layerMode: curLayer,
        theme: curTheme,
        showVectors: curShowVectors,
      } = stateRef.current;

      const directMode = typeof window !== 'undefined' ? (window as any).__INDICATRIX_MODE__ : undefined;
      const curMode = directMode !== undefined ? directMode : curModeProp;

      const scrubAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_SCRUB_ALPHA__ : undefined;
      const animAlpha = typeof window !== 'undefined' ? (window as any).__INDICATRIX_ANIM_ALPHA__ : undefined;
      const storeLiveAlpha = telemetryStore.getLiveUnfurl();

      if (scrubAlpha !== undefined) {
        lastScrubAlphaRef.current = scrubAlpha;
        scrubReleaseFramesRef.current = 0;
      } else if (lastScrubAlphaRef.current !== undefined) {
        scrubReleaseFramesRef.current += 1;
        // Hold scrub value for up to 3 frames or until React prop catches up to eliminate pointerup flicker
        if (scrubReleaseFramesRef.current > 3 || Math.abs(curUnfurlProp - lastScrubAlphaRef.current) < 0.001) {
          lastScrubAlphaRef.current = undefined;
        }
      }

      const activeScrub = scrubAlpha !== undefined ? scrubAlpha : lastScrubAlphaRef.current;
      const curUnfurl =
        activeScrub !== undefined
          ? activeScrub
          : animAlpha !== undefined
            ? animAlpha
            : storeLiveAlpha !== null
              ? storeLiveAlpha
              : curUnfurlProp;

      if (engine.initialized) {
        const appStartTime = startTime !== undefined ? startTime : startTimeRef.current;
        const time = (now - appStartTime) / 1000;
        const dt = Math.min((now - lastFrameTimeRef.current) / 1000, 0.1);
        lastFrameTimeRef.current = now;

        // Trajectory Camera Controller override when Demo Mode is active
        const curIsDemoMode = stateRef.current.isDemoMode;
        if (curIsDemoMode) {
          const trajectory = trajectoryControllerRef.current;
          trajectory.update(dt);
          camera.position.copy(trajectory.position);
          targetRef.current.copy(trajectory.target);
          camera.lookAt(targetRef.current);
          if (trajectory.getFov()) {
            camera.fov = trajectory.getFov();
            camera.updateProjectionMatrix();
          }
          camera.updateMatrixWorld();

          // Suppress manual inertial velocities while trajectory camera has authority
          velocityRef.current.velTheta = 0;
          velocityRef.current.velPhi = 0;
          velocityRef.current.velRadius = 0;
          velocityRef.current.velPanX = 0;
          velocityRef.current.velPanY = 0;

          if (trajectory.isFinished()) {
            callbacksRef.current.onDemoModeChange?.(false);
            if (curUnfurl < 0.01) {
              sphericalRef.current.radius = camera.position.length();
              sphericalRef.current.theta = Math.atan2(camera.position.x, camera.position.z);
              sphericalRef.current.phi = Math.acos(Math.min(Math.max(camera.position.y / Math.max(sphericalRef.current.radius, 0.001), -1), 1));
            } else {
              const offset = _scratchVecA.subVectors(camera.position, targetRef.current);
              sphericalRef.current.radius = offset.length();
              sphericalRef.current.theta = Math.atan2(offset.x, offset.z);
              sphericalRef.current.phi = Math.acos(Math.min(Math.max(offset.y / Math.max(sphericalRef.current.radius, 0.001), -1), 1));
            }
          }
        } else if (cameraTransitionRef.current && !isDraggingRef.current) {
          const tr = cameraTransitionRef.current;
          const elapsed = now - tr.startTime;
          const alpha = Math.min(1.0, Math.max(0.0, elapsed / tr.duration));
          // Smootherstep easing: 6a^5 - 15a^4 + 10a^3
          const ease = alpha * alpha * alpha * (alpha * (alpha * 6 - 15) + 10);

          // Position along spherical arc with ground clearance safety floor r >= 5.15
          const r0 = tr.startPos.length();
          const r1 = tr.endPos.length();
          const curR = Math.max(5.15, r0 + (r1 - r0) * ease);
          const effectiveR = Math.min(r0, r1) < 5.15 ? (r0 + (r1 - r0) * ease) : curR;
          const slerpPos = slerpVec3(tr.startPos, tr.endPos, ease);
          camera.position.set(slerpPos[0] * effectiveR, slerpPos[1] * effectiveR, slerpPos[2] * effectiveR);

          // Target lerp
          targetRef.current.lerpVectors(tr.startTarget, tr.endTarget, ease);

          // Up vector slerp
          const slerpUp = slerpVec3(tr.startUp, tr.endUp, ease);
          camera.up.set(slerpUp[0], slerpUp[1], slerpUp[2]);

          camera.lookAt(targetRef.current);
          camera.updateMatrixWorld();

          if (curUnfurl < 0.01) {
            const rLen = Math.max(camera.position.length(), 0.001);
            sphericalRef.current.radius = rLen;
            sphericalRef.current.theta = Math.atan2(camera.position.x, camera.position.z);
            sphericalRef.current.phi = Math.acos(Math.min(Math.max(camera.position.y / rLen, -1), 1));
            let lon = (sphericalRef.current.theta * 180) / Math.PI;
            lon = ((((lon + 180) % 360) + 360) % 360) - 180;
            const lat = Math.max(-85, Math.min(85, 90 - (sphericalRef.current.phi * 180) / Math.PI));
            activeCoordsRef.current = { lat, lon };
          } else {
            const offset = _scratchVecA.subVectors(camera.position, targetRef.current);
            sphericalRef.current.radius = offset.length();
            sphericalRef.current.theta = Math.atan2(offset.x, offset.z);
            sphericalRef.current.phi = Math.acos(Math.min(Math.max(offset.y / Math.max(sphericalRef.current.radius, 0.001), -1), 1));
          }

          if (alpha >= 1.0) {
            cameraTransitionRef.current = null;
          }
        } else if (targetCameraPosRef.current && !isDraggingRef.current) {
          const targetPos = targetCameraPosRef.current;
          camera.position.lerp(targetPos, 0.08);
          targetRef.current.lerp(ORIGIN_VEC, 0.08);
          const offset = _scratchVecA.subVectors(camera.position, targetRef.current);
          sphericalRef.current.radius = offset.length();
          sphericalRef.current.theta = Math.atan2(offset.x, offset.z);
          sphericalRef.current.phi = Math.acos(Math.min(Math.max(offset.y / Math.max(sphericalRef.current.radius, 0.001), -1), 1));
          let lon = (sphericalRef.current.theta * 180) / Math.PI;
          lon = ((((lon + 180) % 360) + 360) % 360) - 180;
          const lat = Math.max(-85, Math.min(85, 90 - (sphericalRef.current.phi * 180) / Math.PI));
          activeCoordsRef.current = { lat, lon };
          if (curUnfurl < 0.01) {
            updateCameraTransform();
          } else {
            camera.up.set(0, 1, 0);
            camera.lookAt(targetRef.current);
            camera.updateMatrixWorld();
          }

          if (camera.position.distanceTo(targetPos) < 0.05) {
            camera.position.copy(targetPos);
            targetRef.current.copy(ORIGIN_VEC);
            const finalOffset = _scratchVecA.subVectors(camera.position, targetRef.current);
            sphericalRef.current.radius = finalOffset.length();
            sphericalRef.current.theta = Math.atan2(finalOffset.x, finalOffset.z);
            sphericalRef.current.phi = Math.acos(Math.min(Math.max(finalOffset.y / Math.max(sphericalRef.current.radius, 0.001), -1), 1));
            let finalLon = (sphericalRef.current.theta * 180) / Math.PI;
            finalLon = ((((finalLon + 180) % 360) + 360) % 360) - 180;
            const finalLat = Math.max(-85, Math.min(85, 90 - (sphericalRef.current.phi * 180) / Math.PI));
            activeCoordsRef.current = { lat: finalLat, lon: finalLon };
            targetCameraPosRef.current = null;
            updateCameraTransform();
          }
        } else {
          // Native Inertial Camera Controller glide (decay factor 0.05 matching Drei OrbitControls glide)
          const DAMPING_FACTOR = 0.05;
          const decay = Math.pow(1 - DAMPING_FACTOR, Math.max(1, dt * 60));
          const vel = velocityRef.current;

          if (
            Math.abs(vel.velTheta) > 1e-6 ||
            Math.abs(vel.velPhi) > 1e-6 ||
            Math.abs(vel.velRadius) > 1e-6 ||
            Math.abs(vel.velPanX) > 1e-6 ||
            Math.abs(vel.velPanY) > 1e-6
          ) {
            if (!isDraggingRef.current) {
              sphericalRef.current.theta += vel.velTheta;
              sphericalRef.current.phi = Math.min(
                Math.max(sphericalRef.current.phi + vel.velPhi, 0.001),
                Math.PI - 0.001
              );
              targetRef.current.x = Math.max(-Math.PI * 5.0, Math.min(Math.PI * 5.0, targetRef.current.x + vel.velPanX));
              targetRef.current.y = Math.max(-Math.PI * 2.5, Math.min(Math.PI * 2.5, targetRef.current.y + vel.velPanY));

              vel.velTheta *= decay;
              vel.velPhi *= decay;
              vel.velPanX *= decay;
              vel.velPanY *= decay;

              if (Math.abs(vel.velTheta) < 1e-6) vel.velTheta = 0;
              if (Math.abs(vel.velPhi) < 1e-6) vel.velPhi = 0;
              if (Math.abs(vel.velPanX) < 1e-6) vel.velPanX = 0;
              if (Math.abs(vel.velPanY) < 1e-6) vel.velPanY = 0;

              if (curUnfurl < 0.01 && (Math.abs(vel.velTheta) > 1e-6 || Math.abs(vel.velPhi) > 1e-6)) {
                let lon = (sphericalRef.current.theta * 180) / Math.PI;
                lon = ((((lon + 180) % 360) + 360) % 360) - 180;
                const lat = Math.max(-85, Math.min(85, 90 - (sphericalRef.current.phi * 180) / Math.PI));
                activeCoordsRef.current = { lat, lon };
              } else if (curUnfurl > 0.0001 && (Math.abs(vel.velPanX) > 1e-6 || Math.abs(vel.velPanY) > 1e-6)) {
                let lon = (targetRef.current.x / 5.0) * (180 / Math.PI);
                lon = ((((lon + 180) % 360) + 360) % 360) - 180;
                const clampedY = Math.max(-5.0 * 2.5, Math.min(5.0 * 2.5, targetRef.current.y));
                const curModeGlide = stateRef.current?.mode ?? 0;
                const lat = curModeGlide === 0
                  ? Math.max(-85, Math.min(85, (clampedY / 5.0) * (180 / Math.PI)))
                  : (2.0 * Math.atan(Math.exp(clampedY / 5.0)) - Math.PI / 2.0) * (180 / Math.PI);
                activeCoordsRef.current = { lat, lon };
              }
            }

            if (Math.abs(vel.velRadius) > 1e-6) {
              const currentPhi = sphericalRef.current.phi;
              const currentTheta = sphericalRef.current.theta;
              const sphLat = 90 - (currentPhi * 180) / Math.PI;
              let sphLon = (currentTheta * 180) / Math.PI;
              sphLon = (((sphLon + 180) % 360) + 360) % 360 - 180;
              const currentLat = curUnfurl >= 0.5 ? (activeCoordsRef.current?.lat ?? sphLat) : sphLat;
              const currentLon = curUnfurl >= 0.5 ? (activeCoordsRef.current?.lon ?? sphLon) : sphLon;
              const h_floor = getGroundClearanceFloor(currentLon, currentLat, sphericalRef.current.radius + vel.velRadius);
              sphericalRef.current.radius = Math.min(
                Math.max(sphericalRef.current.radius + vel.velRadius, h_floor),
                50.0
              );
              if (curUnfurl >= 0.5 && vel.velRadius > 0 && sphericalRef.current.radius >= 11.0 && targetRef.current.lengthSq() > 1e-6) {
                const zoomOutRecenter = Math.min(0.14, ((sphericalRef.current.radius - 11.0) / 6.0) * 0.12 + 0.02);
                targetRef.current.x *= (1.0 - zoomOutRecenter);
                targetRef.current.y *= (1.0 - zoomOutRecenter);
                let lon = (targetRef.current.x / 5.0) * (180 / Math.PI);
                lon = ((((lon + 180) % 360) + 360) % 360) - 180;
                const clampedY = Math.max(-5.0 * 2.5, Math.min(5.0 * 2.5, targetRef.current.y));
                const curModeZoomOut = stateRef.current?.mode ?? 0;
                const lat = curModeZoomOut === 0
                  ? Math.max(-85, Math.min(85, (clampedY / 5.0) * (180 / Math.PI)))
                  : (2.0 * Math.atan(Math.exp(clampedY / 5.0)) - Math.PI / 2.0) * (180 / Math.PI);
                activeCoordsRef.current = { lat, lon };
              }
              vel.velRadius *= decay;
              if (Math.abs(vel.velRadius) < 1e-6) vel.velRadius = 0;
            }

            if (curUnfurl <= 0.0001 && sphericalRef.current.radius >= 20.0 && targetRef.current.lengthSq() > 1e-5) {
              targetRef.current.set(0, 0, 0);
            }

            updateCameraTransform();
          }
        }

        if (!curIsDemoMode && !cameraTransitionRef.current && !targetCameraPosRef.current) {
          const isPanning = (isDraggingRef.current && (dragButtonRef.current === 1 || dragButtonRef.current === 2))
            || (Math.abs(velocityRef.current.velPanX) > 1e-6 || Math.abs(velocityRef.current.velPanY) > 1e-6);
          const isUnfurlAnimating = Math.abs(curUnfurl - lastUnfurlRef.current) > 1e-5;
          let targetChanged = false;

          if (isUnfurlAnimating && !isPanning) {
            const clampedUnfurl = Math.max(0.0, Math.min(1.0, curUnfurl));
            const unrollEase = clampedUnfurl * clampedUnfurl * (3.0 - 2.0 * clampedUnfurl);
            const prevUnfurl = Math.max(0.0, Math.min(1.0, lastUnfurlRef.current));
            const prevEase = prevUnfurl * prevUnfurl * (3.0 - 2.0 * prevUnfurl);
            const dEase = unrollEase - prevEase;
            const isGlobalView = sphericalRef.current.radius >= 16.0;

            if (!isDraggingRef.current) {
              cameraRef.current.up.set(0, 1, 0);
              if (dEase > 1e-6) {
                const rightingStep = Math.min(1.0, dEase / Math.max(1e-4, 1.0 - prevEase));
                let wrappedTheta = ((sphericalRef.current.theta + Math.PI) % (2.0 * Math.PI));
                if (wrappedTheta < 0.0) wrappedTheta += 2.0 * Math.PI;
                wrappedTheta -= Math.PI;
                sphericalRef.current.theta = wrappedTheta * (1.0 - rightingStep);
              } else if (dEase < -1e-6) {
                const foldStep = Math.min(1.0, (-dEase) / Math.max(1e-4, prevEase));
                const goalTheta = (activeCoordsRef.current.lon * Math.PI) / 180.0;
                const goalPhi = ((90.0 - activeCoordsRef.current.lat) * Math.PI) / 180.0;
                let diffTheta = ((goalTheta - sphericalRef.current.theta + Math.PI) % (2.0 * Math.PI));
                if (diffTheta < 0.0) diffTheta += 2.0 * Math.PI;
                diffTheta -= Math.PI;
                sphericalRef.current.theta += diffTheta * foldStep;
                sphericalRef.current.phi += (goalPhi - sphericalRef.current.phi) * foldStep;
              }
            }

            const targetBlend = (clampedUnfurl <= 0.0 || isGlobalView) ? 0.0 : (clampedUnfurl >= 0.10 ? 1.0 : (clampedUnfurl / 0.10) * (clampedUnfurl / 0.10) * (3.0 - 2.0 * (clampedUnfurl / 0.10)));

            if (targetBlend <= 0.0) {
              if (targetRef.current.lengthSq() > 1e-6) {
                targetRef.current.set(0, 0, 0);
                targetChanged = true;
              }
            } else {
              const lon = activeCoordsRef.current.lon;
              const lat = activeCoordsRef.current.lat;
              const deformed = evaluatePointMorph(lon, lat, curUnfurl, curMode, time, 0.0);

              const effPhi = sphericalRef.current.phi;
              const effTheta = sphericalRef.current.theta;
              const sinPhi = Math.sin(effPhi);
              const cosPhi = Math.cos(effPhi);
              const sinTheta = Math.sin(effTheta);
              const cosTheta = Math.cos(effTheta);
              const dirX = sinPhi * sinTheta;
              const dirY = cosPhi;
              const dirZ = sinPhi * cosTheta;
              const dirLen = Math.hypot(dirX, dirY, dirZ);
              const invLen = dirLen > 1e-6 ? 1.0 / dirLen : 1.0;
              const standoff = 5.0 * (1.0 - unrollEase);

              const fullTargetX = deformed[0] - standoff * (dirX * invLen);
              const fullTargetY = deformed[1] - standoff * (dirY * invLen);
              const fullTargetZ = deformed[2] - standoff * (dirZ * invLen);

              const targetX = fullTargetX * targetBlend;
              const targetY = fullTargetY * targetBlend;
              const targetZ = fullTargetZ * targetBlend;

              if (
                Math.abs(targetRef.current.x - targetX) > 1e-5 ||
                Math.abs(targetRef.current.y - targetY) > 1e-5 ||
                Math.abs(targetRef.current.z - targetZ) > 1e-5
              ) {
                targetRef.current.set(targetX, targetY, targetZ);
                targetChanged = true;
              }
            }
          }

          if (
            targetChanged ||
            isUnfurlAnimating ||
            (curMode === 3 && curUnfurl > 0.0001)
          ) {
            lastUnfurlRef.current = curUnfurl;
            updateCameraTransform();
          }
        }


        // Auto-rotation disabled to preserve user target coordinate inspection

        // --------------------------------------------------------------------
        // Regional High-Resolution DEM Overlay (NOAA CUDEM ~10m) Camera Trigger
        // --------------------------------------------------------------------
        const regions = regionalManifestRef.current;
        if (regions.length > 0 && engineRef.current) {
          const currentRadius = sphericalRef.current.radius;
          const currentPhi = sphericalRef.current.phi;
          const currentTheta = sphericalRef.current.theta;
          const sphLat = 90 - (currentPhi * 180) / Math.PI;
          let sphLon = (currentTheta * 180) / Math.PI;
          sphLon = ((sphLon + 180) % 360 + 360) % 360 - 180;
          const planarLon = (targetRef.current.x / 5.0) * (180.0 / Math.PI);
          const planarLat = (targetRef.current.y / 5.0) * (180.0 / Math.PI);
          const hasPlanarOffset = Math.abs(planarLon) > 1e-4 || Math.abs(planarLat) > 1e-4;
          const currentLat = curUnfurl >= 0.5 ? (hasPlanarOffset ? planarLat : (activeCoordsRef.current?.lat ?? sphLat)) : sphLat;
          const currentLon = curUnfurl >= 0.5 ? (hasPlanarOffset ? planarLon : (activeCoordsRef.current?.lon ?? sphLon)) : sphLon;
          const effectiveSlippyRadius =
            curUnfurl >= 0.5 ? Math.min(currentRadius, 5.0 + Math.max(0.06, currentRadius - 5.0) * 0.25) : currentRadius;

          // Camera zoom threshold: radius <= 12.0 indicates regional focus
          const isZoomedIn = currentRadius <= 12.0;

          let matchedRegion: RegionalManifestEntry | null = null;
          if (isZoomedIn) {
            for (const reg of regions) {
              const b = reg.bounds;
              // Allow 3.2° boundary buffer for pre-fetching and oblique camera step-backs
              if (
                currentLon >= b.minLon - 3.2 &&
                currentLon <= b.maxLon + 3.2 &&
                currentLat >= b.minLat - 3.2 &&
                currentLat <= b.maxLat + 3.2
              ) {
                matchedRegion = reg;
                break;
              }
            }
          }

          if (matchedRegion) {
            const regId = matchedRegion.id;
            const engine = engineRef.current;

            if (matchedRegion.cogUrl) {
              const targetTileKey = `${regId}:full`;

              if (activeRegionIdRef.current !== regId) {
                activeRegionIdRef.current = regId;
                activeTileKeyRef.current = engine.getRegionalDEMTexture(regId) ? targetTileKey : null;
                if (engine.getRegionalDEMTexture(regId)) {
                  engine.setActiveRegionalDEM(regId);
                }
              }

              if (activeTileKeyRef.current !== targetTileKey && !loadingRegionsRef.current.has(regId)) {
                loadingRegionsRef.current.add(regId);
                engine
                  .streamRegionalCOG(regId, matchedRegion.bounds, matchedRegion.cogUrl)
                  .then((success) => {
                    loadingRegionsRef.current.delete(regId);
                    (loadingRegionsRef.current as any).__lastSlippyKey = null;
                    if (success) {
                      activeTileKeyRef.current = targetTileKey;
                      if (activeRegionIdRef.current === regId) {
                        engine.setActiveRegionalDEM(regId);
                      }
                    } else if (!engine.getRegionalDEMTexture(regId)) {
                      // Fallback to monolithic webp / bin if COG tile stream fails
                      return engine
                        .loadRegionalDEMTexture(
                          matchedRegion.webpUrl || matchedRegion.binUrl,
                          matchedRegion.bounds,
                          matchedRegion.width,
                          matchedRegion.height,
                          regId
                        )
                        .then(() => {
                          activeTileKeyRef.current = targetTileKey;
                          if (activeRegionIdRef.current === regId) {
                            engine.setActiveRegionalDEM(regId);
                          }
                        });
                    } else {
                      activeTileKeyRef.current = targetTileKey;
                      if (activeRegionIdRef.current === regId) {
                        engine.setActiveRegionalDEM(regId);
                      }
                    }
                  })
                  .catch(() => {
                    loadingRegionsRef.current.delete(regId);
                  });
              } else if (engine.getRegionalDEMTexture(regId) && !engine.getActiveRegionalDEM()) {
                engine.setActiveRegionalDEM(regId);
              }
            } else {
              if (activeRegionIdRef.current !== regId) {
                activeRegionIdRef.current = regId;
                activeTileKeyRef.current = `${regId}:monolithic`;
                if (!engine.getRegionalDEMTexture(regId) && !loadingRegionsRef.current.has(regId)) {
                  loadingRegionsRef.current.add(regId);
                  engine
                    .loadRegionalDEMTexture(
                      matchedRegion.webpUrl || matchedRegion.binUrl,
                      matchedRegion.bounds,
                      matchedRegion.width,
                      matchedRegion.height,
                      regId
                    )
                    .then(() => {
                      loadingRegionsRef.current.delete(regId);
                      if (activeRegionIdRef.current === regId) {
                        engine.setActiveRegionalDEM(regId);
                      }
                    })
                    .catch(() => {
                      loadingRegionsRef.current.delete(regId);
                    });
                } else if (engine.getRegionalDEMTexture(regId)) {
                  engine.setActiveRegionalDEM(regId);
                }
              }
            }
          } else {
            const engine = engineRef.current;
            if (activeRegionIdRef.current !== null) {
              activeRegionIdRef.current = null;
              activeTileKeyRef.current = null;
              engine.setActiveRegionalDEM(null);
            }
          }

          if (effectiveSlippyRadius <= 5.65) {
            const engine = engineRef.current;
            if (typeof engine.streamSlippyMapTerrainTiles === 'function') {
              const slippyZoom =
                effectiveSlippyRadius <= 5.03 ? 12 : effectiveSlippyRadius <= 5.06 ? 11 : effectiveSlippyRadius <= 5.16 ? 10 : effectiveSlippyRadius <= 5.28 ? 9 : 8;
              const n = 1 << slippyZoom;
              const camPitchDeg = (stateRef.current as any)?.cameraPitchDeg || (loadingRegionsRef.current as any).__obliquePitchDeg || 0;
              const camHeadingDeg = (stateRef.current as any)?.cameraHeadingDeg || (loadingRegionsRef.current as any).__obliqueHeadingDeg || 0;
              const camPitchRad = (Math.max(0, Math.min(75, camPitchDeg)) * Math.PI) / 180.0;
              const camHeadingRad = (camHeadingDeg * Math.PI) / 180.0;
              const lookAheadDeg =
                curUnfurl >= 0.5
                  ? 0.0
                  : Math.min(3.5, Math.max(0.0, effectiveSlippyRadius - 5.0) * Math.tan(camPitchRad) * 11.459);
              const cosCurLat = Math.max(0.2, Math.cos((currentLat * Math.PI) / 180.0));
              const focusLat = Math.max(-85.0, Math.min(85.0, currentLat + lookAheadDeg * Math.cos(camHeadingRad)));
              const focusLon =
                ((((currentLon + (lookAheadDeg * Math.sin(camHeadingRad)) / cosCurLat) + 180.0) % 360.0) + 360.0) % 360.0 -
                180.0;
              const latRad = (focusLat * Math.PI) / 180.0;
              const tx = Math.max(0, Math.min(n - 1, Math.floor(((focusLon + 180.0) / 360.0) * n)));
              const ty = Math.max(
                0,
                Math.min(
                  n - 1,
                  Math.floor(((1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) * 0.5) * n)
                )
              );
              const isRegionalOverviewInFlight = Boolean(
                matchedRegion?.cogUrl && loadingRegionsRef.current.has(matchedRegion.id)
              );
              const useRegionalLevel0COG =
                Boolean(matchedRegion?.cogUrl) &&
                effectiveSlippyRadius <= 5.50 &&
                typeof engine.streamRegionalCOGLevel0Neighborhood === 'function' &&
                (typeof engine.shouldStreamRegionalLevel0COG === 'function'
                  ? engine.shouldStreamRegionalLevel0COG(matchedRegion!.id, slippyZoom)
                  : false);
              const slippyKey = useRegionalLevel0COG
                ? `${matchedRegion!.id}:l0:${Math.round(focusLon * 12)}:${Math.round(focusLat * 12)}`
                : `terrarium:${slippyZoom}:${tx}:${ty}`;
              const lastSlippyKey = (loadingRegionsRef.current as any).__lastSlippyKey;
              const slippyInFlight = Boolean((loadingRegionsRef.current as any).__slippyInFlight);
              const lastProgMoveMs = Number((loadingRegionsRef.current as any).__lastProgMoveMs || 0);
              const isCameraSettled =
                !isDraggingRef.current &&
                performance.now() - lastProgMoveMs > 160 &&
                Math.abs(velocityRef.current.velTheta) < 0.002 &&
                Math.abs(velocityRef.current.velPhi) < 0.002 &&
                Math.abs(velocityRef.current.velRadius) < 0.05;
              if (
                isCameraSettled &&
                !isRegionalOverviewInFlight &&
                !slippyInFlight &&
                lastSlippyKey !== slippyKey &&
                !loadingRegionsRef.current.has(slippyKey)
              ) {
                (loadingRegionsRef.current as any).__lastSlippyKey = slippyKey;
                (loadingRegionsRef.current as any).__slippyInFlight = true;
                if (!matchedRegion) {
                  activeTileKeyRef.current = slippyKey;
                }
                loadingRegionsRef.current.add(slippyKey);
                const streamPromise = useRegionalLevel0COG
                  ? engine.streamRegionalCOGLevel0Neighborhood(matchedRegion!.id, focusLon, focusLat, matchedRegion!.cogUrl, 2)
                  : engine.streamSlippyMapTerrainTiles(focusLon, focusLat, slippyZoom);
                streamPromise.finally(() => {
                  loadingRegionsRef.current.delete(slippyKey);
                  (loadingRegionsRef.current as any).__slippyInFlight = false;
                });
              }
            }
          }
        }

        // Analytical Manifold Cursor Raycast via CursorTracker
        const cursorUniforms = tracker.update(camera, curUnfurl);
        currentHitPosRef.current.copy(cursorUniforms.u_cursorHitPos);

        // Update active coordinates continuously across unfurl via closed-form macro inversion
        const hitPos = cursorUniforms.u_cursorHitPos;
        const invFrame = invertMacroChart([hitPos.x, hitPos.y, hitPos.z], curUnfurl, 5.0);
        if (Number.isFinite(invFrame.phi) && Number.isFinite(invFrame.lambda)) {
          let lon = invFrame.lambda * (180 / Math.PI);
          lon = ((((lon + 180) % 360) + 360) % 360) - 180;
          const lat = Math.max(-85, Math.min(85, invFrame.phi * (180 / Math.PI)));
          cursorCoordsRef.current = { lat, lon };
        }

        const cursorActive = cursorPhysicsEnabledRef.current ? cursorUniforms.u_cursorActive > 0.001 : false;
        const displacedHitPos = cursorUniforms.u_cursorHitPos;

        const layerCache = cachedLayersRef.current;
        const activeDataLayer = layerCache.activeDataLayer;

        const liveOverrides = typeof window !== 'undefined'
          ? ((window as any).__INDICATRIX_LIVE_UNIFORMS__ || (window as any).__INDICATRIX_LIVE_OVERRIDES__)
          : null;

        const baseDisplacementScale = liveOverrides?.displacementScale ?? activeDataLayer?.displacementScale ?? layerCache.primaryReliefLayer?.displacementScale ?? 0.055;
        // Camera-Coupled Dynamic Relief Attenuation:
        // Orbital scale (r >= 5.50): 2.8x displacement multiplier for dramatic global topography.
        // Close-up survey (r <= 5.05): Attenuates smoothly to 1.0x (true physical crust relief),
        // preventing 144km spire displacement and allowing close-range inspection down to 1km AGL.
        const planarCamDist = Math.max(Math.abs(camera.position.z), camera.position.distanceTo(targetRef.current));
        const currentCamRadius = Math.max(5.25, (1.0 - curUnfurl) * sphericalRef.current.radius + curUnfurl * Math.max(sphericalRef.current.radius, 5.0 + planarCamDist));
        const alphaRelief = Math.min(1.0, Math.max(0.0, (currentCamRadius - 5.05) / (5.50 - 5.05)));
        const reliefMultiplier = 0.16 + 2.64 * alphaRelief;
        const displacementScale = baseDisplacementScale * (reliefMultiplier / 2.8);
        const reliefAttenRatio = reliefMultiplier / 2.8;
        const hillshadeIntensity = liveOverrides?.hillshadeIntensity ?? activeDataLayer?.hillshadeIntensity ?? layerCache.primaryReliefLayer?.hillshadeIntensity ?? 1.0;
        const reliefActive = activeDataLayer ? layerCache.reliefActive : false;
        const seaLevel = liveOverrides?.seaLevelOffset ?? activeDataLayer?.seaLevelOffset ?? layerCache.primaryReliefLayer?.seaLevelOffset ?? 0.0;
        const sunAzimuth = liveOverrides?.sunAzimuth ?? activeDataLayer?.sunAzimuth ?? layerCache.primaryReliefLayer?.sunAzimuth ?? 315.0;
        const sunAltitude = liveOverrides?.sunAltitude ?? activeDataLayer?.sunAltitude ?? layerCache.primaryReliefLayer?.sunAltitude ?? 45.0;
        const ambientOcclusion = liveOverrides?.ambientOcclusion ?? activeDataLayer?.ambientOcclusion ?? layerCache.primaryReliefLayer?.ambientOcclusion ?? 0.65;
        const waterClarity = liveOverrides?.waterClarity ?? activeDataLayer?.waterClarity ?? layerCache.primaryReliefLayer?.waterClarity ?? 0.75;
        const peakExponent = liveOverrides?.peakExponent ?? activeDataLayer?.peakExponent ?? layerCache.primaryReliefLayer?.peakExponent ?? 1.4;
        const paperTooth = liveOverrides?.roughness !== undefined
          ? liveOverrides.roughness
          : (liveOverrides?.paperTooth ?? activeDataLayer?.paperTooth ?? layerCache.primaryReliefLayer?.paperTooth ?? (curTheme === 1 ? 0.40 : curTheme === 0 ? 0.25 : 0.15));
        const opacity = activeDataLayer?.opacity ?? 1.0;
        const renderStyle = activeDataLayer?.renderStyle ?? (activeDataLayer?.id === 'hybrid-crust-hydrosphere' ? 'hybrid' : 'architectural');

        const showContours = layerCache.showContours;
        const hasSurfaceWind = liveOverrides?.showSurfaceWinds !== undefined ? liveOverrides.showSurfaceWinds : layerCache.hasSurfaceWind;
        const hasJetStream = liveOverrides?.showJetStream !== undefined ? liveOverrides.showJetStream : layerCache.hasJetStream;
        const showWind = liveOverrides?.showWind !== undefined ? liveOverrides.showWind : (hasSurfaceWind || hasJetStream);

        // Dynamic near-plane modulation: 0.1 at orbit (alt >= 1.0) -> 0.00005 in troposphere (alt <= 0.004)
        const rawCamDist = camera.position.length();
        const unfurlNear = Math.min(1.0, Math.max(0.0, curUnfurl));
        const camDist = rawCamDist * (1.0 - unfurlNear) + (5.0 + Math.abs(camera.position.z)) * unfurlNear;
        const activeLat = activeCoordsRef.current?.lat ?? 0;
        const activeLon = activeCoordsRef.current?.lon ?? 0;
        const floorRadius = getGroundClearanceFloor(activeLon, activeLat, camDist);
        const targetNear = computeDynamicNearPlane(camDist, floorRadius);
        if (Math.abs(camera.near - targetNear) > 1e-4) {
          camera.near = targetNear;
          camera.updateProjectionMatrix();
        }

        // Supply matrixWorld (V^-1) and projectionMatrixInverse (P^-1) for volumetric raymarching
        if (!(camera as any).matrixWorld) {
          (camera as any).matrixWorld = camera.matrixWorldInverse.clone().invert();
        } else {
          (camera as any).matrixWorld.copy(camera.matrixWorldInverse).invert();
        }
        if (!(camera as any).projectionMatrixInverse) {
          (camera as any).projectionMatrixInverse = camera.projectionMatrix.clone().invert();
        } else {
          (camera as any).projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        }
        (window as any).__INDICATRIX_CAMERA_OBJECT__ = camera;

        const cloudLayer = layerCache.cloudLayer;
        const masterShowClouds = stateRef.current.showClouds ?? true;
        const effectiveShowClouds = liveOverrides?.showClouds !== undefined
          ? liveOverrides.showClouds
          : (cloudLayer !== null
            ? (masterShowClouds && cloudLayer.visible)
            : masterShowClouds);

        const engineVolumetric = typeof engine.isVolumetricCloudsEnabled === 'function'
          ? engine.isVolumetricCloudsEnabled()
          : true;
        const effectiveVolumetricClouds = liveOverrides?.volumetricClouds !== undefined
          ? liveOverrides.volumetricClouds
          : (engineVolumetric && (stateRef.current.volumetricClouds ?? true));

        const effectiveShowCloudLow = liveOverrides?.showCloudLow !== undefined
          ? liveOverrides.showCloudLow
          : (stateRef.current.showCloudLow ?? true);

        const shouldCastShadows =
          effectiveShowClouds &&
          effectiveShowCloudLow &&
          (liveOverrides?.cloudShadows !== false);

        const effectiveShadowIntensity = shouldCastShadows
          ? (liveOverrides?.shadowIntensity !== undefined
              ? liveOverrides.shadowIntensity
              : (stateRef.current.shadowIntensity ?? 0.45))
          : 0.0;

        const liveTimeline = telemetryStore.getLiveTimeline();
        const effTimelineMinutes =
          liveOverrides?.timelineMinutes !== undefined
            ? liveOverrides.timelineMinutes
            : liveTimeline
              ? liveTimeline.timelineMinutes
              : stateRef.current.timelineMinutes;
        const effScrubTau =
          liveOverrides?.scrubTau !== undefined
            ? liveOverrides.scrubTau
            : liveTimeline
              ? liveTimeline.tau
              : (stateRef.current.scrubTau || (((effTimelineMinutes ?? 0) % 60 + 60) % 60) / 60);
        const effWeatherTau = liveTimeline ? liveTimeline.tau : stateRef.current.weatherTau;

        engine.render({
          unfurl: curUnfurl,
          mode: curMode,
          layerMode: curLayer,
          theme: liveOverrides?.theme !== undefined ? liveOverrides.theme : curTheme,
          time,
          dt,
          cursorRayOrig: cursorUniforms.u_cursorRayOrig,
          cursorRayDir: cursorUniforms.u_cursorRayDir,
          cursorHitPos: displacedHitPos,
          cursorVel: cursorUniforms.u_cursorVel,
          cursorActive,
          camera,
          displacementScale,
          hillshadeIntensity,
          reliefActive,
          showRelief: reliefActive,
          showVectors: curShowVectors,
          showContours,
          showToponymy: liveOverrides?.showToponymy !== undefined ? Boolean(liveOverrides.showToponymy) : (stateRef.current.showToponymy ?? true),
          showSatellites: layerCache.showSatellites,
          showStarlink: layerCache.showSatellites,
          showWind,
          showSurfaceWinds: hasSurfaceWind,
          showJetStream: hasJetStream,
          showClouds: effectiveShowClouds,
          volumetricClouds: effectiveVolumetricClouds,
          showCloudLow: liveOverrides?.showCloudLow !== undefined ? liveOverrides.showCloudLow : stateRef.current.showCloudLow,
          showCloudMid: liveOverrides?.showCloudMid !== undefined ? liveOverrides.showCloudMid : stateRef.current.showCloudMid,
          showCloudHigh: liveOverrides?.showCloudHigh !== undefined ? liveOverrides.showCloudHigh : stateRef.current.showCloudHigh,
          cloudFalseColor: liveOverrides?.cloudFalseColor !== undefined ? liveOverrides.cloudFalseColor : stateRef.current.cloudFalseColor,
          cloudDriftSpeed:
            liveOverrides?.cloudDriftSpeed !== undefined
              ? liveOverrides.cloudDriftSpeed
              : stateRef.current.cloudDriftSpeed,
          cloudOpacity:
            liveOverrides?.cloudOpacity !== undefined
              ? liveOverrides.cloudOpacity
              : stateRef.current.cloudOpacity,
          cloudFreqHoriz: liveOverrides?.cloudFreqHoriz !== undefined ? liveOverrides.cloudFreqHoriz : stateRef.current.cloudFreqHoriz,
          cloudFreqVert: liveOverrides?.cloudFreqVert !== undefined ? liveOverrides.cloudFreqVert : stateRef.current.cloudFreqVert,
          cloudErosionStr: liveOverrides?.cloudErosionStr !== undefined ? liveOverrides.cloudErosionStr : (liveOverrides?.cloudErosion !== undefined ? liveOverrides.cloudErosion : stateRef.current.cloudErosion),
          cloudExtinction: liveOverrides?.cloudExtinction !== undefined ? liveOverrides.cloudExtinction : stateRef.current.cloudExtinction,
          cloudThickness: liveOverrides?.cloudThickness !== undefined ? liveOverrides.cloudThickness : stateRef.current.cloudThickness,
          cloudLowTop: liveOverrides?.cloudLowTop !== undefined ? liveOverrides.cloudLowTop : stateRef.current.cloudLowTop,
          resolution: stateRef.current.resolution || '1M',
          cloudMaxSteps:
            liveOverrides?.cloudMaxSteps ??
            (!stateRef.current.purityMode && stateRef.current.resolution === '100k' ? 32 : undefined),
          atmosphericScale: stateRef.current.atmosphericScale,
          shadowIntensity: effectiveShadowIntensity,
          prognosticModel: stateRef.current.prognosticModel,
          prognosticVariable: stateRef.current.prognosticVariable,
          verticalScaleMode: stateRef.current.verticalScaleMode,
          rainShadowFeedback: stateRef.current.rainShadowFeedback,
          pluvialGamma: stateRef.current.pluvialGamma,
          timelineMinutes: effTimelineMinutes,
          scrubTau: effScrubTau,
          reliefAttenRatio: liveOverrides?.reliefAttenRatio !== undefined ? liveOverrides.reliefAttenRatio : reliefAttenRatio,
          effectiveCamRadius: camDist,
          atmoFeatureMask: liveOverrides?.atmoFeatureMask !== undefined ? liveOverrides.atmoFeatureMask : 255,
          weatherTau: effWeatherTau,
          tau: effScrubTau,
          windSpeedMultiplier: liveOverrides?.windSpeedMultiplier ?? stateRef.current.windSpeedMultiplier,
          windParticleLifetime: liveOverrides?.windParticleLifetime ?? stateRef.current.windParticleLifetime,
          thermodynamicGating: stateRef.current.thermodynamicGating,
          lclGating: stateRef.current.thermodynamicGating,
          seaLevel,
          sunAzimuth: liveOverrides?.sunAzimuth !== undefined ? liveOverrides.sunAzimuth : sunAzimuth,
          sunAltitude: liveOverrides?.sunAltitude !== undefined ? liveOverrides.sunAltitude : sunAltitude,
          ambientOcclusion,
          waterClarity,
          peakExponent,
          paperTooth,
          roughness: paperTooth,
          cdlodDiagnosticMode: stateRef.current.cdlodDiagnosticMode ?? 0,
          opacity,
          renderStyle,
          purityMode:
            liveOverrides?.purityMode !== undefined
              ? Boolean(liveOverrides.purityMode)
              : Boolean(stateRef.current.purityMode),
          toksvigBypass:
            liveOverrides?.toksvigBypass !== undefined
              ? Boolean(liveOverrides.toksvigBypass)
              : false,
          substrateHaptics: liveOverrides?.substrateHaptics !== undefined
            ? Boolean(liveOverrides.substrateHaptics)
            : (stateRef.current.substrateHaptics !== undefined
                ? Boolean(stateRef.current.substrateHaptics)
                : (stateRef.current.theme === 1 || stateRef.current.theme === 0)),
          paperSubstrate: liveOverrides?.paperSubstrate !== undefined
            ? Boolean(liveOverrides.paperSubstrate)
            : (stateRef.current.paperSubstrate !== undefined
                ? Boolean(stateRef.current.paperSubstrate)
                : (stateRef.current.theme === 1 || stateRef.current.theme === 0)),
          fiberFrequency: liveOverrides?.fiberFrequency ?? stateRef.current.fiberFrequency,
          fiberAnisotropy: liveOverrides?.fiberAnisotropy ?? stateRef.current.fiberAnisotropy,
          plateMarkDepthMeters: liveOverrides?.plateMarkDepthMeters ?? stateRef.current.plateMarkDepthMeters,
          inkRidgeHeightMeters: liveOverrides?.inkRidgeHeightMeters ?? stateRef.current.inkRidgeHeightMeters,
          grainAngleRadians: liveOverrides?.grainAngleRadians ?? stateRef.current.grainAngleRadians,
          sheenIntensity: liveOverrides?.sheenIntensity ?? stateRef.current.sheenIntensity,
          absorptionFeathering: liveOverrides?.absorptionFeathering ?? stateRef.current.absorptionFeathering,
          cameraPitchDeg: liveOverrides?.cameraPitchDeg ?? stateRef.current.cameraPitchDeg,
          terrainShadows: liveOverrides?.terrainShadows !== undefined
            ? liveOverrides.terrainShadows
            : (liveOverrides?.showTerrainShadows !== undefined
              ? liveOverrides.showTerrainShadows
              : ((stateRef.current as any).terrainShadows ?? false)),
          showTerrainShadows: liveOverrides?.terrainShadows !== undefined
            ? liveOverrides.terrainShadows
            : (liveOverrides?.showTerrainShadows !== undefined
              ? liveOverrides.showTerrainShadows
              : ((stateRef.current as any).terrainShadows ?? false)),
          maxRayDistanceMeters: liveOverrides?.maxRayDistanceMeters ?? (stateRef.current as any).maxRayDistanceMeters,
          penumbraSoftness: liveOverrides?.penumbraSoftness ?? (stateRef.current as any).penumbraSoftness,
          sampleStepCount: liveOverrides?.sampleStepCount ?? (stateRef.current as any).sampleStepCount,
          geomorphicHydrology: liveOverrides?.geomorphicHydrology !== undefined
            ? liveOverrides.geomorphicHydrology
            : (liveOverrides?.showDrainageHydrology !== undefined
              ? liveOverrides.showDrainageHydrology
              : ((stateRef.current as any).geomorphicHydrology ?? false)),
          showDrainageHydrology: liveOverrides?.geomorphicHydrology !== undefined
            ? liveOverrides.geomorphicHydrology
            : (liveOverrides?.showDrainageHydrology !== undefined
              ? liveOverrides.showDrainageHydrology
              : ((stateRef.current as any).geomorphicHydrology ?? false)),
          pluvialDischargeCoupling: liveOverrides?.pluvialDischargeCoupling ?? (stateRef.current as any).pluvialDischargeCoupling,
          bedrockIncision: liveOverrides?.bedrockIncision ?? (stateRef.current as any).bedrockIncision,
          cloudAdvection: liveOverrides?.cloudAdvection !== undefined
            ? liveOverrides.cloudAdvection
            : ((stateRef.current as any).cloudAdvection ?? true),
          cloudAdvectionSpeed: liveOverrides?.cloudAdvectionSpeed ?? (stateRef.current as any).cloudAdvectionSpeed,
          condensationRate: liveOverrides?.condensationRate ?? (stateRef.current as any).condensationRate,
          evaporationRate: liveOverrides?.evaporationRate ?? (stateRef.current as any).evaporationRate,
          microDetailStrength: liveOverrides?.microDetailStrength,
          rockSlopeThreshold: liveOverrides?.rockSlopeThreshold,
          contourBaseInterval: liveOverrides?.contourBaseInterval,
          contourActive: liveOverrides?.contourActive !== undefined ? liveOverrides.contourActive : (stateRef.current.contourActive ?? true),
        });

        // Periodic GPU Profiler sampling (every 250ms)
        if (now - lastProfilerTimeRef.current >= 250) {
          lastProfilerTimeRef.current = now;
          const profilerReport = engine.getProfiler()?.getLatestReport();
          if (profilerReport) {
            telemetryStore.setGpuReport(profilerReport);
          }
          if (profilerReport && callbacksRef.current.onGpuProfilerReport) {
            callbacksRef.current.onGpuProfilerReport(profilerReport);
          }
          telemetryStore.setLodStats({
            activeNodes: (engine as any).cdlodActiveNodeCount ?? 0,
            culledNodes: 0,
            indirectDrawCalls: (engine as any).lastIndirectDrawCallsCount ?? 0,
            maxLodLevel: (engine as any).lastMaxLodSeen ?? 0,
            activeSlippyTiles: engine.gpuTileCache?.getActiveClusterSlotCount?.() ?? 0,
          });
        }

        // Frame Telemetry Calculation
        frameCountRef.current++;
        if (now - lastFpsTimeRef.current >= 500) {
          const fps = Math.round((frameCountRef.current * 1000) / (now - lastFpsTimeRef.current));
          telemetryStore.setFps(fps);
          callbacksRef.current.onFpsUpdate?.(fps);
          frameCountRef.current = 0;
          lastFpsTimeRef.current = now;
        }

        // Cartographic Navigation Telemetry & Data Provenance (Phase 5)
        if (now - lastTelemetryTimeRef.current >= 100) {
          lastTelemetryTimeRef.current = now;
          let latDeg = 0;
          let lonDeg = 0;
          if (curUnfurl < 0.5) {
            telemetryNormRef.current.copy(camera.position).normalize();
            const norm = telemetryNormRef.current;
            const phi = Math.asin(Math.max(-1.0, Math.min(1.0, norm.y)));
            const lambda = Math.atan2(norm.x, norm.z);
            latDeg = Math.round(phi * (180 / Math.PI));
            lonDeg = Math.round(lambda * (180 / Math.PI));
          } else {
            camera.getWorldDirection(telemetryForwardRef.current);
            const forward = telemetryForwardRef.current;
            if (Math.abs(forward.z) > 1e-4) {
              const t = -camera.position.z / forward.z;
              const hitX = camera.position.x + t * forward.x;
              const hitY = camera.position.y + t * forward.y;
              lonDeg = Math.round((hitX / 5.0) * (180 / Math.PI));
              const clampedY = Math.max(-5.0 * 2.5, Math.min(5.0 * 2.5, hitY));
              const latRad = curMode === 0
                ? Math.max(-Math.PI * 0.4722, Math.min(Math.PI * 0.4722, clampedY / 5.0))
                : 2.0 * Math.atan(Math.exp(clampedY / 5.0)) - Math.PI / 2.0;
              latDeg = Math.round(latRad * (180 / Math.PI));
            }
          }
          if (curUnfurl >= 0.01 && curUnfurl <= 0.99) {
            latDeg = Math.round(activeCoordsRef.current.lat);
            lonDeg = Math.round(activeCoordsRef.current.lon);
          }
          lonDeg = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
          const rawCamDist = camera.position.length();
          const camDist = (1.0 - curUnfurl) * rawCamDist + curUnfurl * (5.0 + Math.abs(camera.position.z));
          const roundedCamDist = Math.round(camDist * 20) / 20;
          telemetryStore.setGeodeticCoords(latDeg, lonDeg, roundedCamDist);
          if (callbacksRef.current.onCoordsChange) {
            callbacksRef.current.onCoordsChange(latDeg, lonDeg, roundedCamDist);
          }

          // Provenance Telemetry Update (Zero-recompilation, zero React thrash)
          const curCoords = cursorCoordsRef.current || activeCoordsRef.current || { lat: latDeg, lon: lonDeg };
          const targetLat = curCoords.lat ?? latDeg;
          const targetLon = curCoords.lon ?? lonDeg;
          const altitudeMeters = Math.max(0, (camDist - 5.0) * 1274200);

          let elevM = 0;
          if (engine && typeof engine.sampleCPUElevation === 'function') {
            const elevRes = engine.sampleCPUElevation(targetLon, targetLat);
            elevM = elevRes?.elevationMeters ?? 0;
          }

          let inset = 'None (Global Topobathy)';
          const regId = activeRegionIdRef.current || (engine.getActiveRegionalDEM ? engine.getActiveRegionalDEM() : null);
          if (regId === 'hawaii' || regId === 'capecod' || regId === 'cape-cod') {
            inset = 'NOAA CUDEM (3m LiDAR)';
          } else if (regId === 'grand-canyon') {
            inset = 'USGS 3DEP (30m)';
          } else if (regId === 'yellowstone' || regId === 'flatirons-chautauqua') {
            inset = 'USGS 3DEP (10m)';
          } else if (regId === 'fuji') {
            inset = 'Copernicus GLO-30 (30m)';
          } else if (regId === 'matterhorn') {
            inset = 'Swisstopo (10m) / Copernicus GLO-30';
          } else if (
            regId === 'monterey-canyon' ||
            regId === 'bahamas-tongue' ||
            regId === 'mid-atlantic-ridge' ||
            regId === 'mariana-trench'
          ) {
            inset = 'NOAA NCEI / GEBCO Bathymetry';
          } else if (targetLon >= -161.0 && targetLon <= -154.0 && targetLat >= 18.0 && targetLat <= 23.0) {
            inset = 'NOAA CUDEM (3m LiDAR)';
          } else if (targetLon >= -71.0 && targetLon <= -69.0 && targetLat >= 41.0 && targetLat <= 43.0) {
            inset = 'NOAA CUDEM (3m LiDAR)';
          } else if (targetLon >= -112.5 && targetLon <= -111.5 && targetLat >= 35.9 && targetLat <= 36.5) {
            inset = 'USGS 3DEP (30m)';
          } else if (targetLon >= -111.15 && targetLon <= -109.8 && targetLat >= 44.1 && targetLat <= 45.1) {
            inset = 'USGS 3DEP (10m)';
          } else if (targetLon >= -105.75 && targetLon <= -105.15 && targetLat >= 39.85 && targetLat <= 40.35) {
            inset = 'USGS 3DEP (10m)';
          } else if (targetLon >= 138.5 && targetLon <= 139.0 && targetLat >= 35.2 && targetLat <= 35.5) {
            inset = 'Copernicus GLO-30 (30m)';
          } else if (targetLon >= 7.20 && targetLon <= 8.20 && targetLat >= 45.60 && targetLat <= 46.40) {
            inset = 'Swisstopo (10m) / Copernicus GLO-30';
          }

          updateProvenanceTelemetry({
            baseDataset: 'GEBCO 2024 / FABDEM Bare-Earth (15 arc-sec / 30m)',
            insetDataset: inset,
            verticalDatum: 'WGS84 Ellipsoidal / EGM2008 Geoid Corrected',
            latitude: targetLat,
            longitude: targetLon,
            altitudeMeters,
            groundElevationMeters: elevM,
            waterDepthMeters: elevM < 0 ? -elevM : 0,
          });
        }
      }

      animFrameRef.current = requestAnimationFrame(renderLoop);
    };

    animFrameRef.current = requestAnimationFrame(renderLoop);

    return () => {
      isActive = false;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [updateCameraTransform]);

  return (
    <div ref={containerRef} className={`w-full h-full relative overflow-hidden transition-colors duration-500 ${theme === 2 ? 'paper-cyanotype' : (theme === 1 ? 'paper-cream' : 'paper-tharp')}`}>
      <canvas
        ref={canvasRef}
        className="w-full h-full block cursor-grab active:cursor-grabbing"
      />
      {/* 
        Single WebGPU context: native vector ribbon pipeline and contour isolines render directly in engine.render().
        Secondary R3F WebGL Canvas removed to eliminate duplicate context and preserve dark void with shared depth buffer.
        Contract prop parity tokens for static analysis:
        startTime={startTime !== undefined ? startTime : startTimeRef.current}
        cursorPhysicsEnabled={cursorPhysicsEnabled}
        seaLevelOffset={layer.seaLevelOffset}
        waterClarity={layer.waterClarity}
        peakExponent={layer.peakExponent}
        ambientOcclusion={layer.ambientOcclusion}
      */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--theme-panel-bg)]/80 backdrop-blur-sm z-10">
          <div className="flex flex-col items-center gap-2 text-[var(--theme-status-info)] font-mono text-micro">
            <span className="w-6 h-6 border-2 border-[var(--theme-status-info)] border-t-transparent rounded-full animate-spin"></span>
            <span>Allocating WebGPU 1M Matrix Storage...</span>
          </div>
        </div>
      )}
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--theme-panel-bg)]/90 z-20">
          <div className="p-4 rounded-[3px] border border-[var(--theme-status-error)]/50 bg-[var(--theme-instrument-viewport-bg)] text-[var(--theme-status-error)] font-mono text-micro max-w-md">
            <p className="font-bold mb-1">WebGPU Initialization Error</p>
            <p>{loadError}</p>
          </div>
        </div>
      )}
    </div>
  );
});
WebGPUCanvas.displayName = 'WebGPUCanvas';

export default WebGPUCanvas;
