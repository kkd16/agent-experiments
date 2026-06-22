// The Cocke–Younger–Kasami recognizer: bottom-up dynamic programming on a **CNF** grammar.
//
// table[i][len] holds every nonterminal that derives the substring of `input` starting at i with
// length len. Length-1 cells come straight from terminal rules A → a; longer cells are filled by
// trying every split point k and every binary rule A → B C with B over the left part and C over the
// right. The string is accepted iff the start symbol reaches the whole-string cell. Back-pointers
// turn the table into a parse tree; the same recurrence, summed, counts parses (ambiguity).

import type { Grammar } from './grammar'
import { ntSetOf } from './grammar'
import type { ParseNode } from './earley'

type Back =
  | { kind: 'term'; sym: string }
  | { kind: 'split'; k: number; B: string; C: string }

export interface CykResult {
  accepted: boolean
  n: number
  /** cells[len-1][i] = the nonterminals deriving input[i .. i+len), sorted. */
  cells: string[][][]
  tree: ParseNode | null
  /** Number of parse trees, capped. */
  count: number
}

const CAP = 2000

/** Run CYK. `g` must be in CNF (see {@link import('./normalize').toCnf}). */
export function cyk(g: Grammar, input: string): CykResult {
  const nt = ntSetOf(g)
  const n = input.length

  // Special case: the empty word is accepted iff S → ε is present.
  if (n === 0) {
    const acc = g.productions.some((p) => p.lhs === g.start && p.rhs.length === 0)
    return { accepted: acc, n: 0, cells: [], tree: acc ? { symbol: g.start, children: [] } : null, count: acc ? 1 : 0 }
  }

  // table[i][len] = Set of nonterminals; back[i][len][A] = one derivation.
  const table: Set<string>[][] = Array.from({ length: n }, () => Array.from({ length: n + 1 }, () => new Set<string>()))
  const back = new Map<string, Back>()
  const bkey = (i: number, len: number, A: string) => `${i}.${len}.${A}`

  // Length 1.
  for (let i = 0; i < n; i++) {
    for (const p of g.productions) {
      if (p.rhs.length === 1 && !nt.has(p.rhs[0]) && p.rhs[0] === input[i]) {
        if (!table[i][1].has(p.lhs)) {
          table[i][1].add(p.lhs)
          back.set(bkey(i, 1, p.lhs), { kind: 'term', sym: input[i] })
        }
      }
    }
  }

  // Lengths 2..n.
  for (let len = 2; len <= n; len++) {
    for (let i = 0; i + len <= n; i++) {
      for (let k = 1; k < len; k++) {
        const left = table[i][k]
        const right = table[i + k][len - k]
        if (left.size === 0 || right.size === 0) continue
        for (const p of g.productions) {
          if (p.rhs.length !== 2) continue
          const [B, C] = p.rhs
          if (left.has(B) && right.has(C) && !table[i][len].has(p.lhs)) {
            table[i][len].add(p.lhs)
            back.set(bkey(i, len, p.lhs), { kind: 'split', k, B, C })
          }
        }
      }
    }
  }

  const accepted = table[0][n].has(g.start)

  // Display grid: cells[len-1][i].
  const cells: string[][][] = []
  for (let len = 1; len <= n; len++) {
    const row: string[][] = []
    for (let i = 0; i + len <= n; i++) row.push([...table[i][len]].sort())
    cells.push(row)
  }

  // One parse tree from the back-pointers.
  const buildTree = (i: number, len: number, A: string): ParseNode => {
    const b = back.get(bkey(i, len, A))!
    if (b.kind === 'term') return { symbol: A, children: [{ symbol: b.sym, terminal: true }] }
    return { symbol: A, children: [buildTree(i, b.k, b.B), buildTree(i + b.k, len - b.k, b.C)] }
  }
  const tree = accepted ? buildTree(0, n, g.start) : null

  // Parse count via the same recurrence, memoised.
  const memo = new Map<string, number>()
  const countCell = (i: number, len: number, A: string): number => {
    if (len === 1) {
      return table[i][1].has(A) ? g.productions.filter((p) => p.lhs === A && p.rhs.length === 1 && p.rhs[0] === input[i]).length : 0
    }
    const mk = bkey(i, len, A)
    const c = memo.get(mk)
    if (c !== undefined) return c
    let total = 0
    for (let k = 1; k < len && total < CAP; k++) {
      for (const p of g.productions) {
        if (p.rhs.length !== 2 || p.lhs !== A) continue
        const [B, C] = p.rhs
        if (table[i][k].has(B) && table[i + k][len - k].has(C)) {
          total += countCell(i, k, B) * countCell(i + k, len - k, C)
        }
      }
    }
    total = Math.min(total, CAP)
    memo.set(mk, total)
    return total
  }
  const count = accepted ? countCell(0, n, g.start) : 0

  return { accepted, n, cells, tree, count }
}
