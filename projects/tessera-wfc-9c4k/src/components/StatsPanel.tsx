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
    ['eliminations', fmt(stats.eliminations)],
    ['peak depth', `${stats.peakDepth}`],
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
      {stats.supportsConnectivity && stats.connectivity !== 'off' && <ConnectivityReadout stats={stats} />}
    </section>
  );
}

function ConnectivityReadout({ stats }: { stats: Stats }) {
  if (stats.connectivity === 'terminals') {
    const label =
      stats.terminals < 2
        ? 'pin ≥ 2 connector tiles'
        : stats.routed === true
          ? '✓ pins routed'
          : stats.status === 'done'
            ? '✓ pins routed'
            : 'routing…';
    return (
      <div className={`conn-readout ${stats.routed === true || (stats.status === 'done' && stats.terminals >= 2) ? 'ok' : ''}`}>
        <span className="conn-title">Route between pins</span>
        <span className="conn-value">{label}</span>
        <span className="conn-sub">
          {stats.terminals} terminal{stats.terminals === 1 ? '' : 's'} · {stats.components} component
          {stats.components === 1 ? '' : 's'} so far
        </span>
      </div>
    );
  }
  const ok = stats.components <= 1;
  return (
    <div className={`conn-readout ${ok ? 'ok' : ''}`}>
      <span className="conn-title">One connected network</span>
      <span className="conn-value">{stats.components === 0 ? 'no connectors yet' : `${stats.components} component${stats.components === 1 ? '' : 's'}`}</span>
      <span className="conn-sub">{ok ? (stats.status === 'done' ? 'fully connected' : 'connected so far') : 'still fragmenting — will be forced to merge'}</span>
    </div>
  );
}
