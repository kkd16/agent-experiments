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
