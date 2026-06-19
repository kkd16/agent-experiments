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
    id: 'divmagic',
    title: 'Division by a constant',
    blurb: 'Watch -O1 turn every `/ C` and `% C` into multiply-shift — no hardware divide.',
    source: `// Hardware integer division is ~20x slower than a multiply, so every
// optimizing compiler replaces a division (or remainder) by a *constant* with
// a short multiply/shift/add sequence — an exact algebraic identity, not an
// approximation. Compile this at -O0 then flip to -O1 and read the WASM tab:
// the i32.div_s / i32.rem_s opcodes vanish.
//
//   * a power of two  -> an arithmetic shift with a round-toward-zero bias,
//   * anything else    -> the signed "magic number" multiply (Hacker's Delight):
//                         a high-word multiply by a precomputed constant.
//
// The reference interpreter and the compiled wasm are proven bit-identical at
// every optimization level, INT_MIN and all.

fn checksum(seed: int) -> int {
  // A little hash mixing divides and remainders by assorted constants.
  let h = seed;
  h = (h * 1103515245 + 12345);         // a wrapping LCG step (fits in int)
  let a = h / 7;          // magic multiply
  let b = h % 100;        // magic multiply (digits)
  let c = h / 16;         // shift by 4 (power of two)
  let d = h % 1000;       // magic multiply
  return a + b * 3 + c - d;
}

fn main() {
  // Decompose numbers into base-10 digits — the canonical /10 and %10 idiom,
  // both of which strength-reduce to the same shared multiply (GVN at -O2).
  for (let n = 0; n < 6; n = n + 1) {
    let x = checksum(n);
    if (x < 0) { x = -x; }
    let digits = 0;
    while (x > 0) {
      print(x % 10);      // last digit
      x = x / 10;         // drop it
      digits = digits + 1;
    }
    print(-1);            // separator
  }
}
`,
  },
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
  {
    id: 'optshow',
    title: 'Optimizer showcase',
    blurb: 'Inlining + LICM + strength reduction — step -O0→-O3 and watch locals & bytes fall.',
    source: `// scale() is tiny and non-recursive, so it is inlined at -O2+; once every
// call is inlined the function itself is deleted (only main is exported).
fn scale(x: int) -> int { return x * 8; }   // x*8 strength-reduces to x<<3

fn main() {
  let a = 17; let b = 4; let acc = 0;
  for (let i = 0; i < 64; i = i + 1) {
    let inv = a * b - (a + b);    // loop-invariant: hoisted to the preheader
    acc += scale(i) + inv;        // call inlined; compound assignment
  }
  print(acc);
}
`,
  },
  {
    id: 'loop-unroll',
    title: 'Loop unrolling → constants',
    blurb: 'Counted loops with a constant trip count fully unroll, then fold away. Step -O0→-O3.',
    source: `// At -O2/-O3 a counted loop whose trip count the optimizer can prove
// constant is *fully unrolled* — the induction variable / trip-count
// analysis (see the Optimizer tab) replaces the loop with straight-line
// copies of its body, and SCCP + GVN + simplify-cfg then fold the whole
// thing into a single constant. Watch the CFG collapse to one block.
fn main() {
  // Sum of squares, i = 1..20. Unrolls to 20 adds, then folds to 2870.
  let s = 0;
  for (let i = 1; i <= 20; i = i + 1) { s = s + i * i; }
  print(s);

  // Two accumulators threaded through the loop as phi nodes — both fold.
  let a = 1; let b = 0;
  for (let k = 0; k < 10; k = k + 1) { let t = a + b; a = b; b = t; }
  print(b);

  // A descending counter (negative step) folds the factorial too.
  let f = 1;
  for (let n = 6; n > 0; n = n - 1) { f = f * n; }
  print(f);
}
`,
  },
  {
    id: 'loop-vector',
    title: 'Fixed-size vector kernel',
    blurb: 'Small memory loops (trip ≤ 8) unroll into straight-line loads/stores — a vector-kernel win.',
    source: `// Small fixed-size loops are unrolled even when they touch linear memory,
// so the index arithmetic and bounds math fold into a flat sequence of
// loads, stores and multiplies — the classic win for fixed-size vector and
// matrix kernels. Compare the WASM / CFG at -O0 vs -O3.
fn main() {
  let v = int_array(4);
  for (let i = 0; i < 4; i = i + 1) { v[i] = (i + 1) * (i + 1); }  // [1, 4, 9, 16]

  // Dot product v·v, unrolled into four load/multiply/add chains.
  let dot = 0;
  for (let i = 0; i < 4; i = i + 1) { dot = dot + v[i] * v[i]; }
  print(dot);                                  // 1 + 16 + 81 + 256 = 354

  // Prefix sums, written back in place.
  for (let i = 1; i < 4; i = i + 1) { v[i] = v[i] + v[i - 1]; }
  for (let i = 0; i < 4; i = i + 1) { print(v[i]); }   // 1 5 14 30
}
`,
  },
  {
    id: 'strings',
    title: 'Strings & text',
    blurb: 'First-class str type: concat with +, str()/char() conversions, len & byte indexing — a real string runtime compiled to wasm.',
    source: `// Strata strings are byte strings living in linear memory. Build them with
// '+', convert numbers with str(), make characters with char(), and read
// bytes by indexing. The whole string runtime is itself written in Strata and
// compiled to wasm — the Verify tab proves it matches the interpreter.
fn shout(s: str) -> str {
  let out = "";
  for (let i = 0; i < len(s); i = i + 1) {
    let c = s[i];
    if (c >= 97 && c <= 122) { c = c - 32; }   // lowercase -> uppercase
    out = out + char(c);
  }
  return out + "!";
}

fn main() {
  print("Hello, " + "Strata" + "!");
  print(shout("functions return strings"));
  for (let i = 1; i <= 15; i = i + 1) {       // FizzBuzz, the wordy way
    let s = "";
    if (i % 3 == 0) { s = s + "Fizz"; }
    if (i % 5 == 0) { s = s + "Buzz"; }
    print(s == "" ? str(i) : s);
  }
}
`,
  },
  {
    id: 'caesar',
    title: 'Caesar cipher',
    blurb: 'Encrypt then decrypt text with modular byte arithmetic; the round trip recovers the original.',
    source: `// A Caesar cipher over the ASCII letters, then its inverse. Shifting by k and
// then by 26-k recovers the original — pure string + byte arithmetic.
fn shift(s: str, k: int) -> str {
  let out = "";
  for (let i = 0; i < len(s); i = i + 1) {
    let c = s[i];
    if (c >= 65 && c <= 90) { c = (c - 65 + k) % 26 + 65; }        // A-Z
    else if (c >= 97 && c <= 122) { c = (c - 97 + k) % 26 + 97; }  // a-z
    out = out + char(c);
  }
  return out;
}

fn main() {
  let msg = "Attack at dawn";
  let enc = shift(msg, 3);
  let dec = shift(enc, 23);   // 26 - 3
  print(msg);
  print(enc);
  print(dec);
  print(dec == msg ? "round-trip OK" : "FAILED");
}
`,
  },
  {
    id: 'barchart',
    title: 'ASCII bar chart',
    blurb: 'Render text bars from array data, with labels assembled by str() — strings + arrays together.',
    source: `// A tiny horizontal bar chart. Each row mixes array data, number formatting
// via str(), and a run of '#' characters built with char(35).
fn bar(n: int) -> str {
  let s = "";
  for (let i = 0; i < n; i = i + 1) { s = s + char(35); }   // '#'
  return s;
}

fn main() {
  let data = int_array(5);
  data[0] = 3; data[1] = 7; data[2] = 2; data[3] = 9; data[4] = 5;
  for (let i = 0; i < 5; i = i + 1) {
    print("row " + str(i) + " | " + bar(data[i]) + " " + str(data[i]));
  }
}
`,
  },
  {
    id: 'toolkit',
    title: 'Text toolkit',
    blurb: 'Case folding, slicing, search and lexicographic ordering — the str library working together.',
    source: `// A little text toolkit built on Strata's string library: case folding
// (to_upper/to_lower), slicing (substr), search (index_of), and ordering.
fn cap(s: str) -> str {
  if (len(s) == 0) { return s; }
  return to_upper(substr(s, 0, 1)) + to_lower(substr(s, 1, len(s) - 1));
}

fn main() {
  let kv = "name=Strata";
  let eq = index_of(kv, 61);              // '=' is byte 61
  print(substr(kv, 0, eq));               // "name"
  print(substr(kv, eq + 1, len(kv)));     // "Strata" (count clamps to the end)

  print(cap("hELLO world"));              // "Hello world"
  print(to_upper("shout"));               // "SHOUT"

  print(to_lower("Apple") == to_lower("apple"));   // case-insensitive equal
  print("apple" < "banana");              // lexicographic ordering
  print("banana" < "apple");
}
`,
  },
  {
    id: 'syntax',
    title: 'Ternary & compound assign',
    blurb: 'The newer surface syntax: conditional expressions and `+= … >>=`.',
    source: `fn sign(x: int) -> int { return x > 0 ? 1 : (x < 0 ? -1 : 0); }

fn main() {
  let bits = 0;
  for (let i = -3; i <= 3; i = i + 1) {
    print(sign(i));
    bits <<= 1;
    bits |= i % 2 == 0 ? 1 : 0;   // ternary inside a compound assignment
  }
  print(bits);
}
`,
  },
  {
    id: 'control-flow',
    title: 'do-while & switch',
    blurb: 'Bottom-tested loops and multi-label switches — try -O0…-O3 to watch the CFG.',
    source: `fn classify(n: int) -> str {
  switch (n % 4) {
    case 0: { return "zero"; }
    case 1, 3: { return "odd"; }      // multi-label case, no fallthrough
    default: { return "two"; }
  }
  return "?";
}

fn main() {
  // do-while always runs the body once, then re-tests the condition.
  let n = 1;
  do {
    print(str(n) + " -> " + classify(n));
    n = n * 2;
  } while (n <= 16);

  for (let i = 0; i < 6; i = i + 1) { print(classify(i)); }
}
`,
  },
  {
    id: 'text-toolkit-2',
    title: 'String library & str[]',
    blurb: 'split / join / trim / replace / parse_int and first-class arrays of strings.',
    source: `// Reverse the word order of a sentence using split + str[] + join.
fn reverse_words(s: str) -> str {
  let w = split(trim(s), " ");
  let out = str_array(len(w));
  for (let i = 0; i < len(w); i = i + 1) { out[len(w) - 1 - i] = w[i]; }
  return join(out, " ");
}

fn main() {
  print(reverse_words("  the quick brown fox  "));
  print(replace("a-b-c-d", "-", " :: "));
  print(repeat("=", 12));
  print(starts_with("strata.wasm", "strata"));
  print(contains("hello world", "o w"));

  // Parse and sum a CSV row.
  let cells = split("12,34,5,-7,100", ",");
  let total = 0;
  for (let i = 0; i < len(cells); i = i + 1) { total += parse_int(cells[i]); }
  print(join(cells, " + ") + " = " + str(total));
}
`,
  },
  {
    id: 'long-hash',
    title: '64-bit hashing (long)',
    blurb: 'The `long` type lowers to real wasm `i64`. FNV-1a + exact 20! — watch the i64 ops in the WASM tab.',
    source: `// Strata's \`long\` is a genuine 64-bit integer (wasm i64). Literals take an
// \`L\` suffix (decimal or 0x hex); arithmetic wraps mod 2^64, exactly like wasm.

// FNV-1a, the classic 64-bit string hash. The offset basis 14695981039346656037
// is written as its signed-i64 value; the multiply wraps — that's the algorithm.
fn fnv1a(s: str) -> long {
  let h = -3750763034362895579L;     // 0xCBF29CE484222325
  for (let i = 0; i < len(s); i = i + 1) {
    h = h ^ long(s[i]);
    h = h * 0x100000001B3L;          // the 64-bit FNV prime, 1099511628211
  }
  return h;
}

// 20! is 2432902008176640000 — it overflows a 32-bit int but is exact in a long.
fn fact(n: int) -> long {
  let r = 1L;
  for (let i = 2; i <= n; i = i + 1) { r = r * long(i); }
  return r;
}

fn main() {
  print(fnv1a("hello"));
  print(fnv1a("world"));
  print("fox -> " + str(fnv1a("The quick brown fox")));
  print(fact(20));
  print(int(20) * int(20));          // for contrast: 32-bit int can overflow
  print(fact(13) > 6227020800L);     // 13! exceeds 2^32
}
`,
  },
  {
    id: 'long-prng',
    title: 'xorshift64 (long)',
    blurb: 'A 64-bit PRNG built from i64 shifts/xor and a long global — deterministic across every -O level.',
    source: `// George Marsaglia's xorshift*: a tiny, fast 64-bit pseudo-random generator.
// State and constants are \`long\` (i64); the shifts and xors are real i64 ops.
let state: long = 0x2545F4914F6CDD1DL;

fn next() -> long {
  let x = state;
  x = x ^ (x << 13L);
  x = x ^ (x >> 7L);
  x = x ^ (x << 17L);
  state = x;
  return x;
}

// A bounded roll in [0, n): take the (wrapped) value modulo n, made non-negative.
fn roll(n: int) -> int {
  let r = int(next() % long(n));
  return r < 0 ? r + n : r;
}

fn main() {
  // raw 64-bit stream
  for (let i = 0; i < 5; i = i + 1) { print(next()); }
  // a histogram of 6000 dice rolls — should be ~1000 each
  let counts = int_array(6);
  for (let i = 0; i < 6000; i = i + 1) { counts[roll(6)] += 1; }
  for (let f = 0; f < 6; f = f + 1) { print(counts[f]); }
}
`,
  },
  {
    id: 'select',
    title: 'Branchless select',
    blurb: 'Ternaries / if-else assignments fold into a wasm `select` at -O1+ — see the WASM tab.',
    source: `// clamp() is two diamonds; if-conversion turns each into a branchless select.
fn clamp(x: int, lo: int, hi: int) -> int {
  let y = x < lo ? lo : x;
  return y > hi ? hi : y;
}

fn main() {
  for (let i = -3; i <= 7; i = i + 1) { print(clamp(i, 0, 4)); }

  // running min / max with no branches in the loop body
  let lo = 1000;
  let hi = -1000;
  let data = split("3,-1,9,4,-8,2,7", ",");
  for (let i = 0; i < len(data); i = i + 1) {
    let v = parse_int(data[i]);
    lo = v < lo ? v : lo;
    hi = v > hi ? v : hi;
  }
  print(lo); print(hi);
}
`,
  },
  {
    id: 'struct-vec',
    title: 'Structs: 2D vectors',
    blurb: 'Aggregate types with named fields — passed, returned, and mutated by handle.',
    source: `// A struct is an aggregate laid out in linear memory and referenced by an
// i32 handle. Fields are read/written with dot notation; structs pass to and
// return from functions by handle (so a function can mutate its argument).
struct Vec2 { x: float; y: float; }

fn add(a: Vec2, b: Vec2) -> Vec2 { return Vec2(a.x + b.x, a.y + b.y); }
fn scale(v: Vec2, s: float) -> Vec2 { return Vec2(v.x * s, v.y * s); }
fn dot(a: Vec2, b: Vec2) -> float { return a.x * b.x + a.y * b.y; }
fn normSq(v: Vec2) -> float { return dot(v, v); }

fn main() {
  let a = Vec2(3.0, 4.0);
  let b = Vec2(1.0, 2.0);
  let c = add(a, scale(b, 2.0));
  print(c.x); print(c.y);
  print(normSq(a));          // 25
  print(dot(a, b));          // 11

  // Mutation through a handle is visible to every alias of the struct.
  let p = a;
  p.x = 10.0;
  print(a.x);                // 10
}
`,
  },
  {
    id: 'struct-bst',
    title: 'Structs: binary search tree',
    blurb: 'Recursive structs + `null` leaves build a real linked data structure.',
    source: `// A recursive struct field holds a handle to another node; \`null\` is the
// handle that points nowhere, so it terminates the tree. Insert is recursive,
// and an in-order walk prints the values in sorted order.
struct Tree { value: int; left: Tree; right: Tree; }

fn insert(t: Tree, v: int) -> Tree {
  if (t == null) { return Tree(v, null, null); }
  if (v < t.value) { t.left = insert(t.left, v); }
  else if (v > t.value) { t.right = insert(t.right, v); }
  return t;
}

fn inorder(t: Tree) {
  if (t == null) { return; }
  inorder(t.left);
  print(t.value);
  inorder(t.right);
}

fn height(t: Tree) -> int {
  if (t == null) { return 0; }
  let l = height(t.left);
  let r = height(t.right);
  return 1 + (l > r ? l : r);
}

fn main() {
  let root: Tree = null;
  let xs = split("5,3,8,1,4,7,9,2,6", ",");
  for (let i = 0; i < len(xs); i = i + 1) {
    root = insert(root, parse_int(xs[i]));
  }
  inorder(root);            // 1..9 sorted
  print(height(root));
}
`,
  },
  {
    id: 'struct-rational',
    title: 'Structs: rational arithmetic',
    blurb: 'A Rat { n, d } value type with gcd-reduced add/mul, returned by value.',
    source: `// Exact fractions as a small value type. Each operation returns a fresh,
// reduced struct — the bump allocator hands out a new handle per construction.
struct Rat { n: int; d: int; }

fn gcd(a: int, b: int) -> int {
  while (b != 0) { let t = a % b; a = b; b = t; }
  return a < 0 ? -a : a;
}

fn reduce(r: Rat) -> Rat {
  let g = gcd(r.n, r.d);
  if (g == 0) { return r; }
  let s = r.d < 0 ? -1 : 1;          // keep the denominator positive
  return Rat(s * r.n / g, s * r.d / g);
}

fn add(a: Rat, b: Rat) -> Rat { return reduce(Rat(a.n * b.d + b.n * a.d, a.d * b.d)); }
fn mul(a: Rat, b: Rat) -> Rat { return reduce(Rat(a.n * b.n, a.d * b.d)); }

fn main() {
  // Harmonic-ish sum 1/1 + 1/2 + 1/3 + 1/4 as one exact fraction.
  let acc = Rat(0, 1);
  for (let i = 1; i <= 4; i = i + 1) { acc = add(acc, Rat(1, i)); }
  print(acc.n); print(acc.d);        // 25 / 12

  let half = mul(Rat(1, 2), Rat(1, 1));
  print(half.n); print(half.d);      // 1 / 2
}
`,
  },
  {
    id: 'struct-array',
    title: 'Structs: arrays of records',
    blurb: 'struct_array(n) makes a null-filled array of handles — here a tiny insertion sort.',
    source: `// An array of structs is an array of handles (struct_array(n) starts all-null).
// Sorting swaps handles, never field contents, so it is one i32 move per swap.
struct Item { key: int; tag: int; }

fn main() {
  let parts = split("5:a,2:b,8:c,1:d,9:e,3:f,7:g", ",");
  let n = len(parts);
  let a: Item[] = struct_array(n);
  for (let i = 0; i < n; i = i + 1) {
    let kv = split(parts[i], ":");
    a[i] = Item(parse_int(kv[0]), i);
  }

  // insertion sort by key — moves handles, keeping each Item intact
  for (let i = 1; i < n; i = i + 1) {
    let cur = a[i];
    let j = i - 1;
    while (j >= 0 && a[j].key > cur.key) { a[j + 1] = a[j]; j = j - 1; }
    a[j + 1] = cur;
  }

  for (let i = 0; i < n; i = i + 1) { print(a[i].key); }
  print(a[0].tag);            // original index of the smallest key
}
`,
  },
  {
    id: 'mem-opt',
    title: 'Memory optimization',
    blurb: 'Watch -O1 forward stores into loads, eliminate redundant loads, and delete dead stores — count the load/store opcodes vanish from the WASM tab.',
    source: `// Until the mid-end could reason about *memory*, every struct-field and array
// access did a real round-trip through linear memory. The memory optimizer adds
// the three classic transforms, all on one alias analysis (compile at -O0, then
// flip to -O1 and read the WASM tab — the i32.load / i32.store opcodes drop):
//
//   * store -> load forwarding : a field written then read back becomes the value
//   * redundant-load elimination: the same field read twice loads once
//   * dead-store elimination   : a field overwritten before any read isn't stored
//
// It is conservative by design: only accesses through the *same base* at disjoint
// constant offsets are proven non-aliasing, so a write through one handle can
// never be wrongly forwarded across a write through another — every rewrite is
// proven behaviour-preserving by the differential oracle at -O0..-O3.

struct Particle { x: int; y: int; vx: int; vy: int; }

fn step(p: Particle) {
  // A read-modify-write burst on one handle. Each load after the first store of
  // a field forwards the stored value; the construction's initial stores that
  // get overwritten here are dead. Only the final field values survive as stores.
  p.x = p.x + p.vx;     // load x, load vx, store x
  p.y = p.y + p.vy;     // load y, load vy, store y
  p.vy = p.vy - 1;      // gravity: load vy, store vy
}

fn energy(p: Particle) -> int {
  // Every field is read twice — redundant-load elimination keeps one load each.
  return p.vx * p.vx + p.vy * p.vy + p.x + p.x + p.y + p.y;
}

fn main() {
  let p = Particle(0, 100, 3, 0);
  for (let t = 0; t < 5; t = t + 1) {
    step(p);
    print(p.x); print(p.y);
  }
  print(energy(p));
}
`,
  },
  {
    id: 'float-format',
    title: 'Floating point & str(float)',
    blurb: 'A from-scratch shortest round-trip formatter (Dragon4, written in Strata) + the f64 math library — all compiled to real wasm.',
    source: `// str(float) prints the *shortest* decimal that reads back to the exact same
// f64 — the same string a browser's Number.toString would give — produced by a
// Dragon4 big-integer formatter written in Strata and compiled to WebAssembly.
fn main() {
  // The classic: 0.1 + 0.2 is not 0.3
  print("0.1 + 0.2 = " + str(0.1 + 0.2));
  print("1/3       = " + str(1.0 / 3.0));
  print("sqrt(2)   = " + str(sqrt(2.0)));

  // Shortest round-trip across magnitudes (watch the fixed<->exponent threshold)
  print(str(1.0e21)); print(str(0.0000001)); print(str(6.022e23));

  // A tiny stats pass: mean and population standard deviation (uses sqrt)
  let data = float_array(8);
  data[0] = 2.0; data[1] = 4.0; data[2] = 4.0; data[3] = 4.0;
  data[4] = 5.0; data[5] = 5.0; data[6] = 7.0; data[7] = 9.0;
  let n = len(data);
  let sum = 0.0;
  for (let i = 0; i < n; i = i + 1) { sum = sum + data[i]; }
  let mean = sum / float(n);
  let acc = 0.0;
  for (let i = 0; i < n; i = i + 1) { let d = data[i] - mean; acc = acc + d * d; }
  print("mean = " + str(mean) + ", stddev = " + str(sqrt(acc / float(n))));

  // Rounding is ties-to-even (wasm f64.nearest), plus abs / fmin / fmax
  print("round: " + str(round(2.5)) + " " + str(round(3.5)) + " " + str(round(-2.5)));
  print("clamp: " + str(fmax(0.0, fmin(10.0, 42.5))) + ", |-7.5| = " + str(abs(-7.5)));
}
`,
  },
  {
    id: 'math-lib',
    title: 'Transcendental math library',
    blurb: 'exp / ln / sin / cos / pow / atan2 / … — written once in Strata, compiled to wasm AND run by the oracle, so they agree bit-for-bit. Includes an ASCII sine plot.',
    source: `// Strata's transcendental library. WebAssembly has no exp/sin/ln opcode, so each
// of these is a polynomial kernel written in Strata itself (MATH_PRELUDE): the
// compiler injects it into the wasm, and the reference interpreter runs the very
// same source — so the two agree to the last bit, which the harness proves.
fn main() {
  print("e         = " + str(exp(1.0)));
  print("ln(2)     = " + str(ln(2.0)));
  print("pi        = " + str(atan2(0.0, -1.0)));         // atan2 recovers pi
  print("2^0.5     = " + str(pow(2.0, 0.5)));
  print("sin(1)    = " + str(sin(1.0)));
  print("hypot 3,4 = " + str(hypot(3.0, 4.0)));
  print("cbrt(27)  = " + str(cbrt(27.0)));
  print("tanh(1)   = " + str(tanh(1.0)));

  // An ASCII plot of sin over [0, 2*pi): each row maps sin in [-1,1] to a column.
  let pi = 3.141592653589793;
  let rows = 17;
  for (let r = 0; r < rows; r = r + 1) {
    let x = 2.0 * pi * float(r) / float(rows - 1);
    let y = sin(x);
    let col = int(round((y + 1.0) * 22.0));   // 0..44
    let line = "";
    for (let c = 0; c <= 44; c = c + 1) {
      if (c == col) { line = line + "*"; }
      else if (c == 22) { line = line + "|"; }   // the y = 0 axis
      else { line = line + " "; }
    }
    print(line);
  }
}
`,
  },
  {
    id: 'mandelbrot',
    title: 'Mandelbrot set (ASCII)',
    blurb: 'Escape-time render of the Mandelbrot set with floating-point arithmetic — the wasm output matches the interpreter pixel-for-pixel.',
    source: `// The Mandelbrot set, rendered as ASCII by escape-time iteration. Pure f64
// arithmetic in a hot double loop — a good exercise for LICM and the stackifier.
fn main() {
  let rows = 24;
  let cols = 64;
  let maxIter = 50;
  let shades = " .:-=+*#%@";          // 10 density levels (escape time -> glyph)
  for (let py = 0; py < rows; py = py + 1) {
    let y0 = (float(py) / float(rows)) * 2.0 - 1.0;        // [-1, 1)
    let line = "";
    for (let px = 0; px < cols; px = px + 1) {
      let x0 = (float(px) / float(cols)) * 3.0 - 2.0;      // [-2, 1)
      let x = 0.0;
      let y = 0.0;
      let iter = 0;
      while (iter < maxIter && x * x + y * y <= 4.0) {
        let xt = x * x - y * y + x0;
        y = 2.0 * x * y + y0;
        x = xt;
        iter = iter + 1;
      }
      if (iter >= maxIter) { line = line + "@"; }
      else {
        let idx = iter % 10;
        line = line + substr(shades, idx, 1);
      }
    }
    print(line);
  }
}
`,
  },
  {
    id: 'f32-precision',
    title: 'f32 vs f64 precision',
    blurb: 'Single precision (wasm f32) lowered end to end. Watch where 32-bit floats diverge from 64-bit — representability, a harmonic sum, and the 2^24 integer gap.',
    source: `// 'f32' is a real single-precision type lowered to the wasm f32 opcodes. It is
// distinct from 'float' (f64): the type checker forbids mixing them, and every
// f32 op rounds to 24-bit precision. Here is where that rounding shows.
fn main() {
  // 0.1 has no exact binary form; f32 keeps far fewer bits than f64.
  print("0.1 as f64 = " + str(0.1));
  print("0.1 as f32 = " + str(float(f32(0.1))));     // promote to f64 to print
  // A neat reversal: 0.1+0.2 != 0.3 in f64, but the coarser f32 rounding lands
  // both on the same value, so the f32 comparison is true.
  print("0.1+0.2 == 0.3 in f64? " + str(0.1 + 0.2 == 0.3));
  print("0.1+0.2 == 0.3 in f32? " + str(f32(0.1) + f32(0.2) == f32(0.3)));

  // The 2^24 gap: above 16777216, consecutive integers are NOT all representable.
  print("f32(16777216) = " + str(f32(16777216)));
  print("f32(16777217) = " + str(f32(16777217)));    // rounds back down to 2^24

  // A harmonic sum drifts more in single precision than double.
  let n = 4096;
  let s32 = f32(0.0);
  let s64 = 0.0;
  for (let i = 1; i <= n; i = i + 1) {
    s32 = s32 + f32(1.0) / f32(i);
    s64 = s64 + 1.0 / float(i);
  }
  print("harmonic(4096) f32 = " + str(s32));
  print("harmonic(4096) f64 = " + str(s64));
  print("difference         = " + str(s64 - float(s32)));
}
`,
  },
  {
    id: 'higher-order',
    title: 'First-class functions',
    blurb: 'Function pointers: pass functions as arguments, return them, store them in a struct vtable, and call them through a real wasm call_indirect. Compile at -O1+ and watch the Optimizer panel devirtualize the provable indirect calls back into direct ones.',
    source: `// Functions are values. A function type is written 'fn(int, int) -> int', and a
// bare function name decays to a pointer to it (like C / Go). Calling a function-
// typed value lowers to a real wasm 'call_indirect' through the module's function
// table. Below: a generic map/reduce, a comparator-driven sort, and a vtable.

fn square(x: int) -> int { return x * x; }
fn add(a: int, b: int) -> int { return a + b; }
fn maxi(a: int, b: int) -> int { return a > b ? a : b; }

// Generic over the mapped function 'g' — pass any 'fn(int) -> int'.
fn map(xs: int[], g: fn(int) -> int) -> int[] {
  let out = int_array(len(xs));
  for (let i = 0; i < len(xs); i = i + 1) { out[i] = g(xs[i]); }
  return out;
}

// A self-recursive fold: never inlined, so its indirect call genuinely survives.
fn fold(xs: int[], i: int, g: fn(int, int) -> int, acc: int) -> int {
  if (i >= len(xs)) { return acc; }
  return fold(xs, i + 1, g, g(acc, xs[i]));
}

// Insertion sort parameterized by a comparator function pointer.
fn sort(xs: int[], less: fn(int, int) -> bool) {
  for (let i = 1; i < len(xs); i = i + 1) {
    let key = xs[i];
    let j = i - 1;
    while (j >= 0 && less(key, xs[j])) { xs[j + 1] = xs[j]; j = j - 1; }
    xs[j + 1] = key;
  }
}
fn asc(a: int, b: int) -> bool { return a < b; }
fn desc(a: int, b: int) -> bool { return a > b; }

// A 'struct' of function pointers is a hand-rolled vtable / strategy object.
struct Op { run: fn(int, int) -> int; name: str; }

fn show(label: str, xs: int[]) {
  let line = label;
  for (let i = 0; i < len(xs); i = i + 1) { line = line + " " + str(xs[i]); }
  print(line);
}

fn main() {
  let a = int_array(6);
  a[0]=5; a[1]=3; a[2]=8; a[3]=1; a[4]=9; a[5]=2;
  show("input   ", a);

  // map(square): a function passed as an argument.
  show("squared ", map(a, square));

  // fold with two different combiners chosen at runtime.
  print("sum = " + str(fold(a, 0, add, 0)));
  print("max = " + str(fold(a, 0, maxi, -2147483648)));

  // sort with a comparator, then re-sort with the opposite one.
  sort(a, asc);  show("asc     ", a);
  sort(a, desc); show("desc    ", a);

  // A vtable: a 'struct' field holds a function pointer. (Arrays of function
  // pointers also work now — see the "Bytecode VM" example for a jump table.)
  let plus = Op(add, "plus");
  print(plus.name + "(20, 22) = " + str(plus.run(20, 22)));

  // Devirtualization: 'g' is a known function pointer, so at -O1+ the optimizer
  // proves the target and rewrites 'g(7)' into a direct call to 'square'.
  let g = square;
  print("g(7) = " + str(g(7)));
}
`,
  },
  {
    id: 'bytecode-vm',
    title: 'Bytecode VM (jump table)',
    blurb: 'A stack-based virtual machine whose instruction dispatch is an array of function pointers — a real jump table lowered to a wasm call_indirect indexed by the opcode. Each instruction is one function in the table; the fetch–decode–execute loop is a single table indexing. The handler table is data, so the dispatch never devirtualizes, even at -O3.',
    source: `// A tiny stack machine. The classic interpreter dispatch — a 'switch' over the
// opcode — is replaced here by an ARRAY OF FUNCTION POINTERS indexed directly by
// the opcode: 'table[op](vm, imm)'. That single indexing is the whole decode
// step, and it lowers to a wasm 'call_indirect' through the module's function
// table. Because the table is built at runtime, the optimizer can never prove the
// target, so the indirect dispatch survives at every optimization level.

struct VM { stack: int[]; sp: int; }              // a struct with an int[] field

fn push(vm: VM, x: int) { vm.stack[vm.sp] = x; vm.sp = vm.sp + 1; }
fn pop(vm: VM) -> int { vm.sp = vm.sp - 1; return vm.stack[vm.sp]; }

// Every instruction handler shares one signature: 'fn(VM, int) -> void', taking
// the machine and the instruction's immediate operand (used only by PUSH).
fn op_push(vm: VM, imm: int) { push(vm, imm); }
fn op_add(vm: VM, imm: int)  { let b = pop(vm); let a = pop(vm); push(vm, a + b); }
fn op_sub(vm: VM, imm: int)  { let b = pop(vm); let a = pop(vm); push(vm, a - b); }
fn op_mul(vm: VM, imm: int)  { let b = pop(vm); let a = pop(vm); push(vm, a * b); }
fn op_dup(vm: VM, imm: int)  { let a = pop(vm); push(vm, a); push(vm, a); }
fn op_neg(vm: VM, imm: int)  { push(vm, 0 - pop(vm)); }
fn op_out(vm: VM, imm: int)  { print(pop(vm)); }

// Opcode constants — the indices into the dispatch table.
fn PUSH() -> int { return 0; }
fn ADD()  -> int { return 1; }
fn SUB()  -> int { return 2; }
fn MUL()  -> int { return 3; }
fn DUP()  -> int { return 4; }
fn NEG()  -> int { return 5; }
fn OUT()  -> int { return 6; }

// Fetch–decode–execute: a single 'table[op](...)' per instruction.
fn run(code: int[], imm: int[], table: (fn(VM, int))[]) {
  let vm = VM(int_array(256), 0);
  let pc = 0;
  while (pc < len(code)) {
    table[code[pc]](vm, imm[pc]);
    pc = pc + 1;
  }
}

fn main() {
  // Wire the jump table once: opcode -> handler.
  let table: (fn(VM, int))[] = fn_array(7);
  table[PUSH()] = op_push;
  table[ADD()]  = op_add;
  table[SUB()]  = op_sub;
  table[MUL()]  = op_mul;
  table[DUP()]  = op_dup;
  table[NEG()]  = op_neg;
  table[OUT()]  = op_out;

  // Program: compute (3 + 4) * 5, print it, then print -(6 * 6).
  let n = 11;
  let code = int_array(n);
  let imm = int_array(n);
  code[0]=PUSH(); imm[0]=3;
  code[1]=PUSH(); imm[1]=4;
  code[2]=ADD();
  code[3]=PUSH(); imm[3]=5;
  code[4]=MUL();
  code[5]=OUT();             // -> 35
  code[6]=PUSH(); imm[6]=6;
  code[7]=DUP();
  code[8]=MUL();
  code[9]=NEG();
  code[10]=OUT();            // -> -36

  run(code, imm, table);
}
`,
  },
];

export const TEST_PROGRAMS: { name: string; source: string }[] = EXAMPLES.map((e) => ({ name: e.id, source: e.source }));
