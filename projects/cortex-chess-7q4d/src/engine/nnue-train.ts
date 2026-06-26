// nnue-train.ts — a hand-rolled trainer for the NNUE net in `nnue.ts`.
//
// The net is trained by **knowledge distillation**: positions are sampled by
// seeded self-play, each labelled with the existing hand-crafted `evaluate`, and a
// small Adam-SGD loop fits the net to reproduce that signal. Every gradient is
// hand-derived (and gradient-checked against finite differences in the Lab), in the
// same spirit as the rest of this from-scratch engine — no autodiff, no ML library.
//
// Once trained, the net's first layer is exactly the accumulator the search updates
// incrementally, so distillation buys a *learned, non-linear* evaluation that the
// engine can run as cheaply as the classical one.

import {
  type Position,
  type Undo,
  parseFen,
  START_FEN,
  makeMoveOnBoard,
} from './board'
import { generateLegal } from './movegen'
import { evaluate } from './eval'
import {
  type NnueWeights,
  zeroWeights,
  featureIndex,
  to64,
  DEFAULT_H,
  OUT_SCALE,
  LABEL_CLAMP,
} from './nnue'
import { EMPTY, pieceColor, pieceType } from './board'

// A precomputed training example: the active feature indices viewed from the side
// to move and from the opponent, plus the regression target.
export interface Example {
  stmFeats: Int32Array // active features for the side-to-move perspective
  oppFeats: Int32Array // active features for the opponent perspective
  y: number // target = clamp(eval, ±LABEL_CLAMP) / OUT_SCALE, stm-relative
  cp: number // the raw classical eval in centipawns (for correlation plots)
}

// --- Seeded RNG (mulberry32) + Gaussian ------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rng: () => number): number {
  // Box–Muller.
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// --- Example construction ---------------------------------------------------

// Active feature lists for both perspectives of a position.
export function featuresOf(p: Position): { stm: Int32Array; opp: Int32Array } {
  const stm = p.turn
  const opp = (stm ^ 1) as 0 | 1
  const stmList: number[] = []
  const oppList: number[] = []
  const board = p.board
  for (let s = 0; s < 128; s++) {
    if ((s & 0x88) !== 0) {
      s += 7
      continue
    }
    const pc = board[s]
    if (pc === EMPTY) continue
    const c = pieceColor(pc)
    const t = pieceType(pc)
    const s64 = to64(s)
    stmList.push(featureIndex(stm, c, t, s64))
    oppList.push(featureIndex(opp, c, t, s64))
  }
  return { stm: Int32Array.from(stmList), opp: Int32Array.from(oppList) }
}

function exampleFromPosition(p: Position): Example {
  let cp = evaluate(p)
  if (cp > LABEL_CLAMP) cp = LABEL_CLAMP
  else if (cp < -LABEL_CLAMP) cp = -LABEL_CLAMP
  const { stm, opp } = featuresOf(p)
  return { stmFeats: stm, oppFeats: opp, y: cp / OUT_SCALE, cp }
}

// A handful of opening positions to seed varied self-play games.
const SEED_FENS = [
  START_FEN,
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', // Sicilian
  'rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 1 2', // d4 Nf6
  'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2', // d4 d5
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', // open game
]

// Generate `count` distinct training positions by seeded semi-random self-play.
// Most moves are random (broad coverage), but captures are taken with higher
// probability so the sampled positions aren't pure noise.
export function generatePositions(count: number, seed = 0x1234): Example[] {
  const rng = mulberry32(seed)
  const examples: Example[] = []
  const undo: Undo = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
  let game = 0
  while (examples.length < count) {
    const fen = SEED_FENS[game % SEED_FENS.length]
    game++
    const p = parseFen(fen)
    const plies = 16 + Math.floor(rng() * 40)
    for (let ply = 0; ply < plies && examples.length < count; ply++) {
      const moves = generateLegal(p)
      if (moves.length === 0) break
      // Record this position (skip the very first few plies — too book-like).
      if (ply >= 2 && rng() < 0.6) examples.push(exampleFromPosition(p))
      // Pick a move: bias toward captures so games stay lively.
      let pick = moves[Math.floor(rng() * moves.length)]
      if (rng() < 0.4) {
        const caps = moves.filter((m) => p.board[(m >> 7) & 0x7f] !== EMPTY)
        if (caps.length > 0) pick = caps[Math.floor(rng() * caps.length)]
      }
      makeMoveOnBoard(p, pick, undo)
    }
  }
  return examples
}

