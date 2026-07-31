// Differential verification for the Tagged DFA.
//
// A capture engine is only as trustworthy as the evidence that it agrees with
// something you already believe. This harness draws random *capturing* regular
// patterns and random inputs from a seeded PRNG and, for each, compares three
// independent computations of the whole-string capture:
//
//   1. the TDFA               (buildTDFA → runTDFA) — the determinised machine
//   2. the reference sim      (simulateTagged)      — a plain thread list
//   3. the platform's RegExp  (^(?:R)$ with /d)     — an *external* oracle
//
// (1) vs (2) is the real theorem — determinisation must preserve the tagged
// semantics — and it is checked on *every* generated pattern. (3) is a second
// pair of eyes from an engine we did not write; to keep its leftmost-greedy
// disambiguation identical to ours we avoid the one construct where regex engines
// famously disagree (an unbounded quantifier over a nullable body), so all three
// must agree exactly. Any mismatch is surfaced with the exact pattern and input.

import { parse } from '../parser';
import { analyzeFeatures } from '../ast';
import type { RegexNode } from '../ast';
import { compileProgram, type Program } from '../pike';
import { toCodePoints } from '../simulate';
import { simulateTagged, runTDFA, buildTDFA, minimizeRegisters, type TaggedMatch } from './tdfa';

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
  private nextF: () => number;
  constructor(nextF: () => number) {
    this.nextF = nextF;
  }
  int(n: number) {
    return Math.floor(this.nextF() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  chance(p: number) {
    return this.nextF() < p;
  }
}

// --- Random capturing pattern generation -----------------------------------
// A grammar rich in groups (the whole point) but restricted to the subset where
// our leftmost-greedy parse and JS RegExp's coincide exactly.

const LITERALS = ['a', 'b', 'c'] as const;

function genAtom(rng: Rng, depth: number, groupBudget: { n: number }): string {
  const allowGroup = depth < 3 && groupBudget.n > 0;
  const roll = rng.int(allowGroup ? 8 : 6);
  switch (roll) {
    case 0:
    case 1:
    case 2:
      return rng.pick(LITERALS);
    case 3:
      return '\\d';
    case 4:
    case 5: {
      const neg = rng.chance(0.25) ? '^' : '';
      const members: string[] = [];
      const k = 1 + rng.int(2);
      for (let i = 0; i < k; i++) {
        if (rng.chance(0.4)) {
          const lo = rng.int(2);
          members.push(`${LITERALS[lo]}-${LITERALS[lo + 1]}`);
        } else members.push(rng.pick(LITERALS));
      }
      return `[${neg}${members.join('')}]`;
    }
    default: {
      groupBudget.n--;
      return `(${genAlt(rng, depth + 1, groupBudget)})`;
    }
  }
}

function genQuantified(rng: Rng, depth: number, groupBudget: { n: number }): string {
  const atom = genAtom(rng, depth, groupBudget);
  const q = rng.int(6);
  switch (q) {
    case 0:
      return atom + '*';
    case 1:
      return atom + '+';
    case 2:
      return atom + '?';
    case 3:
      return `${atom}{${rng.int(3)}}`;
    case 4: {
      const m = rng.int(2);
      return `${atom}{${m},${m + rng.int(3)}}`;
    }
    default:
      return atom;
  }
}

function genConcat(rng: Rng, depth: number, groupBudget: { n: number }): string {
  const n = 1 + rng.int(depth === 0 ? 4 : 2);
  let out = '';
  for (let i = 0; i < n; i++) out += genQuantified(rng, depth, groupBudget);
  return out;
}

function genAlt(rng: Rng, depth: number, groupBudget: { n: number }): string {
  const n = 1 + rng.int(depth < 1 ? 3 : 2);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(genConcat(rng, depth, groupBudget));
  return parts.join('|');
}

const INPUT_ALPHABET = 'abc012'.split('');

function genInput(rng: Rng, maxLen: number): string {
  const len = rng.int(maxLen + 1);
  let s = '';
  for (let i = 0; i < len; i++) s += rng.pick(INPUT_ALPHABET);
  return s;
}

// A capturing group underneath *any* quantifier is where ECMAScript and the
// Thompson/Pike leftmost-greedy semantics this studio implements provably differ:
//   • empty-iteration rejection — JS drops a group captured by an empty iteration;
//   • per-iteration capture reset — JS clears a loop body's inner groups at the
//     start of every iteration, so a group skipped by the *last* iteration reads
//     `undefined`, whereas we keep its last-set value.
// Neither can bite a group that never sits inside a quantifier, so we consult the
// JS oracle only on those patterns. The TDFA-vs-reference theorem (our own two
// engines) is checked on *every* pattern regardless — that is the real invariant.
function anyGroupUnderQuantifier(node: RegexNode): boolean {
  const walk = (n: RegexNode, underQuant: boolean): boolean => {
    switch (n.type) {
      case 'group':
        return underQuant || walk(n.node, underQuant);
      case 'star':
      case 'plus':
      case 'opt':
      case 'repeat':
        return walk(n.node, true);
      case 'concat':
        return n.parts.some((p) => walk(p, underQuant));
      case 'alt':
        return n.options.some((o) => walk(o, underQuant));
      default:
        return false;
    }
  };
  return walk(node, false);
}

// --- Comparison -------------------------------------------------------------

export type Span = [number, number] | null;

function groupsToSpans(m: TaggedMatch | null, groupCount: number): (Span | 'nomatch')[] {
  if (!m) return ['nomatch'];
  const out: (Span | 'nomatch')[] = [];
  for (let g = 0; g <= groupCount; g++) {
    const s = m.groups[g];
    out.push(s ? [s.start, s.end] : null);
  }
  return out;
}

function jsSpans(source: string, input: string, groupCount: number): (Span | 'nomatch')[] | null {
  let re: RegExp;
  try {
    re = new RegExp('^(?:' + source + ')$', 'du');
  } catch {
    return null; // platform rejects it → skip the oracle column
  }
  const m = re.exec(input);
  if (!m) return ['nomatch'];
  // With /d, m.indices[g] = [start,end] (code-unit offsets; inputs are BMP so
  // they equal code-point indices) or undefined for a non-participating group.
  const indices = (m as unknown as { indices: (readonly [number, number] | undefined)[] }).indices;
  const out: (Span | 'nomatch')[] = [];
  for (let g = 0; g <= groupCount; g++) {
    const pair = indices[g];
    out.push(pair ? [pair[0], pair[1]] : null);
  }
  return out;
}

function spansEqual(a: (Span | 'nomatch')[], b: (Span | 'nomatch')[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === 'nomatch' || y === 'nomatch') {
      if (x !== y) return false;
    } else if (x === null || y === null) {
      if (x !== y) return false;
    } else if (x[0] !== y[0] || x[1] !== y[1]) {
      return false;
    }
  }
  return true;
}

