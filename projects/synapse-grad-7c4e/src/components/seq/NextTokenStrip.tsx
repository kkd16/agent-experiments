import { useMemo } from 'react';
import type { GPT } from '../../engine/transformer';
import { VOCAB, tokenLabel } from '../../engine/seqtasks';

interface Props {
  gpt: GPT;
  probeIds: Int32Array;
  answerStart: number;
  tick: number;
}

// Teacher-forced: at every position the model sees the *true* prefix and predicts the next token.
// This strip shows that prediction — the argmax and its probability — beside the token that
// actually follows, so you can watch the answer span light up green as the model learns.
export default function NextTokenStrip({ gpt, probeIds, answerStart, tick }: Props) {
  const cells = useMemo(() => {
    const logits = gpt.forward(probeIds);
    const T = probeIds.length;
    const out: { pos: number; predicted: number; prob: number; actual: number; inAnswer: boolean; correct: boolean }[] = [];
    for (let i = 0; i < T - 1; i++) {
      const base = i * VOCAB;
      let mx = -Infinity;
      for (let j = 0; j < VOCAB; j++) mx = Math.max(mx, logits.data[base + j]);
      let sum = 0;
      let best = 0;
      const p = new Float64Array(VOCAB);
      for (let j = 0; j < VOCAB; j++) {
        const e = Math.exp(logits.data[base + j] - mx);
        p[j] = e;
        sum += e;
      }
      for (let j = 0; j < VOCAB; j++) {
        p[j] /= sum;
        if (p[j] > p[best]) best = j;
      }
      const actual = probeIds[i + 1];
      out.push({
        pos: i,
        predicted: best,
        prob: p[best],
        actual,
        inAnswer: i + 1 >= answerStart,
        correct: best === actual,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpt, probeIds, answerStart, tick]);

  return (
    <div className="card">
      <div className="card-title">
        Next-token predictions{' '}
        <span className="muted small">· teacher-forced argmax at each position vs. the token that truly follows</span>
      </div>
      <div className="nts-strip">
        {cells.map((c) => (
          <div
            key={c.pos}
            className={`nts-cell ${c.inAnswer ? 'ans' : 'ctx'} ${c.correct ? 'ok' : 'bad'}`}
            title={`pos ${c.pos}: predicts “${tokenLabel(c.predicted)}” (${(c.prob * 100).toFixed(0)}%), actual “${tokenLabel(c.actual)}”`}
          >
            <span className="nts-pred">{tokenLabel(c.predicted)}</span>
            <span className="nts-bar">
              <span className="nts-bar-fill" style={{ height: `${Math.round(c.prob * 100)}%` }} />
            </span>
            <span className="nts-actual">{tokenLabel(c.actual)}</span>
          </div>
        ))}
      </div>
      <p className="muted small chart-foot">
        Upper glyph = model’s prediction · bar = its confidence · lower glyph = the true next token · green = match.
        Cells right of the divider are the answer span.
      </p>
    </div>
  );
}
