import React, { useState, useCallback } from 'react';
import { PolarSunCompass } from '../instruments/PolarSunCompass';
import { HypsometricReliefCurve } from '../instruments/HypsometricReliefCurve';
import { BathymetricTideGauge } from '../instruments/BathymetricTideGauge';
import { TactileSwitch } from '../../ui/TactileSwitch';
import { VernierSlider } from '../../ui/VernierSlider';
import type { DataLayerItem } from '../UnifiedRightSidebar';

export interface CrustHydrosphereTabProps {
  theme: 0 | 1 | 2;
  isLight: boolean;
  primaryLayer?: DataLayerItem;
  primaryLayerId: string;
  onHillshadeChangeDataLayer?: (id: string, azimuth: number, intensity: number, altitude?: number) => void;
  onDisplacementScaleChangeDataLayer?: (id: string, scale: number) => void;
  onPeakExponentChangeDataLayer?: (id: string, exponent: number) => void;
  onAmbientOcclusionChangeDataLayer?: (id: string, ao: number) => void;
  onSeaLevelOffsetChangeDataLayer?: (id: string, offset: number) => void;
  onWaterClarityChangeDataLayer?: (id: string, clarity: number) => void;
  showVectors: boolean;
  onVectorsToggle: () => void;
  terrainShadows?: boolean;
  onTerrainShadowsToggle?: () => void;
  onTerrainShadowsChange?: (enabled: boolean) => void;
  penumbraSoftness?: number;
  onPenumbraSoftnessChange?: (softness: number) => void;
  geomorphicHydrology?: boolean;
  onGeomorphicHydrologyToggle?: () => void;
  onGeomorphicHydrologyChange?: (enabled: boolean) => void;
  pluvialDischargeCoupling?: number;
  onPluvialDischargeCouplingChange?: (val: number) => void;
  bedrockIncision?: number;
  onBedrockIncisionChange?: (val: number) => void;
  showToponymy?: boolean;
  onToponymyToggle?: () => void;
  onToponymyChange?: (enabled: boolean) => void;
  contourActive?: boolean;
  onContourActiveChange?: (enabled: boolean) => void;
  xdrSolarGlint?: boolean;
  onXdrSolarGlintChange?: (enabled: boolean) => void;
}

