// mcts.ts — a from-scratch AlphaZero-style PUCT Monte-Carlo Tree Search.
//
// Cortex's main brain is a classical alpha-beta searcher (search.ts): it proves
// a move best by exhausting a tree with cutoffs. This module adds the *other*
// modern search paradigm — the one AlphaZero / Leela are built on — entirely from
// scratch and sharing Cortex's own board, movegen and evaluation:
//
//   • a search **tree** grown one simulation at a time, each simulation walking
//     from the root to a leaf by the **PUCT** rule, expanding that leaf, reading a
//     **value** for it, and backing the value up the path (negamax sign-flipping);
//   • **no random rollouts** — the leaf value is the position's static evaluation
//     (classical or the NNUE net) squashed to a win-probability, exactly as a
//     value network is used in AlphaZero;
//   • a **policy** that turns the move list into a prior distribution — either a
//     cheap hand-crafted feature policy, or a "1-ply eval" policy that softmaxes
//     the evaluator's own one-move-deep scores (so the priors and the value come
//     from the same brain);
//   • **eval-initialised first-play urgency**: an unvisited move's optimistic Q is
//     its own 1-ply eval, so the tree spends its first visits on the moves the
//     evaluator already likes instead of fanning out blindly;
//   • **Dirichlet root noise** and a **temperature** on the final move choice, the
//     two knobs AlphaZero uses for exploration / self-play diversity.
//
// The output is a *visit distribution* over the root moves: the most-visited move
// is the search's choice, and the visit counts (not the raw evals) are the policy
// the UI renders as bars. Verified by `mctsSelftest` (mates found, distribution
// normalised, visit bookkeeping exact, PV legal).

import {
  type Position,
  type Move,
  type Color,
  type Undo,
  WHITE,
  PAWN,
  KNIGHT,
  BISHOP,
  QUEEN,
  KING,
  parseFen,
  fileOf,
  rankOf,
  pieceColor,
  pieceType,
  moveFrom,
  moveTo,
  movePromo,
  moveFlag,
  FLAG_CASTLE,
  FLAG_EP,
  makeMoveOnBoard,
  unmakeMoveOnBoard,
} from './board'
import { generateLegal, isSquareAttacked } from './movegen'
import { see } from './see'
import { evaluate } from './eval'
import { makeFreshEvaluator, type NnueWeights } from './nnue'

// A position evaluator: stm-relative centipawns (the same contract as `evaluate`).
export type CpEvaluator = (p: Position) => number

export type PolicyKind = 'heuristic' | 'eval1'
export type ValueSource = 'classical' | 'nnue'

export interface MctsOptions {
  /** Number of simulations (playouts) to run; 0 = unbounded (use maxTime). */
  maxNodes: number
  /** Wall-clock budget in ms; 0 = no limit. */
  maxTime: number
  /** PUCT exploration constant (AlphaZero default ≈ 1.5–2.5). */
  cpuct: number
  /** Prior policy: cheap hand-crafted features, or a 1-ply eval softmax. */
  policy: PolicyKind
  /** Softmax temperature for the move-selection visit distribution (0 = argmax). */
  temperature: number
  /** Root Dirichlet-noise weight ε in [0,1] (0 = none). */
  dirichlet: number
  /** Dirichlet concentration α (AlphaZero chess ≈ 0.3). */
  dirichletAlpha: number
  /** Which static evaluation feeds the value (and the eval1 policy). */
  evalSource: ValueSource
  /** Deterministic seed for Dirichlet noise + temperature sampling. */
  seed: number
}

export const MCTS_DEFAULTS: MctsOptions = {
  maxNodes: 4000,
  maxTime: 0,
  cpuct: 2.0,
  policy: 'eval1',
  temperature: 0,
  dirichlet: 0,
  dirichletAlpha: 0.3,
  evalSource: 'classical',
  seed: 0x5eed,
}

// One root-move summary for the UI: visit count, mean action-value Q (stm
// perspective, in [-1,1]), prior probability, and the move itself.
export interface RootMoveStat {
  move: Move
  visits: number
  q: number
  prior: number
}

