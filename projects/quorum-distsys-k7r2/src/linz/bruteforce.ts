// An independent, deliberately naive reference checker — the oracle the fast
// Wing & Gong checker is differentially tested against.
//
// It is the *definition* of linearizability executed literally: enumerate every
// linear extension of the real-time partial order, and accept iff at least one of
// them is a legal run of the sequential spec. No memoization, no interleaved
// pruning, no object partitioning — a different code path on purpose, so a bug
// shared with the optimized checker is vanishingly unlikely. Exponential, hence
// only used on small histories in the test suite.
import { eqValue, precedes, type History, type Op } from './history';
import type { Spec } from './specs';

class TooLarge extends Error {}

/** Decide linearizability of a *complete* single-object history by brute force. */
export function bruteForceLinearizable(
  history: History,
  spec: Spec<unknown>,
  cap = 3_000_000,
): boolean {
  const ops = history.ops;
  const n = ops.length;
  if (n === 0) return true;

  const preds: number[][] = ops.map((oi, i) => {
    const ps: number[] = [];
    for (let j = 0; j < n; j++) if (j !== i && precedes(ops[j], oi)) ps.push(j);
    return ps;
  });

  const placed = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  let extensions = 0;
  let found = false;

  const legal = (ord: number[]): boolean => {
    let state = spec.init();
    for (const i of ord) {
      const o = ops[i];
      const r = spec.apply(state, o.f, o.arg);
      if (!eqValue(r.out, o.res ?? null)) return false;
      state = r.state;
    }
    return true;
  };

  const rec = (): void => {
    if (found) return;
    if (order.length === n) {
      if (++extensions > cap) throw new TooLarge();
      if (legal(order)) found = true;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      let ready = true;
      for (const j of preds[i]) {
        if (!placed[j]) {
          ready = false;
          break;
        }
      }
      if (!ready) continue;
      placed[i] = true;
      order.push(i);
      rec();
      order.pop();
      placed[i] = false;
      if (found) return;
    }
  };

  rec();
  return found;
}

/** True when a history is small enough to brute-force without blowing up. */
export function bruteForceFeasible(ops: Op[]): boolean {
  return ops.length <= 9;
}
