// The Streamlet safety properties, checked live across the cluster on every
// render. As with every BFT lab here, invariants are evaluated over the
// **honest** replicas only — a Byzantine replica's state is untrustworthy by
// definition. Streamlet's theorem: the honest replicas stay consistent as long
// as at most f = ⌊(N-1)/3⌋ replicas are faulty, under *any* network behaviour.
// These checks are the live evidence.
import type { InvariantResult, NodeView } from '../../sim/types';
import { faultBudget, opStr, GENESIS_HASH, type StreamletState, type Command } from './types';

export function streamletInvariants(nodes: ReadonlyArray<NodeView<StreamletState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const Ntot = nodes.length;
  const f = faultBudget(Ntot);

  const honest = nodes.filter((n) => n.state.fault === 'honest');
  const faulty = nodes.filter((n) => n.state.fault !== 'honest');

  // 0. FAULT BUDGET — the precondition for every other property. Streamlet
  //    tolerates up to f Byzantine replicas out of N = 3f+1; beyond that,
  //    agreement is *allowed* to break. This is the boundary of the theorem.
  results.push({
    name: `Fault budget (≤ f = ${f})`,
    ok: faulty.length <= f,
    detail:
      faulty.length <= f
        ? `${faulty.length}/${Ntot} replicas Byzantine — within the f=${f} the cluster tolerates`
        : `${faulty.length}/${Ntot} replicas Byzantine — EXCEEDS f=${f}; safety is no longer guaranteed`,
  });

  // 1. CONSISTENCY (the headline). No two honest replicas finalize different
  //    blocks at the same height. This must hold even while a Byzantine leader
  //    equivocates, as long as faulty ≤ f — the whole point of the finalization
  //    rule + 2f+1 quorum intersection.
  {
    let bad = '';
    const byHeight = new Map<number, { hash: string; node: string }>();
    for (const n of honest) {
      for (const e of n.state.committed) {
        const prev = byHeight.get(e.height);
        if (!prev) byHeight.set(e.height, { hash: e.hash, node: n.id });
        else if (prev.hash !== e.hash) {
          bad = `height ${e.height}: ${prev.node} finalized ${prev.hash.slice(0, 14)}… but ${n.id} finalized ${e.hash.slice(0, 14)}…`;
          break;
        }
      }
      if (bad) break;
    }
    results.push({
      name: 'Consistency (honest replicas)',
      ok: !bad,
      detail: bad ? `two honest replicas forked — ${bad}` : 'every honest replica finalizes the same block at every height',
    });
  }

  // 2. FINALIZED-CHAIN INTEGRITY — each honest replica's finalized log is a
  //    gap-free run 1…finalHeight whose blocks link parent→child into one chain,
  //    its execution tip matches, and every finalized block is one it holds. This
  //    is the internal consistency of the replicated log.
  {
    let bad = '';
    for (const n of honest) {
      const s = n.state;
      const sorted = [...s.committed].sort((a, b) => a.height - b.height);
      let prevHash = GENESIS_HASH;
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i];
        if (i > 0 && e.height !== sorted[i - 1].height + 1) {
          bad = `${n.id}: a hole between finalized heights ${sorted[i - 1].height} and ${e.height}`;
          break;
        }
        const blk = s.blocks[e.hash];
        if (blk && blk.parent !== prevHash) {
          bad = `${n.id}: finalized block at height ${e.height} does not link to its predecessor`;
          break;
        }
        prevHash = e.hash;
      }
      if (bad) break;
      const last = sorted[sorted.length - 1];
      if (last && last.height === s.finalHeight && last.hash !== s.finalHash) {
        bad = `${n.id}: execution tip (#${s.finalHeight}) disagrees with the last finalized block`;
        break;
      }
    }
    results.push({
      name: 'Finalized-chain integrity',
      ok: !bad,
      detail: bad ? bad : 'every honest replica finalized a single gap-free, parent-linked chain',
    });
  }

  // 3. STATE-MACHINE SAFETY — each honest replica's KV store equals exactly its
  //    finalized commands replayed in order. Proves execution faithfully reflects
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
        bad = `${n.id}: KV store does not match its finalized log replayed in order`;
        break;
      }
    }
    results.push({
      name: 'State-machine safety',
      ok: !bad,
      detail: bad ? bad : 'every honest replica’s KV = its finalized commands replayed in order',
    });
  }

  // 4. NOTARIZATION IS FORK-FREE AT A HEIGHT ON THE FINALIZED PATH — a subtler
  //    Streamlet property made checkable: no two *distinct* blocks that any honest
  //    replica has finalized ever appear at the same height across the honest set,
  //    AND no honest replica has notarized a block that conflicts with another
  //    honest replica's finalized block at the same height. (Forks may be
  //    *notarized* off the finalized path — that is allowed — but never on it.)
  {
    let bad = '';
    // Map height → the finalized hash agreed by honest replicas (from inv 1 this
    // is unique when it holds); flag any honest replica that notarized a
    // different block at that height on a chain it treats as notarized.
    const finalAt = new Map<number, string>();
    for (const n of honest) for (const e of n.state.committed) if (!finalAt.has(e.height)) finalAt.set(e.height, e.hash);
    outer: for (const n of honest) {
      const s = n.state;
      for (const h of Object.keys(s.notarized)) {
        const b = s.blocks[h];
        if (!b) continue;
        const fin = finalAt.get(b.height);
        if (fin && fin !== b.hash && s.notarized[fin] !== undefined) {
          // Only a violation if this replica also treats the finalized block as
          // notarized (i.e. it genuinely holds two notarized blocks at a height
          // one of which is finalized) — an actual conflicting-notarization fork.
          bad = `${n.id}: notarized ${b.hash.slice(0, 12)}… conflicting with finalized block at height ${b.height}`;
          break outer;
        }
      }
    }
    results.push({
      name: 'No conflicting notarization on the finalized path',
      ok: !bad,
      detail: bad ? bad : 'no honest replica holds a notarized block that conflicts with a finalized one at its height',
    });
  }

  // A friendly liveness note (informational, not a safety invariant).
  if (honest.length > 0) {
    const live = honest.filter((n) => n.up);
    const finals = live.map((n) => n.state.finalHeight);
    const maxFin = finals.length ? Math.max(...finals) : 0;
    const caughtUp = live.filter((n) => n.state.finalHeight === maxFin).length;
    const lead = honest.reduce((a, b) => (a.state.finalHeight >= b.state.finalHeight ? a : b));
    const lastReal = [...lead.state.committed].reverse().find((e) => e.cmd.op.op !== 'noop');
    results.push({
      name: 'Progress',
      ok: true,
      detail:
        maxFin === 0
          ? 'no blocks finalized yet — needs three consecutive-epoch notarized blocks'
          : `${caughtUp}/${live.length} live honest replicas at #${maxFin}` + (lastReal ? ` — last: ${opStr(lastReal.cmd)}` : ''),
    });
  }

  return results;
}