export interface MctsResult {
  bestMove: Move | null
  /** Position value in [-1,1] from the side-to-move's perspective. */
  rootValue: number
  /** `rootValue` mapped back to centipawns for the eval bar. */
  scoreCp: number
  /** Mate flag derived from a terminal best line, or null. */
  mate: number | null
  /** Simulations actually run. */
  nodes: number
  timeMs: number
  /** Simulations per second. */
  nps: number
  /** Principal variation (greedy by visit count), as move ints. */
  pv: Move[]
  /** Root moves sorted by visit count, descending. */
  children: RootMoveStat[]
  /** Deepest path reached in the tree. */
  treeDepth: number
}

// ----------------------------------------------------------------------------
// Value mapping: centipawns ⇄ a win-probability-flavoured value in (-1, 1).
// The logistic is the Elo curve (base-10, 400-scale), so +100 cp ≈ +0.28 and
// +600 cp ≈ +0.94 — and it is exactly invertible for the eval-bar readout.
// ----------------------------------------------------------------------------
const CP_SCALE = 400

export function cpToValue(cp: number): number {
  const p = 1 / (1 + Math.pow(10, -cp / CP_SCALE))
  return 2 * p - 1
}

export function valueToCp(v: number): number {
  const clamped = v < -0.9995 ? -0.9995 : v > 0.9995 ? 0.9995 : v
  const p = (clamped + 1) / 2
  return Math.round(-CP_SCALE * Math.log10(1 / p - 1))
}

// ----------------------------------------------------------------------------
// A tiny seeded RNG (mulberry32) + a normal/gamma sampler for Dirichlet noise.
// ----------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sampleNormal(rng: () => number): number {
  // Box–Muller; guard the log against u1 = 0.
  let u1 = rng()
  if (u1 < 1e-12) u1 = 1e-12
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

// Marsaglia–Tsang gamma sampler (shape a > 0, scale 1). For a < 1 the standard
// boost γ(a) = γ(a+1)·U^(1/a) keeps it valid.
function sampleGamma(a: number, rng: () => number): number {
  if (a < 1) {
    const u = Math.max(rng(), 1e-12)
    return sampleGamma(a + 1, rng) * Math.pow(u, 1 / a)
  }
  const d = a - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = sampleNormal(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

// A Dirichlet(α,…,α) sample of length n: independent Gamma(α) draws normalised.
function sampleDirichlet(n: number, alpha: number, rng: () => number): Float64Array {
  const out = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    out[i] = sampleGamma(alpha, rng)
    sum += out[i]
  }
  if (sum <= 0) {
    out.fill(1 / n)
    return out
  }
  for (let i = 0; i < n; i++) out[i] /= sum
  return out
}

// ----------------------------------------------------------------------------
// Policy: turn a position's legal moves into a prior distribution + a per-move
// "init value" (the optimistic Q an unvisited move starts with, parent
// perspective, in [-1,1]).
// ----------------------------------------------------------------------------

// Centre-ness of a square in [0,1] — peaks on d4/e4/d5/e5.
function centerScore(s: number): number {
  const f = fileOf(s)
  const r = rankOf(s)
  const df = 3.5 - Math.abs(f - 3.5)
  const dr = 3.5 - Math.abs(r - 3.5)
  return (df + dr) / 7
}

const MVV = [0, 1, 3, 3, 5, 9, 0]

// Hand-crafted move logits (stm perspective). Cheap — no make/unmake.
function heuristicLogits(p: Position, moves: Move[]): Float64Array {
  const logits = new Float64Array(moves.length)
  const enemy = (p.turn ^ 1) as Color
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    const from = moveFrom(m)
    const to = moveTo(m)
    const flag = moveFlag(m)
    const moving = pieceType(p.board[from])
    let g = 0

    // Captures: MVV with an SEE sanity gate — winning captures are loud, losing
    // ones (a hung trade) are quietened well below a normal quiet move.
    const isCapture = flag === FLAG_EP || (p.board[to] !== 0 && pieceColor(p.board[to]) === enemy)
    if (isCapture) {
      const victim = flag === FLAG_EP ? PAWN : pieceType(p.board[to])
      const exch = see(p, m)
      g += exch >= 0 ? 1.4 + MVV[victim] * 0.18 : -1.6 + exch / 300
    }

    // Promotion — a queen is decisive, a minor underpromotion rarely wanted.
    const promo = movePromo(m)
    if (promo === QUEEN) g += 2.2
    else if (promo !== 0) g += 0.2

    // Castling = king safety; a small, reliable nudge.
    if (flag === FLAG_CASTLE) g += 0.8

    // Centralisation of the moving piece (knights/bishops/pawns benefit most).
    const centerGain = centerScore(to) - centerScore(from)
    if (moving === KNIGHT || moving === BISHOP) g += centerGain * 1.4
    else if (moving === PAWN) g += centerGain * 0.8
    else g += centerGain * 0.4

    // Develop a minor off the back rank early; nudge the queen to stay home.
    const backRank = p.turn === WHITE ? 0 : 7
    if ((moving === KNIGHT || moving === BISHOP) && rankOf(from) === backRank) g += 0.5
    if (moving === QUEEN && rankOf(from) === backRank && p.fullmove <= 8) g -= 0.4
    if (moving === KING && flag !== FLAG_CASTLE && p.fullmove <= 12) g -= 0.5

    logits[i] = g
  }
  return logits
}

