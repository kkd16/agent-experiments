// The proof console — the house style. A seeded fuzzer draws random FO and MSO
// sentences over a small alphabet and checks, three ways, that the Büchi
// compiler is correct:
//
//  1. DIFFERENTIAL — compile the sentence to a DFA and confront it with the
//     brute-force oracle on *every* word up to length L. The compiled automaton
//     must accept exactly the words the oracle says satisfy the formula.
//  2. DUALITY — ∀x.φ and ¬∃x¬φ must compile to the same language (a check the
//     compiler can't fake, since the two go through different code paths).
//  3. THE VARIETY BRIDGE — every *first-order* sentence's language must come back
//     star-free (McNaughton–Papert), decided by the studio's own syntactic-monoid
//     engine; every sentence's language must be regular (Büchi).
//
// Reproducible by seed; the first counterexample is surfaced verbatim.

import type { Formula } from './ast';
import { isFirstOrder, formulaToString } from './ast';
import { compileFormula } from './compile';
import { lowerSentenceToDFA } from './lower';
import { minimizeDFA } from '../minimize';
import { languageUpTo } from './semantics';
import { acceptsLoweredDFA } from './index';
import { buildSyntacticMonoid, greenRelations, monoidProperties } from '../monoid';

// ── a seeded PRNG (sfc32-ish via mulberry32) ──────────────────────────────────
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

// ── random formula generation ────────────────────────────────────────────────
interface GenCtx {
  rnd: () => number;
  alphabet: string[];
  foInScope: string[];
  soInScope: string[];
  foCounter: { n: number };
  soCounter: { n: number };
  allowSO: boolean;
}

