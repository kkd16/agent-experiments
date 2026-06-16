// A curated library of SMT-LIB scripts spanning the supported logics. Each is
// small, self-contained, and chosen to *show a theory thinking*: a congruence
// that closes, a strict cycle that can't, an integer gap, or a fact that only
// emerges when arithmetic and uninterpreted functions are combined.

export interface SmtExample {
  name: string
  logic: string
  blurb: string
  expected: 'sat' | 'unsat'
  src: string
}

export const SMT_EXAMPLES: SmtExample[] = [
  {
    name: 'Congruence closure',
    logic: 'QF_UF',
    blurb: 'If a = b = c then f(a) and f(c) must agree — so demanding f(a) ≠ f(c) is contradictory.',
    expected: 'unsat',
    src: `(set-logic QF_UF)
(declare-sort U 0)
(declare-fun a () U)
(declare-fun b () U)
(declare-fun c () U)
(declare-fun f (U) U)

(assert (= a b))
(assert (= b c))
(assert (not (= (f a) (f c))))
(check-sat)`,
  },
  {
    name: 'A function that is its own inverse',
    logic: 'QF_UF',
    blurb: 'f³(a)=a and f⁵(a)=a force f(a)=a (gcd(3,5)=1), so f(a) ≠ a is unsatisfiable.',
    expected: 'unsat',
    src: `(set-logic QF_UF)
(declare-sort U 0)
(declare-fun a () U)
(declare-fun f (U) U)

(assert (= (f (f (f a))) a))
(assert (= (f (f (f (f (f a))))) a))
(assert (not (= (f a) a)))
(check-sat)`,
  },
  {
    name: 'Uninterpreted predicate',
    logic: 'QF_UF',
    blurb: 'p is an uninterpreted predicate. With x = y, p(x) and p(y) cannot disagree.',
    expected: 'unsat',
    src: `(set-logic QF_UF)
(declare-sort U 0)
(declare-fun x () U)
(declare-fun y () U)
(declare-fun p (U) Bool)

(assert (= x y))
(assert (p x))
(assert (not (p y)))
(check-sat)`,
  },
  {
    name: 'Strict ordering cycle',
    logic: 'QF_LRA',
    blurb: 'x < y < z < x is impossible over an ordered field — the simplex finds the contradiction.',
    expected: 'unsat',
    src: `(set-logic QF_LRA)
(declare-const x Real)
(declare-const y Real)
(declare-const z Real)

(assert (< x y))
(assert (< y z))
(assert (< z x))
(check-sat)`,
  },
  {
    name: 'A feasible blend',
    logic: 'QF_LRA',
    blurb: 'Mix two ingredients to hit a target — a small linear program with a real solution.',
    expected: 'sat',
    src: `(set-logic QF_LRA)
(declare-const a Real)
(declare-const b Real)

(assert (>= a 0))
(assert (>= b 0))
(assert (= (+ a b) 10))
(assert (= (+ (* 2 a) (* 5 b)) 35))
(check-sat)
(get-model)`,
  },
  {
    name: 'No integer between 0 and 1',
    logic: 'QF_LIA',
    blurb: 'Over the integers there is nothing strictly between 0 and 1 — branch-and-bound proves it.',
    expected: 'unsat',
    src: `(set-logic QF_LIA)
(declare-const x Int)

(assert (> x 0))
(assert (< x 1))
(check-sat)`,
  },
  {
    name: 'Integer change-making',
    logic: 'QF_LIA',
    blurb: 'Find non-negative counts of 3 and 5 that sum to 19 — an integer feasibility problem.',
    expected: 'sat',
    src: `(set-logic QF_LIA)
(declare-const threes Int)
(declare-const fives Int)

(assert (>= threes 0))
(assert (>= fives 0))
(assert (= (+ (* 3 threes) (* 5 fives)) 19))
(check-sat)
(get-model)`,
  },
  {
    name: 'Pigeonhole over integers',
    logic: 'QF_LIA',
    blurb: 'Three distinct integers can\'t all fit in {0,1} — no room for a third.',
    expected: 'unsat',
    src: `(set-logic QF_LIA)
(declare-const x Int)
(declare-const y Int)
(declare-const z Int)

(assert (distinct x y z))
(assert (and (<= 0 x) (<= x 1)))
(assert (and (<= 0 y) (<= y 1)))
(assert (and (<= 0 z) (<= z 1)))
(check-sat)`,
  },
  {
    name: 'Combining UF + arithmetic',
    logic: 'QF_UFLIA',
    blurb: 'x ≤ y and y ≤ x force x = y, so the uninterpreted f must agree: f(x) ≠ f(y) is impossible.',
    expected: 'unsat',
    src: `(set-logic QF_UFLIA)
(declare-const x Int)
(declare-const y Int)
(declare-fun f (Int) Int)

(assert (<= x y))
(assert (<= y x))
(assert (not (= (f x) (f y))))
(check-sat)`,
  },
  {
    name: 'UF + arithmetic, satisfiable',
    logic: 'QF_UFLIA',
    blurb: 'When x and y can differ, an uninterpreted f is free to map them anywhere — this one is satisfiable.',
    expected: 'sat',
    src: `(set-logic QF_UFLIA)
(declare-const x Int)
(declare-const y Int)
(declare-fun f (Int) Int)

(assert (< x y))
(assert (> (f x) (f y)))
(assert (>= (f x) 0))
(check-sat)
(get-model)`,
  },
  {
    name: 'Read-over-write',
    logic: 'QF_AX',
    blurb: 'Reading the cell you just wrote returns the value you wrote — so claiming otherwise is impossible.',
    expected: 'unsat',
    src: `(set-logic QF_AX)
(declare-sort Index 0)
(declare-sort Elem 0)
(declare-const a (Array Index Elem))
(declare-const i Index)
(declare-const v Elem)

; select(store(a,i,v), i) must equal v
(assert (not (= (select (store a i v) i) v)))
(check-sat)`,
  },
  {
    name: 'A write is invisible elsewhere',
    logic: 'QF_AX',
    blurb: 'A write at i cannot change what a different index j reads — McCarthy’s second axiom.',
    expected: 'unsat',
    src: `(set-logic QF_AX)
(declare-sort Index 0)
(declare-sort Elem 0)
(declare-const a (Array Index Elem))
(declare-const i Index)
(declare-const j Index)
(declare-const v Elem)

(assert (not (= i j)))
(assert (not (= (select (store a i v) j) (select a j))))
(check-sat)`,
  },
  {
    name: 'Independent writes commute',
    logic: 'QF_AX',
    blurb: 'When i ≠ j, writing i then j is the same array as writing j then i — proved by extensionality.',
    expected: 'unsat',
    src: `(set-logic QF_AX)
(declare-sort Index 0)
(declare-sort Elem 0)
(declare-const a (Array Index Elem))
(declare-const i Index)
(declare-const j Index)
(declare-const v Elem)
(declare-const w Elem)

(assert (not (= i j)))
(assert (not (= (store (store a i v) j w)
                (store (store a j w) i v))))
(check-sat)`,
  },
  {
    name: 'Extensionality',
    logic: 'QF_AX',
    blurb: 'Two arrays equal at every index are the same array — so equal arrays cannot disagree on a read.',
    expected: 'unsat',
    src: `(set-logic QF_AX)
(declare-sort Index 0)
(declare-sort Elem 0)
(declare-const a (Array Index Elem))
(declare-const b (Array Index Elem))
(declare-const i Index)

(assert (= a b))
(assert (not (= (select a i) (select b i))))
(check-sat)`,
  },
  {
    name: 'Swap leaves the rest alone',
    logic: 'QF_ALIA',
    blurb: 'Swapping a[i] and a[j] keeps every other cell untouched — here a satisfiable swap over integer arrays.',
    expected: 'sat',
    src: `(set-logic QF_ALIA)
(declare-const a (Array Int Int))
(declare-const i Int)
(declare-const j Int)

; b is a with cells i and j swapped
(assert (= i 0))
(assert (= j 1))
(assert (= (select a 0) 10))
(assert (= (select a 1) 20))
(check-sat)
(get-model)`,
  },
  {
    name: 'Constant array',
    logic: 'QF_ALIA',
    blurb: 'An all-zero array reads 0 at every index — overwrite one cell and the rest stay 0.',
    expected: 'unsat',
    src: `(set-logic QF_ALIA)
(declare-const i Int)
(declare-const j Int)

(assert (not (= i j)))
; the constant 0 array, with cell i overwritten by 5, still reads 0 at j (≠ i)
(assert (not (= (select (store ((as const (Array Int Int)) 0) i 5) j) 0)))
(check-sat)`,
  },
  {
    name: 'Array index out of order',
    logic: 'QF_ALIA',
    blurb: 'After writing 7 at i, the cell cannot read back as less than 7 — arrays meet integer arithmetic.',
    expected: 'unsat',
    src: `(set-logic QF_ALIA)
(declare-const a (Array Int Int))
(declare-const i Int)

(assert (< (select (store a i 7) i) 7))
(check-sat)`,
  },
]