// --- The trainer -----------------------------------------------------------

export interface TrainOpts {
  h?: number
  lr?: number
  seed?: number
  beta1?: number
  beta2?: number
  weightInit?: number
}

export class NnueTrainer {
  readonly w: NnueWeights
  private readonly lr: number
  private readonly beta1: number
  private readonly beta2: number
  private readonly eps = 1e-8
  private t = 0
  // Adam moment estimates.
  private readonly mW1: Float32Array
  private readonly vW1: Float32Array
  private readonly mB1: Float32Array
  private readonly vB1: Float32Array
  private readonly mW2: Float32Array
  private readonly vW2: Float32Array
  private mB2 = 0
  private vB2 = 0
  // Reusable scratch.
  private readonly aOwn: Float32Array
  private readonly aOpp: Float32Array
  private readonly gB1: Float32Array
  private readonly gW2: Float32Array

  constructor(opts: TrainOpts = {}) {
    const h = opts.h ?? DEFAULT_H
    this.lr = opts.lr ?? 1e-3
    this.beta1 = opts.beta1 ?? 0.9
    this.beta2 = opts.beta2 ?? 0.999
    this.w = zeroWeights(h)
    const rng = mulberry32(opts.seed ?? 0x9e37)
    const scale = opts.weightInit ?? 0.05
    for (let i = 0; i < this.w.w1.length; i++) this.w.w1[i] = gaussian(rng) * scale
    for (let i = 0; i < this.w.w2.length; i++) this.w.w2[i] = gaussian(rng) * scale
    this.mW1 = new Float32Array(this.w.w1.length)
    this.vW1 = new Float32Array(this.w.w1.length)
    this.mB1 = new Float32Array(h)
    this.vB1 = new Float32Array(h)
    this.mW2 = new Float32Array(2 * h)
    this.vW2 = new Float32Array(2 * h)
    this.aOwn = new Float32Array(h)
    this.aOpp = new Float32Array(h)
    this.gB1 = new Float32Array(h)
    this.gW2 = new Float32Array(2 * h)
  }

  // Forward one example into the scratch accumulators; returns the scalar output.
  private forward(ex: Example): number {
    const h = this.w.h
    const w1 = this.w.w1
    const aOwn = this.aOwn
    const aOpp = this.aOpp
    aOwn.set(this.w.b1)
    aOpp.set(this.w.b1)
    const sf = ex.stmFeats
    for (let k = 0; k < sf.length; k++) {
      const base = sf[k] * h
      for (let j = 0; j < h; j++) aOwn[j] += w1[base + j]
    }
    const of = ex.oppFeats
    for (let k = 0; k < of.length; k++) {
      const base = of[k] * h
      for (let j = 0; j < h; j++) aOpp[j] += w1[base + j]
    }
    let o = this.w.b2
    const w2 = this.w.w2
    for (let j = 0; j < h; j++) {
      const co = aOwn[j] < 0 ? 0 : aOwn[j] > 1 ? 1 : aOwn[j]
      const cp = aOpp[j] < 0 ? 0 : aOpp[j] > 1 ? 1 : aOpp[j]
      o += w2[j] * co + w2[h + j] * cp
    }
    return o
  }

