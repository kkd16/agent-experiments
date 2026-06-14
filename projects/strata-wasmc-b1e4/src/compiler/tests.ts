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
];
