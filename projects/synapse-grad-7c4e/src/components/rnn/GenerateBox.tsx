import { useMemo, useState } from 'react';
import type { RecurrentLM } from '../../engine/recurrent';
import { makeSample, tokenLabel, tokensToString, vocabSize, type RnnTaskKind } from '../../engine/charseq';
import { mulberry32 } from '../../engine/nn';

interface Props {
  model: RecurrentLM;
  task: RnnTaskKind;
  len: number;
}

interface GenState {
  prompt: string;
  produced: { ch: string; correct: boolean | null }[];
}

// Autoregressive sampling. For recall/copy it feeds a fresh prompt and checks the reproduction
// against ground truth (per-token green/red); for the language model it samples a continuation
// from a seed at the chosen temperature. Sampling is button-driven (not per training frame) so a
// 64-token language sample doesn't re-run on every animation tick.
export default function GenerateBox({ model, task, len }: Props) {
  const [temp, setTemp] = useState(task === 'lang' ? 0.7 : 0);
  const [seedCtr, setSeedCtr] = useState(0);

  const out: GenState = useMemo(() => {
    const rng = mulberry32((0x9e37 ^ (seedCtr * 2654435761)) >>> 0);
    if (task === 'lang') {
      const V = vocabSize('lang');
      let start = 0;
      for (let j = 0; j < V; j++) if (tokenLabel('lang', j) === 't') start = j;
      const gen = model.generate(Int32Array.from([start]), 64, temp, rng);
      return { prompt: '', produced: Array.from(gen, (id) => ({ ch: tokenLabel('lang', id), correct: null })) };
    }
    const ex = makeSample(task, len, rng);
    const count = task === 'recall' ? 1 : len;
    const promptIds = ex.input.subarray(0, ex.promptLen);
    const gen = model.generate(promptIds, count, temp, rng);
    const truth: number[] = [];
    for (let i = ex.promptLen - 1; i < ex.target.length; i++) truth.push(ex.target[i]);
    const produced: { ch: string; correct: boolean | null }[] = [];
    for (let i = 0; i < count; i++) {
      const id = gen[ex.promptLen + i];
      produced.push({ ch: tokenLabel(task, id), correct: id === truth[i] });
    }
    return { prompt: tokensToString(task, promptIds), produced };
  }, [model, task, len, temp, seedCtr]);

  const allOk = out.produced.length > 0 && out.produced.every((p) => p.correct !== false);

  return (
    <div className="card">
      <div className="card-title">
        {task === 'lang' ? 'Sample from the language model' : 'Generate & check'}
        {task !== 'lang' && (
          <span className={`pill ${allOk ? 'ok' : 'bad'}`}>{allOk ? 'correct' : 'wrong'}</span>
        )}
      </div>
      <div className="rnn-gen-out">
        {out.prompt && <span className="rnn-gen-prompt">{out.prompt}</span>}
        {task === 'lang' ? (
          <span className="rnn-gen-text">{out.produced.map((p) => p.ch).join('')}</span>
        ) : (
          out.produced.map((p, i) => (
            <span key={i} className={`rnn-gen-tok ${p.correct === null ? '' : p.correct ? 'ok' : 'bad'}`}>
              {p.ch}
            </span>
          ))
        )}
      </div>
      <div className="rnn-gen-ctl">
        <button className="ghost" onClick={() => setSeedCtr((c) => c + 1)}>
          {task === 'lang' ? '↻ Sample again' : '↻ New example'}
        </button>
        {task === 'lang' && (
          <label className="field rnn-temp">
            <span>
              temperature <b>{temp.toFixed(2)}</b>
            </span>
            <input type="range" min={0.2} max={1.4} step={0.05} value={temp} onChange={(e) => setTemp(Number(e.target.value))} />
          </label>
        )}
      </div>
    </div>
  );
}
