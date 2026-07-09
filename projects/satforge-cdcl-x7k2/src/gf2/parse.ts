// Two front-ends for authoring XOR-CNF problems in the studio.
//
//   • **Extended DIMACS** — the standard interchange format, plus CryptoMiniSat's
//     `x`-clause extension: a line `x ℓ₁ … ℓ_k 0` is a parity constraint, an
//     ordinary line is a clause. Tolerant of loose headers (variable count is
//     inferred from the literals actually used).
//   • **A tiny DSL** for hand-writing parity systems quickly: one constraint per
//     line, e.g. `x1 ^ x2 ^ x3 = 1`, `a xor b = 0`, or a clause `x1 | -x2 | x3`.
//     Variables are `x<n>` or bare integers; `-`/`~`/`!` negate a literal.
//
// Both funnel into the same `XorCnf`, so whatever a user types is immediately
// solvable by the hybrid engine *and* expandable to plain CNF for the
// independent clausal cross-check.

import { normalizeXorLits, type XorCnf, type XorClause } from './xor'

export interface ParseXorOk {
  ok: true
  problem: XorCnf
  warnings: string[]
}
export interface ParseXorErr {
  ok: false
  error: string
  line: number
}
export type ParseXorResult = ParseXorOk | ParseXorErr

/** Parse extended DIMACS (ordinary clauses + `x` XOR clauses). */
export function parseXorDimacs(text: string): ParseXorResult {
  const warnings: string[] = []
  const comments: string[] = []
  const clauses: number[][] = []
  const xors: XorClause[] = []
  let declaredVars = 0
  let maxVar = 0
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i].trim()
    if (raw === '') continue
    if (raw.startsWith('c')) {
      comments.push(raw.slice(1).trim())
      continue
    }
    if (raw.startsWith('p')) {
      const parts = raw.split(/\s+/)
      if (parts.length < 4 || parts[1] !== 'cnf') return { ok: false, error: 'expected "p cnf <vars> <clauses>"', line: lineNo }
      declaredVars = Number(parts[2])
      if (!Number.isInteger(declaredVars)) return { ok: false, error: 'problem-line var count must be an integer', line: lineNo }
      continue
    }
    if (raw === '%') break
    let body = raw
    let isXor = false
    if (raw[0] === 'x' && (raw[1] === ' ' || raw[1] === '\t')) {
      isXor = true
      body = raw.slice(1).trim()
    }
    const lits: number[] = []
    for (const tok of body.split(/\s+/)) {
      const n = Number(tok)
      if (!Number.isInteger(n)) return { ok: false, error: `expected an integer literal, got "${tok}"`, line: lineNo }
      if (n === 0) break
      lits.push(n)
      const v = Math.abs(n)
      if (v > maxVar) maxVar = v
    }
    if (lits.length === 0 && !isXor) continue
    if (isXor) xors.push(normalizeXorLits(lits))
    else clauses.push(lits)
  }
  const numVars = Math.max(declaredVars, maxVar)
  if (declaredVars && declaredVars !== maxVar && maxVar > declaredVars) {
    warnings.push(`header declared ${declaredVars} variables but literals reach ${maxVar}`)
  }
  if (numVars === 0) return { ok: false, error: 'no variables — add some clauses or XOR constraints', line: 0 }
  return { ok: true, problem: { numVars, clauses, xors, comments }, warnings }
}

const varOf = (tok: string): number | null => {
  const t = tok.trim()
  const m = /^x?(\d+)$/i.exec(t)
  if (!m) return null
  const v = Number(m[1])
  return v >= 1 ? v : null
}

/** Parse the friendly DSL. Each nonempty, non-`#` line is one constraint. */
export function parseXorDsl(text: string): ParseXorResult {
  const warnings: string[] = []
  const clauses: number[][] = []
  const xors: XorClause[] = []
  let maxVar = 0
  const track = (v: number) => {
    if (v > maxVar) maxVar = v
  }
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let raw = lines[i].trim()
    if (raw === '' || raw.startsWith('#') || raw.startsWith('//')) continue
    // Strip an optional trailing comment.
    const hash = raw.indexOf('#')
    if (hash >= 0) raw = raw.slice(0, hash).trim()
    if (raw === '') continue

    const isClause = /[|]/.test(raw) || /\bor\b/i.test(raw)
    if (isClause) {
      const toks = raw.split(/\s*(?:\||\bor\b)\s*/i).filter((t) => t.length > 0)
      const lits: number[] = []
      for (const tok of toks) {
        const neg = /^[-~!]/.test(tok)
        const v = varOf(tok.replace(/^[-~!]+/, ''))
        if (v === null) return { ok: false, error: `bad clause literal "${tok}"`, line: lineNo }
        track(v)
        lits.push(neg ? -v : v)
      }
      if (lits.length) clauses.push(lits)
      continue
    }

    // XOR constraint: LHS (^ / xor separated) = rhs
    const eq = raw.split('=')
    if (eq.length !== 2) return { ok: false, error: 'XOR line needs exactly one "=" (e.g. x1 ^ x2 = 1)', line: lineNo }
    const rhsTok = eq[1].trim()
    if (rhsTok !== '0' && rhsTok !== '1') return { ok: false, error: `right-hand side must be 0 or 1, got "${rhsTok}"`, line: lineNo }
    let rhs = Number(rhsTok)
    const toks = eq[0].split(/\s*(?:\^|\bxor\b|\+)\s*/i).filter((t) => t.length > 0)
    if (toks.length === 0) return { ok: false, error: 'XOR line has no variables', line: lineNo }
    const vars: number[] = []
    for (const tok of toks) {
      const neg = /^[-~!]/.test(tok)
      const v = varOf(tok.replace(/^[-~!]+/, ''))
      if (v === null) return { ok: false, error: `bad XOR term "${tok}"`, line: lineNo }
      track(v)
      if (neg) rhs ^= 1 // ¬v = 1 ⊕ v
      vars.push(v)
    }
    // Fold duplicate variables (x ⊕ x = 0).
    const parity = new Map<number, number>()
    for (const v of vars) parity.set(v, ((parity.get(v) ?? 0) + 1) & 1)
    const kept: number[] = []
    for (const [v, p] of parity) if (p === 1) kept.push(v)
    kept.sort((a, b) => a - b)
    xors.push({ vars: kept, rhs: rhs & 1 })
  }
  if (maxVar === 0) return { ok: false, error: 'no variables found', line: 0 }
  return { ok: true, problem: { numVars: maxVar, clauses, xors }, warnings }
}

/** Serialize a problem back to extended DIMACS (round-trips through the parser). */
export function toXorDimacs(p: XorCnf): string {
  const out: string[] = []
  if (p.comments) for (const c of p.comments) out.push(`c ${c}`)
  out.push(`p cnf ${p.numVars} ${p.clauses.length + p.xors.length}`)
  for (const c of p.clauses) out.push(`${c.join(' ')} 0`)
  for (const x of p.xors) {
    // Emit as an x-clause whose literals XOR to 1: rhs 0 needs one literal negated.
    const lits = x.vars.slice()
    if (lits.length === 0) {
      out.push(x.rhs === 1 ? 'x 0' : 'c (empty XOR = 0, trivially true)')
      continue
    }
    const signed = lits.map((v, i) => (i === 0 && x.rhs === 0 ? -v : v))
    out.push(`x ${signed.join(' ')} 0`)
  }
  return out.join('\n') + '\n'
}
