// CNF representation + DIMACS parsing/serialization.
//
// Public API uses DIMACS-style signed integers for literals: a variable is a
// positive integer 1..numVars, and a negative integer is its negation. The
// solver converts these to a compact 0-based internal encoding (see solver.ts).

export interface CNF {
  /** Number of distinct variables (1..numVars). */
  numVars: number
  /** Each clause is a disjunction of signed literals, e.g. [1, -3, 4]. */
  clauses: number[][]
  /** Optional human-readable comments carried from the DIMACS source. */
  comments?: string[]
}

export interface ParseResult {
  cnf: CNF
  /** Non-fatal warnings (e.g. header count mismatch). */
  warnings: string[]
}

export class DimacsError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.name = 'DimacsError'
    this.line = line
  }
}

/**
 * Parse DIMACS CNF text into a {@link CNF}. Tolerant of missing/loose headers:
 * the variable count is inferred from the literals actually used, and a header
 * mismatch is reported as a warning rather than a hard error.
 */
export function parseDimacs(text: string): ParseResult {
  const warnings: string[] = []
  const comments: string[] = []
  const clauses: number[][] = []
  let declaredVars = 0
  let declaredClauses = 0
  let sawHeader = false
  let maxVar = 0
  let current: number[] = []

  const rawLines = text.split(/\r?\n/)
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1
    const line = rawLines[i].trim()
    if (line === '') continue
    if (line.startsWith('c')) {
      comments.push(line.slice(1).trim())
      continue
    }
    if (line.startsWith('p')) {
      const parts = line.split(/\s+/)
      if (parts.length < 4 || parts[1] !== 'cnf') {
        throw new DimacsError('malformed problem line, expected "p cnf <vars> <clauses>"', lineNo)
      }
      declaredVars = Number(parts[2])
      declaredClauses = Number(parts[3])
      if (!Number.isInteger(declaredVars) || !Number.isInteger(declaredClauses)) {
        throw new DimacsError('problem line counts must be integers', lineNo)
      }
      sawHeader = true
      continue
    }
    if (line === '%') break // some benchmark files terminate with a trailing %/0 block
    // A clause line: whitespace-separated integers terminated by 0.
    for (const tok of line.split(/\s+/)) {
      const n = Number(tok)
      if (!Number.isInteger(n)) {
        throw new DimacsError(`expected an integer literal, got "${tok}"`, lineNo)
      }
      if (n === 0) {
        clauses.push(current)
        current = []
      } else {
        const v = Math.abs(n)
        if (v > maxVar) maxVar = v
        current.push(n)
      }
    }
  }
  if (current.length > 0) {
    // Clause not terminated by 0 — accept it but warn.
    clauses.push(current)
    warnings.push('final clause was not terminated by 0; accepted anyway')
  }

  const numVars = Math.max(declaredVars, maxVar)
  if (sawHeader) {
    if (declaredVars < maxVar) {
      warnings.push(`header declared ${declaredVars} vars but literal ${maxVar} appears; using ${maxVar}`)
    }
    if (declaredClauses !== clauses.length) {
      warnings.push(`header declared ${declaredClauses} clauses but found ${clauses.length}`)
    }
  } else {
    warnings.push('no "p cnf" header found; inferred dimensions from the literals')
  }

  return { cnf: { numVars, clauses, comments }, warnings }
}

/** Serialize a {@link CNF} back to canonical DIMACS text. */
export function toDimacs(cnf: CNF): string {
  const out: string[] = []
  for (const c of cnf.comments ?? []) out.push(`c ${c}`)
  out.push(`p cnf ${cnf.numVars} ${cnf.clauses.length}`)
  for (const clause of cnf.clauses) out.push(`${clause.join(' ')} 0`)
  return out.join('\n') + '\n'
}

/** Count occurrences and basic shape metrics for a CNF (used in the UI). */
export function cnfStats(cnf: CNF) {
  let literals = 0
  let units = 0
  let maxWidth = 0
  let empties = 0
  for (const c of cnf.clauses) {
    literals += c.length
    if (c.length === 1) units++
    if (c.length === 0) empties++
    if (c.length > maxWidth) maxWidth = c.length
  }
  return {
    numVars: cnf.numVars,
    numClauses: cnf.clauses.length,
    literals,
    units,
    empties,
    maxWidth,
    avgWidth: cnf.clauses.length ? literals / cnf.clauses.length : 0,
  }
}

/** Check whether an assignment (1-based, value[v] ∈ {true,false}) satisfies a CNF. */
export function verifyModel(cnf: CNF, model: boolean[]): { ok: boolean; failing: number } {
  for (let i = 0; i < cnf.clauses.length; i++) {
    const clause = cnf.clauses[i]
    let sat = false
    for (const lit of clause) {
      const v = Math.abs(lit)
      const val = model[v]
      if ((lit > 0 && val) || (lit < 0 && !val)) {
        sat = true
        break
      }
    }
    if (!sat) return { ok: false, failing: i }
  }
  return { ok: true, failing: -1 }
}