// Softmax with temperature τ over logits → probabilities.
function softmax(logits: Float64Array, tau: number): Float64Array {
  const n = logits.length
  const out = new Float64Array(n)
  if (n === 0) return out
  const t = tau > 1e-6 ? tau : 1e-6
  let max = -Infinity
  for (let i = 0; i < n; i++) if (logits[i] > max) max = logits[i]
  let sum = 0
  for (let i = 0; i < n; i++) {
    out[i] = Math.exp((logits[i] - max) / t)
    sum += out[i]
  }
  for (let i = 0; i < n; i++) out[i] /= sum
  return out
}

// ----------------------------------------------------------------------------
// The search tree.
// ----------------------------------------------------------------------------
// Game-theoretic proof state for the MCTS-Solver layer (Winands et al.). Statistics
// drive the search, but whenever a subtree is *proved* — a forced mate, a forced
// loss, or a forced draw — that exact verdict overrides the estimate and flows up
// the tree, so Cortex's MCTS finds and reports mates as exactly as its alpha-beta
// searcher does, instead of merely scoring them "very winning".
const UNKNOWN = 0
const WIN = 1 // the side to move at this node has a forced win
const LOSS = 2 // the side to move is forced to lose
const DRAW = 3 // the result is a forced draw

interface Node {
  expanded: boolean
  terminal: boolean
  /** Leaf value, stm perspective, in [-1,1] (also the terminal value). */
  value: number
  /** Proof state (UNKNOWN/WIN/LOSS/DRAW) from the side-to-move's perspective. */
  proven: number
  /** Plies to mate when proven WIN/LOSS (0 at a terminal checkmate). */
  mateDepth: number
  /** Child index that carries the proof (the winning move, or the max-resist move). */
  proofChild: number
  moves: Int32Array
  prior: Float64Array
  /** Optimistic init Q per child, parent perspective. */
  initQ: Float64Array
  childN: Int32Array
  childW: Float64Array
  childSum: number // Σ childN, cached for the PUCT denominator
  children: (Node | null)[]
}

function newNode(): Node {
  return {
    expanded: false,
    terminal: false,
    value: 0,
    proven: UNKNOWN,
    mateDepth: 0,
    proofChild: -1,
    moves: EMPTY_MOVES,
    prior: EMPTY_F64,
    initQ: EMPTY_F64,
    childN: EMPTY_I32,
    childW: EMPTY_F64,
    childSum: 0,
    children: [],
  }
}
const EMPTY_MOVES = new Int32Array(0)
const EMPTY_F64 = new Float64Array(0)
const EMPTY_I32 = new Int32Array(0)

