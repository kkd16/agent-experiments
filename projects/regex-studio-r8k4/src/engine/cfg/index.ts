// The Context-Free package façade — parse a grammar once and derive everything
// static about it (the cleaned grammar, its Chomsky normal form, the structural
// fixpoints, finiteness), plus a one-call membership test that runs all three
// recognizers and reports whether they agree.

import type { Grammar } from './grammar';
import { parseGrammar, type CfgParseError } from './parse';
import { generatingSet, nullableSet, reachableSet, removeUseless, analyzeFiniteness, type FinitenessResult } from './analysis';
import { toChomskyNormalForm, type CnfResult } from './normalize';
import { cyk, type CykResult } from './cyk';
import { earley, type EarleyResult } from './earley';
import { pdaAccepts } from './pda';
import { derives } from './oracle';

export interface CompiledCfg {
  source: string;
  error: CfgParseError | null;
  grammar: Grammar | null;
  trimmed: Grammar | null; // useless symbols removed
  cnf: CnfResult | null;
  nullable: string[];
  generating: string[];
  reachable: string[];
  useless: string[]; // symbols dropped by trimming
  finiteness: FinitenessResult | null;
}

export function compileCfg(source: string): CompiledCfg {
  const parsed = parseGrammar(source);
  if (parsed.error) {
    return {
      source,
      error: parsed.error,
      grammar: null,
      trimmed: null,
      cnf: null,
      nullable: [],
      generating: [],
      reachable: [],
      useless: [],
      finiteness: null,
    };
  }
  const g = parsed.grammar;
  const nullable = nullableSet(g);
  const generating = generatingSet(g);
  const reachable = reachableSet(g);
  const trimmed = removeUseless(g);
  const trimmedNames = new Set(trimmed.nonterminals);
  const useless = g.nonterminals.filter((A) => !trimmedNames.has(A) || !generating.has(A));
  let cnf: CnfResult | null;
  try {
    cnf = toChomskyNormalForm(g);
  } catch {
    cnf = null;
  }
  const finiteness = analyzeFiniteness(g);
  return {
    source,
    error: null,
    grammar: g,
    trimmed,
    cnf,
    nullable: [...nullable],
    generating: [...generating],
    reachable: [...reachable],
    useless: [...new Set(useless)],
    finiteness,
  };
}

export interface Membership {
  cyk: CykResult;
  earley: EarleyResult;
  oracleAccepts: boolean;
  pda: { accepted: boolean; bounded: boolean };
  agree: boolean;
}

export function membership(grammar: Grammar, cnf: Grammar, w: string): Membership {
  const c = cyk(cnf, w);
  const e = earley(grammar, w);
  const o = derives(grammar, w);
  const p = pdaAccepts(grammar, w);
  const agree = c.accepted === e.accepted && e.accepted === o && (p.bounded || p.accepted === o);
  return { cyk: c, earley: e, oracleAccepts: o, pda: p, agree };
}

export * from './grammar';
export * from './tree';
export { parseGrammar } from './parse';
export { CFG_EXAMPLES, DEFAULT_CFG_SOURCE, DEFAULT_CFG_SAMPLE, type CfgExample } from './gallery';
export { enumerateWords, shortestWord, findAmbiguity, rootTrees, derives, type AmbiguityWitness } from './oracle';
export { pdaRun, buildPda, type PdaRun, type PdaStep, type PdaTable } from './pda';
export { toChomskyNormalForm, isChomskyNormalForm, type CnfResult, type CnfStep } from './normalize';
export { cyk, type CykResult } from './cyk';
export { earley, type EarleyResult } from './earley';
