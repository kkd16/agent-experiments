// Aether — match exhaustiveness & redundancy analysis
//
// An implementation of Maranget's pattern "usefulness" algorithm
// (https://www.cs.tufts.edu/comp/150FP/archive/luc-maranget/warn.pdf),
// specialised to Aether's pattern domain. It answers two questions about a
// `match`:
//   • is it exhaustive? (and if not, a witness value that nothing matches)
//   • is any clause redundant? (unreachable given the clauses above it)
// Results are surfaced as non-fatal warnings.

import type { Pattern, TypeExpr } from './ast.ts'
import type { Type } from './types.ts'
import { ARROW, LIST, TUPLE, prune } from './types.ts'

// Normalised pattern: either a wildcard, or a constructor with sub-patterns.
type NPat = { wild: true } | { wild: false; ctor: string; args: NPat[] }

const WILD: NPat = { wild: true }

function toNPat(p: Pattern): NPat {
  switch (p.kind) {
    case 'pwild':
    case 'pvar':
      return WILD
    case 'pint':
      return { wild: false, ctor: `int:${p.value}`, args: [] }
    case 'pfloat':
      return { wild: false, ctor: `float:${p.value}`, args: [] }
    case 'pstr':
      return { wild: false, ctor: `str:${JSON.stringify(p.value)}`, args: [] }
    case 'pbool':
      return { wild: false, ctor: p.value ? 'true' : 'false', args: [] }
    case 'punit':
      return { wild: false, ctor: 'unit', args: [] }
    case 'pnil':
      return { wild: false, ctor: 'nil', args: [] }
    case 'pcons':
      return { wild: false, ctor: 'cons', args: [toNPat(p.head), toNPat(p.tail)] }
    case 'ptuple':
      return { wild: false, ctor: 'tuple', args: p.elements.map(toNPat) }
    case 'pcon':
      return { wild: false, ctor: p.name, args: p.args.map(toNPat) }
  }
}

interface CtorShape {
  name: string
  arity: number
  argTypes: Type[]
}

// The complete constructor signature of a type, or `infinite` for types with
// unbounded constructors (Int/Float/String, type variables, unknowns).
type Signature = { kind: 'finite'; ctors: CtorShape[] } | { kind: 'infinite' }

export interface TypeCtorInfo {
  params: string[]
  ctors: { name: string; argTypeExprs: TypeExpr[] }[]
}

type ConvertFn = (te: TypeExpr, params: Map<string, Type>) => Type

function signatureOf(
  type: Type,
  typeCtors: Map<string, TypeCtorInfo>,
  convert: ConvertFn,
): Signature {
  const t = prune(type)
  if (t.kind === 'var') return { kind: 'infinite' }
  switch (t.name) {
    case 'Bool':
      return {
        kind: 'finite',
        ctors: [
          { name: 'true', arity: 0, argTypes: [] },
          { name: 'false', arity: 0, argTypes: [] },
        ],
      }
    case 'Unit':
      return { kind: 'finite', ctors: [{ name: 'unit', arity: 0, argTypes: [] }] }
    case LIST: {
      const elem = t.args[0]
      return {
        kind: 'finite',
        ctors: [
          { name: 'nil', arity: 0, argTypes: [] },
          { name: 'cons', arity: 2, argTypes: [elem, t] },
        ],
      }
    }
    case TUPLE:
      return {
        kind: 'finite',
        ctors: [{ name: 'tuple', arity: t.args.length, argTypes: t.args }],
      }
    case ARROW:
      return { kind: 'infinite' }
    default: {
      const info = typeCtors.get(t.name)
      if (!info) return { kind: 'infinite' }
      const subst = new Map<string, Type>()
      info.params.forEach((p, i) => subst.set(p, t.args[i] ?? prune({ kind: 'var', id: -1, ref: null })))
      const ctors = info.ctors.map((c) => {
        const argTypes = c.argTypeExprs.map((te) => convert(te, subst))
        return { name: c.name, arity: argTypes.length, argTypes }
      })
      return { kind: 'finite', ctors }
    }
  }
}

function wildcards(n: number): NPat[] {
  return Array.from({ length: n }, () => WILD)
}

// rows of P matching constructor `name`/`arity`, with that column expanded
function specialize(matrix: NPat[][], name: string, arity: number): NPat[][] {
  const out: NPat[][] = []
  for (const row of matrix) {
    const head = row[0]
    if (head.wild) {
      out.push([...wildcards(arity), ...row.slice(1)])
    } else if (head.ctor === name) {
      out.push([...head.args, ...row.slice(1)])
    }
  }
  return out
}

// rows of P with a wildcard in the first column, that column dropped
function defaultMatrix(matrix: NPat[][]): NPat[][] {
  const out: NPat[][] = []
  for (const row of matrix) {
    if (row[0].wild) out.push(row.slice(1))
  }
  return out
}

