// Hud.tsx — small performance/state overlay shown over the canvas.

import type { Stats } from '../sim/engine';

export function Hud({ stats }: { stats: Stats | null }) {
  if (!stats) return null;
  const cells = stats.resolution * stats.resolution;
  const p = stats.probe;
  return (
    <>
      <div className="hud">
        <span className={stats.fps >= 50 ? 'ok' : stats.fps >= 30 ? 'warn' : 'bad'}>
          {stats.fps.toFixed(0)} fps
        </span>
        <span>{stats.stepMs.toFixed(1)} ms/step</span>
        <span>
          {stats.resolution}² · {(cells / 1000).toFixed(1)}k cells
        </span>
        <span title="Mean kinetic energy of the flow">KE {stats.kineticEnergy.toFixed(3)}</span>
        <span title="Peak residual divergence — how incompressible the field is (lower is better)">
          ∇·u {stats.maxDivergence.toExponential(1)}
        </span>
        {stats.paused && <span className="warn">paused</span>}
      </div>
      {p && (
        <div className="probe" title="Field values under the cursor">
          <span className="probe-pos">
            ({p.gx}, {p.gy}){p.solid ? ' · wall' : ''}
          </span>
          <span>u ({p.u.toFixed(3)}, {p.v.toFixed(3)})</span>
          <span>|u| {p.speed.toFixed(3)}</span>
          <span title="vorticity ω = ∇×u">ω {p.curl.toExponential(1)}</span>
          <span title="pressure (last solve)">p {p.pressure.toExponential(1)}</span>
          <span title="temperature">T {p.temp.toFixed(3)}</span>
          {p.fuel > 1e-4 && <span title="fuel concentration">fuel {p.fuel.toFixed(3)}</span>}
          {p.bmag > 1e-4 && <span title="magnetic field magnitude |B|">|B| {p.bmag.toFixed(3)}</span>}
          {Math.abs(p.current) > 1e-4 && (
            <span title="out-of-plane current density jz = ∂ₓB_y − ∂_yB_x">jz {p.current.toExponential(1)}</span>
          )}
        </div>
      )}
    </>
  );
}
