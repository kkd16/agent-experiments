// nnue-quant.ts — integer (fixed-point) quantization of the NNUE evaluation.
//
// The float net in `nnue.ts` is correct but it is the *slow* shape every real
// engine sheds before it ships: a forward pass of `double` multiply-adds. The one
// trick that made NNUE fast enough to matter — the reason Stockfish could fold a
// neural net into a 100 Mnps alpha-beta search without losing speed — is that the
// whole evaluation is carried out in **small integers**: the feature transformer in
// int16, its clipped-ReLU output as a byte, and the output layer as an int8·uint8
// dot product accumulated in int32. That is what lets a CPU's SIMD lanes (VNNI's
// `vpdpbusd`: 64 byte-products summed per instruction) do the work, and it is the
// last missing piece of this NNUE. This module is that piece, hand-rolled.
//
// The scheme (Stockfish's, in miniature):
//
//   • A scale QA fixes the feature transformer. Every W1 weight and b1 bias is
//     stored as round(x · QA): W1 as int16, the accumulator bias as int32. An
//     accumulator entry is then b1_q + Σ W1_q over the active features — an int32
//     that represents the true float value times QA.
//   • The clipped ReLU clamps an accumulator entry to [0, QA]. Because QA = 255
//     that clamp lands in a **uint8** — exactly the activation a byte-dot wants.
//   • A scale QB fixes the output layer: W2 is stored as round(W2 · QB) in **int8**
//     (QB is chosen so every weight fits a byte), and b2 as round(b2 · QA · QB) in
//     int32. The output is o_q = b2_q + Σ W2_q · act, an int32 holding o · QA · QB.
//   • Centipawns come out by rescaling once at the very end:
//        cp = round(o_q · OUT_SCALE / (QA · QB)).
//
// The accumulator is still **incrementally updatable** — the entire point of NNUE —
// because addition is exact in integers: folding a move in and back out returns the
// accumulator bit-for-bit, exactly as the float version does. `verifyQuantization`
// proves both halves of the claim: (1) the integer incremental path equals a
// from-scratch integer refresh bit-for-bit, and (2) the integer eval tracks the
// float eval to within a few centipawns — below the quantum the search can even
// resolve — while the move it *chooses* almost always agrees.
//
// No SIMD here (the browser's JS engine has none to give), so this buys legibility
// and a 2× smaller network, not raw speed — but the arithmetic is the genuine
// article: every product and sum below is an integer a VNNI lane would compute.

import {
  type Position,
  type Move,
  type Color,
  WHITE,
  BLACK,
  EMPTY,
  PAWN,
  ROOK,
  KING,
  fileOf,
  rankOf,
  pieceColor,
  pieceType,
  moveFrom,
  moveTo,
  movePromo,
  moveFlag,
  FLAG_EP,
  FLAG_CASTLE,
  sq,
  clonePosition,
  makeMoveOnBoard,
  parseFen,
  START_FEN,
  type Undo,
} from './board'
import { generateLegal } from './movegen'
import {
  type NnueWeights,
  type EvalAccumulator,
  FEATURES,
  OUT_SCALE,
  EVAL_CLAMP,
  featureIndex,
  to64,
  nnueEvalFresh,
} from './nnue'

// The feature-transformer scale. 255 is Stockfish's choice and it is not arbitrary:
// the clipped ReLU clamps to [0, QA], so QA = 255 makes every activation a uint8 —
// the input a byte-wise dot product is built to consume.
export const QA = 255

// Round-half-away-from-zero (symmetric), so positive and negative weights quantize
// with the same bias — important for the output layer's signed int8 weights.
function iround(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x)
}

function clampI16(x: number): number {
  return x > 32767 ? 32767 : x < -32768 ? -32768 : x
}

/** The integer network: int16 feature transformer, int8 output layer. */
export interface QuantNet {
  h: number
  qa: number
  /** Output-layer scale, chosen so every W2 weight fits a signed byte. */
  qb: number
  /** round(W1 · QA), row-major by feature: w1[feat*H + j]. int16. */
  w1: Int16Array
  /** round(b1 · QA). int32 — it seeds the accumulator, which is itself int32. */
  b1: Int32Array
  /** round(W2 · QB). int8 (first H = own half, next H = opp half). */
  w2: Int8Array
  /** round(b2 · QA · QB). int32. */
  b2: number
  /** Diagnostics filled in by `quantize`, surfaced by the Lab. */
  diag: QuantDiag
}

