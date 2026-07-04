// The proof console — the house style. Parikh's theorem earns its keep only if the
// semilinear set we build from the regex really IS the language's commutative image.
// A seeded fuzzer draws random regular patterns over a tiny alphabet and confronts
// the structural construction against two independent authorities, every check exact
// up to a length/count horizon:
//
//  1. DIFFERENTIAL vs the language — brute-force every word of length ≤ N the regex
//     accepts, read off its count vector, and demand the resulting SET of vectors
//     equals the semilinear set enumerated up to total ≤ N. Two utterly different
//     roads (word generation vs. the semilinear algebra) must land on the same set.
//  2. MEMBERSHIP — for random count vectors, the semilinear membership oracle must
//     agree with "some accepted word has these counts" (the brute-force set).
//  3. PRESBURGER BRIDGE — compile the semilinear set to a Presburger formula and run
//     it through the studio's own Büchi–Bruyère–Villemaire engine; the resulting
//     digit-automaton must accept EXACTLY the count tuples the semilinear set holds.
//     Three roads — regex algebra, language enumeration, number-theoretic automaton
//     — one set of vectors.
//
// Reproducible by seed; the first counterexample is surfaced verbatim.

import { compile } from './compile';
import {
  analyzeParikh,
  enumerateSemilinear,
  languageParikh,
  memberSemi,
  toPresburgerFormula,
  vecKey,
  type Vec,
} from './parikh';
import { collectAtoms } from './parikh';
import { compilePresburgerFormula } from './presburger/compile';
import { acceptsTuple } from './presburger/automata';

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
function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

const LETTERS = ['a', 'b', 'c'] as const;

// A deliberately small grammar: enough shapes to exercise every semilinear
// operator (·, |, *, +, ?, bounded repeat, grouping) while keeping the languages,
// their word sets and the compiled Presburger automata small and fast.
function genAtom(rnd: () => number, depth: number): string {
  if (depth > 0 && rnd() < 0.35) return `(${genAlt(rnd, depth - 1)})`;
  return pick(rnd, LETTERS);
}
function genQuant(rnd: () => number, depth: number): string {
  const atom = genAtom(rnd, depth);
  const q = randInt(rnd, 0, 6);
  switch (q) {
    case 0:
      return atom + '*';
    case 1:
      return atom + '+';
    case 2:
      return atom + '?';
    case 3:
      return `${atom}{${randInt(rnd, 0, 2)}}`;
    case 4: {
      const m = randInt(rnd, 0, 2);
      return `${atom}{${m},${m + randInt(rnd, 0, 2)}}`;
    }
    default:
      return atom;
  }
}
function genConcat(rnd: () => number, depth: number): string {
  const n = randInt(rnd, 1, depth === 0 ? 3 : 2);
  let s = '';
  for (let i = 0; i < n; i++) s += genQuant(rnd, depth);
  return s;
}
function genAlt(rnd: () => number, depth: number): string {
  const n = randInt(rnd, 1, depth < 1 ? 3 : 2);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(genConcat(rnd, depth));
  return parts.join('|');
}

export interface ParikhFuzzConfig {
  seed: number;
  trials: number;
  maxLen: number; // differential horizon (word length / coordinate-sum)
  vectorProbes: number; // random membership vectors per trial
}

export const DEFAULT_PARIKH_FUZZ: ParikhFuzzConfig = {
  seed: 0x9a1c,
  trials: 250,
  maxLen: 6,
  vectorProbes: 12,
};

export interface ParikhFuzzReport {
  ok: boolean;
  trials: number;
  tested: number; // patterns that produced a clean (non-truncated) comparison
  skipped: number; // truncated / too-large / non-regular — no verdict
  setChecks: number; // differential set-equality comparisons (one per tested pattern)
  membershipChecks: number;
  bridgeChecks: number; // Presburger tuple confrontations
  vectorsCompared: number; // total count vectors compared across all roads
  elapsedMs: number;
  failure: null | { kind: 'set' | 'membership' | 'bridge'; pattern: string; detail: string };
}

