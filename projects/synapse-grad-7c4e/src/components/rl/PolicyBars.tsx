import type { RLHandle, DemoInfo } from '../../hooks/useRLTrainer';
import { PENDULUM_LIMITS } from '../../engine/rl-env';

interface Props {
  handle: RLHandle;
  tick: number;
  demoInfo: () => DemoInfo;
  usesCritic: boolean;
}

// For a discrete policy: the action distribution π(a|s) for the state the demo agent is in *right
// now*, with the chosen action highlighted — watch it sharpen from near-uniform toward a confident
// choice as training proceeds. For a continuous (Gaussian) policy: the mean μ and the ±σ spread of
// the torque, with the sampled action marked, over the env's action range.
export default function PolicyBars({ handle, demoInfo, usesCritic }: Props) {
  const env = handle.env;
  const info = demoInfo();

  if (info.continuous) {
    const range = PENDULUM_LIMITS.maxTorque; // symmetric ±range
    const mu = info.mean ? info.mean[0] : 0;
    const sd = info.std ? info.std[0] : 0;
    const act = info.actionVec ? info.actionVec[0] : mu;
    const toPct = (v: number) => ((Math.max(-range, Math.min(range, v)) + range) / (2 * range)) * 100;
    const muPct = toPct(mu);
    const loPct = toPct(mu - sd);
    const hiPct = toPct(mu + sd);
    const actPct = toPct(act);
    return (
      <div className="policy-bars">
        <div className="gauss-row">
          <span className="pbar-label">torque</span>
          <span className="gauss-track">
            <span className="gauss-zero" />
            <span className="gauss-band" style={{ left: `${loPct}%`, width: `${Math.max(1, hiPct - loPct)}%` }} />
            <span className="gauss-mean" style={{ left: `${muPct}%` }} />
            <span className="gauss-action" style={{ left: `${actPct}%` }} />
          </span>
        </div>
        <div className="gauss-readout">
          <span>
            μ <b>{mu.toFixed(2)}</b>
          </span>
          <span>
            σ <b>{sd.toFixed(2)}</b>
          </span>
          <span>
            a <b>{act.toFixed(2)}</b>
          </span>
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          range [−{range}, {range}] · the green tick is the sampled action
        </div>
        {usesCritic && (
          <div className="pbar-value">
            critic V(s) <b>{Number.isFinite(info.value) ? info.value.toFixed(2) : '—'}</b>
          </div>
        )}
      </div>
    );
  }

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
