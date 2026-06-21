// The variety ladder: deeper algebraic classification of a regular language,
// read straight off its syntactic monoid M(L).
//
// Session 8 built M(L), Green's relations and the single aperiodic ⇔ star-free
// verdict. This module turns that into a full *classification*:
//
//   • DA / FO²[<]      — a finite monoid is in DA iff every REGULAR element is
//                        idempotent (Schützenberger / Pin / Tesson–Thérien).
//                        DA is exactly the languages definable in two-variable
//                        first-order logic FO²[<], equivalently the UNAMBIGUOUS
//                        POLYNOMIALS A₀*a₁A₁*…aₖAₖ*, equivalently Σ₂ ∩ Π₂.
//   • the syntactic group, NAMED — the structure group of M(L) (the whole
//                        monoid when it is a group, else the group H-class of
//                        the top counting D-class) identified up to isomorphism:
//                        cyclic ℤ/n, the full abelian invariant-factor product,
//                        dihedral Dₙ, quaternion Q₈, A₄/S₄, …, all from the
//                        Cayley table — so the "counting modulus" gets a name.
//   • the variety ladder — where L sits on the inclusion lattice, each level
//                        carrying the theorem that justifies it and a one-line
//                        operational (logical) reading.
//
// Everything here is decided structurally from the multiplication table and the
// Green's relations, and cross-checked by the Algebra panel's fuzzer.

import type { SyntacticMonoid, GreenStructure, MonoidProperties } from './monoid';

// ── small integer helpers ────────────────────────────────────────────────────

function gcd(a: number, b: number): number {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}
function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}
function primeFactors(n: number): number[] {
  const primes: number[] = [];
  let m = n;
  for (let p = 2; p * p <= m; p++) {
    if (m % p === 0) {
      primes.push(p);
      while (m % p === 0) m /= p;
    }
  }
  if (m > 1) primes.push(m);
  return primes;
}

// The order of element `x` inside a group with identity `e` (the idempotent that
// is the group's identity — NOT necessarily the monoid identity): smallest k≥1
// with xᵏ = e.
function elementOrder(x: number, e: number, mult: Int32Array, size: number): number {
  let p = x;
  let k = 1;
  while (p !== e) {
    p = mult[p * size + x];
    k++;
    if (k > size + 1) break; // guard; never expected in a real group
  }
  return k;
}

// The inverse of `x` in a group with identity `e`: x^(order−1). Walks the powers
// e, x, x², … returning the power xᵏ with xᵏ·x = e.
function inverseOf(x: number, e: number, mult: Int32Array, size: number): number {
  let cur = e;
  for (let k = 0; k <= size + 1; k++) {
    if (mult[cur * size + x] === e) return cur;
    cur = mult[cur * size + x];
  }
  return e;
}

// ── DA / FO²[<] membership ────────────────────────────────────────────────────

export interface DAResult {
  inDA: boolean;
  witness: number | null; // a regular, non-idempotent element id (failure proof)
  regularElements: number; // how many elements live in a regular D-class
}

// M ∈ DA ⇔ every regular element is idempotent. A regular element is one that
// lies in a regular D-class (a D-class containing an idempotent). Note this test
// alone forces aperiodicity: a non-trivial group's non-identity elements are
// regular but not idempotent, so they fail it.
export function daMembership(m: SyntacticMonoid, green: GreenStructure): DAResult {
  const regularD = new Array<boolean>(green.dClasses.length).fill(false);
  for (const d of green.dClasses) regularD[d.id] = d.regular;
  let regularElements = 0;
  let witness: number | null = null;
  for (const el of m.elements) {
    const inRegular = regularD[green.dClassOf[el.id]];
    if (!inRegular) continue;
    regularElements++;
    if (!el.idempotent && witness === null) witness = el.id;
  }
  return { inDA: witness === null, witness, regularElements };
}

// ── the syntactic group, identified up to isomorphism ─────────────────────────

export interface GroupInfo {
  order: number;
  abelian: boolean;
  cyclic: boolean;
  exponent: number;
  name: string; // e.g. "ℤ/6", "ℤ/2 × ℤ/2", "D₄", "Q₈", "S₄"
  family: 'trivial' | 'cyclic' | 'abelian' | 'dihedral' | 'quaternion' | 'alternating' | 'symmetric' | 'other';
  meaning: string; // operational reading
  invariantFactors: number[] | null; // abelian case: d₁ | d₂ | … | dₖ
  orderSpectrum: { order: number; count: number }[]; // histogram of element orders
  identity: number; // element id of the group identity (the governing idempotent)
  members: number[]; // element ids forming the group
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
function sub(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUB[+d])
    .join('');
}

