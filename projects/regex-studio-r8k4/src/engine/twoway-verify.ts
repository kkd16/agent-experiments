// The proof console for the two-way road — the house style. A seeded fuzzer
// draws random two-way DFAs and confronts Shepherdson's `construct` with the
// trivially-correct `simulate` oracle three independent ways:
//
//  1. DIFFERENTIAL — for each random machine M and each random word w, the
//     constructed one-way DFA must accept w iff the real two-way head accepts w.
//     The oracle is unimpeachable: it just runs M with exact loop detection, so
//     any disagreement is a genuine bug in the construction.
//  2. GALLERY — every curated machine is checked EXHAUSTIVELY over all words up
//     to a horizon (the constructed DFA vs the oracle on the entire ball), so the
//     teaching examples are certified, not merely spot-checked.
//  3. ROUND TRIP — lift the constructed DFA back to a right-only 2DFA and
//     reconstruct; `compareDFAs` must report `equal`. That closes the loop:
//     2DFA → DFA → 2DFA → DFA returns the same language, both halves of the
//     Rabin–Scott equivalence on one machine.
//
// Reproducible by seed; the first counterexample is surfaced verbatim.

import { compareDFAs } from './equivalence';
import { GALLERY, construct, liftDFA, simulate, type Move, type TwoWayDFA, LEND, REND } from './twoway';

// A small, fast PRNG (mulberry32) — matches the house style used elsewhere.
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

function randInt(rnd: () => number, n: number): number {
  return Math.floor(rnd() * n);
}

/** A random well-defined two-way DFA. `nReal` proper states plus accept/reject;
 *  every proper state gets a total transition on each tape symbol, with a slight
 *  bias toward Right and toward halting so a healthy fraction of machines have a
 *  non-trivial language. */
function randomMachine(rnd: () => number, nReal: number, alphabet: string[]): TwoWayDFA {
  const states: string[] = [];
  for (let i = 0; i < nReal; i++) states.push(`q${i}`);
  const acc = states.length;
  states.push('acc');
  const rej = states.length;
  states.push('rej');

  const syms = [LEND, ...alphabet, REND];
  const delta: Map<string, Move>[] = states.map(() => new Map());

  const randTarget = (): number => {
    const r = rnd();
    if (r < 0.12) return acc;
    if (r < 0.22) return rej;
    return randInt(rnd, nReal);
  };

  for (let q = 0; q < nReal; q++) {
    for (const sym of syms) {
      let to = randTarget();
      let dir = rnd() < 0.62 ? 'R' : 'L';
      // Keep machines well-formed: Right on ⊢, never Right off ⊣.
      if (sym === LEND) dir = 'R';
      if (sym === REND && dir === 'R') {
        // turn it into a decisive halt rather than running off the right
        to = rnd() < 0.5 ? acc : rej;
        dir = 'L';
      }
      delta[q].set(sym, { to, dir: dir as Move['dir'] });
    }
  }
  return { name: 'random', states, start: 0, accept: acc, reject: rej, alphabet, delta };
}

/** Accept/reject by walking the constructed one-way DFA's transition table. */
function dfaAccepts(dfa: import('./dfa').DFA, word: string): boolean {
  let s = dfa.start;
  for (const ch of word) {
    const code = ch.codePointAt(0)!;
    const a = dfa.atoms.findIndex((at) => code >= at.lo && code <= at.hi);
    if (a < 0) return false; // off-alphabet ⇒ dead
    s = dfa.table[s][a];
    if (s < 0) return false;
  }
  return dfa.states[s].accept;
}

function randomWord(rnd: () => number, alphabet: string[], maxLen: number): string {
  const len = randInt(rnd, maxLen + 1);
  let w = '';
  for (let i = 0; i < len; i++) w += alphabet[randInt(rnd, alphabet.length)];
  return w;
}

