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

  // Everything below is transient: save the heap top now and reset it once the
  // (short) result string has been built, so a str(float) in a hot loop reuses
  // the same scratch instead of leaking it. The digit buffer and assembly buffer
  // are allocated above hp0 too — they are dead by the time the heap is reset,
  // and the result string (tens of bytes, far smaller than the digit buffer) is
  // re-allocated at hp0 without overlapping the still-readable assembly buffer.
  let hp0 = __heap_get();
  let dig = int_array(40);
  let buf = __alloc(64);

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
  __heap_set(hp0);              // free every transient bignum allocated above
  return __f_mkstr(buf, w);     // the result string is then allocated at hp0
}

// ---------------------------------------------------------------------------
// The inverse of str(float): parse_float — a *correctly rounded* decimal string
// to double (round to nearest, ties to even), reusing the same big-integer
// library. It is exact: form value = man * 10^E as num/den, scale by a power of
// two so the quotient has 53 bits, divide (binary long division), and round on
// the exact remainder. Subnormals and overflow-to-infinity are handled. It
// matches the reference interpreter (which runs the identical algorithm) and a
// fuzz proves both reproduce JS Number() over millions of strings.

// a := a + v  (v a small non-negative int), carrying from limb 0 up.
fn __bn_add_small(a: int[], v: int) -> int {
  let n = a[0];
  let i = 1;
  let carry = v;
  while (carry != 0) {
    let cur = i <= n ? a[i] : 0;
    let s = cur + carry;
    a[i] = s & 65535;
    carry = s >> 16;
    if (i > n) { n = i; }
    i = i + 1;
  }
  a[0] = n;
  return 0;
}

// Number of significant bits of a (0 for the zero value).
fn __bn_bitlen(a: int[]) -> int {
  let n = a[0];
  if (n == 0) { return 0; }
  let top = a[n];
  let bits = 0;
  while (top != 0) { bits = bits + 1; top = top >> 1; }
  return (n - 1) * 16 + bits;
}

// A := num << s, B := den   (s >= 0); else A := num, B := den << (-s).
fn __scale_ab(num: int[], den: int[], s: int, A: int[], B: int[]) -> int {
  __bn_copy(A, num); __bn_copy(B, den);
  if (s >= 0) { __bn_shl(A, s); } else { __bn_shl(B, 0 - s); }
  return 0;
}

// Q := floor(A / B), and R := A mod B, by binary long division. The quotient is
// known to fit in 53 bits here, so it is returned as a long; R is left in Rout.
fn __bn_divmod(A: int[], B: int[], Rout: int[]) -> long {
  Rout[0] = 0;
  let Q = 0L;
  let i = __bn_bitlen(A) - 1;
  while (i >= 0) {
    __bn_shl(Rout, 1);                          // R <<= 1
    let bit = (A[(i / 16) + 1] >> (i % 16)) & 1; // next bit of A
    if (bit != 0) {
      if (Rout[0] == 0) { Rout[0] = 1; Rout[1] = 1; } else { Rout[1] = Rout[1] | 1; }
    }
    Q = Q << 1L;
    if (__bn_cmp(Rout, B) >= 0) { __bn_sub(Rout, B); Q = Q | 1L; }
    i = i - 1;
  }
  return Q;
}

// Round-to-nearest-even decision from the exact remainder R over divisor B for a
// current quotient q: 1 if the fraction R/B rounds q up, else 0.
fn __round_even(R: int[], B: int[], q: long) -> int {
  let T = int_array(280);
  __bn_copy(T, R); __bn_mul_small(T, 2);
  let c = __bn_cmp(T, B);
  if (c > 0) { return 1; }
  if (c == 0 && (q & 1L) == 1L) { return 1; }
  return 0;
}

