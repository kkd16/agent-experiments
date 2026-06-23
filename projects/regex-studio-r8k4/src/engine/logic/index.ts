// Logic ⇒ Automaton, end to end: parse an MSO[<] (or LTLf) formula, compile it
// to a finite automaton by the Büchi–Elgot–Trakhtenbrot construction, and — for
// a sentence — lower it into the studio's own DFA so it flows into every
// existing view (Min-DFA, Language, Census, Algebra). The converse of the whole
// studio: instead of compiling a regex *down* to an automaton, build the
// automaton a logical *specification* denotes.

import type { DFA } from '../dfa';
import { atomIndexFor } from '../dfa';
import { minimizeDFA } from '../minimize';
import type { Formula } from './ast';
import { freeVars, isSentence, isFirstOrder, formulaToString } from './ast';
import { parseFormula, type ParseError } from './parser';
import { parseLTLf, type LTL, ltlToString } from './ltlf';
import { compileFormula, type SizeTrace } from './compile';
import { LogicError, type BitDFA } from './bitaut';
import { lowerSentenceToDFA } from './lower';

export type LogicMode = 'mso' | 'ltlf';

export interface LogicCompiled {
  mode: LogicMode;
  source: string;
  alphabet: string[];
  error: ParseError | null; // parse error
  buildError: string | null; // construction error (e.g. state blow-up, bad letter)
  formula: Formula | null; // the (possibly desugared) MSO formula
  formulaText: string | null;
  ltl: LTL | null;
  ltlText: string | null;
  free: { fo: string[]; so: string[] };
  sentence: boolean;
  firstOrder: boolean;
  bit: BitDFA | null; // automaton over the free-variable tracks
  trace: SizeTrace[];
  maxStates: number;
  dfa: DFA | null; // lowered + minimised studio DFA (sentences only)
}

export function compileLogic(source: string, alphabet: string[], mode: LogicMode): LogicCompiled {
  const base: LogicCompiled = {
    mode,
    source,
    alphabet,
    error: null,
    buildError: null,
    formula: null,
    formulaText: null,
    ltl: null,
    ltlText: null,
    free: { fo: [], so: [] },
    sentence: false,
    firstOrder: true,
    bit: null,
    trace: [],
    maxStates: 0,
    dfa: null,
  };

  let formula: Formula | null;
  if (mode === 'ltlf') {
    const r = parseLTLf(source);
    if (r.error) return { ...base, error: r.error };
    formula = r.formula;
    base.ltl = r.ltl;
    base.ltlText = r.ltl ? ltlToString(r.ltl) : null;
  } else {
    const r = parseFormula(source);
    if (r.error) return { ...base, error: r.error };
    formula = r.formula;
  }
  if (!formula) return { ...base, error: { message: 'empty formula', index: 0 } };

  const fv = freeVars(formula);
  base.formula = formula;
  base.formulaText = formulaToString(formula);
  base.free = { fo: [...fv.fo].sort(), so: [...fv.so].sort() };
  base.sentence = isSentence(formula);
  base.firstOrder = isFirstOrder(formula);

  try {
    const { automaton, trace, maxStates } = compileFormula(formula, alphabet);
    base.bit = automaton;
    base.trace = trace;
    base.maxStates = maxStates;
    if (base.sentence) {
      base.dfa = minimizeDFA(lowerSentenceToDFA(automaton, alphabet));
    }
  } catch (e) {
    if (e instanceof LogicError) return { ...base, buildError: e.message };
    return { ...base, buildError: String((e as Error)?.message ?? e) };
  }
  return base;
}

// Run a lowered studio DFA on a word given as letter indices.
export function acceptsLoweredDFA(dfa: DFA, indices: number[], alphabet: string[]): boolean {
  let state = dfa.start;
  for (const li of indices) {
    const code = alphabet[li].codePointAt(0) ?? 0;
    const a = atomIndexFor(dfa.atoms, code);
    if (a < 0) return false;
    const next = dfa.table[state][a];
    if (next < 0) return false;
    state = next;
  }
  return dfa.states[state].accept;
}

export type { Formula, BitDFA, SizeTrace, LTL, ParseError };
