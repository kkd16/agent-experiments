import { useMemo } from 'react';
import type { NTM } from '../../engine/ntm';
import { scoreSample, type NtmSample } from '../../engine/ntmtasks';
import Heatmap from './Heatmap';

interface Props {
  model: NTM;
  probe: NtmSample;
  tick: number;
}

// The task, end to end: the input bit-stream the controller sees, the target the machine must
// reproduce on the answer steps, and the machine's actual output probabilities — so you can watch
// the recalled sequence sharpen from grey noise into the exact target as training proceeds.
export default function SequenceView({ model, probe, tick }: Props) {
  const { probs, solved, bitAcc } = useMemo(() => {
    const { logits } = model.forward(probe.inputs);
    const W = probe.outputWidth;
    const T = logits.length;
    const p = new Float64Array(T * W);
    for (let t = 0; t < T; t++) {
      for (let j = 0; j < W; j++) p[t * W + j] = 1 / (1 + Math.exp(-logits[t].data[j]));
    }
    const sc = scoreSample(logits, probe);
    return { probs: p, solved: sc.solved, bitAcc: sc.bitTotal ? sc.bitCorrect / sc.bitTotal : 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, probe, tick]);

  const T = probe.inputs.length;
  const W = probe.outputWidth;
  const IW = probe.inputWidth;

  // Input raster: [IW × T] (features as rows, time as cols).
  const inputMat = new Float64Array(IW * T);
  for (let t = 0; t < T; t++) for (let j = 0; j < IW; j++) inputMat[j * T + t] = probe.inputs[t][j];

  // Target and output rasters over the scored steps, aligned to the full timeline (blank where
  // not scored, so the answer phase lines up under the input phase).
  const targetMat = new Float64Array(W * T);
  const outMat = new Float64Array(W * T);
  for (let t = 0; t < T; t++) {
    for (let j = 0; j < W; j++) {
      targetMat[j * T + t] = probe.scored[t] ? probe.targets[t][j] : 0;
      outMat[j * T + t] = probe.scored[t] ? probs[t * W + j] : 0;
    }
  }

  const cell = T > 26 ? 8 : 11;
  const colLabels = Array.from({ length: T }, (_, t) => (probe.scored[t] ? '·' : ''));

  const dataLabels = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? 'bit' : ''));

  return (
    <div className="card">
      <div className="card-title">
        Task I/O <span className="muted small">· probe · bit-accuracy {(bitAcc * 100).toFixed(0)}% {solved ? '· ✓ solved' : ''}</span>
      </div>
      <div className="ntm-io">
        <div className="ntm-io-row">
          <span className="ntm-io-tag">input</span>
          <Heatmap data={inputMat} rows={IW} cols={T} cell={cell} palette="bits" vmax={1} rowLabels={dataLabels(IW)} />
        </div>
        <div className="ntm-io-row">
          <span className="ntm-io-tag">target</span>
          <Heatmap data={targetMat} rows={W} cols={T} cell={cell} palette="bits" vmax={1} rowLabels={dataLabels(W)} />
        </div>
        <div className="ntm-io-row">
          <span className="ntm-io-tag">output</span>
          <Heatmap data={outMat} rows={W} cols={T} cell={cell} palette="bits" vmax={1} rowLabels={dataLabels(W)} colLabels={colLabels} />
        </div>
      </div>
      <p className="muted small chart-foot">
        The last input channels are control flags (start-of-output / repeat count / query marker);
        the model reads zeros during the answer phase and must reconstruct the target from memory
        alone. <span className="muted">·</span> marks scored steps.
      </p>
    </div>
  );
}
