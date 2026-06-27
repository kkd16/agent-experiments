// The EPaxos safety properties, checked across the whole cluster on every render.
//
// EPaxos has no single log, so its safety is not "everyone agrees on slot i". It
// is two things, and these are their live witnesses — they must NEVER go red:
//
//   1. **Per-instance consensus** — every replica that has decided an instance
//      decided the *same* (command, deps, seq). Each instance is a single-decree
//      Paxos register; this is the value it chose.
//   2. **Execution consistency** — any two interfering commands are executed in
//      the *same relative order* on every replica that executes both. This is the
//      property that makes the leaderless, out-of-order store linearizable: the
//      whole point of the dependency graph.
//
// Plus an internal **state-machine** check (each replica's KV equals its own
// execution order replayed) and a separate, *eventual* convergence gauge.
import type { InvariantResult, NodeView } from '../../sim/types';
import { cmdEq, cmdStr, depsEq, keyOf, type Command, type EPaxosState } from './types';

const committedOrExecuted = (st: string) => st === 'committed' || st === 'executed';

export function epaxosInvariants(nodes: ReadonlyArray<NodeView<EPaxosState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const states = nodes.map((n) => n.state);

  // 1. PER-INSTANCE CONSENSUS — decided instances agree on (cmd, deps, seq).
  {
    let bad = '';
    const seen = new Map<string, { cmd: Command | null; deps: string[]; seq: number; by: string }>();
    for (const n of nodes) {
      for (const key of Object.keys(n.state.inst)) {
        const inst = n.state.inst[key];
        if (!committedOrExecuted(inst.status)) continue;
        const prev = seen.get(key);
        if (!prev) {
          seen.set(key, { cmd: inst.cmd, deps: inst.deps, seq: inst.seq, by: n.id });
        } else if (!cmdEq(prev.cmd, inst.cmd) || !depsEq(prev.deps, inst.deps) || prev.seq !== inst.seq) {
          bad = `instance ${key}: ${prev.by} decided {${cmdStr(prev.cmd)}, seq ${prev.seq}, ${prev.deps.length} deps} but ${n.id} decided {${cmdStr(inst.cmd)}, seq ${inst.seq}, ${inst.deps.length} deps}`;
          break;
        }
      }
      if (bad) break;
    }
    results.push({
      name: 'Per-instance consensus',
      ok: !bad,
      detail: bad ? bad : 'every replica that decided an instance chose the same command, deps and seq',
    });
  }

  // 2. EXECUTION CONSISTENCY — interfering commands execute in the same order
  //    on every replica that runs both. We compare, for each conflict key, the
  //    relative order of the instances touching it across all replicas.
  {
    // The *decided* command per instance — only committed/executed records count
    // (a stale PreAccepted value at a crashed replica is not what was chosen, and
    // per-instance consensus #1 guarantees the decided records all agree).
    const cmdOf = new Map<string, Command>();
    for (const s of states) {
      for (const key of Object.keys(s.inst)) {
        const inst = s.inst[key];
        if (!committedOrExecuted(inst.status)) continue;
        const c = inst.cmd;
        if (c && c.op !== 'noop' && !cmdOf.has(key)) cmdOf.set(key, c);
      }
    }
    // Per-replica execution position.
    const posByNode = nodes.map((n) => {
      const pos = new Map<string, number>();
      n.state.executedOrder.forEach((k, i) => pos.set(k, i));
      return pos;
    });
    // Group executed instances by the key their command touches.
    const groups = new Map<string, string[]>();
    for (const [inst, c] of cmdOf) {
      const k = keyOf(c);
      if (k === null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(inst);
    }
    let bad = '';
    outer: for (const [, members] of groups) {
      for (let a = 0; a < members.length && !bad; a++) {
        for (let b = a + 1; b < members.length; b++) {
          const x = members[a];
          const y = members[b];
          let dir = 0; // +1 means x-before-y seen; -1 means y-before-x
          for (const pos of posByNode) {
            if (!pos.has(x) || !pos.has(y)) continue;
            const d = pos.get(x)! < pos.get(y)! ? 1 : -1;
            if (dir === 0) dir = d;
            else if (dir !== d) {
              bad = `conflicting commands ${x} (${cmdStr(cmdOf.get(x)!)}) and ${y} (${cmdStr(cmdOf.get(y)!)}) executed in different orders on different replicas`;
              break outer;
            }
          }
        }
      }
    }
    results.push({
      name: 'Execution consistency (interfering order)',
      ok: !bad,
      detail: bad ? bad : 'every pair of interfering commands executes in the same order on all replicas — the store is linearizable',
    });
  }

  // 3. STATE-MACHINE SAFETY — each replica's KV equals its execution replayed.
  {
    let bad = '';
    for (const n of nodes) {
      const s = n.state;
      const replay: Record<string, string> = {};
      for (const key of s.executedOrder) {
        const c = s.inst[key]?.cmd;
        if (!c) continue;
        if (c.op === 'set') replay[c.key] = c.value;
        else if (c.op === 'del') delete replay[c.key];
      }
      if (JSON.stringify(replay) !== JSON.stringify(s.kv)) {
        bad = `${n.id}: KV does not equal its own execution order replayed`;
        break;
      }
    }
    results.push({
      name: 'State-machine safety',
      ok: !bad,
      detail: bad ? bad : 'every replica’s KV equals its committed execution order replayed',
    });
  }

  return results;
}

/**
 * Convergence is *eventual*, not a safety property: during a partition replicas
 * execute different prefixes and the gauge dips; once messages drain it heals.
 * Reported separately so it never paints the safety panel red.
 */
export function convergenceGauge(nodes: ReadonlyArray<NodeView<EPaxosState>>): InvariantResult {
  const up = nodes.filter((n) => n.up);
  if (up.length <= 1) return { name: 'Convergence (eventual)', ok: true, detail: 'single replica' };
  const kvs = up.map((n) => JSON.stringify(sortedKv(n.state.kv)));
  const counts = up.map((n) => n.state.executedOrder.length);
  const allEqual = kvs.every((k) => k === kvs[0]);
  return {
    name: 'Convergence (eventual)',
    ok: allEqual,
    detail: allEqual
      ? `all ${up.length} live replicas converged (${counts[0]} commands executed)`
      : `replicas still diverge — executed counts ${counts.join('/')} (heals once messages drain)`,
  };
}

function sortedKv(kv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(kv).sort()) out[k] = kv[k];
  return out;
}