function* allWords(alphabet: string[], maxLen: number): Generator<string> {
  let frontier = [''];
  yield '';
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = [];
    for (const w of frontier) for (const c of alphabet) next.push(w + c);
    for (const w of next) yield w;
    frontier = next;
  }
}

export interface TwoWayFuzzConfig {
  seed: number;
  trials: number; // random machines
  nReal: number; // proper states per random machine
  alphabet: string[];
  wordsPerMachine: number;
  maxWordLen: number;
  galleryHorizon: number; // exhaustive word length for the gallery
  maxDfaStates: number; // skip machines whose construction blows past this
}

export const DEFAULT_TWOWAY_FUZZ: TwoWayFuzzConfig = {
  seed: 1,
  trials: 300,
  nReal: 4,
  alphabet: ['a', 'b'],
  wordsPerMachine: 40,
  maxWordLen: 7,
  galleryHorizon: 9,
  maxDfaStates: 4000,
};

export interface TwoWayFuzzReport {
  ok: boolean;
  trials: number;
  differentialChecks: number;
  galleryChecks: number;
  roundTripChecks: number;
  skipped: number;
  elapsedMs: number;
  failure:
    | null
    | { kind: 'differential' | 'gallery' | 'roundtrip'; machine: string; detail: string };
}

export function runTwoWayFuzz(config: TwoWayFuzzConfig = DEFAULT_TWOWAY_FUZZ): TwoWayFuzzReport {
  const start = performance.now();
  const rnd = mulberry32(config.seed * 2654435761 + 12345);
  let differentialChecks = 0;
  let galleryChecks = 0;
  let roundTripChecks = 0;
  let skipped = 0;

  const finish = (failure: TwoWayFuzzReport['failure']): TwoWayFuzzReport => ({
    ok: failure === null,
    trials: config.trials,
    differentialChecks,
    galleryChecks,
    roundTripChecks,
    skipped,
    elapsedMs: performance.now() - start,
    failure,
  });

  // 1 + 3 — random machines: differential + round-trip.
  for (let t = 0; t < config.trials; t++) {
    const M = randomMachine(rnd, config.nReal, config.alphabet);
    const built = construct(M, config.maxDfaStates);
    if (built.truncated) {
      skipped++;
      continue;
    }
    for (let j = 0; j < config.wordsPerMachine; j++) {
      const w = randomWord(rnd, config.alphabet, config.maxWordLen);
      const oracle = simulate(M, w).accept;
      const got = dfaAccepts(built.dfa, w);
      differentialChecks++;
      if (oracle !== got) {
        return finish({
          kind: 'differential',
          machine: `random#${t}`,
          detail: `word "${w || 'ε'}" — oracle ${oracle}, constructed DFA ${got}`,
        });
      }
    }

    // round trip: DFA → right-only 2DFA → DFA must be equal
    const M2 = liftDFA(built.dfa);
    const D2 = construct(M2, config.maxDfaStates);
    roundTripChecks++;
    if (!D2.truncated) {
      const rel = compareDFAs(built.dfa, D2.dfa).relation;
      if (rel !== 'equal') {
        return finish({
          kind: 'roundtrip',
          machine: `random#${t}`,
          detail: `2DFA→DFA→2DFA→DFA relation is "${rel}", expected "equal"`,
        });
      }
    }
  }

  // 2 — gallery exhaustive.
  for (const entry of GALLERY) {
    const M = entry.machine;
    const built = construct(M, config.maxDfaStates);
    for (const w of allWords(config.alphabet, config.galleryHorizon)) {
      const oracle = simulate(M, w).accept;
      const got = dfaAccepts(built.dfa, w);
      galleryChecks++;
      if (oracle !== got) {
        return finish({
          kind: 'gallery',
          machine: M.name,
          detail: `word "${w || 'ε'}" — oracle ${oracle}, constructed DFA ${got}`,
        });
      }
    }
  }

  return finish(null);
}
