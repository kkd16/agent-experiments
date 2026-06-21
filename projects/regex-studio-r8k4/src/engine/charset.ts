// CharSet — an immutable set of Unicode code points, stored as sorted,
// merged, disjoint inclusive ranges [lo, hi]. This is the alphabet primitive
// the whole engine is built on: NFA edges, DFA alphabet partitioning and the
// pretty labels you see on the graphs all flow through here.

export const MAX_CODE_POINT = 0x10ffff;

export interface Range {
  lo: number;
  hi: number;
}

export class CharSet {
  // Invariant: ranges are sorted by lo, non-overlapping and non-adjacent.
  readonly ranges: readonly Range[];

  private constructor(ranges: Range[]) {
    this.ranges = ranges;
  }

  static empty(): CharSet {
    return new CharSet([]);
  }

  static fromRanges(input: Range[]): CharSet {
    const valid = input.filter((r) => r.lo <= r.hi).map((r) => ({ lo: r.lo, hi: r.hi }));
    valid.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const merged: Range[] = [];
    for (const r of valid) {
      const last = merged[merged.length - 1];
      if (last && r.lo <= last.hi + 1) {
        last.hi = Math.max(last.hi, r.hi);
      } else {
        merged.push({ lo: r.lo, hi: r.hi });
      }
    }
    return new CharSet(merged);
  }

  static fromChar(code: number): CharSet {
    return new CharSet([{ lo: code, hi: code }]);
  }

  static fromRange(lo: number, hi: number): CharSet {
    return CharSet.fromRanges([{ lo, hi }]);
  }

  static union(sets: CharSet[]): CharSet {
    const all: Range[] = [];
    for (const s of sets) all.push(...s.ranges.map((r) => ({ ...r })));
    return CharSet.fromRanges(all);
  }

  union(other: CharSet): CharSet {
    return CharSet.union([this, other]);
  }

  // Complement over the full Unicode range.
  negate(): CharSet {
    const out: Range[] = [];
    let next = 0;
    for (const r of this.ranges) {
      if (r.lo > next) out.push({ lo: next, hi: r.lo - 1 });
      next = Math.max(next, r.hi + 1);
    }
    if (next <= MAX_CODE_POINT) out.push({ lo: next, hi: MAX_CODE_POINT });
    return new CharSet(out);
  }

  intersect(other: CharSet): CharSet {
    const out: Range[] = [];
    let i = 0;
    let j = 0;
    while (i < this.ranges.length && j < other.ranges.length) {
      const a = this.ranges[i];
      const b = other.ranges[j];
      const lo = Math.max(a.lo, b.lo);
      const hi = Math.min(a.hi, b.hi);
      if (lo <= hi) out.push({ lo, hi });
      if (a.hi < b.hi) i++;
      else j++;
    }
    return new CharSet(out);
  }

