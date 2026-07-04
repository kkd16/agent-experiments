// PARIKH'S THEOREM — the commutative image of a regular language, as a machine.
//
// Every other "analysis" tab reads the *order* of a language; this one throws the
// order away. The PARIKH MAP π sends a word to its vector of letter counts —
// π("aab") = (2,1) over the alphabet {a,b} — and π(L) = { π(w) : w ∈ L } is the
// COMMUTATIVE IMAGE of the language, a subset of ℕ^Σ. Parikh's 1966 theorem says
// this image is always SEMILINEAR: a finite union of LINEAR SETS
//
//        L(base; p₁,…,p_r) = { base + n₁·p₁ + … + n_r·p_r : nᵢ ∈ ℕ },
//
// a base point plus the ℕ-cone of a few period vectors. (Parikh proved it for the
// far larger context-free languages; the regular case is the clean core.) For a
// regular language we compute π(L) *structurally*, straight off the regex AST, by
// the algebra of semilinear sets — the exact mirror of Thompson's construction,
// one operation per regex operator:
//
//     π(∅)      = ∅                       π(ε)   = { 0 }
//     π(a)      = { e_a }                 π(A|B) = π(A) ∪ π(B)          (union)
//     π(A·B)    = π(A) ⊕ π(B)             (Minkowski sum: {u+v})
//     π(A*)     = the submonoid ⟨π(A)⟩    (the ⊕-closure, {0} + finite sums)
//
// The two-line miracles fall straight out: π((ab)*) = {(n,n)} is the DIAGONAL —
// a regular language whose commutative image is a single line, #a = #b read off a
// machine; π(a*b*) is the whole quadrant ℕ²; and over ONE letter π((aaa|aaaaa)*)
// is the numerical semigroup ⟨3,5⟩ = {0,3,5,6,8,…}, whose largest gap 7 is the
// FROBENIUS NUMBER — literally the Chicken-McNugget set the Presburger tab reads
// off "∃a∃b. n = 3a+5b". That coincidence is not a coincidence: a set of naturals
// is semilinear IFF it is Presburger-definable, so this tab BRIDGES the studio's
// two halves — every semilinear image compiles to a Presburger formula, whose
// automaton (the studio's own Büchi–Bruyère–Villemaire machine) is confronted,
// tuple for tuple, against the semilinear set we built from the regex. Three
// independent roads to one set of vectors: the structural algebra, a brute-force
// enumeration of the language's own words, and the number-theoretic automaton.
//
// The whole file is over an ABSTRACT alphabet: each *distinct leaf character-class*
// of the pattern is one letter (one dimension). So `[a-z]` is a single symbol, and
// two occurrences of the same class share a dimension — exactly the pattern's own
// atom alphabet, the coarsest view on which "how many times did each atom fire?"
// is well posed.

import type { RegexNode } from './ast';
import type { CharSet } from './charset';
import type { Formula } from './presburger/ast';
import { formulaToString } from './presburger/ast';

export class ParikhError extends Error {}

// A guard on the size of every intermediate semilinear set: the star of a union of
// m linear sets is a union over the 2^m−1 non-empty subsets, so a wide alternation
// under a star can blow up. We cap and report rather than hang.
const MAX_LINEAR = 400; // final cap on a normalised union
const MAX_RAW = 6000; // cap on a single operation's pre-normalisation size
const SUBSUME_LIMIT = 64; // only run the O(n²) containment pass on small unions
const MEMBER_NODE_CAP = 200_000;

export type Vec = number[]; // a point/period in ℕ^dim, non-negative

// A linear set  base + ℕ·p₁ + … + ℕ·p_r.
export interface LinearSet {
  base: Vec;
  periods: Vec[];
}

// A semilinear set: a finite union of linear sets, all of one dimension.
export interface Semilinear {
  dim: number;
  sets: LinearSet[];
}

// ── vector helpers ────────────────────────────────────────────────────────────
function zeros(k: number): Vec {
  return new Array<number>(k).fill(0);
}
function addVec(a: Vec, b: Vec): Vec {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}
export function vecKey(v: Vec): string {
  return v.join(',');
}
function total(v: Vec): number {
  let s = 0;
  for (const x of v) s += x;
  return s;
}
function isZeroVec(v: Vec): boolean {
  return v.every((x) => x === 0);
}

