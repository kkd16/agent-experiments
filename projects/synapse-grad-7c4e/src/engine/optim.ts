import type { Tensor } from './tensor';

export type OptimizerKind = 'sgd' | 'momentum' | 'rmsprop' | 'adam';

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
      for (let i = 0; i < d.length; i++) {
        let grad = g[i];
        if (weightDecay !== 0) grad += weightDecay * d[i];
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
          case 'rmsprop': {
            v[i] = beta2 * v[i] + (1 - beta2) * grad * grad;
            d[i] -= (lr * grad) / (Math.sqrt(v[i]) + eps);
            break;
          }
          case 'adam': {
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
