// The pipeline in one call: source → AST → ε-NFA → DFA → minimal DFA.
// Each stage is null when an earlier stage failed, so the UI can show partial
// progress and a precise parse error.

import type { ParseError, RegexNode } from './ast';
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
}

export function compile(source: string): Compiled {
  const { ast, error, groupCount } = parse(source);
  if (!ast || error) {
    return { source, error, ast: null, nfa: null, dfa: null, minDfa: null, groupCount };
  }
  const nfa = buildNFA(ast);
  const dfa = buildDFA(nfa);
  const minDfa = minimizeDFA(dfa);
  return { source, error: null, ast, nfa, dfa, minDfa, groupCount };
}

export type { RegexNode, ParseError, NFA, DFA };
