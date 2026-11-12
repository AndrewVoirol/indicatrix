import React, { useState, useMemo, useEffect, useRef } from 'react';
import { TactileSwitch } from '../../ui/TactileSwitch';
import { VernierSlider } from '../../ui/VernierSlider';
import { TactileSelect } from '../../ui/TactileSelect';

export interface KinematicsTabProps {
  cameraPosition?: [number, number, number];
  onSnapCamera: (v: 'equator' | 'pole' | 'seam' | 'isometric' | 'horizon') => void;
  alpha?: number;
  isActive?: boolean;
  isDemoMode?: boolean;
  demoSequence?: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji';
  onToggleDemoMode?: (seq?: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji') => void;
  onSelectDemoSequence?: (seq: 'hawaii' | 'cape-cod' | 'grand-canyon' | 'fuji') => void;
}

export const DEMO_PRESETS = [
  { id: 'hawaii', label: 'Hawaii', coordinates: "19°49'N 155°28'W", description: 'Volcanic hotspot & ocean trench' },
  { id: 'cape-cod', label: 'Cape Cod', coordinates: "41°54'N 70°03'W", description: 'Coastal spit & moraine barrier' },
  { id: 'grand-canyon', label: 'Grand Canyon', coordinates: "36°06'N 112°06'W", description: 'Riparian orogeny & canyon incision' },
  { id: 'fuji', label: 'Mount Fuji', coordinates: "35°21'N 138°43'E", description: 'Stratovolcano & caldera relief' },
] as const;

export const KinematicsTab: React.FC<KinematicsTabProps> = ({
  cameraPosition,
  onSnapCamera,
  alpha = 0,
  isActive = true,
  isDemoMode = false,
  demoSequence = 'hawaii',
  onToggleDemoMode,
  onSelectDemoSequence,
}) => {
  const [activeSnap, setActiveSnap] = useState<'equator' | 'pole' | 'seam' | 'isometric' | 'horizon' | null>(null);
  const snapAnchorRef = useRef<{ time: number; settledPos: [number, number, number] | null } | null>(null);
  const [liveCameraState, setLiveCameraState] = useState<{
    pos: [number, number, number] | null;
    pitch: number | null;
    coords: { lat: number; lon: number } | null;
    camDist: number | null;
  }>({ pos: null, pitch: null, coords: null, camDist: null });

  useEffect(() => {
    if (isDemoMode) {
      setActiveSnap(null);
      snapAnchorRef.current = null;
    }
  }, [isDemoMode]);

  useEffect(() => {
    if (!isActive) return;
    if (typeof window === 'undefined') return;
    if (typeof navigator !== 'undefined' && /jsdom|HappyDOM/i.test(navigator.userAgent || '')) return;
    const syncCam = () => {
      const cam = (window as any).__INDICATRIX_CAMERA__;
      if (!cam) return;
      const pos = typeof cam.getPosition === 'function' ? cam.getPosition() : null;
      const pitchVal = typeof cam.getPitch === 'function' ? cam.getPitch() : (typeof cam.pitch === 'number' ? cam.pitch : null);
      const activeCoords = typeof cam.getActiveCoords === 'function' ? cam.getActiveCoords() : null;
      const distVal = typeof cam.getCamDist === 'function' ? cam.getCamDist() : null;

      if (snapAnchorRef.current && Array.isArray(pos) && pos.length >= 3) {
        const elapsed = performance.now() - snapAnchorRef.current.time;
        if (elapsed > 1800) {
          if (!snapAnchorRef.current.settledPos) {
            snapAnchorRef.current.settledPos = [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(pos[2]) || 15];
          } else {
            const dx = (Number(pos[0]) || 0) - snapAnchorRef.current.settledPos[0];
            const dy = (Number(pos[1]) || 0) - snapAnchorRef.current.settledPos[1];
            const dz = (Number(pos[2]) || 0) - snapAnchorRef.current.settledPos[2];
            if (Math.hypot(dx, dy, dz) > 0.15) {
              snapAnchorRef.current = null;
              setActiveSnap(null);
            }
          }
        }
      }

      setLiveCameraState((prev) => {
        const nextPos: [number, number, number] | null = Array.isArray(pos) && pos.length >= 3
          ? [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(pos[2]) || 15]
          : prev.pos;
        const nextPitch = typeof pitchVal === 'number' && Number.isFinite(pitchVal) ? pitchVal : prev.pitch;
        const nextCoords =
          activeCoords && Number.isFinite(activeCoords.lat) && Number.isFinite(activeCoords.lon)
            ? { lat: Number(activeCoords.lat), lon: Number(activeCoords.lon) }
            : prev.coords;
        const nextDist = typeof distVal === 'number' && Number.isFinite(distVal) ? distVal : prev.camDist;
        if (
          prev.pitch === nextPitch &&
          prev.camDist === nextDist &&
          prev.coords?.lat === nextCoords?.lat &&
          prev.coords?.lon === nextCoords?.lon &&
          prev.pos &&
          nextPos &&
          Math.abs(prev.pos[0] - nextPos[0]) < 0.005 &&
          Math.abs(prev.pos[1] - nextPos[1]) < 0.005 &&
          Math.abs(prev.pos[2] - nextPos[2]) < 0.005
        ) {
          return prev;
        }
        return { pos: nextPos, pitch: nextPitch, coords: nextCoords, camDist: nextDist };
      });
    };
    syncCam();
    const timer = window.setInterval(syncCam, 120);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const attitudeReadout = useMemo(() => {
    const pos = liveCameraState.pos || cameraPosition || [0, 0, 15];
    const [x, y, z] = pos;
    let latNum: number;
    let lonNum: number;
    let altStr: string;

    if (alpha > 0.5) {
      // Planar unfolded chart
      if (liveCameraState.coords) {
        latNum = liveCameraState.coords.lat;
        lonNum = liveCameraState.coords.lon;
      } else {
        lonNum = Math.max(-180, Math.min(180, (x / 5.0) * (180 / Math.PI)));
        latNum = Math.max(-90, Math.min(90, (y / 5.0) * (180 / Math.PI)));
      }
      const effDist = liveCameraState.camDist ?? (5.0 + Math.abs(z - 5.0));
      altStr = effDist > 0.001 ? effDist.toFixed(1) : '15.0';
    } else {
      const r = Math.sqrt(x * x + y * y + z * z);
      altStr = r > 0.001 ? r.toFixed(1) : '15.0';
      latNum = Math.asin(Math.max(-1, Math.min(1, y / (r || 1)))) * (180 / Math.PI);
      lonNum = Math.atan2(x, z) * (180 / Math.PI);
    }

    let lat = latNum.toFixed(1);
    if (lat === '-0.0') lat = '0.0';
    let lon = lonNum.toFixed(1);
    if (lon === '-0.0') lon = '0.0';
    let pitchVal = (liveCameraState.pitch ?? 0).toFixed(1);
    if (pitchVal === '-0.0') pitchVal = '0.0';
    return `LAT: ${lat}° · LON: ${lon}° · PITCH: ${pitchVal}° · ALT: ${altStr} R`;
  }, [alpha, cameraPosition, liveCameraState.camDist, liveCameraState.coords, liveCameraState.pos, liveCameraState.pitch]);

  return (
    <>
      {/* 1. Spatial Vantage & Flight Deck */}
      <div className="p-2.5 rounded-[3px] border border-[var(--theme-card-border)] bg-[var(--theme-card-bg)] space-y-2 transition-all shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-micro uppercase font-bold tracking-wider text-[var(--theme-text-primary)]">
            Spatial Vantage & Flight Deck
          </div>
          <span className="text-nano font-mono text-[var(--theme-text-muted)]">
            Attitude
          </span>
        </div>

        <div className="px-2 py-1 rounded-[2px] bg-[var(--theme-control-bg)] border border-[var(--theme-control-border)] text-nano font-mono tracking-wider text-center text-[var(--theme-text-accent)] tabular-nums font-semibold">
          {attitudeReadout}
        </div>

        <div className="grid grid-cols-5 gap-1 text-nano font-bold">
          {([
            { key: 'equator', label: 'Equator', glyph: '⊝' },
            { key: 'pole', label: 'Pole', glyph: '⊙' },
            { key: 'seam', label: 'Seam', glyph: '⦶' },
            { key: 'isometric', label: 'Iso', glyph: '◬' },
            { key: 'horizon', label: 'Horizon', glyph: '☵' },
          ] as const).map((snap) => {
            const isSnapActive = activeSnap === snap.key;
            return (
              <button
                key={snap.key}
                type="button"
                onClick={() => {
                  setActiveSnap(snap.key);
                  snapAnchorRef.current = { time: performance.now(), settledPos: null };
                  setLiveCameraState((prev) => ({
                    ...prev,
                    pitch: snap.key === 'horizon' ? 78 : 0,
                  }));
                  if (snap.key !== 'horizon' && typeof window !== 'undefined' && (window as any).__INDICATRIX_LIVE_UNIFORMS__) {
                    (window as any).__INDICATRIX_LIVE_UNIFORMS__.cameraPitchDeg = 0;
                  }
                  onSnapCamera(snap.key);
                }}
                data-glyph={snap.glyph}
                aria-pressed={isSnapActive}
                title={`${snap.label} (${snap.glyph})`}
                className={`py-1.5 px-0.5 rounded-[2px] border transition-all cursor-pointer text-center truncate select-none flex flex-col items-center justify-center before:content-[attr(data-glyph)] before:block before:text-micro before:leading-none before:opacity-75 before:mb-0.5 ${
                  isSnapActive
                    ? 'bg-[var(--theme-control-active-bg)] text-[var(--theme-control-active-text)] border-[var(--theme-control-active-border)] shadow-sm font-semibold ring-1 ring-[var(--theme-control-active-ring)]'
                    : 'border-[var(--theme-control-border)] bg-[var(--theme-control-bg)] text-[var(--theme-text-secondary)] hover:text-[var(--theme-text-primary)] hover:border-[var(--theme-card-border-hover)] hover:bg-[var(--theme-control-hover-bg)]'
                }`}
              >
                <span>{snap.label}</span>
              </button>
            );
          })}
        </div>

        <div className="pt-2 border-t border-[var(--theme-card-border)] space-y-1.5">
          <TactileSwitch
            checked={Boolean(isDemoMode)}
            onChange={() => onToggleDemoMode?.(demoSequence)}
            title="Toggle Continuous Cinematics & Regional Insets Tour"
            label="Flyover Tour"
            sublabel="Cinematic orbital & regional insets"
          />
          <TactileSelect
            id="sidebar-demo-sequence"
            value={demoSequence || 'hawaii'}
            ariaLabel="Demo Sequence Preset"
            onChange={(val) => onSelectDemoSequence?.(val as any)}
            options={DEMO_PRESETS}
          />
        </div>
      </div>

      {/* Camera Horizon Pitch */}
      <div className="p-2.5 rounded-[3px] border border-[var(--theme-card-border)] bg-[var(--theme-card-bg)] space-y-2 transition-all shadow-sm">
        <div className="flex items-center justify-between text-nano">
          <span className="font-bold text-[var(--theme-text-primary)] uppercase tracking-wider text-micro">
            Camera Horizon Pitch
          </span>
          <span className="text-[var(--theme-text-muted)] font-mono text-nano">
            0° Nadir — 85° Grazing
          </span>
        </div>

        {/* Camera Horizon Pitch Slider */}
        <VernierSlider
          id="camera-horizon-pitch-kinematics"
          value={(() => {
            if (liveCameraState.pitch !== null) return Math.min(85, Math.max(0, liveCameraState.pitch));
            if (typeof window !== 'undefined') {
              const cam = (window as any).__INDICATRIX_CAMERA__;
              if (cam?.getPitch) return cam.getPitch();
              if (cam?.pitch !== undefined) return cam.pitch;
            }
            return 0;
          })()}
          defaultValue={0}
          min={0}
          max={85}
          step={1}
          onChange={(val: number) => {
            setActiveSnap(null);
            snapAnchorRef.current = null;
            setLiveCameraState((prev) => ({ ...prev, pitch: val }));
            if (typeof window !== 'undefined') {
              const cam = (window as any).__INDICATRIX_CAMERA__;
              if (cam?.setPitch) cam.setPitch(val);
            }
          }}
          label="Camera Horizon Pitch"
          unit="°"
          readout={(() => {
            if (liveCameraState.pitch !== null) return `${Number(liveCameraState.pitch).toFixed(1)}°`;
            if (typeof window !== 'undefined') {
              const cam = (window as any).__INDICATRIX_CAMERA__;
              const p = cam?.getPitch?.() ?? cam?.pitch ?? 0;
              return `${Number(p).toFixed(1)}°`;
            }
            return '0.0°';
          })()}
          tooltip="Camera Horizon Pitch Angle (0° Nadir to 85° Grazing)"
          className="!border-0 !bg-transparent !p-0 !shadow-none"
        />
      </div>
    </>
  );
};
