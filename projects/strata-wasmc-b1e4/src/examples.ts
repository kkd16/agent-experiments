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
];

export const TEST_PROGRAMS: { name: string; source: string }[] = EXAMPLES.map((e) => ({ name: e.id, source: e.source }));
