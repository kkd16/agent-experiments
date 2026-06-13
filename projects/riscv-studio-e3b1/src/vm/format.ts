// Number-formatting helpers shared across the VM and UI.
//
// JavaScript numbers are IEEE-754 doubles; bitwise ops coerce to signed 32-bit. We
// consistently treat register/memory words as unsigned 32-bit for storage and convert
// to signed only for display or signed arithmetic.

/** Coerce any number to an unsigned 32-bit integer (0 .. 2^32-1). */
export function u32(x: number): number {
  return x >>> 0;
}

/** Coerce any number to a signed 32-bit integer (-2^31 .. 2^31-1). */
export function i32(x: number): number {
  return x | 0;
}

/** Zero-padded lowercase hex, e.g. toHex(255, 2) === 'ff'. */
export function toHex(value: number, digits = 8): string {
  return u32(value).toString(16).padStart(digits, '0');
}

/** `0x`-prefixed hex word. */
export function hexWord(value: number): string {
  return `0x${toHex(value, 8)}`;
}

/** 32-bit binary string grouped in nibbles for readability. */
export function toBin(value: number): string {
  const bits = u32(value).toString(2).padStart(32, '0');
  return bits.replace(/(.{4})(?=.)/g, '$1 ');
}

/** Sign-extend the low `bits` of `value` to a signed 32-bit integer. */
export function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

/** Render a word in the requested radix for the inspector. */
export type Radix = 'hex' | 'dec' | 'udec' | 'bin';

export function formatWord(value: number, radix: Radix): string {
  switch (radix) {
    case 'hex':
      return hexWord(value);
    case 'dec':
      return i32(value).toString(10);
    case 'udec':
      return u32(value).toString(10);
    case 'bin':
      return `0b${toBin(value)}`;
  }
}

/** Parse an integer literal in C-like syntax: decimal, 0x.., 0b.., 0o.., or a char 'a'. */
export function parseIntLiteral(raw: string): number | null {
  const s = raw.trim();
  if (s.length === 0) return null;

  // Character literal: 'a', '\n', '\0', '\t', '\\', '\''.
  const charMatch = s.match(/^'(\\.|[^'\\])'$/);
  if (charMatch) {
    return charCode(charMatch[1]);
  }

  let neg = false;
  let body = s;
  if (body[0] === '-') {
    neg = true;
    body = body.slice(1);
  } else if (body[0] === '+') {
    body = body.slice(1);
  }

  let value: number;
  if (/^0x[0-9a-f]+$/i.test(body)) value = parseInt(body.slice(2), 16);
  else if (/^0b[01]+$/i.test(body)) value = parseInt(body.slice(2), 2);
  else if (/^0o[0-7]+$/i.test(body)) value = parseInt(body.slice(2), 8);
  else if (/^[0-9]+$/.test(body)) value = parseInt(body, 10);
  else return null;

  if (!Number.isFinite(value)) return null;
  return neg ? -value : value;
}

/** Decode a single (possibly escaped) character to its code point. */
export function charCode(token: string): number {
  if (token.length === 1) return token.charCodeAt(0);
  switch (token) {
    case '\\n':
      return 10;
    case '\\t':
      return 9;
    case '\\r':
      return 13;
    case '\\0':
      return 0;
    case '\\\\':
      return 92;
    case "\\'":
      return 39;
    case '\\"':
      return 34;
    default:
      return token.charCodeAt(token.length - 1);
  }
}
