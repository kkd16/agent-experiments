import { Tensor } from './tensor';
import { dropout, layerNorm, batchNorm, makeBatchNormState, type BatchNormState } from './ops';

export type Activation =
  | 'relu'
  | 'leaky_relu'
  | 'elu'
  | 'gelu'
  | 'silu'
  | 'softplus'
  | 'tanh'
  | 'sigmoid'
  | 'linear';

export type NormKind = 'none' | 'layer' | 'batch';

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
// He for ReLU-family, Xavier/Glorot otherwise — the right variance to keep signals alive
// through depth.
export class Linear implements Module {
  weight: Tensor;
  bias: Tensor;

  constructor(inF: number, outF: number, act: Activation, rng: () => number) {
    const heLike = act === 'relu' || act === 'leaky_relu' || act === 'elu' || act === 'gelu' || act === 'silu';
    const gain = heLike ? Math.sqrt(2 / inF) : Math.sqrt(1 / inF);
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

export function applyActivation(x: Tensor, act: Activation): Tensor {
  switch (act) {
    case 'relu':
      return x.relu();
    case 'leaky_relu':
      return x.leakyRelu();
    case 'elu':
      return x.elu();
    case 'gelu':
      return x.gelu();
    case 'silu':
      return x.silu();
    case 'softplus':
      return x.softplus();
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
  norm?: NormKind;
  dropout?: number;
  residual?: boolean;
}

// A multilayer perceptron built from a hidden-layer spec, with optional per-layer
// normalization (LayerNorm / BatchNorm), dropout, and residual (skip) connections.
//
// Each hidden block runs: Linear → Norm → Activation → Dropout → (+ skip if width matches).
// `forward` returns raw logits (no output activation) so it can feed either softmax-CE
// (classification) or MSE (regression). `activations(x)` re-runs the forward pass keeping
// every hidden layer's post-activation output for the neuron-grid feature maps. Dropout and
// BatchNorm are mode-aware: call `train()` before a training step and `eval()` (the default)
// for any evaluation or visualization so those layers behave deterministically.
export class MLP implements Module {
  layers: Linear[];
  acts: Activation[];
  norms: NormKind[];
  dropouts: number[];
  residual: boolean[];
  private gammas: (Tensor | null)[];
  private betas: (Tensor | null)[];
  private bnStates: (BatchNormState | null)[];
  private dropRng: () => number;
  training = false;

  constructor(inputDim: number, hidden: LayerSpec[], outputDim: number, rng: () => number) {
    this.layers = [];
    this.acts = [];
    this.norms = [];
    this.dropouts = [];
    this.residual = [];
    this.gammas = [];
    this.betas = [];
    this.bnStates = [];
    this.dropRng = mulberry32((Math.floor(rng() * 1e9) ^ 0x9e3779b9) >>> 0);

    let prev = inputDim;
    for (const h of hidden) {
      this.layers.push(new Linear(prev, h.units, h.activation, rng));
      this.acts.push(h.activation);
      const norm = h.norm ?? 'none';
      this.norms.push(norm);
      this.dropouts.push(h.dropout ?? 0);
      this.residual.push(Boolean(h.residual) && prev === h.units);
      if (norm === 'none') {
        this.gammas.push(null);
        this.betas.push(null);
        this.bnStates.push(null);
      } else {
        this.gammas.push(Tensor.fromFlat(new Float64Array(h.units).fill(1), 1, h.units, true).named('γ'));
        this.betas.push(Tensor.zeros(1, h.units, true).named('β'));
        this.bnStates.push(norm === 'batch' ? makeBatchNormState(h.units) : null);
      }
      prev = h.units;
    }
    // Output layer: plain linear, no norm/dropout/residual.
    this.layers.push(new Linear(prev, outputDim, 'linear', rng));
    this.acts.push('linear');
    this.norms.push('none');
    this.dropouts.push(0);
    this.residual.push(false);
    this.gammas.push(null);
    this.betas.push(null);
    this.bnStates.push(null);
  }

  train(): void {
    this.training = true;
  }

  eval(): void {
    this.training = false;
  }

  private normalize(z: Tensor, i: number): Tensor {
    const norm = this.norms[i];
    if (norm === 'layer') return layerNorm(z, this.gammas[i]!, this.betas[i]!);
    if (norm === 'batch') return batchNorm(z, this.gammas[i]!, this.betas[i]!, this.bnStates[i]!, this.training);
    return z;
  }

  // Shared forward path; when `collect` is set, returns each hidden block's post-activation
  // output (used by the neuron grid). Dropout is skipped when collecting so the feature maps
  // are deterministic.
  private run(x: Tensor, collect: Tensor[] | null): Tensor {
    let h = x;
    const last = this.layers.length - 1;
    for (let i = 0; i < this.layers.length; i++) {
      const input = h;
      let z = this.layers[i].forward(h);
      z = this.normalize(z, i);
      let a = applyActivation(z, this.acts[i]);
      if (i < last) {
        if (collect) collect.push(a);
        if (!collect && this.dropouts[i] > 0) a = dropout(a, this.dropouts[i], this.training, this.dropRng);
        if (this.residual[i]) a = a.add(input);
      }
      h = a;
    }
    return h;
  }

  forward(x: Tensor): Tensor {
    return this.run(x, null);
  }

  // Forward pass that returns the post-activation output of every hidden layer.
  activations(x: Tensor): Tensor[] {
    const out: Tensor[] = [];
    this.run(x, out);
    return out;
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.layers) ps.push(...l.parameters());
    for (let i = 0; i < this.gammas.length; i++) {
      if (this.gammas[i]) ps.push(this.gammas[i]!, this.betas[i]!);
    }
    return ps;
  }

  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }

  // Flat snapshot of all trainable parameter values, in `parameters()` order — used by
  // save/load and URL sharing.
  exportWeights(): number[] {
    const ps = this.parameters();
    const out: number[] = [];
    for (const p of ps) for (let i = 0; i < p.size; i++) out.push(p.data[i]);
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
