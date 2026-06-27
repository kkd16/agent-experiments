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

// Runs a capture forward over a fixed probe sequence and shows the top-layer hidden state (and,
// for an LSTM, the cell state) evolving step by step — the "memory tape" the recurrence carries.
export default function HiddenStateView({ model, task, sample, tick }: Props) {
  const trace = useMemo(() => {
    model.forward(sample.input, true);
    return model.lastTrace;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, sample, tick]);

  if (!trace) return null;
  const colLabels = Array.from(sample.input, (id) => tokenLabel(task, id));

  return (
    <div className="card">
      <div className="card-title">
        Hidden state through time <span className="muted small">· top layer · {trace.cell.toUpperCase()}</span>
      </div>
      <p className="muted small">
        Each column is a timestep, each row a hidden unit; blue ▸ positive, pink ▸ negative (tanh range). The state is
        the only thing carried forward — everything the net "remembers" lives here.
      </p>
      <ActivationHeatmap series={trace.hidden} signed height={Math.min(180, Math.max(80, trace.H * 5))} colLabels={colLabels} />
      {trace.cellState && (
        <>
          <div className="muted small rnn-sub">Cell state c_t <span className="muted">· the LSTM's protected memory highway</span></div>
          <ActivationHeatmap series={trace.cellState} signed height={Math.min(180, Math.max(80, trace.H * 5))} />
        </>
      )}
    </div>
  );
}
