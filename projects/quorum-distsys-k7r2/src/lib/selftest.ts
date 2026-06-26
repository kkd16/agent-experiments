// A built-in test suite, runnable live from the UI. It proves the two things
// the whole simulator rests on: (1) the kernel is perfectly deterministic and
// its time-travel is exact, and (2) the protocols actually uphold their
// invariants — including a randomized chaos run that crashes nodes and
// partitions the network thousands of times and asserts Raft never breaks.
import { Rng } from '../sim/prng';
import { PriorityQueue } from '../sim/pqueue';
import { Kernel } from '../sim/kernel';
import { createRaft } from '../protocols/raft/raft';
import { raftInvariants } from '../protocols/raft/invariants';
import { DEFAULT_RAFT_CONFIG, type RaftCommand, type RaftState } from '../protocols/raft/types';
import { createCrdtProtocol, crdtSpec, type CrdtNodeState } from '../protocols/crdt/crdt';
import type { CrdtOp } from '../protocols/crdt/crdts';
import { createTwoPC, type TwoPCCmd, type TwoPCState } from '../protocols/commit/twopc';
import { createThreePC, type ThreePCCmd, type ThreePCState } from '../protocols/commit/threepc';
import { createVClock, type VcCmd, type VcState } from '../protocols/vclock/vclock';
import { createCoedit, docText, visibleCells, type CoeditOp, type CoeditState } from '../protocols/coedit/coedit';
import { createPaxos } from '../protocols/paxos/paxos';
import { paxosInvariants } from '../protocols/paxos/invariants';
import { DEFAULT_PAXOS_CONFIG, type PaxosCmd, type PaxosState, type PaxosValue } from '../protocols/paxos/types';

export interface TestResult {
  group: string;
  name: string;
  ok: boolean;
  detail: string;
}

function raftKernel(seed: number, ids: string[], preVote = false) {
  return new Kernel<RaftState, RaftCommand>({
    seed,
    protocol: createRaft({ ...DEFAULT_RAFT_CONFIG, preVote }),
    nodeIds: ids,
  });
}

function raftKernelCfg(seed: number, ids: string[], cfg: Partial<typeof DEFAULT_RAFT_CONFIG>) {
  return new Kernel<RaftState, RaftCommand>({
    seed,
    protocol: createRaft({ ...DEFAULT_RAFT_CONFIG, ...cfg }),
    nodeIds: ids,
  });
}

const topLeader = (k: Kernel<RaftState, RaftCommand>) =>
  k
    .views()
    .filter((v) => v.up && v.state.role === 'leader')
    .sort((a, b) => b.state.currentTerm - a.state.currentTerm)[0];

/** The active voter set as a node sees it (latest config entry in its log, else bootstrap). */
function activeMembers(s: RaftState): string[] {
  for (let i = s.log.length - 1; i >= 0; i--) {
    const c = s.log[i].cmd;
    if (c.op === 'config') {
      const set = c.next ? [...new Set([...c.old, ...c.next])] : c.old;
      return [...set].sort();
    }
  }
  const cfg = s.snapshotIndex > 0 ? s.snapshotConfig : s.bootstrap;
  const set = cfg.next ? [...new Set([...cfg.old, ...cfg.next])] : cfg.old;
  return [...set].sort();
}

