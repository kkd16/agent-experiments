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

  // --- 64-bit integers (long / i64) -------------------------------------------
  {
    name: 'long-arith-wrap',
    source: `fn main(){
  let a = 9223372036854775807L; print(a + 1L);   // wraps to INT64_MIN
  print(-9223372036854775808L - 1L);             // wraps to INT64_MAX
  let big = 3037000500L; print(big * big);        // squares just past 2^63 -> wraps
  print(1000000000000L * 1000000000000L);         // 1e24 wraps mod 2^64
  print(0L - 1L); print(-0L);
}`,
  },
  {
    name: 'long-div-rem',
    source: `fn main(){
  print(-7L / 2L); print(7L / -2L); print(-7L / -2L);
  print(-7L % 2L); print(7L % -2L); print(-7L % -2L);
  print(9223372036854775807L / 3L);
  print(-9223372036854775808L / 2L);
  print(-9223372036854775808L % 7L);
}`,
  },
  {
    name: 'long-shift-bitwise',
    source: `fn main(){
  print(1L << 62L); print(1L << 63L); print(1L << 64L);  // count masks to 6 bits: 64 -> 0
  print(-1L >> 1L); print(-8L >> 2L); print(255L >> 9L);
  print(7L & 5L); print(7L | 8L); print(6L ^ 3L); print(~0L); print(~1L);
  print(-1L >> 63L);                                       // arithmetic shift -> -1
  print(0xFFFFFFFFFFFFFFFFL); print(0x7FFFFFFFFFFFFFFFL);  // -1 and INT64_MAX
}`,
  },
  {
    name: 'long-conversions',
    source: `fn main(){
  print(long(5)); print(long(-7)); print(long(true)); print(long(false));
  print(int(9223372036854775807L));   // wrap low 32 bits -> -1
  print(int(4294967296L));            // 2^32 wraps -> 0
  print(int(-1L));
  print(float(9007199254740993L));    // 2^53+1 rounds to 2^53 in f64
  print(long(3.9)); print(long(-3.9)); print(long(2.0));
  print(long(1.0e18));                // in range, exact-integer f64
  print(long(9.0e18) > 0L);
}`,
  },
  {
    name: 'long-str',
    source: `fn main(){
  print(str(0L)); print(str(42L)); print(str(-7L));
  print(str(9223372036854775807L)); print(str(-9223372036854775808L));   // MAX / MIN
  print("h=" + str(1099511628211L));
  let line = "";
  for (let i = 1; i <= 5; i = i + 1) { line = line + str(long(i) * 1000000000L) + " "; }
  print(line);
}`,
  },
  {
    name: 'long-fnv1a',
    source: `fn fnv1a(s: str) -> long {
  let h = -3750763034362895579L;          // 14695981039346656037 (offset basis) as signed i64
  for (let i = 0; i < len(s); i = i + 1) {
    h = h ^ long(s[i]);
    h = h * 1099511628211L;                // FNV-1a 64-bit prime; multiply wraps mod 2^64
  }
  return h;
}
fn main(){
  print(fnv1a("")); print(fnv1a("a")); print(fnv1a("hello"));
  print(fnv1a("The quick brown fox jumps over the lazy dog"));
  print(fnv1a("hello") == fnv1a("hello"));
}`,
  },
  {
    name: 'long-xorshift',
    source: `fn main(){
  let x = 88172645463325252L;
  for (let i = 0; i < 8; i = i + 1) {
    x = x ^ (x << 13L);
    x = x ^ (x >> 7L);
    x = x ^ (x << 17L);
    print(x);
  }
}`,
  },
  {
    name: 'long-factorial',
    source: `fn fact(n: int) -> long {
  let r = 1L;
  for (let i = 2; i <= n; i = i + 1) { r = r * long(i); }
  return r;
}
fn main(){ for (let i = 0; i <= 20; i = i + 1) { print(fact(i)); } }`,
  },
  {
    name: 'long-array',
    source: `fn main(){
  let n = 7; let a = long_array(n);
  print(len(a)); print(a[0]);                 // uninitialized -> 0
  a[0] = 1L;
  for (let i = 1; i < n; i = i + 1) { a[i] = a[i - 1] * 1000000000L; }   // wraps
  let s = 0L;
  for (let i = 0; i < n; i = i + 1) { print(a[i]); s = s + a[i]; }
  print(s);
}`,
  },
  {
    name: 'long-mixed-int',
    source: `fn main(){
  let i = 1000000;
  print(i * i);                  // i32 multiply wraps
  print(long(i) * long(i));      // exact 1e12 in i64
  let big = 9223372036854775807L;
  print(int(big)); print(big > 0L); print(long(int(big)));
  for (let k = 0; k < 5; k = k + 1) { print(long(k) * long(k) * long(k)); }
}`,
  },
  {
    name: 'long-strength-reduce',
    source: `fn f(x: long) -> long { return x * 8L + x * 1024L + 2L * x; }
fn main(){ for (let i = -3; i < 4; i = i + 1) { print(f(long(i))); } }`,
  },
  {
    name: 'long-select',
    source: `fn maxl(a: long, b: long) -> long { return a > b ? a : b; }
fn absl(x: long) -> long { return x < 0L ? 0L - x : x; }    // lowers to a diamond -> select
fn main(){
  print(maxl(5L, 9L)); print(maxl(-3L, -7L));
  print(absl(-9223372036854775807L)); print(absl(42L));
  let s = 0L;
  for (let i = 0; i < 10; i = i + 1) { s = s + (i % 2 == 0 ? long(i) : 0L - long(i)); }
  print(s);
}`,
  },
  {
    name: 'long-global-prng',
    source: `let seed: long = 88172645463325252L;
let prime: long = 6364136223846793005L;
fn next() -> long { seed = seed * prime + 1442695040888963407L; return seed; }
fn main(){ for (let i = 0; i < 6; i = i + 1) { print(next()); } }`,
  },
  {
    name: 'long-tail-sum',
    source: `fn sum(n: long, acc: long) -> long { if (n == 0L) { return acc; } return sum(n - 1L, acc + n); }
fn main(){ for (let i = 0L; i < 10L; i = i + 1L) { print(sum(i * 90L, 0L)); } }`,
  },

  // --- bit-manipulation primitives (popcount / clz / ctz / rotl / rotr) -------
  {
    name: 'bitops-i32',
    source: `fn main(){
  print(popcount(0)); print(popcount(255)); print(popcount(-1)); print(popcount(0x55555555));
  print(clz(1)); print(clz(0)); print(clz(-1)); print(clz(0x00010000));
  print(ctz(1)); print(ctz(0)); print(ctz(8)); print(ctz(-2147483648));
  print(rotl(1, 0)); print(rotl(1, 1)); print(rotl(1, 31)); print(rotl(1, 32)); print(rotl(-2147483648, 1));
  print(rotr(1, 1)); print(rotr(1, 0)); print(rotr(2, 1)); print(rotr(1, 33));
}`,
  },
  {
    name: 'bitops-i64',
    source: `fn main(){
  print(popcount(0L)); print(popcount(-1L)); print(popcount(0xFFFFFFFFL)); print(popcount(0x5555555555555555L));
  print(clz(1L)); print(clz(0L)); print(clz(-1L)); print(clz(0x0000000100000000L));
  print(ctz(1L)); print(ctz(0L)); print(ctz(256L)); print(ctz(-9223372036854775808L));
  print(rotl(1L, 0L)); print(rotl(1L, 1L)); print(rotl(1L, 63L)); print(rotl(1L, 64L)); print(rotl(1L, 65L));
  print(rotr(1L, 1L)); print(rotr(2L, 1L)); print(rotr(0x8000000000000000L, 63L));
}`,
  },
  {
    name: 'bitops-mix',
    source: `fn mix(h: long, k: long) -> long {
  let x = k * -75363745605771443L;       // 0xFF51AFD7ED558CCD
  x = rotl(x, 31L);
  x = x * -4417276706812531889L;          // 0xC4CEB9FE1A85EC53
  return rotl(h ^ x, 27L) * 5L + 1390208809L;
}
fn main(){
  let h = 0L;
  for (let i = 1; i <= 8; i = i + 1) { h = mix(h, long(i)); print(h); }
  print(popcount(h)); print(clz(h)); print(ctz(h | 1L));
  // hoist a loop-invariant rotate out of the loop, and CSE repeated ones
  let acc = 0;
  for (let i = 0; i < 12; i = i + 1) { acc = acc + rotl(0x01020304, 8) + popcount(i); }
  print(acc);
}`,
  },

  // --- structs (aggregate types) -------------------------------------------
  {
    name: 'struct-basic',
    source: `struct Point { x: int; y: int; }
fn main(){
  let p = Point(3, 4);
  print(p.x); print(p.y);
  p.x = 10; p.y += 5;          // store + compound-store into a field
  print(p.x); print(p.y);
  print(p.x * p.x + p.y * p.y);
}`,
  },
  {
    name: 'struct-mixed-fields',
    source: `struct Mix { i: int; l: long; f: float; b: bool; s: str; }
fn main(){
  let m = Mix(7, 9000000000L, 2.5, true, "hi");
  print(m.i); print(m.l); print(m.f); print(m.b); print(m.s);
  m.l = m.l * 2L; m.f = m.f * 4.0; m.b = !m.b; m.s = m.s + "!";
  print(m.l); print(m.f); print(m.b); print(m.s);
}`,
  },
  {
    name: 'struct-by-handle',
    source: `struct V { x: int; y: int; z: int; }
fn dot(a: V, b: V) -> int { return a.x*b.x + a.y*b.y + a.z*b.z; }
fn bump(v: V) { v.x += 1; v.y += 1; v.z += 1; }   // mutates the caller's struct
fn main(){
  let a = V(1, 2, 3);
  let b = V(4, 5, 6);
  print(dot(a, b));
  bump(a);
  print(a.x); print(a.y); print(a.z);
  print(dot(a, b));
}`,
  },
  {
    name: 'struct-alias',
    source: `struct Box { v: int; }
fn main(){
  let a = Box(5);
  let b = a;                 // alias — same handle
  b.v = 99;
  print(a.v);                // sees the mutation
  print(a == b);             // true (same object)
  let c = Box(99);
  print(a == c);             // false (distinct allocations, equal contents)
  print(a != c);
}`,
  },
  {
    name: 'struct-nested',
    source: `struct D { v: int; }
struct C { d: D; }
struct B { c: C; }
struct A { b: B; tag: int; }
fn main(){
  let a = A(B(C(D(1))), 100);
  print(a.b.c.d.v); print(a.tag);
  a.b.c.d.v = 42;
  print(a.b.c.d.v);
  let d = a.b.c.d;           // alias the innermost struct
  d.v = d.v + 1;
  print(a.b.c.d.v);          // 43, seen through the chain
}`,
  },
  {
    name: 'struct-linked-list',
    source: `struct Node { value: int; next: Node; }
fn cons(v: int, rest: Node) -> Node { return Node(v, rest); }
fn sumList(n: Node) -> int {
  let s = 0; let cur = n;
  while (cur != null) { s = s + cur.value; cur = cur.next; }
  return s;
}
fn length(n: Node) -> int {
  if (n == null) { return 0; }
  return 1 + length(n.next);
}
fn main(){
  let l = cons(1, cons(2, cons(3, cons(4, cons(5, null)))));
  print(sumList(l));
  print(length(l));
  // reverse in place
  let prev: Node = null; let cur = l;
  while (cur != null) { let nx = cur.next; cur.next = prev; prev = cur; cur = nx; }
  print(sumList(prev));
  print(prev.value);          // 5 — old tail is the new head
}`,
  },
  {
    name: 'struct-bst-sort',
    source: `struct Tree { v: int; left: Tree; right: Tree; }
fn insert(t: Tree, v: int) -> Tree {
  if (t == null) { return Tree(v, null, null); }
  if (v < t.v) { t.left = insert(t.left, v); } else { t.right = insert(t.right, v); }
  return t;
}
fn walk(t: Tree) {
  if (t == null) { return; }
  walk(t.left); print(t.v); walk(t.right);
}
fn main(){
  let root: Tree = null;
  let seed = 12345;
  for (let i = 0; i < 20; i = i + 1) {
    seed = (seed * 1103515245 + 12345) & 2147483647;
    root = insert(root, seed % 100);
  }
  walk(root);                 // ascending (duplicates go right)
}`,
  },
  {
    name: 'struct-array-field',
    source: `struct Buf { data: int[]; len: int; cap: int; }
fn push(b: Buf, v: int) { b.data[b.len] = v; b.len += 1; }
fn main(){
  let b = Buf(int_array(8), 0, 8);
  for (let i = 0; i < 8; i = i + 1) { push(b, i * i); }
  let s = 0;
  for (let i = 0; i < b.len; i = i + 1) { s = s + b.data[i]; }
  print(s); print(b.len); print(b.data[3]);
}`,
  },
  {
    name: 'struct-alloc-loop',
    source: `struct Acc { sum: long; count: int; }
fn main(){
  // Thousands of allocations exercise the bump allocator; the optimizer must
  // keep loads/stores ordered around each construction.
  let a = Acc(0L, 0);
  for (let i = 0; i < 2000; i = i + 1) {
    let p = Acc(long(i), i);          // fresh handle every iteration
    a.sum = a.sum + p.sum;
    a.count = a.count + 1;
  }
  print(a.sum); print(a.count);
}`,
  },
  {
    name: 'struct-global-null',
    source: `struct Node { v: int; next: Node; }
let head: Node = null;        // struct-typed global, initialised null
fn main(){
  print(head == null);
  head = Node(1, Node(2, Node(3, null)));
  let s = 0; let c = head;
  while (c != null) { s = s + c.v; c = c.next; }
  print(s);
  print(head.next.v);          // 2
}`,
  },
  {
    name: 'struct-array',
    source: `struct P { x: int; y: int; }
fn main(){
  let a: P[] = struct_array(4);
  print(a[0] == null);          // zero-filled → null
  for (let i = 0; i < 4; i = i + 1) { a[i] = P(i, i * i); }
  let s = 0;
  for (let i = 0; i < len(a); i = i + 1) { s = s + a[i].x + a[i].y; }
  print(s);
  a[2].x = 100;                  // mutate a struct held in the array
  print(a[2].x); print(a[2].y);
}`,
  },
  {
    name: 'struct-array-sort',
    source: `struct Item { key: int; tag: int; }
fn main(){
  let n = 7;
  let a: Item[] = struct_array(n);
  let seed = 99;
  for (let i = 0; i < n; i = i + 1) {
    seed = (seed * 1103515245 + 12345) & 2147483647;
    a[i] = Item(seed % 50, i);
  }
  // bubble sort by key, swapping handles (not contents)
  for (let i = 0; i < n; i = i + 1) {
    for (let j = 0; j < n - 1 - i; j = j + 1) {
      if (a[j].key > a[j + 1].key) { let t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; }
    }
  }
  for (let i = 0; i < n; i = i + 1) { print(a[i].key); print(a[i].tag); }
}`,
  },
  {
    name: 'struct-array-in-struct',
    source: `struct P { v: int; }
struct Pool { slots: P[]; count: int; }
fn main(){
  let pool = Pool(struct_array(6), 0);
  for (let i = 0; i < 6; i = i + 1) { pool.slots[i] = P(i * 10); pool.count += 1; }
  let s = 0;
  for (let i = 0; i < pool.count; i = i + 1) { s = s + pool.slots[i].v; }
  print(s); print(pool.slots[4].v); print(pool.count);
}`,
  },
  {
    name: 'float-math-lib',
    source: `fn main(){
  print(sqrt(2.0)); print(sqrt(16.0)); print(sqrt(0.0)); print(sqrt(-1.0));
  print(floor(2.7)); print(floor(-2.1)); print(ceil(2.1)); print(ceil(-2.7));
  print(trunc(2.9)); print(trunc(-2.9));
  print(abs(-3.5)); print(abs(3.5));
  print(fmin(1.5, -2.0)); print(fmax(1.5, -2.0));
  print(copysign(3.0, -1.0)); print(copysign(-3.0, 1.0));
}`,
  },
  {
    name: 'float-round-ties-even',
    source: `fn main(){
  // wasm f64.nearest rounds halves to even
  print(round(0.5)); print(round(1.5)); print(round(2.5)); print(round(3.5));
  print(round(-0.5)); print(round(-1.5)); print(round(-2.5));
  print(round(2.4)); print(round(2.6)); print(round(-2.4)); print(round(-2.6));
  print(round(1000000.5));
}`,
  },
  {
    name: 'float-builtins-overridable',
    source: `// A user function named sqrt shadows the soft builtin entirely.
fn sqrt(x: float) -> float { return x + 1.0; }
fn main(){ print(sqrt(10.0)); print(floor(9.9)); }`,
  },
  {
    name: 'float-to-str-basic',
    source: `fn main(){
  print(str(0.0)); print(str(1.0)); print(str(-1.0)); print(str(0.5));
  print(str(0.1)); print(str(0.2)); print(str(0.3)); print(str(1.5));
  print(str(3.14159)); print(str(2.718281828459045));
  print(str(100.0)); print(str(1000000.0)); print(str(0.001));
  print(str(123.456)); print(str(-0.0));
}`,
  },
  {
    name: 'float-to-str-notation',
    source: `fn main(){
  // boundaries between fixed and exponential ECMAScript notation
  print(str(1.0e21)); print(str(1.0e-7)); print(str(5.0e-7)); print(str(1.0e-6));
  print(str(1.0e20)); print(str(1.0e22)); print(str(123456789.0));
  print(str(0.0001)); print(str(0.00001)); print(str(0.000001)); print(str(0.0000001));
  print(str(6.022e23)); print(str(1.0e308)); print(str(1.0e-308));
}`,
  },
  {
    name: 'float-to-str-computed',
    source: `// Values produced by arithmetic (not literals) round-tripped through str().
fn main(){
  let s = 0.0;
  for (let i = 1; i <= 6; i = i + 1) { s = s + 1.0 / float(i); }
  print(str(s));                       // harmonic sum
  print(str(sqrt(2.0)));
  print(str(1.0 / 3.0));
  print(str(0.1 + 0.2));               // the classic 0.30000000000000004
  print("pi ~ " + str(3.141592653589793));
  print(str(float(9999999) / 1000.0));
}`,
  },
  {
    name: 'float-to-str-extremes',
    source: `fn main(){
  print(str(1.0 / 0.0));               // inf
  print(str(-1.0 / 0.0));              // -inf
  print(str(0.0 / 0.0));               // nan
  print(str(4.9e-324));                // smallest subnormal
  print(str(1.7976931348623157e308));  // max double
  print(str(9007199254740993.0));      // 2^53 + 1 (not representable -> nearest)
}`,
  },
  {
    name: 'parse-float-basic',
    source: `fn main(){
  print(str(parse_float("0"))); print(str(parse_float("1")));
  print(str(parse_float("-1"))); print(str(parse_float("3.14159")));
  print(str(parse_float("0.1"))); print(str(parse_float("0.5")));
  print(str(parse_float("100"))); print(str(parse_float("-2.5")));
  print(str(parse_float("123.456"))); print(str(parse_float("+7")));
  print(str(parse_float("")));        // -> 0
  print(str(parse_float("abc")));     // -> 0
}`,
  },
  {
    name: 'parse-float-exponent',
    source: `fn main(){
  print(str(parse_float("1e10"))); print(str(parse_float("1e-10")));
  print(str(parse_float("6.022e23"))); print(str(parse_float("1.5E3")));
  print(str(parse_float("1e308"))); print(str(parse_float("1e-308")));
  print(str(parse_float("5e-324")));       // smallest subnormal
  print(str(parse_float("2e400")));        // overflow -> inf
  print(str(parse_float("1e-400")));       // underflow -> 0
  print(str(parse_float("-3.5e-7")));
}`,
  },
  {
    name: 'parse-float-roundtrip',
    source: `// str() then parse_float() must recover the exact same double (bit-identical),
// so re-formatting the parsed value reproduces the string.
fn main(){
  print(str(parse_float(str(0.1 + 0.2))));
  print(str(parse_float(str(1.0 / 3.0))));
  print(str(parse_float(str(sqrt(2.0)))));
  print(str(parse_float("0.30000000000000004") == 0.1 + 0.2));
  print(str(parse_float("1234.5678") * 2.0));
  // partial-prefix scanning (stops at the first invalid character)
  print(str(parse_float("12.5xyz"))); print(str(parse_float("3.1.4")));
}`,
  },
  {
    name: 'float-reduce-loop',
    source: `// Exercise the f64 ops through a loop the optimizer rewrites (LICM / stackify).
fn main(){
  let acc = 0.0;
  for (let i = 1; i <= 8; i = i + 1) {
    acc = acc + sqrt(float(i)) * fmin(2.0, float(i));
  }
  print(floor(acc)); print(ceil(acc));
}`,
  },
  // --- transcendental math library (the shared MATH_PRELUDE kernel) -----------
  // The wasm backend compiles the kernel and the interpreter runs the same
  // source, so the printed doubles must agree bit-for-bit at every opt level.
  {
    name: 'math-transcendentals',
    source: `fn main(){
  print(str(exp(1.0))); print(str(ln(10.0))); print(str(log2(1024.0)));
  print(str(log10(1000.0))); print(str(sin(1.0))); print(str(cos(1.0)));
  print(str(tan(0.5))); print(str(atan(1.0))); print(str(asin(0.5)));
  print(str(acos(0.5))); print(str(cbrt(27.0))); print(str(pow(2.0, 10.0)));
  print(str(sinh(1.0))); print(str(cosh(1.0))); print(str(tanh(1.0)));
  print(str(expm1(1.0e-6))); print(str(log1p(1.0e-6)));
  print(str(hypot(3.0, 4.0))); print(str(atan2(1.0, 1.0))); print(str(fmod(10.5, 3.0)));
}`,
  },
  {
    name: 'math-identities',
    source: `// Identities that must hold to rounding, computed identically on both backends.
fn main(){
  for (let i = 0; i < 8; i = i + 1) {
    let x = float(i) * 0.7 - 2.0;
    print(str(sin(x) * sin(x) + cos(x) * cos(x)));     // ~1
    print(str(cosh(x) * cosh(x) - sinh(x) * sinh(x))); // ~1
    print(str(ln(exp(x))));                            // ~x
  }
}`,
  },
  {
    name: 'math-pow-branches',
    source: `// pow special cases: integer vs fractional exponents of a negative base.
fn main(){
  print(str(pow(-2.0, 3.0)));   // -8
  print(str(pow(-2.0, 2.0)));   //  4
  print(str(pow(-8.0, 2.0)));   // 64
  print(str(pow(9.0, 0.5)));    //  3
  print(str(pow(2.0, -3.0)));   // 0.125
  print(str(pow(5.0, 0.0)));    //  1
  print(str(pow(-2.0, 0.5) != pow(-2.0, 0.5)));  // NaN != NaN -> true
}`,
  },
  {
    name: 'math-loop-array',
    source: `// Math through a float[] and a loop (LICM / stackifier stress), then a sum.
fn main(){
  let n = 12;
  let xs = float_array(n);
  let s = 0.0;
  for (let i = 0; i < n; i = i + 1) {
    let t = float(i) * 0.5;
    xs[i] = exp(0.0 - t) * sin(t * 3.0);
    s = s + xs[i];
  }
  for (let i = 0; i < n; i = i + 1) { print(str(xs[i])); }
  print(str(s));
}`,
  },
  // --- f32 (single-precision) end to end --------------------------------------
  // The interpreter models f32 as a Math.fround-rounded number; the wasm backend
  // uses the f32 opcodes. The printed (promoted-to-f64) values must agree.
  {
    name: 'f32-arithmetic',
    source: `fn main(){
  let a = f32(0.1);
  let b = f32(0.2);
  print(str(a + b));                 // f32 rounding: 0.30000001192092896
  print(str(a - b)); print(str(a * b)); print(str(f32(1.0) / f32(3.0)));
  print(str(f32(0.0) - a));          // negate stays f32 (strict: no f64/f32 mixing)
  print(str(float(a)));              // promote: 0.10000000149011612
}`,
  },
  {
    name: 'f32-conversions',
    source: `fn main(){
  print(str(f32(16777217)));        // 2^24+1 not representable -> 16777216
  print(str(f32(123456789)));       // int -> f32 (rounds)
  print(str(f32(123456789L)));      // long -> f32
  print(str(int(f32(3.999))));      // 3 (truncates)
  print(str(long(f32(1.0e15))));    // f32 then trunc to i64
  print(str(float(f32(3.1415927)))); // demote then promote
  print(str(f32(true)));            // bool -> f32 (1.0)
}`,
  },
  {
    name: 'f32-array-sum',
    source: `// A harmonic sum accumulated entirely in single precision.
fn main(){
  let n = 12;
  let xs = f32_array(n);
  for (let i = 0; i < n; i = i + 1) { xs[i] = f32(1.0) / f32(i + 1); }
  let s = f32(0.0);
  for (let i = 0; i < n; i = i + 1) { s = s + xs[i]; }
  print(str(s));
  for (let i = 0; i < n; i = i + 1) { print(str(xs[i])); }
}`,
  },
  {
    name: 'f32-struct-dot',
    source: `// f32 struct fields (4-byte) + a function returning f32.
struct Vec3 { x: f32; y: f32; z: f32; }
fn dot(a: Vec3, b: Vec3) -> f32 { return a.x * b.x + a.y * b.y + a.z * b.z; }
fn main(){
  let a = Vec3(f32(1.5), f32(2.5), f32(3.5));
  let b = Vec3(f32(0.5), f32(1.0), f32(2.0));
  print(str(dot(a, b)));
  a.x = a.x + f32(10.0);
  print(str(a.x)); print(str(a.y)); print(str(a.z));
}`,
  },
  {
    name: 'f32-compare',
    source: `fn main(){
  print(f32(0.1) + f32(0.2) == f32(0.3));  // false — single-precision rounding
  print(f32(0.5) < f32(0.6));
  print(f32(1.0) / f32(3.0) > f32(0.33));
  print(f32(2.0) == f32(2.0));
  // f32 vs f64 disagree on representability of 0.1
  print(float(f32(0.1)) == 0.1);           // false
}`,
  },
  {
    name: 'math-user-shadow-isolation',
    source: `// A user 'fn sqrt' shadows the builtin in user code, but the MATH_PRELUDE
// kernels keep using the NATIVE sqrt internally — so hypot is still 5.0 even
// though the user's sqrt doubles its argument. Both backends must agree.
fn sqrt(x: float) -> float { return x * 2.0; }
fn main(){
  print(str(sqrt(2.0)));        // user's: 4.0
  print(str(hypot(3.0, 4.0)));  // native kernel sqrt: 5.0
  print(str(cbrt(64.0)));       // native kernel sqrt unaffected: 4.0
  print(str(asin(0.5)));        // uses native sqrt inside
}`,
  },

  // ----- function pointers / first-class functions -----
  {
    name: 'fnptr-higher-order-apply',
    source: `fn inc(x: int) -> int { return x + 1; }
fn dbl(x: int) -> int { return x * 2; }
fn apply(g: fn(int) -> int, x: int) -> int { return g(x); }
fn main(){
  print(apply(inc, 10));     // 11
  print(apply(dbl, 10));     // 20
  let f = inc;               // a bare function name decays to a pointer
  print(f(41));              // 42 (indirect call through a local)
  print(apply(f, 5));        // 6
}`,
  },
  {
    name: 'fnptr-return-and-curry',
    source: `fn add(a: int, b: int) -> int { return a + b; }
fn sub(a: int, b: int) -> int { return a - b; }
fn pick(which: int) -> fn(int, int) -> int {
  if (which == 0) { return add; }
  return sub;
}
fn main(){
  print(pick(0)(3, 4));      // 7  (call applied to a call's result)
  print(pick(1)(10, 3));     // 7
  let op = pick(0);
  print(op(100, 1));         // 101
}`,
  },
  {
    name: 'fnptr-comparator-sort',
    source: `fn asc(a: int, b: int) -> bool { return a < b; }
fn desc(a: int, b: int) -> bool { return a > b; }
fn sort(xs: int[], less: fn(int, int) -> bool) {
  let n = len(xs);
  let i = 1;
  while (i < n) {
    let key = xs[i];
    let j = i - 1;
    while (j >= 0 && less(key, xs[j])) { xs[j + 1] = xs[j]; j = j - 1; }
    xs[j + 1] = key;
    i = i + 1;
  }
}
fn show(xs: int[]) { let i = 0; while (i < len(xs)) { print(xs[i]); i = i + 1; } }
fn main(){
  let a = int_array(6);
  a[0]=3; a[1]=1; a[2]=4; a[3]=1; a[4]=5; a[5]=9;
  sort(a, asc); show(a);
  sort(a, desc); show(a);
}`,
  },
  {
    name: 'fnptr-map-reduce',
    source: `fn sq(x: int) -> int { return x * x; }
fn addup(a: int, b: int) -> int { return a + b; }
fn mymap(xs: int[], g: fn(int) -> int) -> int[] {
  let out = int_array(len(xs));
  let i = 0;
  while (i < len(xs)) { out[i] = g(xs[i]); i = i + 1; }
  return out;
}
fn reduce(xs: int[], g: fn(int, int) -> int, acc: int) -> int {
  let i = 0;
  while (i < len(xs)) { acc = g(acc, xs[i]); i = i + 1; }
  return acc;
}
fn main(){
  let a = int_array(4);
  a[0]=1; a[1]=2; a[2]=3; a[3]=4;
  let b = mymap(a, sq);
  print(reduce(b, addup, 0));   // 1+4+9+16 = 30
  print(b[3]);                  // 16
}`,
  },
  {
    name: 'fnptr-struct-vtable',
    source: `struct Calc { op: fn(int, int) -> int; name: str; }
fn addi(a: int, b: int) -> int { return a + b; }
fn muli(a: int, b: int) -> int { return a * b; }
fn run(c: Calc, x: int, y: int) -> int { return c.op(x, y); }
fn main(){
  let plus = Calc(addi, "plus");
  let times = Calc(muli, "times");
  print(run(plus, 6, 7));    // 13
  print(run(times, 6, 7));   // 42
  print(plus.name);
  print(plus.op(2, 3));      // 5  (member.fn(...) indirect call)
}`,
  },
  {
    name: 'fnptr-identity',
    source: `fn a1(x: int) -> int { return x; }
fn a2(x: int) -> int { return x + 0; }
fn main(){
  let p = a1; let q = a1; let r = a2;
  print(p == q);   // true  — same function
  print(p == r);   // false — distinct functions
  print(p != r);   // true
}`,
  },
  {
    name: 'fnptr-devirtualize',
    source: `fn tw(x: int) -> int { return x * 3; }
fn main(){
  let g = tw;          // a funcaddr in a local: devirtualization fires at -O1+
  print(g(14));        // 42 at every optimization level
  print(tw(10));       // 30
}`,
  },
  {
    name: 'fnptr-mixed-types',
    source: `fn slen(s: str) -> int { return len(s); }
fn choose(b: bool) -> fn(str) -> int { return slen; }
fn lmul(a: long, b: long) -> long { return a * b; }
fn fadd(a: float, b: float) -> float { return a + b; }
fn main(){
  let f = choose(true);
  print(f("hello"));                       // 5
  let g = lmul;
  print(str(g(1000000000L, 1000000000L))); // 1000000000000000000
  let h = fadd;
  print(str(h(0.1, 0.2)));                 // 0.30000000000000004
}`,
  },
  {
    name: 'fnptr-recursive-hof',
    source: `// A self-recursive higher-order fold: the optimizer can never inline it, so its
// indirect call survives at every level (the comparator is a runtime value).
fn addup(a: int, b: int) -> int { return a + b; }
fn maxi(a: int, b: int) -> int { return a > b ? a : b; }
fn foldl(xs: int[], i: int, g: fn(int, int) -> int, acc: int) -> int {
  if (i >= len(xs)) { return acc; }
  return foldl(xs, i + 1, g, g(acc, xs[i]));
}
fn main(){
  let a = int_array(5);
  a[0]=3; a[1]=1; a[2]=4; a[3]=1; a[4]=5;
  print(foldl(a, 0, addup, 0));            // 14
  print(foldl(a, 0, maxi, -2147483648));   // 5
}`,
  },
  {
    name: 'fnptr-compose',
    source: `fn compose(f: fn(int) -> int, g: fn(int) -> int, x: int) -> int { return f(g(x)); }
fn inc(x: int) -> int { return x + 1; }
fn neg(x: int) -> int { return 0 - x; }
fn main(){
  print(compose(inc, neg, 5));   // inc(neg(5)) = -4
  print(compose(neg, inc, 5));   // neg(inc(5)) = -6
}`,
  },
  // ----- arrays of function pointers (jump tables / state machines) -----
  {
    name: 'fnarr-jump-table',
    source: `fn fadd(a: int, b: int) -> int { return a + b; }
fn fsub(a: int, b: int) -> int { return a - b; }
fn fmul(a: int, b: int) -> int { return a * b; }
fn fdiv(a: int, b: int) -> int { return b == 0 ? 0 : a / b; }
fn main(){
  let ops: (fn(int, int) -> int)[] = fn_array(4);
  ops[0] = fadd; ops[1] = fsub; ops[2] = fmul; ops[3] = fdiv;
  let i = 0;
  while (i < 4) { print(ops[i](12, 4)); i = i + 1; }   // 16 8 48 3
}`,
  },
  {
    name: 'fnarr-null-sentinel',
    source: `// A fresh fn_array element is the "no function" value (null); the wasm engine
// traps if it is called, but it can be *observed* with == null without trapping.
fn hello() -> int { return 1; }
fn main(){
  let t: (fn() -> int)[] = fn_array(3);
  t[1] = hello;                 // slots 0 and 2 stay null
  let i = 0;
  while (i < 3) {
    if (t[i] == null) { print(-1); } else { print(t[i]()); }
    i = i + 1;
  }                             // -1 1 -1
  t[1] = null;                  // a function pointer can be cleared back to null
  print(t[1] == null);          // true
  print(hello == null);         // false — a real pointer is never null
}`,
  },
  {
    name: 'fnarr-state-machine',
    source: `// A finite-state machine: each state is a function in a table that prints its
// id and returns the next state's index. Dispatch is a pure table indexing.
fn s_red() -> int { print(0); return 1; }
fn s_green() -> int { print(1); return 2; }
fn s_yellow() -> int { print(2); return 0; }
fn main(){
  let states: (fn() -> int)[] = fn_array(3);
  states[0] = s_red; states[1] = s_green; states[2] = s_yellow;
  let st = 0; let steps = 0;
  while (steps < 7) { st = states[st](); steps = steps + 1; }  // 0 1 2 0 1 2 0
  print(99);
}`,
  },
  {
    name: 'fnarr-reassign-identity',
    source: `fn a() -> int { return 10; }
fn b() -> int { return 20; }
fn main(){
  let t: (fn() -> int)[] = fn_array(2);
  t[0] = a; t[1] = a;
  print(t[0] == t[1]);   // true  — same target
  t[1] = b;
  print(t[0] == t[1]);   // false
  print(t[0]());          // 10
  print(t[1]());          // 20
  let p = t[0];           // load a table slot into a local function pointer
  print(p == a);          // true
  print(p());             // 10
}`,
  },
  {
    name: 'fnarr-mixed-sigs',
    source: `fn pa(x: int) { print(x); }
fn pb(x: int) { print(x * x); }
fn slen(s: str) -> int { return len(s); }
fn lsum(a: long, b: long) -> long { return a + b; }
fn main(){
  let actions: (fn(int))[] = fn_array(2);   // array of void-returning actions
  actions[0] = pa; actions[1] = pb;
  actions[0](7);                 // 7
  actions[1](7);                 // 49
  let measures: (fn(str) -> int)[] = fn_array(1);
  measures[0] = slen;
  print(measures[0]("strata"));  // 6
  let acc: (fn(long, long) -> long)[] = fn_array(1);
  acc[0] = lsum;
  print(str(acc[0](2L, 40L)));   // 42
}`,
  },
  {
    name: 'fnarr-grammar-distinction',
    source: `// 'fn(int) -> int[]' returns an int[]; '(fn(int) -> int)[]' is an array OF
// function pointers — the grouping parens disambiguate.
fn evens(n: int) -> int[] {
  let a = int_array(n); let i = 0;
  while (i < n) { a[i] = i * 2; i = i + 1; }
  return a;
}
fn inc(x: int) -> int { return x + 1; }
fn dec(x: int) -> int { return x - 1; }
fn main(){
  let e = evens(4);
  print(e[3]);                              // 6
  let fns: (fn(int) -> int)[] = fn_array(2);
  fns[0] = inc; fns[1] = dec;
  print(fns[0](fns[1](10)));                // inc(dec(10)) = 10
}`,
  },
  {
    name: 'fnarr-runtime-dispatch',
    source: `// The table is built in a callee and returned, then indexed by a loop variable —
// so the optimizer can never devirtualize the call (the target is data).
fn k0(x: int) -> int { return x + 100; }
fn k1(x: int) -> int { return x + 200; }
fn k2(x: int) -> int { return x + 300; }
fn build() -> (fn(int) -> int)[] {
  let t: (fn(int) -> int)[] = fn_array(3);
  t[0] = k0; t[1] = k1; t[2] = k2;
  return t;
}
fn main(){
  let t = build();
  let i = 0; let acc = 0;
  while (i < 3) { acc = acc + t[i](i); i = i + 1; }
  print(acc);   // 100 + 201 + 302 = 603
}`,
  },
  {
    name: 'fnarr-as-param',
    source: `// A function-pointer array passed as a parameter, with a null-guarded dispatch.
fn op_add(a: int, b: int) -> int { return a + b; }
fn op_max(a: int, b: int) -> int { return a > b ? a : b; }
fn dispatch(tbl: (fn(int, int) -> int)[], which: int, a: int, b: int) -> int {
  if (tbl[which] == null) { return -1; }
  return tbl[which](a, b);
}
fn main(){
  let tbl: (fn(int, int) -> int)[] = fn_array(3);
  tbl[0] = op_add; tbl[2] = op_max;   // slot 1 deliberately left null
  print(dispatch(tbl, 0, 3, 4));   // 7
  print(dispatch(tbl, 1, 3, 4));   // -1  (null slot)
  print(dispatch(tbl, 2, 3, 4));   // 4
}`,
  },

  // --- loop optimization battery -------------------------------------------
  // These stress the induction-variable / trip-count analysis and the unroller:
  // each must print the same lines at -O0 (no unroll) and -O2/-O3 (unrolled and
  // usually folded to a constant), so the harness proves the transform exact.
  {
    name: 'loop-sum-collapse',
    source: `fn main(){
  let s = 0;
  for (let i = 1; i <= 100; i = i + 1) { s = s + i; }
  print(s);                              // 5050 — unrolls then folds to a constant
}`,
  },
  {
    name: 'loop-reverse-step',
    source: `fn main(){
  let p = 1;
  for (let i = 5; i > 0; i = i - 1) { p = p * i; }
  print(p);                              // 120 — descending counter (negative step)
}`,
  },
  {
    name: 'loop-step-by-two',
    source: `fn main(){
  let n = 0; let s = 0;
  for (let i = 0; i < 20; i = i + 2) { n = n + 1; s = s + i; }
  print(n); print(s);                    // 10, 90
}`,
  },
  {
    name: 'loop-ne-test',
    source: `fn main(){
  let s = 0; let i = 0;
  while (i != 8) { s = s + i * i; i = i + 1; }
  print(s);                              // 140 — exit on not-equal
}`,
  },
  {
    name: 'loop-iv-on-rhs',
    source: `fn main(){
  let s = 0;
  for (let i = 0; 12 > i; i = i + 3) { s = s + i; }
  print(s);                              // 0+3+6+9 = 18 — IV is the right operand
}`,
  },
  {
    name: 'loop-multi-phi',
    source: `fn main(){
  let a = 0; let b = 1;                   // two accumulators threaded as header phis
  for (let i = 0; i < 10; i = i + 1) { let t = a + b; a = b; b = t; }
  print(a); print(b);                    // a 10th/11th Fibonacci, fully unrolled
}`,
  },
  {
    name: 'loop-nested',
    source: `fn main(){
  let s = 0;
  for (let i = 0; i < 5; i = i + 1) {
    for (let j = 0; j < 5; j = j + 1) { s = s + i * j; }
  }
  print(s);                              // 100 — innermost unrolls first, then the outer
}`,
  },
  {
    name: 'loop-early-return',
    source: `fn first_factor(n: int) -> int {
  for (let d = 2; d < n; d = d + 1) { if (n % d == 0) { return d; } }
  return n;
}
fn main(){ print(first_factor(91)); print(first_factor(97)); }  // 7, 97 — return inside an unrolled loop`,
  },
  {
    name: 'loop-long-iv',
    source: `fn main(){
  let s = 0L;
  for (let i = 1L; i <= 12L; i = i + 1L) { s = s + i * i; }
  print(s);                              // 650 — 64-bit induction variable
}`,
  },
  {
    name: 'loop-array-unroll',
    source: `fn main(){
  let a = int_array(6);
  for (let i = 0; i < 6; i = i + 1) { a[i] = i * i; }   // small side-effecting loop (unrolls at T<=8)
  let s = 0;
  for (let i = 0; i < 6; i = i + 1) { s = s + a[i]; }
  print(s);                              // 55
}`,
  },
  {
    name: 'loop-variable-bound',
    source: `fn tri(n: int) -> int {
  let s = 0;
  for (let i = 0; i < n; i = i + 1) { s = s + i; }   // bound is a parameter — must NOT unroll
  return s;
}
fn main(){ for (let n = 0; n <= 6; n = n + 1) { print(tri(n)); } }`,
  },
  {
    name: 'loop-break-no-unroll',
    source: `fn main(){
  let s = 0;
  for (let i = 0; i < 100; i = i + 1) {   // a break is a second exit — must NOT unroll
    if (i * i > 40) { break; }
    s = s + i;
  }
  print(s);                              // 0+1+..+6 = 21
}`,
  },
  {
    name: 'loop-zero-trip',
    source: `fn main(){
  let s = 42;
  for (let i = 10; i < 5; i = i + 1) { s = s + 1; }   // never executes
  print(s);                              // 42
}`,
  },
  {
    name: 'loop-continue',
    source: `fn main(){
  let s = 0;
  for (let i = 0; i < 12; i = i + 1) {
    if (i % 3 == 0) { continue; }
    s = s + i;
  }
  print(s);                              // sum of i in 1..11 not divisible by 3 = 52
}`,
  },
  {
    // Division/remainder by a *constant* with a runtime dividend — exercises the
    // div-by-const strength reduction over every lowering: power-of-two (pos &
    // neg), and the signed magic-number multiply (pos & neg, small & large).
    // The dividends include INT_MIN/INT_MAX so the magic-number corner cases and
    // the round-toward-zero bias are all hit. Divisors are all |d| >= 2, so no
    // division here can trap (and the oracle proves the rewrite exact).
    name: 'div-by-const-i32',
    source: `fn probe(x: int) {
  print(x / 2);    print(x % 2);
  print(x / -2);   print(x % -2);
  print(x / 3);    print(x % 3);
  print(x / -3);   print(x % -3);
  print(x / 7);    print(x % 7);
  print(x / -7);   print(x % -7);
  print(x / 10);   print(x % 10);
  print(x / 16);   print(x % 16);
  print(x / -16);  print(x % -16);
  print(x / 100);  print(x % 100);
  print(x / 1000); print(x % 1000);
  print(x / 65536);print(x % 65536);
}
fn main(){
  let xs = int_array(9);
  xs[0] = 0;          xs[1] = 1;           xs[2] = -1;
  xs[3] = 7;          xs[4] = -7;          xs[5] = 2147483647;
  xs[6] = -2147483648;xs[7] = 123456789;   xs[8] = -123456789;
  for (let i = 0; i < 9; i = i + 1) { probe(xs[i]); }
}`,
  },
  {
    // 64-bit division/remainder by a constant. Power-of-two divisors (incl. 2^32)
    // lower to i64 shifts with bias correction; general divisors use the 64-bit
    // signed magic-number multiply, whose high-64 product is *synthesized* from
    // i64 ops (wasm has no mulhi). Dividends span I64_MIN/I64_MAX so every
    // corner of the bias + sign correction is hit.
    name: 'div-by-const-i64',
    source: `fn probe(x: long) {
  print(x / 2L);              print(x % 2L);
  print(x / -2L);             print(x % -2L);
  print(x / 8L);              print(x % 8L);
  print(x / -1024L);          print(x % -1024L);
  print(x / 4294967296L);     print(x % 4294967296L);   // 2^32
  print(x / 3L);              print(x % 3L);             // magic
  print(x / -7L);             print(x % -7L);            // magic, neg
  print(x / 1000L);           print(x % 1000L);          // magic
  print(x / 1000000007L);     print(x % 1000000007L);    // magic, large
  print(x / -1000000000000L); print(x % -1000000000000L);// magic, > 2^32
}
fn main(){
  let xs = long_array(7);
  xs[0] = 0L;  xs[1] = 1L;  xs[2] = -1L;
  xs[3] = 9223372036854775807L;     // I64_MAX
  xs[4] = -9223372036854775808L;    // I64_MIN
  xs[5] = -123456789012345L;
  xs[6] = 4611686018427387904L;     // 2^62
  for (let i = 0; i < 7; i = i + 1) { probe(xs[i]); }
}`,
  },
  {
    // A divmod of the same operands: at -O2 GVN must recognise the quotient
    // shared by `x / d` (the rewrite) and the `x - (x/d)*d` of `x % d` and
    // compute it once. Output must match the reference at every level.
    name: 'div-by-const-divmod',
    source: `fn digits(n: int) {
  let x = n;
  if (x < 0) { x = -x; }
  while (x > 0) { print(x % 10); x = x / 10; }
}
fn main(){
  digits(0); digits(7); digits(100); digits(2024); digits(-98765);
}`,
  },

  // --- memory optimization: store→load forwarding · RLE · DSE ---------------
  {
    // A read-modify-write chain on one struct field: every load after the first
    // store forwards the stored value, and only the final store survives. The
    // printed values must be unchanged at every level.
    name: 'mem-forward-chain',
    source: `struct Box { v: long; }
fn main(){
  let b = Box(0L);
  b.v = b.v + 1L;     print(b.v);
  b.v = b.v + 10L;    print(b.v);
  b.v = b.v * 3L;     print(b.v);
  b.v = b.v - 7L;     print(b.v);
  print(b.v + b.v);   // two forwarded loads of the same field
}`,
  },
  {
    // Dead-store elimination: each field is constructed, then overwritten before
    // any read. The early stores are dead; the observed values are the last ones.
    name: 'mem-dead-store',
    source: `struct P { x: int; y: int; z: int; }
fn main(){
  let p = P(1, 2, 3);   // these three stores are all dead ...
  p.x = 10;             // ... overwritten here ...
  p.y = 20;
  p.z = 30;
  p.x = p.x + p.y + p.z; // load each (forwarded), store x
  print(p.x); print(p.y); print(p.z);
}`,
  },
  {
    // Redundant-load elimination across reuse of the same handle, including a
    // mixed-type struct (int / long / float / bool fields).
    name: 'mem-rle-mixed',
    source: `struct M { i: int; l: long; f: float; b: bool; }
fn score(m: M) -> float {
  // each field read twice — RLE should keep one load apiece
  let a = float(m.i) + float(m.i);
  let c = float(m.l) - float(m.l);
  let d = m.f * m.f;
  let e = m.b;
  return a + c + d + (e ? 1.0 : 0.0);
}
fn main(){
  let m = M(5, 9L, 2.5, true);
  print(str(score(m)));
  print(str(score(m)));
}`,
  },
  {
    // Aliasing across DISTINCT bases must stay correct: writes to one struct must
    // never be forwarded across a write to another. The interpreter (objects) and
    // the wasm (flat memory) agree only if the pass is conservative here.
    name: 'mem-distinct-bases',
    source: `struct C { v: int; }
fn main(){
  let a = C(100);
  let b = C(200);
  a.v = a.v + 1;   // store a.v
  b.v = b.v + 2;   // store b.v  (different base)
  a.v = a.v + b.v; // load a.v + load b.v  -> a.v = 101 + 202 = 303
  print(a.v); print(b.v);
}`,
  },
  {
    // A call between a store and a load is a memory barrier: the callee might read
    // OR write the object, so the store is not dead and the load must re-read.
    // `tick` is recursive so it is not inlined away.
    name: 'mem-call-barrier',
    source: `struct C { v: int; }
fn tick(c: C, n: int) { if (n > 0) { c.v = c.v + 1; tick(c, n - 1); } }
fn main(){
  let c = C(0);
  c.v = 5;        // store
  tick(c, 3);     // mutates c.v through a call — must observe 5, then write 8
  print(c.v);     // re-load after the call -> 8
  c.v = c.v + 100;
  print(c.v);
}`,
  },
  {
    // Array element aliasing: a[i] and a[j] may be the same cell at run time, so a
    // store to a[j] must kill any forwarded value for a[i]. Exercised with i==j
    // and i!=j so a wrong forward would print the wrong number.
    name: 'mem-array-alias',
    source: `fn probe(i: int, j: int) -> int {
  let a = int_array(4);
  a[0] = 0; a[1] = 0; a[2] = 0; a[3] = 0;
  a[i] = 7;       // store a[i]
  a[j] = 9;       // store a[j] — aliases a[i] iff i==j
  return a[i];    // must re-load: 9 when i==j, else 7
}
fn main(){
  print(probe(1, 1));   // alias  -> 9
  print(probe(1, 2));   // no alias-> 7
  print(probe(3, 3));   // alias  -> 9
  print(probe(0, 3));   // no alias-> 7
}`,
  },
  {
    // Cross-block forwarding: a value stored before a branch is still forwardable
    // at a merge only when both arms agree. Here the field is re-stored in only
    // one arm, so the merge must NOT forward a stale value.
    name: 'mem-branch-merge',
    source: `struct B { v: int; }
fn pick(k: int) -> int {
  let b = B(0);
  b.v = 11;
  if (k > 0) { b.v = 22; }   // only one arm overwrites
  return b.v;                 // 22 if k>0 else 11
}
fn main(){
  print(pick(-1)); print(pick(1)); print(pick(0));
}`,
  },
  {
    // Same-cell forwarding inside a loop body, plus a redundant load of an array
    // element that is written and immediately read with the same index.
    name: 'mem-loop-body',
    source: `fn run(n: int) -> int {
  let a = int_array(8);
  let i = 0;
  while (i < n) {
    a[i] = i * i;       // store a[i]
    a[i] = a[i] + 1;    // load a[i] (forward), store a[i]
    i = i + 1;
  }
  let s = 0;
  let j = 0;
  while (j < n) { s = s + a[j]; j = j + 1; }
  return s;
}
fn main(){ print(run(0)); print(run(1)); print(run(6)); }`,
  },
  {
    // Silent (redundant) store elimination: writing a field the value it already
    // holds is a no-op. The self-assignments and the no-op read-modify-writes must
    // vanish without changing any printed value.
    name: 'mem-silent-store',
    source: `struct S { a: int; b: long; }
fn main(){
  let s = S(7, 100L);
  s.a = s.a;          // silent: a already holds its value
  s.b = s.b + 0L;     // folds to s.b = s.b -> silent after SCCP
  s.a = s.a * 1;      // folds to s.a = s.a -> silent
  print(s.a); print(s.b);
  s.a = 7;            // same constant it already holds (after the no-ops) -> silent
  print(s.a);
}`,
  },
  {
    // SROA: a record used only locally (no calls, no escape) is promoted entirely
    // out of memory — every field becomes an SSA value. The handle never leaks, so
    // the alloc and all its loads/stores must disappear with identical output.
    name: 'sroa-local',
    source: `struct P { x: int; y: int; }
fn main(){
  let p = P(3, 4);
  p.x = p.x + p.y;     // 7
  p.y = p.x * p.y;     // 28
  print(p.x); print(p.y);
}`,
  },
  {
    // SROA through a control-flow merge: a field written on both arms of a branch
    // must reconcile with a phi at the join (not a memory round-trip). The value
    // read after the merge has to match the path actually taken.
    name: 'sroa-phi-merge',
    source: `struct P { x: int; y: int; }
fn classify(n: int) -> int {
  let p = P(0, n);
  if (n > 0) { p.x = 1; } else if (n < 0) { p.x = -1; } else { p.x = 0; }
  return p.x + p.y * 0;
}
fn main(){ print(classify(42)); print(classify(-7)); print(classify(0)); }`,
  },
  {
    // SROA across a loop: a field accumulated each iteration becomes a loop-carried
    // phi. The header phi for every promoted slot must thread the right value.
    name: 'sroa-loop-acc',
    source: `struct Acc { sum: int; cnt: int; }
fn triangular(n: int) -> int {
  let a = Acc(0, 0);
  for (let i = 1; i <= n; i = i + 1) { a.sum = a.sum + i; a.cnt = a.cnt + 1; }
  return a.sum + a.cnt;     // n(n+1)/2 + n
}
fn main(){ print(triangular(5)); print(triangular(100)); print(triangular(0)); }`,
  },
  {
    // Handle aliasing: `q = p` is the SAME record. A write through one alias is
    // visible through the other — promotion must keep a single slot per field,
    // not two.
    name: 'sroa-alias',
    source: `struct P { x: int; y: int; }
fn main(){
  let p = P(1, 2);
  let q = p;           // same handle
  q.x = 99;
  p.y = q.y + p.x;     // 2 + 99
  print(p.x); print(q.y); print(p.y);
}`,
  },
  {
    // Mixed field widths (i32 / i64 / f64 / f32) at their natural offsets all
    // scalarize independently; the byte-offset slots must stay disjoint.
    name: 'sroa-mixed-widths',
    source: `struct M { a: int; b: long; c: float; d: f32; }
fn main(){
  let m = M(1, 9000000000L, 2.5, f32(1.25));
  m.a = m.a + 3;
  m.b = m.b * 2L;
  m.c = m.c + float(m.a);
  print(m.a); print(m.b); print(m.c); print(m.d);
}`,
  },
  {
    // Escape boundaries: a record that is returned (or compared, or stored) must
    // stay a real allocation, while a sibling local record is still promoted. The
    // two must not be confused.
    name: 'sroa-escape-mix',
    source: `struct P { x: int; y: int; }
fn keep(p: P) -> P { return p; }      // p escapes via return
fn main(){
  let a = P(5, 6);
  let kept = keep(a);                 // a escapes -> stays in memory
  let local = P(10, 20);              // never escapes -> promoted
  local.x = local.x + local.y;
  print(kept.x); print(kept.y); print(local.x);
}`,
  },
  {
    // After cross-function inlining at -O2, vector helpers fold away and the whole
    // chain of temporaries melts to scalar arithmetic — the headline SROA win.
    name: 'sroa-inline-vec',
    source: `struct V { x: float; y: float; }
fn add(a: V, b: V) -> V { return V(a.x + b.x, a.y + b.y); }
fn scale(v: V, s: float) -> V { return V(v.x * s, v.y * s); }
fn dot(a: V, b: V) -> float { return a.x * b.x + a.y * b.y; }
fn main(){
  let a = V(3.0, 4.0);
  let b = V(1.0, 2.0);
  let c = add(a, scale(b, 2.0));
  print(c.x); print(c.y);
  print(dot(a, b));
}`,
  },

  // --- 128-bit SIMD vectors -------------------------------------------------
  {
    name: 'simd-int4-arith',
    source: `fn main(){
  let a = int4(1, 2, 3, 4);
  let b = int4(10, 20, 30, 40);
  let c = a + b; print(lane(c,0)); print(lane(c,1)); print(lane(c,2)); print(lane(c,3));
  print(hsum(a * b));                  // 10+40+90+160 = 300
  print(hsum(b - a));                  // 9+18+27+36 = 90
  let m = int4(1000000, 1, 1, 1); print(lane(m * m, 0));   // i32 imul wrap
  let o = int4(2147483647, 0, 0, 0); print(lane(o + int4(1,0,0,0), 0)); // wrap to INT_MIN
}`,
  },
  {
    name: 'simd-long2',
    source: `fn main(){
  let a = long2(1000000000000L, 5L);
  let b = long2(2L, 7L);
  print(lane(a * b, 0)); print(lane(a + b, 1)); print(hsum(a));
  print(lane(-a, 0)); print(lane(~b, 1));
}`,
  },
  {
    name: 'simd-double2-dot',
    source: `fn dot(a: double2, b: double2) -> float { return hsum(a * b); }
fn main(){
  let a = double2(3.0, 4.0);
  let b = double2(0.5, 2.0);
  print(dot(a, b)); print(lane(a / b, 0)); print(lane(a - b, 1));
  print(lane(vmin(a, b), 1)); print(lane(vmax(a, b), 0));
  print(lane(vsqrt(double2(9.0, 16.0)), 1));
  print(lane(vabs(double2(-7.0, 4.0)), 0));
}`,
  },
  {
    name: 'simd-float4',
    source: `fn main(){
  let a = float4(f32(1.5), f32(2.5), f32(3.5), f32(4.5));
  let b = float4(f32(2.0));                 // splat
  let c = a * b; print(lane(c,0)); print(lane(c,3)); print(hsum(a));
  print(hsum(a / b));
  print(lane(vsqrt(float4(f32(4.0), f32(0.25), f32(1.0), f32(100.0))), 1));
  let p = float4(f32(0.1), f32(0.2), f32(0.3), f32(0.0));   // f32 rounding
  print(lane(p * float4(f32(0.1)), 0));
}`,
  },
  {
    name: 'simd-lanes-bitwise',
    source: `fn main(){
  let a = int4(7);
  let b = withlane(a, 2, 99);
  print(lane(b,0)); print(lane(b,2)); print(hsum(b));
  print(hsum(vmin(a,b))); print(hsum(vmax(a,b)));
  let x = int4(12, 10, 255, 1);
  let y = int4(10, 6, 15, 1);
  print(lane(x & y, 0)); print(lane(x | y, 1)); print(lane(x ^ y, 2)); print(lane(~x, 3));
  print(lane(-x, 0));
  print(lane(vabs(int4(-5, 3, -2147483648, 8)), 2));     // abs(INT_MIN) wraps
}`,
  },
  {
    name: 'simd-vec-params-loop',
    source: `fn axpy(s: int, x: int4, y: int4) -> int4 { return int4(s) * x + y; }
fn main(){
  let acc = int4(0);
  for (let i = 0; i < 5; i = i + 1) { acc = acc + axpy(i, int4(1,2,3,4), int4(i,i,i,i)); }
  print(lane(acc,0)); print(lane(acc,1)); print(lane(acc,3)); print(hsum(acc));
}`,
  },
  {
    name: 'simd-vec-ternary',
    source: `fn pick(c: bool, a: int4, b: int4) -> int4 { return c ? a : b; }
fn main(){
  print(hsum(pick(true,  int4(1,2,3,4), int4(9,9,9,9))));   // 10
  print(hsum(pick(false, int4(1,2,3,4), int4(9,9,9,9))));   // 36
}`,
  },
  {
    name: 'simd-compare-select',
    source: `fn main(){
  let a = int4(10, 20, 30, 40);
  let b = int4(1, 2, 3, 4);
  let m = vgt(a, int4(25));                 // mask: 0,0,-1,-1
  let r = vselect(m, a, b);                 // 1, 2, 30, 40
  print(lane(r,0)); print(lane(r,2)); print(hsum(r));
  print(lane(vlt(a,b),0)); print(lane(veq(a,a),3)); print(hsum(vne(a,b)));
}`,
  },
  {
    name: 'simd-compare-float',
    source: `fn main(){
  let a = float4(f32(1.0), f32(2.0), f32(3.0), f32(4.0));
  let m = vlt(a, float4(f32(2.5)));
  let r = vselect(m, a, float4(f32(9.0)));  // 1, 2, 9, 9
  print(lane(r,0)); print(lane(r,2)); print(hsum(r));
  let d = double2(1.5, 9.0);
  let dm = vge(d, double2(2.0, 9.0));
  let dr = vselect(dm, double2(100.0), double2(-1.0));
  print(lane(dr,0)); print(lane(dr,1));
}`,
  },
  {
    name: 'simd-convert',
    source: `fn main(){
  let f = to_float4(int4(1, 2, 3, 4));
  print(lane(f,0)); print(hsum(f));
  let j = to_int4(float4(f32(1.9), f32(2.1), f32(-3.7), f32(100.5)));   // truncates
  print(lane(j,0)); print(lane(j,2)); print(hsum(j));
  let s = to_int4(float4(f32(3000000000.0), f32(-3000000000.0), f32(0.0), f32(5.0)));  // saturates
  print(lane(s,0)); print(lane(s,1)); print(lane(s,3));
}`,
  },
  {
    name: 'simd-mandelbrot-row',
    source: `// Four Mandelbrot pixels at once, branchless: each step masks the still-
// escaping lanes and adds 1 to their iteration counts via vselect.
fn main(){
  let cx = float4(f32(-0.5), f32(0.0), f32(0.25), f32(-1.0));
  let cy = float4(f32(0.0));
  let zx = float4(f32(0.0));
  let zy = float4(f32(0.0));
  let cnt = int4(0);
  for (let it = 0; it < 20; it = it + 1) {
    let zx2 = zx * zx;
    let zy2 = zy * zy;
    let alive = vlt(zx2 + zy2, float4(f32(4.0)));
    cnt = cnt - vselect(alive, int4(1), int4(0));     // count escaping lanes
    let nzx = zx2 - zy2 + cx;
    let nzy = float4(f32(2.0)) * zx * zy + cy;
    zx = nzx; zy = nzy;
  }
  print(lane(cnt,0)); print(lane(cnt,1)); print(lane(cnt,2)); print(lane(cnt,3));
}`,
  },

  // --- Operator strength reduction on induction variables (OSR). Each loop is
  // large enough that the unroller declines, so the multiply/shift of the IV
  // survives to -O2/-O3 and OSR reduces it to an addition. The differential
  // oracle proves the reduced wasm prints exactly what the interpreter does, so
  // these double as the proof that `(i+c)*r ≡ i*r + c*r (mod 2^w)` is exact. --
  {
    name: 'osr-mul-basic',
    source: `fn main(){
  let acc = 0;
  for (let i = 0; i < 200; i = i + 1) { acc = acc + i * 7; }
  print(acc);
}`,
  },
  {
    name: 'osr-shl-iv',
    source: `fn main(){
  let acc = 0;
  for (let i = 0; i < 150; i = i + 1) { acc = acc + (i << 3); }
  print(acc);
}`,
  },
  {
    name: 'osr-neg-stride',
    source: `fn main(){
  // a decrementing induction variable: step -3, region constant 5.
  let acc = 0;
  for (let i = 300; i > 0; i = i - 3) { acc = acc ^ (i * 5); }
  print(acc);
}`,
  },
  {
    name: 'osr-neg-rc',
    source: `fn main(){
  // negative region constant exercises the signed wraparound of the derived step.
  let acc = 0;
  for (let i = 0; i < 175; i = i + 2) { acc = acc + i * -11; }
  print(acc);
}`,
  },
  {
    name: 'osr-invariant-rc',
    source: `fn main(){
  // the region constant is a loop-invariant *variable*, not a literal.
  let n = 130;
  let r = n * 2 + 1;
  let acc = 0;
  for (let i = 0; i < n; i = i + 1) { acc = acc + i * r; }
  print(acc); print(r);
}`,
  },
  {
    name: 'osr-multi-candidate',
    source: `fn main(){
  // three reducible candidates over one induction variable in one loop.
  let a = 0; let b = 0; let c = 0;
  for (let i = 0; i < 160; i = i + 1) {
    a = a + i * 3;
    b = b ^ (i << 2);
    c = c + i * 9;
  }
  print(a); print(b); print(c);
}`,
  },
  {
    name: 'osr-gvn-shared',
    source: `fn main(){
  // i*9 appears twice; GVN folds them, OSR reduces the single survivor.
  let acc = 0;
  for (let i = 0; i < 180; i = i + 1) {
    let t = i * 9;
    acc = acc + t + (i * 9);
  }
  print(acc);
}`,
  },
  {
    name: 'osr-long-iv',
    source: `fn main(){
  // 64-bit induction variable and a 64-bit region constant.
  let acc: long = 0L;
  for (let i: long = 0L; i < 200L; i = i + 1L) { acc = acc + i * 1000003L; }
  print(acc);
}`,
  },
  {
    name: 'osr-addressing',
    source: `fn main(){
  // the canonical use: an array address base + i*stride becomes a running bump.
  let n = 120;
  let a = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i * 4 + 1000; }
  let sum = 0;
  for (let i = 0; i < n; i = i + 1) { sum = sum ^ a[i]; }
  print(sum);
}`,
  },
  {
    name: 'osr-nested-loops',
    source: `fn main(){
  // each loop level carries its own reducible induction multiply.
  let acc = 0;
  for (let i = 0; i < 60; i = i + 1) {
    acc = acc + i * 17;
    for (let j = 0; j < 120; j = j + 1) { acc = acc ^ (j * 13 + i); }
  }
  print(acc);
}`,
  },
  {
    name: 'osr-wrap-i32',
    source: `fn main(){
  // a big multiplier so i*r wraps i32 every few iterations — the reduced add
  // chain must wrap the same way.
  let acc = 0;
  for (let i = 0; i < 250; i = i + 1) { acc = acc + i * 1000003; }
  print(acc);
}`,
  },

  // --- Reassociation: canonicalize integer affine expression trees. Each body
  // is built over a loop counter (so the expression stays symbolic past SCCP and
  // reassociation actually fires at -O2/-O3), and the differential oracle pins the
  // result bit-for-bit at -O0..-O3 — so these prove every reassociation identity
  // (`a·x + b·x ≡ (a+b)·x`, constant folding, `c·x·d ≡ (c·d)·x`, distribution and
  // cancellation) is exact in the wrapping ring Z/2^w, including the wrap edges. --
  {
    name: 'reassoc-like-terms',
    source: `fn main(){
  // three multiples of one value collect into a single multiply: x*1034.
  let acc = 0;
  for (let i = 0; i < 160; i = i + 1) { acc = acc + (i * 8 + i * 1024 + 2 * i); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-const-fold',
    source: `fn main(){
  // scattered literals fold into one: (x+3)+(x+5) -> 2x+8.
  let acc = 0;
  for (let i = 0; i < 140; i = i + 1) { let x = i; acc = acc ^ ((x + 3) + (x + 5)); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-mul-chain',
    source: `fn main(){
  // a multiplicative constant chain folds: (i*4)*3 -> i*12.
  let acc = 0;
  for (let i = 0; i < 150; i = i + 1) { acc = acc + (i * 4) * 3; }
  print(acc);
}`,
  },
  {
    name: 'reassoc-cancel',
    source: `fn main(){
  // commuted operands cancel exactly: (i+j) - (j+i) + i -> i.
  let acc = 0;
  for (let i = 0; i < 120; i = i + 1) { let j = i * 2 + 1; acc = acc + ((i + j) - (j + i) + i); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-neg-coeff',
    source: `fn main(){
  // like terms with opposite signs combine to a negative coefficient: 5x - 9x -> -4x.
  let acc = 0;
  for (let i = 0; i < 130; i = i + 1) { acc = acc + (i * 5 - i * 9); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-distribute',
    source: `fn main(){
  // a constant distributes over a sum and then folds: 2*(i+i+3) -> 4i+6.
  let acc = 0;
  for (let i = 0; i < 110; i = i + 1) { acc = acc ^ (2 * (i + i + 3)); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-shl-terms',
    source: `fn main(){
  // shift-coded multiples collect through the shift coefficient: (i<<3)+(i<<1) -> i*10.
  let acc = 0;
  for (let i = 0; i < 145; i = i + 1) { acc = acc + ((i << 3) + (i << 1) + i); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-wrap-i32',
    source: `fn main(){
  // two huge multiples sum past 2^31, so the combined coefficient wraps i32 — the
  // single reduced multiply must wrap identically to the two it replaced.
  let acc = 0;
  for (let i = 0; i < 200; i = i + 1) { acc = acc + (i * 2000000000 + i * 2000000000); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-multi-use',
    source: `fn main(){
  // a multi-use subterm (t) must stay a shared atom, not be duplicated.
  let acc = 0;
  for (let i = 0; i < 125; i = i + 1) { let t = i * 3 + 1; acc = acc + (t + t + t); print(t); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-long',
    source: `fn main(){
  // 64-bit affine reassociation with wide coefficients that wrap i64.
  let acc: long = 0L;
  for (let i: long = 0L; i < 200L; i = i + 1L) {
    acc = acc + (i * 5000000000L + i * 7000000000L + 11L + 13L);
  }
  print(acc);
}`,
  },
  {
    name: 'reassoc-long-cancel',
    source: `fn main(){
  // i64 cancellation: (a + b*4) - b*4 -> a, with a 64-bit loop variable.
  let acc: long = 0L;
  for (let i: long = 0L; i < 160L; i = i + 1L) {
    let b = i * 3L;
    acc = acc ^ ((i + b * 4L) - b * 4L);
  }
  print(acc);
}`,
  },

  // --- Bitwise reassociation (and/or/xor monoids). Same canonicalization over a
  // monoid instead of a ring: idempotence (and/or), self-inverse parity (xor),
  // absorbing elements (`& 0`, `| ~0`) and constant folding. Built over a loop
  // counter so the chains stay symbolic; the oracle pins each at -O0..-O3. --------
  {
    name: 'reassoc-xor-cancel',
    source: `fn main(){
  // xor self-inverse: x ^ y ^ x -> y (the repeated atom cancels by parity).
  let acc = 0;
  for (let i = 0; i < 130; i = i + 1) { let x = i * 3; let y = i + 7; acc = acc + (x ^ y ^ x); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-xor-const',
    source: `fn main(){
  // scattered xor constants fold into one: x ^ 3 ^ 5 -> x ^ 6.
  let acc = 0;
  for (let i = 0; i < 140; i = i + 1) { acc = acc ^ (i ^ 3 ^ 5); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-and-idem',
    source: `fn main(){
  // and idempotence + constant fold: x & y & x & 0xF0 & 0x3C -> (x & y) & 0x30.
  let acc = 0;
  for (let i = 0; i < 125; i = i + 1) { let x = i * 5; let y = i + 1; acc = acc + (x & y & x & 240 & 60); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-and-absorb',
    source: `fn main(){
  // and absorbing element short-circuits the whole chain to 0.
  let acc = 0;
  for (let i = 0; i < 100; i = i + 1) { let x = i * 7 + 3; acc = acc + ((x & i) & 0); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-or-fold',
    source: `fn main(){
  // or idempotence + constant fold: x | 0xF0 | x | 0x0F -> x | 0xFF.
  let acc = 0;
  for (let i = 0; i < 135; i = i + 1) { let x = i * 9; acc = acc ^ (x | 240 | x | 15); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-or-absorb',
    source: `fn main(){
  // or absorbing element (all ones) short-circuits to -1.
  let acc = 0;
  for (let i = 0; i < 90; i = i + 1) { acc = acc + ((i | 7) | -1); }
  print(acc);
}`,
  },
  {
    name: 'reassoc-xor-long',
    source: `fn main(){
  // 64-bit xor: cancellation + wide constant fold (255L ^ 256L = 511L).
  let acc: long = 0L;
  for (let i: long = 0L; i < 150L; i = i + 1L) {
    let x = i * 3L; let y = i + 1L;
    acc = acc ^ (x ^ y ^ x ^ 255L ^ 256L);
  }
  print(acc);
}`,
  },

  // ---------------------------------------------------------------------------
  // Partial loop unrolling (unroll-by-K + remainder). Each loop has a *runtime*
  // or large bound the full unroller declines, so the strider engages; the
  // remainder loop must mop up every leftover trip count exactly. The argument
  // sets sweep trip counts mod K (0,1,2,3,4,…) so the remainder is exercised at
  // every residue, including the zero- and one-iteration edges.
  // ---------------------------------------------------------------------------
  {
    name: 'partial-sum-up',
    source: `fn sum(n: int) -> int { let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + i; } return s; }
fn main(){ for (let n = 0; n <= 13; n = n + 1) { print(sum(n)); } print(sum(1000)); }`,
  },
  {
    name: 'partial-countdown',
    source: `fn f(n: int) -> int { let s = 0; for (let i = n; i > 0; i = i - 1) { s = s + i * 3 - 1; } return s; }
fn main(){ for (let n = 0; n <= 11; n = n + 1) { print(f(n)); } print(f(777)); }`,
  },
  {
    name: 'partial-stride-le',
    source: `fn f(n: int) -> int { let s = 0; for (let i = 0; i <= n; i = i + 3) { s = s * 2 + i; } return s; }
fn main(){ for (let n = 0; n <= 20; n = n + 1) { print(f(n)); } }`,
  },
  {
    name: 'partial-stride-ge-neg',
    source: `fn f(n: int) -> int { let s = 0; for (let i = n; i >= 0; i = i - 2) { s = s + (i ^ 5); } return s; }
fn main(){ for (let n = 0; n <= 17; n = n + 1) { print(f(n)); } }`,
  },
  {
    name: 'partial-ne-exact',
    source: `// i counts 0,1,…,n with a !=-test that's reached exactly (n >= 0); the strider
// must keep the body running until the precise stopping value.
fn f(n: int) -> int { let s = 1; for (let i = 0; i != n; i = i + 1) { s = s + (i & 7) + 1; } return s; }
fn main(){ for (let n = 0; n <= 14; n = n + 1) { print(f(n)); } print(f(513)); }`,
  },
  {
    name: 'partial-side-effects',
    source: `// A printing body: the strider may only run the K copies once it has proved all
// K iterations happen, so the printed sequence and its length must be identical.
fn run(n: int){ for (let i = 0; i < n; i = i + 1) { print(i * i - i); } }
fn main(){ run(0); run(1); run(2); run(3); run(4); run(5); run(9); }`,
  },
  {
    name: 'partial-two-reductions',
    source: `fn f(n: int) -> int { let a = 0; let b = 1; for (let i = 0; i < n; i = i + 1) { a = a + i; b = b * 3 + a; } return a ^ b; }
fn main(){ for (let n = 0; n <= 12; n = n + 1) { print(f(n)); } print(f(200)); }`,
  },
  {
    name: 'partial-inner-if',
    source: `// Control flow inside the body (a diamond) — the cloned region must keep its
// internal branches and merges intact across all K copies.
fn f(n: int) -> int { let s = 0; for (let i = 0; i < n; i = i + 1) { if (i % 2 == 0) { s = s + i; } else { s = s - i * 2; } } return s; }
fn main(){ for (let n = 0; n <= 15; n = n + 1) { print(f(n)); } print(f(999)); }`,
  },
  {
    name: 'partial-nested',
    source: `// Inner loop is strided first; the outer loop's bound is runtime too.
fn f(n: int) -> int { let s = 0; for (let i = 0; i < n; i = i + 1) { for (let j = 0; j < n; j = j + 1) { s = s + i * j; } } return s; }
fn main(){ for (let n = 0; n <= 9; n = n + 1) { print(f(n)); } print(f(40)); }`,
  },
  {
    name: 'partial-i64',
    source: `// A 64-bit induction variable and a wrapping i64 reduction.
fn f(n: long) -> long { let s = 0L; for (let i = 0L; i < n; i = i + 1L) { s = s * 1000003L + i; } return s; }
fn main(){ for (let n = 0L; n <= 13L; n = n + 1L) { print(f(n)); } print(f(500L)); }`,
  },
  {
    name: 'partial-i64-stride',
    source: `fn f(n: long) -> long { let s = 7L; for (let i = n; i > 0L; i = i - 3L) { s = s + i * i; } return s; }
fn main(){ for (let n = 0L; n <= 16L; n = n + 1L) { print(f(n)); } }`,
  },
  {
    name: 'partial-large-const',
    source: `// A constant bound far past the full-unroll limit: the strider should peel it
// into a K-wide main loop, the remainder handling 300 mod K.
fn main(){ let s = 0; for (let i = 0; i < 300; i = i + 1) { s = (s + i) * 3 - 1; } print(s); }`,
  },
  {
    name: 'partial-invariant-bound',
    source: `// The bound is a runtime loop-invariant computed in the preheader (m), not a
// parameter — the strider must recognise it as invariant.
fn f(k: int) -> int { let m = k * 2 + 3; let s = 0; for (let i = 0; i < m; i = i + 1) { s = s + i - k; } return s; }
fn main(){ for (let k = 0; k <= 10; k = k + 1) { print(f(k)); } }`,
  },
  {
    name: 'partial-wrap-body',
    source: `// The loop counter stays in range, but the reduction multiply wraps i32 every
// few iterations — the K strided copies must wrap exactly like the rolling loop.
fn f(n: int) -> int { let s = 1; for (let i = 1; i <= n; i = i + 1) { s = s * 1000003 + i; } return s; }
fn main(){ for (let n = 0; n <= 14; n = n + 1) { print(f(n)); } print(f(250)); }`,
  },
  {
    name: 'partial-neg-init',
    source: `// A negative runtime start with a positive step: the remainder must align even
// when the iteration space straddles zero.
fn f(a: int, b: int) -> int { let s = 0; for (let i = a; i < b; i = i + 1) { s = s + i * i - 1; } return s; }
fn main(){ for (let b = -4; b <= 9; b = b + 1) { print(f(-4, b)); } print(f(-100, 100)); }`,
  },

  // ===================================================================
  // Auto-vectorizer battery — counted array loops widened to v128 SIMD.
  // Each kernel is verified bit-identical (interp = V8 = VM) at -O0..-O3,
  // so the 4-wide vector main loop + scalar remainder it lowers to at -O2+
  // must agree exactly with the scalar loop at -O0. Lengths are chosen to
  // straddle a multiple of 4 (so the remainder loop is always exercised).
  // ===================================================================
  {
    name: 'vec-int-elementwise',
    source: `// c[i] = a[i]*b[i] + a[i] over an i32 array — three v128.loads, an i32x4.mul,
// an i32x4.add and a v128.store per four elements. Length 23 = 5·4 + 3.
fn sum(a: int[], n: int) -> int { let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + a[i]; } return s; }
fn main(){
  let n = 23;
  let a = int_array(n); let b = int_array(n); let c = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i - 7; b[i] = i * 3 - 2; }
  for (let i = 0; i < n; i = i + 1) { c[i] = a[i] * b[i] + a[i]; }
  print(sum(c, n)); print(c[0]); print(c[n - 1]); print(c[20]);
}`,
  },
  {
    name: 'vec-int-bitwise-wrap',
    source: `// Lanewise &, |, ^ plus a wrapping i32x4.mul — every lane must wrap mod 2^32
// exactly like the scalar imul. A few negative inputs exercise the sign bits.
fn main(){
  let n = 30;
  let a = int_array(n); let b = int_array(n); let r = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i * 87654321 - 13; b[i] = (i - 15) * 1000003; }
  for (let i = 0; i < n; i = i + 1) { r[i] = (a[i] & b[i]) | (a[i] ^ b[i]) * 7; }
  for (let i = 0; i < n; i = i + 1) { print(r[i]); }
}`,
  },
  {
    name: 'vec-f32-saxpy',
    source: `// The canonical SAXPY y[i] = a*x[i] + y[i] over f32 arrays: a splatted scalar,
// two v128.loads, an f32x4.mul, an f32x4.add, a v128.store. Length 18 = 4·4 + 2.
fn main(){
  let n = 18;
  let x = f32_array(n); let y = f32_array(n);
  for (let i = 0; i < n; i = i + 1) { x[i] = f32(i) * f32(0.5); y[i] = f32(100 - i); }
  let a = f32(2.25);
  for (let i = 0; i < n; i = i + 1) { y[i] = a * x[i] + y[i]; }
  for (let i = 0; i < n; i = i + 1) { print(y[i]); }
}`,
  },
  {
    name: 'vec-f32-fused',
    source: `// A longer f32 expression (mul, div, sub) to exercise f32x4.div and
// single-precision rounding per lane (the round-trip must match the scalar).
fn main(){
  let n = 21;
  let a = f32_array(n); let b = f32_array(n); let c = f32_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = f32(i + 1); b[i] = f32(2 * i + 3); }
  for (let i = 0; i < n; i = i + 1) { c[i] = a[i] * a[i] / b[i] - b[i]; }
  for (let i = 0; i < n; i = i + 1) { print(c[i]); }
}`,
  },
  {
    name: 'vec-inplace-alias',
    source: `// In-place update a[i] = a[i] + a[i]: the load and store address the SAME array
// at the SAME index, so the vstore/vload pair is within-lane — soundness must
// hold under aliasing. Length 20 (a clean multiple of 4: no remainder).
fn main(){
  let n = 20;
  let a = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i * i - 50; }
  for (let i = 0; i < n; i = i + 1) { a[i] = a[i] + a[i] * 3; }
  let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + a[i]; } print(s);
}`,
  },
  {
    name: 'vec-runtime-bound',
    source: `// A runtime trip count passed as a parameter (not a constant): the "4 more?"
// guard must compute the vector/remainder split at run time, for many lengths
// including 0,1,2,3 (all-remainder) and exact multiples of 4. The fused kernel
// a[i] = a[i]*k + b[i] (k and the two array handles all loop-invariant) is the
// part that widens; checksum stays scalar.
fn fuse(a: int[], b: int[], n: int, k: int) { for (let i = 0; i < n; i = i + 1) { a[i] = a[i] * k + b[i]; } }
fn checksum(a: int[], n: int) -> int { let s = 0; for (let i = 0; i < n; i = i + 1) { s = s * 31 + a[i]; } return s; }
fn main(){
  for (let n = 0; n <= 17; n = n + 1) {
    let a = int_array(n + 1); let b = int_array(n + 1);
    for (let i = 0; i < n; i = i + 1) { a[i] = (i + 1) * (i + 1); b[i] = i * 7 - 3; }
    fuse(a, b, n, 5);
    print(checksum(a, n));
  }
}`,
  },
  {
    name: 'vec-copy-clear',
    source: `// Pure copy b[i] = a[i] (one vload, one vstore) and a splatted-constant clear
// a[i] = 0 (a splat + vstore, no load). Both are degenerate but must vectorize.
fn main(){
  let n = 26;
  let a = int_array(n); let b = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i * 7 - 3; }
  for (let i = 0; i < n; i = i + 1) { b[i] = a[i]; }
  for (let i = 0; i < n; i = i + 1) { a[i] = 0; }
  let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + b[i] - a[i]; } print(s);
}`,
  },
  {
    name: 'vec-decline-stencil',
    source: `// a[i] = a[i] + a[i-1] carries a true dependence (iteration i reads what i-1
// wrote): the subscript i-1 is not the IV, so the pass MUST decline and leave
// the scalar loop — proven by the result still matching at every -O level.
fn main(){
  let n = 19;
  let a = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i; }
  for (let i = 1; i < n; i = i + 1) { a[i] = a[i] + a[i - 1]; }
  for (let i = 0; i < n; i = i + 1) { print(a[i]); }
}`,
  },
  {
    name: 'vec-decline-reduction',
    source: `// A reduction s += a[i] has a second loop-carried value (the accumulator), so
// the pass declines (horizontal reduce is future work) — but the read of a[i]
// in a separate pure-map loop above it still vectorizes. Result must match.
fn main(){
  let n = 22;
  let a = int_array(n); let b = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i - 11; }
  for (let i = 0; i < n; i = i + 1) { b[i] = a[i] * a[i]; }
  let s = 0; let p = 1;
  for (let i = 0; i < n; i = i + 1) { s = s + b[i]; p = p * 3 + b[i]; }
  print(s); print(p);
}`,
  },
  {
    name: 'vec-nonzero-start',
    source: `// A loop that starts at a runtime offset and uses <= (inclusive bound): the
// guard polarity and the vector IV's init must both be honoured.
fn run(a: int[], lo: int, hi: int) { for (let i = lo; i <= hi; i = i + 1) { a[i] = a[i] + 1000; } }
fn main(){
  let n = 40;
  let a = int_array(n);
  for (let i = 0; i < n; i = i + 1) { a[i] = i * i; }
  run(a, 3, 33);
  let s = 0; for (let i = 0; i < n; i = i + 1) { s = s * 7 + a[i]; } print(s);
}`,
  },
];
