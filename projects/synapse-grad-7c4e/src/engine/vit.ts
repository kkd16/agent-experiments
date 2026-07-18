// Vision Transformer (ViT) — a from-scratch, end-to-end-differentiable image classifier.
//
// This is the bridge lab between the CNN (Vision) and the sequence Transformer: it treats an
// image as a *sequence of patches*. An H×W glyph is cut into a P×P grid of non-overlapping
// patches; each flattened patch is linearly projected to a token; a learnable [CLS] token is
// prepended and learnable positional embeddings are added; the sequence runs through a stack of
// pre-LayerNorm bidirectional Transformer encoder blocks (multi-head self-attention + a GELU
// MLP, exactly the primitives the sequence Transformer uses, minus the causal mask); and the
// final [CLS] token is read off and classified.
//
// Everything is assembled out of the engine's own gradchecked tensor ops — matmul, softmax,
// layerNorm, gelu, concatCols, stackRows — so the whole network is one autograd graph and the
// self-test gradchecks it end-to-end. The headline visual is **attention rollout** (Abnar &
// Zuidema, 2020): recursively fold the per-layer attention (mixed with the residual identity)
// into a single map from the [CLS] token back to the input patches — i.e. *where the classifier
// is looking* — drawn straight over the glyph.

import { Tensor } from './tensor';
import { layerNorm, concatCols, stackRows } from './ops';
import { mulberry32 } from './nn';

export interface ViTConfig {
  imgSize: number; // H = W (single channel)
  patch: number; // patch side; imgSize must be divisible by it
  dModel: number; // token / embedding width
  nHeads: number; // dModel must be divisible by nHeads
  nLayers: number; // encoder blocks
  dFF: number; // MLP hidden width
  numClasses: number;
  seed: number;
}

interface Block {
  ln1g: Tensor;
  ln1b: Tensor;
  wq: Tensor[];
  wk: Tensor[];
  wv: Tensor[];
  wo: Tensor;
  ln2g: Tensor;
  ln2b: Tensor;
  w1: Tensor;
  b1: Tensor;
  w2: Tensor;
  b2: Tensor;
}

// Per-forward capture of the attention tensors, for the interpretability views. `maps[l][h]`
// is the [T,T] row-stochastic attention matrix of head h in layer l (query row → key col).
export interface ViTAttn {
  T: number; // sequence length = numPatches + 1 (the [CLS] token is index 0)
  nLayers: number;
  nHeads: number;
  numPatches: number;
  gridSide: number; // P = sqrt(numPatches), the patch grid side
  maps: Float64Array[][];
}

// The result of folding the attention stack into one [CLS]→patch importance map.
export interface RolloutView {
  gridSide: number;
  // `perLayer[l]` is the P·P patch-importance grid using rollout truncated at layer l+1 —
  // so scrubbing l shows attention sharpening with depth. `full` = the last entry.
  perLayer: Float64Array[];
  full: Float64Array;
}

