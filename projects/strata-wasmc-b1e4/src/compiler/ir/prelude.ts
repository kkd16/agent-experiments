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
`;