export function runSelfTests(): TestResult[] {
  const out: TestResult[] = [];
  const t = (group: string, name: string, fn: () => [boolean, string]) => {
    try {
      const [ok, detail] = fn();
      out.push({ group, name, ok, detail });
    } catch (e) {
      out.push({ group, name, ok: false, detail: `threw: ${(e as Error).message}` });
    }
  };

  // ---- kernel primitives ----
  t('Kernel', 'PRNG is reproducible & seed-sensitive', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    let same = true;
    for (let i = 0; i < 50; i++) if (a.nextUint32() !== b.nextUint32()) same = false;
    const c = new Rng(42);
    const d = new Rng(43);
    let diff = false;
    for (let i = 0; i < 50; i++) if (c.nextUint32() !== d.nextUint32()) diff = true;
    return [same && diff, same ? (diff ? 'identical for equal seeds, divergent for different' : 'seeds did not diverge') : 'equal seeds diverged'];
  });

  t('Kernel', 'Priority queue pops in (time, seq) order', () => {
    const pq = new PriorityQueue<{ time: number; seq: number }>();
    const r = new Rng(7);
    for (let i = 0; i < 500; i++) pq.push({ time: r.int(0, 40), seq: i });
    let prev: { time: number; seq: number } | null = null;
    let ok = true;
    while (pq.size) {
      const x = pq.pop()!;
      if (prev && (x.time < prev.time || (x.time === prev.time && x.seq < prev.seq))) ok = false;
      prev = x;
    }
    return [ok, ok ? '500 items dequeued in nondecreasing order' : 'out-of-order pop'];
  });

  t('Kernel', 'Simulation is deterministic (same seed ⇒ same history)', () => {
    const run = (seed: number) => {
      const k = raftKernel(seed, ['A', 'B', 'C', 'D', 'E']);
      for (let i = 0; i < 200; i++) {
        k.advance(25);
        if (i % 30 === 0) {
          const leader = k.views().find((v) => v.up && v.state.role === 'leader');
          if (leader) k.command(leader.id, { op: 'set', key: 'x', value: String(i) });
        }
      }
      return k.serialize();
    };
    const ok = run(99) === run(99);
    return [ok, ok ? 'two independent runs produced byte-identical state' : 'runs diverged'];
  });

  t('Kernel', 'Time travel is exact (restore ⇒ identical replay)', () => {
    const k = raftKernel(1234, ['A', 'B', 'C', 'D', 'E']);
    for (let i = 0; i < 60; i++) k.advance(25);
    const s1 = k.serialize();
    for (let i = 0; i < 60; i++) k.advance(25);
    const s2 = k.serialize();
    k.restore(s1);
    for (let i = 0; i < 60; i++) k.advance(25);
    const s3 = k.serialize();
    const ok = s2 === s3;
    return [ok, ok ? 'replay from a restored snapshot matched exactly' : 'replay diverged from original'];
  });

  // ---- Raft ----
  t('Raft', 'Elects a single leader on a healthy cluster', () => {
    let elected = 0;
    let safe = true;
    for (const seed of [1, 2, 3, 7, 13]) {
      const k = raftKernel(seed, ['A', 'B', 'C']);
      for (let i = 0; i < 120; i++) k.advance(25);
      const leaders = k.views().filter((v) => v.up && v.state.role === 'leader');
      if (leaders.length >= 1) elected++;
      if (!raftInvariants(k.views()).every((iv) => iv.ok)) safe = false;
    }
    return [elected === 5 && safe, `${elected}/5 seeds elected a leader; invariants ${safe ? 'held' : 'broke'}`];
  });

  t('Raft', 'Replicates & commits client commands by majority', () => {
    const k = raftKernel(5, ['A', 'B', 'C', 'D', 'E']);
    for (let i = 0; i < 80; i++) k.advance(25);
    const leader = k.views().find((v) => v.up && v.state.role === 'leader');
    if (!leader) return [false, 'no leader formed'];
    for (let n = 0; n < 6; n++) {
      k.command(leader.id, { op: 'set', key: 'k', value: String(n) });
      for (let i = 0; i < 20; i++) k.advance(25);
    }
    const committed = k.views().filter((v) => v.state.kv['k'] === '5').length;
    const ok = committed >= 3; // majority applied the latest value
    return [ok, `${committed}/5 replicas applied the latest committed value`];
  });

  const chaosRun = (preVote: boolean): [boolean, string] => {
    const k = raftKernel(2026, ['A', 'B', 'C', 'D', 'E'], preVote);
    const chaos = new Rng(31337);
    const ids = k.nodeOrder;
    let cmd = 0;
    let firstBreak = '';
    for (let i = 0; i < 1200 && !firstBreak; i++) {
      k.advance(20);
      const up = ids.filter((id) => k.isUp(id));
      const down = ids.filter((id) => !k.isUp(id));
      const roll = chaos.next();
      if (roll < 0.04 && up.length > 1) k.crash(chaos.pick(up)!);
      else if (roll < 0.12 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.15) {
        const shuffled = chaos.shuffle(ids);
        const cut = chaos.int(1, ids.length - 1);
        k.partition([shuffled.slice(0, cut), shuffled.slice(cut)]);
      } else if (roll < 0.2) k.healNetwork();
      else if (roll < 0.35) {
        const leader = k.views().find((v) => v.up && v.state.role === 'leader');
        if (leader) k.command(leader.id, { op: 'set', key: 'c', value: String(cmd++) });
      }
      const bad = raftInvariants(k.views()).find((iv) => !iv.ok);
      if (bad) firstBreak = `${bad.name}: ${bad.detail}`;
    }
    return [!firstBreak, firstBreak || 'all four Raft invariants held through 1,200 randomized faults'];
  };

  t('Raft', 'Never violates safety under 1,200 chaos steps', () => chaosRun(false));
  t('Raft', 'Stays safe under 1,200 chaos steps with pre-vote', () => chaosRun(true));

  t('Raft', 'Pre-vote stops a partitioned node from inflating terms', () => {
    const termWhenIsolated = (preVote: boolean) => {
      const k = raftKernel(7, ['A', 'B', 'C', 'D', 'E'], preVote);
      for (let i = 0; i < 80; i++) k.advance(25); // settle on a leader
      k.partition([['A', 'B', 'C', 'D'], ['E']]); // isolate E
      for (let i = 0; i < 300; i++) k.advance(25); // let E keep timing out
      return k.views().find((v) => v.id === 'E')!.state.currentTerm;
    };
    const off = termWhenIsolated(false);
    const on = termWhenIsolated(true);
    const ok = on < off && on <= 2;
    return [ok, `isolated node's term: ${off} without pre-vote vs ${on} with pre-vote`];
  });

  // ---- Raft: log compaction / snapshots ----
  t('Raft·Snapshot', 'Compacts the log yet keeps every replica converged', () => {
    const k = raftKernelCfg(11, ['A', 'B', 'C', 'D', 'E'], { snapshotThreshold: 8 });
    for (let i = 0; i < 80; i++) k.advance(25);
    let n = 0;
    for (let r = 0; r < 40; r++) {
      const leader = topLeader(k);
      if (leader) k.command(leader.id, { op: 'set', key: 'k', value: String(n++) });
      for (let i = 0; i < 8; i++) k.advance(25);
    }
    for (let i = 0; i < 200; i++) k.advance(25); // let everyone catch up + compact
    const states = k.views().map((v) => v.state);
    const compacted = states.some((s) => s.snapshotIndex > 0);
    const kvs = states.map((s) => s.kv['k']);
    const converged = kvs.every((v) => v === kvs[0] && v !== undefined);
    const safe = raftInvariants(k.views()).every((iv) => iv.ok);
    const maxLog = Math.max(...states.map((s) => s.log.length));
    const maxIdx = Math.max(...states.map((s) => s.snapshotIndex + s.log.length));
    const ok = compacted && converged && safe;
    return [
      ok,
      ok
        ? `log compacted (≤${maxLog} live entries for ${maxIdx} total) and all replicas agree k=${kvs[0]}`
        : `compacted=${compacted} converged=${converged} safe=${safe}`,
    ];
  });

  t('Raft·Snapshot', 'A lagging follower is caught up by InstallSnapshot', () => {
    const k = raftKernelCfg(23, ['A', 'B', 'C', 'D', 'E'], { snapshotThreshold: 6 });
    for (let i = 0; i < 80; i++) k.advance(25);
    const leader = topLeader(k);
    if (!leader) return [false, 'no leader formed'];
    // Knock out a follower, then commit far past the snapshot threshold.
    const victim = k.nodeOrder.find((id) => id !== leader.id)!;
    k.crash(victim);
    for (let n = 0; n < 30; n++) {
      const l = topLeader(k);
      if (l) k.command(l.id, { op: 'set', key: 'v', value: String(n) });
      for (let i = 0; i < 8; i++) k.advance(25);
    }
    const leaderSnap = topLeader(k)?.state.snapshotIndex ?? 0;
    // Bring the follower back: its nextIndex is below the leader's snapshot, so it
    // must be repaired via InstallSnapshot rather than AppendEntries.
    k.restart(victim);
    for (let i = 0; i < 400; i++) k.advance(25);
    const v = k.views().find((n) => n.id === victim)!.state;
    const others = k.views().filter((n) => n.id !== victim).map((n) => n.state.kv['v']);
    const want = others[0];
    const ok = leaderSnap > 0 && v.kv['v'] === want && v.snapshotIndex > 0 && raftInvariants(k.views()).every((iv) => iv.ok);
    return [ok, ok ? `follower rebuilt from a snapshot (≤#${v.snapshotIndex}) to v=${v.kv['v']}` : `victim v=${v.kv['v']} want=${want} snap=${v.snapshotIndex} leaderSnap=${leaderSnap}`];
  });

  t('Raft·Snapshot', 'Snapshots survive a crash & restore the state machine', () => {
    const k = raftKernelCfg(47, ['A', 'B', 'C'], { snapshotThreshold: 5 });
    for (let i = 0; i < 60; i++) k.advance(25);
    for (let n = 0; n < 20; n++) {
      const l = topLeader(k);
      if (l) k.command(l.id, { op: 'set', key: 'z', value: String(n) });
      for (let i = 0; i < 8; i++) k.advance(25);
    }
    for (let i = 0; i < 100; i++) k.advance(25);
    // Crash & restart every node: each must restore its KV store from its snapshot.
    for (const id of k.nodeOrder) {
      k.crash(id);
      k.restart(id);
    }
    for (let i = 0; i < 200; i++) k.advance(25);
    const kvs = k.views().map((v) => v.state.kv['z']);
    const ok = kvs.every((v) => v === kvs[0] && v !== undefined) && raftInvariants(k.views()).every((iv) => iv.ok);
    return [ok, ok ? `all replicas restored z=${kvs[0]} from their snapshots` : `kvs=${kvs.join('/')}`];
  });

  t('Raft·Snapshot', 'Stays deterministic & safe under chaos with compaction on', () => {
    const run = () => {
      const k = raftKernelCfg(2026, ['A', 'B', 'C', 'D', 'E'], { snapshotThreshold: 10, preVote: true });
      const chaos = new Rng(909);
      const ids = k.nodeOrder;
      let cmd = 0;
      let firstBreak = '';
      for (let i = 0; i < 1200 && !firstBreak; i++) {
        k.advance(20);
        const up = ids.filter((id) => k.isUp(id));
        const down = ids.filter((id) => !k.isUp(id));
        const roll = chaos.next();
        if (roll < 0.04 && up.length > 1) k.crash(chaos.pick(up)!);
        else if (roll < 0.12 && down.length > 0) k.restart(chaos.pick(down)!);
        else if (roll < 0.15) {
          const shuffled = chaos.shuffle(ids);
          const cut = chaos.int(1, ids.length - 1);
          k.partition([shuffled.slice(0, cut), shuffled.slice(cut)]);
        } else if (roll < 0.2) k.healNetwork();
        else if (roll < 0.45) {
          const l = topLeader(k);
          if (l) k.command(l.id, { op: 'set', key: 'c', value: String(cmd++) });
        }
        const bad = raftInvariants(k.views()).find((iv) => !iv.ok);
        if (bad) firstBreak = `${bad.name}: ${bad.detail}`;
      }
      return { firstBreak, ser: k.serialize() };
    };
    const a = run();
    const b = run();
    if (a.firstBreak) return [false, a.firstBreak];
    const ok = a.ser === b.ser;
    return [ok, ok ? 'all six invariants held through 1,200 faults and the run was byte-identical' : 'runs diverged with compaction on'];
  });

  // ---- Raft: cluster membership changes (joint consensus) ----
  t('Raft·Membership', 'Grows the cluster A,B,C → A..E via joint consensus', () => {
    const pool = ['A', 'B', 'C', 'D', 'E'];
    const k = raftKernelCfg(5, pool, { initialMembers: ['A', 'B', 'C'] });
    for (let i = 0; i < 80; i++) k.advance(25);
    const seed = topLeader(k);
    if (!seed) return [false, 'no initial leader among A,B,C'];
    k.command(seed.id, { op: 'set', key: 'k', value: 'hi' });
    for (let i = 0; i < 40; i++) k.advance(25);
    // Add D, then E — one reconfiguration at a time.
    for (const add of ['D', 'E']) {
      const l = topLeader(k);
      if (!l) return [false, `lost leader before adding ${add}`];
      const members = activeMembers(l.state);
      k.command(l.id, { op: 'config', old: [], next: [...members, add] });
      for (let i = 0; i < 120; i++) k.advance(25);
    }
    const l = topLeader(k);
    const members = l ? activeMembers(l.state) : [];
    const allFive = members.length === 5;
    const newcomers = k.views().filter((v) => v.id === 'D' || v.id === 'E');
    const gotData = newcomers.every((v) => v.state.kv['k'] === 'hi');
    const safe = raftInvariants(k.views()).every((iv) => iv.ok);
    const ok = allFive && gotData && safe;
    return [ok, ok ? `cluster grew to {${members.join('')}}; D,E hold replicated data; all invariants held` : `members={${members.join('')}} gotData=${gotData} safe=${safe}`];
  });

  t('Raft·Membership', 'Shrinks the cluster by removing a follower', () => {
    const pool = ['A', 'B', 'C', 'D', 'E'];
    const k = raftKernelCfg(9, pool, { initialMembers: pool });
    for (let i = 0; i < 90; i++) k.advance(25);
    const l0 = topLeader(k);
    if (!l0) return [false, 'no leader'];
    const victim = pool.find((id) => id !== l0.id)!;
    k.command(l0.id, { op: 'config', old: [], next: pool.filter((id) => id !== victim) });
    for (let i = 0; i < 160; i++) k.advance(25);
    const l = topLeader(k);
    const members = l ? activeMembers(l.state) : [];
    const removed = !members.includes(victim) && members.length === 4;
    const safe = raftInvariants(k.views()).every((iv) => iv.ok);
    const ok = removed && safe;
    return [ok, ok ? `removed ${victim}; configuration is now {${members.join('')}} and stayed safe` : `members={${members.join('')}} safe=${safe}`];
  });

  t('Raft·Membership', 'A membership change under churn never splits the cluster', () => {
    const pool = ['A', 'B', 'C', 'D', 'E'];
    const k = raftKernelCfg(73, pool, { initialMembers: ['A', 'B', 'C'], preVote: true });
    const chaos = new Rng(4242);
    let firstBreak = '';
    let added = false;
    for (let i = 0; i < 700 && !firstBreak; i++) {
      k.advance(20);
      if (i === 120) {
        const l = topLeader(k);
        if (l) k.command(l.id, { op: 'config', old: [], next: ['A', 'B', 'C', 'D', 'E'] });
        added = true;
      }
      const roll = chaos.next();
      const up = pool.filter((id) => k.isUp(id));
      const down = pool.filter((id) => !k.isUp(id));
      if (roll < 0.03 && up.length > 2) k.crash(chaos.pick(up)!);
      else if (roll < 0.1 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.3) {
        const l = topLeader(k);
        if (l) k.command(l.id, { op: 'set', key: 'm', value: String(i) });
      }
      const bad = raftInvariants(k.views()).find((iv) => !iv.ok);
      if (bad) firstBreak = `${bad.name}: ${bad.detail}`;
    }
    if (firstBreak) return [false, firstBreak];
    for (let i = 0; i < 300; i++) k.advance(20);
    const l = topLeader(k);
    const members = l ? activeMembers(l.state) : [];
    const ok = added && members.length === 5 && raftInvariants(k.views()).every((iv) => iv.ok);
    return [ok, ok ? 'reconfigured to 5 nodes amid crashes/restarts with every invariant intact' : `members={${members.join('')}}`];
  });

  // ---- Raft: linearizable reads (ReadIndex) ----
  t('Raft·ReadIndex', 'A leader serves the latest committed value', () => {
    const k = raftKernelCfg(15, ['A', 'B', 'C', 'D', 'E'], {});
    for (let i = 0; i < 80; i++) k.advance(25);
    const l = topLeader(k);
    if (!l) return [false, 'no leader'];
    k.command(l.id, { op: 'set', key: 'x', value: '7' });
    for (let i = 0; i < 30; i++) k.advance(25);
    k.command(l.id, { op: 'read', key: 'x', rid: 1 });
    for (let i = 0; i < 20; i++) k.advance(25);
    const lr = k.views().find((v) => v.id === l.id)!.state.lastRead;
    const ok = lr?.rid === 1 && lr?.value === '7';
    return [ok, ok ? `read returned x=${lr!.value} linearized @${lr!.readIndex}` : `lastRead=${JSON.stringify(lr)}`];
  });

  t('Raft·ReadIndex', 'A deposed, partitioned leader cannot serve a stale read', () => {
    const k = raftKernelCfg(3, ['A', 'B', 'C', 'D', 'E'], {});
    for (let i = 0; i < 90; i++) k.advance(25);
    const old = topLeader(k);
    if (!old) return [false, 'no leader'];
    k.command(old.id, { op: 'set', key: 'x', value: '1' });
    for (let i = 0; i < 30; i++) k.advance(25);
    // Isolate the old leader; the majority elects a fresh one and moves on.
    const others = k.nodeOrder.filter((id) => id !== old.id);
    k.partition([[old.id], others]);
    for (let i = 0; i < 160; i++) k.advance(25);
    const fresh = topLeader(k);
    if (!fresh || fresh.id === old.id) return [false, 'majority did not elect a new leader'];
    k.command(fresh.id, { op: 'set', key: 'x', value: '2' });
    for (let i = 0; i < 40; i++) k.advance(25);
    // Both sides attempt a read. The isolated ex-leader must NOT resolve one.
    k.command(old.id, { op: 'read', key: 'x', rid: 100 });
    k.command(fresh.id, { op: 'read', key: 'x', rid: 101 });
    for (let i = 0; i < 60; i++) k.advance(25);
    const oldRead = k.views().find((v) => v.id === old.id)!.state.lastRead;
    const freshRead = k.views().find((v) => v.id === fresh.id)!.state.lastRead;
    const ok = oldRead === null && freshRead?.rid === 101 && freshRead?.value === '2';
    return [ok, ok ? `the deposed leader served no read; the new leader returned the fresh x=${freshRead!.value}` : `oldRead=${JSON.stringify(oldRead)} freshRead=${JSON.stringify(freshRead)}`];
  });

  // ---- CRDT ----
  t('CRDT', 'Replicas converge after a partition heals', () => {
    const k = new Kernel<CrdtNodeState, CrdtOp>({
      seed: 8,
      protocol: createCrdtProtocol('pncounter'),
      nodeIds: ['A', 'B', 'C', 'D'],
    });
    k.partition([['A', 'B'], ['C', 'D']]);
    for (let n = 0; n < 8; n++) {
      k.command('A', { id: 'inc' });
      k.command('B', { id: 'inc' });
      k.command('D', { id: 'dec' });
      k.advance(40);
    }
    k.healNetwork();
    for (let i = 0; i < 200; i++) k.advance(40);
    const spec = crdtSpec('pncounter');
    const vals = k.views().map((v) => spec.value(v.state.data));
    const ok = vals.every((v) => v === vals[0]);
    return [ok, ok ? `all replicas converged to ${vals[0]}` : `diverged: ${vals.join(' / ')}`];
  });

  t('CRDT', 'OR-Set add wins over a concurrent remove', () => {
    const k = new Kernel<CrdtNodeState, CrdtOp>({
      seed: 4,
      protocol: createCrdtProtocol('orset'),
      nodeIds: ['A', 'B', 'C'],
    });
    k.command('A', { id: 'add', arg: 'x' });
    for (let i = 0; i < 60; i++) k.advance(40); // propagate the add everywhere
    k.partition([['A'], ['B', 'C']]);
    k.command('B', { id: 'remove', arg: 'x' });
    k.command('A', { id: 'add', arg: 'x' }); // concurrent re-add on the other side
    for (let i = 0; i < 30; i++) k.advance(40);
    k.healNetwork();
    for (let i = 0; i < 200; i++) k.advance(40);
    const spec = crdtSpec('orset');
    const vals = k.views().map((v) => spec.value(v.state.data));
    const ok = vals.every((v) => v === vals[0]) && vals[0].includes('x');
    return [ok, ok ? `converged with add-wins: ${vals[0]}` : `unexpected: ${vals.join(' / ')}`];
  });

  // ---- Collaborative text (RGA) ----
  t('CoEdit', 'Concurrent edits across a partition converge to one document', () => {
    const k = new Kernel<CoeditState, CoeditOp>({
      seed: 6,
      protocol: createCoedit(),
      nodeIds: ['A', 'B', 'C'],
    });
    const typeInto = (id: string, str: string) => {
      const node = k.views().find((v) => v.id === id)!;
      let base = visibleCells(node.state.doc).length;
      for (const ch of str) k.command(id, { t: 'ins', index: base++, ch });
    };
    typeInto('A', 'hello world');
    for (let i = 0; i < 60; i++) k.advance(30); // replicate the shared base everywhere
    k.partition([['A'], ['B', 'C']]);
    typeInto('A', '!!!'); // concurrent edit on the isolated side
    typeInto('B', '???'); // and on the majority side
    for (let i = 0; i < 30; i++) k.advance(30);
    k.healNetwork();
    for (let i = 0; i < 300; i++) k.advance(30);
    const texts = k.views().map((v) => docText(v.state.doc));
    const converged = texts.every((tx) => tx === texts[0]);
    const keptBoth = texts[0].includes('!!!') && texts[0].includes('???') && texts[0].includes('hello world');
    const ok = converged && keptBoth;
    return [ok, ok ? `all replicas converged to ${JSON.stringify(texts[0])}` : `texts: ${texts.map((x) => JSON.stringify(x)).join(' / ')}`];
  });

  t('CoEdit', 'Insert/delete on an RGA is order-independent (commutative merge)', () => {
    const k = new Kernel<CoeditState, CoeditOp>({
      seed: 12,
      protocol: createCoedit(),
      nodeIds: ['A', 'B', 'C', 'D'],
    });
    const chaos = new Rng(55);
    for (let r = 0; r < 40; r++) {
      const id = chaos.pick(k.nodeOrder)!;
      const node = k.views().find((v) => v.id === id)!;
      const len = visibleCells(node.state.doc).length;
      if (len > 2 && chaos.next() < 0.3) k.command(id, { t: 'del', index: chaos.int(0, len - 1) });
      else k.command(id, { t: 'ins', index: chaos.int(0, len), ch: 'abcdefgh'[chaos.int(0, 7)] });
      k.advance(chaos.int(5, 50));
    }
    for (let i = 0; i < 400; i++) k.advance(30);
    const texts = k.views().map((v) => docText(v.state.doc));
    const ok = texts.every((tx) => tx === texts[0]);
    return [ok, ok ? `40 interleaved edits converged to ${JSON.stringify(texts[0])}` : `diverged: ${texts.map((x) => JSON.stringify(x)).join(' / ')}`];
  });

  // ---- 2PC ----
  t('2PC', 'Commits atomically when all vote yes', () => {
    const k = new Kernel<TwoPCState, TwoPCCmd>({
      seed: 1,
      protocol: createTwoPC(),
      nodeIds: ['C', 'P1', 'P2', 'P3'],
    });
    k.command('C', { type: 'begin' });
    for (let i = 0; i < 40; i++) k.advance(30);
    const parts = k.views().filter((v) => v.state.role === 'participant');
    const allCommitted = parts.every((p) => p.state.pstate === 'committed');
    const safe = k.protocol.invariants!(k.views()).every((iv) => iv.ok);
    return [allCommitted && safe, allCommitted ? 'all participants committed; invariants held' : 'did not all commit'];
  });

  t('2PC', 'Stalled coordinator blocks but stays safe', () => {
    const k = new Kernel<TwoPCState, TwoPCCmd>({
      seed: 1,
      protocol: createTwoPC(),
      nodeIds: ['C', 'P1', 'P2', 'P3'],
    });
    k.command('C', { type: 'begin', stall: true });
    for (let i = 0; i < 60; i++) k.advance(30);
    const parts = k.views().filter((v) => v.state.role === 'participant');
    const blocked = parts.some((p) => p.state.pstate === 'uncertain');
    const safe = k.protocol.invariants!(k.views()).every((iv) => iv.ok);
    return [blocked && safe, blocked ? 'participants blocked (as expected) while safety held' : 'expected blocking did not occur'];
  });

  // ---- 3PC (non-blocking atomic commit) ----
  const threePC = (seed: number) =>
    new Kernel<ThreePCState, ThreePCCmd>({ seed, protocol: createThreePC(), nodeIds: ['C', 'P1', 'P2', 'P3'] });

  t('3PC', 'Commits atomically when all vote yes', () => {
    const k = threePC(1);
    k.command('C', { type: 'begin' });
    for (let i = 0; i < 60; i++) k.advance(30);
    const parts = k.views().filter((v) => v.state.role === 'participant');
    const allCommitted = parts.every((p) => p.state.pstate === 'committed');
    const safe = k.protocol.invariants!(k.views()).every((iv) => iv.ok);
    return [allCommitted && safe, allCommitted ? 'every participant committed; invariants held' : 'did not all commit'];
  });

  t('3PC', 'Coordinator crash after PRE-COMMIT: participants commit themselves (no block)', () => {
    const k = threePC(2);
    k.command('C', { type: 'begin', stall: 'docommit' });
    for (let i = 0; i < 30; i++) k.advance(30); // reach the stall (all pre-committed)
    k.crash('C');
    for (let i = 0; i < 120; i++) k.advance(30); // termination timers fire
    const parts = k.views().filter((v) => v.state.role === 'participant');
    const committed = parts.every((p) => p.state.pstate === 'committed');
    const noneStuck = parts.every((p) => p.state.pstate !== 'terminating' && p.state.pstate !== 'prepared');
    const safe = k.protocol.invariants!(k.views()).every((iv) => iv.ok);
    const ok = committed && noneStuck && safe;
    return [ok, ok ? 'all participants terminated to COMMIT without the coordinator — non-blocking & atomic' : `states: ${parts.map((p) => p.state.pstate).join('/')}`];
  });

  t('3PC', 'Coordinator crash before PRE-COMMIT: participants abort themselves (no block)', () => {
    const k = threePC(3);
    k.command('C', { type: 'begin', stall: 'precommit' });
    for (let i = 0; i < 20; i++) k.advance(30); // reach the stall (all prepared, no pre-commit)
    k.crash('C');
    for (let i = 0; i < 140; i++) k.advance(30);
    const parts = k.views().filter((v) => v.state.role === 'participant');
    const aborted = parts.every((p) => p.state.pstate === 'aborted');
    const noneStuck = parts.every((p) => p.state.pstate !== 'terminating');
    const safe = k.protocol.invariants!(k.views()).every((iv) => iv.ok);
    const ok = aborted && noneStuck && safe;
    return [ok, ok ? 'all participants terminated to ABORT without the coordinator — non-blocking & atomic' : `states: ${parts.map((p) => p.state.pstate).join('/')}`];
  });

  t('3PC', 'A single no vote aborts everyone', () => {
    const k = threePC(4);
    k.command('P2', { type: 'setvote', vote: 'no' });
    k.command('C', { type: 'begin' });
    for (let i = 0; i < 60; i++) k.advance(30);
    const parts = k.views().filter((v) => v.state.role === 'participant');
    const aborted = parts.every((p) => p.state.pstate === 'aborted');
    const safe = k.protocol.invariants!(k.views()).every((iv) => iv.ok);
    return [aborted && safe, aborted ? 'the no vote forced a uniform abort' : `states: ${parts.map((p) => p.state.pstate).join('/')}`];
  });

  // ---- Multi-Paxos ----
  const paxosKernel = (seed: number, ids: string[], cfg: Partial<typeof DEFAULT_PAXOS_CONFIG> = {}) =>
    new Kernel<PaxosState, PaxosCmd>({
      seed,
      protocol: createPaxos({ ...DEFAULT_PAXOS_CONFIG, ...cfg }),
      nodeIds: ids,
      network: { minLatency: 20, maxLatency: 60, dropRate: 0 },
    });
  const setv = (key: string, value: string, cid: string): PaxosValue => ({ op: 'set', key, value, cid });
  const paxosOk = (k: Kernel<PaxosState, PaxosCmd>) => paxosInvariants(k.views()).every((iv) => iv.ok);
  const firstBad = (k: Kernel<PaxosState, PaxosCmd>) => {
    const b = paxosInvariants(k.views()).find((iv) => !iv.ok);
    return b ? `${b.name}: ${b.detail}` : '';
  };
  const liveChosen = (k: Kernel<PaxosState, PaxosCmd>) =>
    k.views().filter((v) => v.up).map((v) => JSON.stringify(v.state.chosen));
  const settle = (k: Kernel<PaxosState, PaxosCmd>, ticks = 240, dt = 25) => {
    for (let i = 0; i < ticks; i++) k.advance(dt);
  };

  t('Paxos', 'Chooses a single value on a healthy cluster', () => {
    const k = paxosKernel(1, ['A', 'B', 'C', 'D', 'E']);
    k.command('A', { type: 'propose', value: setv('x', '42', 'c1') });
    settle(k, 60);
    const chosen = k.views()[0].state.chosen;
    const slot1 = chosen[1];
    const ok = !!slot1 && slot1.op === 'set' && slot1.value === '42' && paxosOk(k);
    return [ok, ok ? `slot 1 chosen = x=42; all invariants held` : firstBad(k) || 'value not chosen'];
  });

  t('Paxos', 'Multi-Paxos replicates a sequence in order (one leader, single round-trips)', () => {
    const k = paxosKernel(2, ['A', 'B', 'C', 'D', 'E']);
    for (let i = 0; i < 8; i++) {
      k.command('A', { type: 'propose', value: setv('k' + i, 'v' + i, 'c' + i) });
      settle(k, 8);
    }
    settle(k, 60);
    const a = k.views().find((v) => v.id === 'A')!.state;
    // 8 client values chosen (possibly interleaved with a leader no-op at slot 1).
    const allKv = Object.keys(a.kv).filter((kk) => kk.startsWith('k')).length === 8;
    const converged = new Set(liveChosen(k)).size === 1;
    const ok = allKv && converged && paxosOk(k);
    return [ok, ok ? `8 commands replicated & applied; every live node converged` : firstBad(k) || `kv keys=${Object.keys(a.kv).join(',')}`];
  });

  t('Paxos', 'Dueling proposers still converge to one chosen value', () => {
    const k = paxosKernel(7, ['A', 'B', 'C', 'D', 'E']);
    // Force two different nodes to start Phase 1 with competing client values.
    k.command('A', { type: 'propose', value: setv('w', 'A', 'cA') });
    k.command('E', { type: 'prepare' });
    k.command('E', { type: 'propose', value: setv('w', 'E', 'cE') });
    settle(k, 120);
    // Whatever wins, every node must agree on slot 1 and safety must hold.
    const converged = new Set(liveChosen(k)).size === 1;
    const slot1 = k.views()[0].state.chosen[1];
    const ok = !!slot1 && converged && paxosOk(k);
    return [ok, ok ? `dueling resolved — all agree slot 1 = w=${slot1 && slot1.op === 'set' ? slot1.value : '?'}` : firstBad(k) || 'did not converge'];
  });

  t('Paxos', 'A majority partition makes progress; the minority cannot choose', () => {
    const k = paxosKernel(3, ['A', 'B', 'C', 'D', 'E']);
    settle(k, 30); // let a leader emerge
    k.partition([['A', 'B', 'C'], ['D', 'E']]);
    settle(k, 40);
    // Propose into both sides.
    k.command('A', { type: 'propose', value: setv('p', 'maj', 'cMaj') });
    k.command('D', { type: 'propose', value: setv('p', 'min', 'cMin') });
    settle(k, 120);
    const views = k.views();
    const anyChosenMaj = views.some((v) => Object.values(v.state.chosen).some((x) => x.op === 'set' && x.value === 'maj'));
    const anyChosenMin = views.some((v) => Object.values(v.state.chosen).some((x) => x.op === 'set' && x.value === 'min'));
    const ok = anyChosenMaj && !anyChosenMin && paxosOk(k);
    return [ok, ok ? 'majority chose its value; minority blocked; safety held' : firstBad(k) || `maj=${anyChosenMaj} min=${anyChosenMin}`];
  });

  t('Paxos', 'Partition heals: the lagging minority catches up to the chosen log', () => {
    const k = paxosKernel(11, ['A', 'B', 'C', 'D', 'E']);
    settle(k, 30);
    k.partition([['A', 'B', 'C'], ['D', 'E']]);
    settle(k, 30);
    for (let i = 0; i < 4; i++) {
      k.command('A', { type: 'propose', value: setv('h' + i, 'maj', 'h' + i) });
      settle(k, 10);
    }
    settle(k, 60);
    k.healNetwork();
    settle(k, 200);
    const converged = new Set(liveChosen(k)).size === 1;
    const ok = converged && paxosOk(k);
    return [ok, ok ? 'every node converged to one chosen log after heal' : firstBad(k) || 'minority never caught up'];
  });

  t('Paxos', 'Leader failover preserves all chosen values (recovery rule)', () => {
    const k = paxosKernel(5, ['A', 'B', 'C', 'D', 'E']);
    for (let i = 0; i < 4; i++) {
      k.command('A', { type: 'propose', value: setv('f' + i, 'v' + i, 'f' + i) });
      settle(k, 8);
    }
    settle(k, 40);
    const before = JSON.stringify(k.views().find((v) => v.id === 'B')!.state.chosen);
    // Crash whoever currently leads, then keep going.
    const leader = k.views().find((v) => v.up && v.state.role === 'leader');
    if (leader) k.crash(leader.id);
    settle(k, 80);
    k.command('B', { type: 'propose', value: setv('after', 'x', 'after') });
    settle(k, 120);
    // No previously-chosen slot may have changed value.
    const b = k.views().find((v) => v.id === 'B')!.state;
    const beforeMap = JSON.parse(before) as Record<number, PaxosValue>;
    let preserved = true;
    for (const kk of Object.keys(beforeMap)) {
      const i = Number(kk);
      if (JSON.stringify(b.chosen[i]) !== JSON.stringify(beforeMap[i])) preserved = false;
    }
    const progressed = Object.values(b.chosen).some((x) => x.op === 'set' && x.key === 'after');
    const ok = preserved && progressed && paxosOk(k);
    return [ok, ok ? 'failover kept every chosen value and resumed progress' : firstBad(k) || `preserved=${preserved} progressed=${progressed}`];
  });

  t('Paxos', 'Safety holds through 1,200 randomized faults (chaos)', () => {
    const k = paxosKernel(2026, ['A', 'B', 'C', 'D', 'E']);
    const chaos = new Rng(90210);
    const ids = k.nodeOrder;
    let cmd = 0;
    let firstBreak = '';
    for (let i = 0; i < 1200 && !firstBreak; i++) {
      k.advance(20);
      const up = ids.filter((id) => k.isUp(id));
      const down = ids.filter((id) => !k.isUp(id));
      const roll = chaos.next();
      if (roll < 0.04 && up.length > 1) k.crash(chaos.pick(up)!);
      else if (roll < 0.12 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.15) {
        const shuffled = chaos.shuffle(ids);
        const cut = chaos.int(1, ids.length - 1);
        k.partition([shuffled.slice(0, cut), shuffled.slice(cut)]);
      } else if (roll < 0.2) k.healNetwork();
      else if (roll < 0.4 && up.length > 0) {
        k.command(chaos.pick(up)!, { type: 'propose', value: setv('c', String(cmd), 'c' + cmd) });
        cmd++;
      }
      const bad = paxosInvariants(k.views()).find((iv) => !iv.ok);
      if (bad) firstBreak = `${bad.name}: ${bad.detail}`;
    }
    return [!firstBreak, firstBreak || 'Agreement, Quorum-backing & log integrity held through 1,200 faults'];
  });

  t('Paxos', 'After chaos heals, every live node converges to one chosen log', () => {
    const k = paxosKernel(4242, ['A', 'B', 'C', 'D', 'E']);
    const chaos = new Rng(13);
    const ids = k.nodeOrder;
    let cmd = 0;
    for (let i = 0; i < 700; i++) {
      k.advance(20);
      const up = ids.filter((id) => k.isUp(id));
      const roll = chaos.next();
      if (roll < 0.03 && up.length > 1) k.crash(chaos.pick(up)!);
      else if (roll < 0.1) {
        const down = ids.filter((id) => !k.isUp(id));
        if (down.length) k.restart(chaos.pick(down)!);
      } else if (roll < 0.13) {
        const sh = chaos.shuffle(ids);
        k.partition([sh.slice(0, 3), sh.slice(3)]);
      } else if (roll < 0.18) k.healNetwork();
      else if (roll < 0.4 && up.length > 0) {
        k.command(chaos.pick(up)!, { type: 'propose', value: setv('z', String(cmd), 'z' + cmd) });
        cmd++;
      }
    }
    // Heal everything and bring every node up, then let it settle fully.
    k.healNetwork();
    for (const id of ids) if (!k.isUp(id)) k.restart(id);
    settle(k, 400);
    const chosenSets = k.views().map((v) => JSON.stringify(v.state.chosen));
    const converged = new Set(chosenSets).size === 1;
    const ok = converged && paxosOk(k);
    return [ok, ok ? `all 5 nodes converged to one chosen log (${Object.keys(k.views()[0].state.chosen).length} slots)` : firstBad(k) || 'nodes did not converge'];
  });

  // ---- Vector clocks ----
  t('VectorClock', 'Receive vectors always dominate their send', () => {
    const k = new Kernel<VcState, VcCmd>({ seed: 3, protocol: createVClock(), nodeIds: ['A', 'B', 'C', 'D'] });
    for (let i = 0; i < 250; i++) k.advance(30);
    const inv = k.protocol.invariants!(k.views());
    const ok = inv.every((iv) => iv.ok);
    return [ok, ok ? 'causal-delivery invariant held over the whole run' : inv.find((iv) => !iv.ok)!.detail];
  });

  return out;
}