// The abelian invariant factors d₁ | d₂ | … | dₖ (product = group order) recovered
// from the element-order spectrum by per-prime primary decomposition. For a prime
// p, #{x : xᵖ^ⁱ = e} = p^(Σ min(i,aⱼ)) where the p-part is ⊕ℤ/p^aⱼ, so the
// exponents aⱼ fall straight out of the cumulative counts.
function abelianInvariantFactors(orders: number[]): number[] {
  const n = orders.length;
  if (n === 1) return [1];
  const primes = primeFactors(n);
  const perPrime = new Map<number, number[]>(); // prime → exponents (descending)
  let maxLen = 0;
  for (const p of primes) {
    // c[i] = #{x : order(x) | pⁱ}  (order is a p-power ≤ pⁱ, or 1)
    const c: number[] = [];
    for (let i = 0; i < 64; i++) {
      const pi = Math.pow(p, i);
      let cnt = 0;
      for (const o of orders) if (pi % o === 0) cnt++;
      c.push(cnt);
      if (i > 0 && c[i] === c[i - 1]) break;
    }
    // r[i] = number of cyclic parts with exponent ≥ i = log_p(c[i]/c[i-1])
    const r: number[] = [0];
    for (let i = 1; i < c.length; i++) {
      const ratio = c[i] / c[i - 1];
      r[i] = Math.round(Math.log(ratio) / Math.log(p));
    }
    const exps: number[] = [];
    for (let i = 1; i < r.length; i++) {
      const count = (r[i] ?? 0) - (r[i + 1] ?? 0);
      for (let t = 0; t < count; t++) exps.push(i);
    }
    exps.sort((a, b) => b - a); // descending
    perPrime.set(p, exps);
    maxLen = Math.max(maxLen, exps.length);
  }
  // Invariant factor in slot s (s=0 largest) is ∏ₚ p^(exps[s]). Convention emits
  // them ascending with d₁ | d₂ | … | dₖ.
  const factors: number[] = [];
  for (let s = 0; s < maxLen; s++) {
    let f = 1;
    for (const p of primes) {
      const e = perPrime.get(p)![s] ?? 0;
      f *= Math.pow(p, e);
    }
    factors.push(f);
  }
  factors.reverse();
  return factors;
}

function histogram(orders: number[]): { order: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const o of orders) counts.set(o, (counts.get(o) ?? 0) + 1);
  return [...counts.entries()].map(([order, count]) => ({ order, count })).sort((a, b) => a.order - b.order);
}

// Try to name a non-abelian group from its order + element-order spectrum + a
// structural dihedral probe on the Cayley table. Unknown groups degrade to a
// safe "non-abelian group of order n" — we never claim a name we can't justify.
function nameNonAbelian(
  members: number[],
  identity: number,
  mult: Int32Array,
  size: number,
  orders: number[],
): { name: string; family: GroupInfo['family'] } {
  const n = members.length;
  const orderCount = (k: number) => orders.filter((o) => o === k).length;

  // Generic dihedral Dₖ (order 2k): a rotation r of order k and a reflection s of
  // order 2 with s·r·s = r⁻¹.
  if (n % 2 === 0) {
    const k = n / 2;
    const rot = members.find((x) => elementOrder(x, identity, mult, size) === k);
    if (rot !== undefined && k >= 3) {
      const rinv = inverseOf(rot, identity, mult, size);
      const refl = members.find((s) => {
        if (elementOrder(s, identity, mult, size) !== 2) return false;
        const sr = mult[s * size + rot];
        const srs = mult[sr * size + s];
        return srs === rinv;
      });
      if (refl !== undefined) {
        const name = k === 3 ? `D${sub(3)} ≅ S${sub(3)}` : `D${sub(k)}`;
        return { name, family: 'dihedral' };
      }
    }
  }
  // Quaternion Q₈: order 8, a single involution, six elements of order 4.
  if (n === 8 && orderCount(2) === 1 && orderCount(4) === 6) {
    return { name: `Q${sub(8)}`, family: 'quaternion' };
  }
  // A₄: order 12 with exactly 3 involutions and 8 elements of order 3 (no order-4
  // or order-6 elements) — uniquely separates it from D₆ and the dicyclic group.
  if (n === 12 && orderCount(1) === 1 && orderCount(2) === 3 && orderCount(3) === 8) {
    return { name: `A${sub(4)}`, family: 'alternating' };
  }
  // S₄: order 24, element orders ⊆ {1,2,3,4}, with order-4 elements present.
  if (n === 24 && orderCount(4) > 0 && orders.every((o) => o <= 4)) {
    return { name: `S${sub(4)}`, family: 'symmetric' };
  }
  return { name: `non-abelian group of order ${n}`, family: 'other' };
}

