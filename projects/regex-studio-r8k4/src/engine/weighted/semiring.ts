// The semiring zoo — the algebraic ground every weighted automaton stands on.
//
// A *weighted* automaton generalises the Boolean one this studio is built on: a
// run no longer merely *exists* or *doesn't*, it carries a **weight** drawn from
// a semiring `(K, ⊕, ⊗, 0̄, 1̄)`. The weight of a word is the ⊕-sum, over every
// accepting run, of the ⊗-product of the weights along it. Swap the semiring and
// the *same automaton* computes a different thing entirely:
//
//   • Boolean `(∨, ∧)`      — does a run exist? → ordinary recognition.
//   • Counting `(+, ×)` on ℕ — how *many* accepting runs? → the ambiguity degree.
//   • Tropical `(min, +)`    — the cheapest run → shortest-distance / best parse.
//   • Viterbi `(max, ×)`     — the most-likely run → the MAP path of an HMM.
//   • Probability `(+, ×)`   — the total mass → the language's probability.
//
// This is Schützenberger's world of *rational power series*, and Mohri's generic
// shortest-distance framework: one set of algorithms, parameterised by a semiring.
//
// A semiring is *closed* / has a **star** `a* = 1̄ ⊕ a ⊕ a² ⊕ …` when that sum is
// well-defined — the missing ingredient for the Kleene star and for the
// all-words closure `λ·M*·γ`. We give every semiring here a *total* `star`,
// saturating to an explicit ∞ where the series genuinely diverges (a positive
// counting loop, a probability ≥ 1), so the closure algorithms never get stuck;
// the verifier cross-checks the finite cases against a brute-force word sum.

export interface Semiring<K> {
  readonly name: string;
  readonly zero: K; // 0̄ — the additive identity and multiplicative annihilator
  readonly one: K; // 1̄ — the multiplicative identity
  plus(a: K, b: K): K; // ⊕
  times(a: K, b: K): K; // ⊗
  star(a: K): K; // a* = 1̄ ⊕ a ⊕ a² ⊕ … (total; saturates on divergence)
  eq(a: K, b: K): boolean; // semantic equality (ε-tolerant for the float carriers)
  show(a: K): string; // a compact label for the UI
  readonly idempotent: boolean; // a ⊕ a = a ⇒ the all-words ⊕-sum stabilises
  fromCount(n: number): K; // the n-fold ⊕-sum of 1̄ (n copies of a unit run)
  isInfinite?(a: K): boolean; // a saturated / divergent value, if the carrier has one
}

// --- Boolean: (∨, ∧) — recognition is the weighted automaton over 𝔹 ----------

export const Boolean2: Semiring<boolean> = {
  name: 'Boolean (∨,∧)',
  zero: false,
  one: true,
  plus: (a, b) => a || b,
  times: (a, b) => a && b,
  star: () => true, // 1̄ ∨ … = ⊤ always
  eq: (a, b) => a === b,
  show: (a) => (a ? '⊤' : '⊥'),
  idempotent: true,
  fromCount: (n) => n > 0,
};

// --- Counting: (+, ×) over ℕ ∪ {∞} — the number of accepting runs -------------
//
// `null` is ∞ (a positive cycle makes the path count diverge). BigInt keeps exact
// counts past 2⁵³ so the "how ambiguous is this word" reading stays honest.

export type Count = bigint | null; // null = ∞
const INF: Count = null;
const isInf = (x: Count): x is null => x === null;

export const Counting: Semiring<Count> = {
  name: 'Counting (+,×) ℕ∪∞',
  zero: 0n,
  one: 1n,
  plus: (a, b) => (isInf(a) || isInf(b) ? INF : a + b),
  times: (a, b) => {
    if (a === 0n || b === 0n) return 0n; // 0̄ annihilates even ∞ (ℕ∞ convention)
    if (isInf(a) || isInf(b)) return INF;
    return a * b;
  },
  star: (a) => (a === 0n ? 1n : INF), // 0* = 1; any positive count loops to ∞
  eq: (a, b) => a === b,
  show: (a) => (isInf(a) ? '∞' : a.toString()),
  idempotent: false,
  fromCount: (n) => BigInt(n),
  isInfinite: (a) => isInf(a),
};