export class Mcts {
  private readonly evalCp: CpEvaluator
  private readonly opt: MctsOptions
  private readonly rng: () => number
  private readonly undos: Undo[] = []
  private readonly pathNode: Node[] = []
  private readonly pathChild: number[] = []
  private readonly pathMove: Move[] = []
  private maxDepthSeen = 0
  private stopped = false

  constructor(evalCp: CpEvaluator, opt: MctsOptions) {
    this.evalCp = evalCp
    this.opt = opt
    this.rng = makeRng(opt.seed)
  }

  stop(): void {
    this.stopped = true
  }

  private freshUndo(ply: number): Undo {
    let u = this.undos[ply]
    if (!u) {
      u = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
      this.undos[ply] = u
    }
    return u
  }

  // Expand `node` for the current `pos`: detect terminals, otherwise compute the
  // legal moves, the prior policy, the per-child init Q and the node's own value.
  private expand(node: Node, pos: Position): void {
    node.expanded = true
    const moves = generateLegal(pos)
    if (moves.length === 0) {
      node.terminal = true
      // Side to move has no moves: checkmate (in check) loses, stalemate draws.
      const mated = isSquareAttacked(pos, pos.kings[pos.turn], (pos.turn ^ 1) as Color)
      node.value = mated ? -1 : 0
      node.proven = mated ? LOSS : DRAW
      node.mateDepth = 0
      return
    }
    if (pos.halfmove >= 100) {
      // 50-move rule: a proven draw regardless of material.
      node.terminal = true
      node.value = 0
      node.proven = DRAW
      return
    }

    node.moves = Int32Array.from(moves)
    const n = moves.length
    node.childN = new Int32Array(n)
    node.childW = new Float64Array(n)
    node.children = new Array(n).fill(null)
    node.childSum = 0

    node.value = cpToValue(this.evalCp(pos))

    if (this.opt.policy === 'eval1') {
      // 1-ply eval policy: make each move, read the child's value (negated to the
      // parent's perspective), softmax those into priors, and reuse them as the
      // per-child optimistic init Q. Priors and value share one evaluator.
      const childVal = new Float64Array(n)
      const undo = this.freshUndo(1024) // a scratch slot well past any real ply
      for (let i = 0; i < n; i++) {
        makeMoveOnBoard(pos, moves[i], undo)
        // Value from the child's stm; negate to the parent's perspective.
        const v = -cpToValue(this.evalCp(pos))
        childVal[i] = v
        unmakeMoveOnBoard(pos, moves[i], undo)
      }
      node.initQ = childVal
      // Sharpen before softmax so the distribution actually concentrates on the
      // good moves (raw values live in a narrow band).
      const logits = new Float64Array(n)
      for (let i = 0; i < n; i++) logits[i] = childVal[i] * EVAL1_SHARP
      node.prior = softmax(logits, 1)
    } else {
      const logits = heuristicLogits(pos, moves)
      node.prior = softmax(logits, HEURISTIC_TAU)
      // Uniform optimistic init = node value minus a mild reduction.
      const init = new Float64Array(n)
      init.fill(node.value - FPU_REDUCTION)
      node.initQ = init
    }
  }

  // Mix Dirichlet noise into a freshly-expanded root's priors (exploration).
  private addRootNoise(root: Node): void {
    if (this.opt.dirichlet <= 0 || root.terminal || root.prior.length === 0) return
    const eps = this.opt.dirichlet
    const noise = sampleDirichlet(root.prior.length, this.opt.dirichletAlpha, this.rng)
    for (let i = 0; i < root.prior.length; i++) {
      root.prior[i] = (1 - eps) * root.prior[i] + eps * noise[i]
    }
  }

