import type { Stats } from '../wfc/controller';

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${Math.round(n)}`;
}

const STATUS_LABEL: Record<Stats['status'], string> = {
  running: 'solving',
  done: 'complete',
  failed: 'stuck',
};

export default function StatsPanel({ stats }: { stats: Stats }) {
  const pct = Math.round(stats.percent * 100);
  const items: [string, string][] = [
    ['tiles in set', `${stats.nTiles}`],
    ['observations', fmt(stats.steps)],
    ['steps / sec', fmt(stats.stepsPerSec)],
    ['contradictions', fmt(stats.contradictions)],
    ['backtracks', fmt(stats.backtracks)],
    ['restarts', `${stats.restarts}`],
  ];
  return (
    <section className="panel stats">
      <header className="panel-head">
        <h2>Telemetry</h2>
        <span className={`badge badge-${stats.status}`}>
          {stats.running && stats.status === 'running' ? '● ' : ''}
          {STATUS_LABEL[stats.status]}
        </span>
      </header>
      <div className="progress">
        <div className="progress-bar" style={{ width: `${pct}%` }} />
        <span className="progress-label">
          {stats.collapsed} / {stats.total} cells · {pct}%
        </span>
      </div>
      <dl className="metrics">
        {items.map(([k, v]) => (
          <div key={k} className="metric">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
