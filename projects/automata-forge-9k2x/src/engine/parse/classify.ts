// Where does this grammar sit in the parsing hierarchy?
//
//   LL(1)                     (top-down, predictive)
//   LR(0) ⊊ SLR(1) ⊊ LALR(1) ⊊ LR(1)   (bottom-up, shift-reduce)
//
// We just build every table and report which ones came out conflict-free, with the conflicts that
// disqualify the rest. (LL(1) is incomparable with the LR family in general, so it is reported on
// its own line.)

import type { Grammar } from '../cfg/grammar'
import { augment } from './augment'
import { buildLl1Table } from './ll1'
import { buildLrTable } from './lr-table'
import type { ParserKind, Conflict } from './lr-table'
import type { Ll1Conflict } from './ll1'

export interface ClassReport {
  ll1: boolean
  ll1Conflicts: Ll1Conflict[]
  lr: Record<ParserKind, { ok: boolean; conflicts: Conflict[] }>
  /** The strongest single bottom-up class the grammar is in (or null if not even LR(1)). */
  strongestLr: ParserKind | null
}

const LR_ORDER: ParserKind[] = ['LR0', 'SLR1', 'LALR1', 'LR1']

export function classifyGrammar(g: Grammar): ClassReport {
  const aug = augment(g)
  const ll1 = buildLl1Table(g)
  const lr = {} as Record<ParserKind, { ok: boolean; conflicts: Conflict[] }>
  for (const kind of LR_ORDER) {
    const t = buildLrTable(g, aug, kind)
    lr[kind] = { ok: t.ok, conflicts: t.conflicts }
  }
  // First class in the chain that is conflict-free (the chain is monotone: once OK it stays OK).
  const strongestLr = LR_ORDER.find((k) => lr[k].ok) ?? null
  return { ll1: ll1.isLl1, ll1Conflicts: ll1.conflicts, lr, strongestLr }
}
