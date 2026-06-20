// Problem → QBF encoders and example instances.
//
// Several families have a value that is *known by construction* (independent of
// the solver), which makes them strong correctness anchors even past the range
// of the brute-force oracle:
//   * matchFamily   — ∀∃ "react" (TRUE) vs ∃∀ "commit" (FALSE), any width.
//   * parityLadder  — arbitrary alternation; TRUE iff the innermost block is ∃.
//   * random QBF    — random prenex instances (checked against the oracle).

import type { QBF, QBlock, Quant } from './qdimacs'
import { normalizeQbf } from './qdimacs'

export interface QExample {
  name: string
  blurb: string
  qbf: QBF
  /** Truth value known a priori, used by the self-check battery. */
  expected?: boolean
}

// ---- Tseitin helpers for building matrices ----------------------------------

/** Clauses for c ⟺ (a ⊕ b), the XOR gate. */
function xorClauses(a: number, b: number, c: number): number[][] {
  return [
    [-a, -b, -c],
    [-a, b, c],
    [a, -b, c],
    [a, b, -c],
  ]
}

/** Clauses for c ⟺ (a ↔ b), the equivalence gate. */
function iffClauses(a: number, b: number): number[][] {
  // a ↔ b  ≡  (¬a ∨ b) ∧ (a ∨ ¬b)
  return [
    [-a, b],
    [a, -b],
  ]
}

// ---- Scalable families ------------------------------------------------------

/**
 * The "copy" game at width `n`.
 *   swap=false → ∀u₁…uₙ ∃y₁…yₙ. ⋀ (yᵢ ↔ uᵢ)   — ∃ moves last and copies ⇒ TRUE.
 *   swap=true  → ∃y₁…yₙ ∀u₁…uₙ. ⋀ (yᵢ ↔ uᵢ)   — ∃ commits first ⇒ FALSE.
 * The textbook demonstration that quantifier order is everything.
 */
export function matchFamily(n: number, swap: boolean): QBF {
  const u: number[] = []
  const y: number[] = []
  for (let i = 0; i < n; i++) {
    u.push(2 * i + 1)
    y.push(2 * i + 2)
  }
  const matrix: number[][] = []
  for (let i = 0; i < n; i++) matrix.push(...iffClauses(u[i], y[i]))
  const prefix: QBlock[] = swap
    ? [{ q: 'e', vars: y }, { q: 'a', vars: u }]
    : [{ q: 'a', vars: u }, { q: 'e', vars: y }]
  return normalizeQbf(prefix, matrix, [
    `copy game, width ${n} (${swap ? 'exists-first / FALSE' : 'forall-first / TRUE'})`,
  ])
}

/**
 * Parity ladder with `k` alternating single-variable blocks. The matrix asserts
 * v₁ ⊕ v₂ ⊕ … ⊕ v_k = 0 (even parity), via a Tseitin XOR chain. Whoever owns the
 * innermost block fixes the final parity bit, so the formula is TRUE iff that
 * block is existential — a clean, value-known instance with `k-1` alternations.
 */
export function parityLadder(k: number, innermostExists: boolean): QBF {
  // Block i (1-based, outermost=1) is ∃ when its parity-from-the-end is right.
  // We want block k to be ∃ iff innermostExists. Strict alternation backwards.
  const prefix: QBlock[] = []
  for (let i = 1; i <= k; i++) {
    // distance from innermost: k - i (0 for innermost)
    const fromEnd = k - i
    const isExists = innermostExists ? fromEnd % 2 === 0 : fromEnd % 2 === 1
    prefix.push({ q: (isExists ? 'e' : 'a') as Quant, vars: [i] })
  }
  // Tseitin XOR chain p₁=v₁; pᵢ = pᵢ₋₁ ⊕ vᵢ; require p_k = false (even).
  const matrix: number[][] = []
  let next = k
  let prev = 1 // p₁ ≡ v₁
  for (let i = 2; i <= k; i++) {
    const p = ++next
    matrix.push(...xorClauses(prev, i, p))
    prev = p
  }
  const aux: number[] = []
  for (let v = k + 1; v <= next; v++) aux.push(v)
  if (aux.length > 0) prefix.push({ q: 'e', vars: aux }) // functionally-defined p's
  matrix.push([-prev]) // final parity must be 0
  return normalizeQbf(prefix, matrix, [`parity ladder, k=${k}, innermost ${innermostExists ? '∃' : '∀'}`])
}

// ---- Random instances -------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface RandomQbfOptions {
  seed: number
  /** Quantifier of the outermost block ('e' or 'a'); blocks then alternate. */
  leading: Quant
  /** Number of quantifier blocks. */
  blocks: number
  /** Variables per block. */
  perBlock: number
  /** Number of clauses. */
  clauses: number
  /** Literals per clause. */
  k: number
}

