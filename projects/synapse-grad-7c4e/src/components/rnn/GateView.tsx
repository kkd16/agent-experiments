import { useMemo } from 'react';
import type { RecurrentLM } from '../../engine/recurrent';
import type { RnnSample, RnnTaskKind } from '../../engine/charseq';
import { tokenLabel } from '../../engine/charseq';
import ActivationHeatmap from './ActivationHeatmap';

interface Props {
  model: RecurrentLM;
  task: RnnTaskKind;
  sample: RnnSample;
  tick: number;
}

// The gate activations that make a GRU/LSTM gated: the sigmoid gates (in [0,1], how much to
// keep/write/expose) and the tanh candidate (in [-1,1], what to write). Watching the forget gate
// stay near 1 over distractors is *why* the cell remembers.
export default function GateView({ model, task, sample, tick }: Props) {
  const trace = useMemo(() => {
    model.forward(sample.input, true);
    return model.lastTrace;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, sample, tick]);

  if (!trace || !trace.gates) return null;
  const colLabels = Array.from(sample.input, (id) => tokenLabel(task, id));
  const bandH = Math.min(120, Math.max(56, trace.H * 4));

  return (
    <div className="card">
      <div className="card-title">
        Gate activations <span className="muted small">· {trace.cell.toUpperCase()} · per timestep</span>
      </div>
      <p className="muted small">
        Sigmoid gates run 0→1 (dark→blue): how much memory to keep or write. The candidate is signed (blue/pink).
      </p>
      <div className="rnn-gates">
        {trace.gates.map((g, i) => {
          const isCandidate = g.name.startsWith('n') || g.name.startsWith('g') || g.name.startsWith('h');
          return (
            <div className="rnn-gate" key={g.name}>
              <div className="muted small rnn-gate-name">{g.name}</div>
              <ActivationHeatmap
                series={g.series}
                signed={isCandidate}
                height={bandH}
                colLabels={i === trace.gates!.length - 1 ? colLabels : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
