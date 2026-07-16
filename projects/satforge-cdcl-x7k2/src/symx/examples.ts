// A curated gallery of Mini programs. Each carries the verdict the symbolic
// executor is expected to return at the default unroll bound (8), plus a small
// input box the self-test enumerates concretely to corroborate that verdict.

export interface SymxExample {
  title: string
  blurb: string
  src: string
  expect: 'safe' | 'safe-bounded' | 'unsafe' | 'unknown'
  /** Inclusive per-input box the self-test brute-forces (must be small). */
  box?: { lo: bigint; hi: bigint }
}

export const SYMX_EXAMPLES: SymxExample[] = [
  {
    title: 'Absolute value',
    blurb: 'The textbook |x|: negate the negative branch, then prove the result is never negative. Loop-free, so this is verified for ALL integers — not merely up to a bound.',
    expect: 'safe',
    box: { lo: -12n, hi: 12n },
    src: `# abs(x) is always non-negative — a total, unbounded proof.
input x;
r = x;
if (x < 0) {
  r = -x;
}
assert(r >= 0);
`,
  },
  {
    title: 'max — broken',
    blurb: 'A max(a,b) with the assignment flipped in the taken branch. The executor finds inputs where the "maximum" is smaller than b and reproduces the crash.',
    expect: 'unsafe',
    box: { lo: -8n, hi: 8n },
    src: `# BUG: the true branch stores a instead of b.
input a;
input b;
m = a;
if (b > a) {
  m = a;   # should be: m = b
}
assert(m >= a);
assert(m >= b);
`,
  },
  {
    title: 'max — fixed',
    blurb: 'The corrected maximum. Both post-conditions (m ≥ a and m ≥ b) hold on every path, for all inputs.',
    expect: 'safe',
    box: { lo: -8n, hi: 8n },
    src: `input a;
input b;
m = a;
if (b > a) {
  m = b;
}
assert(m >= a);
assert(m >= b);
`,
  },
  {
    title: 'clamp to [lo, hi]',
    blurb: 'Clamp x into an interval, ASSUMING lo ≤ hi. The assumption prunes the impossible inputs; the two post-conditions then hold universally.',
    expect: 'safe',
    box: { lo: -6n, hi: 6n },
    src: `input x;
input lo;
input hi;
assume(lo <= hi);
r = x;
if (r < lo) { r = lo; }
if (r > hi) { r = hi; }
assert(r >= lo);
assert(r <= hi);
`,
  },
  {
    title: 'sign classifier',
    blurb: 'Map x to its sign in {-1, 0, 1}. Uses Boolean connectives inside an assertion: "x ≠ 0 OR sign = 0".',
    expect: 'safe',
    box: { lo: -10n, hi: 10n },
    src: `input x;
s = 0;
if (x > 0) { s = 1; }
if (x < 0) { s = -1; }
assert(s <= 1);
assert(s >= -1);
assert(!(x == 0) || s == 0);
`,
  },
  {
    title: 'loop — invariant proven',
    blurb: 'A counted loop with a bounded input (0 ≤ n ≤ 5). Every iteration fits inside the unroll budget, so the invariant s = 3n is proven for all admissible n.',
    expect: 'safe',
    box: { lo: 0n, hi: 5n },
    src: `input n;
assume(n >= 0);
assume(n <= 5);
i = 0;
s = 0;
while (i < n) {
  s = s + 3;
  i = i + 1;
}
assert(s == 3 * n);
`,
  },
  {
    title: 'loop — safe up to bound',
    blurb: 'The same loop with n unbounded. Paths that would run past the unroll bound are flagged, so this is proven safe UP TO K iterations — bounded model checking in miniature.',
    expect: 'safe-bounded',
    box: { lo: 0n, hi: 6n },
    src: `input n;
assume(n >= 0);
i = 0;
s = 0;
while (i < n) {
  s = s + 2;
  i = i + 1;
}
assert(s == 2 * n);
`,
  },
  {
    title: 'loop — off-by-two bug',
    blurb: 'A loop that steps the counter by 2, then asserts it lands exactly on n. It overshoots whenever n is odd; the executor returns the smallest such n and the concrete trace confirms it.',
    expect: 'unsafe',
    box: { lo: 0n, hi: 7n },
    src: `input n;
assume(n >= 0);
i = 0;
while (i < n) {
  i = i + 2;
}
assert(i == n);   # fails for odd n
`,
  },
  {
    title: 'non-linear — out of fragment',
    blurb: 'Multiplying two unknowns leaves QF_LIA. The executor detects this honestly and reports "unknown" rather than guessing — the boundary of exact decidability.',
    expect: 'unknown',
    src: `input x;
input y;
z = x * y;
assert(z >= 0);
`,
  },
]
