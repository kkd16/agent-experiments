import { useMemo } from 'react';
import type { RecurrentLM } from '../../engine/recurrent';
import { makeSample, tokenLabel, type RnnTaskKind } from '../../engine/charseq';
import { maskedCrossEntropy } from '../../engine/losses';
import { mulberry32 } from '../../engine/nn';

interface Props {
  model: RecurrentLM;
  task: RnnTaskKind;
  len: number;
  tick: number;
}

// A few held-out examples scored by teacher forcing: at every graded step show the model's argmax
// next to the target, coloured by correctness, plus the per-example loss.
export default function SamplePredictions({ model, task, len, tick }: Props) {
  const rows = useMemo(() => {
    const rng = mulberry32(0x5151);
    const out: { loss: number; cells: { pred: string; want: string; ok: boolean }[] }[] = [];
    const V = model.cfg.vocab;
    for (let s = 0; s < 6; s++) {
      const ex = makeSample(task, len, rng);
      const logits = model.forward(ex.input);
      const loss = maskedCrossEntropy(logits, ex.target, ex.keep).loss.data[0];
      const cells: { pred: string; want: string; ok: boolean }[] = [];
      for (let i = 0; i < ex.target.length; i++) {
        if (!ex.keep[i]) continue;
        let best = 0;
        let bv = -Infinity;
        for (let j = 0; j < V; j++) {
          const v = logits.data[i * V + j];
          if (v > bv) {
            bv = v;
            best = j;
          }
        }
        cells.push({ pred: tokenLabel(task, best), want: tokenLabel(task, ex.target[i]), ok: best === ex.target[i] });
      }
      out.push({ loss, cells });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, task, len, tick]);

  return (
    <div className="card">
      <div className="card-title">
        Held-out predictions <span className="muted small">· teacher-forced argmax vs target</span>
      </div>
      <div className="rnn-preds">
        {rows.map((r, i) => (
          <div className="rnn-pred-row" key={i}>
            <div className="rnn-pred-cells">
              {r.cells.map((c, j) => (
                <span key={j} className={`rnn-pred-tok ${c.ok ? 'ok' : 'bad'}`} title={`target ${c.want}`}>
                  {c.pred}
                </span>
              ))}
            </div>
            <span className="muted small rnn-pred-loss">L={r.loss.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