// Identify the group on `members` with identity `identity` (the governing
// idempotent), using the monoid's Cayley table.
export function identifyGroup(
  members: number[],
  identity: number,
  mult: Int32Array,
  size: number,
): GroupInfo {
  const n = members.length;
  const orders = members.map((x) => elementOrder(x, identity, mult, size));
  const orderSpectrum = histogram(orders);
  const exponent = orders.reduce((a, b) => lcm(a, b), 1);
  const cyclic = orders.includes(n);

  let abelian = true;
  outer: for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (mult[members[i] * size + members[j]] !== mult[members[j] * size + members[i]]) {
        abelian = false;
        break outer;
      }
    }
  }

  let name: string;
  let family: GroupInfo['family'];
  let invariantFactors: number[] | null = null;
  let meaning: string;

  if (n === 1) {
    name = 'trivial';
    family = 'trivial';
    meaning = 'a single element — no counting at all.';
  } else if (abelian) {
    invariantFactors = abelianInvariantFactors(orders);
    if (invariantFactors.length === 1) {
      name = `ℤ/${invariantFactors[0]}`;
      family = 'cyclic';
      meaning = `pure modular counting: membership turns on a count taken mod ${invariantFactors[0]}.`;
    } else {
      name = invariantFactors.map((d) => `ℤ/${d}`).join(' × ');
      const klein = invariantFactors.length === 2 && invariantFactors[0] === 2 && invariantFactors[1] === 2;
      if (klein) name += ' (Klein four)';
      family = 'abelian';
      meaning = `independent modular counters of periods ${invariantFactors.join(', ')} (order never matters — the group is commutative).`;
    }
  } else {
    const named = nameNonAbelian(members, identity, mult, size, orders);
    name = named.name;
    family = named.family;
    meaning = `a non-commutative group — the order of letters changes the count; exponent ${exponent}.`;
  }

  return {
    order: n,
    abelian,
    cyclic,
    exponent,
    name,
    family,
    meaning,
    invariantFactors,
    orderSpectrum,
    identity,
    members,
  };
}

// The structure group of M(L): the whole monoid when it is a group (one
// idempotent), otherwise the group H-class of the highest-rank counting D-class
// (the one realising the counting modulus). Returns null when M is aperiodic
// (all group H-classes trivial) — there is no genuine counting to name.
export function syntacticGroup(m: SyntacticMonoid, green: GreenStructure): GroupInfo | null {
  if (!m.mult) return null;
  // Whole monoid is a group ⇔ exactly one idempotent. (A trivial one-element
  // monoid is the trivial group — no genuine counting, so don't surface it.)
  if (m.idempotents.length === 1 && m.size > 1) {
    return identifyGroup(
      m.elements.map((e) => e.id),
      m.identity,
      m.mult,
      m.size,
    );
  }
  // Otherwise pick the top regular D-class whose group order is the largest.
  let best: { d: (typeof green.dClasses)[number]; order: number } | null = null;
  for (const d of green.dClasses) {
    if (d.regular && d.groupOrder > 1 && (!best || d.groupOrder > best.order)) best = { d, order: d.groupOrder };
  }
  if (!best) return null;
  // Find the group H-class: the H-class of an idempotent in this D-class.
  const idemSet = new Set(m.idempotents);
  let idem = -1;
  for (const e of best.d.members) {
    if (idemSet.has(e)) {
      idem = e;
      break;
    }
  }
  if (idem < 0) return null;
  const hIdx = green.hClassOf[idem];
  const members = green.hClasses[hIdx];
  return identifyGroup(members, idem, m.mult, m.size);
}

// ── the variety ladder ────────────────────────────────────────────────────────

export interface VarietyLevel {
  id: string;
  name: string; // headline name(s)
  member: boolean;
  theorem: string; // the language↔algebra correspondence
  meaning: string; // operational / logical reading
  algebra: string; // the monoid-side condition decided
}

export interface VarietyLadder {
  levels: VarietyLevel[]; // most specific → most general
  tightestId: string; // smallest variety L provably belongs to (non-group branch)
  da: DAResult;
  group: GroupInfo | null;
  isGroupLanguage: boolean;
}

