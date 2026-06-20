// QBF (Quantified Boolean Formula) model + QDIMACS (de)serialization.
//
// A prenex QBF is a quantifier *prefix* over a propositional CNF *matrix*:
//
//     Q1 X1. Q2 X2. … Qk Xk.  φ            (Qi ∈ {∃, ∀}, Xi disjoint var blocks)
//
// We store the prefix outermost-first and the matrix as DIMACS-style signed
// integer clauses (exactly like {@link CNF} in ../sat/cnf.ts). The public API
// keeps adjacent same-quantifier blocks merged and every matrix variable bound
// (free variables are, by the QDIMACS convention, existential and outermost).

/** A quantifier: existential (`'e'`, ∃) or universal (`'a'`, ∀). */
export type Quant = 'e' | 'a'

/** One quantifier block: a quantifier applied to a set of variables (1..numVars). */
export interface QBlock {
  q: Quant
  vars: number[]
}

/** A prenex QBF: a quantifier prefix over a CNF matrix. */
export interface QBF {
  /** Number of distinct variables (1..numVars). */
  numVars: number
  /** Quantifier blocks, outermost first. Adjacent blocks have distinct quantifiers. */
  prefix: QBlock[]
  /** CNF matrix: each clause a disjunction of signed DIMACS literals. */
  matrix: number[][]
  /** Optional human-readable comments carried from the QDIMACS source. */
  comments?: string[]
}

export interface QParseResult {
  qbf: QBF
  warnings: string[]
}

export class QDimacsError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.name = 'QDimacsError'
    this.line = line
  }
}

/**
 * Canonicalize a prefix + matrix into a {@link QBF}:
 *  - drops empty blocks and merges adjacent same-quantifier blocks,
 *  - removes duplicate variables within / across blocks (first binding wins),
 *  - binds every variable that occurs in the matrix but in no block by prepending
 *    it to an outermost existential block (the standard free-variable convention),
 *  - recomputes `numVars` from the maximum variable actually mentioned.
 */
export function normalizeQbf(prefix: QBlock[], matrix: number[][], comments?: string[]): QBF {
  // Largest variable mentioned anywhere.
  let maxVar = 0
  for (const b of prefix) for (const v of b.vars) if (v > maxVar) maxVar = v
  for (const c of matrix) for (const l of c) {
    const v = Math.abs(l)
    if (v > maxVar) maxVar = v
  }

  // First binding of each variable wins; later duplicates are dropped.
  const bound = new Set<number>()
  const cleaned: QBlock[] = []
  for (const b of prefix) {
    const vars: number[] = []
    for (const v of b.vars) {
      if (v < 1 || bound.has(v)) continue
      bound.add(v)
      vars.push(v)
    }
    if (vars.length > 0) cleaned.push({ q: b.q, vars })
  }

  // Variables that occur in the matrix but were never quantified: bind them
  // existentially at the very outside (QDIMACS treats free vars as ∃, outermost).
  const used = new Set<number>()
  for (const c of matrix) for (const l of c) used.add(Math.abs(l))
  const free: number[] = []
  for (const v of used) if (!bound.has(v)) free.push(v)
  free.sort((a, b) => a - b)
  if (free.length > 0) {
    if (cleaned.length > 0 && cleaned[0].q === 'e') {
      cleaned[0] = { q: 'e', vars: [...free, ...cleaned[0].vars] }
    } else {
      cleaned.unshift({ q: 'e', vars: free })
    }
  }

  // Merge adjacent same-quantifier blocks.
  const merged: QBlock[] = []
  for (const b of cleaned) {
    const last = merged[merged.length - 1]
    if (last && last.q === b.q) last.vars.push(...b.vars)
    else merged.push({ q: b.q, vars: [...b.vars] })
  }

  return { numVars: maxVar, prefix: merged, matrix: matrix.map((c) => [...c]), comments }
}

/**
 * Parse QDIMACS text into a {@link QBF}. Tolerant of a missing/loose header and
 * of clauses interleaved with quantifier lines is *not* allowed (QDIMACS puts
 * the whole prefix first); quantifier lines after the first clause are rejected.
 */
