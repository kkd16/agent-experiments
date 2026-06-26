// nnue.ts — a from-scratch NNUE (efficiently-updatable neural-network) evaluation.
//
// This is the one thing top modern engines added in the last decade and the one
// thing Cortex was missing: a learned evaluation that *replaces* the hand-crafted
// positional terms with a small neural net — and, crucially, one whose first layer
// (the "accumulator") is **incrementally updatable**, so a move costs O(features
// touched) instead of a full re-evaluation. Everything here is hand-rolled: no
// TensorFlow, no ONNX, no math libraries. The network is defined here; the
// hand-derived SGD trainer lives in `nnue-train.ts`.
//
// Architecture (a faithful-but-small NNUE):
//
//   768 inputs per perspective  ->  feature transformer (W1: 768 x H, b1: H)
//                                     => two accumulators a_white, a_black (size H)
//   eval(stm):  h = [ clip(a_stm) , clip(a_opp) ]        (size 2H, clipped ReLU)
//               o = b2 + W2 · h                          (scalar)
//               cp = round(o * OUT_SCALE)                (stm-relative centipawns)
//
// The 768 input features are (piece-class x square), where the piece-class folds in
// whether the piece is the perspective's *own* or the *enemy*'s, and the square is
// vertically mirrored for the black perspective. Because the feature set is NOT
// king-bucketed (plain piece-square, à la a simplified HalfKA), **every** move is a
// pure incremental update of the two accumulators — no full refresh is ever forced,
// and a null move touches nothing at all. That makes the incremental path provably
// equivalent to a from-scratch refresh, which the Lab self-tests check bit-for-bit.

import {
  type Position,
  type Move,
  WHITE,
  BLACK,
  EMPTY,
  PAWN,
  ROOK,
  KING,
  type Color,
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
} from './board'

// Default hidden width. Small enough to train in a couple of seconds in a browser
// tab, wide enough to clearly out-correlate a linear model.
export const DEFAULT_H = 128

// Output scaling: the net predicts a number ~[-3, 3]; one unit ≈ OUT_SCALE cp.
export const OUT_SCALE = 600
// Training labels are clamped to this many centipawns before scaling, so genuine
// tablebase mate scores don't blow up the regression target.
export const LABEL_CLAMP = 1800
// Hard clamp on the eval the net is allowed to emit, well inside the mate window.
export const EVAL_CLAMP = 3000

export interface NnueWeights {
  h: number // hidden width H
  w1: Float32Array // [768 * H], row-major by feature: w1[feat*H + j]
  b1: Float32Array // [H]
  w2: Float32Array // [2H]  (first H = own half, next H = opp half)
  b2: number
}

export const FEATURES = 768 // 12 piece-classes * 64 squares

// The structural contract the search relies on: a thing that can be refreshed from
// a position, folded forward/back across a move, and read as a stm-relative score.
// Both the float `Accumulator` (below) and the integer `QuantAccumulator`
// (`nnue-quant.ts`) satisfy it, so the search can drive either through one field.
export interface EvalAccumulator {
  refresh(p: Position): void
  applyMove(p: Position, m: Move, sign: number): void
  evalScore(stm: Color): number
}

// 0x88 square -> 0..63 (rank*8 + file).
export function to64(s: number): number {
  return rankOf(s) * 8 + fileOf(s)
}

// Feature index for a piece of (color, type) on 0..63 square `s64`, viewed from
// `persp`. Own pieces occupy classes 0..5, enemy pieces 6..11; black's view
// vertically mirrors the board so "my side" is always the bottom two ranks.
export function featureIndex(persp: Color, color: Color, type: number, s64: number): number {
  const ownness = color === persp ? 0 : 1
  const pclass = ownness * 6 + (type - 1)
  const rel = persp === WHITE ? s64 : s64 ^ 56
  return pclass * 64 + rel
}

// Allocate zeroed weights of the given width.
export function zeroWeights(h: number = DEFAULT_H): NnueWeights {
  return {
    h,
    w1: new Float32Array(FEATURES * h),
    b1: new Float32Array(h),
    w2: new Float32Array(2 * h),
    b2: 0,
  }
}

