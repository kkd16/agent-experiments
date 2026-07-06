import { useCallback, useEffect, useState } from 'react';
import type { GPT } from '../../engine/transformer';
import { makeSample, VOCAB, type SeqTaskKind } from '../../engine/seqtasks';
import { mulberry32 } from '../../engine/nn';

interface Props {
  gpt: GPT;
  task: SeqTaskKind;
  digits: number;
  tick: number;
  running: boolean;
}

interface HeadStat {
  layer: number;
  head: number;
  drop: number; // baseline − ablated answer-token accuracy (importance)
}

// Teacher-forced answer-token accuracy over a fixed probe set, optionally with one head lesioned.
function answerAccuracy(gpt: GPT, set: { ids: Int32Array; targets: Int32Array; keep: Uint8Array }[], ablated?: Set<string>): number {
  let total = 0;
  let correct = 0;
  for (const ex of set) {
    const logits = gpt.forward(ex.ids, false, ablated);
    for (let i = 0; i < ex.targets.length; i++) {
      if (!ex.keep[i]) continue;
      const base = i * VOCAB;
      let best = 0;
      for (let j = 1; j < VOCAB; j++) if (logits.data[base + j] > logits.data[base + best]) best = j;
      total++;
      if (best === ex.targets[i]) correct++;
    }
  }
  return total ? correct / total : 0;
}

export default function HeadInfluence({ gpt, task, digits, tick, running }: Props) {
  const [stats, setStats] = useState<HeadStat[]>([]);
  const [baseline, setBaseline] = useState(0);

  const measure = useCallback(() => {
    // A small fixed probe set so the study is deterministic across re-measures.
    const rng = mulberry32(0xbeef ^ (digits << 3));
    const set = Array.from({ length: 24 }, () => makeSample(task, digits, rng)).map((ex) => {
      const L = ex.tokens.length;
      const ids = Int32Array.from(ex.tokens.subarray(0, L - 1));
      const targets = Int32Array.from(ex.tokens.subarray(1, L));
      const keep = new Uint8Array(L - 1);
      for (let i = 0; i < L - 1; i++) keep[i] = i + 1 >= ex.answerStart ? 1 : 0;
      return { ids, targets, keep };
    });
    const base = answerAccuracy(gpt, set);
    setBaseline(base);
    const out: HeadStat[] = [];
    for (let l = 0; l < gpt.cfg.nLayers; l++) {
      for (let h = 0; h < gpt.cfg.nHeads; h++) {
        const acc = answerAccuracy(gpt, set, new Set([`${l}:${h}`]));
        out.push({ layer: l, head: h, drop: base - acc });
      }
    }
    setStats(out);
  }, [gpt, task, digits]);

  // Refresh automatically whenever training is paused and something changed; stay stale (cheap)
  // while the RAF loop is running so we never pay N·H forwards per frame.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!running) measure();
  }, [tick, running, measure]);

  const maxDrop = Math.max(0.001, ...stats.map((s) => Math.abs(s.drop)));

  return (
    <div className="card">
      <div className="card-title">
        Head influence{' '}
        <span className="muted small">· lesion each head, measure the drop in answer accuracy — which heads carry the task</span>
      </div>
      <div className="head-influence">
        {stats.map((s) => {
          const frac = Math.max(0, s.drop) / maxDrop;
          const hurt = s.drop < -0.003; // ablating it *helped* (rare; distracting head)
          return (
            <div key={`${s.layer}:${s.head}`} className="hi-row" title={`L${s.layer}·H${s.head}: −${(s.drop * 100).toFixed(1)}%`}>
              <span className="hi-label">
                L{s.layer}·H{s.head}
              </span>
              <span className="hi-track">
                <span
                  className={`hi-fill ${hurt ? 'neg' : ''}`}
                  style={{ width: `${Math.round((hurt ? Math.abs(s.drop) / maxDrop : frac) * 100)}%` }}
                />
              </span>
              <span className="hi-val">{s.drop >= 0 ? '−' : '+'}{Math.abs(s.drop * 100).toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
      <div className="hi-foot">
        <span className="muted small">baseline answer acc {(baseline * 100).toFixed(0)}%</span>
        <button className="ghost mini" onClick={measure} disabled={running} title="re-run the ablation study">
          re-measure
        </button>
      </div>
    </div>
  );
}
