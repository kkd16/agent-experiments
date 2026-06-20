// The pipeline in one call: source → AST → ε-NFA → DFA → minimal DFA.
// Each stage is null when an earlier stage failed, so the UI can show partial
// progress and a precise parse error.
//
// Patterns using non-regular constructs (backreferences, lookaround) or
// positional assertions (anchors, word boundaries) still parse into an AST and
// run on the backtracking VM, but they can't be represented by the plain
// alphabet-driven automata — so the NFA/DFA stages stay null and `features`
// records why.

import { analyzeFeatures, type AstFeatures, type ParseError, type RegexNode } from './ast';
import { parse } from './parser';
import { buildNFA, type NFA } from './nfa';
import { buildDFA, type DFA } from './dfa';
import { minimizeDFA } from './minimize';

export interface Compiled {
  source: string;
  error: ParseError | null;
  ast: RegexNode | null;
  nfa: NFA | null;
  dfa: DFA | null;
  minDfa: DFA | null;
  groupCount: number;
  groupNames: Record<string, number>;
  features: AstFeatures | null;
}

export function compile(source: string): Compiled {
  const { ast, error, groupCount, groupNames } = parse(source);
  if (!ast || error) {
    return { source, error, ast: null, nfa: null, dfa: null, minDfa: null, groupCount, groupNames, features: null };
  }
  const features = analyzeFeatures(ast);
  if (!features.regular) {
    // The AST is valid and the VM can run it, but the automata views can't.
    return { source, error: null, ast, nfa: null, dfa: null, minDfa: null, groupCount, groupNames, features };
  }
  const nfa = buildNFA(ast);
  const dfa = buildDFA(nfa);
  const minDfa = minimizeDFA(dfa);
  return { source, error: null, ast, nfa, dfa, minDfa, groupCount, groupNames, features };
}

export type { RegexNode, ParseError, NFA, DFA, AstFeatures };