function randTensor(rows: number, cols: number, std: number, rng: () => number, name: string): Tensor {
  const d = new Float64Array(rows * cols);
  for (let i = 0; i < d.length; i++) {
    // Box–Muller standard normal scaled to the target std.
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    d[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * std;
  }
  return Tensor.fromFlat(d, rows, cols, true).named(name);
}

function ones(cols: number, name: string): Tensor {
  return Tensor.fromFlat(new Float64Array(cols).fill(1), 1, cols, true).named(name);
}

export class ViT {
  cfg: ViTConfig;
  dHead: number;
  numPatches: number;
  gridSide: number;
  patchDim: number;

  patchProj: Tensor; // [patchDim, dModel]
  patchBias: Tensor; // [1, dModel]
  cls: Tensor; // [1, dModel] — the learnable class token
  posEmb: Tensor; // [T, dModel]
  blocks: Block[];
  lnfg: Tensor;
  lnfb: Tensor;
  head: Tensor; // [dModel, numClasses]
  headBias: Tensor; // [1, numClasses]

  lastAttn: ViTAttn | null = null;
  training = false;

  // Cached constant [1,T] selector that lifts the [CLS] row out of the sequence via a matmul
  // (row 0 = 1, rest 0) — keeps the readout on the autograd tape without a bespoke slice op.
  private clsPick: Tensor;

  constructor(cfg: ViTConfig) {
    if (cfg.imgSize % cfg.patch !== 0) {
      throw new Error(`imgSize ${cfg.imgSize} not divisible by patch ${cfg.patch}`);
    }
    if (cfg.dModel % cfg.nHeads !== 0) {
      throw new Error(`dModel ${cfg.dModel} not divisible by nHeads ${cfg.nHeads}`);
    }
    this.cfg = cfg;
    this.gridSide = cfg.imgSize / cfg.patch;
    this.numPatches = this.gridSide * this.gridSide;
    this.patchDim = cfg.patch * cfg.patch;
    this.dHead = cfg.dModel / cfg.nHeads;
    const T = this.numPatches + 1;

    const rng = mulberry32(cfg.seed);
    const projStd = 1 / Math.sqrt(cfg.dModel);
    this.patchProj = randTensor(this.patchDim, cfg.dModel, 1 / Math.sqrt(this.patchDim), rng, 'patchProj');
    this.patchBias = Tensor.zeros(1, cfg.dModel, true).named('patchBias');
    this.cls = randTensor(1, cfg.dModel, 0.02, rng, 'cls');
    this.posEmb = randTensor(T, cfg.dModel, 0.02, rng, 'posEmb');
    this.blocks = [];
    for (let l = 0; l < cfg.nLayers; l++) {
      const wq: Tensor[] = [];
      const wk: Tensor[] = [];
      const wv: Tensor[] = [];
      for (let h = 0; h < cfg.nHeads; h++) {
        wq.push(randTensor(cfg.dModel, this.dHead, projStd, rng, `L${l}.Wq${h}`));
        wk.push(randTensor(cfg.dModel, this.dHead, projStd, rng, `L${l}.Wk${h}`));
        wv.push(randTensor(cfg.dModel, this.dHead, projStd, rng, `L${l}.Wv${h}`));
      }
      this.blocks.push({
        ln1g: ones(cfg.dModel, `L${l}.ln1.γ`),
        ln1b: Tensor.zeros(1, cfg.dModel, true).named(`L${l}.ln1.β`),
        wq,
        wk,
        wv,
        wo: randTensor(cfg.dModel, cfg.dModel, projStd, rng, `L${l}.Wo`),
        ln2g: ones(cfg.dModel, `L${l}.ln2.γ`),
        ln2b: Tensor.zeros(1, cfg.dModel, true).named(`L${l}.ln2.β`),
        w1: randTensor(cfg.dModel, cfg.dFF, Math.sqrt(2 / cfg.dModel), rng, `L${l}.W1`),
        b1: Tensor.zeros(1, cfg.dFF, true).named(`L${l}.b1`),
        w2: randTensor(cfg.dFF, cfg.dModel, 1 / Math.sqrt(cfg.dFF), rng, `L${l}.W2`),
        b2: Tensor.zeros(1, cfg.dModel, true).named(`L${l}.b2`),
      });
    }
    this.lnfg = ones(cfg.dModel, 'lnf.γ');
    this.lnfb = Tensor.zeros(1, cfg.dModel, true).named('lnf.β');
    this.head = randTensor(cfg.dModel, cfg.numClasses, projStd, rng, 'head');
    this.headBias = Tensor.zeros(1, cfg.numClasses, true).named('headBias');

    const pick = new Float64Array(T);
    pick[0] = 1;
    this.clsPick = Tensor.fromFlat(pick, 1, T, false);
  }

  train(): void {
    this.training = true;
  }

  eval(): void {
    this.training = false;
  }

  // Cut one image (row-major intensities, length imgSize²) into its [numPatches, patchDim]
  // patch matrix — a constant (no gradient flows to pixels), consumed by the patch projection.
  patchify(pixels: Float64Array): Tensor {
    const { imgSize, patch } = this.cfg;
    const P = this.gridSide;
    const pd = this.patchDim;
    const out = new Float64Array(this.numPatches * pd);
    for (let pr = 0; pr < P; pr++) {
      for (let pc = 0; pc < P; pc++) {
        const patchIdx = pr * P + pc;
        const base = patchIdx * pd;
        for (let y = 0; y < patch; y++) {
          const iy = pr * patch + y;
          for (let x = 0; x < patch; x++) {
            const ix = pc * patch + x;
            out[base + y * patch + x] = pixels[iy * imgSize + ix];
          }
        }
      }
    }
    return Tensor.fromFlat(out, this.numPatches, pd, false);
  }

  // Forward one image → logits [1, numClasses]. When `capture` is set, every head's attention
  // matrix is stashed on `lastAttn` for the interpretability views.
  forwardOne(pixels: Float64Array, capture = false): Tensor {
    const { nHeads } = this.cfg;
    const invSqrt = 1 / Math.sqrt(this.dHead);
    const T = this.numPatches + 1;

    const patches = this.patchify(pixels); // [numPatches, patchDim]
    const tokens = patches.matmul(this.patchProj).add(this.patchBias); // [numPatches, dModel]
    let h = stackRows([this.cls, tokens]).add(this.posEmb); // [T, dModel]

    const snap: ViTAttn | null = capture
      ? { T, nLayers: this.cfg.nLayers, nHeads, numPatches: this.numPatches, gridSide: this.gridSide, maps: [] }
      : null;

    for (let l = 0; l < this.blocks.length; l++) {
      const blk = this.blocks[l];
      // --- multi-head self-attention (pre-LN, bidirectional: no causal mask) ---
      const a = layerNorm(h, blk.ln1g, blk.ln1b);
      const heads: Tensor[] = [];
      const layerMaps: Float64Array[] = [];
      for (let head = 0; head < nHeads; head++) {
        const q = a.matmul(blk.wq[head]); // [T, dHead]
        const k = a.matmul(blk.wk[head]);
        const v = a.matmul(blk.wv[head]);
        const scores = q.matmul(k.transpose()).scale(invSqrt); // [T,T]
        const attn = scores.softmax();
        if (snap) layerMaps.push(attn.data.slice());
        heads.push(attn.matmul(v)); // [T, dHead]
      }
      if (snap) snap.maps.push(layerMaps);
      const merged = nHeads === 1 ? heads[0] : concatCols(heads); // [T, dModel]
      h = h.add(merged.matmul(blk.wo));
      // --- position-wise MLP (pre-LN) ---
      const m = layerNorm(h, blk.ln2g, blk.ln2b);
      const ff = m.matmul(blk.w1).add(blk.b1).gelu().matmul(blk.w2).add(blk.b2);
      h = h.add(ff);
    }

    h = layerNorm(h, this.lnfg, this.lnfb);
    const clsOut = this.clsPick.matmul(h); // [1, dModel] — the class token after the stack
    const logits = clsOut.matmul(this.head).add(this.headBias); // [1, numClasses]
    if (snap) this.lastAttn = snap;
    return logits;
  }

  // Forward a mini-batch of images stacked as rows of `X` ([n, imgSize²]) → logits [n, classes].
  // Each image is its own patch sequence, so we run them independently and glue the class-token
  // logits back into one matrix for the shared softmax-cross-entropy loss.
  forwardBatch(X: Tensor, n: number): Tensor {
    const px = this.cfg.imgSize * this.cfg.imgSize;
    const rows: Tensor[] = [];
    for (let i = 0; i < n; i++) {
      rows.push(this.forwardOne(X.data.subarray(i * px, i * px + px)));
    }
    return n === 1 ? rows[0] : stackRows(rows);
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [this.patchProj, this.patchBias, this.cls, this.posEmb];
    for (const b of this.blocks) {
      ps.push(b.ln1g, b.ln1b, ...b.wq, ...b.wk, ...b.wv, b.wo, b.ln2g, b.ln2b, b.w1, b.b1, b.w2, b.b2);
    }
    ps.push(this.lnfg, this.lnfb, this.head, this.headBias);
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

// ---- attention rollout ----------------------------------------------------------------------
//
// Fold a stack of per-layer attention matrices into one map from the [CLS] token to the input
// patches. Following Abnar & Zuidema (2020): the residual connection means each token keeps
// (roughly) half of itself, so we average the heads, add the identity, renormalize each row to
// a distribution, and multiply the layers together. Row 0 of the product — restricted to the
// patch columns 1..numPatches — is how much of the classifier's [CLS] representation traces back
// to each patch. We also return the truncated products so the UI can scrub attention deepening.

export function attentionRollout(attn: ViTAttn): RolloutView {
  const { T, nLayers, nHeads, numPatches, gridSide } = attn;

  // Start from the identity (T×T), stored row-major.
  let roll = new Float64Array(T * T);
  for (let i = 0; i < T; i++) roll[i * T + i] = 1;

  const perLayer: Float64Array[] = [];

  for (let l = 0; l < nLayers; l++) {
    // Average heads → mean attention A [T,T].
    const A = new Float64Array(T * T);
    for (let hd = 0; hd < nHeads; hd++) {
      const m = attn.maps[l][hd];
      for (let i = 0; i < T * T; i++) A[i] += m[i] / nHeads;
    }
    // Add the residual identity and row-normalize: Â = normalize(A + I).
    const Ahat = new Float64Array(T * T);
    for (let i = 0; i < T; i++) {
      let s = 0;
      for (let j = 0; j < T; j++) {
        const v = A[i * T + j] + (i === j ? 1 : 0);
        Ahat[i * T + j] = v;
        s += v;
      }
      const inv = s > 0 ? 1 / s : 0;
      for (let j = 0; j < T; j++) Ahat[i * T + j] *= inv;
    }
    // roll ← Â · roll.
    const next = new Float64Array(T * T);
    for (let i = 0; i < T; i++) {
      for (let k = 0; k < T; k++) {
        const a = Ahat[i * T + k];
        if (a === 0) continue;
        for (let j = 0; j < T; j++) next[i * T + j] += a * roll[k * T + j];
      }
    }
    roll = next;

    // Snapshot the [CLS]→patch row for this depth.
    const grid = new Float64Array(numPatches);
    for (let p = 0; p < numPatches; p++) grid[p] = roll[0 * T + (p + 1)];
    perLayer.push(grid);
  }

  const full = perLayer.length ? perLayer[perLayer.length - 1].slice() : new Float64Array(numPatches);
  return { gridSide, perLayer, full };
}

// The raw (single-layer) mean [CLS]→patch attention for a given layer — the un-rolled view, so
// the two can be compared side by side.
export function clsAttentionAt(attn: ViTAttn, layer: number): Float64Array {
  const { T, nHeads, numPatches } = attn;
  const out = new Float64Array(numPatches);
  for (let hd = 0; hd < nHeads; hd++) {
    const m = attn.maps[layer][hd];
    for (let p = 0; p < numPatches; p++) out[p] += m[0 * T + (p + 1)] / nHeads;
  }
  return out;
}

// The classic ViT positional-embedding diagnostic. For the P² patch positions (skipping the
// [CLS] slot at index 0), compute the cosine similarity between every pair of position
// embeddings. Returns a numPatches×numPatches matrix; reshaped per row into P×P tiles, each
// tile shows how similar one patch position is to all others — and a *trained* ViT recovers 2-D
// locality (each position most similar to its spatial neighbours) with no such structure imposed.
export function positionalSimilarity(model: ViT): { sim: Float64Array; numPatches: number; gridSide: number } {
  const T = model.numPatches + 1;
  const d = model.cfg.dModel;
  const np = model.numPatches;
  const pos = model.posEmb.data;
  const norm = new Float64Array(np);
  for (let i = 0; i < np; i++) {
    let s = 0;
    const base = (i + 1) * d; // +1 skips the [CLS] position
    for (let k = 0; k < d; k++) s += pos[base + k] * pos[base + k];
    norm[i] = Math.sqrt(s) + 1e-9;
  }
  const sim = new Float64Array(np * np);
  for (let i = 0; i < np; i++) {
    const bi = (i + 1) * d;
    for (let j = 0; j < np; j++) {
      const bj = (j + 1) * d;
      let dot = 0;
      for (let k = 0; k < d; k++) dot += pos[bi + k] * pos[bj + k];
      sim[i * np + j] = dot / (norm[i] * norm[j]);
    }
  }
  void T;
  return { sim, numPatches: np, gridSide: model.gridSide };
}

export const VIT_ARCH_PRESETS: { id: string; label: string; patch: number; dModel: number; nHeads: number; nLayers: number; dFF: number }[] = [
  { id: 'tiny', label: 'Tiny · patch 4 · d24 · 2 layers', patch: 4, dModel: 24, nHeads: 3, nLayers: 2, dFF: 48 },
  { id: 'small', label: 'Small · patch 4 · d48 · 3 layers', patch: 4, dModel: 48, nHeads: 4, nLayers: 3, dFF: 96 },
  { id: 'wide', label: 'Wide · patch 4 · d64 · 2 layers', patch: 4, dModel: 64, nHeads: 8, nLayers: 2, dFF: 128 },
  { id: 'coarse', label: 'Coarse · patch 8 · d48 · 2 layers', patch: 8, dModel: 48, nHeads: 4, nLayers: 2, dFF: 96 },
  { id: 'fine', label: 'Fine · patch 2 · d48 · 2 layers', patch: 2, dModel: 48, nHeads: 4, nLayers: 2, dFF: 96 },
];
