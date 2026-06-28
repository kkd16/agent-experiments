import { useEffect, useRef, useState } from 'react';
import { type StepStats } from '../engine';

/** A compact telemetry readout of the live simulation. */
export default function Hud({ stats }: { stats: StepStats | null }) {
  const [fps, setFps] = useState(0);
  const frames = useRef(0);
  const since = useRef(0);

  useEffect(() => {
    let raf = 0;
    since.current = performance.now();
    const tick = (): void => {
      frames.current++;
      const now = performance.now();
      if (now - since.current >= 500) {
        setFps((frames.current * 1000) / (now - since.current));
        frames.current = 0;
        since.current = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const rows: Array<[string, string]> = [
    ['FPS', fps.toFixed(0)],
    ['Step', stats ? `${stats.stepMs.toFixed(2)} ms` : '—'],
    ['Bodies', stats ? `${stats.bodies}` : '—'],
    ['Awake', stats ? `${stats.awakeBodies}` : '—'],
    ['Contacts', stats ? `${stats.contacts}` : '—'],
    ['Manifold pts', stats ? `${stats.contactPoints}` : '—'],
    ['Islands', stats ? `${stats.islands}` : '—'],
    ['Joints', stats ? `${stats.joints}` : '—'],
    ['Pairs', stats ? `${stats.pairs}` : '—'],
    ['BVH height', stats ? `${stats.treeHeight}` : '—'],
  ];

  // Fluid telemetry only when an SPH system is live.
  if (stats && stats.fluidParticles > 0) {
    rows.push(['Fluid particles', `${stats.fluidParticles}`]);
    rows.push(['Fluid density', `${stats.fluidDensity.toFixed(3)} ρ₀`]);
  }

  // MPM telemetry only when a Material Point Method system is live.
  if (stats && stats.mpmParticles > 0) {
    rows.push(['MPM points', `${stats.mpmParticles}`]);
  }

  return (
    <div className="hud">
      {rows.map(([label, value]) => (
        <div className="hud-cell" key={label}>
          <span className="hud-label">{label}</span>
          <span className="hud-value">{value}</span>
        </div>
      ))}
    </div>
  );
}