// value = man * 10^E, with sign neg, rounded to the nearest double.
fn __dec_to_double(neg: int, man: int[], E: int) -> float {
  if (man[0] == 0) { return __f64_from_bits(long(neg) << 63L); } // signed zero

  let num = int_array(220);
  let den = int_array(220);
  __bn_copy(num, man);
  __bn_set_small(den, 1);
  if (E >= 0) { __bn_mul_pow10(num, E); } else { __bn_mul_pow10(den, 0 - E); }

  let A = int_array(280);
  let B = int_array(280);
  let R = int_array(280);

  // scale so the 53-bit quotient lands in [2^52, 2^53)
  let s = 52 - (__bn_bitlen(num) - __bn_bitlen(den));
  __scale_ab(num, den, s, A, B);
  let Q = __bn_divmod(A, B, R);
  while (Q < 4503599627370496L) { s = s + 1; __scale_ab(num, den, s, A, B); Q = __bn_divmod(A, B, R); }
  while (Q >= 9007199254740992L) { s = s - 1; __scale_ab(num, den, s, A, B); Q = __bn_divmod(A, B, R); }
  let e2 = 52 - s;
  let biased = e2 + 1023;

  if (biased <= 0) {
    // subnormal: mantissa m = round(num * 2^1074 / den), exponent field 0
    __scale_ab(num, den, 1074, A, B);
    let m = __bn_divmod(A, B, R);
    if (__round_even(R, B, m) != 0) { m = m + 1L; }
    return __f64_from_bits((long(neg) << 63L) | m);
  }

  if (__round_even(R, B, Q) != 0) {
    Q = Q + 1L;
    if (Q == 9007199254740992L) { Q = 4503599627370496L; biased = biased + 1; }
  }
  if (biased >= 2047) { return __f64_from_bits((long(neg) << 63L) | (2047L << 52L)); } // +/- inf
  let mant = Q - 4503599627370496L;            // drop the implicit leading 1
  return __f64_from_bits((long(neg) << 63L) | (long(biased) << 52L) | mant);
}

// parse_float(s): the longest valid leading [sign] d* [. d*] [(e|E) [sign] d+]
// prefix, correctly rounded. Empty / digit-less input yields signed zero.
fn __parse_float(s: int) -> float {
  let hp0 = __heap_get();         // free man + every bignum below on the way out
  let n = __load32(s);
  let i = 0;
  let neg = 0;
  if (i < n) {
    let c = __load8(s + 8 + i);
    if (c == 45) { neg = 1; i = i + 1; } else if (c == 43) { i = i + 1; }
  }
  let man = int_array(180);
  man[0] = 0;
  let digits = 0;
  let fracDigits = 0;
  let sawDot = 0;
  let scanning = 1;
  while (i < n && scanning != 0) {
    let c = __load8(s + 8 + i);
    if (c >= 48 && c <= 57) {
      __bn_mul_small(man, 10); __bn_add_small(man, c - 48);
      digits = digits + 1;
      if (sawDot != 0) { fracDigits = fracDigits + 1; }
      i = i + 1;
    } else if (c == 46 && sawDot == 0) { sawDot = 1; i = i + 1; }
    else { scanning = 0; }
  }
  let result = 0.0;
  if (digits == 0) {
    result = __f64_from_bits(long(neg) << 63L);
  } else {
    let exp = 0;
    if (i < n) {
      let c = __load8(s + 8 + i);
      if (c == 101 || c == 69) {                   // 'e' / 'E'
        let j = i + 1;
        let eneg = 0;
        if (j < n) {
          let c2 = __load8(s + 8 + j);
          if (c2 == 45) { eneg = 1; j = j + 1; } else if (c2 == 43) { j = j + 1; }
        }
        let ed = 0;
        let ev = 0;
        let go = 1;
        while (j < n && go != 0) {
          let c2 = __load8(s + 8 + j);
          if (c2 < 48 || c2 > 57) { go = 0; }
          else { ev = ev * 10 + (c2 - 48); if (ev > 100000) { ev = 100000; } ed = ed + 1; j = j + 1; }
        }
        if (ed > 0) { exp = eneg != 0 ? 0 - ev : ev; i = j; }
      }
    }
    result = __dec_to_double(neg, man, exp - fracDigits);
  }
  __heap_set(hp0);
  return result;
}
`;

// ===========================================================================
// MATH_PRELUDE — Strata's transcendental math library, written in Strata.
//
// WebAssembly has no transcendental opcodes, so — unlike sqrt/floor/ceil/trunc/
// round/abs/fmin/fmax/copysign, each a single wasm op the interpreter mirrors
// with the matching `Math.*` — these functions cannot be a native op plus a host
// mirror (a hand-rolled polynomial never matches libm to the last ULP, and the
// differential harness demands byte-for-byte agreement). The resolution is to
// write each kernel exactly ONCE, here, in ordinary Strata. The wasm backend
// compiles and injects this prelude (like the string / Dragon4 runtimes); the
// reference interpreter runs THE SAME SOURCE through a cached sub-interpreter
// (see `mathKernel` in interp.ts). One source of truth ⇒ wasm and the oracle
// agree by construction at every optimization level.
//
// Every kernel uses only f64 `+ - * /`, comparisons, the native single-op
// builtins (sqrt/floor/trunc/abs/copysign/fmin/fmax), and the `__f64_bits` /
// `__f64_from_bits` reinterpret intrinsics for exact frexp/ldexp — each of which
// is already identical across the wasm backend and the interpreter. NaN is
// produced as `0.0/0.0` and ±inf as `±1.0/0.0` (float division never traps).
// ===========================================================================
export const MATH_PRELUDE = `
// 2^n for an integer n, built straight from the IEEE-754 exponent field. Values
// of n outside the normal range fold to inf / 0 via multiplication, so this and
// __ldexp never trap. (8.98846567431158e307 = 2^1023, 2.2250...e-308 = 2^-1022.)
fn __exp2i(n: int) -> float {
  if (n > 1023) { return __exp2i(n - 1023) * 8.98846567431158e307; }
  if (n < -1022) { return __exp2i(n + 1022) * 2.2250738585072014e-308; }
  let bits = (long(n) + 1023L) << 52L;
  return __f64_from_bits(bits);
}

