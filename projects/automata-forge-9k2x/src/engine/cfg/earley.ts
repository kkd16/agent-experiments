// Earley's algorithm — a parser that runs on *any* context-free grammar directly: left/right
// recursion, ε-productions and ambiguity all work, with no normal form required. This is the app's
// membership/parse oracle (CYK, by contrast, needs a CNF grammar).
//
// The chart S[0..n] holds *items* `A → α • β (j)`: the production A → αβ, a dot marking how much of
// the body has matched, and the origin j where this attempt began. Three operations grow it:
//   • predict  — at `… • B …`, add `B → • γ (k)` for every B-production (and, when B is nullable,
//                advance the dot now — the Aycock–Horspool fix that makes ε work without re-passes);
//   • scan     — at `… • a …` with input[k] = a, carry `… a • … (j)` into S[k+1];
//   • complete — a finished item `B → γ • (j)` advances every `A → … • B … (i)` waiting in S[j].
// The string is accepted iff S[n] contains the augmented start finished from origin 0.

import type { Grammar, Production } from './grammar'
import { ntSetOf } from './grammar'
import { nullableSet } from './analyze'

export interface Item {
  prod: number // index into the internal production array
  dot: number
  origin: number
}

export interface EarleyResult {
  accepted: boolean
  /** chart[k] = the items in state S[k], in insertion order. */
  chart: Item[][]
  /** The internal production array (index 0 is the augmented start `Γ → S`). */
  prods: Production[]
  start: string // the fresh augmented start nonterminal name
  n: number // input length
}

const AUG = 'Γ' // augmented start symbol (never collides — the parser only accepts A–Z)

/** Run Earley recognition, returning the full chart for inspection. */
export function earley(g: Grammar, input: string): EarleyResult {
  const nt = ntSetOf(g)
  const nullable = nullableSet(g)
  const prods: Production[] = [{ lhs: AUG, rhs: [g.start] }, ...g.productions]

  // Index productions by their left-hand side for the predictor.
  const byLhs = new Map<string, number[]>()
  prods.forEach((p, i) => {
    const arr = byLhs.get(p.lhs)
    if (arr) arr.push(i)
    else byLhs.set(p.lhs, [i])
  })

  const n = input.length
  const chart: Item[][] = Array.from({ length: n + 1 }, () => [])
  const seen: Set<string>[] = Array.from({ length: n + 1 }, () => new Set<string>())

  const key = (it: Item) => `${it.prod}.${it.dot}.${it.origin}`
  const add = (pos: number, it: Item) => {
    const k = key(it)
    if (!seen[pos].has(k)) {
      seen[pos].add(k)
      chart[pos].push(it)
    }
  }

  add(0, { prod: 0, dot: 0, origin: 0 })

  for (let k = 0; k <= n; k++) {
    const list = chart[k]
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      const prod = prods[item.prod]
      if (item.dot < prod.rhs.length) {
        const X = prod.rhs[item.dot]
        if (nt.has(X)) {
          // predict
          for (const p of byLhs.get(X) ?? []) add(k, { prod: p, dot: 0, origin: k })
          if (nullable.has(X)) add(k, { prod: item.prod, dot: item.dot + 1, origin: item.origin })
        } else if (k < n && input[k] === X) {
          // scan
          add(k + 1, { prod: item.prod, dot: item.dot + 1, origin: item.origin })
        }
      } else {
        // complete: advance every item in S[origin] waiting on prod.lhs
        const B = prod.lhs
        const waiting = chart[item.origin]
        for (let w = 0; w < waiting.length; w++) {
          const it2 = waiting[w]
          const p2 = prods[it2.prod]
          if (it2.dot < p2.rhs.length && p2.rhs[it2.dot] === B) {
            add(k, { prod: it2.prod, dot: it2.dot + 1, origin: it2.origin })
          }
        }
      }
    }
  }

  const accepted = chart[n].some((it) => it.prod === 0 && it.dot === 1 && it.origin === 0)
  return { accepted, chart, prods, start: AUG, n }
}

/** Cheap membership test. */
export function earleyAccepts(g: Grammar, input: string): boolean {
  return earley(g, input).accepted
}

// ---------------------------------------------------------------------------
// Parse-tree extraction over the chart.
// ---------------------------------------------------------------------------

export interface ParseNode {
  symbol: string
  /** Present on internal (nonterminal) nodes. An empty array renders as the ε body. */
  children?: ParseNode[]
  terminal?: boolean
}

/** Build a set of completed spans `lhs:i:j` so tree extraction never explores dead branches. */
function completedSpans(res: EarleyResult): Set<string> {
  const set = new Set<string>()
  res.chart.forEach((list, j) => {
    for (const it of list) {
      const p = res.prods[it.prod]
      if (it.dot === p.rhs.length) set.add(`${p.lhs}:${it.origin}:${j}`)
    }
  })
  return set
}

