// A curated library of Optimization-Modulo-Theories scripts. Each uses the
// `(minimize t)` / `(maximize t)` (OMT) or `(assert-soft f :weight w)` (MaxSMT)
// extensions and is chosen to show optimization *across* theories: integer
// programs (QF_LIA), linear programs (QF_LRA), and weighted soft constraints over
// arithmetic and uninterpreted functions.

export interface OmtExample {
  name: string
  logic: string
  /** 'omt' = single objective; 'maxsmt' = weighted soft constraints. */
  kind: 'omt' | 'maxsmt'
  blurb: string
  src: string
}

export const OMT_EXAMPLES: OmtExample[] = [
  {
    name: 'Coin change (fewest coins)',
    logic: 'QF_LIA',
    kind: 'omt',
    blurb: 'Make 47¢ from 1/5/10/25¢ coins using as few coins as possible. Integer optimization finds the exact minimum.',
    src: `(set-logic QF_LIA)
(declare-const c1 Int)   ; pennies
(declare-const c5 Int)   ; nickels
(declare-const c10 Int)  ; dimes
(declare-const c25 Int)  ; quarters
(assert (>= c1 0)) (assert (>= c5 0)) (assert (>= c10 0)) (assert (>= c25 0))
(assert (= (+ c1 (* 5 c5) (* 10 c10) (* 25 c25)) 47))

(minimize (+ c1 c5 c10 c25))
(check-sat)`,
  },
  {
    name: '0/1 Knapsack (best value)',
    logic: 'QF_LIA',
    kind: 'omt',
    blurb: 'Pick a subset of five items maximizing total value while the total weight stays within a capacity of 10.',
    src: `(set-logic QF_LIA)
; xi ∈ {0,1}: is item i taken?
(declare-const x1 Int) (declare-const x2 Int) (declare-const x3 Int)
(declare-const x4 Int) (declare-const x5 Int)
(assert (<= 0 x1)) (assert (<= x1 1))
(assert (<= 0 x2)) (assert (<= x2 1))
(assert (<= 0 x3)) (assert (<= x3 1))
(assert (<= 0 x4)) (assert (<= x4 1))
(assert (<= 0 x5)) (assert (<= x5 1))
; weights must fit the knapsack
(assert (<= (+ (* 6 x1) (* 3 x2) (* 5 x3) (* 4 x4) (* 2 x5)) 10))

; maximize total value
(maximize (+ (* 10 x1) (* 4 x2) (* 7 x3) (* 6 x4) (* 3 x5)))
(check-sat)`,
  },
  {
    name: 'Production planning (LP)',
    logic: 'QF_LRA',
    kind: 'omt',
    blurb: 'A classic linear program: choose continuous production levels to maximize profit under three resource limits. The simplex jumps to the exact rational vertex optimum.',
    src: `(set-logic QF_LRA)
(declare-const a Real)  ; units of product A
(declare-const b Real)  ; units of product B
(assert (>= a 0)) (assert (>= b 0))
(assert (<= (+ (* 2 a) b) 18))     ; machine hours
(assert (<= (+ a (* 3 b)) 42))     ; labour hours
(assert (<= (+ a b) 24))           ; storage

(maximize (+ (* 3 a) (* 5 b)))     ; profit
(check-sat)`,
  },
  {
    name: 'Conflicting preferences (MaxSMT)',
    logic: 'QF_LIA',
    kind: 'maxsmt',
    blurb: 'Three wishes for when to start the day cannot all hold at once. MaxSMT keeps the highest-weight subset and pays the minimum penalty for the rest.',
    src: `(set-logic QF_LIA)
(declare-const start Int)
(assert (and (>= start 8) (<= start 18)))   ; hard: a sane hour

(assert-soft (>= start 10) :weight 3 :id sleep-in)
(assert-soft (<= start 9)  :weight 5 :id beat-traffic)
(assert-soft (= start 12)  :weight 2 :id lunch-meeting)
(check-sat)`,
  },
  {
    name: 'MaxSMT over equalities (QF_UF)',
    logic: 'QF_UF',
    kind: 'maxsmt',
    blurb: 'These equalities cannot all hold — congruence would force f(a)=f(c), which is forbidden. MaxSMT keeps the largest-weight consistent subset of them — optimization *modulo the theory of equality*.',
    src: `(set-logic QF_UF)
(declare-sort U 0)
(declare-fun a () U) (declare-fun b () U) (declare-fun c () U)
(declare-fun f (U) U)
(assert (not (= (f a) (f c))))   ; hard constraint

(assert-soft (= a b) :weight 2 :id ab)
(assert-soft (= b c) :weight 2 :id bc)
(assert-soft (= a c) :weight 1 :id ac)
(check-sat)`,
  },
  {
    name: 'Disjunctive plan (min cost)',
    logic: 'QF_LIA',
    kind: 'omt',
    blurb: 'The feasible set is a union of intervals (a Boolean OR of arithmetic constraints). OMT searches across the Boolean structure to the global minimum — 30, in the cheaper branch.',
    src: `(set-logic QF_LIA)
(declare-const cost Int)
; either the premium plan (≥100) or the budget plan (30..40)
(assert (or (>= cost 100) (and (>= cost 30) (<= cost 40))))

(minimize cost)
(check-sat)`,
  },
  {
    name: 'Open infimum (strict bound)',
    logic: 'QF_LRA',
    kind: 'omt',
    blurb: 'Minimizing x subject to x > 1: the infimum is exactly 1, but a strict inequality means it is never attained. Exact δ-rational reasoning detects the open optimum.',
    src: `(set-logic QF_LRA)
(declare-const x Real)
(assert (> x 1))

(minimize x)
(check-sat)`,
  },
  {
    name: 'Unbounded objective',
    logic: 'QF_LRA',
    kind: 'omt',
    blurb: 'Maximizing y when only y ≥ x is required: y can grow without limit. The simplex LP detects the unbounded direction.',
    src: `(set-logic QF_LRA)
(declare-const x Real)
(declare-const y Real)
(assert (>= (- y x) 0))

(maximize y)
(check-sat)`,
  },
]