// x * 2^n.
fn __ldexp(x: float, n: int) -> float { return x * __exp2i(n); }

// Unbiased base-2 exponent of a finite normal x != 0.
fn __ilogb(x: float) -> int {
  let bits = __f64_bits(x);
  return int((bits >> 52L) & 0x7FFL) - 1023;
}

// Natural logarithm. Decompose x = 2^e * m with m in [sqrt(1/2), sqrt(2)); then
// ln(m) = 2*(s + s^3/3 + s^5/5 + ...) with s = (m-1)/(m+1), |s| <= 0.1716, which
// converges fast, and ln(x) = e*ln2 + ln(m).
fn __ln(x: float) -> float {
  if (x != x) { return x; }
  if (x < 0.0) { return 0.0 / 0.0; }
  if (x == 0.0) { return -1.0 / 0.0; }
  if (x > 1.0e308) { return x; }
  let bits = __f64_bits(x);
  let e = int((bits >> 52L) & 0x7FFL) - 1023;
  let mbits = (bits & 0x000FFFFFFFFFFFFFL) | 0x3FF0000000000000L;
  let m = __f64_from_bits(mbits);
  if (m > 1.4142135623730951) { m = m * 0.5; e = e + 1; }
  let s = (m - 1.0) / (m + 1.0);
  let s2 = s * s;
  let term = s;
  let sum = s;
  let k = 1;
  while (k <= 12) { term = term * s2; sum = sum + term / float(2 * k + 1); k = k + 1; }
  return float(e) * 0.6931471805599453 + 2.0 * sum;
}

fn __log2(x: float) -> float { return __ln(x) * 1.4426950408889634; }
fn __log10(x: float) -> float { return __ln(x) * 0.4342944819032518; }

// ln(1+x), accurate near 0 via 2*atanh(s), s = x/(2+x) (no cancellation).
fn __log1p(x: float) -> float {
  if (x != x) { return x; }
  if (x <= -1.0) { if (x == -1.0) { return -1.0 / 0.0; } return 0.0 / 0.0; }
  if (abs(x) < 0.5) {
    let s = x / (2.0 + x);
    let s2 = s * s;
    let term = s;
    let sum = s;
    let k = 1;
    while (k <= 20) { term = term * s2; sum = sum + term / float(2 * k + 1); k = k + 1; }
    return 2.0 * sum;
  }
  return __ln(1.0 + x);
}

// exp(x). Cody–Waite range reduction x = k*ln2 + r with |r| <= ln2/2, then
// exp(r) by Taylor series and exp(x) = 2^k * exp(r).
fn __exp(x: float) -> float {
  if (x != x) { return x; }
  if (x > 709.782712893384) { return 1.0 / 0.0; }
  if (x < -745.1332191019412) { return 0.0; }
  let kf = floor(x * 1.4426950408889634 + 0.5);
  let r = (x - kf * 0.6931471803691238) - kf * 1.9082149292705877e-10;
  let term = 1.0;
  let sum = 1.0;
  let i = 1;
  while (i <= 13) { term = term * r / float(i); sum = sum + term; i = i + 1; }
  return __ldexp(sum, int(kf));
}