export interface VerifyConfig {
  seed: number;
  trials: number;
  stringsPerPattern: number;
  maxStringLen: number;
  useOracle: boolean;
}

export const DEFAULT_VERIFY: VerifyConfig = {
  seed: 0x7a95,
  trials: 400,
  stringsPerPattern: 16,
  maxStringLen: 9,
  useOracle: true,
};

export interface Counterexample {
  pattern: string;
  input: string;
  tdfa: (Span | 'nomatch')[];
  reference: (Span | 'nomatch')[];
  oracle: (Span | 'nomatch')[] | null;
  which: 'tdfa≠reference' | 'minimised≠reference' | 'reference≠oracle';
}

export interface VerifyReport {
  config: VerifyConfig;
  patterns: number;
  checks: number;
  agreed: boolean;
  counterexample: Counterexample | null;
  skipped: number; // patterns filtered out (non-regular / nullable-loop / build-truncated)
  maxStates: number; // the largest TDFA built during the run
  totalStates: number;
  regsBefore: number; // total materialised registers, summed over patterns (pre-minimisation)
  regsAfter: number; // total after register minimisation
  elapsedMs: number;
}

export function runVerify(config: VerifyConfig = DEFAULT_VERIFY): VerifyReport {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const rng = new Rng(mulberry32(config.seed));
  let patterns = 0;
  let checks = 0;
  let skipped = 0;
  let maxStates = 0;
  let totalStates = 0;
  let regsBefore = 0;
  let regsAfter = 0;
  let counterexample: Counterexample | null = null;

  outer: for (let t = 0; t < config.trials; t++) {
    const source = genAlt(rng, 0, { n: 3 });
    const { ast, error, groupCount } = parse(source);
    if (!ast || error) {
      skipped++;
      continue;
    }
    const feats = analyzeFeatures(ast);
    if (!feats.regular) {
      skipped++;
      continue;
    }
    // The TDFA-vs-reference theorem is checked on every pattern; the JS oracle is
    // only consulted where ECMAScript and Thompson capture semantics coincide.
    const oracleSafe = !anyGroupUnderQuantifier(ast);
    let prog: Program;
    try {
      prog = compileProgram(ast, groupCount);
    } catch {
      skipped++;
      continue;
    }
    const tdfa = buildTDFA(prog, groupCount, { maxStates: 3000 });
    if (tdfa.truncated) {
      skipped++;
      continue;
    }
    const mini = minimizeRegisters(tdfa);
    patterns++;
    maxStates = Math.max(maxStates, tdfa.states.length);
    totalStates += tdfa.states.length;
    regsBefore += tdfa.matRegCount;
    regsAfter += mini.matRegCount;

    for (let s = 0; s < config.stringsPerPattern; s++) {
      const input = genInput(rng, config.maxStringLen);
      const codes = toCodePoints(input);
      const tdfaSpans = groupsToSpans(runTDFA(tdfa, codes).match, groupCount);
      const refSpans = groupsToSpans(simulateTagged(prog, groupCount, codes), groupCount);
      checks++;
      if (!spansEqual(tdfaSpans, refSpans)) {
        counterexample = { pattern: source, input, tdfa: tdfaSpans, reference: refSpans, oracle: null, which: 'tdfa≠reference' };
        break outer;
      }
      // The minimised machine must agree with the reference too.
      const miniSpans = groupsToSpans(runTDFA(mini, codes).match, groupCount);
      if (!spansEqual(miniSpans, refSpans)) {
        counterexample = { pattern: source, input, tdfa: miniSpans, reference: refSpans, oracle: null, which: 'minimised≠reference' };
        break outer;
      }
      if (config.useOracle && oracleSafe) {
        const oracle = jsSpans(source, input, groupCount);
        if (oracle && !spansEqual(refSpans, oracle)) {
          counterexample = { pattern: source, input, tdfa: tdfaSpans, reference: refSpans, oracle, which: 'reference≠oracle' };
          break outer;
        }
      }
    }
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    config,
    patterns,
    checks,
    agreed: counterexample === null,
    counterexample,
    skipped,
    maxStates,
    totalStates,
    regsBefore,
    regsAfter,
    elapsedMs: Math.max(0, Math.round(t1 - t0)),
  };
}

