// The HotStuff safety properties, checked live across the cluster on every render.
//
// As in PBFT, invariants are evaluated over the **honest** replicas only — a
// Byzantine replica's state is untrustworthy by definition. The theorem HotStuff
// proves is that the honest replicas stay consistent as long as at most
// f = ⌊(N-1)/3⌋ replicas are faulty; these checks are the live evidence.
import type { InvariantResult, NodeView } from '../../sim/types';
import { faultBudget, opStr, type HsState, type Command } from './types';

export function hotstuffInvariants(nodes: ReadonlyArray<NodeView<HsState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const Ntot = nodes.length;
  const f = faultBudget(Ntot);

  const honest = nodes.filter((n) => n.state.fault === 'honest');
  const faulty = nodes.filter((n) => n.state.fault !== 'honest');

  // 0. FAULT BUDGET — the precondition for every other property. HotStuff
  //    tolerates up to f Byzantine replicas; beyond that, agreement is *allowed*
  //    to break. This is the boundary of the theorem.
  results.push({
    name: `Fault budget (≤ f = ${f})`,
    ok: faulty.length <= f,
    detail:
      faulty.length <= f
        ? `${faulty.length}/${Ntot} replicas Byzantine — within the f=${f} the cluster tolerates`
        : `${faulty.length}/${Ntot} replicas Byzantine — EXCEEDS f=${f}; safety is no longer guaranteed`,
  });

  // 1. AGREEMENT — the headline. No two honest replicas commit different blocks
  //    at the same height. It must hold even while a Byzantine leader actively
  //    equivocates, as long as faulty ≤ f (quorum intersection: two 2f+1 vote
  //    sets share an honest replica, which votes at most once per height).
  {
    let bad = '';
    const byHeight = new Map<number, { hash: string; node: string }>();
    for (const n of honest) {
      for (const e of n.state.committed) {
        const prev = byHeight.get(e.height);
        if (!prev) byHeight.set(e.height, { hash: e.hash, node: n.id });
        else if (prev.hash !== e.hash) {
          bad = `height ${e.height}: ${prev.node} committed ${prev.hash.slice(0, 14)}… but ${n.id} committed ${e.hash.slice(0, 14)}…`;
          break;
        }
      }
      if (bad) break;
    }
    results.push({
      name: 'Agreement (honest replicas)',
      ok: !bad,
      detail: bad ? `two honest replicas forked — ${bad}` : 'every honest replica commits the same block at every height',
    });
  }

  // 2. CHAIN INTEGRITY — each honest replica's committed log is a gap-free run
  //    1…bExecHeight whose blocks link parent→child into a single chain, and its
  //    execution tip matches. Internal consistency of the replicated log.
  {
    let bad = '';
    for (const n of honest) {
      const s = n.state;
      const sorted = [...s.committed].sort((a, b) => a.height - b.height);
      let prevHash = '';
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i];
        if (i > 0 && e.height !== sorted[i - 1].height + 1) {
          bad = `${n.id}: a hole between committed heights ${sorted[i - 1].height} and ${e.height}`;
          break;
        }
        const blk = s.blocks[e.hash];
        if (blk && prevHash && blk.parent !== prevHash) {
          bad = `${n.id}: committed block at height ${e.height} does not link to its predecessor`;
          break;
        }
        prevHash = e.hash;
      }
      if (bad) break;
      const last = sorted[sorted.length - 1];
      if (last && last.height === s.bExecHeight && last.hash !== s.bExecHash) {
        bad = `${n.id}: execution tip (#${s.bExecHeight}) disagrees with the last committed block`;
        break;
      }
    }
    results.push({
      name: 'Chain integrity',
      ok: !bad,
      detail: bad ? bad : 'every honest replica committed a single gap-free, parent-linked chain',
    });
  }

  // 3. STATE-MACHINE SAFETY — each honest replica's KV store equals exactly its
  //    committed commands replayed in order. Proves execution faithfully reflects
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
        bad = `${n.id}: KV store does not match its committed log replayed in order`;
        break;
      }
    }
    results.push({
      name: 'State-machine safety',
      ok: !bad,
      detail: bad ? bad : 'every honest replica’s KV = its committed commands replayed in order',
    });
  }

  // A friendly liveness note (informational, not a safety invariant).
  if (honest.length > 0) {
    const live = honest.filter((n) => n.up);
    const execs = live.map((n) => n.state.bExecHeight);
    const maxExec = execs.length ? Math.max(...execs) : 0;
    const caughtUp = live.filter((n) => n.state.bExecHeight === maxExec).length;
    const lead = honest.reduce((a, b) => (a.state.bExecHeight >= b.state.bExecHeight ? a : b));
    const lastReal = [...lead.state.committed].reverse().find((e) => e.cmd.op.op !== 'noop');
    results.push({
      name: 'Progress',
      ok: true,
      detail:
        maxExec === 0
          ? 'no blocks committed yet'
          : `${caughtUp}/${live.length} live honest replicas at #${maxExec}` + (lastReal ? ` — last: ${opStr(lastReal.cmd)}` : ''),
    });
  }

  return results;
}
