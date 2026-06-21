// A small convolutional network built on the autograd engine — the vision counterpart to
// the MLP in `nn.ts`. It threads spatial shapes through a stack of conv→activation→pool
// blocks, flattens, and finishes with a dense head, returning raw logits for softmax-CE.
// Like everything here it is pure hand-rolled autograd: each forward op records its own
// backward, so one `loss.backward()` trains the whole CNN.

import { Tensor } from './tensor';
import { conv2d, maxPool2d, avgPool2d, convOut, poolOut, type ConvMeta, type PoolMeta } from './conv';
import { mulberry32, applyActivation, type Activation, type Module } from './nn';

export type PoolKind = 'max' | 'avg';

export interface ConvBlockSpec {
  filters: number;
  kernel: number; // square kernel (kernel × kernel)
  pool: number; // pooling window (1 = no pool)
  poolKind?: PoolKind;
  activation: Activation;
}

export interface CNNConfig {
  imgSize: number; // square input H = W
  inChannels: number;
  blocks: ConvBlockSpec[];
  dense: number[]; // hidden dense widths after the flatten
  numClasses: number;
}

// One captured intermediate feature stack (for the feature-map visualization).
export interface FeatureStack {
  label: string;
  channels: number;
  H: number;
  W: number;
  data: Float64Array; // [channels * H * W] for a single image
}

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class ConvNet implements Module {
  cfg: CNNConfig;
  convW: Tensor[] = [];
  convB: Tensor[] = [];
  denseW: Tensor[] = [];
  denseB: Tensor[] = [];
  outW: Tensor;
  outB: Tensor;
  // Spatial shape after each block (post-pool) — handy for shape-aware UI.
  blockShapes: { C: number; H: number; W: number }[] = [];
  flatDim: number;
  training = false;

  constructor(cfg: CNNConfig, rng: () => number) {
    this.cfg = cfg;
    let C = cfg.inChannels;
    let H = cfg.imgSize;
    let W = cfg.imgSize;

    for (const block of cfg.blocks) {
      const k = block.kernel;
      const pad = Math.floor(k / 2); // 'same' conv for odd kernels at stride 1
      const fanIn = C * k * k;
      const heLike =
        block.activation === 'relu' ||
        block.activation === 'leaky_relu' ||
        block.activation === 'elu' ||
        block.activation === 'gelu' ||
        block.activation === 'silu';
      const gain = (heLike ? Math.sqrt(2) : 1) / Math.sqrt(fanIn);
      const w = new Float64Array(block.filters * fanIn);
      for (let i = 0; i < w.length; i++) w[i] = randn(rng) * gain;
      this.convW.push(Tensor.fromFlat(w, block.filters, fanIn, true).named('conv'));
      this.convB.push(Tensor.zeros(1, block.filters, true).named('cb'));

      H = convOut(H, k, 1, pad);
      W = convOut(W, k, 1, pad);
      C = block.filters;
      if (block.pool > 1) {
        H = poolOut(H, block.pool, block.pool);
        W = poolOut(W, block.pool, block.pool);
      }
      this.blockShapes.push({ C, H, W });
    }

    this.flatDim = C * H * W;
    let prev = this.flatDim;
    for (const units of cfg.dense) {
      const gain = Math.sqrt(2 / prev); // ReLU dense head
      const w = new Float64Array(prev * units);
      for (let i = 0; i < w.length; i++) w[i] = randn(rng) * gain;
      this.denseW.push(Tensor.fromFlat(w, prev, units, true).named('fc'));
      this.denseB.push(Tensor.zeros(1, units, true).named('fb'));
      prev = units;
    }
    const ow = new Float64Array(prev * cfg.numClasses);
    const ogain = Math.sqrt(1 / prev);
    for (let i = 0; i < ow.length; i++) ow[i] = randn(rng) * ogain;
    this.outW = Tensor.fromFlat(ow, prev, cfg.numClasses, true).named('out');
    this.outB = Tensor.zeros(1, cfg.numClasses, true).named('ob');
  }

  train(): void {
    this.training = true;
  }
  eval(): void {
    this.training = false;
  }

  private run(x: Tensor, collect: FeatureStack[] | null): Tensor {
    const cfg = this.cfg;
    let h = x;
    let C = cfg.inChannels;
    let H = cfg.imgSize;
    let W = cfg.imgSize;
    const N = x.rows;

    for (let bi = 0; bi < cfg.blocks.length; bi++) {
      const block = cfg.blocks[bi];
      const k = block.kernel;
      const pad = Math.floor(k / 2);
      const meta: ConvMeta = { N, Cin: C, H, W, Cout: block.filters, kh: k, kw: k, stride: 1, pad };
      const z = conv2d(h, this.convW[bi], this.convB[bi], meta);
      const Hc = convOut(H, k, 1, pad);
      const Wc = convOut(W, k, 1, pad);
      let a = applyActivation(z, block.activation);
      if (collect) {
        collect.push({ label: `conv ${bi + 1}`, channels: block.filters, H: Hc, W: Wc, data: a.data.slice() });
      }
      C = block.filters;
      H = Hc;
      W = Wc;
      if (block.pool > 1) {
        const pm: PoolMeta = { N, C, H, W, k: block.pool, stride: block.pool };
        a = block.poolKind === 'avg' ? avgPool2d(a, pm) : maxPool2d(a, pm);
        H = poolOut(H, block.pool, block.pool);
        W = poolOut(W, block.pool, block.pool);
      }
      h = a;
    }

    // h is already [N, C*H*W] — the flatten is implicit in the row-major layout.
    for (let di = 0; di < this.denseW.length; di++) {
      h = applyActivation(h.matmul(this.denseW[di]).add(this.denseB[di]), 'relu');
    }
    return h.matmul(this.outW).add(this.outB);
  }

  forward(x: Tensor): Tensor {
    return this.run(x, null);
  }

  // Forward pass for a single image that also returns the post-activation feature maps of
  // every conv block (pre-pool, full resolution) for the visualizer.
  featureMaps(x: Tensor): { logits: Tensor; stacks: FeatureStack[] } {
    const stacks: FeatureStack[] = [];
    const logits = this.run(x, stacks);
    return { logits, stacks };
  }

  // First-layer kernels, one entry per output channel: a [Cin, kh, kw] stack flattened.
  firstFilters(): { data: Float64Array; Cin: number; k: number }[] {
    if (this.convW.length === 0) return [];
    const k = this.cfg.blocks[0].kernel;
    const Cin = this.cfg.inChannels;
    const w = this.convW[0];
    const per = Cin * k * k;
    const out: { data: Float64Array; Cin: number; k: number }[] = [];
    for (let co = 0; co < w.rows; co++) {
      out.push({ data: w.data.slice(co * per, (co + 1) * per), Cin, k });
    }
    return out;
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (let i = 0; i < this.convW.length; i++) ps.push(this.convW[i], this.convB[i]);
    for (let i = 0; i < this.denseW.length; i++) ps.push(this.denseW[i], this.denseB[i]);
    ps.push(this.outW, this.outB);
    return ps;
  }

  // Per-parameter-group labels, aligned with `parameters()`, for the weight-stats panel.
  paramGroups(): { name: string; weight: Tensor; bias: Tensor }[] {
    const groups: { name: string; weight: Tensor; bias: Tensor }[] = [];
    for (let i = 0; i < this.convW.length; i++) groups.push({ name: `c${i + 1}`, weight: this.convW[i], bias: this.convB[i] });
    for (let i = 0; i < this.denseW.length; i++) groups.push({ name: `fc${i + 1}`, weight: this.denseW[i], bias: this.denseB[i] });
    groups.push({ name: 'out', weight: this.outW, bias: this.outB });
    return groups;
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

// Named architecture presets, surfaced in the vision control panel.
export interface ArchPreset {
  id: string;
  label: string;
  blocks: ConvBlockSpec[];
  dense: number[];
}

export const ARCH_PRESETS: ArchPreset[] = [
  {
    id: 'compact',
    label: 'Compact · 1 conv',
    blocks: [{ filters: 6, kernel: 3, pool: 2, activation: 'relu' }],
    dense: [32],
  },
  {
    id: 'standard',
    label: 'Standard · 2 conv',
    blocks: [
      { filters: 6, kernel: 3, pool: 2, activation: 'relu' },
      { filters: 12, kernel: 3, pool: 2, activation: 'relu' },
    ],
    dense: [48],
  },
  {
    id: 'deep',
    label: 'Deep · 2 conv (wide)',
    blocks: [
      { filters: 8, kernel: 3, pool: 2, activation: 'relu' },
      { filters: 16, kernel: 3, pool: 2, activation: 'relu' },
    ],
    dense: [64],
  },
  {
    id: 'lenet',
    label: 'LeNet-ish · 5×5',
    blocks: [
      { filters: 6, kernel: 5, pool: 2, activation: 'relu' },
      { filters: 12, kernel: 5, pool: 2, activation: 'relu' },
    ],
    dense: [64],
  },
];

export { mulberry32 };
