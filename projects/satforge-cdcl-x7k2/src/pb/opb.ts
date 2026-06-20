// A tolerant parser/printer for OPB, the standard pseudo-Boolean file format (the PB
// competition's input). A file is an optional `min:`/`max:` objective followed by constraints,
// each a sum of signed integer·literal terms, a comparator (>= <= = > <), an integer RHS, and
// a terminating `;`. Variables are `x1, x2, …`; a literal may be negated as `~x3`. Lines
// starting with `*` are comments.

import { normalizeLinear, type SignedTerm, type Cmp } from './constraint'
import type { PbInstance } from './instance'

export class OpbError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.name = 'OpbError'
    this.line = line
  }
}

interface RawTerm {
  coef: bigint
  lit: number // signed DIMACS literal
}

function parseTerms(tokens: string[], lineNo: number): { terms: RawTerm[]; maxVar: number } {
  const terms: RawTerm[] = []
  let maxVar = 0
  let i = 0
  while (i < tokens.length) {
    const coefTok = tokens[i]
    if (!/^[+-]?\d+$/.test(coefTok)) throw new OpbError(`expected a coefficient, got "${coefTok}"`, lineNo)
    const coef = BigInt(coefTok)
    const varTok = tokens[i + 1]
    if (varTok === undefined) throw new OpbError('coefficient without a variable', lineNo)
    const m = /^(~?)x(\d+)$/.exec(varTok)
    if (!m) throw new OpbError(`expected a variable like x3 or ~x3, got "${varTok}"`, lineNo)
    const v = Number(m[2])
    if (v < 1) throw new OpbError('variable index must be ≥ 1', lineNo)
    if (v > maxVar) maxVar = v
    const lit = m[1] === '~' ? -v : v
    terms.push({ coef, lit })
    i += 2
  }
  return { terms, maxVar }
}

export interface OpbParse {
  instance: PbInstance
  /** 'min' / 'max' if an objective line was present. */
  sense?: 'min' | 'max'
}

/** Parse OPB text into a {@link PbInstance}. A `max:` objective is negated to a minimization. */
export function parseOpb(text: string): OpbParse {
  const lines = text.split(/\r?\n/)
  const constraints = []
  let objective: SignedTerm[] | undefined
  let sense: 'min' | 'max' | undefined
  let maxVar = 0

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let line = lines[i].trim()
    if (line === '' || line.startsWith('*')) continue
    const objMatch = /^(min|max)\s*:/i.exec(line)
    if (objMatch) {
      sense = objMatch[1].toLowerCase() as 'min' | 'max'
      line = line.slice(objMatch[0].length).trim()
      if (line.endsWith(';')) line = line.slice(0, -1).trim()
      const { terms, maxVar: mv } = parseTerms(line.split(/\s+/).filter(Boolean), lineNo)
      maxVar = Math.max(maxVar, mv)
      const sign = sense === 'max' ? -1n : 1n
      objective = terms.map((t) => ({ lit: t.lit, coef: t.coef * sign }))
      continue
    }
    if (!line.endsWith(';')) throw new OpbError('constraint must end with ";"', lineNo)
    line = line.slice(0, -1).trim()
    const cmpMatch = /(>=|<=|=|>|<)/.exec(line)
    if (!cmpMatch) throw new OpbError('missing comparator (>=, <=, =, >, <)', lineNo)
    const cmp = cmpMatch[1] as Cmp
    const idx = cmpMatch.index
    const lhsToks = line.slice(0, idx).trim().split(/\s+/).filter(Boolean)
    const rhsTok = line.slice(idx + cmp.length).trim()
    if (!/^[+-]?\d+$/.test(rhsTok)) throw new OpbError(`expected an integer right-hand side, got "${rhsTok}"`, lineNo)
    const { terms, maxVar: mv } = parseTerms(lhsToks, lineNo)
    maxVar = Math.max(maxVar, mv)
    constraints.push(...normalizeLinear(terms, cmp, BigInt(rhsTok)))
  }

  const instance: PbInstance = {
    numVars: maxVar,
    constraints,
    objective,
    objConst: objective ? 0n : undefined,
    note: sense ? `OPB (${sense}imize objective)` : 'OPB instance',
  }
  return { instance, sense }
}

/** Serialize an instance back to OPB text (objectives always printed as `min:`). */
export function toOpb(inst: PbInstance): string {
  const out: string[] = [`* #variable= ${inst.numVars} #constraint= ${inst.constraints.length}`]
  const termStr = (lit: number, coef: bigint): string => {
    const v = Math.abs(lit)
    const name = lit > 0 ? `x${v}` : `~x${v}`
    const sign = coef >= 0n ? '+' : '-'
    const mag = coef >= 0n ? coef : -coef
    return `${sign}${mag} ${name}`
  }
  if (inst.objective && inst.objective.length) {
    out.push('min: ' + inst.objective.map((t) => termStr(t.lit, t.coef)).join(' ') + ' ;')
  }
  for (const c of inst.constraints) {
    const body = c.terms().map((t) => termStr(t.lit, t.coef)).join(' ')
    out.push(`${body} >= ${c.degree} ;`)
  }
  return out.join('\n') + '\n'
}