  contains(code: number): boolean {
    let lo = 0;
    let hi = this.ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.ranges[mid];
      if (code < r.lo) hi = mid - 1;
      else if (code > r.hi) lo = mid + 1;
      else return true;
    }
    return false;
  }

  isEmpty(): boolean {
    return this.ranges.length === 0;
  }

  size(): number {
    let n = 0;
    for (const r of this.ranges) n += r.hi - r.lo + 1;
    return n;
  }

  // A representative code point, used when probing DFA transitions.
  sample(): number | null {
    return this.ranges.length ? this.ranges[0].lo : null;
  }

  // A *readable* representative: prefer a lowercase letter, digit, space, then
  // common punctuation, so synthesised strings (e.g. ReDoS attacks) are legible.
  // Falls back to the first code point in the set.
  samplePrintable(): number | null {
    if (this.isEmpty()) return null;
    const prefs = [
      0x61, 0x62, 0x63, // a b c
      0x30, 0x31, // 0 1
      0x20, // space
      0x2c, 0x2e, 0x2d, 0x5f, 0x40, // , . - _ @
      0x41, // A
    ];
    for (const c of prefs) if (this.contains(c)) return c;
    for (const r of this.ranges) {
      // first printable ASCII in any range, if any
      const lo = Math.max(r.lo, 0x21);
      if (lo <= r.hi && lo <= 0x7e) return lo;
    }
    return this.ranges[0].lo;
  }

  equals(other: CharSet): boolean {
    if (this.ranges.length !== other.ranges.length) return false;
    for (let i = 0; i < this.ranges.length; i++) {
      if (this.ranges[i].lo !== other.ranges[i].lo || this.ranges[i].hi !== other.ranges[i].hi) return false;
    }
    return true;
  }

  // A stable key for use in maps/sets.
  key(): string {
    return this.ranges.map((r) => `${r.lo}-${r.hi}`).join(',');
  }

  // Human-readable label for graph edges, e.g. "a-z", "\d", "[^a-c]".
  label(): string {
    if (this.isEmpty()) return '∅';
    // Recognise a few well-known classes for a compact label.
    for (const named of NAMED_CLASSES) {
      if (this.equals(named.set)) return named.label;
      if (this.equals(named.set.negate())) return named.negLabel;
    }
    const full = CharSet.fromRange(0, MAX_CODE_POINT);
    if (this.equals(full)) return 'Σ'; // any character
    const dotSet = CharSet.fromChar(NL).negate();
    if (this.equals(dotSet)) return '.';

    // If the complement is smaller, render as a negated class.
    const neg = this.negate();
    if (neg.size() < this.size() && neg.size() <= 12) {
      return `[^${renderRanges(neg.ranges)}]`;
    }
    // Unicode property classes registered at parse time (e.g. \p{L}, \p{Greek}).
    for (const named of EXTRA_NAMED_CLASSES) {
      if (this.equals(named.set)) return named.label;
      if (this.equals(named.set.negate())) return named.negLabel;
    }
    const body = renderRanges(this.ranges);
    return this.size() === 1 ? body : `[${body}]`;
  }
}

const NL = 10; // newline

function escapeChar(code: number): string {
  switch (code) {
    case 9:
      return '\\t';
    case 10:
      return '\\n';
    case 13:
      return '\\r';
    case 32:
      return '␣';
    case 92:
      return '\\\\';
    case 93:
      return '\\]';
    case 94:
      return '\\^';
    case 45:
      return '\\-';
  }
  if (code < 32 || code === 127) return `\\x${code.toString(16).padStart(2, '0')}`;
  if (code > 0xffff) return `U+${code.toString(16).toUpperCase()}`;
  if (code > 0x7e) return `\\u${code.toString(16).padStart(4, '0')}`;
  return String.fromCodePoint(code);
}

function renderRanges(ranges: readonly Range[]): string {
  return ranges
    .map((r) => {
      if (r.lo === r.hi) return escapeChar(r.lo);
      if (r.hi === r.lo + 1) return escapeChar(r.lo) + escapeChar(r.hi);
      return `${escapeChar(r.lo)}-${escapeChar(r.hi)}`;
    })
    .join('');
}

// Predefined character classes used by the parser and label recogniser.
export const DIGIT = CharSet.fromRange(48, 57); // \d
export const WORD = CharSet.union([
  CharSet.fromRange(48, 57),
  CharSet.fromRange(65, 90),
  CharSet.fromChar(95),
  CharSet.fromRange(97, 122),
]); // \w
export const SPACE = CharSet.union([CharSet.fromRange(9, 13), CharSet.fromChar(32)]); // \s
export const DOT = CharSet.fromChar(NL).negate(); // . (any but newline)

const NAMED_CLASSES: { set: CharSet; label: string; negLabel: string }[] = [
  { set: DIGIT, label: '\\d', negLabel: '\\D' },
  { set: WORD, label: '\\w', negLabel: '\\W' },
  { set: SPACE, label: '\\s', negLabel: '\\S' },
];

// Extensible registry for classes discovered at parse time — chiefly the Unicode
// property escapes \p{…}, whose code-point ranges are derived live from the host
// Unicode database (see engine/unicode.ts). Registering a derived set here lets
// every graph edge and AST label render it back as the compact `\p{L}` the user
// wrote, instead of a 700-range character class.
const EXTRA_NAMED_CLASSES: { set: CharSet; label: string; negLabel: string }[] = [];

export function registerNamedClass(set: CharSet, label: string, negLabel: string): void {
  if (EXTRA_NAMED_CLASSES.some((e) => e.label === label)) return;
  EXTRA_NAMED_CLASSES.push({ set, label, negLabel });
}
