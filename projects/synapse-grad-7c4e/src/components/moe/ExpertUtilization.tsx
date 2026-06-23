import { useMemo } from 'react';
import type { MoEGPT } from '../../engine/moe';
import { useMoETrainer } from '../../hooks/useMoETrainer';

interface Props {
  moe: MoEGPT;
  routingStats: ReturnType<typeof useMoETrainer>['routingStats'];
  tick: number;
}

// Per-expert load over the held-out set, against the uniform ideal. The whole point of the
// load-balancing aux loss is to flatten these bars; the coefficient-of-variation number is the
// single-figure summary of how far from balanced the router still is.
export default function ExpertUtilization({ moe, routingStats, tick }: Props) {
  void moe;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => routingStats(), [routingStats, tick]);
  if (!stats) return null;
  const E = stats.nExperts;
  const ideal = 1 / E;
  const maxBar = Math.max(ideal * 1.6, ...stats.util, 1e-6);
  const balanced = stats.cv < 0.15;

  return (
    <div className="card">
      <div className="card-title">
        Expert load{' '}
        <span className="muted small">
          · share of token dispatches per expert (top-{stats.topK} routing over the eval set)
        </span>
      </div>
      <div className="moe-util">
        {stats.util.map((u, e) => (
          <div key={e} className="moe-util-row">
            <span className="moe-util-name">E{e}</span>
            <div className="moe-util-track">
              <div className="moe-util-ideal" style={{ left: `${(ideal / maxBar) * 100}%` }} />
              <div
                className="moe-util-fill"
                style={{ width: `${(u / maxBar) * 100}%`, opacity: 0.55 + 0.45 * (u / maxBar) }}
              />
            </div>
            <span className="moe-util-val">{(u * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
      <div className="moe-util-foot">
        <span className={`pill ${balanced ? 'ok' : 'warn'}`}>
          load imbalance (CV) <b>{stats.cv.toFixed(3)}</b>
        </span>
        <span className="muted small">
          dashed line = uniform {(ideal * 100).toFixed(0)}% · {balanced ? 'well balanced' : 'still specialising'}
        </span>
      </div>
    </div>
  );
}
