// The grounder: instantiate a first-order program into the finite ground program
// that the solver and oracle consume.
//
// It uses the standard "intelligent grounding" idea. Grounding a rule means
// finding every substitution that makes its *positive* body true, so we first
// compute the set of ground atoms that can *possibly* be derived — a
// least-fixpoint that ignores negation (treats every `not` as satisfiable) and
// grows the possible set by firing rule heads whose positive bodies are already
// possible. Because there are no function terms the Herbrand base is finite, so
// this terminates; and because a rule can only ever fire on a substitution whose
// positive atoms are possible, grounding against the possible set loses nothing.
//
// Safety: every variable in a rule must be *bound* — appear in a positive body
// atom, or be assigned by an `X = expr` comparison whose right-hand side is
// already bound. Unsafe rules are rejected with a clear message.

import type { Term, Atom, BodyLit, Rule } from './ast'
import { varsOfAtom, varsOfTerm } from './ast'
import type { GroundProgram, Rule as GRule } from './program'
import { makeAtomTable } from './program'

/** A ground value: an integer, or a symbolic constant name. */
type GVal = { n: number } | { s: string }
type Subst = Map<string, GVal>

function gvalKey(v: GVal): string {
  return 'n' in v ? `#${v.n}` : v.s
}
function gvalStr(v: GVal): string {
  return 'n' in v ? String(v.n) : v.s
}
// ASP's standard total order: integers precede symbolic constants; integers by
// value; constants lexicographically.
function gvalCmp(a: GVal, b: GVal): number {
  const an = 'n' in a
  const bn = 'n' in b
  if (an && bn) return (a as { n: number }).n - (b as { n: number }).n
  if (an) return -1
  if (bn) return 1
  const as = (a as { s: string }).s
  const bs = (b as { s: string }).s
  return as < bs ? -1 : as > bs ? 1 : 0
}

export class GroundError extends Error {}

/** Evaluate a fully-bound term to a ground value (integers for arithmetic). */
function evalTerm(t: Term, subst: Subst): GVal {
  switch (t.t) {
    case 'int':
      return { n: t.v }
    case 'const':
      return { s: t.name }
    case 'var': {
      const v = subst.get(t.name)
      if (v === undefined) throw new GroundError(`unbound variable ${t.name}`)
      return v
    }
    case 'neg': {
      const a = evalTerm(t.a, subst)
      if (!('n' in a)) throw new GroundError(`arithmetic on non-integer`)
      return { n: -a.n }
    }
    case 'bin': {
      const a = evalTerm(t.a, subst)
      const b = evalTerm(t.b, subst)
      if (!('n' in a) || !('n' in b)) throw new GroundError(`arithmetic on non-integer`)
      const x = a.n
      const y = b.n
      switch (t.op) {
        case '+':
          return { n: x + y }
        case '-':
          return { n: x - y }
        case '*':
          return { n: x * y }
        case '/':
          if (y === 0) throw new GroundError(`division by zero`)
          return { n: Math.trunc(x / y) }
        case '\\':
          if (y === 0) throw new GroundError(`modulo by zero`)
          return { n: x % y }
      }
    }
  }
}

function isBound(t: Term, subst: Subst): boolean {
  const vs = new Set<string>()
  varsOfTerm(t, vs)
  for (const v of vs) if (!subst.has(v)) return false
  return true
}

function compare(op: string, a: GVal, b: GVal): boolean {
  const c = gvalCmp(a, b)
  switch (op) {
    case '=':
      return gvalKey(a) === gvalKey(b)
    case '!=':
      return gvalKey(a) !== gvalKey(b)
    case '<':
      return c < 0
    case '<=':
      return c <= 0
    case '>':
      return c > 0
    case '>=':
      return c >= 0
  }
  return false
}