  // PUCT child selection: argmax_a  Q(a) + cpuct · P(a) · √Σn / (1 + n(a)).
  // Proven children short-circuit the formula: a move to an opponent forced-loss is
  // taken (shortest mate first), a move to an opponent forced-win is shunned (and if
  // forced, the longest-resisting one is chosen), a forced draw scores a flat 0.
  private selectChild(node: Node): number {
    const sqrtSum = Math.sqrt(node.childSum + 1)
    const c = this.opt.cpuct
    let best = -Infinity
    let bestI = 0
    for (let a = 0; a < node.moves.length; a++) {
      const child = node.children[a]
      let s: number
      if (child !== null && child.proven !== UNKNOWN) {
        if (child.proven === LOSS) s = 1e6 - child.mateDepth // parent wins → prefer, shorter is better
        else if (child.proven === WIN) s = -1e6 + child.mateDepth // parent loses → avoid, longer resists
        else s = 0 // forced draw, parent perspective value 0
      } else {
        const n = node.childN[a]
        const q = n > 0 ? node.childW[a] / n : node.initQ[a]
        const u = c * node.prior[a] * (sqrtSum / (1 + n))
        s = q + u
      }
      if (s > best) {
        best = s
        bestI = a
      }
    }
    return bestI
  }

  // Recompute a node's proof state from its (possibly still-null) children, and
  // return whether it changed. A single opponent-loss child proves a win at once;
  // proving a loss or a draw needs every child resolved.
  private propagate(node: Node): boolean {
    if (node.terminal) return false
    let lossIdx = -1
    let minLossDepth = Infinity
    let winIdx = -1
    let maxWinDepth = -1
    let allProven = true
    let anyDraw = false
    for (let a = 0; a < node.moves.length; a++) {
      const child = node.children[a]
      if (child === null || child.proven === UNKNOWN) {
        allProven = false
        continue
      }
      if (child.proven === LOSS) {
        if (child.mateDepth < minLossDepth) {
          minLossDepth = child.mateDepth
          lossIdx = a
        }
      } else if (child.proven === WIN) {
        if (child.mateDepth > maxWinDepth) {
          maxWinDepth = child.mateDepth
          winIdx = a
        }
      } else {
        anyDraw = true
      }
    }
    let proven = UNKNOWN
    let depth = 0
    let proof = -1
    if (lossIdx >= 0) {
      proven = WIN
      depth = minLossDepth + 1
      proof = lossIdx
    } else if (allProven) {
      if (anyDraw) {
        proven = DRAW
      } else {
        proven = LOSS
        depth = maxWinDepth + 1
        proof = winIdx
      }
    }
    if (proven !== node.proven || (proven !== UNKNOWN && depth !== node.mateDepth)) {
      node.proven = proven
      node.mateDepth = depth
      node.proofChild = proof
      return true
    }
    return false
  }

  // Run the search from `pos`, returning the visit distribution + best move.
  search(pos: Position, onProgress?: (r: MctsResult) => void, progressEvery = 256): MctsResult {
    this.stopped = false
    this.maxDepthSeen = 0
    const start = nowMs()
    const root = newNode()
    const work = cloneFor(pos)
    this.expand(root, work)
    this.addRootNoise(root)

    const limitN = this.opt.maxNodes > 0 ? this.opt.maxNodes : Infinity
    const limitT = this.opt.maxTime > 0 ? this.opt.maxTime : Infinity
    let sims = 0

    if (!root.terminal) {
      while (sims < limitN) {
        this.simulate(root, work)
        sims++
        if (this.stopped) break
        // The whole position is solved (forced win/loss/draw proven) — stop early.
        if (root.proven !== UNKNOWN) break
        if ((sims & 1023) === 0 && nowMs() - start >= limitT) break
        if (onProgress && sims % progressEvery === 0) {
          onProgress(this.buildResult(root, sims, nowMs() - start))
        }
      }
    }

    return this.buildResult(root, sims, nowMs() - start)
  }

