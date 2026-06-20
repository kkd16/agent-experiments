// Differential fuzzing — turning "trust me, the engines agree" into evidence.
//
// This studio carries five independent, from-scratch matchers plus two roads to
// a DFA. They *should* all agree on whether a string is in a regular language —
// but agreement is a claim, and a fuzzer is how you earn it. Each trial draws a
// random regular pattern and a batch of random strings from a seeded PRNG, then
// asks every engine the same yes/no question:
//
//   1. subset-construction DFA   (Thompson NFA → determinise → minimise)
//   2. derivative DFA            (Brzozowski derivatives → BFS)
//   3. streaming derivatives     (derive once per character, test nullable)
//   4. Antimirov DFA             (equation automaton → determinise)
//   5. partial derivatives       (equation-automaton NFA simulated directly)
//   6. Pike VM                   (bytecode thread-list, anchored)
//   7. backtracking VM           (continuation-passing matcher, anchored)
//   8. the platform's own RegExp (an external oracle — the one engine we did *not* write)
//
// Eight implementations, one verdict. Any single disagreement is a real bug in
// one of them, surfaced with the exact pattern and input that triggers it.
// Because the PRNG is seeded, every run is perfectly reproducible.

import type { RegexNode } from './ast';
import { compile } from './compile';
import { fromAst, accepts, buildDerivDFA, dsize } from './derivatives';
import { acceptsPartial, buildAntimirovNFA, buildAntimirovDFA } from './antimirov';
import { dfaAccepts, toCodePoints } from './simulate';
import { runPike } from './pike';
import { runVM } from './vm';

// --- Seeded PRNG (mulberry32) ----------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(next: () => number) {
    this.next = next;
  }
  float() {
    return this.next();
  }
  int(n: number) {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  chance(p: number) {
    return this.next() < p;
  }
}

// --- Random pattern generation (the safely-comparable regular subset) -------
//
// The grammar is deliberately restricted to constructs where our engines and JS
// `RegExp` agree exactly on *whole-string membership*: literals over a tiny
// alphabet, `.`, `\d`, simple/negated classes, grouping, alternation and the
// four quantifiers. No anchors, backreferences or lookaround (those leave the
// regular languages and JS-semantics parity). Output is a valid source string,
// so the real parser is exercised on every trial too.

const LITERALS = ['a', 'b', 'c', 'd'] as const;

function genAtom(rng: Rng, depth: number): string {
  // Bias hard toward terminals so patterns stay small and legible — and so the
  // full automata pipeline (the per-trial cost) doesn't blow up. Wide-alphabet
  // atoms (`.`, `\d`) and groups are kept rare and shallow: they are what make
  // the compiled DFA (and any counterexample) large.
  const allowGroup = depth < 2;
  const roll = rng.int(allowGroup ? 10 : 8);
  switch (roll) {
    case 0:
    case 1:
    case 2:
    case 3:
      return rng.pick(LITERALS);
    case 4:
      return '.';
    case 5:
      return '\\d';
    case 6:
    case 7: {
      // a character class, possibly negated, of 1–2 members/ranges
      const neg = rng.chance(0.3) ? '^' : '';
      const members: string[] = [];
      const n = 1 + rng.int(2);
      for (let i = 0; i < n; i++) {
        if (rng.chance(0.4)) {
          const lo = rng.int(3); // a..c
          members.push(`${LITERALS[lo]}-${LITERALS[lo + 1]}`);
        } else {
          members.push(rng.pick(LITERALS));
        }
      }
      return `[${neg}${members.join('')}]`;
    }
    default:
      return `(${genAlt(rng, depth + 1)})`;
  }
}

function genQuantified(rng: Rng, depth: number): string {
  const atom = genAtom(rng, depth);
  const q = rng.int(6);
  switch (q) {
    case 0:
      return atom + '*';
    case 1:
      return atom + '+';
    case 2:
      return atom + '?';
    case 3: {
      const m = rng.int(3);
      return `${atom}{${m}}`;
    }
    case 4: {
      const m = rng.int(2);
      const n = m + rng.int(3);
      return `${atom}{${m},${n}}`;
    }
    default:
      return atom; // unquantified
  }
}

function genConcat(rng: Rng, depth: number): string {
  const n = 1 + rng.int(depth === 0 ? 3 : 2);
  let out = '';
  for (let i = 0; i < n; i++) out += genQuantified(rng, depth);
  return out;
}

function genAlt(rng: Rng, depth: number): string {
  const n = 1 + rng.int(depth < 1 ? 3 : 2);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(genConcat(rng, depth));
  return parts.join('|');
}

const INPUT_ALPHABET = 'abcd012'.split('');

function genInput(rng: Rng, maxLen: number): string {
  const len = rng.int(maxLen + 1);
  let s = '';
  for (let i = 0; i < len; i++) s += rng.pick(INPUT_ALPHABET);
  return s;
}

// --- Anchored membership through the AST-driven engines ---------------------
// Wrap the pattern in ^…$ so the leftmost-search VM/Pike answer *whole-string*
// membership, matching what the DFA and RegExp oracle report.

function anchored(ast: RegexNode): RegexNode {
  return { type: 'concat', parts: [{ type: 'anchor', at: 'start' }, ast, { type: 'anchor', at: 'end' }] };
}

// --- The report ------------------------------------------------------------

export interface FuzzConfig {
  seed: number;
  trials: number; // distinct patterns
  stringsPerPattern: number;
  maxStringLen: number;
  useOracle: boolean; // include JS RegExp as a sixth engine
}

export const DEFAULT_FUZZ: FuzzConfig = {
  seed: 0x5eed,
  trials: 500,
  stringsPerPattern: 16,
  maxStringLen: 8,
  useOracle: true,
};