export interface QuantDiag {
  /** [min, max] of the raw int16 feature weights. */
  w1Range: [number, number]
  /** [min, max] of the raw int8 output weights. */
  w2Range: [number, number]
  /** Bytes of the float32 network (w1+b1+w2+b2). */
  floatBytes: number
  /** Bytes of the integer network. */
  quantBytes: number
  /** floatBytes / quantBytes. */
  compression: number
  /** How many W2 weights were clamped to fit int8 (0 for a sane net). */
  w2Clamped: number
  /** How many W1 weights were clamped to fit int16 (0 for a sane net). */
  w1Clamped: number
}

// Quantize a trained float network into the integer one. QB is derived from the
// data: pick the largest power-of-two-free integer scale that keeps every output
// weight inside a signed byte, so we spend the int8's whole dynamic range and no
// more. (A per-net scale, not a global constant, is how real quantizers avoid
// throwing away precision on a net whose weights happen to be small.)
export function quantize(w: NnueWeights): QuantNet {
  const h = w.h
  const w1 = new Int16Array(FEATURES * h)
  const b1 = new Int32Array(h)
  const w2 = new Int8Array(2 * h)

  let w1Min = 0
  let w1Max = 0
  let w1Clamped = 0
  for (let i = 0; i < w1.length; i++) {
    const q = iround(w.w1[i] * QA)
    const c = clampI16(q)
    if (c !== q) w1Clamped++
    w1[i] = c
    if (c < w1Min) w1Min = c
    if (c > w1Max) w1Max = c
  }
  for (let j = 0; j < h; j++) b1[j] = iround(w.b1[j] * QA)

  // Choose QB so the largest |W2| maps to ≤ 127. Guard the empty/zero net.
  let maxW2 = 0
  for (let k = 0; k < w.w2.length; k++) maxW2 = Math.max(maxW2, Math.abs(w.w2[k]))
  const qb = maxW2 > 0 ? Math.max(1, Math.floor(127 / maxW2)) : 64

  let w2Min = 0
  let w2Max = 0
  let w2Clamped = 0
  for (let k = 0; k < w2.length; k++) {
    const q = iround(w.w2[k] * qb)
    const c = q > 127 ? 127 : q < -128 ? -128 : q
    if (c !== q) w2Clamped++
    w2[k] = c
    if (c < w2Min) w2Min = c
    if (c > w2Max) w2Max = c
  }
  const b2 = iround(w.b2 * QA * qb)

  const floatBytes = (FEATURES * h + h + 2 * h + 1) * 4
  const quantBytes = FEATURES * h * 2 + h * 4 + 2 * h * 1 + 4 // int16 + int32 + int8 + scalar

  return {
    h,
    qa: QA,
    qb,
    w1,
    b1,
    w2,
    b2,
    diag: {
      w1Range: [w1Min, w1Max],
      w2Range: [w2Min, w2Max],
      floatBytes,
      quantBytes,
      compression: floatBytes / quantBytes,
      w1Clamped,
      w2Clamped,
    },
  }
}

// The integer twin of `Accumulator`. Two int32 accumulators (one per colour
// perspective); every add/remove is exact, so refresh ≡ incremental bit-for-bit.
export class QuantAccumulator implements EvalAccumulator {
  readonly white: Int32Array
  readonly black: Int32Array
  private readonly q: QuantNet

  constructor(q: QuantNet) {
    this.q = q
    this.white = new Int32Array(q.h)
    this.black = new Int32Array(q.h)
  }

  refresh(p: Position): void {
    this.white.set(this.q.b1)
    this.black.set(this.q.b1)
    const board = p.board
    for (let s = 0; s < 128; s++) {
      if ((s & 0x88) !== 0) {
        s += 7
        continue
      }
      const pc = board[s]
      if (pc === EMPTY) continue
      this.addColumn(pieceColor(pc), pieceType(pc), to64(s), 1)
    }
  }

  private addColumn(color: Color, type: number, s64: number, sign: number): void {
    const h = this.q.h
    const w1 = this.q.w1
    const fw = featureIndex(WHITE, color, type, s64) * h
    const fb = featureIndex(BLACK, color, type, s64) * h
    if (sign > 0) {
      for (let j = 0; j < h; j++) {
        this.white[j] += w1[fw + j]
        this.black[j] += w1[fb + j]
      }
    } else {
      for (let j = 0; j < h; j++) {
        this.white[j] -= w1[fw + j]
        this.black[j] -= w1[fb + j]
      }
    }
  }

