// CTL* model checking by the **Emerson–Lei algorithm** — the synthesis of the lab's two existing
// temporal engines. A CTL* state formula is decided by repeatedly stripping the *innermost* path
// quantifier:
//
//   1. Find a subformula `Q ρ` (`Q ∈ {E, A}`) whose body ρ contains no further quantifier — so ρ is a
//      pure LTL path formula over atoms (and the labels introduced by earlier rounds).
//   2. Decide `Q ρ` at every state. `E ρ` is "some path from here satisfies ρ" — one LTL emptiness
//      check per state (the GPVW/Vardi–Wolper machinery of the Logic mode, in `pathexist.ts`). `A ρ`
//      is its dual: `A ρ = ¬ E ¬ρ`, so we check `E ¬ρ` and complement.
//   3. Introduce a fresh atomic proposition χᵢ true in exactly the states satisfying `Q ρ`, label the
//      model with it, and replace the whole `Q ρ` subformula by χᵢ.
//
// Processing innermost-first (a post-order rewrite) guarantees that by the time a quantifier is
// reached, every quantifier nested inside its body has already collapsed to a label — so its body is
// always honestly an LTL formula. When the last quantifier is gone the residual is a Boolean
// combination of atoms, evaluated state-by-state. The result is the satisfying set of the whole
// formula, the decomposition trace (each χᵢ and the path formula it abbreviates), and a witnessing /
// refuting path for each quantifier round.
//
// This is the algorithm that makes CTL* practical: branching-time *labelling* on the outside (the CTL
// mode), linear-time *automata* on the inside (the LTL mode), glued by atom introduction.

import type { Star, Fragment } from './formula'
import { starToLtl, isStateFormula, offendingTemporal, hasQuant, classify, showStar } from './formula'
import type { Ltl } from '../ltl/formula'
import { toCore } from '../ltl/formula'
import type { CtlModel } from '../ctl/modelcheck'
import { totalize } from '../ctl/modelcheck'
import type { Kripke } from '../ltl/kripke'
import type { Holds, Lasso, PathExistFn } from './pathexist'
import { pathExistGPVW } from './pathexist'

/** One quantifier-elimination round: the label χᵢ it produced and the path formula it abbreviates. */
export interface StarStep {
  label: string // the fresh proposition, e.g. "χ0"
  quant: 'E' | 'A'
  /** The (quantifier-free) LTL path body, with inner quantifiers already shown as their χ labels. */
  pathStar: Star
  pathText: string
  /** The original `Q ρ` subformula (inner quantifiers shown in full). */
  sourceStar: Star
  sourceText: string
  satBool: boolean[]
  sat: number[] // sorted states where `Q ρ` holds
  /** A witnessing path per relevant state: kind `sat` (a path ⊨ ρ for E) or `viol` (a path ⊨ ¬ρ for A). */
  witnesses: { state: number; lasso: Lasso; kind: 'sat' | 'viol' }[]
  /** The LTL formula every witness lasso satisfies (ρ for an E round, ¬ρ for an A round). */
  replayLtl: Ltl
  productStates: number
}

export interface StarResult {
  steps: StarStep[]
  residual: Star // the propositional residual over atoms + χ labels
  satBool: boolean[]
  sat: number[]
  holds: boolean // every initial state satisfies the formula
  initialVerdict: { state: number; holds: boolean }[]
  labelMap: Map<string, boolean[]>
  fragment: Fragment
}

export interface WellFormedError {
  ok: false
  message: string
}

/** Reject anything that is not a CTL* *state* formula (the only thing the semantics is defined for). */
export function checkWellFormed(phi: Star): WellFormedError | { ok: true } {
  if (isStateFormula(phi)) return { ok: true }
  const op = offendingTemporal(phi) ?? 'a temporal operator'
  return {
    ok: false,
    message: `“${op}” must sit under a path quantifier — wrap it as E ${op}… / A ${op}… (CTL* checks state formulas)`,
  }
}

/** Evaluate a quantifier-free, temporal-free residual formula at one state. */
function evalProp(node: Star, state: number, model: CtlModel, labelMap: Map<string, boolean[]>): boolean {
  switch (node.k) {
    case 'true':
      return true
    case 'false':
      return false
    case 'atom': {
      const lbl = labelMap.get(node.name)
      return lbl ? lbl[state] : model.props[state].has(node.name)
    }
    case 'not':
      return !evalProp(node.a, state, model, labelMap)
    case 'and':
      return evalProp(node.a, state, model, labelMap) && evalProp(node.b, state, model, labelMap)
    case 'or':
      return evalProp(node.a, state, model, labelMap) || evalProp(node.b, state, model, labelMap)
    case 'imp':
      return !evalProp(node.a, state, model, labelMap) || evalProp(node.b, state, model, labelMap)
    case 'iff':
      return evalProp(node.a, state, model, labelMap) === evalProp(node.b, state, model, labelMap)
    default:
      // A temporal operator / quantifier in the residual would be a bug (caught by checkWellFormed).
      throw new Error('evalProp: non-propositional residual (internal error)')
  }
}

