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
  {
    name: 'List read-back',
    logic: 'QF_DT',
    blurb: 'The head of a freshly built cons is exactly the value you put there — denying it is impossible.',
    expected: 'unsat',
    src: `(set-logic QF_DT)
(declare-sort Elem 0)
(declare-datatype Lst ((nil) (cons (head Elem) (tail Lst))))
(declare-const a Elem)

; head(cons(a, nil)) must equal a
(assert (not (= (head (cons a nil)) a)))
(check-sat)`,
  },
  {
    name: 'Constructors are injective',
    logic: 'QF_DT',
    blurb: 'cons is injective: if cons(a,x) = cons(b,x) then a and b are the same — recovered through the selectors.',
    expected: 'unsat',
    src: `(set-logic QF_DT)
(declare-sort Elem 0)
(declare-datatype Lst ((nil) (cons (head Elem) (tail Lst))))
(declare-const a Elem)
(declare-const b Elem)
(declare-const x Lst)

(assert (= (cons a x) (cons b x)))
(assert (not (= a b)))
(check-sat)`,
  },
  {
    name: 'An impossible infinite list',
    logic: 'QF_DT',
    blurb: 'A finite list is never its own tail — x = cons(a, x) would be infinite, so it is unsatisfiable (acyclicity).',
    expected: 'unsat',
    src: `(set-logic QF_DT)
(declare-sort Elem 0)
(declare-datatype Lst ((nil) (cons (head Elem) (tail Lst))))
(declare-const x Lst)
(declare-const a Elem)

(assert (= x (cons a x)))
(check-sat)`,
  },
  {
    name: 'Three colours and no more',
    logic: 'QF_DT',
    blurb: 'An enum has exactly its listed values — a Color that is none of red/green/blue cannot exist (exhaustiveness).',
    expected: 'unsat',
    src: `(set-logic QF_DT)
(declare-datatype Color ((red) (green) (blue)))
(declare-const c Color)

(assert (not (= c red)))
(assert (not (= c green)))
(assert (not (= c blue)))
(check-sat)`,
  },
  {
    name: 'Peano successor',
    logic: 'QF_DT',
    blurb: 'A natural number that is a successor and differs from its own successor — perfectly satisfiable (e.g. 1).',
    expected: 'sat',
    src: `(set-logic QF_DT)
(declare-datatypes ((Nat 0)) (((zero) (succ (pred Nat)))))
(declare-const n Nat)

(assert ((_ is succ) n))
(assert (not (= n (succ n))))
(check-sat)
(get-model)`,
  },
  {
    name: 'A branching tree',
    logic: 'QF_DT',
    blurb: 'A binary tree node whose two children are distinct subtrees — satisfiable; the model commits to a shape.',
    expected: 'sat',
    src: `(set-logic QF_DT)
(declare-sort Elem 0)
(declare-datatypes ((Tree 0)) (((leaf (val Elem)) (node (left Tree) (right Tree)))))
(declare-const t Tree)

(assert ((_ is node) t))
(assert (not (= (left t) (right t))))
(check-sat)
(get-model)`,
  },
  {
    name: 'Typed list head (datatypes + ints)',
    logic: 'QF_DTLIA',
    blurb: 'Datatypes meet integer arithmetic: after x = lcons(5, lnil) the head is 5, so claiming hd(x) < 5 is impossible.',
    expected: 'unsat',
    src: `(set-logic QF_DTLIA)
(declare-datatypes ((IntLst 0)) (((lnil) (lcons (hd Int) (tl IntLst)))))
(declare-const x IntLst)

(assert (= x (lcons 5 lnil)))
(assert (< (hd x) 5))
(check-sat)`,
  },
  {
    name: 'Concatenation splits a word',
    logic: 'QF_S',
    blurb: 'Find x, y with x·y = "ab" and |x| = 1 — the solver reads off x = "a", y = "b" from the bounded code-unit model.',
    expected: 'sat',
    src: `(set-logic QF_S)
(declare-fun x () String)
(declare-fun y () String)

(assert (= (str.++ x y) "ab"))
(assert (= (str.len x) 1))
(check-sat)`,
  },
  {
    name: 'No string is its own tail-extension',
    logic: 'QF_S',
    blurb: 'x = "a"·x would force |x| = 1 + |x|. The reduction sends that straight to the simplex, which refutes it — acyclicity, for free, from the length bound.',
    expected: 'unsat',
    src: `(set-logic QF_S)
(declare-fun x () String)

(assert (= x (str.++ "a" x)))
(check-sat)`,
  },
  {
    name: 'Substring read-back',
    logic: 'QF_S',
    blurb: 'str.substr("hello", 1, 3) is exactly "ell" (SMT-LIB offset/length semantics, unfolded over positions), so denying it is contradictory.',
    expected: 'unsat',
    src: `(set-logic QF_S)
(assert (not (= (str.substr "hello" 1 3) "ell")))
(check-sat)`,
  },
  {
    name: 'Prefix, suffix and a hole in the middle',
    logic: 'QF_S',
    blurb: 'Build a length-4 word that starts with "a", ends with "d" and contains "bc" — the only fit is "abcd".',
    expected: 'sat',
    src: `(set-logic QF_S)
(declare-fun z () String)

(assert (str.prefixof "a" z))
(assert (str.suffixof "d" z))
(assert (str.contains z "bc"))
(assert (= (str.len z) 4))
(check-sat)`,
  },
  {
    name: 'Equality is value, not identity',
    logic: 'QF_S',
    blurb: '"ab"·"c" and "abc" are *different terms* but the *same string*, so demanding they be distinct is unsatisfiable.',
    expected: 'unsat',
    src: `(set-logic QF_S)
(assert (distinct (str.++ "ab" "c") "abc"))
(check-sat)`,
  },
  {
    name: 'Length is additive over concatenation',
    logic: 'QF_S',
    blurb: '|x·y| = |x| + |y| is a theorem of the theory (concatenation lays the code-units end to end), so its negation has no model.',
    expected: 'unsat',
    src: `(set-logic QF_S)
(declare-fun x () String)
(declare-fun y () String)

(assert (not (= (str.len (str.++ x y)) (+ (str.len x) (str.len y)))))
(check-sat)`,
  },
  {
    name: 'Find the first match',
    logic: 'QF_S',
    blurb: 'str.indexof("abcabc", "bc", 2) is the least offset ≥ 2 where "bc" occurs — position 4 — so claiming anything else fails.',
    expected: 'unsat',
    src: `(set-logic QF_S)
(assert (not (= (str.indexof "abcabc" "bc" 2) 4)))
(check-sat)`,
  },
  {
    name: 'Place a letter by its index',
    logic: 'QF_S',
    blurb: 'A length-3 word whose first "b" sits at index 1 and that ends in "c": the solver fills the hole (e.g. "abc").',
    expected: 'sat',
    src: `(set-logic QF_S)
(declare-fun x () String)

(assert (= (str.len x) 3))
(assert (= (str.indexof x "b" 0) 1))
(assert (str.suffixof "c" x))
(check-sat)`,
  },
  {
    name: 'A commuting append',
    logic: 'QF_S',
    blurb: 'x·"a" = "a"·x with |x| = 2 forces x to be all a’s — the solver returns x = "aa".',
    expected: 'sat',
    src: `(set-logic QF_S)
(declare-fun x () String)

(assert (= (str.++ x "a") (str.++ "a" x)))
(assert (= (str.len x) 2))
(check-sat)`,
  },
]
