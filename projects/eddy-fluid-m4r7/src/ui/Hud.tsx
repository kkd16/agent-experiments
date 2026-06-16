// Hud.tsx — small performance/state overlay shown over the canvas.

import type { Stats } from '../sim/engine';

export function Hud({ stats }: { stats: Stats | null }) {
  if (!stats) return null;
  const cells = stats.resolution * stats.resolution;
  return (
    <div className="hud">
      <span className={stats.fps >= 50 ? 'ok' : stats.fps >= 30 ? 'warn' : 'bad'}>
        {stats.fps.toFixed(0)} fps
      </span>
      <span>{stats.stepMs.toFixed(1)} ms/step</span>
      <span>
        {stats.resolution}² · {(cells / 1000).toFixed(1)}k cells
      </span>
      {stats.paused && <span className="warn">paused</span>}
    </div>
  );
}
