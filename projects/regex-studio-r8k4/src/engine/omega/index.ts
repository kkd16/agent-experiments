// The ω-studio orchestrator. Parse an LTL spec, push it to negation-normal
// form, build the generalized Büchi automaton by the GPVW tableau, degeneralize
// to a plain NBA, and decide the two questions the automata-theoretic approach
// to model checking (Vardi–Wolper) reduces everything to:
//
//   satisfiable(φ)  ⇔  L(NBA(φ)) ≠ ∅            (a model lasso witnesses it)
//   valid(φ)        ⇔  L(NBA(¬φ)) = ∅           (else a counterexample lasso)
//
// ω-emptiness is a reachable accepting cycle, and its witness is a lasso u·vᵒ.

import {
  parseLTL,
  toCore,
  ltlToString,
  coreToString,
  propsOf,
  type LTL,
  type ParseError,
} from './ltl';
import { buildGBA } from './gpvw';
import {
  degeneralize,
  trimGBA,
  trimNBA,
  isEmpty,
  witness,
  OmegaError,
  type GBA,
  type NBA,
  type Lasso,
} from './nba';

export interface OmegaTrace {
  closure: number; // distinct subformulas of the NNF core
  gbaStates: number; // tableau nodes (generalized Büchi)
  acceptSets: number; // one per Until-subformula (the degeneralization factor k)
  nbaStates: number; // after degeneralization + trim
}

export interface OmegaCompiled {
  error: ParseError | null;
  buildError: string | null;
  ltl: LTL | null;
  ltlText: string | null;
  coreText: string | null;
  gba: GBA | null;
  nba: NBA | null;
  trace: OmegaTrace | null;
  sat: { satisfiable: boolean; witness: Lasso | null } | null;
  valid: { valid: boolean; counter: Lasso | null } | null;
  props: string[];
  offAlphabet: string[];
}

// Build the trimmed NBA for an LTL formula (throws OmegaError on blow-up).
export function buildNBA(phi: LTL, alphabet: string[]): { gba: GBA; nba: NBA; closure: number; rawStates: number; k: number } {
  const core = toCore(phi);
  const { gba, closure, rawStates } = buildGBA(core, alphabet);
  const nba = trimNBA(degeneralize(gba));
  return { gba: trimGBA(gba), nba, closure, rawStates, k: gba.acceptSets.length };
}

export function compileOmega(src: string, alphabet: string[]): OmegaCompiled {
  const base: OmegaCompiled = {
    error: null,
    buildError: null,
    ltl: null,
    ltlText: null,
    coreText: null,
    gba: null,
    nba: null,
    trace: null,
    sat: null,
    valid: null,
    props: [],
    offAlphabet: [],
  };

  const { ltl, error } = parseLTL(src);
  if (error || !ltl) return { ...base, error };

  const props = [...propsOf(ltl)].sort();
  const offAlphabet = props.filter((p) => !alphabet.includes(p));
  base.ltl = ltl;
  base.ltlText = ltlToString(ltl);
  base.coreText = coreToString(toCore(ltl));
  base.props = props;
  base.offAlphabet = offAlphabet;

  let built: ReturnType<typeof buildNBA>;
  try {
    built = buildNBA(ltl, alphabet);
  } catch (e) {
    if (e instanceof OmegaError) return { ...base, buildError: e.message };
    throw e;
  }

  base.gba = built.gba;
  base.nba = built.nba;
  base.trace = {
    closure: built.closure,
    gbaStates: built.gba.stateCount,
    acceptSets: built.k,
    nbaStates: built.nba.stateCount,
  };

  // satisfiability — a model lasso when non-empty.
  const satisfiable = !isEmpty(built.nba);
  base.sat = { satisfiable, witness: satisfiable ? witness(built.nba) : null };

  // validity — build NBA(¬φ); φ is valid iff ¬φ is unsatisfiable.
  try {
    const neg = buildNBA({ k: 'not', a: ltl }, alphabet);
    const negSat = !isEmpty(neg.nba);
    base.valid = { valid: !negSat, counter: negSat ? witness(neg.nba) : null };
  } catch (e) {
    if (!(e instanceof OmegaError)) throw e;
    base.valid = null; // the negation blew up — leave validity undecided
  }

  return base;
}

export type { Lasso } from './nba';