  // One minibatch of full forward+backward+Adam. Returns the mean squared error.
  trainBatch(batch: Example[]): number {
    const h = this.w.h
    const w1 = this.w.w1
    const w2 = this.w.w2
    const gB1 = this.gB1
    const gW2 = this.gW2
    gB1.fill(0)
    gW2.fill(0)
    let gB2 = 0
    // Accumulate W1 gradients sparsely into a map keyed by feature row.
    const gW1rows = new Map<number, Float32Array>()
    const rowFor = (feat: number): Float32Array => {
      let r = gW1rows.get(feat)
      if (!r) {
        r = new Float32Array(h)
        gW1rows.set(feat, r)
      }
      return r
    }

    let sse = 0
    for (const ex of batch) {
      const o = this.forward(ex)
      const diff = o - ex.y
      sse += diff * diff
      const g = 2 * diff // dL/do
      gB2 += g
      const aOwn = this.aOwn
      const aOpp = this.aOpp
      // Output-layer + activation backprop.
      // daOwn[j] / daOpp[j] feed into b1 (shared) and the active W1 rows.
      const daOwn = new Float32Array(h)
      const daOpp = new Float32Array(h)
      for (let j = 0; j < h; j++) {
        const co = aOwn[j] < 0 ? 0 : aOwn[j] > 1 ? 1 : aOwn[j]
        const cp = aOpp[j] < 0 ? 0 : aOpp[j] > 1 ? 1 : aOpp[j]
        gW2[j] += g * co
        gW2[h + j] += g * cp
        // clipped-ReLU derivative: 1 strictly inside (0,1), else 0.
        const dOwn = aOwn[j] > 0 && aOwn[j] < 1 ? g * w2[j] : 0
        const dOpp = aOpp[j] > 0 && aOpp[j] < 1 ? g * w2[h + j] : 0
        daOwn[j] = dOwn
        daOpp[j] = dOpp
        gB1[j] += dOwn + dOpp
      }
      const sf = ex.stmFeats
      for (let k = 0; k < sf.length; k++) {
        const row = rowFor(sf[k])
        for (let j = 0; j < h; j++) row[j] += daOwn[j]
      }
      const of = ex.oppFeats
      for (let k = 0; k < of.length; k++) {
        const row = rowFor(of[k])
        for (let j = 0; j < h; j++) row[j] += daOpp[j]
      }
    }

    // Mean over the batch.
    const inv = 1 / batch.length
    for (let j = 0; j < h; j++) {
      gB1[j] *= inv
      gW2[j] *= inv
      gW2[h + j] *= inv
    }
    gB2 *= inv
    for (const row of gW1rows.values()) for (let j = 0; j < h; j++) row[j] *= inv

    // Adam step.
    this.t++
    const b1 = this.beta1
    const b2 = this.beta2
    const bc1 = 1 - Math.pow(b1, this.t)
    const bc2 = 1 - Math.pow(b2, this.t)
    const lr = this.lr
    const eps = this.eps

    const step = (p: Float32Array, gAt: (j: number) => number, m: Float32Array, v: Float32Array, idx: number, off: number) => {
      const g = gAt(idx)
      const mi = b1 * m[off] + (1 - b1) * g
      const vi = b2 * v[off] + (1 - b2) * g * g
      m[off] = mi
      v[off] = vi
      p[idx] -= (lr * (mi / bc1)) / (Math.sqrt(vi / bc2) + eps)
    }

    for (let j = 0; j < h; j++) step(this.w.b1, (i) => gB1[i], this.mB1, this.vB1, j, j)
    for (let j = 0; j < 2 * h; j++) step(this.w.w2, (i) => gW2[i], this.mW2, this.vW2, j, j)
    // b2 scalar.
    {
      const g = gB2
      this.mB2 = b1 * this.mB2 + (1 - b1) * g
      this.vB2 = b2 * this.vB2 + (1 - b2) * g * g
      this.w.b2 -= (lr * (this.mB2 / bc1)) / (Math.sqrt(this.vB2 / bc2) + eps)
    }
    // W1 rows (only the features that appeared in this batch).
    for (const [feat, row] of gW1rows) {
      const base = feat * h
      for (let j = 0; j < h; j++) {
        const off = base + j
        const g = row[j]
        const mi = b1 * this.mW1[off] + (1 - b1) * g
        const vi = b2 * this.vW1[off] + (1 - b2) * g * g
        this.mW1[off] = mi
        this.vW1[off] = vi
        w1[off] -= (lr * (mi / bc1)) / (Math.sqrt(vi / bc2) + eps)
      }
    }

    return sse * inv
  }
}

// Mean squared error of the net over a set of examples (no training).
export function datasetLoss(w: NnueWeights, examples: Example[]): number {
  const h = w.h
  const aOwn = new Float32Array(h)
  const aOpp = new Float32Array(h)
  let sse = 0
  for (const ex of examples) {
    aOwn.set(w.b1)
    aOpp.set(w.b1)
    for (let k = 0; k < ex.stmFeats.length; k++) {
      const base = ex.stmFeats[k] * h
      for (let j = 0; j < h; j++) aOwn[j] += w.w1[base + j]
    }
    for (let k = 0; k < ex.oppFeats.length; k++) {
      const base = ex.oppFeats[k] * h
      for (let j = 0; j < h; j++) aOpp[j] += w.w1[base + j]
    }
    let o = w.b2
    for (let j = 0; j < h; j++) {
      const co = aOwn[j] < 0 ? 0 : aOwn[j] > 1 ? 1 : aOwn[j]
      const cp = aOpp[j] < 0 ? 0 : aOpp[j] > 1 ? 1 : aOpp[j]
      o += w.w2[j] * co + w.w2[h + j] * cp
    }
    const d = o - ex.y
    sse += d * d
  }
  return sse / Math.max(1, examples.length)
}