/**
 * Model-check a well-formed CTL* state formula against a (raw) Kripke structure. The path-existence
 * engine is injected so the same driver runs the production GPVW engine and the differential oracle.
 */
export function modelCheckStar(
  phi: Star,
  kripke: Kripke,
  pathExist: PathExistFn = pathExistGPVW,
): StarResult {
  const model = totalize(kripke)
  return modelCheckStarOn(phi, model, pathExist)
}

/** As `modelCheckStar`, but against an already-totalized `CtlModel` (shared with the self-test). */
export function modelCheckStarOn(
  phi: Star,
  model: CtlModel,
  pathExist: PathExistFn = pathExistGPVW,
): StarResult {
  const labelMap = new Map<string, boolean[]>()
  const steps: StarStep[] = []
  let counter = 0

  // `holds` reads real propositions and, transparently, the χ labels introduced so far.
  const holds: Holds = (state, atom) => {
    const lbl = labelMap.get(atom)
    return lbl ? lbl[state] : model.props[state].has(atom)
  }

  // Post-order rewrite: eliminate the innermost quantifier first.
  const eliminate = (node: Star): Star => {
    switch (node.k) {
      case 'true':
      case 'false':
      case 'atom':
        return node
      case 'not':
        return { k: 'not', a: eliminate(node.a) }
      case 'next':
        return { k: 'next', a: eliminate(node.a) }
      case 'fin':
        return { k: 'fin', a: eliminate(node.a) }
      case 'glob':
        return { k: 'glob', a: eliminate(node.a) }
      case 'and':
      case 'or':
      case 'imp':
      case 'iff':
      case 'until':
      case 'release':
      case 'wuntil':
        return { k: node.k, a: eliminate(node.a), b: eliminate(node.b) } as Star
      case 'E':
      case 'A': {
        const rho = eliminate(node.a) // now quantifier-free: a pure LTL path formula
        const ltlPos: Ltl = starToLtl(rho)
        // E ρ: states with SOME path ⊨ ρ. A ρ = ¬E¬ρ: check E¬ρ and complement.
        const positive = node.k === 'E'
        const core = toCore(ltlPos, !positive) // NNF of ρ (E) or of ¬ρ (A)
        const pr = pathExist(core, ltlPos, model, holds)
        const satBool = positive ? pr.sat.slice() : pr.sat.map((v) => !v)

        const label = `χ${counter++}`
        labelMap.set(label, satBool)

        const witnesses: StarStep['witnesses'] = []
        for (let s = 0; s < model.n; s++) {
          const w = pr.witness[s]
          if (!w) continue
          // E: pr.sat[s] means a path ⊨ ρ exists (a satisfaction witness for E ρ holding).
          // A: pr.sat[s] means a path ⊨ ¬ρ exists (a violation witness for A ρ failing).
          witnesses.push({ state: s, lasso: w, kind: positive ? 'sat' : 'viol' })
        }
        const replayLtl: Ltl = positive ? ltlPos : { k: 'not', a: ltlPos }

        steps.push({
          label,
          quant: node.k,
          pathStar: rho,
          pathText: showStar(rho),
          sourceStar: node,
          sourceText: showStar(node),
          satBool,
          sat: toList(satBool),
          witnesses,
          replayLtl,
          productStates: pr.productStates,
        })
        return { k: 'atom', name: label }
      }
    }
  }

  const residual = eliminate(phi)
  const satBool = model.props.map((_, s) => evalProp(residual, s, model, labelMap))

  return {
    steps,
    residual,
    satBool,
    sat: toList(satBool),
    holds: model.initial.every((s) => satBool[s]),
    initialVerdict: model.initial.map((s) => ({ state: s, holds: satBool[s] })),
    labelMap,
    fragment: classify(phi),
  }
}

/** Just the satisfying-state vector (used by the differential self-test). */
export function satVectorStar(phi: Star, model: CtlModel, pathExist: PathExistFn = pathExistGPVW): boolean[] {
  return modelCheckStarOn(phi, model, pathExist).satBool
}

function toList(b: boolean[]): number[] {
  const out: number[] = []
  for (let i = 0; i < b.length; i++) if (b[i]) out.push(i)
  return out
}

export { hasQuant }
