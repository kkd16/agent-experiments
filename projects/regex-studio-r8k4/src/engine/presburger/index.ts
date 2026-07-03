// Presburger arithmetic ⇒ Automaton, end to end. Parse a first-order formula of
// ⟨ℕ, +, <, ≡⟩, compile it to a finite automaton over the binary digits of its
// free variables (Büchi–Bruyère–Villemaire), and read everything back: the
// solution set as decoded tuples, the sentence's truth value, the construction
// blow-up. The arithmetic counterpart of the studio's MSO "Logic" tab — where
// that reads a *string* logic into an automaton, this reads *number theory*.

import type { Formula } from './ast';
import { freeVars, isSentence, formulaToString } from './ast';
import { parsePresburger, type ParseError } from './parser';
import { compilePresburgerFormula, type SizeTrace } from './compile';
import { LogicError, type BitDFA, isEmpty } from '../logic/bitaut';
import { isQuantifierFree } from './semantics';

export interface PresburgerCompiled {
  source: string;
  error: ParseError | null;
  buildError: string | null;
  formula: Formula | null;
  formulaText: string | null;
  free: string[];
  sentence: boolean;
  quantifierFree: boolean;
  automaton: BitDFA | null; // over the free-variable digit tracks
  trace: SizeTrace[];
  maxStates: number;
  sentenceValue: boolean | null; // for sentences: is it true over ℕ?
}

export function compilePresburger(source: string): PresburgerCompiled {
  const base: PresburgerCompiled = {
    source,
    error: null,
    buildError: null,
    formula: null,
    formulaText: null,
    free: [],
    sentence: false,
    quantifierFree: false,
    automaton: null,
    trace: [],
    maxStates: 0,
    sentenceValue: null,
  };

  const r = parsePresburger(source);
  if (r.error) return { ...base, error: r.error };
  const formula = r.formula;
  if (!formula) return { ...base, error: { message: 'empty formula', index: 0 } };

  base.formula = formula;
  base.formulaText = formulaToString(formula);
  base.free = [...freeVars(formula)].sort();
  base.sentence = isSentence(formula);
  base.quantifierFree = isQuantifierFree(formula);

  try {
    const { automaton, trace, maxStates } = compilePresburgerFormula(formula);
    base.automaton = automaton;
    base.trace = trace;
    base.maxStates = maxStates;
    if (base.sentence) base.sentenceValue = !isEmpty(automaton);
  } catch (e) {
    if (e instanceof LogicError) return { ...base, buildError: e.message };
    return { ...base, buildError: String((e as Error)?.message ?? e) };
  }
  return base;
}

export interface PresburgerExample {
  name: string;
  src: string;
  note: string;
}

export const PRESBURGER_EXAMPLES: PresburgerExample[] = [
  {
    name: 'x is even',
    src: 'exists y. x = y + y',
    note: 'Project the witness y away and the automaton for “x even” — the classic base-2 “low bit is 0” — falls out. Equivalent to x ≡ 0 (mod 2).',
  },
  {
    name: 'x + y = z (addition, the ripple-carry adder)',
    src: 'x + y = z',
    note: 'The graph IS a binary adder: the two states are “no carry” / “carry”, exactly the carry bit rippling least-significant-digit first.',
  },
  {
    name: 'x < y',
    src: 'x < y',
    note: 'Order as an automaton — reading LSD-first, the last digit position where they differ decides it.',
  },
  {
    name: '3 divides x',
    src: 'x ≡ 0 (mod 3)',
    note: 'The famous “binary multiples of three” automaton, derived from the congruence rather than hand-drawn.',
  },
  {
    name: '2x + 1 = y  (y is odd, and its double-plus-one twin)',
    src: '2*x + 1 = y',
    note: 'A linear Diophantine relation between two naturals — coefficients and a constant, straight into the carry construction.',
  },
  {
    name: 'no largest number (a false ∀)',
    src: 'forall x. exists y. x < y',
    note: 'A true sentence: ∀x ∃y. x<y. The automaton is non-empty (accepts) — decided, not asserted.',
  },
  {
    name: 'every number is even or odd',
    src: 'forall x. (x ≡ 0 (mod 2) | x ≡ 1 (mod 2))',
    note: 'A tautology of arithmetic, verified by the automaton coming back universally accepting.',
  },
  {
    name: 'Chicken McNugget: 3a + 5b (Frobenius)',
    src: 'exists a. exists b. n = 3*a + 5*b',
    note: 'Which n are a non-negative combination of 3 and 5? The largest gap (7) is the Frobenius number — read it straight off the solution list.',
  },
  {
    name: '∃ solution to 2x = 2y + 1 (there is none)',
    src: 'exists x. exists y. 2*x = 2*y + 1',
    note: 'Even can never equal odd — the sentence is false, and the projected automaton is empty. Parity, decided.',
  },
];
