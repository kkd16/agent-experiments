// From-scratch recurrent networks — vanilla RNN, GRU and LSTM — built on the same hand-rolled
// reverse-mode autograd as the rest of Synapse. No cuDNN-style fused cell, no library: each cell
// is assembled from the primitive ops in `tensor.ts` (matmul, add-with-bias broadcast, the
// elementwise tanh/sigmoid/mul, and `stackRows` from `ops.ts`), so the entire unrolled network —
// every gate, across every timestep — is one differentiable graph that backprops-through-time
// with the existing optimizer and is provable by the existing gradient checker.
//
// The recurrence is deliberate and visible: the model walks the sequence one step at a time,
// threading the hidden state h_t (and, for the LSTM, the cell state c_t) from each step into the
// next. That thread is exactly what `backward()` runs back along — which is why this lab can show
// the gradient *through time* decaying for a plain RNN and surviving in an LSTM.

import { Tensor } from './tensor';
import { mulberry32 } from './nn';
import { embedding, stackRows } from './ops';

export type CellKind = 'rnn' | 'gru' | 'lstm';

export interface RnnConfig {
  cell: CellKind;
  vocab: number;
  embDim: number;
  hidden: number;
  nLayers: number;
  seed: number;
}

// One gate's parameters: the input-side weight W (consumes the layer input x_t), the recurrent
// weight U (consumes the previous hidden h_{t-1}), and the bias b. A vanilla RNN layer has one
// such bag, a GRU three (update/reset/candidate), an LSTM four (input/forget/output/candidate).
interface Gate {
  W: Tensor; // [inDim, H]
  U: Tensor; // [H, H]
  b: Tensor; // [1, H]
}

interface Layer {
  gates: Gate[];
  inDim: number;
}

// Per-timestep activations captured from the most recent forward pass, for the visualizers.
export interface RnnTrace {
  T: number;
  H: number;
  cell: CellKind;
  inputIds: Int32Array;
  hidden: Float64Array[]; // [T] of length-H top-layer hidden state
  cellState: Float64Array[] | null; // [T] of length-H LSTM cell state, else null
  gates: { name: string; series: Float64Array[] }[] | null; // gate activations (gru/lstm)
}

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randTensor(rows: number, cols: number, std: number, rng: () => number, label: string): Tensor {
  const d = new Float64Array(rows * cols);
  for (let i = 0; i < d.length; i++) d[i] = randn(rng) * std;
  return Tensor.fromFlat(d, rows, cols, true).named(label);
}

const GATE_NAMES: Record<CellKind, string[]> = {
  rnn: ['h̃'],
  gru: ['z (update)', 'r (reset)', 'n (candidate)'],
  lstm: ['i (input)', 'f (forget)', 'o (output)', 'g (candidate)'],
};

export class RecurrentLM {
  cfg: RnnConfig;
  emb: Tensor; // [vocab, embDim]
  layers: Layer[];
  wOut: Tensor; // [H, vocab]
  bOut: Tensor; // [1, vocab]
  private ones: Tensor; // [1, H] constant, for GRU's (1 - z)

  lastTrace: RnnTrace | null = null;
  lastHiddenRefs: Tensor[] = []; // top-layer h_t tensors of the last forward (for grad-through-time)

