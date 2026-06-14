// Aether — self-tests for the property-based testing engine ("Aether Check").
//
// These assert the *behaviour* of the engine itself: that true laws pass, that
// false ones are falsified and shrunk, that runtime crashes are caught with the
// offending input, that recursive ADTs generate & terminate, and that
// ungeneratable (higher-order) arguments are skipped rather than crashing. Pure
// logic, so it runs both in the browser (the Tests page) and head-less in Node.

import { runProperties } from './property.ts'
import type { PropOutcome, PropReport } from './property.ts'

export interface PropSelfResult {
  name: string
  ok: boolean
  detail: string
}

interface PropSelfCase {
  name: string
  code: string
  check: (r: PropReport) => { ok: boolean; detail: string }
}

function only(r: PropReport): PropOutcome | null {
  return r.outcomes.length === 1 ? r.outcomes[0] : null
}

const CASES: PropSelfCase[] = [
  {
    name: 'true law passes (reverse involution)',
    code: `let prop_rev = fn xs -> reverse (reverse xs) == xs in prop_rev`,
    check: (r) => {
      const o = only(r)
      return { ok: o?.status === 'pass', detail: o ? `${o.status} after ${o.tests}` : 'no outcome' }
    },
  },
  {
    name: 'false law is falsified + shrunk to a 2-element list',
    code: `let prop_bad = fn xs -> reverse xs == xs in prop_bad`,
    check: (r) => {
      const o = only(r)
      const ce = o?.counterexample?.[0] ?? ''
      // a list literal with exactly one comma => two elements
      const twoEls = /^\[[^,]+,[^,\]]+\]$/.test(ce)
      return {
        ok: o?.status === 'fail' && twoEls,
        detail: o ? `${o.status} counterexample=${ce}` : 'no outcome',
      }
    },
  },
  {
    name: 'boundary is found (n < 5 shrinks to 5)',
    code: `let prop_small = fn n -> n < 5 in prop_small`,
    check: (r) => {
      const o = only(r)
      return {
        ok: o?.status === 'fail' && o.counterexample?.[0] === '5',
        detail: o ? `${o.status} counterexample=${o.counterexample?.[0]}` : 'no outcome',
      }
    },
  },
  {
    name: 'multi-argument arithmetic law passes',
    code: `let prop_comm = fn a b -> a + b == b + a in prop_comm`,
    check: (r) => {
      const o = only(r)
      return { ok: o?.status === 'pass', detail: o?.status ?? 'no outcome' }
    },
  },
  {
    name: 'ADT generation (Option) passes',
    code: `type Opt a = None | Some a in
let prop_opt = fn o -> match o with None -> true | Some x -> x == x in prop_opt`,
    check: (r) => {
      const o = only(r)
      return { ok: o?.status === 'pass', detail: o?.status ?? 'no outcome' }
    },
  },
  {
    name: 'recursive ADT generation (Tree) terminates & passes',
    code: `type Tree a = Leaf | Node (Tree a) a (Tree a) in
let rec size = fn t -> match t with Leaf -> 0 | Node l x r -> 1 + size l + size r in
let prop_tree = fn t -> size t >= 0 in prop_tree`,
    check: (r) => {
      const o = only(r)
      return { ok: o?.status === 'pass', detail: o?.status ?? 'no outcome' }
    },
  },
  {
    name: 'runtime crash is caught with the offending input',
    code: `let prop_div = fn n -> 10 / n == 10 / n in prop_div`,
    check: (r) => {
      const o = only(r)
      return {
        ok:
          o?.status === 'fail' &&
          o.counterexample?.[0] === '0' &&
          /division/.test(o.runtimeError ?? ''),
        detail: o ? `${o.status} ${o.counterexample?.[0]} (${o.runtimeError})` : 'no outcome',
      }
    },
  },
  {
    name: 'string + tuple generation passes (concat length)',
    code: `let prop_cat = fn s t -> strlen (s ^ t) == strlen s + strlen t in prop_cat`,
    check: (r) => {
      const o = only(r)
      return { ok: o?.status === 'pass', detail: o?.status ?? 'no outcome' }
    },
  },
  {
    name: 'higher-order argument is skipped, not crashed',
    code: `let prop_ho = fn f -> f 1 == f 1 in prop_ho`,
    check: (r) => {
      const o = only(r)
      return {
        ok: o?.status === 'skip' && /function/.test(o.message ?? ''),
        detail: o ? `${o.status} (${o.message})` : 'no outcome',
      }
    },
  },
  {
    name: 'non-prop bindings are ignored',
    code: `let helper = fn n -> n < 5 in let prop_ok = fn n -> n == n in prop_ok`,
    check: (r) => {
      return {
        ok: r.outcomes.length === 1 && r.outcomes[0].name === 'prop_ok',
        detail: `${r.outcomes.length} discovered: ${r.outcomes.map((o) => o.name).join(', ')}`,
      }
    },
  },
  {
    name: 'reports are deterministic across runs',
    code: `let prop_bad = fn xs -> reverse xs == xs in prop_bad`,
    check: () => {
      const a = runProperties(`let prop_bad = fn xs -> reverse xs == xs in prop_bad`, { seed: 7, runs: 60 })
      const b = runProperties(`let prop_bad = fn xs -> reverse xs == xs in prop_bad`, { seed: 7, runs: 60 })
      const ax = a.outcomes[0]?.counterexample?.join(',')
      const bx = b.outcomes[0]?.counterexample?.join(',')
      return { ok: ax !== undefined && ax === bx, detail: `${ax} == ${bx}` }
    },
  },
]

export function runPropertySuite(): PropSelfResult[] {
  return CASES.map((c) => {
    let report: PropReport
    try {
      report = runProperties(c.code, { seed: 0x5eed, runs: 120 })
    } catch (e) {
      return { name: c.name, ok: false, detail: `threw: ${e instanceof Error ? e.message : e}` }
    }
    if (report.error) return { name: c.name, ok: false, detail: `compile error: ${report.error}` }
    const { ok, detail } = c.check(report)
    return { name: c.name, ok, detail }
  })
}
