import { useMemo, useState } from 'react';
import type { MambaLM } from '../../engine/ssm';
import { mulberry32 } from '../../engine/nn';
import { makeSample, tokenLabel, VOCAB, type SsmTaskKind } from '../../engine/ssmtasks';

interface Props {
  model: MambaLM;
  task: SsmTaskKind;
  n: number;
  tick: number;
}

function decodeWithConfidence(model: MambaLM, prompt: number[], count: number) {
  const out = prompt.slice();
  const steps: { tok: number; prob: number }[] = [];
  for (let i = 0; i < count; i++) {
    const logits = model.forward(Int32Array.from(out));
    const T = out.length;
    const base = (T - 1) * VOCAB;
    let max = -Infinity;
    for (let j = 0; j < VOCAB; j++) max = Math.max(max, logits.data[base + j]);
    let sum = 0;
    const probs = new Float64Array(VOCAB);
    for (let j = 0; j < VOCAB; j++) {
      const e = Math.exp(logits.data[base + j] - max);
      probs[j] = e;
      sum += e;
    }
    let best = 0;
    for (let j = 0; j < VOCAB; j++) {
      probs[j] /= sum;
      if (probs[j] > probs[best]) best = j;
    }
    steps.push({ tok: best, prob: probs[best] });
    out.push(best);
  }
  return steps;
}

// Draw a fresh held-out problem and watch the SSM decode it token-by-token, with per-token
// confidence bars — the prompt structure is task-specific (a field of blanks, key→value pairs,
// or a digit string), so a random example is the cleanest "try it".
export default function SsmGenerateBox({ model, task, n, tick }: Props) {
  const [seed, setSeed] = useState(0);

  const ex = useMemo(
    () => makeSample(task, n, mulberry32((seed * 2654435761 + n * 40503) >>> 0)),
    [task, n, seed],
  );

  const result = useMemo(() => {
    const promptLen = ex.answerStart;
    const answerLen = ex.answerEnd - ex.answerStart;
    const steps = decodeWithConfidence(model, Array.from(ex.tokens.subarray(0, promptLen)), answerLen);
    const cells = steps.map((s, i) => ({
      ch: tokenLabel(s.tok),
      prob: s.prob,
      ok: s.tok === ex.tokens[ex.answerStart + i],
    }));
    const correct = cells.every((c) => c.ok);
    const expected = Array.from(ex.tokens.subarray(ex.answerStart, ex.answerEnd), tokenLabel).join('');
    return { cells, expected, correct };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, ex, tick]);

  const promptStr = Array.from(ex.tokens.subarray(0, ex.answerStart), tokenLabel).join('');

  return (
    <div className="card">
      <div className="card-title">
        Try it <span className="muted small">· a fresh example decoded token-by-token with confidence</span>
      </div>
      <div className="gen-inputs">
        <button className="ghost" onClick={() => setSeed((s) => s + 1)} title="new random example">
          ⟳ new example
        </button>
      </div>
      <div className="gen-out">
        <span className="gen-prompt">{promptStr}</span>
        <span className="gen-arrow">→</span>
        <span className="gen-answer">
          {result.cells.map((c, i) => (
            <span key={i} className="gen-cell">
              <span className={c.ok ? 'd-ok' : 'd-bad'}>{c.ch}</span>
              <span className="gen-bar">
                <span className="gen-bar-fill" style={{ height: `${Math.round(c.prob * 100)}%` }} />
              </span>
            </span>
          ))}
        </span>
        <span className={`gen-verdict ${result.correct ? 'ok' : 'bad'}`}>
          {result.correct ? '✓' : `≠ ${result.expected}`}
        </span>
      </div>
    </div>
  );
}