// --- Tropical: (min, +) over ℝ≥0 ∪ {+∞} — the cheapest run -------------------
//
// 0̄ = +∞ (no run), 1̄ = 0 (a free run). The weight of a word is the *minimum*
// total cost over its accepting runs; the all-words closure is the single-source
// shortest distance — Mohri's algebraic path problem. Star is 0 because, with
// non-negative weights, looping never beats taking the loop zero times.

const EPS = 1e-9;
export const Tropical: Semiring<number> = {
  name: 'Tropical (min,+)',
  zero: Infinity,
  one: 0,
  plus: (a, b) => Math.min(a, b),
  times: (a, b) => a + b, // +∞ + x = +∞ falls out of IEEE arithmetic
  star: (a) => (a >= 0 ? 0 : -Infinity), // weights are ≥ 0 ⇒ a* = 0̄'s sibling 1̄ = 0
  eq: (a, b) => a === b || Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b)),
  show: (a) => (a === Infinity ? '∞' : Number.isInteger(a) ? a.toString() : a.toFixed(3)),
  idempotent: true, // min(a,a)=a
  fromCount: (n) => (n > 0 ? 0 : Infinity),
  isInfinite: (a) => a === Infinity,
};

// --- Viterbi: (max, ×) over [0,1] — the most-likely run ----------------------
//
// 0̄ = 0, 1̄ = 1. The MAP decoder: the weight of a word is the single likeliest
// accepting run. Idempotent (max), so the all-words closure stabilises; star is
// 1 because x^0 = 1 dominates for x ∈ [0,1].

export const Viterbi: Semiring<number> = {
  name: 'Viterbi (max,×)',
  zero: 0,
  one: 1,
  plus: (a, b) => Math.max(a, b),
  times: (a, b) => a * b,
  star: () => 1, // maxₖ xᵏ = x⁰ = 1 on [0,1]
  eq: (a, b) => Math.abs(a - b) <= EPS,
  show: (a) => (Number.isInteger(a) ? a.toString() : a.toFixed(4)),
  idempotent: true,
  fromCount: (n) => (n > 0 ? 1 : 0),
};

// --- Probability / non-negative reals: (+, ×) — the total mass ---------------
//
// 0̄ = 0, 1̄ = 1. The weight of a word sums over every run; the all-words closure
// is the total mass of the (sub-)stochastic language. Not idempotent. The star
// is the geometric series 1/(1−a), saturating to +∞ once a ≥ 1.

export const Probability: Semiring<number> = {
  name: 'Probability (+,×)',
  zero: 0,
  one: 1,
  plus: (a, b) => a + b,
  times: (a, b) => (a === 0 || b === 0 ? 0 : a * b), // 0̄ annihilates ∞ (avoid IEEE ∞·0 = NaN)
  star: (a) => (a < 1 - EPS ? 1 / (1 - a) : Infinity),
  eq: (a, b) => a === b || Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)),
  show: (a) => (a === Infinity ? '∞' : Number.isInteger(a) ? a.toString() : a.toPrecision(5)),
  idempotent: false,
  fromCount: (n) => n,
  isInfinite: (a) => a === Infinity,
};

// The studio's curated set, keyed for persistence / the panel picker.
export const SEMIRINGS = {
  boolean: Boolean2 as Semiring<unknown>,
  counting: Counting as Semiring<unknown>,
  tropical: Tropical as Semiring<unknown>,
  viterbi: Viterbi as Semiring<unknown>,
  probability: Probability as Semiring<unknown>,
} as const;

export type SemiringId = keyof typeof SEMIRINGS;

export const SEMIRING_IDS: SemiringId[] = ['boolean', 'counting', 'tropical', 'viterbi', 'probability'];

export function semiringById(id: SemiringId): Semiring<unknown> {
  return SEMIRINGS[id];
}

// A one-line gloss of *what the word weight means* under each semiring — the
// payoff line the panel shows so the abstraction stays grounded.
export const SEMIRING_MEANING: Record<SemiringId, string> = {
  boolean: 'does any accepting run exist? — ordinary recognition',
  counting: 'how many accepting runs? — the word’s ambiguity degree',
  tropical: 'the cheapest accepting run — shortest distance / best parse',
  viterbi: 'the most-likely accepting run — the HMM’s MAP path',
  probability: 'the total mass over all accepting runs — the language’s probability',
};