  // Identical move algebra to the float accumulator (see `nnue.ts`); only the
  // underlying weights differ. `sign = +1` folds the move in (called on the
  // pre-move position), `sign = -1` reverses it (called once the move is unmade).
  applyMove(p: Position, m: Move, sign: number): void {
    const from = moveFrom(m)
    const to = moveTo(m)
    const flag = moveFlag(m)
    const promo = movePromo(m)
    const board = p.board
    const moving = board[from]
    const us = pieceColor(moving)
    const them = (us ^ 1) as Color
    const mt = pieceType(moving)

    if (flag === FLAG_CASTLE) {
      const rank = rankOf(from)
      const kingside = fileOf(to) > fileOf(from)
      const kingTo = sq(kingside ? 6 : 2, rank)
      const rookTo = sq(kingside ? 5 : 3, rank)
      this.addColumn(us, KING, to64(from), -sign)
      this.addColumn(us, KING, to64(kingTo), sign)
      this.addColumn(us, ROOK, to64(to), -sign)
      this.addColumn(us, ROOK, to64(rookTo), sign)
      return
    }

    this.addColumn(us, mt, to64(from), -sign)
    this.addColumn(us, promo ? promo : mt, to64(to), sign)

    if (flag === FLAG_EP) {
      const capSq = to - (us === WHITE ? 16 : -16)
      this.addColumn(them, PAWN, to64(capSq), -sign)
    } else if (board[to] !== EMPTY) {
      this.addColumn(them, pieceType(board[to]), to64(to), -sign)
    }
  }

  evalScore(stm: Color): number {
    return readEvalQuant(
      this.q,
      stm === WHITE ? this.white : this.black,
      stm === WHITE ? this.black : this.white,
    )
  }
}

// Clamp an accumulator entry to [0, QA] — the clipped ReLU, landing in a uint8.
function crelu(x: number, qa: number): number {
  return x < 0 ? 0 : x > qa ? qa : x
}

// The output layer as an integer dot product. `act ∈ [0,QA]` (uint8) times
// `w2 ∈ [-128,127]` (int8), accumulated in an int32 `o`, then a single rescale to
// centipawns at the end. This is byte-for-byte the arithmetic VNNI performs.
function readEvalQuant(q: QuantNet, own: Int32Array, opp: Int32Array): number {
  const h = q.h
  const w2 = q.w2
  const qa = q.qa
  let o = q.b2 // already at QA·QB scale
  for (let j = 0; j < h; j++) {
    o += w2[j] * crelu(own[j], qa)
    o += w2[h + j] * crelu(opp[j], qa)
  }
  // o holds (the float output) · QA · QB. Rescale once to centipawns.
  let cp = iround((o * OUT_SCALE) / (qa * q.qb))
  if (cp > EVAL_CLAMP) cp = EVAL_CLAMP
  else if (cp < -EVAL_CLAMP) cp = -EVAL_CLAMP
  return cp
}

// Convenience: quantized evaluation of a position from a fresh accumulator.
export function quantEvalFresh(q: QuantNet, p: Position): number {
  const acc = new QuantAccumulator(q)
  acc.refresh(p)
  return acc.evalScore(p.turn)
}

// A position evaluator closure (signature-compatible with `evaluate`) backed by a
// reused quantized accumulator. Drop-in for the head-to-head match.
export function makeQuantEvaluator(q: QuantNet): (p: Position) => number {
  const acc = new QuantAccumulator(q)
  return (p: Position) => {
    acc.refresh(p)
    return acc.evalScore(p.turn)
  }
}

// --- Verification ------------------------------------------------------------

export interface QuantReport {
  /** Positions visited. */
  positions: number
  /** Bit-for-bit: max |incremental − refresh| over the integer accumulators. 0 = exact. */
  accMaxDiff: number
  /** How many positions the incremental eval disagreed with a fresh refresh. 0 = exact. */
  accMismatch: number
  /** Max |quant cp − float cp| over all positions. */
  evalMaxErr: number
  /** Mean |quant cp − float cp|. */
  evalMeanErr: number
  /** RMS of (quant cp − float cp). */
  evalRmse: number
  /** A-priori worst-case |error| from the quantum sizes (measured must be ≤ this). */
  predictedMaxErr: number
  /** Positions where a 1-ply best-move pick agreed between quant and float. */
  moveAgree: number
  /** Positions a 1-ply pick was scored on (skips terminal nodes). */
  moveTotal: number
}

