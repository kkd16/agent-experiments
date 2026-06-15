// The string runtime, written in Strata itself.
//
// Strings are heap objects laid out exactly like arrays: an 8-byte header whose
// first word is the byte length, followed by the raw (Latin-1) bytes. These
// helpers manipulate that representation through the low-level memory intrinsics
// (`__alloc`, `__load8/32`, `__store8/32`) which are only available while
// type-checking this prelude. The builder injects calls to these functions when
// it lowers `+`, `==`/`!=`, `str()` and `char()` on strings.
//
// Because the prelude is compiled by the very same lexer → parser → SSA →
// optimizer → wasm backend as user code, the differential test harness (wasm vs.
// the reference interpreter) exercises this runtime at every optimization level.
export const STRING_PRELUDE = `
// Concatenate two strings into a freshly allocated string.
fn __strcat(a: int, b: int) -> int {
  let la = __load32(a);
  let lb = __load32(b);
  let p = __alloc(la + lb + 8);
  __store32(p, la + lb);
  let i = 0;
  while (i < la) { __store8(p + 8 + i, __load8(a + 8 + i)); i = i + 1; }
  let j = 0;
  while (j < lb) { __store8(p + 8 + la + j, __load8(b + 8 + j)); j = j + 1; }
  return p;
}

// Byte-wise string equality (1 = equal, 0 = not). Pointer-equal strings (e.g. two
// references to the same interned literal) short-circuit immediately.
fn __streq(a: int, b: int) -> int {
  if (a == b) { return 1; }
  let la = __load32(a);
  if (la != __load32(b)) { return 0; }
  let i = 0;
  while (i < la) {
    if (__load8(a + 8 + i) != __load8(b + 8 + i)) { return 0; }
    i = i + 1;
  }
  return 1;
}

// Make a one-byte string from a character code (low 8 bits).
fn __char(c: int) -> int {
  let p = __alloc(9);
  __store32(p, 1);
  __store8(p + 8, c & 255);
  return p;
}

// Decimal rendering of a signed 32-bit integer — matches the interpreter's
// formatInt exactly, including INT_MIN (handled without negating, so no overflow).
fn __int_to_str(n: int) -> int {
  let buf = __alloc(16);
  let pos = 16;
  let neg = n < 0;
  if (n == 0) { pos = pos - 1; __store8(buf + pos, 48); }
  while (n != 0) {
    let d = n % 10;
    if (d < 0) { d = 0 - d; }
    pos = pos - 1;
    __store8(buf + pos, 48 + d);
    n = n / 10;
  }
  let digits = 16 - pos;
  let total = digits + (neg ? 1 : 0);
  let p = __alloc(total + 8);
  __store32(p, total);
  let w = 8;
  if (neg) { __store8(p + 8, 45); w = 9; }
  let i = 0;
  while (i < digits) {
    __store8(p + w + i, __load8(buf + pos + i));
    i = i + 1;
  }
  return p;
}

// Decimal rendering of a signed 64-bit integer — the long counterpart of
// __int_to_str, matching the interpreter's formatLong including INT64_MIN (the
// minus and the digits are produced without ever negating n, so no overflow).
fn __long_to_str(n: long) -> int {
  let buf = __alloc(24);
  let pos = 24;
  let neg = n < 0L;
  if (n == 0L) { pos = pos - 1; __store8(buf + pos, 48); }
  while (n != 0L) {
    let d = n % 10L;
    if (d < 0L) { d = 0L - d; }
    pos = pos - 1;
    __store8(buf + pos, 48 + int(d));
    n = n / 10L;
  }
  let digits = 24 - pos;
  let total = digits + (neg ? 1 : 0);
  let p = __alloc(total + 8);
  __store32(p, total);
  let w = 8;
  if (neg) { __store8(p + 8, 45); w = 9; }
  let i = 0;
  while (i < digits) {
    __store8(p + w + i, __load8(buf + pos + i));
    i = i + 1;
  }
  return p;
}

// Boolean rendering. The two results are ordinary string literals, so they are
// interned into the static data segment like any other.
fn __bool_to_str(b: int) -> str {
  return b != 0 ? "true" : "false";
}

// Lexicographic byte comparison: negative / zero / positive, like C's strcmp.
fn __strcmp(a: int, b: int) -> int {
  let la = __load32(a);
  let lb = __load32(b);
  let n = la < lb ? la : lb;
  let i = 0;
  while (i < n) {
    let ca = __load8(a + 8 + i);
    let cb = __load8(b + 8 + i);
    if (ca != cb) { return ca - cb; }
    i = i + 1;
  }
  return la - lb;
}

// Substring [start, start+count), with start/count clamped into range.
fn __substr(s: int, start: int, count: int) -> int {
  let n = __load32(s);
  if (start < 0) { start = 0; }
  if (start > n) { start = n; }
  if (count < 0) { count = 0; }
  if (start + count > n) { count = n - start; }
  let p = __alloc(count + 8);
  __store32(p, count);
  let i = 0;
  while (i < count) { __store8(p + 8 + i, __load8(s + 8 + start + i)); i = i + 1; }
  return p;
}

// First index of byte c, or -1.
fn __index_of(s: int, c: int) -> int {
  let n = __load32(s);
  let i = 0;
  while (i < n) {
    if (__load8(s + 8 + i) == c) { return i; }
    i = i + 1;
  }
  return 0 - 1;
}

// ASCII upper-casing (bytes a-z) into a fresh string.
fn __to_upper(s: int) -> int {
  let n = __load32(s);
  let p = __alloc(n + 8);
  __store32(p, n);
  let i = 0;
  while (i < n) {
    let c = __load8(s + 8 + i);
    if (c >= 97 && c <= 122) { c = c - 32; }
    __store8(p + 8 + i, c);
    i = i + 1;
  }
  return p;
}

// ASCII lower-casing (bytes A-Z) into a fresh string.
fn __to_lower(s: int) -> int {
  let n = __load32(s);
  let p = __alloc(n + 8);
  __store32(p, n);
  let i = 0;
  while (i < n) {
    let c = __load8(s + 8 + i);
    if (c >= 65 && c <= 90) { c = c + 32; }
    __store8(p + 8 + i, c);
    i = i + 1;
  }
  return p;
}

// ----- extended string library -----------------------------------------------

// Whitespace test: space (32) and the control range tab..CR (bytes 9..13).
fn __is_ws(c: int) -> int { return int(c == 32 || (c >= 9 && c <= 13)); }

// Repeat s n times (n <= 0 -> empty string).
fn __repeat(s: int, n: int) -> int {
  let ls = __load32(s);
  if (n < 0) { n = 0; }
  let total = ls * n;
  let p = __alloc(total + 8);
  __store32(p, total);
  let w = 0;
  let k = 0;
  while (k < n) {
    let i = 0;
    while (i < ls) { __store8(p + 8 + w, __load8(s + 8 + i)); w = w + 1; i = i + 1; }
    k = k + 1;
  }
  return p;
}

// Strip leading/trailing whitespace.
fn __trim(s: int) -> int {
  let n = __load32(s);
  let a = 0;
  while (a < n && __is_ws(__load8(s + 8 + a)) != 0) { a = a + 1; }
  let b = n;
  while (b > a && __is_ws(__load8(s + 8 + b - 1)) != 0) { b = b - 1; }
  return __substr(s, a, b - a);
}

// First index of substring 'sub' at or after 'from', or -1. An empty needle
// matches at 'from' (mirrors the interpreter and JS indexOf).
fn __find_from(s: int, sub: int, from: int) -> int {
  let ns = __load32(s);
  let nb = __load32(sub);
  if (nb == 0) { return from; }
  let i = from;
  while (i + nb <= ns) {
    let j = 0;
    while (j < nb && __load8(s + 8 + i + j) == __load8(sub + 8 + j)) { j = j + 1; }
    if (j == nb) { return i; }
    i = i + 1;
  }
  return 0 - 1;
}

fn __find(s: int, sub: int) -> int { return __find_from(s, sub, 0); }
fn __contains(s: int, sub: int) -> int { return int(__find_from(s, sub, 0) >= 0); }

fn __starts_with(s: int, pre: int) -> int {
  let np = __load32(pre);
  if (np > __load32(s)) { return 0; }
  let i = 0;
  while (i < np) {
    if (__load8(s + 8 + i) != __load8(pre + 8 + i)) { return 0; }
    i = i + 1;
  }
  return 1;
}

fn __ends_with(s: int, suf: int) -> int {
  let nf = __load32(suf);
  let ns = __load32(s);
  if (nf > ns) { return 0; }
  let off = ns - nf;
  let i = 0;
  while (i < nf) {
    if (__load8(s + 8 + off + i) != __load8(suf + 8 + i)) { return 0; }
    i = i + 1;
  }
  return 1;
}

// Replace every non-overlapping occurrence of 'fnd' with 'repl' (two passes:
// count, then fill). An empty needle returns the input unchanged.
fn __replace(s: int, fnd: int, repl: int) -> int {
  let ns = __load32(s);
  let nf = __load32(fnd);
  let nr = __load32(repl);
  if (nf == 0) { return s; }
  let count = 0;
  let i = 0;
  while (i + nf <= ns) {
    let k = __find_from(s, fnd, i);
    if (k < 0) { break; }
    count = count + 1;
    i = k + nf;
  }
  let outLen = ns + count * (nr - nf);
  let p = __alloc(outLen + 8);
  __store32(p, outLen);
  let w = 0;
  let r = 0;
  while (r < ns) {
    let k = __find_from(s, fnd, r);
    if (k < 0) {
      while (r < ns) { __store8(p + 8 + w, __load8(s + 8 + r)); w = w + 1; r = r + 1; }
    } else {
      while (r < k) { __store8(p + 8 + w, __load8(s + 8 + r)); w = w + 1; r = r + 1; }
      let t = 0;
      while (t < nr) { __store8(p + 8 + w, __load8(repl + 8 + t)); w = w + 1; t = t + 1; }
      r = k + nf;
    }
  }
  return p;
}

// Parse an optional sign followed by decimal digits; stop at the first non-digit.
// Accumulation wraps as i32, exactly like the interpreter.
fn __parse_int(s: int) -> int {
  let n = __load32(s);
  let i = 0;
  let neg = 0;
  if (i < n) {
    let c = __load8(s + 8 + i);
    if (c == 45) { neg = 1; i = i + 1; }
    else if (c == 43) { i = i + 1; }
  }
  let acc = 0;
  while (i < n) {
    let c = __load8(s + 8 + i);
    if (c < 48 || c > 57) { break; }
    acc = acc * 10 + (c - 48);
    i = i + 1;
  }
  if (neg != 0) { acc = 0 - acc; }
  return acc;
}

// ----- str[] (arrays of strings) ---------------------------------------------
// A str[] is laid out like an int[]: an 8-byte header whose first word is the
// element count, followed by that many i32 string pointers.

// Split s on a non-empty separator into segments (an empty separator yields a
// single-element array holding s). The algorithm is duplicated verbatim in the
// interpreter so the two cannot disagree on edge cases (trailing/empty fields).
fn __split(s: int, sep: int) -> int {
  let ns = __load32(s);
  let nsep = __load32(sep);
  if (nsep == 0) {
    let one = __alloc(4 + 8);
    __store32(one, 1);
    __store32(one + 8, s);
    return one;
  }
  // pass 1: number of segments = occurrences + 1
  let count = 1;
  let i = 0;
  while (i + nsep <= ns) {
    let k = __find_from(s, sep, i);
    if (k < 0) { break; }
    count = count + 1;
    i = k + nsep;
  }
  let arr = __alloc(count * 4 + 8);
  __store32(arr, count);
  // pass 2: fill segment pointers
  let w = 0;
  let start = 0;
  while (w < count - 1) {
    let k = __find_from(s, sep, start);
    let seg = __substr(s, start, k - start);
    __store32(arr + 8 + w * 4, seg);
    w = w + 1;
    start = k + nsep;
  }
  let last = __substr(s, start, ns - start);
  __store32(arr + 8 + w * 4, last);
  return arr;
}

// Concatenate the elements of a str[] with sep between them.
fn __join(arr: int, sep: int) -> int {
  let n = __load32(arr);
  let nsep = __load32(sep);
  if (n == 0) {
    let e = __alloc(8);
    __store32(e, 0);
    return e;
  }
  let total = (n - 1) * nsep;
  let i = 0;
  while (i < n) {
    total = total + __load32(__load32(arr + 8 + i * 4));
    i = i + 1;
  }
  let p = __alloc(total + 8);
  __store32(p, total);
  let w = 0;
  i = 0;
  while (i < n) {
    if (i > 0) {
      let j = 0;
      while (j < nsep) { __store8(p + 8 + w, __load8(sep + 8 + j)); w = w + 1; j = j + 1; }
    }
    let el = __load32(arr + 8 + i * 4);
    let le = __load32(el);
    let j2 = 0;
    while (j2 < le) { __store8(p + 8 + w, __load8(el + 8 + j2)); w = w + 1; j2 = j2 + 1; }
    i = i + 1;
  }
  return p;
}
`;