// Build the inclusion ladder, most-specific first. The non-group spine is
//   trivial ⊂ piecewise-testable (J-trivial) ⊂ DA (FO²) ⊂ star-free (aperiodic) ⊂ all regular.
export function varietyLadder(
  m: SyntacticMonoid,
  green: GreenStructure,
  props: MonoidProperties,
): VarietyLadder {
  const da = daMembership(m, green);
  const group = syntacticGroup(m, green);

  const levels: VarietyLevel[] = [
    {
      id: 'trivial',
      name: 'trivial',
      member: props.trivial,
      theorem: '|M(L)| = 1',
      meaning: 'the language is ∅ or Σ* — it accepts nothing, or everything.',
      algebra: 'one-element monoid',
    },
    {
      id: 'pt',
      name: 'piecewise testable · J-trivial · BΣ₁[<]',
      member: props.jTrivial,
      theorem: "Simon (1975): J-trivial ⇔ piecewise testable",
      meaning:
        'membership depends only on which scattered subwords (subsequences) of bounded length occur — boolean combinations of "contains the subsequence u".',
      algebra: 'every J-class is a singleton',
    },
    {
      id: 'da',
      name: 'DA · FO²[<] · unambiguous polynomial',
      member: da.inDA,
      theorem: 'Schützenberger / Thérien–Wilke: DA ⇔ FO²[<] ⇔ unambiguous polynomials ⇔ Σ₂ ∩ Π₂',
      meaning:
        'definable using only TWO first-order variables; an unambiguous concatenation A₀*a₁A₁*…aₖAₖ* — each letter parsed in exactly one way.',
      algebra: 'every regular element is idempotent',
    },
    {
      id: 'sf',
      name: 'star-free · aperiodic · FO[<] · counter-free · LTL',
      member: props.aperiodic,
      theorem: 'Schützenberger (1965) + McNaughton–Papert (1971): aperiodic ⇔ star-free ⇔ FO[<] ⇔ counter-free',
      meaning:
        'describable with ∪, concatenation and complement — no Kleene star; equivalently first-order logic FO[<], equivalently linear temporal logic.',
      algebra: 'M(L) has no non-trivial subgroup (group-free)',
    },
    {
      id: 'regular',
      name: 'regular (always)',
      member: true,
      theorem: 'Kleene / Myhill–Nerode: M(L) is finite ⇔ L is regular',
      meaning: 'recognised by a finite automaton — the universe every road in this studio lives in.',
      algebra: 'M(L) is finite',
    },
  ];

  // Tightest = first (most specific) membership on the spine.
  let tightestId = 'regular';
  for (const l of levels) {
    if (l.member) {
      tightestId = l.id;
      break;
    }
  }

  return { levels, tightestId, da, group, isGroupLanguage: props.group };
}

// ── what a selected element does to the DFA (the egg-box↔DFA bridge) ───────────

export interface StateMapView {
  word: number[]; // the realising word (atom indices)
  rank: number; // |image|
  idempotent: boolean;
  map: { from: number; to: number; fixed: boolean }[]; // s ↦ δ(s,w)
  image: number[]; // sorted image states
  cycles: number[][]; // non-trivial cycles on the periodic points (the counter)
  period: number; // longest cycle length (1 ⇔ this word induces no counter)
}

// Describe how the monoid element `elemId` transforms the complete DFA's states.
export function stateMapOf(m: SyntacticMonoid, elemId: number): StateMapView {
  const el = m.elements[elemId];
  const t = el.transform;
  const n = t.length;
  const map: { from: number; to: number; fixed: boolean }[] = [];
  const imageSet = new Set<number>();
  for (let s = 0; s < n; s++) {
    map.push({ from: s, to: t[s], fixed: t[s] === s });
    imageSet.add(t[s]);
  }
  // Cycles among the periodic points: land each state on its cycle (iterate n
  // times), then trace the cycle. Collect distinct non-trivial cycles.
  const seen = new Set<number>();
  const cycles: number[][] = [];
  let period = 1;
  for (let s0 = 0; s0 < n; s0++) {
    let x = s0;
    for (let k = 0; k < n; k++) x = t[x];
    if (seen.has(x)) continue;
    const cyc: number[] = [x];
    seen.add(x);
    let y = t[x];
    while (y !== x) {
      cyc.push(y);
      seen.add(y);
      y = t[y];
      if (cyc.length > n) break;
    }
    if (cyc.length > 1) {
      cycles.push(cyc);
      period = Math.max(period, cyc.length);
    }
  }
  return {
    word: el.word,
    rank: el.rank,
    idempotent: el.idempotent,
    map,
    image: [...imageSet].sort((a, b) => a - b),
    cycles,
    period,
  };
}
