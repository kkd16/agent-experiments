import { useMemo, useState } from 'react';
import type { GPT } from '../../engine/transformer';
import { mulberry32 } from '../../engine/nn';
import { TOK_EQ, TOK_PLUS, VOCAB, tokenLabel, type SeqTaskKind } from '../../engine/seqtasks';

interface Props {
  gpt: GPT;
  task: SeqTaskKind;
  digits: number;
  tick: number;
}

// Build the prompt token ids for a given task from raw digit arrays, matching makeSample.
function buildPrompt(task: SeqTaskKind, a: number[], b: number[]): { ids: number[]; answerLen: number } {
  if (task === 'add') {
    return { ids: [...a, TOK_PLUS, ...b, TOK_EQ], answerLen: Math.max(a.length, b.length) + 1 };
  }
  return { ids: [...a, TOK_EQ], answerLen: a.length };
}

function expectedAnswer(task: SeqTaskKind, a: number[], b: number[], n: number): number[] {
  if (task === 'copy') return a.slice();
  if (task === 'reverse') return a.slice().reverse();
  if (task === 'sort') return a.slice().sort((x, y) => x - y);
  const av = a.reduce((s, d) => s * 10 + d, 0);
  const bv = b.reduce((s, d) => s * 10 + d, 0);
  return (av + bv)
    .toString()
    .padStart(n + 1, '0')
    .split('')
    .map((c) => c.charCodeAt(0) - 48);
}

// Greedy decode that also records the softmax probability of each chosen token, so the UI can
// show how confident the model was at every step.
function decodeWithConfidence(gpt: GPT, prompt: number[], count: number) {
  const out = prompt.slice();
  const steps: { tok: number; prob: number }[] = [];
  for (let i = 0; i < count; i++) {
    const logits = gpt.forward(Int32Array.from(out));
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

export default function GenerateBox({ gpt, task, digits, tick }: Props) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [seed, setSeed] = useState(0);

  const parse = (s: string): number[] => {
    const ds = s.replace(/\D/g, '').slice(-digits).split('').map(Number);
    while (ds.length < digits) ds.unshift(0); // pad with leading zeros (MSB-first, fixed width)
    return ds;
  };

  const inputs = useMemo(() => {
    if (a === '' && b === '') {
      // A fresh random example, re-rolled deterministically each time the dice button bumps `seed`.
      const rng = mulberry32((seed * 2654435761 + digits * 40503) >>> 0);
      const ra = () => Math.floor(rng() * 10);
      const da = Array.from({ length: digits }, ra);
      const db = Array.from({ length: digits }, ra);
      return { da, db, placeholder: true };
    }
    return { da: parse(a), db: parse(b), placeholder: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, digits, seed]);

  const result = useMemo(() => {
    const { ids, answerLen } = buildPrompt(task, inputs.da, inputs.db);
    const steps = decodeWithConfidence(gpt, ids, answerLen);
    const expected = expectedAnswer(task, inputs.da, inputs.db, digits);
    const cells = steps.map((s, i) => ({
      ch: tokenLabel(s.tok),
      prob: s.prob,
      ok: s.tok === expected[i],
    }));
    const correct = cells.every((c) => c.ok);
    return { cells, expected: expected.map(tokenLabel).join(''), correct };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpt, task, inputs, digits, tick]);

  const promptStr =
    task === 'add'
      ? `${inputs.da.join('')}+${inputs.db.join('')}=`
      : `${inputs.da.join('')}=`;

  return (
    <div className="card">
      <div className="card-title">
        Try it <span className="muted small">· type a problem and watch it decode, with per-token confidence</span>
      </div>
      <div className="gen-inputs">
        <input
          value={a}
          onChange={(e) => setA(e.target.value)}
          placeholder={inputs.placeholder ? inputs.da.join('') : ''}
          inputMode="numeric"
          maxLength={digits}
          aria-label="first operand"
        />
        {task === 'add' && (
          <>
            <span className="gen-op">+</span>
            <input
              value={b}
              onChange={(e) => setB(e.target.value)}
              placeholder={inputs.placeholder ? inputs.db.join('') : ''}
              inputMode="numeric"
              maxLength={digits}
              aria-label="second operand"
            />
          </>
        )}
        <button
          className="ghost"
          onClick={() => {
            setA('');
            setB('');
            setSeed((s) => s + 1);
          }}
          title="random example"
        >
          ⟳
        </button>
      </div>
      <div className="gen-out">
        <span className="gen-prompt">{promptStr}</span>
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