// ── the alphabet: distinct leaf character-classes, in first-occurrence order ────
export interface ParikhAtom {
  key: string; // CharSet.key(), the identity of the class
  label: string; // CharSet.label(), what the user reads (a, [a-z], \d, …)
}

export function collectAtoms(ast: RegexNode): { atoms: ParikhAtom[]; indexOf: Map<string, number> } {
  const atoms: ParikhAtom[] = [];
  const indexOf = new Map<string, number>();
  const visit = (n: RegexNode): void => {
    switch (n.type) {
      case 'char': {
        const set: CharSet = n.set;
        const k = set.key();
        if (!indexOf.has(k)) {
          indexOf.set(k, atoms.length);
          atoms.push({ key: k, label: set.label() });
        }
        return;
      }
      case 'empty':
      case 'anchor':
      case 'boundary':
      case 'backref':
        return;
      case 'concat':
        n.parts.forEach(visit);
        return;
      case 'alt':
        n.options.forEach(visit);
        return;
      case 'intersect':
        n.parts.forEach(visit);
        return;
      case 'star':
      case 'plus':
      case 'opt':
      case 'repeat':
      case 'group':
      case 'complement':
      case 'look':
        visit(n.node);
        return;
    }
  };
  visit(ast);
  return { atoms, indexOf };
}

// ── semilinear-set algebra ──────────────────────────────────────────────────────
function emptySemi(dim: number): Semilinear {
  return { dim, sets: [] };
}
function pointSemi(dim: number, base: Vec): Semilinear {
  return { dim, sets: [{ base, periods: [] }] };
}
function zeroSemi(dim: number): Semilinear {
  return pointSemi(dim, zeros(dim));
}