  constructor(cfg: RnnConfig) {
    this.cfg = cfg;
    const rng = mulberry32(cfg.seed);
    const H = cfg.hidden;
    const nGates = cfg.cell === 'rnn' ? 1 : cfg.cell === 'gru' ? 3 : 4;

    this.emb = randTensor(cfg.vocab, cfg.embDim, 0.4, rng, 'emb');
    this.layers = [];
    for (let l = 0; l < cfg.nLayers; l++) {
      const inDim = l === 0 ? cfg.embDim : H;
      const gates: Gate[] = [];
      for (let g = 0; g < nGates; g++) {
        const tag = `L${l}.${GATE_NAMES[cfg.cell][g]}`;
        const W = randTensor(inDim, H, 1 / Math.sqrt(inDim), rng, `${tag}.W`);
        const U = randTensor(H, H, 1 / Math.sqrt(H), rng, `${tag}.U`);
        const b = Tensor.zeros(1, H, true).named(`${tag}.b`);
        // The classic LSTM trick: bias the forget gate positive so it defaults to "remember",
        // which by itself keeps early-training gradients alive through the cell highway.
        if (cfg.cell === 'lstm' && g === 1) b.data.fill(1);
        gates.push({ W, U, b });
      }
      this.layers.push({ gates, inDim });
    }
    this.wOut = randTensor(H, cfg.vocab, 1 / Math.sqrt(H), rng, 'Wout');
    this.bOut = Tensor.zeros(1, cfg.vocab, true).named('bout');
    this.ones = Tensor.fromFlat(new Float64Array(H).fill(1), 1, H, false);
  }

  // One recurrent step for a single layer: consumes the layer input x_t [1, inDim] and the
  // carried state, returns the new hidden (and cell) state plus the gate activations.
  private step(
    layer: Layer,
    x: Tensor,
    h: Tensor,
    c: Tensor | null,
  ): { h: Tensor; c: Tensor | null; gates: Tensor[] } {
    const g = layer.gates;
    if (this.cfg.cell === 'rnn') {
      const pre = x.matmul(g[0].W).add(h.matmul(g[0].U)).add(g[0].b);
      const hNew = pre.tanh();
      return { h: hNew, c: null, gates: [hNew] };
    }
    if (this.cfg.cell === 'gru') {
      const z = x.matmul(g[0].W).add(h.matmul(g[0].U)).add(g[0].b).sigmoid();
      const r = x.matmul(g[1].W).add(h.matmul(g[1].U)).add(g[1].b).sigmoid();
      const n = x.matmul(g[2].W).add(r.mul(h).matmul(g[2].U)).add(g[2].b).tanh();
      const hNew = this.ones.sub(z).mul(n).add(z.mul(h));
      return { h: hNew, c: null, gates: [z, r, n] };
    }
    // lstm
    const i = x.matmul(g[0].W).add(h.matmul(g[0].U)).add(g[0].b).sigmoid();
    const f = x.matmul(g[1].W).add(h.matmul(g[1].U)).add(g[1].b).sigmoid();
    const o = x.matmul(g[2].W).add(h.matmul(g[2].U)).add(g[2].b).sigmoid();
    const gg = x.matmul(g[3].W).add(h.matmul(g[3].U)).add(g[3].b).tanh();
    const cNew = f.mul(c as Tensor).add(i.mul(gg));
    const hNew = o.mul(cNew.tanh());
    return { h: hNew, c: cNew, gates: [i, f, o, gg] };
  }