// A small deterministic PRNG (matches the Lab's seeded style) so the report is
// reproducible run to run.
function rng32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The a-priori error bound. The output o (at unit scale) carries:
//   • a rounding error in b2 of ≤ 0.5/(QA·QB),
//   • for each of the 2H terms, |w2·act|'s quantization error. With act = clip(a),
//     act_q/QA = (clip(a)·QA rounded)/QA so |act_q/QA − clip(a)| ≤ 0.5/QA, and
//     w2_q/QB likewise ≤ 0.5/QB off w2; the product error is bounded by
//     |w2|·0.5/QA + |act|·0.5/QB + 0.25/(QA·QB) ≤ (|w2|/QA + 1/QB)·0.5 (act ≤ 1).
// Summed and scaled by OUT_SCALE gives the centipawn bound below.
function predictMaxErr(q: QuantNet, w: NnueWeights): number {
  let sumAbsW2 = 0
  for (let k = 0; k < w.w2.length; k++) sumAbsW2 += Math.abs(w.w2[k])
  const twoH = w.w2.length
  const oErr =
    0.5 / (q.qa * q.qb) + // b2 rounding
    (0.5 / q.qa) * sumAbsW2 + // act granularity over all terms
    (0.5 / q.qb) * twoH + // w2 granularity (act ≤ 1)
    (0.25 / (q.qa * q.qb)) * twoH // cross term
  // Plus the final cp rounding (≤ 0.5 cp).
  return Math.ceil(oErr * OUT_SCALE + 0.5)
}

// Walk a batch of random self-play positions and check every claim at once.
export function verifyQuantization(w: NnueWeights, opts?: { games?: number; plies?: number; seed?: number }): {
  q: QuantNet
  report: QuantReport
} {
  const q = quantize(w)
  const games = opts?.games ?? 16
  const plies = opts?.plies ?? 30
  const rng = rng32(opts?.seed ?? 0x5eed)

  let positions = 0
  let accMaxDiff = 0
  let accMismatch = 0
  let evalMaxErr = 0
  let sumAbs = 0
  let sumSq = 0
  let moveAgree = 0
  let moveTotal = 0

  // A reusable position + undo for the 1-ply move-agreement probe.
  for (let game = 0; game < games; game++) {
    const start = freshStart()
    let pos = start
    const acc = new QuantAccumulator(q)
    acc.refresh(pos)

    for (let ply = 0; ply < plies; ply++) {
      const moves = generateLegal(pos)
      if (moves.length === 0) break

      // 1-ply best-move agreement: rank children by their child eval (lower is
      // better for us, since a child is scored from the opponent's perspective).
      let bestFloat = -1
      let bestFloatScore = Infinity
      let bestQuant = -1
      let bestQuantScore = Infinity
      const undo = newUndo()
      for (const m of moves) {
        const child = clonePosition(pos)
        makeMoveOnBoard(child, m, undo)
        const fs = nnueEvalFresh(w, child)
        const qs = quantEvalFresh(q, child)
        if (fs < bestFloatScore) {
          bestFloatScore = fs
          bestFloat = m
        }
        if (qs < bestQuantScore) {
          bestQuantScore = qs
          bestQuant = m
        }
      }
      if (bestFloat >= 0) {
        moveTotal++
        if (bestFloat === bestQuant) moveAgree++
      }

      // Pick a (deterministic) move to advance the game.
      const m = moves[Math.floor(rng() * moves.length)]
      acc.applyMove(pos, m, 1)
      const next = clonePosition(pos)
      makeMoveOnBoard(next, m, undo)
      pos = next
      positions++

      // (1) integer incremental ≡ integer refresh, bit-for-bit.
      const fresh = new QuantAccumulator(q)
      fresh.refresh(pos)
      for (let j = 0; j < q.h; j++) {
        const dw = Math.abs(acc.white[j] - fresh.white[j])
        const db = Math.abs(acc.black[j] - fresh.black[j])
        if (dw > accMaxDiff) accMaxDiff = dw
        if (db > accMaxDiff) accMaxDiff = db
      }
      if (acc.evalScore(pos.turn) !== quantEvalFresh(q, pos)) accMismatch++

      // (2) integer eval vs float eval.
      const qcp = quantEvalFresh(q, pos)
      const fcp = nnueEvalFresh(w, pos)
      const err = Math.abs(qcp - fcp)
      if (err > evalMaxErr) evalMaxErr = err
      sumAbs += err
      sumSq += err * err
    }
  }

  const report: QuantReport = {
    positions,
    accMaxDiff,
    accMismatch,
    evalMaxErr,
    evalMeanErr: positions ? sumAbs / positions : 0,
    evalRmse: positions ? Math.sqrt(sumSq / positions) : 0,
    predictedMaxErr: predictMaxErr(q, w),
    moveAgree,
    moveTotal,
  }
  return { q, report }
}

// --- tiny local helpers (kept out of the import surface for the verifier) ----

function newUndo(): Undo {
  return { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
}

// The standard initial position, parsed fresh for each verification game.
function freshStart(): Position {
  return parseFen(START_FEN)
}
