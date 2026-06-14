// An adversarial differential-test battery. Each program is small, deterministic
// and *non-trapping* (a trap's message differs between the interpreter and the
// wasm engine, so traps aren't comparable). The Verify panel compiles every one
// at -O0…-O3, runs the wasm, and asserts the printed output equals the reference
// interpreter — so these double as a regression suite for the optimizer, the
// stackifier and the new language features.

export interface TestProgram {
  name: string;
  source: string;
}

export const TESTS: TestProgram[] = [
  {
    name: 'int-wraparound',
    source: `fn main(){
  let a = 2147483647; print(a + 1);      // wraps to INT_MIN
  print(-2147483648 - 1);                // wraps to INT_MAX
  print(1000000 * 1000000);              // imul wrap
}`,
  },
  {
    name: 'shift-mask',
    source: `fn main(){
  print(1 << 31); print(1 << 33);        // shift amount is masked to 5 bits
  print(-8 >> 1); print(255 >> 9);
  print(7 & 5); print(7 | 8); print(6 ^ 3); print(~0);
}`,
  },
  {
    name: 'signed-div-rem',
    source: `fn main(){
  print(-7 / 2); print(7 / -2); print(-7 / -2);
  print(-7 % 2); print(7 % -2); print(-7 % -2);
  print(-2147483648 % -1);               // defined as 0, no trap
}`,
  },
  {
    name: 'strength-reduce-mul',
    source: `fn f(x: int) -> int { return x * 8 + x * 1024 + 2 * x; }
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(f(i - 3)); } }`,
  },
  {
    name: 'float-arith',
    source: `fn main(){
  let a = 3.5; let b = 1.25;
  print(a + b); print(a - b); print(a * b); print(a / b);
  print(a > b); print(a == 3.5); print(a < b);
}`,
  },
  {
    name: 'float-infinity',
    source: `fn main(){
  let z = 0.0; print(1.0 / z); print(-1.0 / z);
  let big = 1.0e308; print(big * 10.0);
}`,
  },
  {
    name: 'casts',
    source: `fn main(){
  print(int(3.9)); print(int(-3.9)); print(int(2.0));
  print(float(5)); print(float(-1));
  print(int(true)); print(int(false));
}`,
  },
  {
    name: 'short-circuit-order',
    source: `fn loud(x: int) -> bool { print(x); return x > 0; }
fn main(){
  if (loud(1) && loud(2)) { print(100); }
  if (loud(0) && loud(3)) { print(200); } else { print(300); }
  if (loud(0) || loud(4)) { print(400); }
}`,
  },
  {
    name: 'ternary-nested',
    source: `fn classify(x: int) -> int { return x < 0 ? -1 : (x == 0 ? 0 : 1); }
fn main(){
  for (let i = -2; i <= 2; i = i + 1) { print(classify(i)); }
  let t = 1 < 2 ? (3 > 4 ? 10 : 20) : 30; print(t);
}`,
  },
  {
    name: 'ternary-float',
    source: `fn main(){
  for (let i = 0; i < 4; i = i + 1) {
    let v = i % 2 == 0 ? 0.5 : 1.5;
    print(v * float(i));
  }
}`,
  },
  {
    name: 'compound-assign',
    source: `fn main(){
  let x = 10; x += 5; x -= 3; x *= 2; x /= 4; x %= 5; print(x);
  let b = 12; b &= 10; b |= 1; b ^= 3; b <<= 2; b >>= 1; print(b);
  let a = int_array(2); a[0] = 1; a[0] += 9; a[1] = a[0]; a[1] *= 3; print(a[0]); print(a[1]);
}`,
  },
  {
    name: 'mutual-recursion',
    source: `fn is_even(n: int) -> bool { return n == 0 ? true : is_odd(n - 1); }
fn is_odd(n: int) -> bool { return n == 0 ? false : is_even(n - 1); }
fn main(){ for (let i = 0; i < 8; i = i + 1) { print(is_even(i)); } }`,
  },
  {
    name: 'inline-chain',
    source: `fn c(x: int) -> int { return x + 1; }
fn b(x: int) -> int { return c(x) * 2; }
fn a(x: int) -> int { return b(x) - 3; }
fn main(){ for (let i = 0; i < 5; i = i + 1) { print(a(i)); } }`,
  },
  {
    name: 'inline-arg-once',
    source: `fn dbl(x: int) -> int { return x + x; }
fn main(){
  let n = 0;
  // the argument has no side effects but is a compound expression
  for (let i = 1; i <= 4; i = i + 1) { n = n + dbl(i * i + 1); }
  print(n);
}`,
  },
  {
    name: 'array-reverse',
    source: `fn main(){
  let n = 8; let a = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i * i; }
  let lo = 0; let hi = n - 1;
  while (lo < hi) { let t = a[lo]; a[lo] = a[hi]; a[hi] = t; lo += 1; hi -= 1; }
  for (let i = 0; i < n; i = i + 1) { print(a[i]); }
}`,
  },
  {
    name: 'matrix-trace',
    source: `fn main(){
  let n = 4; let m = int_array(n * n);
  for (let r = 0; r < n; r = r + 1) {
    for (let col = 0; col < n; col = col + 1) { m[r * n + col] = r * 10 + col; }
  }
  let tr = 0;
  for (let i = 0; i < n; i = i + 1) { tr += m[i * n + i]; }
  print(tr);
}`,
  },
  {
    name: 'break-continue',
    source: `fn main(){
  let sum = 0;
  for (let i = 0; i < 100; i = i + 1) {
    if (i % 3 == 0) { continue; }
    if (i > 20) { break; }
    sum += i;
  }
  print(sum);
}`,
  },
  {
    name: 'licm-heavy',
    source: `fn main(){
  let a = 6; let b = 9; let acc = 0;
  for (let i = 0; i < 50; i = i + 1) {
    let inv = (a * b) + (b - a) * (a + b);   // fully loop-invariant
    acc = (acc + inv + i) % 1000000007;
  }
  print(acc);
}`,
  },
  {
    name: 'nested-licm',
    source: `fn main(){
  let k = 4; let total = 0;
  for (let i = 0; i < 20; i = i + 1) {
    for (let j = 0; j < 20; j = j + 1) {
      let inv = k * k - k;          // invariant in both loops
      total += inv + i - j;
    }
  }
  print(total);
}`,
  },
  {
    name: 'globals',
    source: `let counter = 0;
let step: int = 3;
fn bump() -> int { counter = counter + step; return counter; }
fn main(){ for (let i = 0; i < 5; i = i + 1) { print(bump()); } }`,
  },
  {
    name: 'const-fold-dead',
    source: `fn main(){
  let a = 2 + 3 * 4;            // 14
  if (a > 100) { print(-1); }  // dead branch
  else if (1 + 1 == 2) { print(a * 0 + a - a + 7); }
  let x = (10 << 2) >> 1;      // 20
  print(x);
}`,
  },
  {
    name: 'shadowing',
    source: `fn main(){
  let x = 1;
  { let x = 2; { let x = 3; print(x); } print(x); }
  print(x);
  for (let x = 10; x < 13; x = x + 1) { print(x); }
}`,
  },
  {
    name: 'early-return',
    source: `fn first_factor(n: int) -> int {
  for (let d = 2; d * d <= n; d = d + 1) { if (n % d == 0) { return d; } }
  return n;
}
fn main(){ for (let n = 2; n < 20; n = n + 1) { print(first_factor(n)); } }`,
  },
  {
    name: 'zero-trip-loop',
    source: `fn main(){
  let a = 5; let r = 0;
  for (let i = 0; i < 0; i = i + 1) { r = a * a + a; }  // never runs
  print(r);
  let n = -3;
  while (n > 0) { r += a * 2; n -= 1; }                 // never runs
  print(r);
}`,
  },
  {
    name: 'power-via-loop',
    source: `fn ipow(base: int, e: int) -> int {
  let r = 1;
  for (let i = 0; i < e; i = i + 1) { r *= base; }
  return r;
}
fn main(){ for (let e = 0; e < 8; e = e + 1) { print(ipow(2, e)); print(ipow(3, e)); } }`,
  },
  {
    name: 'float-newton-inline',
    source: `fn sq(x: float) -> float { return x * x; }
fn main(){
  let x = 2.0;
  for (let i = 0; i < 6; i = i + 1) { x = x - (sq(x) - 2.0) / (2.0 * x); }
  print(x); print(sq(x));
}`,
  },
  {
    name: 'boolean-chains',
    source: `fn main(){
  for (let i = 0; i < 16; i = i + 1) {
    let a = (i & 1) != 0;
    let b = (i & 2) != 0;
    let c = (i & 4) != 0;
    print(a && b || c);      // precedence: (a && b) || c
    print(!a || b && !c);    // precedence: (!a) || (b && (!c))
  }
}`,
  },
  {
    name: 'gcd-lcm',
    source: `fn gcd(a: int, b: int) -> int { while (b != 0) { let t = b; b = a % b; a = t; } return a; }
fn lcm(a: int, b: int) -> int { return a / gcd(a, b) * b; }
fn main(){ for (let i = 1; i <= 8; i = i + 1) { print(lcm(i, 12)); } }`,
  },
  {
    name: 'tail-sum',
    source: `fn sum(n: int, acc: int) -> int { if (n == 0) { return acc; } return sum(n - 1, acc + n); }
fn main(){ for (let i = 0; i < 10; i = i + 1) { print(sum(i * 90, 0)); } }`,
  },
  {
    name: 'tail-gcd',
    source: `fn gcd(a: int, b: int) -> int { if (b == 0) { return a; } return gcd(b, a % b); }
fn main(){ for (let i = 1; i <= 12; i = i + 1) { print(gcd(i * 7, 84)); } }`,
  },
  {
    name: 'tail-conditional',
    source: `fn drop2(n: int) -> int {
  if (n <= 0) { return 0; }
  if (n == 1) { return 1; }
  return drop2(n - 2);   // tail self-call from a third path
}
fn main(){ for (let i = 0; i < 12; i = i + 1) { print(drop2(i)); } }`,
  },
  {
    name: 'deep-expression',
    source: `fn main(){
  let x = 3; let y = 5; let z = 7;
  print(((x + y) * (z - x) + (y * z - x * x)) / (x + 1) - (z % (y - x)));
  print((x * y + z) * (x - y + z) - (x + y - z) * (y + z - x));
}`,
  },

  // --- string runtime (literals, concat, ==, indexing, str()/char(), len) ---
  {
    name: 'str-literals-escapes',
    source: `fn main(){
  print("Hello, world!");
  print("tab\\tafter"); print("a\\nb"); print("q=\\" b=\\\\ x=\\x41");
  print(""); print(len(""));
}`,
  },
  {
    name: 'str-concat-eq',
    source: `fn main(){
  let a = "foo"; let b = "bar";
  print(a + b); print("x" + "y" + "z");
  print(a == "foo"); print(a == b); print(a != b);
  print(("a" + "b") == "ab");     // built vs interned literal
  print("" + a == a);
}`,
  },
  {
    name: 'str-conversions',
    source: `fn main(){
  print(str(0)); print(str(42)); print(str(-7));
  print(str(-2147483648)); print(str(2147483647));   // INT_MIN / INT_MAX
  print(str(true)); print(str(false));
  print(char(72) + char(105) + str(33));             // 'H' + 'i' + "33" = "Hi33"
  print(str(1) + str(2) + str(3));
}`,
  },
  {
    name: 'str-index-len',
    source: `fn main(){
  let s = "ABCDE";
  print(len(s));
  for (let i = 0; i < len(s); i = i + 1) { print(s[i]); }
  print(s[0] + s[4]);   // 65 + 69 byte arithmetic
}`,
  },
  {
    name: 'str-reverse',
    source: `fn rev(s: str) -> str {
  let r = "";
  for (let i = len(s) - 1; i >= 0; i = i - 1) { r = r + char(s[i]); }
  return r;
}
fn main(){ print(rev("hello")); print(rev("")); print(rev("a")); print(rev("racecar") == "racecar"); }`,
  },
  {
    name: 'str-fizzbuzz',
    source: `fn main(){
  for (let i = 1; i <= 20; i = i + 1) {
    let s = "";
    if (i % 3 == 0) { s = s + "Fizz"; }
    if (i % 5 == 0) { s = s + "Buzz"; }
    print(s == "" ? str(i) : s);
  }
}`,
  },
  {
    name: 'str-caesar-roundtrip',
    source: `fn shift(s: str, k: int) -> str {
  let out = "";
  for (let i = 0; i < len(s); i = i + 1) {
    let c = s[i];
    if (c >= 97 && c <= 122) { c = (c - 97 + k) % 26 + 97; }
    out = out + char(c);
  }
  return out;
}
fn main(){
  let m = "the quick brown fox";
  let e = shift(m, 13);
  print(e);
  print(shift(e, 13) == m);   // ROT13 is its own inverse
}`,
  },
  {
    name: 'str-recursive-build',
    source: `fn rep(s: str, n: int) -> str { if (n <= 0) { return ""; } return s + rep(s, n - 1); }
fn main(){ let r = rep("ab", 5); print(r); print(len(r)); print(rep("-", 0) == ""); }`,
  },
  {
    name: 'str-param-passthrough',
    source: `fn pick(cond: int, a: str, b: str) -> str { return cond != 0 ? a : b; }
fn main(){
  print(pick(1, "yes", "no"));
  print(pick(0, "yes", "no"));
  print(pick(1, "yes", "no") + "/" + pick(0, "yes", "no"));
}`,
  },
  {
    name: 'str-ordering',
    source: `fn main(){
  print("a" < "b"); print("b" < "a"); print("a" < "a");
  print("ab" < "abc"); print("abc" < "ab");        // prefix ordering
  print("apple" <= "apple"); print("apple" >= "apple");
  print("Zoo" < "apple");                            // 'Z'(90) < 'a'(97)
  print("" < "x"); print("x" > ""); print("" <= "");
}`,
  },
  {
    name: 'str-substr',
    source: `fn main(){
  let s = "Hello, World";
  print(substr(s, 0, 5)); print(substr(s, 7, 5));
  print(substr(s, 7, 100));    // count clamps to end
  print(substr(s, -3, 4));     // start clamps to 0
  print(len(substr(s, 5, -1))); // negative count -> empty
  print(len(substr(s, 100, 5))); // start past end -> empty
}`,
  },
  {
    name: 'str-index-of',
    source: `fn main(){
  let s = "mississippi";
  print(index_of(s, 115)); print(index_of(s, 112)); print(index_of(s, 122));
  print(index_of("", 97)); print(index_of(s, 109));   // 'm' at 0
  print(index_of(s, 321));   // out of byte range -> -1
}`,
  },
  {
    name: 'str-case',
    source: `fn main(){
  print(to_upper("Hello, World 123!"));
  print(to_lower("Hello, World 123!"));
  print(to_upper(to_lower("MiXeD")));
  print(to_lower("Apple") == to_lower("apple"));
  print(len(to_upper("")) == 0);
}`,
  },
  {
    name: 'str-titlecase',
    source: `fn cap(s: str) -> str {
  if (len(s) == 0) { return s; }
  return to_upper(substr(s, 0, 1)) + to_lower(substr(s, 1, len(s) - 1));
}
fn main(){ print(cap("hELLO")); print(cap("world")); print(cap("a")); print(cap("")); }`,
  },
  {
    name: 'do-while-basic',
    source: `fn main(){
  let i = 0;
  do { print(i); i = i + 1; } while (i < 5);
  // body always runs once even when the condition is false up front
  let n = 10;
  do { print(n); n = n + 1; } while (n < 5);
}`,
  },
  {
    name: 'do-while-break-continue',
    source: `fn main(){
  let i = 0;
  do {
    i = i + 1;
    if (i == 3) { continue; }
    if (i == 7) { break; }
    print(i);
  } while (i < 100);
  print(-1); print(i);
}`,
  },
  {
    name: 'switch-basic',
    source: `fn name(d: int) -> str {
  switch (d) {
    case 1: { return "one"; }
    case 2: { return "two"; }
    case 3, 4, 5: { return "many"; }
    default: { return "other"; }
  }
  return "unreachable";
}
fn main(){ for (let i = 0; i < 7; i = i + 1) { print(name(i)); } }`,
  },
  {
    name: 'switch-nodefault-fallthrough',
    source: `fn main(){
  let total = 0;
  for (let i = 0; i < 6; i = i + 1) {
    switch (i % 3) {
      case 0: { total = total + 10; }
      case 1: { total = total + 1; }
    }
    print(total);
  }
}`,
  },
  {
    name: 'switch-expr-labels',
    source: `fn main(){
  for (let i = 0; i < 5; i = i + 1) {
    switch (i) {
      case 1 << 1: { print(100); }   // 2
      case 1 + 2: { print(200); }    // 3
      default: { print(i); }
    }
  }
}`,
  },
  {
    name: 'str-repeat-trim',
    source: `fn main(){
  print(repeat("ab", 3)); print(repeat("x", 0)); print(repeat("-", 1));
  print("[" + trim("   hi  there   ") + "]");
  print("[" + trim("\\t\\n  padded \\r\\n") + "]");
  print("[" + trim("") + "]"); print("[" + trim("noedge") + "]");
  print(len(repeat("abc", 4)));
}`,
  },
  {
    name: 'str-find-contains',
    source: `fn main(){
  print(find("hello world", "world")); print(find("hello", "xyz"));
  print(find("aaaa", "aa")); print(find("abc", ""));
  print(contains("banana", "nan")); print(contains("banana", "xyz"));
  print(starts_with("strata", "str")); print(starts_with("strata", "rat"));
  print(ends_with("compiler", "ler")); print(ends_with("compiler", "lex"));
  print(starts_with("hi", "longer")); print(ends_with("hi", "longer"));
}`,
  },
  {
    name: 'str-replace',
    source: `fn main(){
  print(replace("a.b.c.d", ".", "/"));
  print(replace("aaa", "a", "bb"));
  print(replace("hello", "l", ""));
  print(replace("xyz", "q", "Q"));
  print(replace("ababab", "ab", "X"));
  print(replace("abc", "", "Z"));
  print(replace("the cat sat", "at", "OG"));
}`,
  },
  {
    name: 'str-parse-int',
    source: `fn main(){
  print(parse_int("123")); print(parse_int("-45")); print(parse_int("+7"));
  print(parse_int("  8")); print(parse_int("99abc")); print(parse_int(""));
  print(parse_int("0")); print(parse_int("-0")); print(parse_int("2147483647"));
  // round-trip through str()
  let n = -32768; print(parse_int(str(n)) == n);
}`,
  },
  {
    name: 'str-array-basic',
    source: `fn main(){
  let a = str_array(3);
  print(len(a));
  print("[" + a[0] + "]");          // uninitialized element reads as ""
  a[0] = "alpha"; a[1] = "beta"; a[2] = "gamma";
  for (let i = 0; i < len(a); i = i + 1) { print(a[i]); }
  a[1] = a[0] + "-" + a[2];
  print(a[1]);
}`,
  },
  {
    name: 'str-split-join',
    source: `fn main(){
  let parts = split("a,b,c,d", ",");
  print(len(parts));
  for (let i = 0; i < len(parts); i = i + 1) { print(parts[i]); }
  print(join(parts, "/"));
  print(join(split("one two three", " "), "_"));
  print("[" + join(split(",", ","), "|") + "]");     // ["",""] -> "|"
  print("[" + join(split("trailing,", ","), "|") + "]");
  print(len(split("", ",")));                         // [""] -> 1
  print(join(split("nosep", "X"), "+"));              // ["nosep"]
}`,
  },
  {
    name: 'str-split-words-roundtrip',
    source: `fn rev_words(s: str) -> str {
  let w = split(s, " ");
  let out = str_array(len(w));
  for (let i = 0; i < len(w); i = i + 1) { out[len(w) - 1 - i] = w[i]; }
  return join(out, " ");
}
fn main(){
  print(rev_words("the quick brown fox"));
  print(rev_words("single"));
  print(join(split("a.b.c", "."), "."));   // identity round-trip
}`,
  },
  {
    name: 'if-convert-select',
    source: `fn absdiff(a: int, b: int) -> int { return a > b ? a - b : b - a; }
fn clamp(x: int, lo: int, hi: int) -> int {
  let y = x < lo ? lo : x;          // lowers to a diamond -> select
  return y > hi ? hi : y;
}
fn maxf(a: float, b: float) -> float { return a > b ? a : b; }
fn main(){
  for (let i = -3; i <= 3; i = i + 1) { print(absdiff(i, 0)); print(clamp(i, -1, 1)); }
  print(maxf(2.5, 1.5)); print(maxf(-1.0, -2.0));
  // nested selects
  let s = 0;
  for (let i = 0; i < 10; i = i + 1) { s = s + (i % 2 == 0 ? i : -i); }
  print(s);
}`,
  },
  {
    name: 'str-csv-sum',
    source: `fn main(){
  let row = "10,20,30,40,5";
  let cells = split(row, ",");
  let total = 0;
  for (let i = 0; i < len(cells); i = i + 1) { total = total + parse_int(cells[i]); }
  print(total);
  print(join(cells, " + ") + " = " + str(total));
}`,
  },
];
