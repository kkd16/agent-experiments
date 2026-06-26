// Live safety panel: every protocol invariant, green when it holds, red the
// instant it is violated. The whole point of the simulator is that these stay
// green no matter how cruel the network is.
import type { InvariantResult } from '../sim/types';

interface Props {
  invariants: InvariantResult[];
  title?: string;
}

export function InvariantPanel({ invariants, title = 'Safety invariants' }: Props) {
  const allOk = invariants.every((i) => i.ok);
  return (
    <div className="invariant-panel">
      <div className="panel-head">
        <span>{title}</span>
        <span className={`status-pill ${allOk ? 'ok' : 'bad'}`}>{allOk ? 'HOLDING' : 'VIOLATED'}</span>
      </div>
      <div className="invariant-list">
        {invariants.length === 0 && <div className="muted pad">No invariants for this lab.</div>}
        {invariants.map((inv) => (
          <div className={`invariant-row ${inv.ok ? 'ok' : 'bad'}`} key={inv.name}>
            <span className="inv-mark">{inv.ok ? '✓' : '✕'}</span>
            <div className="inv-text">
              <div className="inv-name">{inv.name}</div>
              <div className="inv-detail">{inv.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
