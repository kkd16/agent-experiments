// The structured event log: every send / drop / state change / commit, newest
// first, color-coded by kind and tagged with the node and virtual time.
import { useMemo, useState } from 'react';
import type { LogEntry } from '../sim/types';
import { fmtTime, logColor } from '../lib/format';

interface Props {
  log: LogEntry[];
  limit?: number;
}

const KINDS = ['all', 'send', 'state', 'commit', 'drop', 'crash', 'info'] as const;

export function Timeline({ log, limit = 220 }: Props) {
  const [filter, setFilter] = useState<(typeof KINDS)[number]>('all');
  const rows = useMemo(() => {
    const filtered = filter === 'all' ? log : log.filter((l) => l.kind === filter);
    return filtered.slice(-limit).reverse();
  }, [log, filter, limit]);

  return (
    <div className="timeline">
      <div className="panel-head">
        <span>Event log</span>
        <div className="chip-row">
          {KINDS.map((k) => (
            <button
              key={k}
              className={`chip ${filter === k ? 'on' : ''}`}
              onClick={() => setFilter(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="timeline-body">
        {rows.length === 0 && <div className="muted pad">No events yet — press Play.</div>}
        {rows.map((l) => (
          <div className="log-row" key={`${l.seq}`}>
            <span className="log-time">{fmtTime(l.time)}</span>
            <span className="log-node">{l.node}</span>
            <span className="log-dot" style={{ background: logColor(l.kind) }} />
            <span className="log-text">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
