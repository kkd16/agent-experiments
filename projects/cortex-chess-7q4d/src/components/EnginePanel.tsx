import type { SearchInfo } from '../engine'

interface EnginePanelProps {
  info: SearchInfo | null
  pvSan: string
  thinking: boolean
}

function fmtNodes(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

export default function EnginePanel({ info, pvSan, thinking }: EnginePanelProps) {
  const scoreText = info
    ? info.mate !== null
      ? `#${info.mate}`
      : ((info.score >= 0 ? '+' : '') + (info.score / 100).toFixed(2))
    : '—'

  return (
    <div className="engine-panel">
      <div className="engine-head">
        <span className="engine-name">
          Cortex <span className={`pulse ${thinking ? 'on' : ''}`} />
        </span>
        <span className="engine-score">{scoreText}</span>
      </div>
      <div className="engine-stats">
        <div>
          <span className="stat-k">Depth</span>
          <span className="stat-v">{info ? info.depth : '—'}</span>
        </div>
        <div>
          <span className="stat-k">Nodes</span>
          <span className="stat-v">{info ? fmtNodes(info.nodes) : '—'}</span>
        </div>
        <div>
          <span className="stat-k">Speed</span>
          <span className="stat-v">{info ? fmtNodes(info.nps) + '/s' : '—'}</span>
        </div>
        <div>
          <span className="stat-k">Time</span>
          <span className="stat-v">{info ? info.timeMs + 'ms' : '—'}</span>
        </div>
      </div>
      <div className="engine-pv">
        <span className="stat-k">Best line</span>
        <div className="pv-line">{pvSan || '—'}</div>
      </div>
    </div>
  )
}