// exp(x) - 1, accurate near 0 (Taylor avoids the 1.0 cancellation).
fn __expm1(x: float) -> float {
  if (x != x) { return x; }
  if (abs(x) < 0.35) {
    let term = x;
    let sum = x;
    let k = 2;
    while (k <= 16) { term = term * x / float(k); sum = sum + term; k = k + 1; }
    return sum;
  }
  return __exp(x) - 1.0;
}

// sin/cos kernels on a reduced argument r in [-pi/4, pi/4] (Taylor).
fn __sin_k(r: float) -> float {
  let r2 = r * r;
  let term = r;
  let sum = r;
  let k = 1;
  while (k <= 8) { term = 0.0 - term * r2 / float((2 * k) * (2 * k + 1)); sum = sum + term; k = k + 1; }
  return sum;
}
fn __cos_k(r: float) -> float {
  let r2 = r * r;
  let term = 1.0;
  let sum = 1.0;
  let k = 1;
  while (k <= 8) { term = 0.0 - term * r2 / float((2 * k - 1) * (2 * k)); sum = sum + term; k = k + 1; }
  return sum;
}

// Argument reduction: n = round(x*2/pi); r = x - n*(pi/2) using a two-part pi/2
// (Cody–Waite) for extra precision. Accurate for |x| up to ~1e8; beyond that the
// two-part reduction loses bits (a documented limitation — true Payne–Hanek is
// out of scope). The low 2 bits of n pick the quadrant.
fn __sin(x: float) -> float {
  if (x != x) { return x; }
  if (abs(x) > 1.0e308) { return 0.0 / 0.0; }
  let nf = floor(x * 0.6366197723675814 + 0.5);
  let q = int(nf) & 3;
  let r = (x - nf * 1.5707963267341256) - nf * 6.077100506506192e-11;
  if (q == 0) { return __sin_k(r); }
  if (q == 1) { return __cos_k(r); }
  if (q == 2) { return 0.0 - __sin_k(r); }
  return 0.0 - __cos_k(r);
}
fn __cos(x: float) -> float {
  if (x != x) { return x; }
  if (abs(x) > 1.0e308) { return 0.0 / 0.0; }
  let nf = floor(x * 0.6366197723675814 + 0.5);
  let q = int(nf) & 3;
  let r = (x - nf * 1.5707963267341256) - nf * 6.077100506506192e-11;
  if (q == 0) { return __cos_k(r); }
  if (q == 1) { return 0.0 - __sin_k(r); }
  if (q == 2) { return 0.0 - __cos_k(r); }
  return __sin_k(r);
}
fn __tan(x: float) -> float { return __sin(x) / __cos(x); }

// atan via reciprocal reduction to [0,1] then the half-angle identity
// atan(t) = 2*atan(t/(1+sqrt(1+t^2))) repeated until t is tiny, then a short
// polynomial; atan(orig) = 2^s * atan(t_small).
fn __atan(x: float) -> float {
  if (x != x) { return x; }
  let neg = x < 0.0;
  let t = abs(x);
  if (t > 1.0e308) { return copysign(1.5707963267948966, x); }
  let recip = false;
  if (t > 1.0) { t = 1.0 / t; recip = true; }
  let s = 0;
  while (t > 0.05) { t = t / (1.0 + sqrt(1.0 + t * t)); s = s + 1; }
  let t2 = t * t;
  let term = t;
  let sum = t;
  let k = 1;
  while (k <= 7) { term = 0.0 - term * t2; sum = sum + term / float(2 * k + 1); k = k + 1; }
  let r = __ldexp(sum, s);
  if (recip) { r = 1.5707963267948966 - r; }
  if (neg) { r = 0.0 - r; }
  return r;
}
fn __asin(x: float) -> float {
  if (x != x) { return x; }
  if (x > 1.0 || x < -1.0) { return 0.0 / 0.0; }
  if (x == 1.0) { return 1.5707963267948966; }
  if (x == -1.0) { return -1.5707963267948966; }
  return __atan(x / sqrt(1.0 - x * x));
}
fn __acos(x: float) -> float {
  if (x != x) { return x; }
  return 1.5707963267948966 - __asin(x);
}
fn __atan2(y: float, x: float) -> float {
  if (x != x) { return x; }
  if (y != y) { return y; }
  if (x > 0.0) { return __atan(y / x); }
  if (x < 0.0) {
    if (y >= 0.0) { return __atan(y / x) + 3.141592653589793; }
    return __atan(y / x) - 3.141592653589793;
  }
  if (y > 0.0) { return 1.5707963267948966; }
  if (y < 0.0) { return -1.5707963267948966; }
  return 0.0;
}

