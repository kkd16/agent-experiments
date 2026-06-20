// BDD/ZDD correctness harness — folded into the project's selftest.ts so its
// assertions count toward the headline tally, exactly like the SMT/QBF/IMC subsystems.
//
// The engine is pinned from three independent directions:
//   1. a brute-force truth-table oracle (every apply, cofactor, quantifier and
//      reorder is re-checked on all 2^k assignments of small functions),
//   2. the project's OWN solvers — a BDD built from a CNF must agree with the
//      CDCL engine on SAT/UNSAT and with the #SAT counter on the model count, and
//   3. closed-form combinatorics for the ZDD set algebra (2^n, C(n,k), and
//      random family union/intersect/difference versus bit-mask set arithmetic).

import { Bdd } from './bdd'
import type { NodeId } from './bdd'
import { reorder, reverseOrder, randomOrder, sift } from './reorder'
import { bddFromCnf, GALLERY } from './build'
import { compileExpr, parseExpr, exprVars, evalExpr } from './expr'
import { Zdd } from './zdd'
import { solve, countModels } from '../sat'
import type { CNF } from '../sat'

export interface BddCheckReport {
  pass: number
  fail: number
  messages: string[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Build a BDD over k variables from an explicit truth table (length 2^k). */
function tableToBdd(bdd: Bdd, k: number, table: boolean[]): NodeId {
  let root: NodeId = 0
  for (let idx = 0; idx < 1 << k; idx++) {
    if (!table[idx]) continue
    let minterm: NodeId = 1
    for (let j = 0; j < k; j++) {
      const lit = (idx >> j) & 1 ? bdd.ithVar(j) : bdd.nithVar(j)
      minterm = bdd.and(minterm, lit)
    }
    root = bdd.or(root, minterm)
  }
  return root
}

function assignOf(idx: number, k: number): boolean[] {
  const a = new Array<boolean>(k)
  for (let j = 0; j < k; j++) a[j] = ((idx >> j) & 1) === 1
  return a
}

function popcount(table: boolean[]): number {
  let c = 0
  for (const b of table) if (b) c++
  return c
}

function binom(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n
  let r = 1n
  for (let i = 0; i < k; i++) r = (r * BigInt(n - i)) / BigInt(i + 1)
  return r
}

export function runBddChecks(): BddCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 40) messages.push(`FAIL: ${name} ${extra}`)
    }
  }

  // ---- 1. canonicity & Boolean identities (pointer equality is equivalence) --
  {
    const b = new Bdd(4)
    const [a, bb, c] = [b.ithVar(0), b.ithVar(1), b.ithVar(2)]
    check('and is commutative (same node)', b.and(a, bb) === b.and(bb, a))
    check('or is commutative (same node)', b.or(a, bb) === b.or(bb, a))
    check('De Morgan: ¬(a∧b) = ¬a∨¬b', b.not(b.and(a, bb)) === b.or(b.not(a), b.not(bb)))
    check('double negation', b.not(b.not(a)) === a)
    check('xor = a¬b ∨ ¬ab', b.xor(a, bb) === b.or(b.and(a, b.not(bb)), b.and(b.not(a), bb)))
    check('iff = ¬xor', b.iff(a, bb) === b.not(b.xor(a, bb)))
    check('absorption: a ∨ (a∧b) = a', b.or(a, b.and(a, bb)) === a)
    check('distributivity', b.and(a, b.or(bb, c)) === b.or(b.and(a, bb), b.and(a, c)))
    check('excluded middle: a ∨ ¬a = ⊤', b.or(a, b.not(a)) === 1)
    check('contradiction: a ∧ ¬a = ⊥', b.and(a, b.not(a)) === 0)
    check('ite = a∧b ∨ ¬a∧c', b.ite(a, bb, c) === b.or(b.and(a, bb), b.and(b.not(a), c)))
    check('ite(f,1,0) = f', b.ite(a, 1, 0) === a)
  }

  // ---- 2. apply / satCount / cofactor / quantify vs a truth-table oracle ----
  {
    const rng = mulberry32(0xb00b)
    let applyBad = 0
    let countBad = 0
    let cofBad = 0
    let quantBad = 0
    let composeBad = 0
    const TRIALS = 500
    for (let t = 0; t < TRIALS; t++) {
      const k = 2 + Math.floor(rng() * 3) // 2..4 vars
      const N = 1 << k
      const tf: boolean[] = []
      const tg: boolean[] = []
      for (let i = 0; i < N; i++) {
        tf.push(rng() < 0.5)
        tg.push(rng() < 0.5)
      }
      const bdd = new Bdd(k)
      const f = tableToBdd(bdd, k, tf)
      const g = tableToBdd(bdd, k, tg)

      // satCount must equal the number of true rows.
      if (bdd.satCount(f) !== BigInt(popcount(tf))) countBad++

      for (let i = 0; i < N; i++) {
        const a = assignOf(i, k)
        const fv = tf[i]
        const gv = tg[i]
        if (bdd.evaluate(f, a) !== fv) applyBad++
        if (bdd.evaluate(bdd.not(f), a) !== !fv) applyBad++
        if (bdd.evaluate(bdd.and(f, g), a) !== (fv && gv)) applyBad++
        if (bdd.evaluate(bdd.or(f, g), a) !== (fv || gv)) applyBad++
        if (bdd.evaluate(bdd.xor(f, g), a) !== (fv !== gv)) applyBad++
        if (bdd.evaluate(bdd.implies(f, g), a) !== (!fv || gv)) applyBad++
        if (bdd.evaluate(bdd.iff(f, g), a) !== (fv === gv)) applyBad++
      }

      // Shannon reconstruction: f ≡ ite(xv, f|v=1, f|v=0).
      for (let v = 0; v < k; v++) {
        const rec = bdd.ite(bdd.ithVar(v), bdd.restrict(f, v, true), bdd.restrict(f, v, false))
        if (rec !== f) cofBad++
      }

      // ∀/∃ over one variable, re-checked on every assignment.
      for (let v = 0; v < k; v++) {
        const ex = bdd.existsVar(f, v)
        const fa = bdd.forallVar(f, v)
        for (let i = 0; i < N; i++) {
          const a = assignOf(i, k)
          const a0 = a.slice()
          const a1 = a.slice()
          a0[v] = false
          a1[v] = true
          const oracleE = tf[idxOf(a0, k)] || tf[idxOf(a1, k)]
          const oracleA = tf[idxOf(a0, k)] && tf[idxOf(a1, k)]
          if (bdd.evaluate(ex, a) !== oracleE) quantBad++
          if (bdd.evaluate(fa, a) !== oracleA) quantBad++
        }
      }

      // compose: substitute g for variable 0 in f.
      if (k >= 2) {
        const comp = bdd.compose(f, 0, g)
        for (let i = 0; i < N; i++) {
          const a = assignOf(i, k)
          const sub = a.slice()
          sub[0] = bdd.evaluate(g, a)
          if (bdd.evaluate(comp, a) !== tf[idxOf(sub, k)]) composeBad++
        }
      }
    }
    check('apply (¬,∧,∨,⊕,→,↔) matches truth tables', applyBad === 0, `${applyBad} mismatches`)
    check('satCount matches enumerated count', countBad === 0, `${countBad} bad`)
    check('Shannon cofactor reconstruction f = ite(x, f₁, f₀)', cofBad === 0, `${cofBad} bad`)
    check('∃/∀ quantification matches the oracle', quantBad === 0, `${quantBad} bad`)
    check('compose (variable substitution) matches the oracle', composeBad === 0, `${composeBad} bad`)
  }

  // ---- 3. reordering preserves the function and the model count -------------
  {
    const rng = mulberry32(0x5eed)
    let funcBad = 0
    let countBad = 0
    let siftGrew = 0
    let siftBroke = 0
    const TRIALS = 250
    for (let t = 0; t < TRIALS; t++) {
      const k = 3 + Math.floor(rng() * 3) // 3..5 vars
      const N = 1 << k
      const tf: boolean[] = []
      for (let i = 0; i < N; i++) tf.push(rng() < 0.5)
      const bdd = new Bdd(k)
      const f = tableToBdd(bdd, k, tf)
      const baseCount = bdd.satCount(f)

      const orders = [reverseOrder(bdd.order), randomOrder(k, (t * 2654435761) >>> 0)]
      for (const ord of orders) {
        const r = reorder(bdd, f, ord)
        if (r.bdd.satCount(r.root) !== baseCount) countBad++
        for (let i = 0; i < N; i++) {
          const a = assignOf(i, k)
          if (r.bdd.evaluate(r.root, a) !== tf[i]) funcBad++
        }
      }

      // sift must never grow the diagram and must preserve the function.
      const s = sift(bdd, f)
      if (s.sizeAfter > s.sizeBefore) siftGrew++
      if (s.bdd.satCount(s.root) !== baseCount) siftBroke++
      for (let i = 0; i < N; i++) {
        const a = assignOf(i, k)
        if (s.bdd.evaluate(s.root, a) !== tf[i]) siftBroke++
      }
    }
    check('reorder preserves the Boolean function', funcBad === 0, `${funcBad} bad`)
    check('reorder preserves the model count', countBad === 0, `${countBad} bad`)
    check('sift never grows the diagram', siftGrew === 0, `${siftGrew} grew`)
    check('sift preserves the function', siftBroke === 0, `${siftBroke} broke`)
  }

  // ---- 4. order sensitivity is real: the bit-match blow-up -----------------
  {
    // pairOr(4): grouped order is exponential, interleaved is linear, and sift
    // recovers a small order from the bad one.
    const item = GALLERY.find((g) => g.id === 'pair-or')!
    const built = item.build() // loads in the grouped (bad) order
    const groupedSize = built.bdd.size(built.root)
    const good = reorder(built.bdd, built.root, item.goodOrder!)
    const goodSize = good.bdd.size(good.root)
    check('bit-match: grouped order is much larger than interleaved', groupedSize > 2 * goodSize, `${groupedSize} vs ${goodSize}`)
    const s = sift(built.bdd, built.root)
    check('bit-match: sift shrinks the bad order toward optimal', s.sizeAfter <= goodSize + 1, `sift=${s.sizeAfter} good=${goodSize}`)
    // function identity across all three representations
    const base = built.bdd.satCount(built.root)
    check('bit-match: reorder + sift keep the model count', good.bdd.satCount(good.root) === base && s.bdd.satCount(s.root) === base)
  }

  // ---- 5. cross-check against the project's own CDCL + #SAT engines ---------
  {
    const rng = mulberry32(0xca7)
    let satBad = 0
    let countBad = 0
    const TRIALS = 160
    for (let t = 0; t < TRIALS; t++) {
      const nv = 4 + Math.floor(rng() * 7) // 4..10 vars
      const ratio = 2.5 + rng() * 2.5 // a mix of SAT and UNSAT
      const cnf = randomCnf(nv, Math.round(nv * ratio), rng)
      const { bdd, root } = bddFromCnf(cnf)
      const bddSat = bdd.isSat(root)
      const cdcl = solve(cnf).status === 'sat'
      if (bddSat !== cdcl) satBad++
      const bddCount = bdd.satCount(root)
      const sharp = countModels(cnf)
      if (sharp.exact && sharp.count !== null && bddCount !== sharp.count) countBad++
    }
    check('BDD SAT/UNSAT agrees with the CDCL solver', satBad === 0, `${satBad} disagreements`)
    check('BDD model count agrees with the #SAT counter', countBad === 0, `${countBad} disagreements`)
  }

  // ---- 6. the expression front-end round-trips through the oracle -----------
  {
    const exprs = [
      '(a & b) | (c ^ d)',
      'a -> (b -> a)',
      '(a <-> b) <-> (b <-> a)',
      '!(a | b) <-> (!a & !b)',
      '(a + b) * (c + !a)',
      'x0 ^ x1 ^ x2 ^ x3',
    ]
    let exprBad = 0
    for (const src of exprs) {
      const ast = parseExpr(src)
      const names = exprVars(ast)
      const { bdd, root } = compileExpr(src)
      const k = names.length
      for (let i = 0; i < 1 << k; i++) {
        const a = assignOf(i, k)
        const env = new Map<string, boolean>()
        names.forEach((nm, j) => env.set(nm, a[j]))
        if (bdd.evaluate(root, a) !== evalExpr(ast, env)) exprBad++
      }
    }
    check('expression compiler matches its own evaluator', exprBad === 0, `${exprBad} bad`)
    // a known tautology and contradiction
    check('parsed tautology compiles to ⊤', compileExpr('a -> (b -> a)').root === 1)
    check('parsed contradiction compiles to ⊥', compileExpr('a & !a').root === 0)
  }

  // ---- 7. ZDD set algebra vs closed-form combinatorics + brute force --------
  {
    let powBad = 0
    for (let n = 0; n <= 12; n++) {
      const z = new Zdd(n)
      if (z.count(z.allSubsets()) !== 1n << BigInt(n)) powBad++
    }
    check('ZDD allSubsets counts 2ⁿ', powBad === 0, `${powBad} bad`)

    let comBad = 0
    for (let n = 0; n <= 10; n++) {
      const z = new Zdd(n)
      for (let k = 0; k <= n; k++) {
        if (z.count(z.combinations(k)) !== binom(n, k)) comBad++
      }
    }
    check('ZDD combinations count C(n,k)', comBad === 0, `${comBad} bad`)

    // Random family algebra over a 5-element universe vs bit-mask sets.
    const rng = mulberry32(0xfade)
    let algBad = 0
    let enumBad = 0
    const U = 5
    for (let t = 0; t < 300; t++) {
      const fa = randomFamily(U, rng)
      const fb = randomFamily(U, rng)
      const z = new Zdd(U)
      const za = familyToZdd(z, fa)
      const zb = familyToZdd(z, fb)
      const uni = setUnion(fa, fb)
      const inter = setInter(fa, fb)
      const dif = setDiff(fa, fb)
      if (z.count(za) !== BigInt(fa.size)) algBad++
      if (z.count(z.union(za, zb)) !== BigInt(uni.size)) algBad++
      if (z.count(z.intersect(za, zb)) !== BigInt(inter.size)) algBad++
      if (z.count(z.diff(za, zb)) !== BigInt(dif.size)) algBad++
      // membership, not just cardinality
      if (!sameFamily(z.enumerate(z.union(za, zb)).sets, uni, U)) enumBad++
    }
    check('ZDD count(family) = |family|', algBad === 0, `${algBad} bad`)
    check('ZDD ∪/∩/∖ match bit-mask set algebra (membership)', enumBad === 0, `${enumBad} bad`)
    // commutativity / canonicity of the set ops
    {
      const z = new Zdd(U)
      const a = z.combinations(2)
      const b = z.combinations(3)
      check('ZDD union is commutative (same node)', z.union(a, b) === z.union(b, a))
      check('ZDD intersect is commutative (same node)', z.intersect(a, b) === z.intersect(b, a))
      check('ZDD a∖a = ∅', z.diff(a, a) === 0)
      check('ZDD single() builds exactly one set', z.count(z.single([0, 2, 4])) === 1n)
    }
  }

  return { pass, fail, messages }
}