export interface Correlation {
  r2: number // coefficient of determination of net-cp vs classical-cp
  r: number // Pearson correlation
  rmse: number // RMSE in centipawns
  points: { x: number; y: number }[] // (classical cp, net cp), sub-sampled
}

// Correlate the net's centipawn output against the classical eval on a holdout.
export function correlation(w: NnueWeights, examples: Example[], maxPoints = 400): Correlation {
  const h = w.h
  const aOwn = new Float32Array(h)
  const aOpp = new Float32Array(h)
  const xs: number[] = []
  const ys: number[] = []
  for (const ex of examples) {
    aOwn.set(w.b1)
    aOpp.set(w.b1)
    for (let k = 0; k < ex.stmFeats.length; k++) {
      const base = ex.stmFeats[k] * h
      for (let j = 0; j < h; j++) aOwn[j] += w.w1[base + j]
    }
    for (let k = 0; k < ex.oppFeats.length; k++) {
      const base = ex.oppFeats[k] * h
      for (let j = 0; j < h; j++) aOpp[j] += w.w1[base + j]
    }
    let o = w.b2
    for (let j = 0; j < h; j++) {
      const co = aOwn[j] < 0 ? 0 : aOwn[j] > 1 ? 1 : aOwn[j]
      const cp = aOpp[j] < 0 ? 0 : aOpp[j] > 1 ? 1 : aOpp[j]
      o += w.w2[j] * co + w.w2[h + j] * cp
    }
    xs.push(ex.cp)
    ys.push(o * OUT_SCALE)
  }
  const n = xs.length || 1
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0
  let syy = 0
  let sxy = 0
  let sse = 0
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
    const e = ys[i] - xs[i]
    sse += e * e
  }
  const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0
  // R² of the net's cp as a predictor of the classical cp (1 - SSE/SST).
  const sst = xs.reduce((a, b) => a + (b - mx) * (b - mx), 0)
  const r2 = sst > 0 ? 1 - sse / sst : 0
  const rmse = Math.sqrt(sse / n)
  // Sub-sample points for plotting.
  const points: { x: number; y: number }[] = []
  const stride = Math.max(1, Math.floor(xs.length / maxPoints))
  for (let i = 0; i < xs.length; i += stride) points.push({ x: xs[i], y: ys[i] })
  return { r2, r, rmse, points }
}

// --- Gradient check ---------------------------------------------------------

