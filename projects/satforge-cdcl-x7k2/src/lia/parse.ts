// A tolerant parser for human-typed integer linear constraint systems, one
// relation per line:
//
//     2x + 3y <= 12
//     x - y = 1
//     x >= 0 ; y >= 0           (';' also separates constraints)
//     # comments with # or //
//
// Relations: <=, >=, =, ==, <, > . Strict < / > are exact over the integers
// (a < b ⇔ a ≤ b−1). Coefficients may be written `3x`, `3*x`, or just `x`;
// either side may hold variables and constants. Variables are collected in
// first-seen order, which fixes their column ids for the Omega test.

import { type Lin, addConst, addScaled, sub, zero } from './lin'
import type { Cons } from './omega'

export interface ParseOk {
  ok: true
  constraints: Cons[]
  names: string[]
}
export interface ParseErr {
  ok: false
  error: string
  line?: number
}
export type ParseResult = ParseOk | ParseErr

type Tok =
  | { k: 'num'; v: bigint }
  | { k: 'id'; v: string }
  | { k: 'op'; v: '+' | '-' | '*' }

function tokenize(s: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < s.length && s[j] >= '0' && s[j] <= '9') j++
      out.push({ k: 'num', v: BigInt(s.slice(i, j)) })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++
      out.push({ k: 'id', v: s.slice(i, j) })
      i = j
      continue
    }
    if (ch === '+' || ch === '-' || ch === '*') {
      out.push({ k: 'op', v: ch })
      i++
      continue
    }
    throw new Error(`unexpected character '${ch}'`)
  }
  return out
}

function parseExpr(src: string, reg: Map<string, number>, names: string[]): Lin {
  const toks = tokenize(src)
  if (toks.length === 0) throw new Error('empty expression')
  let i = 0
  let lin = zero()

  const readSigns = (): bigint => {
    let net = 1n
    while (i < toks.length && toks[i].k === 'op' && (toks[i] as { v: string }).v !== '*') {
      if ((toks[i] as { v: string }).v === '-') net = -net
      i++
    }
    return net
  }

  const readTerm = (sign: bigint): void => {
    let coef: bigint | null = null
    if (i < toks.length && toks[i].k === 'num') {
      coef = (toks[i] as { v: bigint }).v
      i++
    }
    if (i < toks.length && toks[i].k === 'op' && (toks[i] as { v: string }).v === '*') i++
    let id: string | null = null
    if (i < toks.length && toks[i].k === 'id') {
      id = (toks[i] as { v: string }).v
      i++
    }
    if (coef === null && id === null) throw new Error('expected a number or variable')
    if (id !== null) {
      let v = reg.get(id)
      if (v === undefined) {
        v = names.length
        reg.set(id, v)
        names.push(id)
      }
      lin = addScaled(lin, { c: 0n, t: new Map([[v, 1n]]) }, sign * (coef ?? 1n))
    } else {
      lin = addConst(lin, sign * coef!)
    }
  }

  let s = readSigns()
  readTerm(s)
  while (i < toks.length) {
    if (toks[i].k !== 'op' || (toks[i] as { v: string }).v === '*')
      throw new Error('expected + or - between terms')
    s = readSigns()
    readTerm(s)
  }
  return lin
}

const RELS = ['<=', '>=', '==', '=', '<', '>'] as const
type Rel = (typeof RELS)[number]

function findRel(line: string): { rel: Rel; at: number } | null {
  let best: { rel: Rel; at: number } | null = null
  for (const rel of RELS) {
    const at = line.indexOf(rel)
    if (at < 0) continue
    // Prefer the earliest; among equal positions prefer the longer operator.
    if (!best || at < best.at || (at === best.at && rel.length > best.rel.length)) {
      best = { rel, at }
    }
  }
  return best
}

function buildCons(rel: Rel, L: Lin, R: Lin): Cons {
  switch (rel) {
    case '=':
    case '==':
      return { lin: sub(L, R), op: 'eq' } // L − R = 0
    case '<=':
      return { lin: sub(R, L), op: 'ge' } // R − L ≥ 0
    case '>=':
      return { lin: sub(L, R), op: 'ge' } // L − R ≥ 0
    case '<':
      return { lin: addConst(sub(R, L), -1n), op: 'ge' } // R − L − 1 ≥ 0
    case '>':
      return { lin: addConst(sub(L, R), -1n), op: 'ge' } // L − R − 1 ≥ 0
  }
}

export interface ObjectiveOk {
  ok: true
  lin: Lin
}
export interface ObjectiveErr {
  ok: false
  error: string
}
export type ObjectiveResult = ObjectiveOk | ObjectiveErr

/**
 * Parse a linear objective expression against an *existing* variable order (the
 * names already collected from the constraints). Unknown variables are rejected
 * — an objective may only score variables the system constrains — so a stray
 * identifier is a friendly error rather than a silently-unbounded column.
 */
export function parseObjective(text: string, names: string[]): ObjectiveResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'empty objective' }
  const reg = new Map<string, number>()
  names.forEach((n, i) => reg.set(n, i))
  const before = names.length
  // Clone the names array so parseExpr can append, then detect new entries.
  const scratch = [...names]
  let lin: Lin
  try {
    lin = parseExpr(trimmed, reg, scratch)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'parse error' }
  }
  if (scratch.length > before) {
    const extra = scratch.slice(before).join(', ')
    return { ok: false, error: `objective references unknown variable(s): ${extra}` }
  }
  return { ok: true, lin }
}

export function parseLia(text: string): ParseResult {
  const reg = new Map<string, number>()
  const names: string[] = []
  const constraints: Cons[] = []
  const rawLines = text.split('\n')
  for (let ln = 0; ln < rawLines.length; ln++) {
    let line = rawLines[ln]
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash)
    const slash = line.indexOf('//')
    if (slash >= 0) line = line.slice(0, slash)
    for (const piece of line.split(';')) {
      const trimmed = piece.trim()
      if (!trimmed) continue
      try {
        const found = findRel(trimmed)
        if (!found)
          return { ok: false, error: `no relation (<=, >=, =, <, >) found`, line: ln + 1 }
        const lhs = trimmed.slice(0, found.at).trim()
        const rhs = trimmed.slice(found.at + found.rel.length).trim()
        if (!lhs || !rhs) return { ok: false, error: 'missing left- or right-hand side', line: ln + 1 }
        const L = parseExpr(lhs, reg, names)
        const R = parseExpr(rhs, reg, names)
        constraints.push(buildCons(found.rel, L, R))
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'parse error', line: ln + 1 }
      }
    }
  }
  if (constraints.length === 0) return { ok: false, error: 'no constraints' }
  if (names.length === 0) return { ok: false, error: 'no variables in the system' }
  return { ok: true, constraints, names }
}