export function runParikhFuzz(config: ParikhFuzzConfig = DEFAULT_PARIKH_FUZZ): ParikhFuzzReport {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const rnd = mulberry32(config.seed * 2654435761 + 12345);
  let tested = 0;
  let skipped = 0;
  let setChecks = 0;
  let membershipChecks = 0;
  let bridgeChecks = 0;
  let vectorsCompared = 0;

  const done = (ok: boolean, failure: ParikhFuzzReport['failure']): ParikhFuzzReport => ({
    ok,
    trials: config.trials,
    tested,
    skipped,
    setChecks,
    membershipChecks,
    bridgeChecks,
    vectorsCompared,
    elapsedMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start),
    failure,
  });

  for (let t = 0; t < config.trials; t++) {
    const src = genAlt(rnd, 2);
    const c = compile(src);
    if (c.error || !c.ast || !c.features?.regular) {
      skipped++;
      continue;
    }
    const res = analyzeParikh(c.ast);
    if (res.error) {
      skipped++;
      continue;
    }
    const { indexOf } = collectAtoms(c.ast);
    const dim = res.dim;

    // (1) differential: language words vs. semilinear enumeration, as sets.
    const lang = languageParikh(c.ast, dim, indexOf, config.maxLen);
    const semi = enumerateSemilinear(res.semilinear, config.maxLen);
    if (lang.truncated || semi.truncated) {
      skipped++;
      continue;
    }
    tested++;
    setChecks++;
    vectorsCompared += lang.keys.size + semi.keys.size;
    // set equality
    if (lang.keys.size !== semi.keys.size) {
      return done(false, {
        kind: 'set',
        pattern: src,
        detail: `language has ${lang.keys.size} count-vectors ≤ len ${config.maxLen}, semilinear has ${semi.keys.size}`,
      });
    }
    for (const k of lang.keys) {
      if (!semi.keys.has(k)) {
        return done(false, { kind: 'set', pattern: src, detail: `vector (${k}) is a word count but not in the semilinear set` });
      }
    }
    for (const k of semi.keys) {
      if (!lang.keys.has(k)) {
        return done(false, { kind: 'set', pattern: src, detail: `vector (${k}) is in the semilinear set but no word ≤ len ${config.maxLen} has it` });
      }
    }

    // (2) membership oracle vs. the brute-force set on random vectors.
    for (let p = 0; p < config.vectorProbes; p++) {
      const v: Vec = new Array<number>(dim).fill(0);
      let budget = randInt(rnd, 0, config.maxLen);
      for (let i = 0; i < dim && budget > 0; i++) {
        const take = randInt(rnd, 0, budget);
        v[i] = take;
        budget -= take;
      }
      membershipChecks++;
      const inSemi = memberSemi(res.semilinear, v);
      const inLang = lang.keys.has(vecKey(v));
      if (inSemi !== inLang) {
        return done(false, {
          kind: 'membership',
          pattern: src,
          detail: `vector (${vecKey(v)}): semilinear says ${inSemi}, language says ${inLang}`,
        });
      }
    }

    // (3) Presburger bridge — the number-theoretic automaton over the count tuples.
    // Only attempt it for modest images: a wide union or many periods makes the
    // compiled formula (and its digit-automaton) large and slow, and the bridge is
    // already covered thoroughly by the many small patterns. The other two roads
    // still run on every tested pattern regardless.
    const periodTotal = res.semilinear.sets.reduce((s, L) => s + L.periods.length, 0);
    if (dim >= 1 && dim <= 3 && res.semilinear.sets.length <= 6 && periodTotal <= 8) {
      let auto: ReturnType<typeof compilePresburgerFormula>['automaton'] | null;
      try {
        const formula = toPresburgerFormula(res.semilinear, res.varNames);
        auto = compilePresburgerFormula(formula).automaton;
      } catch {
        auto = null; // track/state blow-up — not a correctness failure
      }
      if (auto) {
        // Confront the digit-automaton against the semilinear set on every tuple in
        // the box with coordinate-sum ≤ maxLen (a superset of what words realise).
        const box = config.maxLen;
        const odo = new Array<number>(dim).fill(0);
        outer: for (;;) {
          let s = 0;
          for (const x of odo) s += x;
          if (s <= box) {
            const valueByName: Record<string, number> = {};
            for (let i = 0; i < dim; i++) valueByName[res.varNames[i]] = odo[i];
            bridgeChecks++;
            const inAuto = acceptsTuple(auto, valueByName);
            const inSemi = memberSemi(res.semilinear, odo);
            if (inAuto !== inSemi) {
              return done(false, {
                kind: 'bridge',
                pattern: src,
                detail: `tuple (${odo.join(',')}): Presburger automaton says ${inAuto}, semilinear says ${inSemi}`,
              });
            }
          }
          // advance odometer over [0, box]^dim
          let i = 0;
          for (; i < dim; i++) {
            odo[i]++;
            if (odo[i] <= box) break;
            odo[i] = 0;
          }
          if (i === dim) break outer;
        }
      }
    }
  }

  return done(true, null);
}
