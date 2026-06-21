import type { RLHandle, DemoInfo } from '../../hooks/useRLTrainer';

interface Props {
  handle: RLHandle;
  tick: number;
  demoInfo: () => DemoInfo;
  usesCritic: boolean;
}

// The policy's action distribution for the state the demo agent is in *right now*, plus the
// critic's value estimate. The chosen action's bar is highlighted — watch the distribution sharpen
// from near-uniform (random) toward a confident, near-deterministic choice as training proceeds.
export default function PolicyBars({ handle, demoInfo, usesCritic }: Props) {
  const env = handle.env;
  const info = demoInfo();
  const labels = env ? env.actionLabels : [];
  const probs = info.probs;

  return (
    <div className="policy-bars">
      {labels.map((label, i) => {
        const p = probs && i < probs.length ? probs[i] : 0;
        const chosen = i === info.action;
        return (
          <div className={`pbar-row${chosen ? ' chosen' : ''}`} key={i}>
            <span className="pbar-label">{label}</span>
            <span className="pbar-track">
              <span className="pbar-fill" style={{ width: `${Math.max(1, p * 100)}%` }} />
            </span>
            <span className="pbar-val">{(p * 100).toFixed(0)}%</span>
          </div>
        );
      })}
      {usesCritic && (
        <div className="pbar-value">
          critic V(s) <b>{Number.isFinite(info.value) ? info.value.toFixed(2) : '—'}</b>
        </div>
      )}
    </div>
  );
}
