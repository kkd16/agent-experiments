// The proof console — the house style. A seeded fuzzer draws random grammars
// over a small alphabet and confronts the whole pillar with its three
// independent recognizers and its language-preserving transforms:
//
//  1. RECOGNIZER AGREEMENT — for every string up to a length horizon,
//     CYK(CNF) ≡ Earley(raw) ≡ the brute-force leftmost-derivation oracle. Three
//     unrelated algorithms; any disagreement is a real bug.
//  2. CNF PRESERVES THE LANGUAGE — the Chomsky-normal-form grammar accepts a
//     string iff the original derives it (checked via the oracle, a fourth road).
//  3. USELESS-REMOVAL PRESERVES THE LANGUAGE — trimming non-generating and
//     unreachable symbols never moves the language.
//  4. PDA ≡ ORACLE — the top-down pushdown automaton accepts iff the grammar
//     derives, on every string where its bounded search was conclusive.
//
// Reproducible by seed; the first counterexample is surfaced verbatim.

import type { Grammar, Rule, Sym } from './grammar';
import { grammarText, makeGrammar, nt, term } from './grammar';
import { removeUseless } from './analysis';
import { toChomskyNormalForm } from './normalize';
import { cyk } from './cyk';
import { earley } from './earley';
import { derives } from './oracle';
import { pdaAccepts } from './pda';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rnd: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}
function pick<T>(rnd: () => number, xs: T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

function randomGrammar(rnd: () => number): Grammar {
  const terminals = rnd() < 0.5 ? ['a', 'b'] : ['a', 'b', 'c'];
  const nonterminals = ['S', 'A', 'B'].slice(0, randInt(rnd, 2, 3));
  const rules: Rule[] = [];
  for (const N of nonterminals) {
    const prods = randInt(rnd, 1, 3);
    for (let p = 0; p < prods; p++) {
      const len = randInt(rnd, 0, 3);
      const rhs: Sym[] = [];
      for (let i = 0; i < len; i++) {
        if (rnd() < 0.55) rhs.push(term(pick(rnd, terminals)));
        else rhs.push(nt(pick(rnd, nonterminals)));
      }
      rules.push({ lhs: N, rhs });
    }
  }
  return makeGrammar('S', rules);
}

/** Every string over `alphabet` of length ≤ maxLen, capped in count. */
function allStrings(alphabet: string[], maxLen: number, cap: number): string[] {
  const out: string[] = [''];
  let frontier = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = [];
    for (const s of frontier) for (const a of alphabet) next.push(s + a);
    for (const s of next) {
      out.push(s);
      if (out.length >= cap) return out;
    }
    frontier = next;
  }
  return out;
}

export interface CfgFuzzFailure {
  kind: string;
  grammar: string;
  detail: string;
}

export interface CfgFuzzReport {
  ok: boolean;
  trials: number;
  stringChecks: number;
  cnfChecks: number;
  trimChecks: number;
  pdaChecks: number;
  elapsedMs: number;
  failure: CfgFuzzFailure | null;
}

export const DEFAULT_CFG_FUZZ = { seed: 1, trials: 120, maxLen: 5 };

export function runCfgFuzz(opts: { seed: number; trials: number; maxLen: number }): CfgFuzzReport {
  const rnd = mulberry32(opts.seed);
  const started = nowMs();
  let stringChecks = 0;
  let cnfChecks = 0;
  let trimChecks = 0;
  let pdaChecks = 0;

  for (let t = 0; t < opts.trials; t++) {
    const g = randomGrammar(rnd);
    let cnf: Grammar;
    try {
      cnf = toChomskyNormalForm(g).grammar;
    } catch {
      continue; // skip a pathological CNF blow-up
    }
    const trimmed = removeUseless(g);
    const alphabet = [...g.terminals].sort();
    if (alphabet.length === 0) {
      // only ε possible
      const oEmpty = derives(g, '');
      if (cyk(cnf, '').accepted !== oEmpty || earley(g, '').accepted !== oEmpty) {
        return fail('empty-alphabet', g, `ε membership disagreement`, t, stringChecks, cnfChecks, trimChecks, pdaChecks, started);
      }
      continue;
    }
    const maxLen = alphabet.length <= 2 ? opts.maxLen : Math.min(opts.maxLen, 4);
    const strings = allStrings(alphabet, maxLen, 64);

    for (const w of strings) {
      const o = derives(g, w);
      const e = earley(g, w).accepted;
      const c = cyk(cnf, w).accepted;
      stringChecks++;
      if (e !== o) {
        return fail('earley≠oracle', g, `on "${w || 'ε'}": Earley=${e}, oracle=${o}`, t, stringChecks, cnfChecks, trimChecks, pdaChecks, started);
      }
      cnfChecks++;
      if (c !== o) {
        return fail('cyk≠oracle', g, `on "${w || 'ε'}": CYK(CNF)=${c}, oracle=${o}`, t, stringChecks, cnfChecks, trimChecks, pdaChecks, started);
      }
      const trimO = derives(trimmed, w);
      trimChecks++;
      if (trimO !== o) {
        return fail('trim≠oracle', g, `on "${w || 'ε'}": trimmed=${trimO}, oracle=${o}`, t, stringChecks, cnfChecks, trimChecks, pdaChecks, started);
      }
      const p = pdaAccepts(g, w);
      if (!p.bounded) {
        pdaChecks++;
        if (p.accepted !== o) {
          return fail('pda≠oracle', g, `on "${w || 'ε'}": PDA=${p.accepted}, oracle=${o}`, t, stringChecks, cnfChecks, trimChecks, pdaChecks, started);
        }
      }
    }
  }

  return {
    ok: true,
    trials: opts.trials,
    stringChecks,
    cnfChecks,
    trimChecks,
    pdaChecks,
    elapsedMs: nowMs() - started,
    failure: null,
  };
}

function fail(
  kind: string,
  g: Grammar,
  detail: string,
  trials: number,
  stringChecks: number,
  cnfChecks: number,
  trimChecks: number,
  pdaChecks: number,
  started: number,
): CfgFuzzReport {
  return {
    ok: false,
    trials,
    stringChecks,
    cnfChecks,
    trimChecks,
    pdaChecks,
    elapsedMs: nowMs() - started,
    failure: { kind, grammar: grammarText(g), detail },
  };
}

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return 0;
  }
}