  // One simulation: descend by PUCT to a leaf, expand+evaluate it, back the value
  // up the path (negamax sign flip), then rewind the board.
  private simulate(root: Node, work: Position): void {
    this.pathNode.length = 0
    this.pathChild.length = 0
    this.pathMove.length = 0
    let node = root
    let ply = 0
    let leafValue: number

    for (;;) {
      if (node.terminal) {
        leafValue = node.value
        break
      }
      const ci = this.selectChild(node)
      const move = node.moves[ci]
      this.pathNode.push(node)
      this.pathChild.push(ci)
      this.pathMove.push(move)
      const undo = this.freshUndo(ply)
      makeMoveOnBoard(work, move, undo)
      ply++
      let child = node.children[ci]
      if (child === null) {
        child = newNode()
        node.children[ci] = child
        this.expand(child, work)
        leafValue = child.value
        break
      }
      node = child
    }

    if (ply > this.maxDepthSeen) this.maxDepthSeen = ply

    // Backup: the leaf value is from the leaf's stm; flip once per edge as we
    // climb so each edge's W accrues value from its own parent's perspective.
    let v = leafValue
    for (let i = this.pathNode.length - 1; i >= 0; i--) {
      v = -v
      const parent = this.pathNode[i]
      const ci = this.pathChild[i]
      parent.childN[ci]++
      parent.childW[ci] += v
      parent.childSum++
    }

    // Proof backup: if the leaf is proven, push the verdict up the path until a
    // node's proof state stops changing (MCTS-Solver).
    for (let i = this.pathNode.length - 1; i >= 0; i--) {
      if (!this.propagate(this.pathNode[i])) break
    }

    // Rewind the board to the root position.
    for (let i = this.pathMove.length - 1; i >= 0; i--) {
      unmakeMoveOnBoard(work, this.pathMove[i], this.undos[i])
    }
  }

  // Assemble a result snapshot from the root's child statistics.
  private buildResult(root: Node, sims: number, ms: number): MctsResult {
    const stats: RootMoveStat[] = []
    for (let a = 0; a < root.moves.length; a++) {
      const n = root.childN[a]
      stats.push({
        move: root.moves[a],
        visits: n,
        q: n > 0 ? root.childW[a] / n : root.initQ[a],
        prior: root.prior[a],
      })
    }
    stats.sort((x, y) => y.visits - x.visits || y.q - x.q)

    let bestMove: Move | null = null
    let rootValue = root.value
    let mate: number | null = null
    if (root.terminal) {
      rootValue = root.value
    } else if (root.proven === WIN && root.proofChild >= 0) {
      // Forced win: play the proving move, report the exact mate distance.
      bestMove = root.moves[root.proofChild]
      rootValue = 1
      mate = Math.ceil(root.mateDepth / 2)
    } else if (root.proven === LOSS && root.proofChild >= 0) {
      // Forced loss: resist as long as possible.
      bestMove = root.moves[root.proofChild]
      rootValue = -1
      mate = -Math.ceil(root.mateDepth / 2)
    } else if (root.proven === DRAW) {
      // Forced draw: the most-visited move already steers clear of losing lines.
      bestMove = stats.length > 0 ? stats[0].move : null
      rootValue = 0
    } else if (stats.length > 0) {
      bestMove = this.pickMove(stats)
      // The position's value is the chosen move's mean action-value.
      const chosen = stats.find((s) => s.move === bestMove) ?? stats[0]
      rootValue = chosen.q
    }

    const pv = this.extractPv(root)
    if (mate === null) mate = this.mateFromPv(root, pv)

    return {
      bestMove,
      rootValue,
      scoreCp: valueToCp(rootValue),
      mate,
      nodes: sims,
      timeMs: Math.round(ms),
      nps: ms > 0 ? Math.round((sims / ms) * 1000) : 0,
      pv,
      children: stats,
      treeDepth: this.maxDepthSeen,
    }
  }

  // Move selection: argmax visits at temperature 0, else sample ∝ visits^(1/τ).
  private pickMove(stats: RootMoveStat[]): Move {
    const tau = this.opt.temperature
    if (tau <= 1e-6 || stats.length === 1) return stats[0].move
    const weights = stats.map((s) => Math.pow(Math.max(s.visits, 0) + 1e-9, 1 / tau))
    let sum = 0
    for (const w of weights) sum += w
    let r = this.rng() * sum
    for (let i = 0; i < stats.length; i++) {
      r -= weights[i]
      if (r <= 0) return stats[i].move
    }
    return stats[0].move
  }