export const CrustHydrosphereTab: React.FC<CrustHydrosphereTabProps> = ({
  theme,
  isLight,
  primaryLayer,
  primaryLayerId,
  onHillshadeChangeDataLayer,
  onDisplacementScaleChangeDataLayer,
  onPeakExponentChangeDataLayer,
  onAmbientOcclusionChangeDataLayer,
  onSeaLevelOffsetChangeDataLayer,
  onWaterClarityChangeDataLayer,
  showVectors,
  onVectorsToggle,
  terrainShadows: propTerrainShadows,
  onTerrainShadowsToggle,
  onTerrainShadowsChange,
  penumbraSoftness: propPenumbraSoftness,
  onPenumbraSoftnessChange,
  geomorphicHydrology: propGeomorphicHydrology,
  onGeomorphicHydrologyToggle,
  onGeomorphicHydrologyChange,
  pluvialDischargeCoupling: propPluvialDischargeCoupling,
  onPluvialDischargeCouplingChange,
  bedrockIncision: propBedrockIncision,
  onBedrockIncisionChange,
  showToponymy: propShowToponymy,
  onToponymyToggle,
  onToponymyChange,
  contourActive: propContourActive,
  onContourActiveChange,
  xdrSolarGlint: propXdrSolarGlint,
  onXdrSolarGlintChange,
}) => {
  const [internalTerrainShadows, setInternalTerrainShadows] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__;
      if (live?.terrainShadows !== undefined) return Boolean(live.terrainShadows);
      if (live?.showTerrainShadows !== undefined) return Boolean(live.showTerrainShadows);
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine && typeof engine.isTerrainShadowsEnabled === 'function') {
        return engine.isTerrainShadowsEnabled();
      }
    }
    return false;
  });

  const [internalPenumbraSoftness, setInternalPenumbraSoftness] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__;
      if (live?.penumbraSoftness !== undefined) return live.penumbraSoftness;
    }
    return 1.5;
  });

  const activeTerrainShadows = propTerrainShadows !== undefined ? propTerrainShadows : internalTerrainShadows;
  const activePenumbraSoftness = propPenumbraSoftness !== undefined ? propPenumbraSoftness : internalPenumbraSoftness;

  const [internalContourActive, setInternalContourActive] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__;
      if (live?.contourActive !== undefined) return Boolean(live.contourActive);
    }
    return true;
  });

  const activeContourActive = propContourActive !== undefined ? propContourActive : internalContourActive;

  const handleToggleContours = useCallback((nextVal?: boolean) => {
    const val = nextVal !== undefined ? nextVal : !activeContourActive;
    setInternalContourActive(val);
    onContourActiveChange?.(val);
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
      live.contourActive = val;
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__ || (window as any).__ENGINE;
      if (engine && typeof engine.updateGeomorphicMicroUniforms === 'function') {
        engine.updateGeomorphicMicroUniforms({ contourActive: val });
      }
    }
  }, [activeContourActive, onContourActiveChange]);

  const [internalShowToponymy, setInternalShowToponymy] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__;
      if (live?.showToponymy !== undefined) return Boolean(live.showToponymy);
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine && typeof engine.isToponymyEnabled === 'function') {
        return engine.isToponymyEnabled();
      }
    }
    return true;
  });

  const activeShowToponymy = propShowToponymy !== undefined ? propShowToponymy : internalShowToponymy;

  const handleToggleToponymy = useCallback((nextVal?: boolean) => {
    const val = nextVal !== undefined ? nextVal : !activeShowToponymy;
    setInternalShowToponymy(val);
    if (onToponymyChange) {
      onToponymyChange(val);
    } else if (onToponymyToggle) {
      onToponymyToggle();
    }
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
      live.showToponymy = val;
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine && typeof engine.setShowToponymy === 'function') {
        engine.setShowToponymy(val);
      }
    }
  }, [activeShowToponymy, onToponymyChange, onToponymyToggle]);

  const handleToggleTerrainShadows = useCallback((nextVal?: boolean) => {
    const val = nextVal !== undefined ? nextVal : !activeTerrainShadows;
    setInternalTerrainShadows(val);
    if (onTerrainShadowsChange) {
      onTerrainShadowsChange(val);
    } else if (onTerrainShadowsToggle) {
      onTerrainShadowsToggle();
    }
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
      live.terrainShadows = val;
      live.showTerrainShadows = val;
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine) {
        if (typeof engine.setTerrainShadowsEnabled === 'function') {
          engine.setTerrainShadowsEnabled(val);
        }
        if (typeof engine.updateTerrainShadowUniforms === 'function') {
          engine.updateTerrainShadowUniforms({
            penumbraSoftness: activePenumbraSoftness,
          });
        }
      }
    }
  }, [activeTerrainShadows, activePenumbraSoftness, onTerrainShadowsChange, onTerrainShadowsToggle]);

  const handlePenumbraSoftnessChange = useCallback((val: number) => {
    setInternalPenumbraSoftness(val);
    onPenumbraSoftnessChange?.(val);
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
      live.penumbraSoftness = val;
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine && typeof engine.updateTerrainShadowUniforms === 'function') {
        engine.updateTerrainShadowUniforms({
          penumbraSoftness: val,
        });
      }
    }
  }, [onPenumbraSoftnessChange]);

  const [internalGeomorphicHydrology, setInternalGeomorphicHydrology] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__;
      if (live?.geomorphicHydrology !== undefined) return Boolean(live.geomorphicHydrology);
      if (live?.showDrainageHydrology !== undefined) return Boolean(live.showDrainageHydrology);
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine && typeof engine.isDrainageHydrologyEnabled === 'function') {
        return engine.isDrainageHydrologyEnabled();
      }
    }
    return false;
  });

  const [internalPluvialDischargeCoupling, setInternalPluvialDischargeCoupling] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__;
      if (live?.pluvialDischargeCoupling !== undefined) return live.pluvialDischargeCoupling;
    }
    return 1.0;
  });

  const [internalBedrockIncision, setInternalBedrockIncision] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__;
      if (live?.bedrockIncision !== undefined) return live.bedrockIncision;
    }
    return 1.0;
  });

  const activeGeomorphicHydrology = propGeomorphicHydrology !== undefined ? propGeomorphicHydrology : internalGeomorphicHydrology;
  const activePluvialDischargeCoupling = propPluvialDischargeCoupling !== undefined ? propPluvialDischargeCoupling : internalPluvialDischargeCoupling;
  const activeBedrockIncision = propBedrockIncision !== undefined ? propBedrockIncision : internalBedrockIncision;

  const handleToggleGeomorphicHydrology = useCallback((nextVal?: boolean) => {
    const val = nextVal !== undefined ? nextVal : !activeGeomorphicHydrology;
    setInternalGeomorphicHydrology(val);
    if (onGeomorphicHydrologyChange) {
      onGeomorphicHydrologyChange(val);
    } else if (onGeomorphicHydrologyToggle) {
      onGeomorphicHydrologyToggle();
    }
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
      live.geomorphicHydrology = val;
      live.showDrainageHydrology = val;
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine) {
        if (typeof engine.setDrainageHydrologyEnabled === 'function') {
          engine.setDrainageHydrologyEnabled(val);
        }
        if (typeof engine.updateDrainageUniforms === 'function') {
          engine.updateDrainageUniforms({
            pluvialCoupling: activePluvialDischargeCoupling,
            bedrockIncision: activeBedrockIncision,
          });
        }
      }
    }
  }, [activeGeomorphicHydrology, activePluvialDischargeCoupling, activeBedrockIncision, onGeomorphicHydrologyChange, onGeomorphicHydrologyToggle]);

  const handlePluvialDischargeCouplingChange = useCallback((val: number) => {
    setInternalPluvialDischargeCoupling(val);
    onPluvialDischargeCouplingChange?.(val);
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
      live.pluvialDischargeCoupling = val;
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine && typeof engine.updateDrainageUniforms === 'function') {
        engine.updateDrainageUniforms({
          pluvialCoupling: val,
        });
      }
    }
  }, [onPluvialDischargeCouplingChange]);

  const handleBedrockIncisionChange = useCallback((val: number) => {
    setInternalBedrockIncision(val);
    onBedrockIncisionChange?.(val);
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
      live.bedrockIncision = val;
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine && typeof engine.updateDrainageUniforms === 'function') {
        engine.updateDrainageUniforms({
          bedrockIncision: val,
        });
      }
    }
  }, [onBedrockIncisionChange]);

  const [internalXdrSolarGlint, setInternalXdrSolarGlint] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__;
      if (live?.xdrSolarGlint !== undefined) return Boolean(live.xdrSolarGlint);
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine && typeof engine.isXdrSolarGlintEnabled === 'function') {
        return engine.isXdrSolarGlintEnabled();
      }
    }
    return false;
  });

  const activeXdrSolarGlint = propXdrSolarGlint !== undefined ? propXdrSolarGlint : internalXdrSolarGlint;

  const handleToggleXdrSolarGlint = useCallback((nextVal?: boolean) => {
    const val = nextVal !== undefined ? nextVal : !activeXdrSolarGlint;
    setInternalXdrSolarGlint(val);
    onXdrSolarGlintChange?.(val);
    if (typeof window !== 'undefined') {
      const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
      live.xdrSolarGlint = val;
      (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
      const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
      if (engine && typeof engine.setXdrSolarGlintEnabled === 'function') {
        engine.setXdrSolarGlintEnabled(val);
      }
    }
  }, [activeXdrSolarGlint, onXdrSolarGlintChange]);

  return (
    <>
      {/* 1. Solar Illumination & Hillshade Station */}
      <PolarSunCompass
        theme={theme}
        azimuth={primaryLayer?.sunAzimuth ?? 315}
        altitude={primaryLayer?.sunAltitude ?? 45}
        onChange={(azimuth, altitude) => {
          onHillshadeChangeDataLayer?.(
            primaryLayerId,
            azimuth,
            primaryLayer?.hillshadeIntensity ?? 0.65,
            altitude
          );
          if (typeof window !== 'undefined') {
            const live = (window as any).__INDICATRIX_LIVE_UNIFORMS__ || {};
            live.sunAzimuth = azimuth;
            live.sunAltitude = altitude;
            (window as any).__INDICATRIX_LIVE_UNIFORMS__ = live;
            const engine = (window as any).__INDICATRIX_WEBGPU_ENGINE__;
            if (engine && typeof engine.updateTerrainShadowUniforms === 'function') {
              engine.updateTerrainShadowUniforms({
                sunAzimuth: azimuth,
                sunAltitude: altitude,
              });
            }
          }
        }}
        isLight={isLight}
      >
        {/* Dynamic Terrain Horizon Self-Shadows & Canyon Lighting */}
        <div className="pt-2 border-t border-[var(--theme-card-border)] space-y-2">
          <TactileSwitch
            id="sidebar-terrain-shadows-toggle"
            checked={activeTerrainShadows}
            onChange={handleToggleTerrainShadows}
            title="Toggle Dynamic Terrain Horizon Self-Shadows"
            label="Terrain Self-Shadows"
            sublabel="Horizon occlusion & canyon shadow rays"
          />

          {/* Collapsible Slider: Penumbra Softness */}
          <div
            className={`transition-all duration-150 ease-out overflow-hidden ${
              activeTerrainShadows
                ? 'max-h-[120px] opacity-100 space-y-1.5 pointer-events-auto'
                : 'max-h-0 opacity-0 p-0 m-0 pointer-events-none'
            }`}
            style={{ transitionTimingFunction: 'var(--theme-spring-switch, cubic-bezier(0.34, 1.35, 0.64, 1))' }}
          >
            <div className="flex items-center justify-between text-nano pt-1">
              <span className="text-[var(--theme-text-secondary)] font-bold uppercase tracking-wider">
                Penumbra Softness:
              </span>
              <span className="font-semibold tabular-nums text-[var(--theme-text-primary)] font-mono">
                {activePenumbraSoftness.toFixed(2)}×
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="sidebar-terrain-shadow-softness"
                name="penumbraSoftness"
                type="range"
                min="0.5"
                max="3.0"
                step="0.05"
                value={activePenumbraSoftness}
                aria-label="Penumbra Softness"
                title="Penumbra Softness (Double-click to reset: 1.5×)"
                onDoubleClick={() => handlePenumbraSoftnessChange(1.5)}
                onChange={(e) => handlePenumbraSoftnessChange(parseFloat(e.target.value))}
                className="flex-1 slider-archival cursor-pointer h-1 rounded-[1px]"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-[var(--theme-card-border)]">
            <TactileSwitch
              id="sidebar-xdr-solar-glint-toggle"
              checked={activeXdrSolarGlint}
              onChange={handleToggleXdrSolarGlint}
              title="Toggle [BETA] XDR Extended Dynamic Range Solar Glint (rgba16float)"
              label="[BETA] XDR Solar Glint"
              sublabel="Extended toneMapping rgba16float (>1.0 Nit)"
            />
          </div>
        </div>
      </PolarSunCompass>

      {/* 2. Hypsometric Relief & Lithosphere Station */}
      <HypsometricReliefCurve
        theme={theme}
        displacementScale={primaryLayer?.displacementScale ?? 0.08}
        peakExponent={primaryLayer?.peakExponent ?? 1.4}
        onDisplacementChange={(scale) => onDisplacementScaleChangeDataLayer?.(primaryLayerId, scale)}
        onPeakExponentChange={(exponent) => onPeakExponentChangeDataLayer?.(primaryLayerId, exponent)}
        isLight={isLight}
      >
        <div className="pt-2 border-t border-[var(--theme-card-border)]">
          <VernierSlider
            id="sidebar-crevice-ao"
            label="Crevice Depth"
            sublabel="DEM surface curvature ambient occlusion"
            tooltip="Darkens concave ravines and canyon floors via DEM surface curvature"
            value={primaryLayer?.ambientOcclusion ?? 0.65}
            min={0.0}
            max={1.0}
            step={0.05}
            defaultValue={0.65}
            readout={`${Math.round((primaryLayer?.ambientOcclusion ?? 0.65) * 100)}%`}
            onChange={(v) => onAmbientOcclusionChangeDataLayer?.(primaryLayerId, v)}
            className="!border-0 !bg-transparent !p-0 !shadow-none"
          />
        </div>
      </HypsometricReliefCurve>

      {/* 3. Bathymetric Hydrosphere & Drainage Station */}
      <BathymetricTideGauge
        theme={theme}
        seaLevelOffset={primaryLayer?.seaLevelOffset ?? 0}
        waterClarity={primaryLayer?.waterClarity ?? 0.75}
        onSeaLevelChange={(offset) => onSeaLevelOffsetChangeDataLayer?.(primaryLayerId, offset)}
        onWaterClarityChange={(clarity) => onWaterClarityChangeDataLayer?.(primaryLayerId, clarity)}
        isLight={isLight}
      >
        {/* Dynamic Geomorphic Drainage Basin Synthesis & Leopold-Maddock Hydrology */}
        <div className="pt-2 border-t border-[var(--theme-card-border)] space-y-2">
          <TactileSwitch
            id="sidebar-geomorphic-hydrology-toggle"
            checked={activeGeomorphicHydrology}
            onChange={handleToggleGeomorphicHydrology}
            title="Toggle Dynamic Geomorphic Hydrology & Basin Accumulation"
            label="Geomorphic Hydrology"
            sublabel="D-∞ catchment routing & Leopold-Maddock"
          />

          {/* Collapsible Sliders: Pluvial Discharge Coupling & Bedrock Incision */}
          <div
            className={`transition-all duration-150 ease-out overflow-hidden ${
              activeGeomorphicHydrology
                ? 'max-h-[160px] opacity-100 space-y-2 pointer-events-auto'
                : 'max-h-0 opacity-0 p-0 m-0 pointer-events-none'
            }`}
            style={{ transitionTimingFunction: 'var(--theme-spring-switch, cubic-bezier(0.34, 1.35, 0.64, 1))' }}
          >
            <div className="space-y-1">
              <div className="flex items-center justify-between text-nano pt-1">
                <span className="text-[var(--theme-text-secondary)] font-bold uppercase tracking-wider">
                  Pluvial Coupling:
                </span>
                <span className="font-semibold tabular-nums text-[var(--theme-text-primary)] font-mono">
                  {activePluvialDischargeCoupling.toFixed(2)}×
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="sidebar-pluvial-discharge-coupling"
                  name="pluvialDischargeCoupling"
                  type="range"
                  min="0.0"
                  max="2.0"
                  step="0.05"
                  value={activePluvialDischargeCoupling}
                  aria-label="Pluvial Discharge Coupling"
                  title="Pluvial Discharge Coupling (Double-click to reset: 1.0×)"
                  onDoubleClick={() => handlePluvialDischargeCouplingChange(1.0)}
                  onChange={(e) => handlePluvialDischargeCouplingChange(parseFloat(e.target.value))}
                  className="flex-1 slider-archival cursor-pointer h-1 rounded-[1px]"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-nano">
                <span className="text-[var(--theme-text-secondary)] font-bold uppercase tracking-wider">
                  Bedrock Incision:
                </span>
                <span className="font-semibold tabular-nums text-[var(--theme-text-primary)] font-mono">
                  {activeBedrockIncision.toFixed(2)}×
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="sidebar-bedrock-incision"
                  name="bedrockIncision"
                  type="range"
                  min="0.0"
                  max="2.0"
                  step="0.05"
                  value={activeBedrockIncision}
                  aria-label="Bedrock Incision"
                  title="Bedrock Incision (Double-click to reset: 1.0×)"
                  onDoubleClick={() => handleBedrockIncisionChange(1.0)}
                  onChange={(e) => handleBedrockIncisionChange(parseFloat(e.target.value))}
                  className="flex-1 slider-archival cursor-pointer h-1 rounded-[1px]"
                />
              </div>
            </div>
          </div>
        </div>
      </BathymetricTideGauge>

      {/* 3. Vector Ink & Geodetic Survey Feeds Station */}
      <div className="p-2.5 rounded-[3px] border border-[var(--theme-card-border)] bg-[var(--theme-card-bg)] space-y-2 transition-all shadow-sm">
        <TactileSwitch
          checked={showVectors}
          onChange={onVectorsToggle}
          title="Toggle Coastline & Boundary Vectors (Press V)"
          label="Vectors (V)"
          sublabel="Coastlines & graticule linework"
        />

        <div className="pt-2 border-t border-[var(--theme-card-border)]">
          <TactileSwitch
            id="sidebar-contours-toggle"
            checked={activeContourActive}
            onChange={handleToggleContours}
            title="Toggle Topographic & Bathymetric Isolines"
            label="Topographic & Bathymetric Isolines"
            sublabel="Multi-scale elevation & isobath contours"
          />
        </div>

        <div className="pt-2 border-t border-[var(--theme-card-border)]">
          <TactileSwitch
            id="sidebar-toponymy-toggle"
            checked={propShowToponymy !== undefined ? propShowToponymy : internalShowToponymy}
            onChange={handleToggleToponymy}
            title="Toggle Toponymy & Spot Elevations"
            label="Toponymy & Spot Elevations"
            sublabel="MSDF copperplate labels & summit markers"
          />
        </div>
      </div>
    </>
  );
};