function headCtors(matrix: NPat[][]): Set<string> {
  const s = new Set<string>()
  for (const row of matrix) {
    const h = row[0]
    if (!h.wild) s.add(h.ctor)
  }
  return s
}

/**
 * Maranget's U: is `q` useful w.r.t. matrix `P` (is there a value matched by `q`
 * but no row of `P`)? Returns a witness row if so, else null. `types` gives the
 * type of each column, used to know complete constructor signatures.
 */
function useful(
  matrix: NPat[][],
  q: NPat[],
  types: Type[],
  typeCtors: Map<string, TypeCtorInfo>,
  convert: ConvertFn,
): NPat[] | null {
  if (types.length === 0) {
    return matrix.length === 0 ? [] : null
  }
  const q0 = q[0]
  const restTypes = types.slice(1)

  if (!q0.wild) {
    const spec = specialize(matrix, q0.ctor, q0.args.length)
    const sig = signatureOf(types[0], typeCtors, convert)
    const argTypes =
      sig.kind === 'finite'
        ? (sig.ctors.find((c) => c.name === q0.ctor)?.argTypes ?? wildcardsTypes(q0.args.length))
        : wildcardsTypes(q0.args.length)
    const w = useful(spec, [...q0.args, ...q.slice(1)], [...argTypes, ...restTypes], typeCtors, convert)
    return w ? reconstruct(q0.ctor, q0.args.length, w) : null
  }

  const sig = signatureOf(types[0], typeCtors, convert)
  const present = headCtors(matrix)
  if (sig.kind === 'finite' && sig.ctors.every((c) => present.has(c.name))) {
    for (const ck of sig.ctors) {
      const spec = specialize(matrix, ck.name, ck.arity)
      const w = useful(
        spec,
        [...wildcards(ck.arity), ...q.slice(1)],
        [...ck.argTypes, ...restTypes],
        typeCtors,
        convert,
      )
      if (w) return reconstruct(ck.name, ck.arity, w)
    }
    return null
  }

  const w = useful(defaultMatrix(matrix), q.slice(1), restTypes, typeCtors, convert)
  if (!w) return null
  let head: NPat = WILD
  if (sig.kind === 'finite') {
    const missing = sig.ctors.find((c) => !present.has(c.name))
    if (missing) head = { wild: false, ctor: missing.name, args: wildcards(missing.arity) }
  }
  return [head, ...w]
}

// types are only consulted when a column actually has a finite signature; for
// reconstructed argument columns of an unknown ctor we use placeholders.
function wildcardsTypes(n: number): Type[] {
  return Array.from({ length: n }, () => ({ kind: 'var', id: -1, ref: null }) as Type)
}

function reconstruct(name: string, arity: number, w: NPat[]): NPat[] {
  const args = w.slice(0, arity)
  return [{ wild: false, ctor: name, args }, ...w.slice(arity)]
}

function renderNPat(p: NPat, prec = 0): string {
  if (p.wild) return '_'
  switch (p.ctor) {
    case 'nil':
      return '[]'
    case 'cons': {
      const s = `${renderNPat(p.args[0], 1)} :: ${renderNPat(p.args[1], 0)}`
      return prec > 0 ? `(${s})` : s
    }
    case 'tuple':
      return `(${p.args.map((a) => renderNPat(a, 0)).join(', ')})`
    case 'unit':
      return '()'
    case 'true':
    case 'false':
      return p.ctor
    default: {
      if (p.ctor.startsWith('int:')) return p.ctor.slice(4)
      if (p.ctor.startsWith('float:')) return p.ctor.slice(6)
      if (p.ctor.startsWith('str:')) return p.ctor.slice(4)
      if (p.args.length === 0) return p.ctor
      const s = `${p.ctor} ${p.args.map((a) => renderNPat(a, 1)).join(' ')}`
      return prec > 0 ? `(${s})` : s
    }
  }
}

export interface MatchAnalysis {
  /** witness patterns for values not covered (empty if exhaustive) */
  missing: string[]
  /** indices of clauses that can never be reached */
  redundant: number[]
}

export function analyzeMatch(
  patterns: Pattern[],
  guarded: boolean[],
  scrutType: Type,
  typeCtors: Map<string, TypeCtorInfo>,
  convert: ConvertFn,
): MatchAnalysis {
  // Only unguarded clauses are guaranteed to match, so only they contribute to
  // coverage. A guarded clause is still redundant if a prior unguarded clause
  // already covers its pattern.
  const rows: NPat[][] = []
  const redundant: number[] = []
  for (let i = 0; i < patterns.length; i++) {
    const row = [toNPat(patterns[i])]
    if (useful(rows, row, [scrutType], typeCtors, convert) === null) {
      redundant.push(i)
    }
    if (!guarded[i]) rows.push(row)
  }
  const witness = useful(rows, [WILD], [scrutType], typeCtors, convert)
  const missing = witness ? [renderNPat(witness[0])] : []
  return { missing, redundant }
}