export function parseQdimacs(text: string): QParseResult {
  const warnings: string[] = []
  const comments: string[] = []
  const prefix: QBlock[] = []
  const clauses: number[][] = []
  let declaredVars = 0
  let declaredClauses = 0
  let sawHeader = false
  let sawClause = false
  let current: number[] = []

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i].trim()
    if (line === '') continue
    if (line.startsWith('c')) {
      comments.push(line.slice(1).trim())
      continue
    }
    if (line.startsWith('p')) {
      const parts = line.split(/\s+/)
      if (parts.length < 4 || parts[1] !== 'cnf') {
        throw new QDimacsError('malformed problem line, expected "p cnf <vars> <clauses>"', lineNo)
      }
      declaredVars = Number(parts[2])
      declaredClauses = Number(parts[3])
      if (!Number.isInteger(declaredVars) || !Number.isInteger(declaredClauses)) {
        throw new QDimacsError('problem line counts must be integers', lineNo)
      }
      sawHeader = true
      continue
    }
    if (line === '%') break
    if (line[0] === 'e' || line[0] === 'a') {
      if (sawClause) throw new QDimacsError('quantifier block after a clause — the prefix must come first', lineNo)
      const q: Quant = line[0] === 'e' ? 'e' : 'a'
      const toks = line.slice(1).trim().split(/\s+/).filter((t) => t !== '')
      const vars: number[] = []
      let terminated = false
      for (const tok of toks) {
        const n = Number(tok)
        if (!Number.isInteger(n)) throw new QDimacsError(`expected an integer variable, got "${tok}"`, lineNo)
        if (n === 0) {
          terminated = true
          break
        }
        if (n < 0) throw new QDimacsError('quantifier blocks list variables (positive integers), not literals', lineNo)
        vars.push(n)
      }
      if (!terminated) throw new QDimacsError('quantifier block must end with 0', lineNo)
      prefix.push({ q, vars })
      continue
    }
    // A clause line: signed integers terminated by 0 (may span lines).
    for (const tok of line.split(/\s+/)) {
      if (tok === '') continue
      const n = Number(tok)
      if (!Number.isInteger(n)) throw new QDimacsError(`expected an integer literal, got "${tok}"`, lineNo)
      if (n === 0) {
        clauses.push(current)
        current = []
        sawClause = true
      } else {
        current.push(n)
      }
    }
  }
  if (current.length > 0) {
    clauses.push(current)
    warnings.push('last clause was not terminated with 0 — accepted anyway')
  }

  if (sawHeader) {
    if (declaredClauses !== clauses.length) {
      warnings.push(`header declared ${declaredClauses} clauses, found ${clauses.length}`)
    }
  } else {
    warnings.push('no "p cnf" header — variable/clause counts inferred from the body')
  }

  const qbf = normalizeQbf(prefix, clauses, comments.length ? comments : undefined)
  if (sawHeader && declaredVars > qbf.numVars) {
    // Honor a larger declared var count (trailing unconstrained vars are harmless).
    qbf.numVars = declaredVars
  }
  return { qbf, warnings }
}

/** Serialize a {@link QBF} back to canonical QDIMACS text. */
export function toQdimacs(qbf: QBF): string {
  const out: string[] = []
  for (const c of qbf.comments ?? []) out.push(`c ${c}`)
  out.push(`p cnf ${qbf.numVars} ${qbf.matrix.length}`)
  for (const b of qbf.prefix) out.push(`${b.q} ${b.vars.join(' ')} 0`)
  for (const c of qbf.matrix) out.push(`${c.join(' ')} 0`)
  return out.join('\n') + '\n'
}

/** Total number of quantifier alternations (0 for a purely ∃ or ∀ formula). */
export function alternations(qbf: QBF): number {
  return Math.max(0, qbf.prefix.length - 1)
}

/** A compact human-readable rendering of the prefix, e.g. "∃{1,2} ∀{3} ∃{4}". */
export function prefixString(qbf: QBF): string {
  return qbf.prefix
    .map((b) => `${b.q === 'e' ? '∃' : '∀'}{${b.vars.join(',')}}`)
    .join(' ')
}