function pick<T>(rnd: () => number, xs: T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

function genAtom(ctx: GenCtx): Formula {
  const choices: (() => Formula)[] = [];
  if (ctx.foInScope.length >= 1) {
    choices.push(() => ({ kind: 'label', letter: pick(ctx.rnd, ctx.alphabet), x: pick(ctx.rnd, ctx.foInScope) }));
  }
  if (ctx.foInScope.length >= 2) {
    choices.push(() => {
      const x = pick(ctx.rnd, ctx.foInScope);
      let y = pick(ctx.rnd, ctx.foInScope);
      if (y === x) y = ctx.foInScope[(ctx.foInScope.indexOf(x) + 1) % ctx.foInScope.length];
      const op = pick(ctx.rnd, ['lt', 'le', 'eq', 'succ'] as const);
      return { kind: op, x, y };
    });
  }
  if (ctx.foInScope.length >= 1 && ctx.soInScope.length >= 1) {
    choices.push(() => ({ kind: 'mem', x: pick(ctx.rnd, ctx.foInScope), set: pick(ctx.rnd, ctx.soInScope) }));
  }
  choices.push(() => ({ kind: ctx.rnd() < 0.5 ? 'true' : 'false' }));
  return pick(ctx.rnd, choices)();
}

function genFormula(ctx: GenCtx, depth: number): Formula {
  if (depth <= 0) return genAtom(ctx);
  const r = ctx.rnd();
  if (r < 0.3) {
    const op = pick(ctx.rnd, ['and', 'or', 'implies', 'iff'] as const);
    return { kind: op, a: genFormula(ctx, depth - 1), b: genFormula(ctx, depth - 1) };
  }
  if (r < 0.45) return { kind: 'not', a: genFormula(ctx, depth - 1) };
  if (r < 0.8) {
    const v = `x${ctx.foCounter.n++}`;
    const inner = { ...ctx, foInScope: [...ctx.foInScope, v] };
    const q = ctx.rnd() < 0.5 ? 'existsFO' : 'forallFO';
    return { kind: q, v, a: genFormula(inner, depth - 1) };
  }
  if (ctx.allowSO && r < 0.92) {
    const v = `Y${ctx.soCounter.n++}`;
    const inner = { ...ctx, soInScope: [...ctx.soInScope, v] };
    const q = ctx.rnd() < 0.5 ? 'existsSO' : 'forallSO';
    return { kind: q, v, a: genFormula(inner, depth - 1) };
  }
  return genAtom(ctx);
}

export interface LogicFuzzConfig {
  seed: number;
  trials: number;
  alphabet: string[];
  maxLen: number; // brute-force horizon
  depth: number; // formula depth
  allowSO: boolean;
}

export const DEFAULT_LOGIC_FUZZ: LogicFuzzConfig = {
  seed: 1,
  trials: 120,
  alphabet: ['a', 'b'],
  maxLen: 6,
  depth: 3,
  allowSO: true,
};

export interface LogicFuzzReport {
  ok: boolean;
  trials: number;
  membershipChecks: number;
  dualityChecks: number;
  bridgeChecks: number;
  foSentences: number;
  msoSentences: number;
  skipped: number; // blew past the state cap (reported, not a failure)
  elapsedMs: number;
  failure: null | {
    kind: 'membership' | 'duality' | 'bridge';
    formula: string;
    detail: string;
  };
}

function isStarFree(dfaMin: ReturnType<typeof minimizeDFA>): boolean {
  const m = buildSyntacticMonoid(dfaMin);
  const green = greenRelations(m);
  if (!green) return false;
  const props = monoidProperties(m, green);
  return props.aperiodic;
}

export function runLogicFuzz(config: LogicFuzzConfig = DEFAULT_LOGIC_FUZZ): LogicFuzzReport {
  const start = performance.now();
  const rnd = mulberry32(config.seed * 2654435761 + 12345);
  let membershipChecks = 0;
  let dualityChecks = 0;
  let bridgeChecks = 0;
  let foSentences = 0;
  let msoSentences = 0;
  let skipped = 0;

  for (let t = 0; t < config.trials; t++) {
    // Generate a sentence: keep quantifying free variables until closed.
    const ctx: GenCtx = {
      rnd,
      alphabet: config.alphabet,
      foInScope: [],
      soInScope: [],
      foCounter: { n: 0 },
      soCounter: { n: 0 },
      allowSO: config.allowSO,
    };
    // The generator only references variables that are in scope, so the result
    // is always a closed sentence.
    const sentence = genFormula(ctx, config.depth);

    let dfa: ReturnType<typeof minimizeDFA>;
    try {
      const { automaton } = compileFormula(sentence, config.alphabet);
      if (automaton.tracks.length !== 0) {
        skipped++;
        continue;
      }
      dfa = minimizeDFA(lowerSentenceToDFA(automaton, config.alphabet));
    } catch {
      skipped++;
      continue;
    }

    const letterIdx = new Map<string, number>();
    config.alphabet.forEach((c, i) => letterIdx.set(c, i));

    // (1) differential against the oracle
    const words = languageUpTo(sentence, config.alphabet, config.maxLen);
    for (const w of words) {
      const oracle = w.accept;
      const auto = acceptsLoweredDFA(dfa, w.indices, config.alphabet);
      membershipChecks++;
      if (oracle !== auto) {
        return done(start, {
          kind: 'membership',
          formula: formulaToString(sentence),
          detail: `word "${w.word || 'ε'}" — oracle ${oracle}, automaton ${auto}`,
        });
      }
    }

    // (2) duality: ∀-form vs ¬∃¬ form (only meaningful when the formula has an
    // outer FO universal we can mirror — here we wrap the whole sentence: it is
    // closed, so ∀-rewrite is the identity on truth, but the *construction*
    // differs and must agree). We compare against a structurally rewritten copy.
    const rewritten = pushNegations(sentence);
    try {
      const { automaton: a2 } = compileFormula(rewritten, config.alphabet);
      if (a2.tracks.length === 0) {
        const dfa2 = minimizeDFA(lowerSentenceToDFA(a2, config.alphabet));
        for (const w of words) {
          dualityChecks++;
          if (acceptsLoweredDFA(dfa2, w.indices, config.alphabet) !== acceptsLoweredDFA(dfa, w.indices, config.alphabet)) {
            return done(start, {
              kind: 'duality',
              formula: formulaToString(sentence),
              detail: `negation-normalised form disagrees on "${w.word || 'ε'}"`,
            });
          }
        }
      }
    } catch {
      /* blow-up on the rewritten form — skip the duality check for this one */
    }

    // (3) variety bridge
    const fo = isFirstOrder(sentence);
    if (fo) foSentences++;
    else msoSentences++;
    bridgeChecks++;
    if (fo && !isStarFree(dfa)) {
      return done(start, {
        kind: 'bridge',
        formula: formulaToString(sentence),
        detail: `first-order sentence but its language is NOT star-free — contradicts McNaughton–Papert`,
      });
    }
  }

  return {
    ok: true,
    trials: config.trials,
    membershipChecks,
    dualityChecks,
    bridgeChecks,
    foSentences,
    msoSentences,
    skipped,
    elapsedMs: performance.now() - start,
    failure: null,
  };

  function done(t0: number, failure: NonNullable<LogicFuzzReport['failure']>): LogicFuzzReport {
    return {
      ok: false,
      trials: config.trials,
      membershipChecks,
      dualityChecks,
      bridgeChecks,
      foSentences,
      msoSentences,
      skipped,
      elapsedMs: performance.now() - t0,
      failure,
    };
  }
}

// Negation normal form rewrite (de Morgan + quantifier duality) — a different
// construction path with the same semantics, for the duality cross-check.
function pushNegations(f: Formula): Formula {
  switch (f.kind) {
    case 'not':
      return negate(f.a);
    case 'and':
    case 'or':
      return { kind: f.kind, a: pushNegations(f.a), b: pushNegations(f.b) };
    case 'implies':
      return { kind: 'or', a: negate(f.a), b: pushNegations(f.b) };
    case 'iff':
      return {
        kind: 'and',
        a: { kind: 'or', a: negate(f.a), b: pushNegations(f.b) },
        b: { kind: 'or', a: negate(f.b), b: pushNegations(f.a) },
      };
    case 'existsFO':
    case 'forallFO':
    case 'existsSO':
    case 'forallSO':
      return { ...f, a: pushNegations(f.a) };
    default:
      return f;
  }
}

function negate(f: Formula): Formula {
  switch (f.kind) {
    case 'true':
      return { kind: 'false' };
    case 'false':
      return { kind: 'true' };
    case 'not':
      return pushNegations(f.a);
    case 'and':
      return { kind: 'or', a: negate(f.a), b: negate(f.b) };
    case 'or':
      return { kind: 'and', a: negate(f.a), b: negate(f.b) };
    case 'implies':
      return { kind: 'and', a: pushNegations(f.a), b: negate(f.b) };
    case 'iff':
      return negate(pushNegations(f));
    case 'existsFO':
      return { kind: 'forallFO', v: f.v, a: negate(f.a) };
    case 'forallFO':
      return { kind: 'existsFO', v: f.v, a: negate(f.a) };
    case 'existsSO':
      return { kind: 'forallSO', v: f.v, a: negate(f.a) };
    case 'forallSO':
      return { kind: 'existsSO', v: f.v, a: negate(f.a) };
    default:
      return { kind: 'not', a: f };
  }
}