// Dedupe periods: drop the zero vector and exact duplicates, then sort canonically.
function normPeriods(periods: Vec[]): Vec[] {
  const seen = new Set<string>();
  const out: Vec[] = [];
  for (const p of periods) {
    if (isZeroVec(p)) continue;
    const k = vecKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  out.sort((a, b) => vecKey(a).localeCompare(vecKey(b)));
  return out;
}

// Is one linear set contained in another? Sound and general: L(bL;PL) ⊆ M(bM;PM)
// iff the base bL ∈ M and every period of L lies in M's recession cone ⟨PM⟩. Both
// are decided by the bounded reachability search of memberLinear; a search that
// overflows the cap conservatively answers "not contained" (we keep the set).
function linContained(L: LinearSet, M: LinearSet): boolean {
  try {
    if (!memberLinear(M, L.base)) return false;
    const cone: LinearSet = { base: zeros(M.base.length), periods: M.periods };
    return L.periods.every((p) => memberLinear(cone, p));
  } catch {
    return false;
  }
}

// Normalise a union of linear sets: canonicalise each, drop exact duplicates, and
// apply the one *sound, cheap* subsumption rule — a set L is redundant when some
// other set L′ has the SAME base and a superset of L's periods (then L ⊆ L′). We
// deliberately avoid the full (NP-hard) containment test; the cap catches the rest.
function normalize(sl: Semilinear): Semilinear {
  const canon: LinearSet[] = sl.sets.map((L) => ({ base: L.base, periods: normPeriods(L.periods) }));
  const byKey = new Map<string, LinearSet>();
  for (const L of canon) {
    const k = vecKey(L.base) + '|' + L.periods.map(vecKey).join(';');
    if (!byKey.has(k)) byKey.set(k, L);
  }
  const uniq = [...byKey.values()];
  // Bail early — before the quadratic containment pass — if even the deduped union
  // is over the cap (a runaway nested pattern). The tab reports this rather than hang.
  if (uniq.length > MAX_LINEAR) {
    throw new ParikhError(`semilinear representation too large (${uniq.length} linear sets) — try a smaller pattern`);
  }
  // The general containment subsumption is O(n²) reachability searches; only worth
  // it — and only affordable — on small unions. Larger (but still capped) unions
  // keep the deduped form, which is sound, just not minimal.
  if (uniq.length > SUBSUME_LIMIT) return { dim: sl.dim, sets: uniq };
  const kept: LinearSet[] = [];
  for (let i = 0; i < uniq.length; i++) {
    const L = uniq[i];
    // L is redundant when it is *contained* in another linear set M — a sound,
    // general test: L(bL;PL) ⊆ M(bM;PM) iff bL ∈ M and every period of L lies in
    // M's recession cone ⟨PM⟩. Tie-break by index so two mutually-containing
    // (equal) sets don't both drop each other.
    const subsumed = uniq.some((M, j) => {
      if (j === i) return false;
      if (!linContained(L, M)) return false;
      return j < i || !linContained(M, L);
    });
    if (!subsumed) kept.push(L);
  }
  return { dim: sl.dim, sets: kept };
}

function unionSemi(a: Semilinear, b: Semilinear): Semilinear {
  if (a.sets.length + b.sets.length > MAX_RAW) throw new ParikhError('union too large for the semilinear view');
  return normalize({ dim: a.dim, sets: [...a.sets, ...b.sets] });
}

// Minkowski sum of two linear sets: bases add, period cones merge.
function sumLinear(a: LinearSet, b: LinearSet): LinearSet {
  return { base: addVec(a.base, b.base), periods: [...a.periods, ...b.periods] };
}

// π(A·B) = π(A) ⊕ π(B): every pairing of a base from A with a base from B.
function sumSemi(a: Semilinear, b: Semilinear): Semilinear {
  if (a.sets.length * b.sets.length > MAX_RAW) throw new ParikhError('Minkowski sum too large for the semilinear view');
  const sets: LinearSet[] = [];
  for (const la of a.sets) for (const lb of b.sets) sets.push(sumLinear(la, lb));
  return normalize({ dim: a.dim, sets });
}

// A^n as an n-fold Minkowski sum (A^0 = {0}).
function powerSemi(a: Semilinear, n: number): Semilinear {
  let acc = zeroSemi(a.dim);
  for (let i = 0; i < n; i++) acc = sumSemi(acc, a);
  return acc;
}

// π(A*) — the additive submonoid generated by π(A).
//
// π(A) = ⋃_{i∈[m]} (bᵢ + ⟨Pᵢ⟩). An element of ⟨π(A)⟩ is a finite sum drawing
// each summand from some linear set; group by the (non-empty) subset T of linear
// sets used *at least once*. Using set i at least once contributes bᵢ plus a
// non-negative amount of bᵢ (the extra copies) and of Pᵢ — so the T-part is
//        Σ_{i∈T} bᵢ  +  ⟨ ⋃_{i∈T} (Pᵢ ∪ {bᵢ}) ⟩.
// Union that over every non-empty T, plus {0} for the empty sum, and you have the
// star exactly. It is 2^m−1 linear sets before normalisation — hence the cap.
function starSemi(a: Semilinear): Semilinear {
  const dim = a.dim;
  if (a.sets.length === 0) return zeroSemi(dim); // π(∅*) = π(ε) = {0}
  const m = a.sets.length;
  if (m > 12) {
    throw new ParikhError(`star of a ${m}-way alternation is too wide for the semilinear view`);
  }
  const out: LinearSet[] = [{ base: zeros(dim), periods: [] }]; // the empty sum
  for (let mask = 1; mask < 1 << m; mask++) {
    let base = zeros(dim);
    const periods: Vec[] = [];
    for (let i = 0; i < m; i++) {
      if (!(mask & (1 << i))) continue;
      const L = a.sets[i];
      base = addVec(base, L.base);
      periods.push(...L.periods);
      if (!isZeroVec(L.base)) periods.push(L.base);
    }
    out.push({ base, periods });
  }
  return normalize({ dim, sets: out });
}

// ── the structural Parikh map, with a per-subexpression construction trace ──────
export interface TraceEntry {
  expr: string; // a compact rendering of the subexpression
  op: string; // the semilinear operation that produced it
  sl: Semilinear;
}

function parikhWalk(
  node: RegexNode,
  dim: number,
  indexOf: Map<string, number>,
  trace: TraceEntry[],
  record: boolean,
): Semilinear {
  const push = (op: string, sl: Semilinear): Semilinear => {
    if (record) trace.push({ expr: printNode(node), op, sl });
    return sl;
  };
  switch (node.type) {
    case 'empty':
      return push('ε ↦ {0}', zeroSemi(dim));
    case 'char': {
      const i = indexOf.get(node.set.key());
      if (i === undefined) throw new ParikhError('internal: unregistered atom');
      const b = zeros(dim);
      b[i] = 1;
      return push('a ↦ {eₐ}', pointSemi(dim, b));
    }
    case 'concat': {
      let acc = zeroSemi(dim);
      for (const p of node.parts) acc = sumSemi(acc, parikhWalk(p, dim, indexOf, trace, record));
      return push('· ↦ ⊕ (Minkowski sum)', acc);
    }
    case 'alt': {
      let acc = emptySemi(dim);
      for (const o of node.options) acc = unionSemi(acc, parikhWalk(o, dim, indexOf, trace, record));
      return push('| ↦ ∪ (union)', acc);
    }
    case 'group':
      return parikhWalk(node.node, dim, indexOf, trace, record);
    case 'star':
      return push('* ↦ ⟨·⟩ (submonoid)', starSemi(parikhWalk(node.node, dim, indexOf, trace, record)));
    case 'plus': {
      const p = parikhWalk(node.node, dim, indexOf, trace, record);
      return push('+ ↦ A ⊕ A*', sumSemi(p, starSemi(p)));
    }
    case 'opt': {
      const p = parikhWalk(node.node, dim, indexOf, trace, record);
      return push('? ↦ A ∪ {0}', unionSemi(p, zeroSemi(dim)));
    }
    case 'repeat': {
      const p = parikhWalk(node.node, dim, indexOf, trace, record);
      const min = node.min;
      if (node.max === null) {
        // A{min,} = A^min · A*
        return push('{m,} ↦ A^m ⊕ A*', sumSemi(powerSemi(p, min), starSemi(p)));
      }
      const max = node.max;
      if (max - min > 40) throw new ParikhError(`repeat bound {${min},${max}} too wide for the semilinear view`);
      let acc = emptySemi(dim);
      for (let c = min; c <= max; c++) acc = unionSemi(acc, powerSemi(p, c));
      return push(`{${min},${max}} ↦ ⋃ Aᶜ`, acc);
    }
    case 'intersect':
    case 'complement':
    case 'anchor':
    case 'boundary':
    case 'backref':
    case 'look':
      throw new ParikhError('the Parikh view needs a plain regular pattern (no & ~ anchors, backrefs or lookaround)');
  }
}

// ── membership: is a count vector realised by the language? ─────────────────────
// v ∈ base + ⟨periods⟩  iff  v−base is a non-negative integer combination of the
// periods. All coordinates are non-negative counts, so this is a bounded reachability
// search over the box [0, v−base] — small in practice, capped for safety.
export function memberLinear(L: LinearSet, v: Vec): boolean {
  const target = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) {
    target[i] = v[i] - L.base[i];
    if (target[i] < 0) return false;
  }
  if (L.periods.length === 0) return target.every((x) => x === 0);
  const targetKey = vecKey(target);
  if (targetKey === vecKey(zeros(v.length))) return true;
  const seen = new Set<string>([vecKey(zeros(v.length))]);
  const stack: Vec[] = [zeros(v.length)];
  let guard = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    for (const p of L.periods) {
      const nx = addVec(cur, p);
      let ok = true;
      for (let i = 0; i < nx.length; i++)
        if (nx[i] > target[i]) {
          ok = false;
          break;
        }
      if (!ok) continue;
      const k = vecKey(nx);
      if (k === targetKey) return true;
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(nx);
      if (++guard > MEMBER_NODE_CAP) throw new ParikhError('membership search too large to decide exactly');
    }
  }
  return false;
}