/** Instantiate an atom (expanding any `lo..hi` ranges) into ground name(s). */
function instantiateAtom(atom: Atom, subst: Subst): string[] {
  const dims: GVal[][] = []
  for (const arg of atom.args) {
    if (arg.a === 'term') dims.push([evalTerm(arg.term, subst)])
    else {
      const lo = evalTerm(arg.lo, subst)
      const hi = evalTerm(arg.hi, subst)
      if (!('n' in lo) || !('n' in hi)) throw new GroundError(`range bounds must be integers`)
      const seq: GVal[] = []
      for (let x = lo.n; x <= hi.n; x++) seq.push({ n: x })
      dims.push(seq)
    }
  }
  // cross product
  let combos: GVal[][] = [[]]
  for (const dim of dims) {
    const next: GVal[][] = []
    for (const c of combos) for (const v of dim) next.push([...c, v])
    combos = next
  }
  return combos.map((c) => (c.length === 0 ? atom.pred : `${atom.pred}(${c.map(gvalStr).join(',')})`))
}

interface Possible {
  /** ground atom name -> parsed value list, keyed for matching. */
  byKey: Map<string, GVal[]>
  /** pred/arity -> list of {name, args} for the join. */
  byPred: Map<string, { name: string; args: GVal[] }[]>
}

function addPossible(pos: Possible, name: string, args: GVal[]): boolean {
  if (pos.byKey.has(name)) return false
  pos.byKey.set(name, args)
  const key = `${name.includes('(') ? name.slice(0, name.indexOf('(')) : name}/${args.length}`
  let list = pos.byPred.get(key)
  if (!list) {
    list = []
    pos.byPred.set(key, list)
  }
  list.push({ name, args })
  return true
}

/** Try to unify a (non-ground) atom's args against a ground candidate's values,
 *  extending `subst`. Returns the new substitution, or null on mismatch. */
function unify(atom: Atom, cand: GVal[], subst: Subst): Subst | null {
  if (atom.args.length !== cand.length) return null
  const s = new Map(subst)
  for (let i = 0; i < atom.args.length; i++) {
    const arg = atom.args[i]
    if (arg.a === 'range') return null // ranges are not allowed in matched (body) atoms
    const term = arg.term
    if (term.t === 'var') {
      const prev = s.get(term.name)
      if (prev === undefined) s.set(term.name, cand[i])
      else if (gvalKey(prev) !== gvalKey(cand[i])) return null
    } else {
      if (!isBound(term, s)) return null
      try {
        if (gvalKey(evalTerm(term, s)) !== gvalKey(cand[i])) return null
      } catch {
        return null // e.g. arithmetic on a symbolic constant — treat as mismatch
      }
    }
  }
  return s
}

/** All substitutions satisfying a literal list's positive atoms + comparisons,
 *  matching positive atoms against the possible set. Comparisons of the form
 *  `X = expr` (X unbound, expr bound) act as let-bindings. */
function* matchLiterals(lits: BodyLit[], pos: Possible, base: Subst): Generator<Subst> {
  const posAtoms = lits.filter((l): l is { k: 'pos'; atom: Atom } => l.k === 'pos')
  const cmps = lits.filter((l): l is { k: 'cmp'; op: import('./ast').CompareOp; a: Term; b: Term } => l.k === 'cmp')

  function* rec(i: number, subst: Subst): Generator<Subst> {
    if (i === posAtoms.length) {
      const done = evalCmps(cmps, subst)
      if (done) yield done
      return
    }
    const atom = posAtoms[i].atom
    const key = `${atom.pred}/${atom.args.length}`
    const list = pos.byPred.get(key) ?? []
    for (const cand of list) {
      const s2 = unify(atom, cand.args, subst)
      if (s2) yield* rec(i + 1, s2)
    }
  }
  yield* rec(0, new Map(base))
}

/** Evaluate/apply the comparison built-ins under `subst`. Returns the (possibly
 *  extended) substitution if all hold, or null if any fails or stays unbound. */