/** A random prenex QBF with strictly alternating blocks and a random k-CNF matrix. */
export function randomQbf(opts: RandomQbfOptions): QBF {
  const rng = mulberry32(opts.seed)
  const prefix: QBlock[] = []
  let v = 0
  for (let b = 0; b < opts.blocks; b++) {
    const vars: number[] = []
    for (let i = 0; i < opts.perBlock; i++) vars.push(++v)
    const q: Quant = b % 2 === 0 ? opts.leading : opts.leading === 'e' ? 'a' : 'e'
    prefix.push({ q, vars })
  }
  const numVars = v
  const matrix: number[][] = []
  for (let c = 0; c < opts.clauses; c++) {
    const lits = new Set<number>()
    const clause: number[] = []
    let guard = 0
    while (clause.length < opts.k && guard++ < opts.k * 8) {
      const x = 1 + Math.floor(rng() * numVars)
      if (lits.has(x)) continue
      lits.add(x)
      clause.push(rng() < 0.5 ? x : -x)
    }
    if (clause.length > 0) matrix.push(clause)
  }
  return normalizeQbf(prefix, matrix, [`random QBF, seed ${opts.seed}`])
}

// ---- Curated examples for the studio ---------------------------------------

function qbf(prefix: QBlock[], matrix: number[][], comments?: string[]): QBF {
  return normalizeQbf(prefix, matrix, comments)
}

export const QBF_EXAMPLES: QExample[] = [
  {
    name: '∀∃ — react and win',
    blurb:
      'For every value the adversary picks for x, the player can pick y to match it (y ↔ x). Because ∃ moves *after* ∀, it can always react. TRUE.',
    expected: true,
    qbf: qbf([{ q: 'a', vars: [1] }, { q: 'e', vars: [2] }], [[-1, 2], [1, -2]], ['∀x ∃y. (x ↔ y)']),
  },
  {
    name: '∃∀ — commit and lose',
    blurb:
      'Same matrix (y ↔ x), but now ∃ must commit to y *before* seeing x. The adversary then chooses the opposite x and breaks the match. FALSE.',
    expected: false,
    qbf: qbf([{ q: 'e', vars: [2] }, { q: 'a', vars: [1] }], [[-1, 2], [1, -2]], ['∃y ∀x. (x ↔ y)']),
  },
  {
    name: 'Universal tautology',
    blurb: '∀x. (x ∨ ¬x). The single clause is valid, so it holds for both values of x. TRUE.',
    expected: true,
    qbf: qbf([{ q: 'a', vars: [1] }], [[1, -1]], ['∀x. (x ∨ ¬x)']),
  },
  {
    name: 'Universal over a unit',
    blurb: '∀x. x. The matrix demands x be true — but ∀ also tries x = false, which fails. FALSE.',
    expected: false,
    qbf: qbf([{ q: 'a', vars: [1] }], [[1]], ['∀x. x']),
  },
  {
    name: 'Dominating literal',
    blurb:
      '∃x ∀y. (x ∨ y) ∧ (x ∨ ¬y). The two clauses together cover both y = 0 and y = 1 only if x is true; x = true is a single existential move that survives every adversary y. TRUE.',
    expected: true,
    qbf: qbf([{ q: 'e', vars: [1] }, { q: 'a', vars: [2] }], [[1, 2], [1, -2]], ['∃x ∀y. (x∨y)∧(x∨¬y)']),
  },
  {
    name: 'No defense exists',
    blurb:
      '∃x ∀y. y. Nothing the player does to x matters; the adversary simply sets y = false and falsifies the clause. FALSE.',
    expected: false,
    qbf: qbf([{ q: 'e', vars: [1] }, { q: 'a', vars: [2] }], [[2]], ['∃x ∀y. y']),
  },
  {
    name: '∃∀∃ — buffered reaction',
    blurb:
      '∃a ∀b ∃c. (c ↔ (a ∧ b)). The innermost ∃c can always set c to a∧b whatever a and b are, so the player wins regardless of the buffer block. TRUE.',
    expected: true,
    qbf: qbf(
      [{ q: 'e', vars: [1] }, { q: 'a', vars: [2] }, { q: 'e', vars: [3] }],
      // c ↔ (a∧b): (¬c∨a)(¬c∨b)(c∨¬a∨¬b)
      [[-3, 1], [-3, 2], [3, -1, -2]],
      ['∃a ∀b ∃c. c ↔ (a∧b)'],
    ),
  },
  {
    name: 'Parity ladder ∃∀∃∀∃',
    blurb:
      'Five players alternate setting one bit each; the matrix demands the XOR of all five be even. The innermost player is ∃ and fixes the final parity bit no matter what came before. TRUE.',
    expected: true,
    qbf: parityLadder(5, true),
  },
  {
    name: 'Parity ladder ∀∃∀∃∀',
    blurb:
      'The same five-bit XOR-is-even game, but now the innermost player is ∀ and deliberately flips the last bit to make the parity odd. FALSE.',
    expected: false,
    qbf: parityLadder(5, false),
  },
  {
    name: 'Copy game (width 4, TRUE)',
    blurb: '∀u₁…u₄ ∃y₁…y₄. ⋀ (yᵢ ↔ uᵢ). The existential block answers last and copies each bit. TRUE.',
    expected: true,
    qbf: matchFamily(4, false),
  },
  {
    name: 'Copy game (width 4, FALSE)',
    blurb: '∃y₁…y₄ ∀u₁…u₄. ⋀ (yᵢ ↔ uᵢ). Committing all four guesses up front cannot survive every adversary. FALSE.',
    expected: false,
    qbf: matchFamily(4, true),
  },
]