export function memberSemi(sl: Semilinear, v: Vec): boolean {
  return sl.sets.some((L) => memberLinear(L, v));
}

// A concrete witness that v ∈ base + ⟨periods⟩: the non-negative multipliers nⱼ
// with v = base + Σ nⱼ·pⱼ, found by the same bounded reachability search. Returns
// null when v is not in this linear set.
export function witnessCombination(L: LinearSet, v: Vec): number[] | null {
  const target = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) {
    target[i] = v[i] - L.base[i];
    if (target[i] < 0) return null;
  }
  if (L.periods.length === 0) return target.every((x) => x === 0) ? [] : null;
  const startKey = vecKey(zeros(v.length));
  const targetKey = vecKey(target);
  const prev = new Map<string, { fromKey: string; period: number }>();
  const seen = new Set<string>([startKey]);
  const stack: Vec[] = [zeros(v.length)];
  let guard = 0;
  let found = targetKey === startKey;
  while (stack.length && !found) {
    const cur = stack.pop()!;
    for (let pj = 0; pj < L.periods.length; pj++) {
      const nx = addVec(cur, L.periods[pj]);
      let ok = true;
      for (let i = 0; i < nx.length; i++)
        if (nx[i] > target[i]) {
          ok = false;
          break;
        }
      if (!ok) continue;
      const k = vecKey(nx);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, { fromKey: vecKey(cur), period: pj });
      if (k === targetKey) {
        found = true;
        break;
      }
      stack.push(nx);
      if (++guard > MEMBER_NODE_CAP) return null;
    }
  }
  if (!found) return null;
  const counts = new Array<number>(L.periods.length).fill(0);
  let cur = targetKey;
  while (cur !== startKey) {
    const step = prev.get(cur);
    if (!step) return null;
    counts[step.period]++;
    cur = step.fromKey;
  }
  return counts;
}

