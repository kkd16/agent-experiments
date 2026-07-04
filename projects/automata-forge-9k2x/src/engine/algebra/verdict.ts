// The payoff: reading the *language* classification straight off the algebra of its syntactic
// monoid. This is the Eilenberg variety theorem in miniature — each structural property of M(L)
// pins L into a named class, with a theorem attached.

import type { Monoid } from './monoid'
import type { MonoidProps } from './properties'
import { showWord } from '../types'

export interface VarietyRow {
  name: string
  /** Algebraic side. */
  algebra: string
  /** Language side. */
  language: string
  holds: boolean
  theorem: string
}

export interface Verdict {
  /** L is star-free ⟺ M(L) is aperiodic (Schützenberger 1965). */
  starFree: boolean
  /** …⟺ definable in first-order logic FO[<] (McNaughton–Papert 1971). */
  foDefinable: boolean
  /** …⟺ the minimal DFA is counter-free / definable in LTL (Kamp 1968). */
  ltlDefinable: boolean
  /** L is piecewise testable ⟺ M(L) is J-trivial (Simon 1975). */
  piecewiseTestable: boolean
  headline: string
  detail: string
  /** The counting obstruction, present exactly when L is *not* star-free. */
  obstruction?: { word: string; period: number; element: number }
  varieties: VarietyRow[]
}

export function classify(mon: Monoid, props: MonoidProps): Verdict {
  const starFree = props.aperiodic

  let obstruction: Verdict['obstruction']
  if (!starFree && props.aperiodicWitness) {
    const w = props.aperiodicWitness
    obstruction = {
      word: showWord(mon.elements[w.element].word),
      period: w.period,
      element: w.element,
    }
  }

  const headline = starFree
    ? 'Star-free — first-order & LTL definable'
    : 'Not star-free — the language genuinely counts'

  const detail = starFree
    ? `The syntactic monoid is aperiodic (no non-trivial subgroup), so by Schützenberger's theorem the language is star-free: expressible with union, concatenation and complement but no Kleene star. Equivalently it is definable in first-order logic FO[<] and in linear temporal logic.`
    : `The syntactic monoid contains a non-trivial group, so by Schützenberger's theorem the language is not star-free. The generator ${
        obstruction ? `“${obstruction.word}”` : ''
      } acts as a counter of period ${
        obstruction?.period ?? '>1'
      }: no first-order sentence over (<) can decide it, because FO[<] cannot count modulo a number.`

  const varieties: VarietyRow[] = [
    {
      name: 'Trivial',
      algebra: '|M| = 1',
      language: '∅ or Σ*',
      holds: props.trivial,
      theorem: 'The two languages whose syntactic monoid collapses to a point.',
    },
    {
      name: 'Aperiodic (star-free)',
      algebra: 'no non-trivial subgroup',
      language: 'star-free = FO[<] = LTL',
      holds: props.aperiodic,
      theorem: 'Schützenberger 1965 · McNaughton–Papert 1971 · Kamp 1968.',
    },
    {
      name: 'J-trivial (piecewise testable)',
      algebra: 'every J-class is a singleton',
      language: 'boolean combos of Σ*a₁Σ*…aₖΣ*',
      holds: props.jTrivial,
      theorem: "Simon's theorem 1975 — testable by the scattered subwords that appear.",
    },
    {
      name: 'R-trivial',
      algebra: 'every R-class is a singleton',
      language: 'unambiguous — “first occurrence” logic',
      holds: props.rTrivial,
      theorem: 'Languages recognised reading left-to-right without revisiting a choice.',
    },
    {
      name: 'Commutative',
      algebra: 'ab = ba for all a, b',
      language: 'depends only on letter counts (Parikh)',
      holds: props.commutative,
      theorem: 'Membership ignores the order of letters.',
    },
    {
      name: 'Idempotent (band)',
      algebra: 'x² = x for all x',
      language: '',
      holds: props.band,
      theorem: 'Every element is its own square.',
    },
    {
      name: 'Semilattice (J₁)',
      algebra: 'commutative band',
      language: 'boolean combos of Σ*aΣ*',
      holds: props.semilattice,
      theorem: 'The simplest non-trivial variety — presence/absence of single letters.',
    },
    {
      name: 'Group',
      algebra: 'a unique idempotent (the identity)',
      language: 'pure modular counting',
      holds: props.group,
      theorem: 'Every element is invertible — the maximally non-star-free shape.',
    },
  ]

  return {
    starFree,
    foDefinable: starFree,
    ltlDefinable: starFree,
    piecewiseTestable: props.jTrivial,
    headline,
    detail,
    obstruction,
    varieties,
  }
}
