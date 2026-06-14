// Curated Strata programs shown in the editor's example menu. They are chosen to
// exercise every language feature and to make the optimizer's wins visible.

export interface Example {
  id: string;
  title: string;
  blurb: string;
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'fib',
    title: 'Recursive Fibonacci',
    blurb: 'Tree recursion — watch the call graph in the WASM output.',
    source: `// Classic tree recursion. Compiles to a recursive wasm function.
fn fib(n: int) -> int {
  if (n < 2) { return n; }
  return fib(n - 1) + fib(n - 2);
}

fn main() {
  for (let i = 0; i < 15; i = i + 1) {
    print(fib(i));
  }
}
`,
  },
  {
    id: 'sieve',
    title: 'Sieve of Eratosthenes',
    blurb: 'Linear-memory arrays + nested loops counting primes below 100.',
    source: `// Count primes below N using a boolean sieve in linear memory.
fn main() {
  let n = 100;
  let sieve = int_array(n);
  let count = 0;
  for (let i = 2; i < n; i = i + 1) {
    if (sieve[i] == 0) {
      count = count + 1;
      for (let j = i * 2; j < n; j = j + i) {
        sieve[j] = 1;
      }
    }
  }
  print(count);
}
`,
  },
  {
    id: 'sort',
    title: 'Insertion Sort',
    blurb: 'In-place array sorting; prints the sorted sequence.',
    source: `// Insertion sort over an array allocated in linear memory.
fn main() {
  let n = 10;
  let a = int_array(n);
  // a pseudo-random-ish fill
  let seed = 7;
  for (let i = 0; i < n; i = i + 1) {
    seed = (seed * 1103515245 + 12345) & 2147483647;
    a[i] = seed % 100;
  }
  for (let i = 1; i < n; i = i + 1) {
    let key = a[i];
    let j = i - 1;
    while (j >= 0 && a[j] > key) {
      a[j + 1] = a[j];
      j = j - 1;
    }
    a[j + 1] = key;
  }
  for (let i = 0; i < n; i = i + 1) { print(a[i]); }
}
`,
  },
  {
    id: 'newton',
    title: 'Newton sqrt (floats)',
    blurb: 'Floating point + iterative refinement using f64 throughout.',
    source: `// Newton-Raphson square root, printed for a few values.
fn sqrt(x: float) -> float {
  if (x <= 0.0) { return 0.0; }
  let g = x;
  for (let i = 0; i < 20; i = i + 1) {
    g = 0.5 * (g + x / g);
  }
  return g;
}

fn main() {
  for (let i = 1; i <= 10; i = i + 1) {
    print(sqrt(float(i)));
  }
}
`,
  },
  {
    id: 'collatz',
    title: 'Collatz lengths',
    blurb: 'while-loops with mixed branches; finds the longest chain under 1000.',
    source: `fn collatz(n: int) -> int {
  let steps = 0;
  while (n != 1) {
    if (n % 2 == 0) { n = n / 2; }
    else { n = 3 * n + 1; }
    steps = steps + 1;
  }
  return steps;
}

fn main() {
  let best = 0;
  let bestN = 0;
  for (let i = 1; i < 1000; i = i + 1) {
    let s = collatz(i);
    if (s > best) { best = s; bestN = i; }
  }
  print(bestN);
  print(best);
}
`,
  },
  {
    id: 'totient',
    title: "Euler's totient",
    blurb: 'Mutual use of gcd in a double loop — heavy on calls and branches.',
    source: `fn gcd(a: int, b: int) -> int {
  while (b != 0) { let t = b; b = a % b; a = t; }
  return a;
}

fn main() {
  let n = 30;
  let total = 0;
  for (let i = 1; i <= n; i = i + 1) {
    if (gcd(i, n) == 1) { total = total + 1; }
  }
  print(total); // phi(30) = 8
}
`,
  },
  {
    id: 'constfold',
    title: 'Constant folding (SCCP)',
    blurb: 'Switch to -O1 and watch ~100 instructions collapse to one constant.',
    source: `// Sparse Conditional Constant Propagation evaluates all of this at
// compile time. Compare the IR / WASM at -O0 versus -O1.
fn main() {
  let a = 2 + 3 * 4 - 1;            // 13
  let b = (a * a) % 7;             // 1
  let c = 1 << 10;                // 1024
  let dead = a * 0 + (c - c);     // 0  (folded + dead-code-eliminated)
  if (10 > 3 && 2 * 2 == 4) {
    print(a + b + c + dead);
  } else {
    print(-1);                    // this branch is proven dead
  }
}
`,
  },
  {
    id: 'cse',
    title: 'Common subexpressions (GVN)',
    blurb: 'At -O2, global value numbering removes the repeated x*y.',
    source: `fn f(x: int, y: int) -> int {
  let a = x * y + x;
  let b = x * y + y;       // x*y recomputed...
  let c = (x * y) * (x * y); // ...and again
  return a + b + c;
}

fn main() {
  print(f(6, 7));
}
`,
  },
  {
    id: 'ackermann',
    title: 'Ackermann',
    blurb: 'Deeply nested recursion — a small but brutal stress test.',
    source: `fn ack(m: int, n: int) -> int {
  if (m == 0) { return n + 1; }
  if (n == 0) { return ack(m - 1, 1); }
  return ack(m - 1, ack(m, n - 1));
}

fn main() {
  for (let m = 0; m <= 3; m = m + 1) {
    print(ack(m, 3));
  }
}
`,
  },
];

export const TEST_PROGRAMS: { name: string; source: string }[] = EXAMPLES.map((e) => ({ name: e.id, source: e.source }));
