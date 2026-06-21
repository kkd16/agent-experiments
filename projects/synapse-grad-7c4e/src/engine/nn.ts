import { Tensor } from './tensor';

export type Activation = 'relu' | 'tanh' | 'sigmoid' | 'linear';

// A small, seedable PRNG (mulberry32) so runs are reproducible and "Reset weights"
// with a fixed seed gives the same starting point every time.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard-normal sample via Box–Muller, drawing from a uniform rng.
function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface Module {
  forward(x: Tensor): Tensor;
  parameters(): Tensor[];
}

// y = x · W + b, with W [inF,outF] and b [1,outF]. Weight init is gain-scaled normal:
// He for ReLU, Xavier/Glorot otherwise — the right variance to keep signals alive
// through depth.
export class Linear implements Module {
  weight: Tensor;
  bias: Tensor;

  constructor(inF: number, outF: number, act: Activation, rng: () => number) {
    const gain = act === 'relu' ? Math.sqrt(2 / inF) : Math.sqrt(1 / inF);
    const w = new Float64Array(inF * outF);
    for (let i = 0; i < w.length; i++) w[i] = randn(rng) * gain;
    this.weight = Tensor.fromFlat(w, inF, outF, true).named('W');
    this.bias = Tensor.zeros(1, outF, true).named('b');
  }

  forward(x: Tensor): Tensor {
    return x.matmul(this.weight).add(this.bias);
  }

  parameters(): Tensor[] {
    return [this.weight, this.bias];
  }
}

function applyActivation(x: Tensor, act: Activation): Tensor {
  switch (act) {
    case 'relu':
      return x.relu();
    case 'tanh':
      return x.tanh();
    case 'sigmoid':
      return x.sigmoid();
    case 'linear':
      return x;
  }
}

export interface LayerSpec {
  units: number;
  activation: Activation;
}

// A multilayer perceptron built from a hidden-layer spec. `forward` returns raw logits
// (no output activation) so it can feed either softmax-CE (classification) or MSE
// (regression). `activations(x)` re-runs the forward pass but keeps every hidden layer's
// post-activation output, which the neuron-grid view renders as per-unit feature maps.
export class MLP implements Module {
  layers: Linear[];
  acts: Activation[];

  constructor(inputDim: number, hidden: LayerSpec[], outputDim: number, rng: () => number) {
    this.layers = [];
    this.acts = [];
    let prev = inputDim;
    for (const h of hidden) {
      this.layers.push(new Linear(prev, h.units, h.activation, rng));
      this.acts.push(h.activation);
      prev = h.units;
    }
    this.layers.push(new Linear(prev, outputDim, 'linear', rng));
    this.acts.push('linear');
  }

  forward(x: Tensor): Tensor {
    let h = x;
    for (let i = 0; i < this.layers.length; i++) {
      h = applyActivation(this.layers[i].forward(h), this.acts[i]);
    }
    return h;
  }

  // Forward pass that returns the post-activation output of every hidden layer.
  activations(x: Tensor): Tensor[] {
    const out: Tensor[] = [];
    let h = x;
    for (let i = 0; i < this.layers.length - 1; i++) {
      h = applyActivation(this.layers[i].forward(h), this.acts[i]);
      out.push(h);
    }
    return out;
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.layers) ps.push(...l.parameters());
    return ps;
  }

  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }
}
