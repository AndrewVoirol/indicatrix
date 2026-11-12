import React from 'react';
import { ResolutionTier } from '../../../types';
import { AtmosphereDrawer, PrognosticModelBackend } from '../../AtmosphereDrawer';
import { TimelineScrubber, type TimelineScrubberState } from '../TimelineScrubber';
import type { MeteorologicalProvenance } from '../../../core/data/WeatherNextDataSource';

export interface AtmosphereTabProps {
  theme: 0 | 1 | 2;
  isLight: boolean;
  resolution: ResolutionTier;
  timelineMinutes?: number;
  onTimelineChange?: (state: TimelineScrubberState) => void;
  propShowClouds?: boolean;
  handleToggleClouds: (val: boolean) => void;
  propShowCloudLow?: boolean;
  onShowCloudLowChange?: (v: boolean) => void;
  propShowCloudMid?: boolean;
  onShowCloudMidChange?: (v: boolean) => void;
  propShowCloudHigh?: boolean;
  onShowCloudHighChange?: (v: boolean) => void;
  propCloudFalseColor?: boolean;
  onCloudFalseColorChange?: (v: boolean) => void;
  propVolumetricClouds?: boolean;
  onVolumetricCloudsChange?: (v: boolean) => void;
  propCloudDriftSpeed?: number;
  onCloudDriftSpeedChange?: (v: number) => void;
  propCloudOpacity?: number;
  onCloudOpacityChange?: (v: number) => void;
  propCloudThickness?: number;
  onCloudThicknessChange?: (v: number) => void;
  propCloudLowTop?: number;
  onCloudLowTopChange?: (v: number) => void;
  propCloudErosion?: number;
  onCloudErosionChange?: (v: number) => void;
  propCloudFreqHoriz?: number;
  onCloudFreqHorizChange?: (v: number) => void;
  propCloudFreqVert?: number;
  onCloudFreqVertChange?: (v: number) => void;
  propCloudExtinction?: number;
  onCloudExtinctionChange?: (v: number) => void;
  propAtmosphericScale?: number;
  onAtmosphericScaleChange?: (v: number) => void;
  propShadowIntensity?: number;
  onShadowIntensityChange?: (v: number) => void;
  propRainShadowFeedback?: number;
  onRainShadowFeedbackChange?: (v: number) => void;
  propPluvialGamma?: number;
  onPluvialGammaChange?: (v: number) => void;
  propThermodynamicGating?: boolean;
  onThermodynamicGatingChange?: (v: boolean) => void;
  prognosticModel?: PrognosticModelBackend;
  onPrognosticModelChange?: (model: PrognosticModelBackend) => void;
  prognosticVariable?: string;
  onPrognosticVariableChange?: (variable: string) => void;
  handleTogglePlanetaryLayer: (id: string, force?: boolean) => void;
  provenance?: MeteorologicalProvenance;
  windSpeedMultiplier?: number;
  onWindSpeedMultiplierChange?: (v: number) => void;
  windParticleLifetime?: number;
  onWindParticleLifetimeChange?: (v: number) => void;
  isWindActive: boolean;
  isActive?: boolean;
}

