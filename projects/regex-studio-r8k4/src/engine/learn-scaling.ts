// A scaling study: watch the learners' query cost grow along a family of
// languages whose minimal DFA doubles at every step.
//
// The family is L_k = "(a|b)* a (a|b)^k" — the words whose (k+1)-th symbol from
// the *end* is an `a`. Its minimal DFA has exactly 2^(k+1) states (the classic
// witness that a DFA must remember the last k+1 symbols), so k = 1,2,3,… gives
// targets of 4, 8, 16, 32, … states — an exponential x-axis on which the three
// active learners' costs separate.
//
// The point of the chart is the *tradeoff*, honestly: this studio's teacher
// answers an equivalence query with the SHORTEST distinguishing counterexample
// (compareDFAs), which is the worst case for Rivest–Schapire's binary search —
// so here classic L* and RS spend almost the same membership queries, while
// Kearns–Vazirani makes ONE equivalence query per state (2^(k+1) of them,
// re-sifting each round) and so spends a little *more* membership than the
// tables. That is the opposite of KV's behaviour on typical/random languages
// (where its tree is far cheaper — see the aggregate table in the cross-check),
// and it is the whole lesson: there is no universally-cheapest learner. What is
// cheap depends on the language and on whether membership or equivalence queries
// are the expensive resource.

import { compile } from './compile';
import { learnLStar } from './learn';
import { learnKV } from './learn-kv';

export interface ScalePoint {
  k: number;
  pattern: string;
  targetStates: number; // states of the minimal DFA (2^(k+1))
  classicMem: number;
  rsMem: number;
  kvMem: number;
  classicEq: number;
  rsEq: number;
  kvEq: number;
}

export interface ScaleStudy {
  family: string;
  points: ScalePoint[];
  ok: boolean; // every point learned correctly (all three ≡ target, minimal)
}

const DEFAULT_MAX_STATES = 96; // keep the biggest target inside the learners' cap

export function runScalingStudy(maxStates: number = DEFAULT_MAX_STATES): ScaleStudy {
  const points: ScalePoint[] = [];
  let ok = true;
  for (let k = 1; k <= 10; k++) {
    const pattern = `(a|b)*a(a|b){${k}}`;
    const compiled = compile(pattern);
    if (!compiled.minDfa) break;
    const target = compiled.minDfa;
    if (target.states.length > maxStates) break;

    const cl = learnLStar(target, { ceHandling: 'prefixes' });
    const rs = learnLStar(target, { ceHandling: 'rivest-schapire' });
    const kv = learnKV(target);
    if (cl.aborted || rs.aborted || kv.aborted) break;
    // Every point must still be a *correct* recovery — the chart is only
    // meaningful if all three learned the exact minimal DFA.
    if (!(cl.minimal && rs.minimal && kv.minimal)) ok = false;

    points.push({
      k,
      pattern,
      targetStates: target.states.length,
      classicMem: cl.membershipQueries,
      rsMem: rs.membershipQueries,
      kvMem: kv.membershipQueries,
      classicEq: cl.equivalenceQueries,
      rsEq: rs.equivalenceQueries,
      kvEq: kv.equivalenceQueries,
    });
  }
  return {
    family: '(a|b)*·a·(a|b)^k — "the (k+1)-th symbol from the end is a", minimal DFA = 2^(k+1) states',
    points,
    ok,
  };
}