// Finite-difference check of a few hand-derived gradients against the analytic
// ones, returning the max relative error. Proves the backprop is correct.
export function gradCheck(seed = 7, nProbe = 12): { maxRelErr: number; checked: number } {
  const examples = generatePositions(24, seed)
  // Tiny weights + a 0.5 accumulator bias keep every clipped-ReLU unit strictly
  // inside (0,1), where the activation is differentiable (slope 1). That lets the
  // finite difference cleanly verify the full chain rule (W1 → accumulator → clip
  // → W2 → output → loss) without straddling a non-differentiable corner; the
  // clamped-region derivative (0) is trivially correct. Float32 params cap the
  // achievable precision, so the tolerance is the usual gradcheck 1e-2.
  const trainer = new NnueTrainer({ h: 16, seed, lr: 0, weightInit: 0.01 }) // lr 0: weights won't move
  const w = trainer.w
  w.b1.fill(0.5)
  const eps = 1e-3

  // Analytic gradient over the whole set via one batch with lr=0 is awkward (Adam
  // mutates moments); instead compute analytic grads directly here.
  const loss = (): number => datasetLoss(w, examples)

  // Build analytic gradient for the probed parameters by a manual backward pass.
  const h = w.h
  const gW1 = new Float32Array(w.w1.length)
  const gB1 = new Float32Array(h)
  const gW2 = new Float32Array(2 * h)
  let gB2 = 0
  const aOwn = new Float32Array(h)
  const aOpp = new Float32Array(h)
  for (const ex of examples) {
    aOwn.set(w.b1)
    aOpp.set(w.b1)
    for (let k = 0; k < ex.stmFeats.length; k++) {
      const base = ex.stmFeats[k] * h
      for (let j = 0; j < h; j++) aOwn[j] += w.w1[base + j]
    }
    for (let k = 0; k < ex.oppFeats.length; k++) {
      const base = ex.oppFeats[k] * h
      for (let j = 0; j < h; j++) aOpp[j] += w.w1[base + j]
    }
    let o = w.b2
    for (let j = 0; j < h; j++) {
      const co = aOwn[j] < 0 ? 0 : aOwn[j] > 1 ? 1 : aOwn[j]
      const cp = aOpp[j] < 0 ? 0 : aOpp[j] > 1 ? 1 : aOpp[j]
      o += w.w2[j] * co + w.w2[h + j] * cp
    }
    const g = (2 * (o - ex.y)) / examples.length
    gB2 += g
    const daOwn = new Float32Array(h)
    const daOpp = new Float32Array(h)
    for (let j = 0; j < h; j++) {
      const co = aOwn[j] < 0 ? 0 : aOwn[j] > 1 ? 1 : aOwn[j]
      const cp = aOpp[j] < 0 ? 0 : aOpp[j] > 1 ? 1 : aOpp[j]
      gW2[j] += g * co
      gW2[h + j] += g * cp
      daOwn[j] = aOwn[j] > 0 && aOwn[j] < 1 ? g * w.w2[j] : 0
      daOpp[j] = aOpp[j] > 0 && aOpp[j] < 1 ? g * w.w2[h + j] : 0
      gB1[j] += daOwn[j] + daOpp[j]
    }
    for (let k = 0; k < ex.stmFeats.length; k++) {
      const base = ex.stmFeats[k] * h
      for (let j = 0; j < h; j++) gW1[base + j] += daOwn[j]
    }
    for (let k = 0; k < ex.oppFeats.length; k++) {
      const base = ex.oppFeats[k] * h
      for (let j = 0; j < h; j++) gW1[base + j] += daOpp[j]
    }
  }

  // Probe a deterministic spread of parameters across all four tensors.
  const rng = mulberry32(seed ^ 0x55)
  let maxRel = 0
  let checked = 0
  const probeParam = (arr: Float32Array, idx: number, analytic: number) => {
    const orig = arr[idx]
    arr[idx] = orig + eps
    const lp = loss()
    arr[idx] = orig
    const l0 = loss()
    arr[idx] = orig - eps
    const lm = loss()
    arr[idx] = orig
    // Kink detector: at a clipped-ReLU corner the one-sided slopes disagree by an
    // O(1) jump, whereas in the smooth interior they differ only by O(f''·eps).
    const slopePlus = (lp - l0) / eps
    const slopeMinus = (l0 - lm) / eps
    if (Math.abs(slopePlus - slopeMinus) > 1e-3) return // straddled a kink — skip
    const num = (lp - lm) / (2 * eps)
    const denom = Math.max(1e-6, Math.abs(num) + Math.abs(analytic))
    const rel = Math.abs(num - analytic) / denom
    if (rel > maxRel) maxRel = rel
    checked++
  }
  for (let i = 0; i < nProbe; i++) {
    const idx = Math.floor(rng() * w.w1.length)
    probeParam(w.w1, idx, gW1[idx])
  }
  for (let i = 0; i < Math.min(nProbe, h); i++) probeParam(w.b1, i, gB1[i])
  for (let i = 0; i < Math.min(nProbe, 2 * h); i++) probeParam(w.w2, i, gW2[i])
  probeParam2(w, gB2, eps, loss, (rel) => {
    if (rel > maxRel) maxRel = rel
    checked++
  })
  return { maxRelErr: maxRel, checked }
}

function probeParam2(w: NnueWeights, analytic: number, eps: number, loss: () => number, report: (rel: number) => void): void {
  const orig = w.b2
  w.b2 = orig + eps
  const lp = loss()
  w.b2 = orig - eps
  const lm = loss()
  w.b2 = orig
  const num = (lp - lm) / (2 * eps)
  const denom = Math.max(1e-6, Math.abs(num) + Math.abs(analytic))
  report(Math.abs(num - analytic) / denom)
}