// pow via exp(y*ln(x)) with the usual special cases; negative base only for
// integer exponents (sign from the exponent's parity).
fn __pow(x: float, y: float) -> float {
  if (x != x) { return x; }
  if (y != y) { return y; }
  if (y == 0.0) { return 1.0; }
  if (x == 1.0) { return 1.0; }
  if (x > 0.0) { return __exp(y * __ln(x)); }
  if (x == 0.0) { if (y > 0.0) { return 0.0; } return 1.0 / 0.0; }
  let yi = trunc(y);
  if (yi != y) { return 0.0 / 0.0; }
  let r = __exp(y * __ln(0.0 - x));
  let half = yi * 0.5;
  if (trunc(half) != half) { return 0.0 - r; }
  return r;
}

// Cube root: exponent/3 initial guess from the bits, refined by Newton.
fn __cbrt(x: float) -> float {
  if (x != x) { return x; }
  if (x == 0.0) { return x; }
  if (abs(x) > 1.0e308) { return x; }
  let neg = x < 0.0;
  let a = abs(x);
  let e = __ilogb(a);
  let y = __exp2i(e / 3);
  let i = 0;
  while (i < 7) { y = (2.0 * y + a / (y * y)) / 3.0; i = i + 1; }
  if (neg) { return 0.0 - y; }
  return y;
}

// Hyperbolic functions. Near 0 they route through expm1 to avoid cancellation.
fn __sinh(x: float) -> float {
  if (x != x) { return x; }
  let a = abs(x);
  if (a > 709.0) { return copysign(1.0 / 0.0, x); }
  if (a < 1.0) { return (__expm1(x) - __expm1(0.0 - x)) * 0.5; }
  let e = __exp(a);
  return copysign((e - 1.0 / e) * 0.5, x);
}
fn __cosh(x: float) -> float {
  if (x != x) { return x; }
  let a = abs(x);
  if (a > 709.0) { return 1.0 / 0.0; }
  let e = __exp(a);
  return (e + 1.0 / e) * 0.5;
}
fn __tanh(x: float) -> float {
  if (x != x) { return x; }
  let a = abs(x);
  if (a > 20.0) { return copysign(1.0, x); }
  let e = __expm1(2.0 * a);
  return copysign(e / (e + 2.0), x);
}

// hypot with scaling to avoid intermediate overflow/underflow.
fn __hypot(x: float, y: float) -> float {
  let ax = abs(x);
  let ay = abs(y);
  if (ax > 1.0e308 || ay > 1.0e308) { return 1.0 / 0.0; }
  let m = fmax(ax, ay);
  let n = fmin(ax, ay);
  if (m == 0.0) { return 0.0; }
  let r = n / m;
  return m * sqrt(1.0 + r * r);
}

// IEEE remainder by repeated scaled subtraction (the classic binary fmod). The
// result has the sign of x and magnitude < |y|.
fn __fmod(x: float, y: float) -> float {
  if (x != x) { return x; }
  if (y != y) { return y; }
  let b = abs(y);
  if (b == 0.0) { return 0.0 / 0.0; }
  let a = abs(x);
  if (a > 1.0e308) { return 0.0 / 0.0; }
  if (b > 1.0e308) { return x; }
  if (a < b) { return x; }
  if (a == b) { return copysign(0.0, x); }
  let eb = __ilogb(b);
  while (a >= b) {
    let d = __ilogb(a) - eb;
    let scaled = __ldexp(b, d);
    if (scaled > a) { scaled = __ldexp(b, d - 1); }
    a = a - scaled;
  }
  return copysign(a, x);
}
`;