/**
 * Extract one parse tree for the whole input, or `null` if it is not in the language. The returned
 * tree is rooted at the *grammar's* start symbol (the augmented `Γ` is unwrapped).
 */
export function earleyParse(g: Grammar, input: string): ParseNode | null {
  const res = earley(g, input)
  if (!res.accepted) return null
  const nt = ntSetOf(g)
  const done = completedSpans(res)
  const memo = new Map<string, ParseNode | null>()

  const byLhs = new Map<string, string[][]>()
  for (const p of g.productions) {
    const arr = byLhs.get(p.lhs)
    if (arr) arr.push(p.rhs)
    else byLhs.set(p.lhs, [p.rhs])
  }

  const derive = (symbol: string, i: number, j: number): ParseNode | null => {
    if (!nt.has(symbol)) {
      return j === i + 1 && input[i] === symbol ? { symbol, terminal: true } : null
    }
    const mk = `${symbol}:${i}:${j}`
    if (memo.has(mk)) return memo.get(mk)!
    memo.set(mk, null) // guard against left-recursive cycles in the search
    let result: ParseNode | null = null
    if (done.has(`${symbol}:${i}:${j}`)) {
      for (const rhs of byLhs.get(symbol) ?? []) {
        const kids = partition(rhs, i, j)
        if (kids) {
          result = { symbol, children: kids }
          break
        }
      }
    }
    memo.set(mk, result)
    return result
  }

  const partition = (rhs: string[], i: number, j: number): ParseNode[] | null => {
    const go = (idx: number, pos: number): ParseNode[] | null => {
      if (idx === rhs.length) return pos === j ? [] : null
      const X = rhs[idx]
      if (!nt.has(X)) {
        if (pos < j && input[pos] === X) {
          const rest = go(idx + 1, pos + 1)
          if (rest) return [{ symbol: X, terminal: true }, ...rest]
        }
        return null
      }
      for (let end = pos; end <= j; end++) {
        if (!done.has(`${X}:${pos}:${end}`)) continue
        const node = derive(X, pos, end)
        if (!node) continue
        const rest = go(idx + 1, end)
        if (rest) return [node, ...rest]
      }
      return null
    }
    return go(0, i)
  }

  return derive(g.start, 0, input.length)
}

const COUNT_CAP = 2000

/**
 * Count parse trees for `input`, capped at {@link COUNT_CAP}. `> 1` means the grammar is ambiguous
 * *for this string*. Returns 0 when the string is not in the language.
 */
export function countParses(g: Grammar, input: string): number {
  const res = earley(g, input)
  if (!res.accepted) return 0
  const nt = ntSetOf(g)
  const done = completedSpans(res)
  const memo = new Map<string, number>()
  const byLhs = new Map<string, string[][]>()
  for (const p of g.productions) {
    const arr = byLhs.get(p.lhs)
    if (arr) arr.push(p.rhs)
    else byLhs.set(p.lhs, [p.rhs])
  }

  const count = (symbol: string, i: number, j: number): number => {
    if (!nt.has(symbol)) return j === i + 1 && input[i] === symbol ? 1 : 0
    const mk = `${symbol}:${i}:${j}`
    const cached = memo.get(mk)
    if (cached !== undefined) return cached
    memo.set(mk, 0) // break cycles; refined below
    if (!done.has(`${symbol}:${i}:${j}`)) return 0
    let total = 0
    for (const rhs of byLhs.get(symbol) ?? []) {
      total += countPartition(rhs, i, j)
      if (total >= COUNT_CAP) {
        total = COUNT_CAP
        break
      }
    }
    memo.set(mk, total)
    return total
  }

  const countPartition = (rhs: string[], i: number, j: number): number => {
    const pmemo = new Map<string, number>()
    const go = (idx: number, pos: number): number => {
      if (idx === rhs.length) return pos === j ? 1 : 0
      const pk = `${idx}.${pos}`
      const c = pmemo.get(pk)
      if (c !== undefined) return c
      const X = rhs[idx]
      let sum = 0
      if (!nt.has(X)) {
        if (pos < j && input[pos] === X) sum = go(idx + 1, pos + 1)
      } else {
        for (let end = pos; end <= j; end++) {
          const ce = count(X, pos, end)
          if (ce > 0) sum += ce * go(idx + 1, end)
          if (sum >= COUNT_CAP) {
            sum = COUNT_CAP
            break
          }
        }
      }
      pmemo.set(pk, sum)
      return sum
    }
    return go(0, i)
  }

  return Math.min(count(g.start, 0, input.length), COUNT_CAP)
}

/** Render one chart item as `A → α • β  (origin)`. */
export function showItem(res: EarleyResult, it: Item): string {
  const p = res.prods[it.prod]
  const body = [...p.rhs]
  body.splice(it.dot, 0, '•')
  const rhs = body.length === 1 && body[0] === '•' ? '•' : body.join(' ')
  return `${p.lhs} → ${rhs}  (${it.origin})`
}