  // Principal variation: follow the proof move where a node is proven (so the PV
  // is the forced mate line), otherwise the most-visited edge.
  private extractPv(root: Node): Move[] {
    const pv: Move[] = []
    let node: Node | null = root
    const guard = 64
    while (node && node.expanded && !node.terminal && node.moves.length > 0 && pv.length < guard) {
      let bestI = -1
      if (node.proven !== UNKNOWN && node.proven !== DRAW && node.proofChild >= 0) {
        bestI = node.proofChild
      } else {
        let bestN = -1
        for (let a = 0; a < node.moves.length; a++) {
          if (node.childN[a] > bestN) {
            bestN = node.childN[a]
            bestI = a
          }
        }
        if (bestN <= 0) break
      }
      if (bestI < 0) break
      pv.push(node.moves[bestI])
      node = node.children[bestI]
    }
    return pv
  }

  // If the greedy PV ends in a terminal checkmate node, report the signed mate-in-N.
  private mateFromPv(root: Node, pv: Move[]): number | null {
    let node: Node | null = root
    let depth = 0
    for (const m of pv) {
      if (!node) return null
      let idx = -1
      for (let a = 0; a < node.moves.length; a++) if (node.moves[a] === m) { idx = a; break }
      if (idx < 0) return null
      node = node.children[idx]
      depth++
    }
    if (node && node.terminal && node.value <= -0.999) {
      // The side to move at the terminal node is mated. Plies from the root → moves.
      const moves = Math.ceil(depth / 2)
      // Even depth ⇒ the mated side is the side to move at the root's opponent end;
      // sign is positive (root side delivers mate) when depth is odd.
      return depth % 2 === 1 ? moves : -moves
    }
    return null
  }
}

const EVAL1_SHARP = 3.0
const HEURISTIC_TAU = 0.9
const FPU_REDUCTION = 0.25

// `performance.now` in a browser/worker; `Date.now` as a Node fallback.
function nowMs(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}

function cloneFor(pos: Position): Position {
  return {
    board: Int8Array.from(pos.board),
    turn: pos.turn,
    castling: pos.castling,
    ep: pos.ep,
    halfmove: pos.halfmove,
    fullmove: pos.fullmove,
    kings: [pos.kings[0], pos.kings[1]],
    hash: pos.hash,
    chess960: pos.chess960,
    crook: Int8Array.from(pos.crook),
    castleMask: Int8Array.from(pos.castleMask),
  }
}

// Build a centipawn evaluator for a given value source.
export function makeMctsEvaluator(source: ValueSource, weights: NnueWeights | null): CpEvaluator {
  if (source === 'nnue' && weights) return makeFreshEvaluator(weights)
  return evaluate
}

// Convenience entry: run an MCTS search over a FEN with the given options.
export function mctsSearch(
  fen: string,
  opt: MctsOptions,
  weights: NnueWeights | null,
  onProgress?: (r: MctsResult) => void,
): MctsResult {
  const evalCp = makeMctsEvaluator(opt.evalSource, weights)
  const pos = parseFen(fen)
  const engine = new Mcts(evalCp, opt)
  return engine.search(pos, onProgress)
}

// ----------------------------------------------------------------------------
// Self-test: prove the search on known positions + check its internal bookkeeping.
// ----------------------------------------------------------------------------
export interface MctsSelftestCase {
  name: string
  fen: string
  /** Expected best move in UCI (e.g. "d1h5"); checked against the search choice. */
  expect: string
  /** A mate is expected (value should be decisive). */
  mate: boolean
  pass: boolean
  got: string
  scoreCp: number
  nodes: number
}

export interface MctsSelftest {
  cases: MctsSelftestCase[]
  /** Priors summed to 1 within tolerance on every expanded node tested. */
  priorsNormalised: boolean
  maxPriorError: number
  /** Σ root visit counts equalled the simulations run. */
  visitsConsistent: boolean
  /** The greedy PV was fully legal when replayed. */
  pvLegal: boolean
  passed: boolean
}