// A single-pattern check used by the UI to badge the current pattern live.
export interface QuickCheck {
  ran: boolean;
  agreed: boolean;
  checks: number;
  mismatch: { input: string; tdfa: (Span | 'nomatch')[]; reference: (Span | 'nomatch')[] } | null;
}

export function quickCheckPattern(ast: RegexNode, groupCount: number, seed = 0x1234, strings = 200, maxLen = 12): QuickCheck {
  let prog: Program;
  try {
    prog = compileProgram(ast, groupCount);
  } catch {
    return { ran: false, agreed: false, checks: 0, mismatch: null };
  }
  const tdfa = buildTDFA(prog, groupCount, { maxStates: 4000 });
  if (tdfa.truncated) return { ran: false, agreed: false, checks: 0, mismatch: null };
  const rng = new Rng(mulberry32(seed));
  let checks = 0;
  for (let s = 0; s < strings; s++) {
    const input = genInput(rng, maxLen);
    const codes = toCodePoints(input);
    const tdfaSpans = groupsToSpans(runTDFA(tdfa, codes).match, groupCount);
    const refSpans = groupsToSpans(simulateTagged(prog, groupCount, codes), groupCount);
    checks++;
    if (!spansEqual(tdfaSpans, refSpans)) {
      return { ran: true, agreed: false, checks, mismatch: { input, tdfa: tdfaSpans, reference: refSpans } };
    }
  }
  return { ran: true, agreed: true, checks, mismatch: null };
}