// The two accumulators (one per *color* perspective). Each is b1 + the sum of the
// W1 columns of every active feature for that perspective. They are color-indexed,
// not side-to-move-indexed, which is exactly what makes the incremental update
// turn-independent (a null move changes nothing here).
export class Accumulator {
  readonly white: Float32Array
  readonly black: Float32Array
  private readonly w: NnueWeights
  constructor(w: NnueWeights) {
    this.w = w
    this.white = new Float32Array(w.h)
    this.black = new Float32Array(w.h)
  }

  // Recompute both accumulators from scratch for a position (the "refresh" path).
  refresh(p: Position): void {
    const h = this.w.h
    this.white.set(this.w.b1)
    this.black.set(this.w.b1)
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
    void h
  }

  // Add (sign=+1) or remove (sign=-1) one piece's contribution to both halves.
  private addColumn(color: Color, type: number, s64: number, sign: number): void {
    const h = this.w.h
    const w1 = this.w.w1
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

  // Incrementally fold a move into the accumulators. `sign = +1` advances the
  // accumulators across the move (call while `p` is still the pre-move position,
  // then make the move on the board); `sign = -1` reverses it (call after the move
  // has been unmade so `p` is the pre-move position again). Because both directions
  // read the identical pre-move position and apply opposite signs, refresh and the
  // running incremental state stay bit-for-bit identical.
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

    // Castling — "king captures own rook" encoding (`to` is the rook origin).
    // Move both king and rook to their fixed g/c and f/d destinations; there is
    // no capture, so handle it whole and return.
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

    // Piece leaves `from`, (possibly promoted) piece lands on `to`.
    this.addColumn(us, mt, to64(from), -sign)
    this.addColumn(us, promo ? promo : mt, to64(to), sign)

    // Captures.
    if (flag === FLAG_EP) {
      const capSq = to - (us === WHITE ? 16 : -16)
      this.addColumn(them, PAWN, to64(capSq), -sign)
    } else if (board[to] !== EMPTY) {
      this.addColumn(them, pieceType(board[to]), to64(to), -sign)
    }
  }

  // Read the stm-relative evaluation out of the current accumulators.
  evalScore(stm: Color): number {
    return readEval(this.w, stm === WHITE ? this.white : this.black, stm === WHITE ? this.black : this.white)
  }
}

// Clipped ReLU, the NNUE activation: clamp to [0, 1].
function clip(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

// Forward the output layer from two raw accumulators (own + opp). Returns
// stm-relative centipawns.
function readEval(w: NnueWeights, own: Float32Array, opp: Float32Array): number {
  const h = w.h
  const w2 = w.w2
  let o = w.b2
  for (let j = 0; j < h; j++) {
    o += w2[j] * clip(own[j])
    o += w2[h + j] * clip(opp[j])
  }
  let cp = Math.round(o * OUT_SCALE)
  if (cp > EVAL_CLAMP) cp = EVAL_CLAMP
  else if (cp < -EVAL_CLAMP) cp = -EVAL_CLAMP
  return cp
}

// Convenience: a from-scratch NNUE evaluation of a position (allocates an
// accumulator, refreshes it, reads the score). Used for training, correlation and
// the equivalence self-tests; search keeps a persistent incremental accumulator.
export function nnueEvalFresh(w: NnueWeights, p: Position): number {
  const acc = new Accumulator(w)
  acc.refresh(p)
  return acc.evalScore(p.turn)
}

// Build a position evaluator closure (signature-compatible with `evaluate`) that
// refreshes a reused accumulator each call. Handy as a drop-in where keeping an
// incremental accumulator in sync isn't worth it (e.g. the head-to-head match).
export function makeFreshEvaluator(w: NnueWeights): (p: Position) => number {
  const acc = new Accumulator(w)
  return (p: Position) => {
    acc.refresh(p)
    return acc.evalScore(p.turn)
  }
}

// --- Serialization (for IndexedDB persistence + worker transfer) -------------

export interface NnueBlob {
  h: number
  w1: number[]
  b1: number[]
  w2: number[]
  b2: number
}

export function serializeNnue(w: NnueWeights): NnueBlob {
  return { h: w.h, w1: Array.from(w.w1), b1: Array.from(w.b1), w2: Array.from(w.w2), b2: w.b2 }
}

export function deserializeNnue(b: NnueBlob): NnueWeights {
  return {
    h: b.h,
    w1: Float32Array.from(b.w1),
    b1: Float32Array.from(b.b1),
    w2: Float32Array.from(b.w2),
    b2: b.b2,
  }
}