function moveToUciLocal(m: Move): string {
  const files = 'abcdefgh'
  const f = moveFrom(m)
  const t = moveTo(m)
  const promo = movePromo(m)
  const ps = promo ? 'nbrq'[promo - KNIGHT] ?? '' : ''
  return files[fileOf(f)] + (rankOf(f) + 1) + files[fileOf(t)] + (rankOf(t) + 1) + ps
}

export function mctsSelftest(): MctsSelftest {
  const cases: { name: string; fen: string; expect: string; mate: boolean; nodes?: number }[] = [
    // King-and-rook mate in one: Rh1-h8#, the lone king boxed on a8 by Kb6.
    { name: 'mate in 1 (Rh8#)', fen: 'k7/8/1K6/8/8/8/8/7R w - - 0 1', expect: 'h1h8', mate: true },
    // Back-rank mate in one: Re8#.
    { name: 'back-rank mate (Re8#)', fen: '6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1', expect: 'e1e8', mate: true },
    // A proven *multi-ply* forced mate: the rook-and-rook ladder mate. The solver
    // must prove every defence loses, then report the exact distance (Ra7, mate-in-3).
    { name: 'multi-ply forced mate (Ra7)', fen: '6k1/8/8/8/8/8/5PPP/R3R1K1 w - - 0 1', expect: 'a1a7', mate: true, nodes: 8000 },
    // Free queen: White just hangs it; Black must grab it (…Rxd1).
    { name: 'win the queen', fen: '3r2k1/5ppp/8/8/8/8/5PPP/3Q2K1 b - - 0 1', expect: 'd8d1', mate: false },
    // Promote to win: pawn on b7, White to move, b8=Q is best.
    { name: 'promotion (b8=Q)', fen: '8/1P4k1/8/8/8/8/6K1/8 w - - 0 1', expect: 'b7b8q', mate: false },
    // A two-ply tactic (not a mate): the knight royal fork Ne6-c7+ wins the rook.
    { name: 'knight fork (Nc7+)', fen: 'r3k3/8/4N3/8/8/8/8/4K3 w - - 0 1', expect: 'e6c7', mate: false, nodes: 4000 },
  ]

  const out: MctsSelftestCase[] = []
  let allMovesPass = true
  let priorsNormalised = true
  let maxPriorError = 0
  let visitsConsistent = true
  let pvLegal = true

  for (const c of cases) {
    const opt: MctsOptions = {
      ...MCTS_DEFAULTS,
      maxNodes: c.nodes ?? 1600,
      policy: 'eval1',
      evalSource: 'classical',
      cpuct: 2.0,
    }
    const r = mctsSearch(c.fen, opt, null)
    const got = r.bestMove !== null ? moveToUciLocal(r.bestMove) : '(none)'
    const movePass = c.expect === '' ? true : got === c.expect
    // A mate case must be *proven* — the solver returns a positive mate distance.
    const matePass = c.mate ? r.mate !== null && r.mate > 0 && r.scoreCp > 600 : true
    const pass = movePass && matePass
    if (!pass) allMovesPass = false
    out.push({ name: c.name, fen: c.fen, expect: c.expect, mate: c.mate, pass, got, scoreCp: r.scoreCp, nodes: r.nodes })

    // Visit consistency: Σ root visits == simulations.
    let sum = 0
    for (const s of r.children) sum += s.visits
    if (sum !== r.nodes) visitsConsistent = false

    // Priors normalised at the root.
    let psum = 0
    for (const s of r.children) psum += s.prior
    maxPriorError = Math.max(maxPriorError, Math.abs(psum - 1))
    if (Math.abs(psum - 1) > 1e-6) priorsNormalised = false

    // PV legality: replay the PV from the FEN.
    const replay = parseFen(c.fen)
    for (const m of r.pv) {
      const legal = generateLegal(replay)
      if (!legal.includes(m)) { pvLegal = false; break }
      const u: Undo = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
      makeMoveOnBoard(replay, m, u)
    }
  }

  const passed = allMovesPass && priorsNormalised && visitsConsistent && pvLegal
  return { cases: out, priorsNormalised, maxPriorError, visitsConsistent, pvLegal, passed }
}
