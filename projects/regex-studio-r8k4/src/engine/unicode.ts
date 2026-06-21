// Unicode property escapes — \p{…} and \P{…} — resolved *live* from the host's
// own Unicode database.
//
// A regex engine that speaks Unicode usually ships a megabyte of generated
// tables (one bitmap per General_Category, per Script, …). The studio takes a
// different road: the JavaScript engine it already runs on *has* the entire
// Unicode database, exposed through `/\p{…}/u`. So we ask it. For a property
// spec like `L`, `Lu`, `Script=Greek` or `White_Space` we build the native
// matcher once, scan the whole code-point space [U+0000, U+10FFFF], and coalesce
// the matching scalars into the studio's own `CharSet` (sorted, merged ranges).
//
// Two consequences worth stating plainly:
//   • The class is correct *by construction* — it is the host's own answer,
//     reshaped into our range representation, so \p{L} here is exactly \p{L}
//     there. Every road in the studio (Thompson, Glushkov, derivatives, the
//     syntactic monoid…) consumes `CharSet`, so they all speak Unicode for free.
//   • The one thing that could still be wrong is *our* range-coalescing. So
//     `verifyProperty` re-confirms membership against the native engine over a
//     spread of sampled code points — the house rule: never ship a claim you
//     can't re-derive a second, independent way.
//
// Results are memoised: a property is scanned at most once per session.

import { CharSet, MAX_CODE_POINT, registerNamedClass } from './charset';

const cache = new Map<string, CharSet | null>();

// The host does loose matching (case / underscore / whitespace insensitive) on
// property names itself, so we only trim. The trimmed text is the cache key.
function specKey(spec: string): string {
  return spec.trim();
}

// Resolve `\p{<spec>}` to a CharSet, or null if the host rejects the spec (an
// unknown property name / value). Derives ranges from the native engine and
// caches them; also registers a pretty label so graph edges read `\p{<spec>}`.
export function resolveUnicodeProperty(spec: string): CharSet | null {
  const key = specKey(spec);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let re: RegExp;
  try {
    // The 'u' flag is what enables property escapes; an invalid spec throws here.
    re = new RegExp('\\p{' + key + '}', 'u');
  } catch {
    cache.set(key, null);
    return null;
  }

  const set = scanProperty(re);
  cache.set(key, set);
  registerNamedClass(set, `\\p{${key}}`, `\\P{${key}}`);
  return set;
}

// Walk the whole code-point space once, accumulating maximal runs of members.
// Lone surrogates (U+D800…U+DFFF) are not scalar values; `\p{…}` never matches
// them, so we treat them as non-members without calling String.fromCodePoint.
function scanProperty(re: RegExp): CharSet {
  const ranges: { lo: number; hi: number }[] = [];
  let runStart = -1;
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    let member: boolean;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      member = false;
    } else {
      member = re.test(String.fromCodePoint(cp));
    }
    if (member) {
      if (runStart < 0) runStart = cp;
    } else if (runStart >= 0) {
      ranges.push({ lo: runStart, hi: cp - 1 });
      runStart = -1;
    }
  }
  if (runStart >= 0) ranges.push({ lo: runStart, hi: MAX_CODE_POINT });
  return CharSet.fromRanges(ranges);
}

// Is `\p{<spec>}` a property the host accepts? (Cheap — does not scan.)
export function isKnownProperty(spec: string): boolean {
  try {
    new RegExp('\\p{' + specKey(spec) + '}', 'u');
    return true;
  } catch {
    return false;
  }
}

export interface PropertyCheck {
  ok: boolean;
  tested: number;
  mismatches: { code: number; ours: boolean; host: boolean }[];
}

// Differential self-check: confirm our coalesced CharSet agrees with the native
// engine over a spread of code points (a deterministic stride plus the boundary
// of every range we produced — the points most likely to expose an off-by-one
// in coalescing). Used by the dev harness and available to the studio's fuzzer.
export function verifyProperty(spec: string, stride = 2017): PropertyCheck {
  const re = new RegExp('\\p{' + specKey(spec) + '}', 'u');
  const set = resolveUnicodeProperty(spec)!;
  const probes = new Set<number>();
  for (let cp = 0; cp <= MAX_CODE_POINT; cp += stride) probes.add(cp);
  // Range boundaries (and the points just outside them) are the sharp edges.
  for (const r of set.ranges) {
    for (const c of [r.lo - 1, r.lo, r.hi, r.hi + 1]) {
      if (c >= 0 && c <= MAX_CODE_POINT) probes.add(c);
    }
  }
  const mismatches: { code: number; ours: boolean; host: boolean }[] = [];
  for (const cp of probes) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ours = set.contains(cp);
    const host = re.test(String.fromCodePoint(cp));
    if (ours !== host) mismatches.push({ code: cp, ours, host });
  }
  return { ok: mismatches.length === 0, tested: probes.size, mismatches: mismatches.slice(0, 16) };
}

// A small curated menu of properties worth showcasing in the UI / examples.
export const SUGGESTED_PROPERTIES: { spec: string; blurb: string }[] = [
  { spec: 'L', blurb: 'any letter (General_Category = Letter)' },
  { spec: 'Lu', blurb: 'uppercase letter' },
  { spec: 'Ll', blurb: 'lowercase letter' },
  { spec: 'N', blurb: 'any number' },
  { spec: 'P', blurb: 'any punctuation' },
  { spec: 'Emoji', blurb: 'emoji (binary property)' },
  { spec: 'White_Space', blurb: 'Unicode whitespace' },
  { spec: 'Script=Greek', blurb: 'the Greek script' },
  { spec: 'Script=Han', blurb: 'CJK / Han ideographs' },
  { spec: 'ASCII', blurb: 'the ASCII block U+0000…U+007F' },
];