  // Unroll over the whole sequence. Returns logits [T, vocab] (one readout per timestep). When
  // `capture` is set, the top-layer per-step activations are stashed on `lastTrace` for the
  // visualizers and the top-layer h_t tensors are kept on `lastHiddenRefs` so the loss's gradient
  // w.r.t. each can be read after a backward pass (the gradient-through-time view).
  forward(ids: Int32Array, capture = false): Tensor {
    const T = ids.length;
    const H = this.cfg.hidden;
    const L = this.layers.length;

    // Fresh zero initial states per layer (constant leaves; their grads are never read).
    const h: Tensor[] = [];
    const c: (Tensor | null)[] = [];
    for (let l = 0; l < L; l++) {
      h.push(Tensor.zeros(1, H, false));
      c.push(this.cfg.cell === 'lstm' ? Tensor.zeros(1, H, false) : null);
    }

    const logitRows: Tensor[] = [];
    const trace: RnnTrace | null = capture
      ? {
          T,
          H,
          cell: this.cfg.cell,
          inputIds: ids.slice(),
          hidden: [],
          cellState: this.cfg.cell === 'lstm' ? [] : null,
          gates: this.cfg.cell === 'rnn' ? null : GATE_NAMES[this.cfg.cell].map((name) => ({ name, series: [] })),
        }
      : null;
    if (capture) this.lastHiddenRefs = [];

    for (let t = 0; t < T; t++) {
      let x = embedding(this.emb, ids.subarray(t, t + 1)); // [1, embDim]
      for (let l = 0; l < L; l++) {
        const out = this.step(this.layers[l], x, h[l], c[l]);
        h[l] = out.h;
        c[l] = out.c;
        x = out.h; // the hidden of layer l is the input to layer l+1
        if (capture && l === L - 1 && trace) {
          trace.hidden.push(out.h.data.slice());
          if (trace.cellState && out.c) trace.cellState.push(out.c.data.slice());
          if (trace.gates) for (let gi = 0; gi < out.gates.length; gi++) trace.gates[gi].series.push(out.gates[gi].data.slice());
          this.lastHiddenRefs.push(out.h);
        }
      }
      logitRows.push(x.matmul(this.wOut).add(this.bOut)); // [1, vocab]
    }

    if (capture) this.lastTrace = trace;
    return stackRows(logitRows);
  }

  // Greedy/temperature autoregressive sampling. Feeds `prompt`, then appends `count` sampled
  // tokens, re-running the recurrence over the growing sequence each step (clarity over speed at
  // this scale). temperature <= 0 means greedy argmax.
  generate(prompt: Int32Array, count: number, temperature: number, rng: () => number): Int32Array {
    const out: number[] = Array.from(prompt);
    const V = this.cfg.vocab;
    for (let i = 0; i < count; i++) {
      const logits = this.forward(Int32Array.from(out));
      const base = (out.length - 1) * V;
      let next: number;
      if (temperature <= 0) {
        let best = 0;
        let bv = -Infinity;
        for (let j = 0; j < V; j++) {
          const v = logits.data[base + j];
          if (v > bv) {
            bv = v;
            best = j;
          }
        }
        next = best;
      } else {
        let max = -Infinity;
        for (let j = 0; j < V; j++) max = Math.max(max, logits.data[base + j]);
        let sum = 0;
        const probs = new Float64Array(V);
        for (let j = 0; j < V; j++) {
          probs[j] = Math.exp((logits.data[base + j] - max) / temperature);
          sum += probs[j];
        }
        let r = rng() * sum;
        next = V - 1;
        for (let j = 0; j < V; j++) {
          r -= probs[j];
          if (r <= 0) {
            next = j;
            break;
          }
        }
      }
      out.push(next);
    }
    return Int32Array.from(out);
  }

  // ‖∂L/∂h_t‖₂ for the top-layer hidden state at each timestep — only valid right after a
  // forward(…, true) + a backward() from a loss built on its logits. This is the gradient that
  // a plain RNN lets vanish and an LSTM/GRU preserves.
  hiddenGradNorms(): number[] {
    return this.lastHiddenRefs.map((t) => {
      let s = 0;
      for (let i = 0; i < t.grad.length; i++) s += t.grad[i] * t.grad[i];
      return Math.sqrt(s);
    });
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [this.emb];
    for (const layer of this.layers) for (const g of layer.gates) ps.push(g.W, g.U, g.b);
    ps.push(this.wOut, this.bOut);
    return ps;
  }

  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }

  exportWeights(): number[] {
    const out: number[] = [];
    for (const p of this.parameters()) for (let i = 0; i < p.size; i++) out.push(p.data[i]);
    return out;
  }

  importWeights(flat: number[]): boolean {
    const ps = this.parameters();
    let total = 0;
    for (const p of ps) total += p.size;
    if (flat.length !== total) return false;
    let k = 0;
    for (const p of ps) for (let i = 0; i < p.size; i++) p.data[i] = flat[k++];
    return true;
  }
}
