import { useMemo } from 'react';
import type { MoEGPT } from '../../engine/moe';
import { useMoETrainer } from '../../hooks/useMoETrainer';
import { TOKENS } from '../../engine/seqtasks';

interface Props {
  moe: MoEGPT;
  routingStats: ReturnType<typeof useMoETrainer>['routingStats'];
  tick: number;
}

function cell(v: number): string {
  const x = Math.max(0, Math.min(1, v));
  // dark → amber, so it reads differently from the violet router map
  const r = Math.round(20 + (251 - 20) * x);
  const g = Math.round(24 + (191 - 24) * x);
  const b = Math.round(38 + (36 - 38) * x);
  return `rgb(${r},${g},${b})`;
}

// What did each expert specialise in? For every token, its top-1 expert "votes" for that token's
// identity; row-normalising gives, per expert, the distribution of token types it tends to take.
// On structured tasks the experts carve up the vocabulary — a concrete, legible read on the
// division of labour the router learned.
export default function ExpertSpecialization({ moe, routingStats, tick }: Props) {
  void moe;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => routingStats(), [routingStats, tick]);
  if (!stats) return null;

  return (
    <div className="card">
      <div className="card-title">
        Expert specialisation{' '}
        <span className="muted small">· per expert, the token types it tends to take (top-1, row-normalised)</span>
      </div>
      <div className="moe-spec">
        <div className="moe-spec-head">
          <span className="moe-spec-corner" />
          {TOKENS.map((t, j) => (
            <span key={j} className="moe-spec-coltok">
              {t}
            </span>
          ))}
        </div>
        {stats.spec.map((row, e) => (
          <div key={e} className="moe-spec-row">
            <span className="moe-spec-name">E{e}</span>
            {row.map((v, j) => (
              <span
                key={j}
                className="moe-spec-cell"
                style={{ background: cell(v) }}
                title={`E${e} · "${TOKENS[j]}" ${(v * 100).toFixed(0)}%`}
              />
            ))}
            <span className="moe-spec-load muted small">{(stats.util[e] * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