// Enumerate the vectors of a semilinear set with coordinate-sum ≤ maxTotal.
export function enumerateSemilinear(
  sl: Semilinear,
  maxTotal: number,
  cap = 20000,
): { keys: Set<string>; points: Vec[]; truncated: boolean } {
  const keys = new Set<string>();
  const points: Vec[] = [];
  for (const L of sl.sets) {
    if (total(L.base) > maxTotal) continue;
    const seen = new Set<string>([vecKey(L.base)]);
    const stack: Vec[] = [L.base];
    while (stack.length) {
      const cur = stack.pop()!;
      const k = vecKey(cur);
      if (!keys.has(k)) {
        keys.add(k);
        points.push(cur);
        if (keys.size > cap) return { keys, points, truncated: true };
      }
      for (const p of L.periods) {
        const nx = addVec(cur, p);
        if (total(nx) > maxTotal) continue;
        const nk = vecKey(nx);
        if (!seen.has(nk)) {
          seen.add(nk);
          stack.push(nx);
        }
      }
    }
  }
  return { keys, points, truncated: false };
}

// ── the independent oracle: the language's OWN Parikh vectors, by brute force ───
// Generate every abstract word of length ≤ maxLen the regex accepts and read off
// its count vector. Completely independent of the semilinear algebra above — this
// is the ground truth the construction is differentially checked against.
export function languageParikh(
  ast: RegexNode,
  dim: number,
  indexOf: Map<string, number>,
  maxLen: number,
  cap = 40000,
): { keys: Set<string>; points: Vec[]; truncated: boolean } {
  let truncated = false;
  // A "word" is an array of atom indices. We dedupe by key and cap the count.
  const gen = (n: RegexNode): Set<string> => {
    if (truncated) return new Set();
    switch (n.type) {
      case 'empty':
        return new Set(['']);
      case 'char': {
        const i = indexOf.get(n.set.key());
        if (i === undefined) throw new ParikhError('internal: unregistered atom');
        return new Set([String(i)]);
      }
      case 'group':
        return gen(n.node);
      case 'concat': {
        let acc = new Set(['']);
        for (const p of n.parts) acc = concatWords(acc, gen(p), maxLen);
        return acc;
      }
      case 'alt': {
        const out = new Set<string>();
        for (const o of n.options) for (const w of gen(o)) addWord(out, w, cap);
        return out;
      }
      case 'star':
        return starWords(gen(n.node), maxLen, cap);
      case 'plus':
        return concatWords(gen(n.node), starWords(gen(n.node), maxLen, cap), maxLen);
      case 'opt': {
        const out = new Set<string>(['']);
        for (const w of gen(n.node)) addWord(out, w, cap);
        return out;
      }
      case 'repeat': {
        const base = gen(n.node);
        const max = n.max === null ? Math.max(n.min, maxLen) : n.max;
        const out = new Set<string>();
        for (let c = n.min; c <= max; c++) {
          let acc = new Set(['']);
          for (let i = 0; i < c; i++) acc = concatWords(acc, base, maxLen);
          for (const w of acc) addWord(out, w, cap);
          if (out.size > cap) {
            truncated = true;
            break;
          }
        }
        return out;
      }
      default:
        throw new ParikhError('non-regular node in Parikh oracle');
    }
  };
  const words = gen(ast);
  if (words.size > cap) truncated = true;
  const keys = new Set<string>();
  const points: Vec[] = [];
  for (const w of words) {
    const v = zeros(dim);
    if (w.length) for (const t of w.split(',')) v[Number(t)]++;
    const k = vecKey(v);
    if (!keys.has(k)) {
      keys.add(k);
      points.push(v);
    }
  }
  return { keys, points, truncated };

  function addWord(set: Set<string>, w: string, capN: number): void {
    if (w === '') {
      set.add('');
      return;
    }
    const len = w.split(',').length;
    if (len > maxLen) return;
    set.add(w);
    if (set.size > capN) truncated = true;
  }
  function concatWords(a: Set<string>, b: Set<string>, maxL: number): Set<string> {
    const out = new Set<string>();
    for (const x of a) {
      const xl = x === '' ? 0 : x.split(',').length;
      for (const y of b) {
        const yl = y === '' ? 0 : y.split(',').length;
        if (xl + yl > maxL) continue;
        const w = x === '' ? y : y === '' ? x : x + ',' + y;
        out.add(w);
        if (out.size > cap) {
          truncated = true;
          return out;
        }
      }
    }
    return out;
  }
  function starWords(base: Set<string>, maxL: number, capN: number): Set<string> {
    const out = new Set<string>(['']);
    let frontier = new Set<string>(['']);
    while (frontier.size) {
      const next = new Set<string>();
      for (const x of frontier) {
        const xl = x === '' ? 0 : x.split(',').length;
        for (const y of base) {
          const yl = y === '' ? 0 : y.split(',').length;
          if (yl === 0) continue; // ε in the base ⇒ don't loop forever
          if (xl + yl > maxL) continue;
          const w = x === '' ? y : x + ',' + y;
          if (!out.has(w)) {
            out.add(w);
            next.add(w);
            if (out.size > capN) {
              truncated = true;
              return out;
            }
          }
        }
      }
      frontier = next;
    }
    return out;
  }
}

