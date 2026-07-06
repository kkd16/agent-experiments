import { useMemo, useState } from 'react';
import type { GPT } from '../../engine/transformer';
import { mulberry32 } from '../../engine/nn';
import { TOK_EQ, TOK_PLUS, tokenLabel, type SeqTaskKind } from '../../engine/seqtasks';

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

export default function GenerateBox({ gpt, task, digits, tick }: Props) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [exampleSeed, setExampleSeed] = useState(0);
  const [sampleNonce, setSampleNonce] = useState(0);
  const [temp, setTemp] = useState(0); // 0 ⇒ greedy
  const [topK, setTopK] = useState(0); // 0 ⇒ off
  const [topP, setTopP] = useState(1); // 1 ⇒ off

  const parse = (s: string): number[] => {
    const ds = s.replace(/\D/g, '').slice(-digits).split('').map(Number);
    while (ds.length < digits) ds.unshift(0); // pad with leading zeros (MSB-first, fixed width)
    return ds;
  };

  const inputs = useMemo(() => {
    if (a === '' && b === '') {
      // A fresh random example, re-rolled deterministically each time the dice button bumps `exampleSeed`.
      const rng = mulberry32((exampleSeed * 2654435761 + digits * 40503) >>> 0);
      const ra = () => Math.floor(rng() * 10);
      const da = Array.from({ length: digits }, ra);
      const db = Array.from({ length: digits }, ra);
      return { da, db, placeholder: true };
    }
    return { da: parse(a), db: parse(b), placeholder: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, digits, exampleSeed]);

  const result = useMemo(() => {
    const { ids, answerLen } = buildPrompt(task, inputs.da, inputs.db);
    // A KV-cache decode (O(L²) instead of the greedy path's O(L³)) that returns each step's
    // sampled token and the probability the model put on it — identical to the batched forward
    // when greedy, and a true temperature/top-k/top-p sampler otherwise.
    const rng = mulberry32((sampleNonce * 40503 + exampleSeed * 2246822519 + 0x9e37) >>> 0);
    const { steps } = gpt.decode(Int32Array.from(ids), answerLen, { temperature: temp, topK, topP }, rng);
    const expected = expectedAnswer(task, inputs.da, inputs.db, digits);
    const cells = steps.map((s, i) => ({
      ch: tokenLabel(s.tok),
      prob: s.prob,
      ok: s.tok === expected[i],
    }));
    const correct = cells.every((c) => c.ok);
    return { cells, expected: expected.map(tokenLabel).join(''), correct };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpt, task, inputs, digits, tick, temp, topK, topP, sampleNonce]);

  const promptStr =
    task === 'add'
      ? `${inputs.da.join('')}+${inputs.db.join('')}=`
      : `${inputs.da.join('')}=`;

  const sampling = temp > 0;

  return (
    <div className="card">
      <div className="card-title">
        Try it{' '}
        <span className="muted small">
          · type a problem — a KV-cache decoder runs it token by token, with per-step confidence
        </span>
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
            setExampleSeed((s) => s + 1);
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
              <span className={sampling ? 'd-samp' : c.ok ? 'd-ok' : 'd-bad'}>{c.ch}</span>
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

      <div className="gen-sampler">
        <div className="field tight">
          <span>
            temperature <b>{temp === 0 ? 'greedy' : temp.toFixed(2)}</b>
          </span>
          <input type="range" min={0} max={1.5} step={0.05} value={temp} onChange={(e) => setTemp(Number(e.target.value))} />
        </div>
        <div className="two">
          <div className="field tight">
            <span>
              top-k <b>{topK === 0 ? 'off' : topK}</b>
            </span>
            <input
              type="range"
              min={0}
              max={12}
              step={1}
              value={topK}
              disabled={!sampling}
              onChange={(e) => setTopK(Number(e.target.value))}
            />
          </div>
          <div className="field tight">
            <span>
              top-p <b>{topP >= 1 ? 'off' : topP.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={topP}
              disabled={!sampling}
              onChange={(e) => setTopP(Number(e.target.value))}
            />
          </div>
        </div>
        <button
          className="ghost wide"
          disabled={!sampling}
          onClick={() => setSampleNonce((n) => n + 1)}
          title="draw a new sample"
        >
          ↻ resample
        </button>
        <p className="muted small chart-foot">
          {sampling
            ? 'Sampling from the (temperature-scaled, top-k / nucleus-filtered) distribution — resample to see the model’s spread.'
            : 'Greedy decode: always the argmax. Raise the temperature to sample, and the answer may drift.'}
        </p>
      </div>
    </div>
  );
}
