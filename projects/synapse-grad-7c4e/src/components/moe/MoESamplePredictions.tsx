import { useMemo } from 'react';
import type { MoEGPT } from '../../engine/moe';
import { makeSample, tokenLabel, type SeqTaskKind } from '../../engine/seqtasks';
import { mulberry32 } from '../../engine/nn';

interface Props {
  moe: MoEGPT;
  task: SeqTaskKind;
  digits: number;
  tick: number;
}

// A handful of held-out problems decoded greedily by the live sparse model — each answer token
// colored against ground truth so you can watch the MoE actually solve the task.
export default function MoESamplePredictions({ moe, task, digits, tick }: Props) {
  const samples = useMemo(() => {
    const rng = mulberry32(0xbeef ^ (digits * 131));
    return Array.from({ length: 7 }, () => makeSample(task, digits, rng));
  }, [task, digits]);

  const rows = useMemo(() => {
    return samples.map((ex) => {
      const promptLen = ex.answerStart;
      const answerLen = ex.answerEnd - ex.answerStart;
      const out = moe.generate(ex.tokens.subarray(0, promptLen), answerLen);
      const prompt = Array.from(ex.tokens.subarray(0, promptLen), tokenLabel).join('');
      const predicted: { ch: string; ok: boolean }[] = [];
      let allOk = true;
      for (let i = 0; i < answerLen; i++) {
        const got = out[promptLen + i];
        const want = ex.tokens[ex.answerStart + i];
        const ok = got === want;
        if (!ok) allOk = false;
        predicted.push({ ch: tokenLabel(got), ok });
      }
      const truth = Array.from(ex.tokens.subarray(ex.answerStart, ex.answerEnd), tokenLabel).join('');
      return { prompt, predicted, truth, allOk };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moe, samples, tick]);

  const solved = rows.filter((r) => r.allOk).length;

  return (
    <div className="card">
      <div className="card-title">
        Live decoding{' '}
        <span className="muted small">
          · {solved}/{rows.length} solved (greedy, autoregressive)
        </span>
      </div>
      <div className="pred-list">
        {rows.map((r, i) => (
          <div key={i} className={`pred-row ${r.allOk ? 'ok' : 'bad'}`}>
            <span className="pred-prompt">{r.prompt}</span>
            <span className="pred-arrow">→</span>
            <span className="pred-answer">
              {r.predicted.map((p, j) => (
                <span key={j} className={p.ok ? 'd-ok' : 'd-bad'}>
                  {p.ch}
                </span>
              ))}
            </span>
            {!r.allOk && <span className="pred-truth">({r.truth})</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