function evalCmps(cmps: { op: import('./ast').CompareOp; a: Term; b: Term }[], subst: Subst): Subst | null {
  const s = new Map(subst)
  const pending = cmps.slice()
  // let-bindings first, to a fixpoint
  let progress = true
  while (progress) {
    progress = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const c = pending[i]
      if (c.op !== '=') continue
      const aBound = isBound(c.a, s)
      const bBound = isBound(c.b, s)
      if (aBound && bBound) continue // handled as a check below
      // exactly one side an unbound bare variable?
      try {
        if (!aBound && c.a.t === 'var' && bBound) {
          s.set(c.a.name, evalTerm(c.b, s))
          pending.splice(i, 1)
          progress = true
        } else if (!bBound && c.b.t === 'var' && aBound) {
          s.set(c.b.name, evalTerm(c.a, s))
          pending.splice(i, 1)
          progress = true
        }
      } catch {
        return null
      }
    }
  }
  for (const c of pending) {
    if (!isBound(c.a, s) || !isBound(c.b, s)) return null
    try {
      if (!compare(c.op, evalTerm(c.a, s), evalTerm(c.b, s))) return null
    } catch {
      return null
    }
  }
  return s
}

function positiveAtomsOf(lits: BodyLit[]): Atom[] {
  return lits.filter((l): l is { k: 'pos'; atom: Atom } => l.k === 'pos').map((l) => l.atom)
}

/** Check safety and report the first unsafe rule variable, if any. */
function checkSafety(r: Rule): string | null {
  // Variables bound by positive body atoms + `X = ...` chains.
  const bound = new Set<string>()
  for (const atom of positiveAtomsOf(r.body)) varsOfAtom(atom, bound)
  // let-binding chains
  let progress = true
  const eqs = r.body.filter((l): l is { k: 'cmp'; op: import('./ast').CompareOp; a: Term; b: Term } => l.k === 'cmp' && l.op === '=')
  while (progress) {
    progress = false
    for (const c of eqs) {
      const rhsVars = new Set<string>()
      const lhsVars = new Set<string>()
      varsOfTerm(c.a, lhsVars)
      varsOfTerm(c.b, rhsVars)
      if (c.a.t === 'var' && !bound.has(c.a.name) && [...rhsVars].every((v) => bound.has(v))) {
        bound.add(c.a.name)
        progress = true
      }
      if (c.b.t === 'var' && !bound.has(c.b.name) && [...lhsVars].every((v) => bound.has(v))) {
        bound.add(c.b.name)
        progress = true
      }
    }
  }
  // every variable anywhere must be bound
  const all = new Set<string>()
  const collect = (lits: BodyLit[]) => {
    for (const l of lits) {
      if (l.k === 'pos' || l.k === 'neg') varsOfAtom(l.atom, all)
      else {
        varsOfTerm(l.a, all)
        varsOfTerm(l.b, all)
      }
    }
  }
  collect(r.body)
  if (r.head.h === 'atom') varsOfAtom(r.head.atom, all)
  else if (r.head.h === 'choice') {
    for (const e of r.head.elems) {
      varsOfAtom(e.atom, all)
      collect(e.cond)
    }
    if (r.head.lo) varsOfTerm(r.head.lo, all)
    if (r.head.hi) varsOfTerm(r.head.hi, all)
  }
  // choice condition local variables are bound within the condition, not globally.
  const localBound = new Set(bound)
  if (r.head.h === 'choice') {
    for (const e of r.head.elems) for (const atom of positiveAtomsOf(e.cond)) varsOfAtom(atom, localBound)
  }
  for (const v of all) if (!localBound.has(v)) return v
  return null
}

export interface GroundResult {
  program: GroundProgram
  errors: string[]
  warnings: string[]
}

