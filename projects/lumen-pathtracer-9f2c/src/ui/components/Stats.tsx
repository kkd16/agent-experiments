// Stats.tsx — a live readout strip beneath the viewport.

import type { RenderStats } from '../../render/renderer'

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(0)
}

export function Stats(props: { stats: RenderStats | null }) {
  const s = props.stats
  const pct = s ? Math.min(100, (s.samples / Math.max(1, s.targetSpp)) * 100) : 0
  return (
    <div className="stats">
      <div className="progress">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="stat-cells">
        <Cell label="Samples" value={s ? `${s.samples} / ${s.targetSpp}` : '—'} />
        <Cell label="Rays" value={s ? fmt(s.rays) : '—'} />
        <Cell label="Rays/s" value={s ? fmt(s.raysPerSec) : '—'} />
        <Cell label="Elapsed" value={s ? `${(s.elapsedMs / 1000).toFixed(1)}s` : '—'} />
        <Cell label="Threads" value={s ? `${s.workers} · ${s.mode === 'multithread' ? 'MT' : 'ST'}` : '—'} />
        <Cell label="Triangles" value={s ? fmt(s.triCount) : '—'} />
        <Cell label="BVH nodes" value={s ? `${fmt(s.bvhNodes)} · d${s.bvhDepth}` : '—'} />
        <Cell label="Status" value={s ? (s.done ? 'Converged' : 'Rendering…') : 'Idle'} highlight={s?.done} />
      </div>
    </div>
  )
}

function Cell(props: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={props.highlight ? 'cell hot' : 'cell'}>
      <span className="cell-label">{props.label}</span>
      <span className="cell-value">{props.value}</span>
    </div>
  )
}