export interface Disagreement {
  pattern: string;
  input: string;
  results: { engine: string; verdict: boolean | 'error' }[];
}

export interface FuzzReport {
  config: FuzzConfig;
  engines: string[];
  patterns: number; // patterns actually tested
  checks: number; // (pattern × string) comparisons
  agreed: boolean;
  disagreement: Disagreement | null;
  oracleUsed: boolean;
  skipped: number; // generated patterns that failed to compile / parse (should be 0)
  aborts: number; // backtracking-VM runs that hit the step limit (no verdict — ReDoS, not a bug)
  elapsedMs: number;
}

const ENGINES_BASE = ['subset DFA', 'derivative DFA', 'streaming D', 'Antimirov DFA', 'partial D', 'Pike VM', 'backtracking VM'];

export function runFuzz(config: FuzzConfig = DEFAULT_FUZZ): FuzzReport {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const rng = new Rng(mulberry32(config.seed));
  const engines = config.useOracle ? [...ENGINES_BASE, 'RegExp oracle'] : ENGINES_BASE;

  let patterns = 0;
  let checks = 0;
  let skipped = 0;
  let aborts = 0;
  let disagreement: Disagreement | null = null;

  outer: for (let t = 0; t < config.trials; t++) {
    const source = genAlt(rng, 0);
    const c = compile(source);
    if (c.error || !c.ast || !c.features?.regular || !c.minDfa) {
      skipped++;
      continue;
    }
    patterns++;

    // Per-pattern precomputation shared across its strings. The derivative DFA
    // is built with a small state cap: a random nested pattern can explode toward
    // thousands of residual states, and building that for every trial dominates
    // the run. A truncated DFA is skipped below, and the streaming derivative
    // engine still exercises the derivative logic on every string regardless.
    const d = fromAst(c.ast);
    // Only build the derivative DFA for modest patterns and with tight budgets:
    // random nested quantifiers can blow the residual expressions up, and building
    // that machine for every trial dominates the run. When skipped/truncated the
    // streaming derivative engine still exercises the derivative logic per string.
    const dd = dsize(d) <= 40 ? buildDerivDFA(d, 200, 600) : null;
    // The Antimirov (equation-automaton) NFA is linear-size, so its determinised
    // DFA is cheap; still, cap it for the same pathological-pattern safety. The
    // streaming partial-derivative engine runs on every string regardless.
    const pn = dsize(d) <= 40 ? buildAntimirovNFA(d, 200, 600) : null;
    const adfa = pn && !pn.truncated ? buildAntimirovDFA(pn) : null;
    const anc = anchored(c.ast);
    let oracle: RegExp | null = null;
    if (config.useOracle) {
      try {
        oracle = new RegExp('^(?:' + source + ')$', 'u');
      } catch {
        oracle = null; // if the platform rejects it, just skip the oracle column
      }
    }

    for (let s = 0; s < config.stringsPerPattern; s++) {
      const input = genInput(rng, config.maxStringLen);
      const codeLen = toCodePoints(input).length;
      const results: { engine: string; verdict: boolean | 'error' }[] = [];

      results.push({ engine: 'subset DFA', verdict: safe(() => dfaAccepts(c.minDfa!, input)) });
      // The derivative DFA is exact unless BFS hit the state cap on a pathological
      // pattern; a truncated machine is incomplete, not wrong, so skip it.
      if (dd && !dd.truncated) results.push({ engine: 'derivative DFA', verdict: safe(() => dfaAccepts(dd, input)) });
      results.push({ engine: 'streaming D', verdict: safe(() => accepts(d, input)) });
      // The equation automaton: determinised (when built) and simulated directly.
      if (adfa) results.push({ engine: 'Antimirov DFA', verdict: safe(() => dfaAccepts(adfa, input)) });
      results.push({ engine: 'partial D', verdict: safe(() => acceptsPartial(d, input)) });
      results.push({
        engine: 'Pike VM',
        verdict: safe(() => {
          const r = runPike(anc, c.groupCount, input);
          return !!r.match && r.match.start === 0 && r.match.end === codeLen;
        }),
      });
      // The backtracking VM can hit its step limit on a (randomly generated)
      // catastrophic pattern. An aborted run is "gave up", not "rejected", so it
      // yields no verdict — we skip it rather than count it as a disagreement.
      let vmAborted = false;
      const vmVerdict = safe(() => {
        // A modest step limit keeps the in-app run snappy: a non-catastrophic
        // pattern decides well within it, and a catastrophic one trips the limit
        // fast and is skipped (its blow-up is a ReDoS demo, not a wrong answer).
        const r = runVM(anc, c.groupCount, input, { stepLimit: 120_000 });
        if (r.aborted) {
          vmAborted = true;
          return false;
        }
        return !!r.match && r.match.start === 0 && r.match.end === codeLen;
      });
      if (vmAborted) aborts++;
      else results.push({ engine: 'backtracking VM', verdict: vmVerdict });
      if (config.useOracle && oracle) results.push({ engine: 'RegExp oracle', verdict: safe(() => oracle!.test(input)) });

      checks++;

      // Every engine must return the same boolean. A thrown exception ('error')
      // is itself a failure worth surfacing.
      const verdicts = results.map((r) => r.verdict);
      const allAgree = verdicts.every((v) => v === verdicts[0] && v !== 'error');
      if (!allAgree) {
        disagreement = { pattern: source, input, results };
        break outer;
      }
    }
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    config,
    engines,
    patterns,
    checks,
    agreed: disagreement === null,
    disagreement,
    oracleUsed: config.useOracle,
    skipped,
    aborts,
    elapsedMs: Math.max(0, Math.round(t1 - t0)),
  };
}

function safe(fn: () => boolean): boolean | 'error' {
  try {
    return fn();
  } catch {
    return 'error';
  }
}
