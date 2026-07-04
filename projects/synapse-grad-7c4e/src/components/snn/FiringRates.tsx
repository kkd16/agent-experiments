import type { SnnMetrics } from '../../hooks/useSnnTrainer';

interface Props {
  metrics: SnnMetrics;
}

// The energy story. Spiking nets are attractive because they are *sparse and event-driven*: a
// neuron costs energy only when it fires, so the total spike count per inference is a direct proxy
// for the joules a neuromorphic chip would spend. We surface the mean firing rate per layer, the
// overall sparsity, and the spikes-per-classification figure that a rate-regularizer trades against
// accuracy.
export default function FiringRates({ metrics }: Props) {
  const rates = metrics.layerRates ?? [];
  const pct = (v: number) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—');
  return (
    <div className="firing">
      <div className="firing-stats">
        <div className="stat">
          <span className="muted small">sparsity</span>
          <b>{pct(metrics.sparsity)}</b>
        </div>
        <div className="stat">
          <span className="muted small">mean rate</span>
          <b>{pct(metrics.meanRate)}</b>
        </div>
        <div className="stat">
          <span className="muted small">spikes / inference</span>
          <b>{Number.isFinite(metrics.spikesPerInfer) ? Math.round(metrics.spikesPerInfer) : '—'}</b>
        </div>
      </div>
      <div className="firing-bars">
        {rates.map((r, i) => (
          <div className="firing-row" key={i}>
            <span className="firing-label muted small">LIF {i + 1}</span>
            <div className="firing-track">
              <div
                className="firing-fill"
                style={{ width: `${Math.min(100, (Number.isFinite(r) ? r : 0) * 100)}%` }}
              />
            </div>
            <span className="firing-val">{pct(r)}</span>
          </div>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        Firing rate = fraction of the {`{neuron × timestep}`} grid that spiked. Lower is cheaper; the spike-rate
        penalty pushes the code sparse without (much) hurting accuracy.
      </p>
    </div>
  );
}