/** Ground a list of parsed rules into a finite ground program. */
export function ground(rules: Rule[]): GroundResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Filter out unsafe rules up front.
  const safe: Rule[] = []
  for (const r of rules) {
    const bad = checkSafety(r)
    if (bad) errors.push(`line ${r.line}: unsafe — variable ${bad} is not bound by a positive body literal`)
    else safe.push(r)
  }

  // ---- fixpoint: compute the possible-atom set ----
  const pos: Possible = { byKey: new Map(), byPred: new Map() }
  const parseName = (name: string): { pred: string; args: GVal[] } => {
    const lp = name.indexOf('(')
    if (lp < 0) return { pred: name, args: [] }
    return { pred: name.slice(0, lp), args: [] } // args unused for seeding
  }
  void parseName

  const addAtomInstances = (atom: Atom, subst: Subst): boolean => {
    let added = false
    let names: string[]
    try {
      names = instantiateAtom(atom, subst)
    } catch {
      return false
    }
    for (const name of names) {
      const lp = name.indexOf('(')
      const args: GVal[] = lp < 0 ? [] : parseArgs(name.slice(lp + 1, -1))
      if (addPossible(pos, name, args)) added = true
    }
    return added
  }

  let changed = true
  let guard = 0
  while (changed && guard++ < 100000) {
    changed = false
    for (const r of safe) {
      const bodyLits = r.body
      for (const subst of matchLiterals(bodyLits, pos, new Map())) {
        if (r.head.h === 'atom') {
          if (addAtomInstances(r.head.atom, subst)) changed = true
        } else if (r.head.h === 'choice') {
          for (const e of r.head.elems) {
            for (const s2 of matchLiterals(e.cond, pos, subst)) {
              if (addAtomInstances(e.atom, s2)) changed = true
            }
          }
        }
        // constraints add nothing
      }
    }
  }

  // ---- emit ground rules ----
  const table = makeAtomTable()
  const grules: GRule[] = []
  const idOf = (name: string): number => table.id(name)
  const single = (atom: Atom, subst: Subst): string => {
    const names = instantiateAtom(atom, subst)
    return names[0]
  }

  const groundNeg = (lits: BodyLit[], subst: Subst): { pos: number[]; neg: number[] } | null => {
    const posIds: number[] = []
    const negIds: number[] = []
    for (const l of lits) {
      if (l.k === 'pos') {
        const name = single(l.atom, subst)
        posIds.push(idOf(name))
      } else if (l.k === 'neg') {
        let names: string[]
        try {
          names = instantiateAtom(l.atom, subst)
        } catch {
          return null
        }
        for (const name of names) {
          if (pos.byKey.has(name)) negIds.push(idOf(name))
          // else: this negative atom can never be true → literal is satisfied → drop it
        }
      }
      // comparisons already enforced by matchLiterals
    }
    return { pos: posIds, neg: negIds }
  }

  for (const r of safe) {
    try {
      for (const subst of matchLiterals(r.body, pos, new Map())) {
        const bodyIds = groundNeg(r.body, subst)
        if (!bodyIds) continue
        if (r.head.h === 'constraint') {
          grules.push({ kind: 'constraint', pos: bodyIds.pos, neg: bodyIds.neg })
        } else if (r.head.h === 'atom') {
          for (const name of instantiateAtom(r.head.atom, subst)) {
            grules.push({ kind: 'normal', head: idOf(name), pos: bodyIds.pos.slice(), neg: bodyIds.neg.slice() })
          }
        } else {
          // choice
          const heads: number[] = []
          const seen = new Set<number>()
          for (const e of r.head.elems) {
            for (const s2 of matchLiterals(e.cond, pos, subst)) {
              for (const name of instantiateAtom(e.atom, s2)) {
                if (!pos.byKey.has(name)) continue
                const id = idOf(name)
                if (!seen.has(id)) {
                  seen.add(id)
                  heads.push(id)
                }
              }
            }
          }
          const lo = r.head.lo ? boundVal(r.head.lo, subst) : null
          const hi = r.head.hi ? boundVal(r.head.hi, subst) : null
          grules.push({ kind: 'choice', heads, lo, hi, pos: bodyIds.pos, neg: bodyIds.neg })
        }
      }
    } catch (e) {
      errors.push(`line ${r.line}: ${(e as Error).message}`)
    }
  }

  const program: GroundProgram = { numAtoms: table.count, atomNames: table.names, rules: grules }
  return { program, errors, warnings }
}

function boundVal(t: Term, subst: Subst): number {
  const v = evalTerm(t, subst)
  if (!('n' in v)) throw new GroundError(`cardinality bound must be an integer`)
  return v.n
}

/** Parse the comma-separated argument values inside an already-formatted ground
 *  atom name back into ground values (integers vs. symbolic constants). Only
 *  top-level commas matter — there are no nested function terms. */
function parseArgs(inside: string): GVal[] {
  if (inside === '') return []
  return inside.split(',').map((piece) => {
    const p = piece.trim()
    if (/^-?\d+$/.test(p)) return { n: Number(p) } as GVal
    return { s: p } as GVal
  })
}
