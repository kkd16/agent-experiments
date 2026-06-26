// The PBFT safety properties, checked live across the cluster on every render.
//
// The crucial twist versus the crash-fault labs: invariants are evaluated over
// the **honest** replicas only. A Byzantine replica's state is, by definition,
// untrustworthy — it may claim anything — so it is excluded from the safety
// witnesses. The theorem PBFT proves is precisely that *the honest replicas*
// stay consistent as long as at most f = ⌊(N-1)/3⌋ replicas are faulty, and
// these checks are the live evidence of that.
import type { InvariantResult, NodeView } from '../../sim/types';
import { faultBudget, opStr, NOOP_REQUEST, type PbftState, type ClientRequest } from './types';

export function pbftInvariants(nodes: ReadonlyArray<NodeView<PbftState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const N = nodes.length;
  const f = faultBudget(N);

  const honest = nodes.filter((n) => n.state.fault === 'honest');
  const faulty = nodes.filter((n) => n.state.fault !== 'honest');

  // 0. FAULT BUDGET — the precondition for every other property. PBFT tolerates
  //    up to f Byzantine replicas; beyond that, agreement is *allowed* to break
  //    (and the simulator will show it). This is the boundary of the theorem.
  results.push({
    name: `Fault budget (≤ f = ${f})`,
    ok: faulty.length <= f,
    detail:
      faulty.length <= f
        ? `${faulty.length}/${N} replicas Byzantine — within the f=${f} the cluster tolerates`
        : `${faulty.length}/${N} replicas Byzantine — EXCEEDS f=${f}; safety is no longer guaranteed`,
  });

  // 1. AGREEMENT — no two honest replicas execute different requests at the same
  //    sequence number. This is the headline safety property; it must hold even
  //    while a Byzantine primary actively equivocates, as long as faulty ≤ f.
  {
    let bad = '';
    const allSeq = new Set<number>();
    for (const n of honest) for (const k of Object.keys(n.state.executed)) allSeq.add(Number(k));
    for (const seq of allSeq) {
      let d: string | undefined;
      let firstNode = '';
      for (const n of honest) {
        const e = n.state.executed[seq];
        if (e === undefined) continue;
        if (d === undefined) {
          d = e;
          firstNode = n.id;
        } else if (e !== d) {
          bad = `seq ${seq}: ${firstNode} executed "${d}" but ${n.id} executed "${e}"`;
          break;
        }
      }
      if (bad) break;
    }
    results.push({
      name: 'Agreement (honest replicas)',
      ok: !bad,
      detail: bad ? `two honest replicas diverged — ${bad}` : 'every honest replica agrees on every executed sequence number',
    });
  }

  // 2. TOTAL-ORDER EXECUTION — each honest replica executed a gap-free prefix
  //    (lastExec covers a contiguous run) and its KV store equals that prefix
  //    replayed in order. Internal state-machine correctness.
  {
    let bad = '';
    for (const n of honest) {
      const s = n.state;
      const replay: Record<string, string> = {};
      for (let i = 1; i <= s.lastExec; i++) {
        const digest = s.executed[i];
        if (digest === undefined) {
          bad = `${n.id}: lastExec=${s.lastExec} but seq ${i} is not executed (a hole)`;
          break;
        }
        const req: ClientRequest = s.requests[digest] ?? NOOP_REQUEST;
        if (req.op.op === 'set') replay[req.op.key] = req.op.value;
        else if (req.op.op === 'del') delete replay[req.op.key];
      }
      if (bad) break;
      if (JSON.stringify(replay) !== JSON.stringify(s.kv)) {
        bad = `${n.id}: KV store does not match its executed prefix replayed in order`;
        break;
      }
    }
    results.push({
      name: 'Total-order execution',
      ok: !bad,
      detail: bad ? bad : 'every honest replica executed a gap-free prefix; its KV = that prefix replayed',
    });
  }

  // 3. CERTIFIED EXECUTION — every sequence number an honest replica executed is
  //    backed by a valid certificate that makes the decision irrevocable. There
  //    are two such certificates, and either suffices:
  //      • a local COMMIT quorum: 2f+1 matching COMMITs the replica saw (two such
  //        quorums for one slot would intersect in an honest replica, which never
  //        commits two digests for one (view, seq)); or
  //      • a catch-up certificate: f+1 matching reports from distinct replicas —
  //        at least one is honest, and honest replicas only report what they
  //        themselves executed (which Agreement guarantees is consistent).
  {
    let bad = '';
    const commitQuorum = 2 * f + 1;
    const catchQuorum = f + 1;
    for (const n of honest) {
      const s = n.state;
      for (let i = 1; i <= s.lastExec && !bad; i++) {
        const digest = s.executed[i];
        const slot = s.log[i];
        let commits = 0;
        if (slot) for (const from of Object.keys(slot.commits)) if (slot.commits[from] === digest) commits++;
        let reports = 0;
        const votes = s.catchup[i];
        if (votes && votes[digest]) reports = Object.keys(votes[digest]).length;
        if (commits < commitQuorum && reports < catchQuorum) {
          bad = `${n.id}: executed seq ${i} with neither a commit quorum (${commits}/${commitQuorum}) nor a catch-up certificate (${reports}/${catchQuorum})`;
        }
      }
      if (bad) break;
    }
    results.push({
      name: 'Certified execution',
      ok: !bad,
      detail: bad
        ? bad
        : `every executed slot is backed by a ${commitQuorum}-commit quorum or an ${catchQuorum}-report catch-up certificate`,
    });
  }

  // A friendly liveness note (not a safety invariant): how far the honest
  // replicas have progressed and whether they have all caught up.
  if (honest.length > 0) {
    const execs = honest.map((n) => n.state.lastExec);
    const maxExec = Math.max(...execs);
    const caughtUp = honest.filter((n) => n.up && n.state.lastExec === maxExec).length;
    const lead = honest.reduce((a, b) => (a.state.lastExec >= b.state.lastExec ? a : b));
    const last = lead.state.execLog[lead.state.execLog.length - 1];
    results.push({
      name: 'Progress',
      ok: true,
      detail:
        maxExec === 0
          ? 'no requests executed yet'
          : `${caughtUp}/${honest.filter((n) => n.up).length} live honest replicas at #${maxExec}` +
            (last ? ` — last: ${opStr(lead.state.requests[last.digest] ?? null)}` : ''),
    });
  }

  return results;
}
