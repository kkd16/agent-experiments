// A curated library of QF_BV scripts. Each is small enough to bit-blast and
// decide in milliseconds, and chosen to show the bit-level engine doing something
// a word-level arithmetic solver cannot: proving a bit-twiddling identity,
// detecting overflow, running a multiplier backwards to factor, or pulling apart
// signed vs. unsigned order.

export interface BvExample {
  name: string
  logic: string
  blurb: string
  expected: 'sat' | 'unsat'
  src: string
}

export const BV_EXAMPLES: BvExample[] = [
  {
    name: 'x · 2 = x ≪ 1',
    logic: 'QF_BV',
    blurb: 'Multiplying by two is a left shift — for every 8-bit x, modulo 2⁸. We check the negation: UNSAT means the identity always holds.',
    expected: 'unsat',
    src: `(set-logic QF_BV)
(declare-const x (_ BitVec 8))

; is there ANY x where they differ?  None — so the rewrite is sound.
(assert (not (= (bvmul x (_ bv2 8)) (bvshl x (_ bv1 8)))))
(check-sat)`,
  },
  {
    name: 'De Morgan on bit-vectors',
    logic: 'QF_BV',
    blurb: '¬(x & y) = ¬x | ¬y, bit for bit. Asserting a counterexample is unsatisfiable.',
    expected: 'unsat',
    src: `(set-logic QF_BV)
(declare-const x (_ BitVec 8))
(declare-const y (_ BitVec 8))

(assert (not (= (bvnot (bvand x y)) (bvor (bvnot x) (bvnot y)))))
(check-sat)`,
  },
  {
    name: 'XOR swap is correct',
    logic: 'QF_BV',
    blurb: "The classic register-free swap (a^=b; b^=a; a^=b) really does exchange a and b. We prove a's final value equals the original b.",
    expected: 'unsat',
    src: `(set-logic QF_BV)
(declare-const a (_ BitVec 16))
(declare-const b (_ BitVec 16))

; a1 = a^b ; b2 = a1^b = a ; a3 = a1^b2 = b
(assert (let ((a1 (bvxor a b)))
        (let ((b2 (bvxor a1 b)))
        (let ((a3 (bvxor a1 b2)))
          (not (and (= a3 b) (= b2 a)))))))
(check-sat)`,
  },
  {
    name: 'Carve a byte with masks',
    logic: 'QF_BV',
    blurb: 'Find an x whose low nibble is A and high nibble is 3. The bit-blaster constructs 0x3A.',
    expected: 'sat',
    src: `(set-logic QF_BV)
(declare-const x (_ BitVec 8))

(assert (= (bvand x #x0f) #x0a))
(assert (= (bvand x #xf0) #x30))
(check-sat)`,
  },
  {
    name: 'Factoring, the multiplier backwards',
    logic: 'QF_BV',
    blurb: 'Solve a·b = 143 over 8-bit words with both factors > 1 — the solver runs an 8×8 multiplier circuit in reverse and recovers 11 × 13.',
    expected: 'sat',
    src: `(set-logic QF_BV)
(declare-const a (_ BitVec 8))
(declare-const b (_ BitVec 8))

(assert (= (bvmul a b) (_ bv143 8)))
(assert (bvugt a (_ bv1 8)))
(assert (bvugt b (_ bv1 8)))
(check-sat)`,
  },
  {
    name: 'Unsigned addition overflows',
    logic: 'QF_BV',
    blurb: 'Over 8-bit words, x + y can wrap below x. The solver finds a witness — bit-vector arithmetic is modular.',
    expected: 'sat',
    src: `(set-logic QF_BV)
(declare-const x (_ BitVec 8))
(declare-const y (_ BitVec 8))

(assert (bvugt y (_ bv0 8)))
(assert (bvult (bvadd x y) x))   ; sum wrapped around
(check-sat)`,
  },
  {
    name: 'Signed vs. unsigned order',
    logic: 'QF_BV',
    blurb: 'The same two bytes can satisfy x <u y yet x >s y: the sign bit reinterprets the order. 0x7F vs 0x80 is one witness.',
    expected: 'sat',
    src: `(set-logic QF_BV)
(declare-const x (_ BitVec 8))
(declare-const y (_ BitVec 8))

(assert (bvult x y))   ; unsigned: x below y
(assert (bvsgt x y))   ; signed:   x above y
(check-sat)`,
  },
  {
    name: 'Overflow-free average',
    logic: 'QF_BV',
    blurb: 'The bit trick (x & y) + ((x ^ y) ≫ 1) equals ⌊(x+y)/2⌋ with no overflow. We verify it against a 9-bit widened sum: UNSAT confirms it.',
    expected: 'unsat',
    src: `(set-logic QF_BV)
(declare-const x (_ BitVec 8))
(declare-const y (_ BitVec 8))

; widened truth: floor((x+y)/2) computed in 9 bits, then truncated
(assert (not (=
  (bvadd (bvand x y) (bvlshr (bvxor x y) (_ bv1 8)))
  ((_ extract 7 0)
     (bvlshr (bvadd ((_ zero_extend 1) x) ((_ zero_extend 1) y)) (_ bv1 9))))))
(check-sat)`,
  },
  {
    name: 'Rotate round-trips',
    logic: 'QF_BV',
    blurb: 'Rotating left by 5 then right by 5 is the identity on a 16-bit word — no information is lost off the ends.',
    expected: 'unsat',
    src: `(set-logic QF_BV)
(declare-const x (_ BitVec 16))

(assert (not (= ((_ rotate_right 5) ((_ rotate_left 5) x)) x)))
(check-sat)`,
  },
  {
    name: 'A power-of-two test',
    logic: 'QF_BV',
    blurb: 'x & (x−1) = 0 holds exactly when x has at most one set bit. Here we find an x>0 that passes the test yet is not a single given power — many powers of two exist.',
    expected: 'sat',
    src: `(set-logic QF_BV)
(declare-const x (_ BitVec 8))

(assert (= (bvand x (bvsub x (_ bv1 8))) (_ bv0 8))) ; x is 0 or a power of two
(assert (not (= x (_ bv0 8))))                       ; ... and nonzero
(assert (not (= x (_ bv1 8))))                       ; ... and not 1
(check-sat)`,
  },
]