// ── the Presburger bridge ───────────────────────────────────────────────────────
// A semilinear set of ℕ^k is Presburger-definable: for each linear set introduce
// existentially-quantified multipliers t_j ≥ 0 and assert x_d = base_d + Σ_j p_{j,d}·t_j;
// OR the linear sets together. Compiling this with the studio's own Presburger
// engine yields an automaton over the binary digits of the count variables — a
// third, number-theoretic witness of the very set the regex produced.
export function toPresburgerFormula(sl: Semilinear, varNames: string[]): Formula {
  if (sl.sets.length === 0) return { kind: 'false' };
  let acc: Formula | null = null;
  sl.sets.forEach((L, li) => {
    const tNames = L.periods.map((_, j) => `t${li}_${j}`);
    let conj: Formula = { kind: 'true' };
    for (let d = 0; d < sl.dim; d++) {
      const coef: Record<string, number> = { [varNames[d]]: 1 };
      L.periods.forEach((p, j) => {
        if (p[d] !== 0) coef[tNames[j]] = -(p[d]);
      });
      const atom: Formula = { kind: 'cmp', op: '=', coef, c: L.base[d] };
      conj = conj.kind === 'true' ? atom : { kind: 'and', a: conj, b: atom };
    }
    let branch: Formula = conj;
    for (let j = tNames.length - 1; j >= 0; j--) branch = { kind: 'exists', v: tNames[j], a: branch };
    acc = acc === null ? branch : { kind: 'or', a: acc, b: branch };
  });
  return acc ?? { kind: 'false' };
}

// ── the whole analysis, for the panel ───────────────────────────────────────────
export interface ParikhResult {
  dim: number;
  atoms: ParikhAtom[];
  semilinear: Semilinear;
  trace: TraceEntry[];
  varNames: string[]; // Presburger variable names, aligned to atoms
  formula: Formula | null;
  formulaText: string | null;
  error: string | null;
}

