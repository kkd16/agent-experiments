// The Tendermint safety properties, checked live across the cluster on every
// render. As with every BFT lab here, invariants are evaluated over the
// **honest** validators only — a Byzantine validator's state is untrustworthy by
// definition. Tendermint's theorem: the honest validators stay consistent as
// long as at most f = ⌊(N-1)/3⌋ validators are faulty, under *any* network
// behaviour (safety holds even under full asynchrony). These checks are the live
// evidence.
import type { InvariantResult, NodeView } from '../../sim/types';
import { faultBudget, quorum, opStr, GENESIS_HASH, NIL, type TendermintState, type Command } from './types';

export function tendermintInvariants(nodes: ReadonlyArray<NodeView<TendermintState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const Ntot = nodes.length;
  const f = faultBudget(Ntot);
  const q = quorum(Ntot);

  const honest = nodes.filter((n) => n.state.fault === 'honest');
  const faulty = nodes.filter((n) => n.state.fault !== 'honest');

  // 0. FAULT BUDGET — the precondition for every other property. Tendermint
  //    tolerates up to f Byzantine validators out of N = 3f+1; beyond that,
  //    agreement is *allowed* to break. This is the boundary of the theorem.
  results.push({
    name: `Fault budget (≤ f = ${f})`,
    ok: faulty.length <= f,
    detail:
      faulty.length <= f
        ? `${faulty.length}/${Ntot} validators Byzantine — within the f=${f} the cluster tolerates`
        : `${faulty.length}/${Ntot} validators Byzantine — EXCEEDS f=${f}; safety is no longer guaranteed`,
  });

  // 1. AGREEMENT (the headline). No two honest validators decide different
  //    blocks at the same height. This must hold even while a Byzantine proposer
  //    equivocates across rounds, as long as faulty ≤ f — the whole point of the
  //    locking rule + 2f+1 quorum intersection.
  {
    let bad = '';
    const byHeight = new Map<number, { hash: string; node: string }>();
    outer: for (const n of honest) {
      for (const e of n.state.committed) {
        const prev = byHeight.get(e.height);
        if (!prev) byHeight.set(e.height, { hash: e.hash, node: n.id });
        else if (prev.hash !== e.hash) {
          bad = `height ${e.height}: ${prev.node} decided ${prev.hash.slice(0, 16)}… but ${n.id} decided ${e.hash.slice(0, 16)}…`;
          break outer;
        }
      }
    }
    results.push({
      name: 'Agreement (honest validators)',
      ok: !bad,
      detail: bad ? `two honest validators decided conflicting blocks — ${bad}` : 'every honest validator decided the same block at every height',
    });
  }

  // 2. DECIDED-CHAIN INTEGRITY — each honest validator's decided log is a
  //    gap-free run 1…decidedHeight of real blocks it holds, and its execution
  //    watermark matches. The internal consistency of the replicated log.
  {
    let bad = '';
    for (const n of honest) {
      const s = n.state;
      const sorted = [...s.committed].sort((a, b) => a.height - b.height);
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i];
        if (i > 0 && e.height !== sorted[i - 1].height + 1 && sorted[i - 1].height !== e.height) {
          bad = `${n.id}: a hole between decided heights ${sorted[i - 1].height} and ${e.height}`;
          break;
        }
        if (e.height > 0 && e.hash === GENESIS_HASH) {
          bad = `${n.id}: genesis appears above height 0`;
          break;
        }
      }
      if (bad) break;
      if (sorted.length && sorted[sorted.length - 1].height !== s.decidedHeight) {
        bad = `${n.id}: decided watermark #${s.decidedHeight} disagrees with its log tail #${sorted[sorted.length - 1].height}`;
        break;
      }
    }
    results.push({
      name: 'Decided-chain integrity',
      ok: !bad,
      detail: bad ? bad : 'every honest validator decided a single gap-free chain matching its watermark',
    });
  }

  // 3. STATE-MACHINE SAFETY — each honest validator's KV store equals exactly its
  //    decided commands replayed in order. Proves execution faithfully reflects
  //    the agreed log (no skipped, duplicated or reordered effects).
  {
    let bad = '';
    for (const n of honest) {
      const s = n.state;
      const replay: Record<string, string> = {};
      const sorted = [...s.committed].sort((a, b) => a.height - b.height);
      for (const e of sorted) {
        const o: Command['op'] = e.cmd.op;
        if (o.op === 'set') replay[o.key] = o.value;
        else if (o.op === 'del') delete replay[o.key];
      }
      if (JSON.stringify(replay) !== JSON.stringify(s.kv)) {
        bad = `${n.id}: KV store does not match its decided log replayed in order`;
        break;
      }
    }
    results.push({
      name: 'State-machine safety',
      ok: !bad,
      detail: bad ? bad : 'every honest validator’s KV = its decided commands replayed in order',
    });
  }

  // 4. LOCK SAFETY — no honest validator is locked on a value that CONFLICTS with
  //    a block already decided at that height by the honest set. The lock is what
  //    stops a later round from deciding differently; if a validator ever locked
  //    against the decided value, the safety argument would be broken. (A lock at
  //    a height not yet decided is fine — that is the lock doing its job.)
  {
    let bad = '';
    const decidedAt = new Map<number, string>();
    for (const n of honest) for (const e of n.state.committed) if (!decidedAt.has(e.height)) decidedAt.set(e.height, e.hash);
    for (const n of honest) {
      const lv = n.state.lockedValue;
      if (!lv) continue;
      const dec = decidedAt.get(lv.height);
      if (dec && dec !== lv.hash) {
        bad = `${n.id}: locked ${lv.hash.slice(0, 14)}… at height ${lv.height}, but the decided block there is ${dec.slice(0, 14)}…`;
        break;
      }
    }
    results.push({
      name: 'Lock safety',
      ok: !bad,
      detail: bad ? bad : 'no honest validator holds a lock conflicting with a decided block at its height',
    });
  }

  // 5. NO CONFLICTING POLKA IN A ROUND — a direct check of quorum intersection:
  //    within one (height, round) at most one value can hold a 2f+1 prevote Polka
  //    across the honest tallies. Two Polkas for different non-nil values in the
  //    same round would be a fork in the making; it cannot happen while faulty ≤ f.
  {
    let bad = '';
    outer: for (const n of honest) {
      const s = n.state;
      for (const rk of Object.keys(s.prevotes)) {
        const byId = s.prevotes[Number(rk)];
        const polkas = Object.keys(byId).filter((id) => id !== NIL && Object.keys(byId[id]).length >= q);
        if (polkas.length > 1) {
          bad = `${n.id}: round ${rk} shows Polkas for ${polkas.length} distinct values`;
          break outer;
        }
      }
    }
    results.push({
      name: 'No conflicting Polka in a round',
      ok: !bad,
      detail: bad ? bad : 'at most one value ever reaches a 2f+1 prevote Polka in any single round',
    });
  }

  // A friendly liveness note (informational, not a safety invariant).
  if (honest.length > 0) {
    const live = honest.filter((n) => n.up);
    if (live.length) {
      const heights = live.map((n) => n.state.decidedHeight);
      const maxH = Math.max(...heights);
      const caughtUp = live.filter((n) => n.state.decidedHeight === maxH).length;
      const lead = live.reduce((a, b) => (a.state.decidedHeight >= b.state.decidedHeight ? a : b));
      const lastReal = [...lead.state.committed].reverse().find((e) => e.cmd.op.op !== 'noop');
      const maxRound = Math.max(0, ...live.map((n) => n.state.round));
      results.push({
        name: 'Progress',
        ok: true,
        detail:
          maxH === 0
            ? 'nothing decided yet — send a client request'
            : `${caughtUp}/${live.length} live honest validators at height #${maxH}` +
              (maxRound > 0 ? ` (round ${maxRound})` : '') +
              (lastReal ? ` — last: ${opStr(lastReal.cmd)}` : ''),
      });
    }
  }

  return results;
}