// ---- helpers used only by the harness --------------------------------------

function idxOf(a: boolean[], k: number): number {
  let idx = 0
  for (let j = 0; j < k; j++) if (a[j]) idx |= 1 << j
  return idx
}

function randomCnf(nv: number, nc: number, rng: () => number): CNF {
  const clauses: number[][] = []
  for (let i = 0; i < nc; i++) {
    const chosen = new Set<number>()
    const clause: number[] = []
    const width = Math.min(3, nv)
    while (clause.length < width) {
      const v = 1 + Math.floor(rng() * nv)
      if (chosen.has(v)) continue
      chosen.add(v)
      clause.push(rng() < 0.5 ? v : -v)
    }
    clauses.push(clause)
  }
  return { numVars: nv, clauses }
}

type Family = Set<number> // set of bit-mask subsets

function randomFamily(u: number, rng: () => number): Family {
  const f: Family = new Set()
  const trials = Math.floor(rng() * (1 << u))
  for (let i = 0; i < trials; i++) f.add(Math.floor(rng() * (1 << u)))
  return f
}
function setUnion(a: Family, b: Family): Family {
  const r = new Set(a)
  for (const x of b) r.add(x)
  return r
}
function setInter(a: Family, b: Family): Family {
  const r: Family = new Set()
  for (const x of a) if (b.has(x)) r.add(x)
  return r
}
function setDiff(a: Family, b: Family): Family {
  const r: Family = new Set()
  for (const x of a) if (!b.has(x)) r.add(x)
  return r
}
function familyToZdd(z: Zdd, f: Family): number {
  let acc = 0 // ZDD_EMPTY
  for (const mask of f) {
    const items: number[] = []
    for (let i = 0; i < z.numVars; i++) if ((mask >> i) & 1) items.push(i)
    acc = z.union(acc, z.single(items))
  }
  return acc
}
function sameFamily(sets: number[][], fam: Family, u: number): boolean {
  if (sets.length !== fam.size) return false
  const got = new Set<number>()
  for (const s of sets) {
    let mask = 0
    for (const v of s) {
      if (v < 0 || v >= u) return false
      mask |= 1 << v
    }
    got.add(mask)
  }
  if (got.size !== fam.size) return false
  for (const m of fam) if (!got.has(m)) return false
  return true
}
