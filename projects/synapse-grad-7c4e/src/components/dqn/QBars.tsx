import type { DQNHandle, DQNDemoInfo } from '../../hooks/useDQNTrainer';

interface Props {
  handle: DQNHandle;
  tick: number;
  demoInfo: () => DQNDemoInfo;
}

// The per-action Q-values Q(s,a) for the state the greedy demo agent is in right now — the
// quantity DQN actually learns. Bars are signed (a diverging fill around zero), the greedy
// (argmax) action is highlighted, and the numeric value is shown. Watch the bars separate as the
// net learns which action is worth more from each state.
export default function QBars({ handle, demoInfo }: Props) {
  const env = handle.env;
  const info = demoInfo();
  const labels = env ? env.actionLabels : [];
  const q = info.q;
  if (!q || labels.length === 0) {
    return <div className="policy-bars muted small">waiting for the first frame…</div>;
  }
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < q.length; i++) {
    lo = Math.min(lo, q[i]);
    hi = Math.max(hi, q[i]);
  }
  const span = Math.max(hi - lo, 1e-6);
  const zeroPct = ((0 - lo) / span) * 100;

  return (
    <div className="policy-bars">
      {labels.map((label, i) => {
        const v = i < q.length ? q[i] : 0;
        const chosen = i === info.greedy;
        const leftPct = ((Math.min(0, v) - lo) / span) * 100;
        const widthPct = (Math.abs(v) / span) * 100;
        return (
          <div className={`pbar-row${chosen ? ' chosen' : ''}`} key={i}>
            <span className="pbar-label">{label}</span>
            <span className="pbar-track" style={{ position: 'relative' }}>
              <span
                style={{
                  position: 'absolute',
                  left: `${zeroPct}%`,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: 'rgba(148,163,184,0.5)',
                }}
              />
              <span
                className="pbar-fill"
                style={{
                  position: 'absolute',
                  left: `${leftPct}%`,
                  width: `${Math.max(1, widthPct)}%`,
                  background: chosen ? '#4ade80' : v >= 0 ? '#38bdf8' : '#fb7185',
                }}
              />
            </span>
            <span className="pbar-val">{v.toFixed(2)}</span>
          </div>
        );
      })}
      <div className="pbar-value">
        greedy V(s) = max_a Q <b>{Number.isFinite(info.value) ? info.value.toFixed(2) : '—'}</b>
      </div>
    </div>
  );
}
