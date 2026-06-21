import type { Tensor } from './tensor';

// The global L2 norm of the gradient across every parameter — surfaced live in the UI and
// used as the basis for gradient clipping.
export function globalGradNorm(params: Tensor[]): number {
  let sq = 0;
  for (const p of params) for (let i = 0; i < p.size; i++) sq += p.grad[i] * p.grad[i];
  return Math.sqrt(sq);
}

// Clip the gradient by its global norm: if ||g|| > maxNorm, scale every entry by
// maxNorm/||g|| so the direction is preserved but the step is bounded. Returns the
// pre-clip norm so callers can chart it. A non-positive maxNorm disables clipping.
export function clipGradGlobalNorm(params: Tensor[], maxNorm: number): number {
  const norm = globalGradNorm(params);
  if (maxNorm > 0 && norm > maxNorm) {
    const scale = maxNorm / (norm + 1e-12);
    for (const p of params) for (let i = 0; i < p.size; i++) p.grad[i] *= scale;
  }
  return norm;
}

export type OptimizerKind = 'sgd' | 'momentum' | 'nesterov' | 'rmsprop' | 'adam' | 'adamw';

export interface OptimizerConfig {
  kind: OptimizerKind;
  lr: number;
  weightDecay: number; // L2 (decoupled): subtracts wd*param before the update step
  momentum: number; // for 'momentum'
  beta1: number; // adam
  beta2: number; // adam / rmsprop (rmsprop uses beta2 as its decay)
  eps: number;
}

export function defaultOptimizer(kind: OptimizerKind, lr: number): OptimizerConfig {
  return {
    kind,
    lr,
    weightDecay: 0,
    momentum: 0.9,
    beta1: 0.9,
    beta2: 0.999,
    eps: 1e-8,
  };
}

// One optimizer over a fixed parameter list. Holds per-parameter state (velocity /
// second-moment buffers) keyed by tensor id, so it survives across steps but is rebuilt
// whenever the network is rebuilt.
export class Optimizer {
  cfg: OptimizerConfig;
  params: Tensor[];
  private m = new Map<number, Float64Array>(); // first moment / velocity
  private v = new Map<number, Float64Array>(); // second moment
  private t = 0; // step count (Adam bias correction)

  constructor(params: Tensor[], cfg: OptimizerConfig) {
    this.params = params;
    this.cfg = cfg;
    for (const p of params) {
      this.m.set(p.id, new Float64Array(p.size));
      this.v.set(p.id, new Float64Array(p.size));
    }
  }

  zeroGrad(): void {
    for (const p of this.params) p.grad.fill(0);
  }

  step(): void {
    const { kind, lr, weightDecay, momentum, beta1, beta2, eps } = this.cfg;
    this.t++;
    const bc1 = 1 - Math.pow(beta1, this.t);
    const bc2 = 1 - Math.pow(beta2, this.t);
    for (const p of this.params) {
      const g = p.grad;
      const d = p.data;
      const m = this.m.get(p.id)!;
      const v = this.v.get(p.id)!;
      // AdamW uses *decoupled* weight decay (applied straight to the param); every other
      // optimizer treats weightDecay as classic L2 folded into the gradient.
      const decoupled = kind === 'adamw';
      for (let i = 0; i < d.length; i++) {
        let grad = g[i];
        if (weightDecay !== 0 && !decoupled) grad += weightDecay * d[i];
        if (weightDecay !== 0 && decoupled) d[i] -= lr * weightDecay * d[i];
        switch (kind) {
          case 'sgd': {
            d[i] -= lr * grad;
            break;
          }
          case 'momentum': {
            m[i] = momentum * m[i] + grad;
            d[i] -= lr * m[i];
            break;
          }
          case 'nesterov': {
            // PyTorch-style Nesterov: look ahead through the velocity buffer.
            m[i] = momentum * m[i] + grad;
            d[i] -= lr * (grad + momentum * m[i]);
            break;
          }
          case 'rmsprop': {
            v[i] = beta2 * v[i] + (1 - beta2) * grad * grad;
            d[i] -= (lr * grad) / (Math.sqrt(v[i]) + eps);
            break;
          }
          case 'adam':
          case 'adamw': {
            m[i] = beta1 * m[i] + (1 - beta1) * grad;
            v[i] = beta2 * v[i] + (1 - beta2) * grad * grad;
            const mh = m[i] / bc1;
            const vh = v[i] / bc2;
            d[i] -= (lr * mh) / (Math.sqrt(vh) + eps);
            break;
          }
        }
      }
    }
  }
}