// ---------------------------------------------------------------------------
// The floating-point formatting runtime — also written in Strata, and likewise
// compiled by this very pipeline (so the differential harness exercises it at
// every optimization level). It implements `str(float)` / `print(str(...))` of a
// double: the *shortest decimal string that round-trips back to the same f64*,
// formatted exactly like ECMAScript's `Number::toString` (and therefore exactly
// like the reference interpreter's `String(x)` oracle).
//
// The shortest digits come from **Dragon4** (Steele & White's "free-format"
// algorithm; Burger & Dubois, "Printing Floating-Point Numbers Quickly and
// Accurately"): exact rational arithmetic in big integers R / S / m+ / m- whose
// boundaries (closed when the significand is even) decide the shortest correctly
// rounded digit sequence. Because the language has no bignum, one is built here
// out of base-2^16 limbs held in an `int[]` (slot 0 = limb count, slots 1.. =
// little-endian limbs) — a tiny self-contained arbitrary-precision library. The
// digits are then laid out per the ECMA-262 Number-to-String notation rules
// (fixed vs. exponential, decimal-point placement). It needs only the low-level
// memory intrinsics plus `__f64_bits` (the IEEE-754 reinterpret), so it is fully
// self-contained and pulled in only when a program formats a float.
export const FLOAT_PRELUDE = `
// ---- base-2^16 big-integer helpers (operate in place on int[] handles) ----

// Drop leading zero limbs so the limb count is canonical (value 0 -> count 0).
fn __bn_norm(a: int[]) -> int {
  let n = a[0];
  while (n > 0 && a[n] == 0) { n = n - 1; }
  a[0] = n;
  return 0;
}

// a := v  (v a small non-negative int, < 2^16).
fn __bn_set_small(a: int[], v: int) -> int {
  if (v == 0) { a[0] = 0; } else { a[0] = 1; a[1] = v; }
  return 0;
}

// a := v  (v a non-negative 64-bit value), split into 16-bit little-endian limbs.
fn __bn_from_long(a: int[], v: long) -> int {
  let n = 0;
  while (v != 0L) {
    n = n + 1;
    a[n] = int(v & 65535L);
    v = v >> 16L;
  }
  a[0] = n;
  return 0;
}

// Magnitude comparison: -1 if a<b, 0 if equal, 1 if a>b. Both must be normalized.
fn __bn_cmp(a: int[], b: int[]) -> int {
  let la = a[0]; let lb = b[0];
  if (la != lb) { return la < lb ? 0 - 1 : 1; }
  let i = la;
  while (i >= 1) {
    if (a[i] != b[i]) { return a[i] < b[i] ? 0 - 1 : 1; }
    i = i - 1;
  }
  return 0;
}

// dst := src.
fn __bn_copy(dst: int[], src: int[]) -> int {
  let n = src[0];
  dst[0] = n;
  let i = 1;
  while (i <= n) { dst[i] = src[i]; i = i + 1; }
  return 0;
}

// a := a * m  (m small, e.g. 2 / 10 / 10000), carrying through the limbs.
fn __bn_mul_small(a: int[], m: int) -> int {
  let n = a[0];
  let carry = 0;
  let i = 1;
  while (i <= n) {
    let p = a[i] * m + carry;
    a[i] = p & 65535;
    carry = p >> 16;
    i = i + 1;
  }
  while (carry != 0) {
    n = n + 1;
    a[n] = carry & 65535;
    carry = carry >> 16;
  }
  a[0] = n;
  return 0;
}

// a := a * 10^k  (k >= 0), in 4-digit chunks for speed.
fn __bn_mul_pow10(a: int[], k: int) -> int {
  while (k >= 4) { __bn_mul_small(a, 10000); k = k - 4; }
  while (k > 0) { __bn_mul_small(a, 10); k = k - 1; }
  return 0;
}

// a := a + b.
fn __bn_add(a: int[], b: int[]) -> int {
  let na = a[0];
  let nb = b[0];
  let n = na; if (nb > n) { n = nb; }
  let carry = 0;
  let i = 1;
  while (i <= n) {
    let av = 0; if (i <= na) { av = a[i]; }
    let bv = 0; if (i <= nb) { bv = b[i]; }
    let s = av + bv + carry;
    a[i] = s & 65535;
    carry = s >> 16;
    i = i + 1;
  }
  if (carry != 0) { n = n + 1; a[n] = carry; }
  a[0] = n;
  return 0;
}

// a := a - b   (requires a >= b).
fn __bn_sub(a: int[], b: int[]) -> int {
  let na = a[0];
  let nb = b[0];
  let borrow = 0;
  let i = 1;
  while (i <= na) {
    let bv = 0; if (i <= nb) { bv = b[i]; }
    let s = a[i] - bv - borrow;
    if (s < 0) { s = s + 65536; borrow = 1; } else { borrow = 0; }
    a[i] = s;
    i = i + 1;
  }
  __bn_norm(a);
  return 0;
}

// a := a << bits  (a left shift by an arbitrary bit count).
fn __bn_shl(a: int[], bits: int) -> int {
  let n = a[0];
  if (n == 0) { return 0; }
  let bitShift = bits % 16;
  if (bitShift != 0) {
    let carry = 0;
    let i = 1;
    while (i <= n) {
      let v = (a[i] << bitShift) | carry;
      a[i] = v & 65535;
      carry = v >> 16;
      i = i + 1;
    }
    if (carry != 0) { n = n + 1; a[n] = carry; }
    a[0] = n;
  }
  let limbShift = bits / 16;
  if (limbShift > 0) {
    let i = n;
    while (i >= 1) { a[i + limbShift] = a[i]; i = i - 1; }
    let j = 1;
    while (j <= limbShift) { a[j] = 0; j = j + 1; }
    a[0] = n + limbShift;
  }
  return 0;
}

// ---- tiny string builders (avoid a dependency on the string prelude) ----

fn __f_cstr1(c: int) -> int { let p = __alloc(9); __store32(p, 1); __store8(p + 8, c); return p; }
fn __f_nan() -> int { let p = __alloc(11); __store32(p, 3); __store8(p + 8, 110); __store8(p + 9, 97); __store8(p + 10, 110); return p; }
fn __f_inf() -> int { let p = __alloc(11); __store32(p, 3); __store8(p + 8, 105); __store8(p + 9, 110); __store8(p + 10, 102); return p; }
fn __f_ninf() -> int { let p = __alloc(12); __store32(p, 4); __store8(p + 8, 45); __store8(p + 9, 105); __store8(p + 10, 110); __store8(p + 11, 102); return p; }

// Write the decimal digits of v (v >= 0) into buf at offset w; return new offset.
fn __f_wuint(buf: int, w: int, v: int) -> int {
  if (v == 0) { __store8(buf + w, 48); return w + 1; }
  let tmp = int_array(12);
  let nd = 0;
  while (v > 0) { nd = nd + 1; tmp[nd] = v % 10; v = v / 10; }
  let i = nd;
  while (i >= 1) { __store8(buf + w, 48 + tmp[i]); w = w + 1; i = i - 1; }
  return w;
}

// Copy len raw bytes from buf into a fresh heap string object.
fn __f_mkstr(buf: int, len: int) -> int {
  let p = __alloc(len + 8);
  __store32(p, len);
  let i = 0;
  while (i < len) { __store8(p + 8 + i, __load8(buf + i)); i = i + 1; }
  return p;
}

// The shortest-round-trip double formatter.
fn __float_to_str(x: float) -> int {
  if (x != x) { return __f_nan(); }                       // NaN
  let bits = __f64_bits(x);
  let expField = int((bits >> 52L) & 2047L);
  let mant = bits & 4503599627370495L;                    // low 52 bits
  if (expField == 2047) {                                 // +/- Infinity
    if (bits < 0L) { return __f_ninf(); }
    return __f_inf();
  }
  if (expField == 0 && mant == 0L) { return __f_cstr1(48); } // +/-0 -> "0"

  let neg = bits < 0L ? 1 : 0;
  let f = 0L; let e = 0;
  if (expField == 0) { f = mant; e = 0 - 1074; }          // subnormal
  else { f = mant + 4503599627370496L; e = expField - 1075; } // normal (add 2^52)
  // closed (inclusive) boundaries when the significand is even
  let even = int((f & 1L) == 0L);
  // unequal margins: a power-of-two significand that is not the smallest normal
  let lowClose = int(mant == 0L && expField > 1);

  // Dragon4 setup: build R, S, m+ (mp), m- (mm) as exact big integers.
  let R = int_array(110); let S = int_array(110);
  let mp = int_array(110); let mm = int_array(110);
  let T = int_array(110); let R2 = int_array(110);
  if (e >= 0) {
    if (lowClose != 0) {
      __bn_from_long(R, f); __bn_shl(R, e + 2);
      __bn_set_small(S, 4);
      __bn_set_small(mp, 1); __bn_shl(mp, e + 1);
      __bn_set_small(mm, 1); __bn_shl(mm, e);
    } else {
      __bn_from_long(R, f); __bn_shl(R, e + 1);
      __bn_set_small(S, 2);
      __bn_set_small(mp, 1); __bn_shl(mp, e);
      __bn_set_small(mm, 1); __bn_shl(mm, e);
    }
  } else {
    if (lowClose != 0) {
      __bn_from_long(R, f); __bn_shl(R, 2);
      __bn_set_small(S, 1); __bn_shl(S, 2 - e);
      __bn_set_small(mp, 2);
      __bn_set_small(mm, 1);
    } else {
      __bn_from_long(R, f); __bn_shl(R, 1);
      __bn_set_small(S, 1); __bn_shl(S, 1 - e);
      __bn_set_small(mp, 1);
      __bn_set_small(mm, 1);
    }
  }

  // Decimal-exponent estimate k = ceil(bexp * log10(2) - 1e-10), bexp the binary
  // exponent of x (= e + bitlength(f) - 1). The two fixups below make the digit
  // count exact regardless of any rounding in this estimate.
  let bexp = e + (64 - int(clz(f))) - 1;
  let k = int(ceil(float(bexp) * 0.30102999566398114 - 0.0000000001));
  if (k >= 0) { __bn_mul_pow10(S, k); }
  else { __bn_mul_pow10(R, 0 - k); __bn_mul_pow10(mp, 0 - k); __bn_mul_pow10(mm, 0 - k); }

  // Fixup 1: if value+m+ already reaches the next decade, shift the point right.
  let go = 1;
  while (go != 0) {
    __bn_copy(T, R); __bn_add(T, mp);
    let c = __bn_cmp(T, S);
    let high = even != 0 ? c >= 0 : c > 0;
    if (high) { __bn_mul_small(S, 10); k = k + 1; } else { go = 0; }
  }
  // Fixup 2: if even after one more digit it cannot reach S, shift the point left.
  go = 1;
  while (go != 0) {
    __bn_copy(T, R); __bn_add(T, mp); __bn_mul_small(T, 10);
    let c = __bn_cmp(T, S);
    let high = even != 0 ? c >= 0 : c > 0;
    if (high) { go = 0; }
    else { __bn_mul_small(R, 10); __bn_mul_small(mp, 10); __bn_mul_small(mm, 10); k = k - 1; }
  }

  // Generate digits until a boundary test fires, rounding the final digit.
  let dig = int_array(40);
  let nd = 0;
  let done = 0;
  while (done == 0) {
    __bn_mul_small(R, 10); __bn_mul_small(mp, 10); __bn_mul_small(mm, 10);
    let d = 0;
    while (__bn_cmp(R, S) >= 0) { __bn_sub(R, S); d = d + 1; }
    let cl = __bn_cmp(R, mm);
    let low = even != 0 ? cl <= 0 : cl < 0;
    __bn_copy(T, R); __bn_add(T, mp);
    let ch = __bn_cmp(T, S);
    let high = even != 0 ? ch >= 0 : ch > 0;
    if (!low && !high) {
      nd = nd + 1; dig[nd] = d;
    } else {
      let up = 0;
      if (high && low) {
        __bn_copy(R2, R); __bn_mul_small(R2, 2);
        let c2 = __bn_cmp(R2, S);
        if (c2 > 0) { up = 1; }
        else if (c2 == 0 && (d & 1) == 1) { up = 1; }   // exact tie -> round to even
      } else if (high) { up = 1; }
      nd = nd + 1; dig[nd] = d + up;
      done = 1;
    }
  }

  // Carry a final digit of 10 leftward (all-nines case grows a new leading 1).
  let n = k;
  let i = nd;
  while (i >= 1 && dig[i] == 10) {
    dig[i] = 0;
    if (i == 1) {
      let j = nd;
      while (j >= 1) { dig[j + 1] = dig[j]; j = j - 1; }
      dig[1] = 1; nd = nd + 1; n = n + 1; i = 0;
    } else { dig[i - 1] = dig[i - 1] + 1; i = i - 1; }
  }
  // Strip trailing zeros (shortest representation).
  while (nd > 1 && dig[nd] == 0) { nd = nd - 1; }

  // ---- ECMA-262 Number-to-String notation ----
  let buf = __alloc(64);
  let w = 0;
  if (neg != 0) { __store8(buf + w, 45); w = w + 1; }
  if (nd <= n && n <= 21) {
    // integer digits then (n - nd) trailing zeros
    let p = 1; while (p <= nd) { __store8(buf + w, 48 + dig[p]); w = w + 1; p = p + 1; }
    let z = 0; while (z < n - nd) { __store8(buf + w, 48); w = w + 1; z = z + 1; }
  } else if (0 < n && n <= 21) {
    // a decimal point after the first n digits
    let p = 1;
    while (p <= n) { __store8(buf + w, 48 + dig[p]); w = w + 1; p = p + 1; }
    __store8(buf + w, 46); w = w + 1;
    while (p <= nd) { __store8(buf + w, 48 + dig[p]); w = w + 1; p = p + 1; }
  } else if (0 - 6 < n && n <= 0) {
    // 0.00…digits
    __store8(buf + w, 48); w = w + 1; __store8(buf + w, 46); w = w + 1;
    let z = 0; while (z < 0 - n) { __store8(buf + w, 48); w = w + 1; z = z + 1; }
    let p = 1; while (p <= nd) { __store8(buf + w, 48 + dig[p]); w = w + 1; p = p + 1; }
  } else {
    // exponential: d[.ddd] 'e' sign exp
    let ex = n - 1;
    __store8(buf + w, 48 + dig[1]); w = w + 1;
    if (nd > 1) {
      __store8(buf + w, 46); w = w + 1;
      let p = 2; while (p <= nd) { __store8(buf + w, 48 + dig[p]); w = w + 1; p = p + 1; }
    }
    __store8(buf + w, 101); w = w + 1;            // 'e'
    let ea = ex;
    if (ex < 0) { __store8(buf + w, 45); w = w + 1; ea = 0 - ex; }
    else { __store8(buf + w, 43); w = w + 1; }    // '+'
    w = __f_wuint(buf, w, ea);
  }
  return __f_mkstr(buf, w);
}
`;
