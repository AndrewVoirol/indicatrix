// ============================================================================
// File: src/components/hud/CuratorsColophon.tsx
// Curator's Colophon / Sheet Cartouche
// Provides unambiguous cartographic data provenance and technical datum references.
// ============================================================================

import React from 'react';
import type { MeteorologicalProvenance } from '../../core/data/WeatherNextDataSource';

export interface CuratorsColophonProps {
  theme: 0 | 1 | 2;
  isWeatherActive?: boolean;
  prognosticModel?: string;
  provenance?: MeteorologicalProvenance;
  timelineMinutes?: number;
  className?: string;
}

export const CuratorsColophon: React.FC<CuratorsColophonProps> = ({
  theme: _theme,
  isWeatherActive = false,
  prognosticModel,
  provenance,
  timelineMinutes = 0,
  className = '',
}) => {
  const isGfs = prognosticModel === 'gfs' || prognosticModel === 'noaa-gfs';
  const isSat = prognosticModel === 'satellite' || prognosticModel === 'live-satellite';
  const activeBadgeStyle = 'bg-[var(--theme-status-sage-15)] text-[var(--theme-status-sage)]';
  const activeModelBadge = isGfs
    ? '[NOAA GFS: ACTIVE]'
    : isSat
    ? '[LIVE SATELLITE: ACTIVE]'
    : '[WEATHERNEXT: ACTIVE]';

  const leadHours = Math.max(0, Math.floor((Number.isFinite(timelineMinutes) ? timelineMinutes : 0) / 60));
  const activeMeteoSpec = isGfs
    ? 'NOAA NCEP GFS 0.25° Operational Grid (1440×721 · 10m / 500 / 250 hPa · 0h Analysis)'
    : isSat
    ? leadHours > 0
      ? `NASA EOSDIS GIBS → WeatherNext 3 (+${leadHours}h Handoff · 3600×1801 · 0.1°)`
      : 'NASA EOSDIS GIBS (VIIRS Band I5 11.45µm + MODIS/VIIRS L2 CTH & CF · 3600×1801 · 0.1°)'
    : `Google DeepMind WeatherNext 3 (3600×1801 · 0.1° Zarr v3${
        provenance?.runTimestamp && provenance.runTimestamp.includes('T')
          ? ` · ${provenance.runTimestamp.slice(11, 13)}Z Cycle`
          : ''
      })`;

  return (
    <div
      data-testid="curators-colophon"
      className={`rounded-[3px] border p-2.5 font-mono text-nano transition-all shadow-sm select-none bg-[var(--theme-card-bg)] border-[var(--theme-card-border)] text-[var(--theme-text-secondary)] font-telemetry ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b pb-1.5 mb-2 border-current/20">
        <span className="font-bold tracking-wider uppercase text-micro text-current">
          Curator's Colophon
        </span>
      </div>

      {/* Data Provenance Ledger */}
      <div className="space-y-1.5 text-nano leading-tight">
        <span className="opacity-70 block text-nano uppercase tracking-wider font-medium">
          Provenance
        </span>
        <ul className="space-y-1 opacity-85 text-nano pl-0.5 leading-snug">
          <li className="flex items-start gap-1">
            <span className="opacity-50 select-none">•</span>
            <span>
              <strong className="text-current font-semibold">Crust & Bathymetry:</strong> GEBCO 2024 / NOAA ETOPO 2022 (15″ DEM)
            </span>
          </li>
          <li className="flex items-start gap-1">
            <span className="opacity-50 select-none">•</span>
            <span className="flex-1">
              <strong className="text-current font-semibold">Atmospheric & Precipitation:</strong> Google DeepMind WeatherNext 3 (0.1° / 10 km), NASA EOSDIS GIBS (VIIRS 11.45µm + MODIS/VIIRS CTH & CF), & NOAA GFS (0.25° 10m / 500 / 250 hPa)
              {isWeatherActive && (
                <>
                  <span
                    data-testid="colophon-badge-weathernext"
                    className={`ml-1.5 px-1.5 py-0.5 rounded-[2px] text-nano font-mono font-bold tracking-wider uppercase align-middle inline-block ${activeBadgeStyle}`}
                  >
                    {activeModelBadge}
                  </span>
                  <span
                    data-testid="colophon-active-meteo-spec"
                    className="block mt-0.5 text-[var(--theme-text-muted)] text-pico"
                  >
                    Active Feed: {activeMeteoSpec}
                  </span>
                </>
              )}
            </span>
          </li>
          <li className="flex items-start gap-1">
            <span className="opacity-50 select-none">•</span>
            <span>
              <strong className="text-current font-semibold">Linework:</strong> Natural Earth (1:10M)
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
};