export function analyzeParikh(ast: RegexNode): ParikhResult {
  const { atoms, indexOf } = collectAtoms(ast);
  const dim = atoms.length;
  const varNames = atoms.map((_, i) => `c${i}`);
  const base: ParikhResult = {
    dim,
    atoms,
    semilinear: emptySemi(dim),
    trace: [],
    varNames,
    formula: null,
    formulaText: null,
    error: null,
  };
  try {
    const trace: TraceEntry[] = [];
    const sl = parikhWalk(ast, dim, indexOf, trace, true);
    base.semilinear = sl;
    base.trace = trace;
    try {
      const formula = toPresburgerFormula(sl, varNames);
      base.formula = formula;
      base.formulaText = formulaToString(formula);
    } catch {
      /* the bridge formula is best-effort; the semilinear set stands on its own */
    }
  } catch (e) {
    base.error = e instanceof ParikhError ? e.message : String((e as Error)?.message ?? e);
  }
  return base;
}

// ── rendering helpers ────────────────────────────────────────────────────────────
export function renderVec(v: Vec, atoms: ParikhAtom[]): string {
  void atoms;
  if (v.length === 0) return '()';
  return '(' + v.map((x) => `${x}`).join(', ') + ')';
}

export function describeLinear(L: LinearSet, atoms: ParikhAtom[]): string {
  const b = renderVec(L.base, atoms);
  if (L.periods.length === 0) return b;
  const ps = L.periods.map((p) => `ℕ·${renderVec(p, atoms)}`).join(' + ');
  return `${b} + ${ps}`;
}

// A compact source rendering of an AST subexpression (for the construction trace).
export function printNode(n: RegexNode): string {
  switch (n.type) {
    case 'empty':
      return 'ε';
    case 'char':
      return n.set.label();
    case 'concat':
      return n.parts.map((p) => wrap(p, 2)).join('');
    case 'alt':
      return n.options.map((o) => wrap(o, 1)).join('|');
    case 'group':
      return printNode(n.node);
    case 'star':
      return wrap(n.node, 3) + '*';
    case 'plus':
      return wrap(n.node, 3) + '+';
    case 'opt':
      return wrap(n.node, 3) + '?';
    case 'repeat':
      return wrap(n.node, 3) + `{${n.min},${n.max ?? ''}}`;
    default:
      return '…';
  }
}

// precedence: 1 = alt, 2 = concat, 3 = atom/quantified
function wrap(n: RegexNode, ctx: number): string {
  const prec =
    n.type === 'alt' ? 1 : n.type === 'concat' ? 2 : 3;
  const s = printNode(n);
  return prec < ctx ? `(${s})` : s;
}

// ── gallery ──────────────────────────────────────────────────────────────────────
export interface ParikhExample {
  name: string;
  pattern: string;
  note: string;
}

export const PARIKH_EXAMPLES: ParikhExample[] = [
  {
    name: '(ab)* — equal counts, the diagonal',
    pattern: '(ab)*',
    note: 'π = {(n,n)} — the diagonal line #a = #b. A regular language whose commutative image is a single ray, read straight off the algebra.',
  },
  {
    name: 'a*b* — the whole quadrant',
    pattern: 'a*b*',
    note: 'π = ℕ² — one linear set, base (0,0), periods (1,0) and (0,1): every pair of counts is realised.',
  },
  {
    name: '⟨3,5⟩ — Chicken McNugget (one letter)',
    pattern: '(aaa|aaaaa)*',
    note: 'Over a single letter π is the numerical semigroup 3ℕ+5ℕ = {0,3,5,6,8,…}; the largest gap 7 is the Frobenius number — the very set the Presburger tab reads off ∃a∃b. n = 3a+5b.',
  },
  {
    name: 'at least one a',
    pattern: '(a|b)*a(a|b)*',
    note: 'π = {(x,y) : x ≥ 1}: base (1,0), periods (1,0) and (0,1) — a shifted half-quadrant.',
  },
  {
    name: 'even number of a’s',
    pattern: 'b*(ab*ab*)*',
    note: 'π = {(x,y) : x even}: the period (2,0) forces the a’s to arrive in pairs while b is free.',
  },
  {
    name: 'a{2,5} — a finite, bounded run',
    pattern: 'a{2,5}',
    note: 'π = {(2),(3),(4),(5)} — four isolated points, no periods: a finite language has a finite (period-free) image.',
  },
  {
    name: '(aa|bbb)* — a two-generator lattice',
    pattern: '(aa|bbb)*',
    note: 'π is generated by (2,0) and (0,3): every count of a is even, every count of b a multiple of 3, chosen independently.',
  },
];