export const AtmosphereTab: React.FC<AtmosphereTabProps> = ({
  theme,
  isLight,
  resolution,
  timelineMinutes,
  onTimelineChange,
  propShowClouds,
  handleToggleClouds,
  propShowCloudLow,
  onShowCloudLowChange,
  propShowCloudMid,
  onShowCloudMidChange,
  propShowCloudHigh,
  onShowCloudHighChange,
  propCloudFalseColor,
  onCloudFalseColorChange,
  propVolumetricClouds,
  onVolumetricCloudsChange,
  propCloudDriftSpeed,
  onCloudDriftSpeedChange,
  propCloudOpacity,
  onCloudOpacityChange,
  propCloudThickness,
  onCloudThicknessChange,
  propCloudLowTop,
  onCloudLowTopChange,
  propCloudErosion,
  onCloudErosionChange,
  propCloudFreqHoriz,
  onCloudFreqHorizChange,
  propCloudFreqVert,
  onCloudFreqVertChange,
  propCloudExtinction,
  onCloudExtinctionChange,
  propAtmosphericScale,
  onAtmosphericScaleChange,
  propShadowIntensity,
  onShadowIntensityChange,
  propRainShadowFeedback,
  onRainShadowFeedbackChange,
  propPluvialGamma,
  onPluvialGammaChange,
  propThermodynamicGating,
  onThermodynamicGatingChange,
  prognosticModel,
  onPrognosticModelChange,
  prognosticVariable,
  onPrognosticVariableChange,
  handleTogglePlanetaryLayer,
  provenance,
  windSpeedMultiplier,
  onWindSpeedMultiplierChange,
  windParticleLifetime,
  onWindParticleLifetimeChange,
  isWindActive,
  isActive = true,
}) => {
  return (
    <>
      <TimelineScrubber
        value={timelineMinutes}
        onTimeChange={onTimelineChange}
        prognosticModel={prognosticModel}
        disabled={prognosticModel === 'gfs' || prognosticModel === 'noaa-gfs'}
        className="border-[var(--theme-card-border)] bg-[var(--theme-card-bg)] !p-2 shadow-sm rounded-[3px]"
      />

      {/* Atmospheric Cloud Strata Instrumentation Card: border-[var(--theme-card-border)] bg-[var(--theme-card-bg)] */}
      <AtmosphereDrawer
        className="space-y-2.5"
        theme={theme}
        isLight={isLight}
        resolution={resolution}
        hideScrubber={true}
        showClouds={propShowClouds}
        onShowCloudsChange={handleToggleClouds}
        showCloudLow={propShowCloudLow}
        onShowCloudLowChange={onShowCloudLowChange}
        showCloudMid={propShowCloudMid}
        onShowCloudMidChange={onShowCloudMidChange}
        showCloudHigh={propShowCloudHigh}
        onShowCloudHighChange={onShowCloudHighChange}
        cloudFalseColor={propCloudFalseColor}
        onCloudFalseColorChange={onCloudFalseColorChange}
        volumetricClouds={propVolumetricClouds}
        onVolumetricCloudsChange={onVolumetricCloudsChange}
        cloudDriftSpeed={propCloudDriftSpeed}
        onCloudDriftSpeedChange={onCloudDriftSpeedChange}
        cloudOpacity={propCloudOpacity}
        onCloudOpacityChange={onCloudOpacityChange}
        cloudThickness={propCloudThickness}
        onCloudThicknessChange={onCloudThicknessChange}
        cloudLowTop={propCloudLowTop}
        onCloudLowTopChange={onCloudLowTopChange}
        cloudErosion={propCloudErosion}
        onCloudErosionChange={onCloudErosionChange}
        cloudFreqHoriz={propCloudFreqHoriz}
        onCloudFreqHorizChange={onCloudFreqHorizChange}
        cloudFreqVert={propCloudFreqVert}
        onCloudFreqVertChange={onCloudFreqVertChange}
        cloudExtinction={propCloudExtinction}
        onCloudExtinctionChange={onCloudExtinctionChange}
        atmosphericScale={propAtmosphericScale}
        onAtmosphericScaleChange={onAtmosphericScaleChange}
        shadowIntensity={propShadowIntensity}
        onShadowIntensityChange={onShadowIntensityChange}
        rainShadowFeedback={propRainShadowFeedback}
        onRainShadowFeedbackChange={onRainShadowFeedbackChange}
        pluvialGamma={propPluvialGamma}
        onPluvialGammaChange={onPluvialGammaChange}
        thermodynamicGating={propThermodynamicGating}
        onThermodynamicGatingChange={onThermodynamicGatingChange}
        prognosticModel={prognosticModel}
        onPrognosticModelChange={onPrognosticModelChange}
        prognosticVariable={prognosticVariable}
        onPrognosticVariableChange={onPrognosticVariableChange}
        timelineMinutes={timelineMinutes}
        onTimelineChange={onTimelineChange}
        onTogglePlanetaryLayer={handleTogglePlanetaryLayer}
        provenance={provenance}
        windSpeedMultiplier={windSpeedMultiplier}
        onWindSpeedMultiplierChange={onWindSpeedMultiplierChange}
        windParticleLifetime={windParticleLifetime}
        onWindParticleLifetimeChange={onWindParticleLifetimeChange}
        isWindActive={isWindActive}
        isActive={isActive}
      />
    </>
  );
};
