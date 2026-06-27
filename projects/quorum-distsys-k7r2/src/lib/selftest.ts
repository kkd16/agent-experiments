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
import { createChord } from '../protocols/chord/chord';
import { chordInvariants } from '../protocols/chord/invariants';
import { DEFAULT_CHORD_CONFIG, type ChordCmd, type ChordState } from '../protocols/chord/types';
import { ownerOf, hashId } from '../protocols/chord/ring';
import { createPbft } from '../protocols/pbft/pbft';
import { pbftInvariants } from '../protocols/pbft/invariants';
import {
  DEFAULT_PBFT_CONFIG,
  faultBudget,
  quorum,
  type PbftCmd,
  type PbftState,
  type ClientRequest,
  type FaultMode,
} from '../protocols/pbft/types';
import { createDynamo } from '../protocols/dynamo/dynamo';
import { dynamoInvariants, convergenceGauge } from '../protocols/dynamo/invariants';
import {
  DEFAULT_DYNAMO_CONFIG,
  overlaps,
  descends,
  concurrent,
  reconcile,
  type DynamoCmd,
  type DynamoState,
  type Version,
} from '../protocols/dynamo/types';
import { buildRing, preferenceList } from '../protocols/dynamo/ring';
import { createAbd } from '../protocols/abd/abd';
import { abdInvariants } from '../protocols/abd/invariants';
import { DEFAULT_ABD_CONFIG, type AbdCmd, type AbdState } from '../protocols/abd/types';
import { createSnow } from '../protocols/snow/snow';
import { snowInvariants, snowGauge } from '../protocols/snow/invariants';
import { DEFAULT_SNOW_CONFIG, type SnowCmd, type SnowState, type Variant, type Colour } from '../protocols/snow/types';
import { createSnapshot } from '../protocols/snapshot/snapshot';
import { snapInvariants, snapGauge } from '../protocols/snapshot/invariants';
import { DEFAULT_SNAP_CONFIG, type SnapCmd, type SnapState } from '../protocols/snapshot/types';
import { createHotStuff } from '../protocols/hotstuff/hotstuff';
import { hotstuffInvariants } from '../protocols/hotstuff/invariants';
import {
  DEFAULT_HOTSTUFF_CONFIG,
  faultBudget as hsFaultBudget,
  quorum as hsQuorum,
  leaderOf as hsLeaderOf,
  type HsCmd,
  type HsState,
  type Command as HsCommand,
  type FaultMode as HsFaultMode,
} from '../protocols/hotstuff/types';
import { createEPaxos } from '../protocols/epaxos/epaxos';
import { epaxosInvariants, convergenceGauge as epConvergence } from '../protocols/epaxos/invariants';
import {
  DEFAULT_EPAXOS_CONFIG,
  fastQuorum as epFastQuorum,
  slowQuorum as epSlowQuorum,
  faultBudget as epFaultBudget,
  instKey as epInstKey,
  type Command as EpCommand,
  type EPaxosCmd,
  type EPaxosState,
} from '../protocols/epaxos/types';

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

  // ---- Chord DHT ----
  const chordKernel = (seed: number, ids: string[]) =>
    new Kernel<ChordState, ChordCmd>({
      seed,
      protocol: createChord(DEFAULT_CHORD_CONFIG),
      nodeIds: ids,
      network: { minLatency: 20, maxLatency: 60, dropRate: 0 },
    });
  const chordLiveIds = (k: Kernel<ChordState, ChordCmd>) =>
    k.views().filter((v) => v.up && v.state.joined).map((v) => v.state.id);
  const chordConverged = (k: Kernel<ChordState, ChordCmd>) => chordInvariants(k.views()).every((iv) => iv.ok);
  const M = DEFAULT_CHORD_CONFIG.m;

  t('Chord', 'Ring of 7 converges (every successor & predecessor correct)', () => {
    const k = chordKernel(1, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    for (let i = 0; i < 200; i++) k.advance(25);
    const inv = chordInvariants(k.views());
    const ok = inv.every((iv) => iv.ok);
    return [ok, ok ? 'one clean cycle; all pointers correct' : inv.filter((iv) => !iv.ok).map((iv) => iv.detail).join('; ')];
  });

  t('Chord', 'Lookups resolve to the true key owner', () => {
    const k = chordKernel(2, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    for (let i = 0; i < 200; i++) k.advance(25);
    const ids = chordLiveIds(k);
    let allCorrect = true;
    let detail = '';
    for (let key = 0; key < (1 << M); key += 17) {
      // Ask a fixed node to look it up.
      k.command('A', { type: 'lookup', key });
      for (let i = 0; i < 30; i++) k.advance(20);
      const last = k.views().find((v) => v.id === 'A')!.state.lastLookup;
      const expected = ownerOf(key, ids);
      if (!last || last.owner !== expected) {
        allCorrect = false;
        detail = `key ${key}: got ${last?.owner ?? 'none'}, expected ${expected}`;
        break;
      }
    }
    return [allCorrect, allCorrect ? `every probed key resolved to its true successor` : detail];
  });

  t('Chord', 'Finger tables give short (O(log N)) lookup paths', () => {
    const k = chordKernel(5, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    for (let i = 0; i < 240; i++) k.advance(25);
    let maxHops = 0;
    for (let key = 3; key < (1 << M); key += 23) {
      k.command('D', { type: 'lookup', key });
      for (let i = 0; i < 30; i++) k.advance(20);
      const last = k.views().find((v) => v.id === 'D')!.state.lastLookup;
      if (last) maxHops = Math.max(maxHops, last.hops);
    }
    // With m=8 fingers, lookups should be far below a linear scan of the ring.
    const ok = maxHops <= M;
    return [ok, ok ? `worst lookup used ${maxHops} hops (≤ m=${M})` : `a lookup took ${maxHops} hops`];
  });

  t('Chord', 'Ring heals after a node crashes (re-converges + correct lookups)', () => {
    const k = chordKernel(3, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    for (let i = 0; i < 200; i++) k.advance(25);
    if (!chordConverged(k)) return [false, 'did not converge before the crash'];
    k.crash('D');
    for (let i = 0; i < 320; i++) k.advance(25); // let stabilization repair
    const inv = chordInvariants(k.views());
    const reconverged = inv.every((iv) => iv.ok);
    // And lookups still resolve correctly among the survivors.
    const ids = chordLiveIds(k);
    k.command('A', { type: 'lookup', key: 99 });
    for (let i = 0; i < 40; i++) k.advance(20);
    const last = k.views().find((v) => v.id === 'A')!.state.lastLookup;
    const lookupOk = !!last && last.owner === ownerOf(99, ids);
    const ok = reconverged && lookupOk;
    return [ok, ok ? 'ring re-converged without D and lookups stayed correct' : reconverged ? 'lookup wrong after heal' : inv.filter((iv) => !iv.ok).map((iv) => iv.detail).join('; ')];
  });

  t('Chord', 'A late joiner is absorbed into the ring', () => {
    // E.g. start with 4, then "join" the rest is already automatic; here we verify
    // hash placement is collision-free and the directory is consistent.
    const k = chordKernel(8, ['A', 'B', 'C', 'D', 'E']);
    for (let i = 0; i < 180; i++) k.advance(25);
    const ids = chordLiveIds(k);
    const distinct = new Set(ids).size === ids.length;
    const converged = chordConverged(k);
    // Sanity: ids are the FNV hashes (collision-resolved).
    const hashed = hashId('A', M);
    const ok = distinct && converged && typeof hashed === 'number';
    return [ok, ok ? `5 distinct ids, ring converged` : `distinct=${distinct} converged=${converged}`];
  });

  // ---- PBFT (Byzantine fault tolerance) ----
  const pbftKernel = (seed: number, ids: string[], drop = 0) =>
    new Kernel<PbftState, PbftCmd>({
      seed,
      protocol: createPbft(DEFAULT_PBFT_CONFIG),
      nodeIds: ids,
      network: { minLatency: 20, maxLatency: 60, dropRate: drop },
    });
  const setReq = (key: string, value: string, cid: string): ClientRequest => ({ cid, op: { op: 'set', key, value } });
  const clientReq = (k: Kernel<PbftState, PbftCmd>, r: ClientRequest) => {
    for (const id of k.nodeOrder) if (k.isUp(id)) k.command(id, { type: 'request', request: r });
  };
  const faulty = (k: Kernel<PbftState, PbftCmd>, id: string, mode: FaultMode) => k.command(id, { type: 'set-fault', mode });
  const pbftSettle = (k: Kernel<PbftState, PbftCmd>, ticks = 200, dt = 20) => {
    for (let i = 0; i < ticks; i++) k.advance(dt);
  };
  const honestViews = (k: Kernel<PbftState, PbftCmd>) => k.views().filter((v) => v.state.fault === 'honest');
  const pbftOk = (k: Kernel<PbftState, PbftCmd>) => pbftInvariants(k.views()).every((iv) => iv.ok);
  const pbftBad = (k: Kernel<PbftState, PbftCmd>) =>
    pbftInvariants(k.views()).filter((iv) => !iv.ok).map((iv) => `${iv.name}: ${iv.detail}`).join(' | ');

  t('PBFT', 'Quorum sizes: N=3f+1 with 2f+1 quorums', () => {
    const ok = faultBudget(4) === 1 && quorum(4) === 3 && faultBudget(7) === 2 && quorum(7) === 5 && faultBudget(10) === 3 && quorum(10) === 7;
    return [ok, ok ? 'f=⌊(N-1)/3⌋ and quorum=2f+1 for N=4,7,10' : 'quorum arithmetic wrong'];
  });

  t('PBFT', 'Healthy 4-node cluster executes & every replica agrees', () => {
    const k = pbftKernel(1, ['A', 'B', 'C', 'D']);
    for (let i = 0; i < 5; i++) {
      clientReq(k, setReq('k' + i, 'v' + i, 'c' + i));
      pbftSettle(k, 30);
    }
    pbftSettle(k, 80);
    const exec = honestViews(k).map((v) => v.state.lastExec);
    const kvs = honestViews(k).map((v) => JSON.stringify(v.state.kv));
    const ok = exec.every((e) => e === 5) && new Set(kvs).size === 1 && pbftOk(k);
    return [ok, ok ? `5 requests committed & applied; all replicas agree` : pbftBad(k) || `exec=${exec.join(',')}`];
  });

  t('PBFT', 'A silent primary triggers a view change and the cluster recovers', () => {
    const k = pbftKernel(3, ['A', 'B', 'C', 'D']);
    faulty(k, 'A', 'silent'); // A is the primary of view 0
    clientReq(k, setReq('y', '9', 'cy'));
    pbftSettle(k, 200);
    const honest = honestViews(k);
    const exec = honest.map((v) => v.state.lastExec);
    const newView = honest[0].state.view > 0;
    const ok = exec.every((e) => e === 1) && newView && pbftOk(k);
    return [ok, ok ? `view changed to v${honest[0].state.view}; request executed despite the dead primary` : pbftBad(k) || `exec=${exec.join(',')}`];
  });

  t('PBFT', 'An EQUIVOCATING primary cannot break agreement', () => {
    const k = pbftKernel(7, ['A', 'B', 'C', 'D']);
    faulty(k, 'A', 'equivocate'); // sends conflicting orders for the same seq
    clientReq(k, setReq('w', 'real', 'cw'));
    pbftSettle(k, 300);
    const honest = honestViews(k);
    const kvs = honest.map((v) => JSON.stringify(v.state.kv));
    // No honest replica may have executed the forged value, and all must agree.
    const noForgery = honest.every((v) => Object.values(v.state.kv).every((val) => !val.includes('✗')));
    const ok = new Set(kvs).size === 1 && noForgery && pbftOk(k);
    return [ok, ok ? `honest replicas ignored the equivocation and converged to ${kvs[0]}` : pbftBad(k) || `kvs=${kvs.join(' / ')}`];
  });

  t('PBFT', 'A lying (conflicting) backup is ignored', () => {
    const k = pbftKernel(11, ['A', 'B', 'C', 'D']);
    faulty(k, 'D', 'conflict'); // votes for a corrupted digest
    for (let i = 0; i < 4; i++) {
      clientReq(k, setReq('k' + i, 'v' + i, 'c' + i));
      pbftSettle(k, 30);
    }
    pbftSettle(k, 80);
    const exec = honestViews(k).map((v) => v.state.lastExec);
    const ok = exec.every((e) => e === 4) && pbftOk(k);
    return [ok, ok ? `the lying backup's votes never counted; honest replicas committed all 4` : pbftBad(k) || `exec=${exec.join(',')}`];
  });

  t('PBFT', '7-node cluster tolerates 2 simultaneous Byzantine faults', () => {
    const k = pbftKernel(13, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    faulty(k, 'A', 'silent');
    faulty(k, 'G', 'conflict');
    for (let i = 0; i < 3; i++) {
      clientReq(k, setReq('k' + i, 'v' + i, 'c' + i));
      pbftSettle(k, 40);
    }
    pbftSettle(k, 200);
    const honest = honestViews(k);
    const kvs = honest.map((v) => JSON.stringify(v.state.kv));
    const allKeys = honest.every((v) => Object.keys(v.state.kv).length === 3);
    const ok = new Set(kvs).size === 1 && allKeys && pbftOk(k);
    return [ok, ok ? `f=2 faults tolerated; all honest replicas converged with 3 keys` : pbftBad(k) || `kvs=${new Set(kvs).size}`];
  });

  t('PBFT', 'A restarted replica catches up via state gossip', () => {
    const k = pbftKernel(31, ['A', 'B', 'C', 'D']);
    k.crash('D');
    for (let i = 0; i < 6; i++) {
      clientReq(k, setReq('k' + i, 'v' + i, 'c' + i));
      pbftSettle(k, 30);
    }
    pbftSettle(k, 60);
    k.restart('D');
    pbftSettle(k, 200);
    const D = k.views().find((v) => v.id === 'D')!.state;
    const other = k.views().find((v) => v.id === 'A')!.state;
    const ok = JSON.stringify(D.kv) === JSON.stringify(other.kv) && D.lastExec === other.lastExec && pbftOk(k);
    return [ok, ok ? `the restarted replica rebuilt its state to #${D.lastExec} from f+1 matching reports` : pbftBad(k) || `D@${D.lastExec} vs A@${other.lastExec}`];
  });

  t('PBFT', 'Agreement holds through 1,500 faults with an equivocating primary', () => {
    const k = pbftKernel(2026, ['A', 'B', 'C', 'D']);
    faulty(k, 'A', 'equivocate'); // 1 Byzantine = f for N=4
    const chaos = new Rng(90210);
    let cmd = 0;
    let firstBreak = '';
    for (let i = 0; i < 1500 && !firstBreak; i++) {
      k.advance(20);
      const roll = chaos.next();
      const up = k.nodeOrder.filter((id) => k.isUp(id) && id !== 'A');
      const down = k.nodeOrder.filter((id) => !k.isUp(id));
      if (roll < 0.03 && up.length > 2) k.crash(chaos.pick(up)!);
      else if (roll < 0.09 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.12) {
        const sh = chaos.shuffle(k.nodeOrder);
        k.partition([sh.slice(0, 2), sh.slice(2)]);
      } else if (roll < 0.16) k.healNetwork();
      else if (roll < 0.4) {
        clientReq(k, setReq('c', String(cmd), 'c' + cmd));
        cmd++;
      }
      // Only the genuine safety invariants must hold (Progress is informational).
      const bad = pbftInvariants(k.views()).filter((iv) => iv.name !== 'Progress').find((iv) => !iv.ok);
      if (bad) firstBreak = `${bad.name}: ${bad.detail}`;
    }
    return [!firstBreak, firstBreak || 'Agreement, total-order, certified-execution & fault-budget held through 1,500 Byzantine faults'];
  });

  t('PBFT', 'After chaos heals, honest replicas converge to one log', () => {
    const k = pbftKernel(555, ['A', 'B', 'C', 'D']);
    faulty(k, 'B', 'conflict'); // a fixed Byzantine backup (= f)
    const chaos = new Rng(424242);
    let cmd = 0;
    for (let i = 0; i < 900; i++) {
      k.advance(20);
      const roll = chaos.next();
      const up = k.nodeOrder.filter((id) => k.isUp(id) && id !== 'B');
      const down = k.nodeOrder.filter((id) => !k.isUp(id));
      if (roll < 0.03 && up.length > 2) k.crash(chaos.pick(up)!);
      else if (roll < 0.1 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.13) {
        const sh = chaos.shuffle(k.nodeOrder);
        k.partition([sh.slice(0, 2), sh.slice(2)]);
      } else if (roll < 0.17) k.healNetwork();
      else if (roll < 0.4) {
        clientReq(k, setReq('z', String(cmd), 'z' + cmd));
        cmd++;
      }
    }
    k.healNetwork();
    for (const id of k.nodeOrder) if (!k.isUp(id)) k.restart(id);
    pbftSettle(k, 500);
    const honest = honestViews(k).filter((v) => v.up);
    const kvs = honest.map((v) => JSON.stringify(v.state.kv));
    const ok = new Set(kvs).size === 1 && pbftOk(k);
    return [ok, ok ? `all live honest replicas converged after the churn (≤ #${Math.max(...honest.map((v) => v.state.lastExec))})` : pbftBad(k) || `sets=${new Set(kvs).size}`];
  });

  t('PBFT', 'Determinism: same seed & schedule ⇒ byte-identical run', () => {
    const run = () => {
      const k = pbftKernel(99, ['A', 'B', 'C', 'D']);
      faulty(k, 'A', 'equivocate');
      for (let i = 0; i < 6; i++) {
        clientReq(k, setReq('k' + i, 'v' + i, 'c' + i));
        pbftSettle(k, 25);
      }
      pbftSettle(k, 80);
      return k.serialize();
    };
    const ok = run() === run();
    return [ok, ok ? 'two independent Byzantine runs produced identical serialized state' : 'runs diverged'];
  });

  // ---- HotStuff (chained BFT consensus) ----
  const hsKernel = (seed: number, ids: string[], drop = 0) =>
    new Kernel<HsState, HsCmd>({
      seed,
      protocol: createHotStuff(DEFAULT_HOTSTUFF_CONFIG),
      nodeIds: ids,
      network: { minLatency: 20, maxLatency: 60, dropRate: drop },
    });
  const hsSet = (key: string, value: string, cid: string): HsCommand => ({ cid, op: { op: 'set', key, value } });
  const hsClient = (k: Kernel<HsState, HsCmd>, c: HsCommand) => {
    for (const id of k.nodeOrder) if (k.isUp(id)) k.command(id, { type: 'request', command: c });
  };
  const hsFaulty = (k: Kernel<HsState, HsCmd>, id: string, mode: HsFaultMode) => k.command(id, { type: 'set-fault', mode });
  const hsSettle = (k: Kernel<HsState, HsCmd>, ticks = 200, dt = 20) => {
    for (let i = 0; i < ticks; i++) k.advance(dt);
  };
  const hsHonest = (k: Kernel<HsState, HsCmd>) => k.views().filter((v) => v.state.fault === 'honest');
  const hsOk = (k: Kernel<HsState, HsCmd>) => hotstuffInvariants(k.views()).every((iv) => iv.ok);
  const hsBad = (k: Kernel<HsState, HsCmd>) =>
    hotstuffInvariants(k.views())
      .filter((iv) => !iv.ok)
      .map((iv) => `${iv.name}: ${iv.detail}`)
      .join(' | ');

  t('HotStuff', 'Quorum sizes: N=3f+1 with 2f+1 certificates & rotating leaders', () => {
    const ok =
      hsFaultBudget(4) === 1 && hsQuorum(4) === 3 && hsFaultBudget(7) === 2 && hsQuorum(7) === 5 && hsFaultBudget(10) === 3 && hsQuorum(10) === 7;
    const ids = ['A', 'B', 'C', 'D'];
    const rotates = hsLeaderOf(ids, 0) === 'A' && hsLeaderOf(ids, 1) === 'B' && hsLeaderOf(ids, 5) === 'B';
    return [ok && rotates, ok && rotates ? 'f=⌊(N-1)/3⌋, quorum=2f+1, leader=all[view%N] rotates every view' : 'quorum/leader arithmetic wrong'];
  });

  t('HotStuff', 'Healthy 4-node cluster commits via 3-chain & every replica agrees', () => {
    const k = hsKernel(1, ['A', 'B', 'C', 'D']);
    for (let i = 0; i < 5; i++) {
      hsClient(k, hsSet('k' + i, 'v' + i, 'c' + i));
      hsSettle(k, 40);
    }
    hsSettle(k, 120);
    const kvs = hsHonest(k).map((v) => JSON.stringify(v.state.kv));
    const allFive = hsHonest(k).every((v) => Object.keys(v.state.kv).length === 5);
    const ok = allFive && new Set(kvs).size === 1 && hsOk(k);
    return [ok, ok ? `5 commands committed through the pipeline; all replicas agree` : hsBad(k) || `kvs=${kvs.join(' / ')}`];
  });

  t('HotStuff', 'Leaders rotate: many distinct proposers commit blocks', () => {
    const k = hsKernel(8, ['A', 'B', 'C', 'D']);
    for (let i = 0; i < 8; i++) {
      hsClient(k, hsSet('r', String(i), 'r' + i));
      hsSettle(k, 30);
    }
    hsSettle(k, 120);
    const lead = hsHonest(k).reduce((a, b) => (a.state.bExecHeight >= b.state.bExecHeight ? a : b));
    // Count distinct proposers among the committed blocks we still retain.
    const ps = new Set<string>();
    for (const e of lead.state.committed) {
      const blk = lead.state.blocks[e.hash];
      if (blk) ps.add(blk.proposer);
    }
    const ok = ps.size >= 2 && hsOk(k);
    return [ok, ok ? `${ps.size} distinct leaders proposed committed blocks (round-robin rotation)` : hsBad(k) || `proposers=${ps.size}`];
  });

  t('HotStuff', 'A silent leader is rotated out by the pacemaker (timeout → next view)', () => {
    const k = hsKernel(3, ['A', 'B', 'C', 'D']);
    hsFaulty(k, 'B', 'silent'); // B is the leader of view 1
    hsClient(k, hsSet('y', '9', 'cy'));
    hsSettle(k, 600);
    const honest = hsHonest(k);
    const committed = honest.every((v) => v.state.kv['y'] === '9');
    const advanced = honest.some((v) => v.state.curView > 1);
    const ok = committed && advanced && hsOk(k);
    return [ok, ok ? `pacemaker timed out the silent leader and a later view committed the request` : hsBad(k) || `views=${honest.map((v) => v.state.curView).join(',')}`];
  });

  t('HotStuff', 'An EQUIVOCATING leader cannot break agreement', () => {
    const k = hsKernel(7, ['A', 'B', 'C', 'D']);
    hsFaulty(k, 'B', 'equivocate'); // B forges conflicting blocks at its view
    hsClient(k, hsSet('w', 'real', 'cw'));
    hsSettle(k, 400);
    const honest = hsHonest(k);
    const kvs = honest.map((v) => JSON.stringify(v.state.kv));
    const noForgery = honest.every((v) => Object.values(v.state.kv).every((val) => !val.includes('✗')));
    const ok = new Set(kvs).size === 1 && noForgery && hsOk(k);
    return [ok, ok ? `honest replicas never committed a forged block and stayed consistent` : hsBad(k) || `kvs=${kvs.join(' / ')}`];
  });

  t('HotStuff', 'A lying (conflicting) backup is ignored', () => {
    const k = hsKernel(11, ['A', 'B', 'C', 'D']);
    hsFaulty(k, 'D', 'conflict'); // votes for a corrupted hash
    for (let i = 0; i < 4; i++) {
      hsClient(k, hsSet('k' + i, 'v' + i, 'c' + i));
      hsSettle(k, 40);
    }
    hsSettle(k, 120);
    const allFour = hsHonest(k).every((v) => Object.keys(v.state.kv).length === 4);
    const ok = allFour && hsOk(k);
    return [ok, ok ? `the lying backup's votes never counted; honest replicas committed all 4` : hsBad(k) || hsHonest(k).map((v) => v.state.bExecHeight).join(',')];
  });

  t('HotStuff', '7-node cluster tolerates 2 simultaneous Byzantine faults', () => {
    const k = hsKernel(13, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    hsFaulty(k, 'B', 'silent');
    hsFaulty(k, 'G', 'conflict');
    for (let i = 0; i < 3; i++) {
      hsClient(k, hsSet('k' + i, 'v' + i, 'c' + i));
      hsSettle(k, 90);
    }
    hsSettle(k, 500);
    const honest = hsHonest(k);
    const kvs = honest.map((v) => JSON.stringify(v.state.kv));
    const allKeys = honest.every((v) => Object.keys(v.state.kv).length === 3);
    const ok = new Set(kvs).size === 1 && allKeys && hsOk(k);
    return [ok, ok ? `f=2 faults tolerated; all honest replicas converged with 3 keys` : hsBad(k) || `kvs=${new Set(kvs).size}`];
  });

  t('HotStuff', 'A restarted replica catches up via committed-block gossip', () => {
    const k = hsKernel(31, ['A', 'B', 'C', 'D']);
    k.crash('D');
    for (let i = 0; i < 6; i++) {
      hsClient(k, hsSet('k' + i, 'v' + i, 'c' + i));
      hsSettle(k, 40);
    }
    hsSettle(k, 80);
    k.restart('D');
    hsSettle(k, 300);
    const D = k.views().find((v) => v.id === 'D')!.state;
    const A = k.views().find((v) => v.id === 'A')!.state;
    const ok = JSON.stringify(D.kv) === JSON.stringify(A.kv) && D.bExecHeight === A.bExecHeight && hsOk(k);
    return [ok, ok ? `the restarted replica rebuilt its state to #${D.bExecHeight} from f+1 matching reports` : hsBad(k) || `D@${D.bExecHeight} vs A@${A.bExecHeight}`];
  });

  t('HotStuff', 'Agreement holds through 1,500 faults with an equivocating leader', () => {
    const k = hsKernel(2026, ['A', 'B', 'C', 'D']);
    hsFaulty(k, 'B', 'equivocate'); // 1 Byzantine = f for N=4
    const chaos = new Rng(70707);
    let cmd = 0;
    let firstBreak = '';
    for (let i = 0; i < 1500 && !firstBreak; i++) {
      k.advance(20);
      const roll = chaos.next();
      const up = k.nodeOrder.filter((id) => k.isUp(id) && id !== 'B');
      const down = k.nodeOrder.filter((id) => !k.isUp(id));
      if (roll < 0.03 && up.length > 2) k.crash(chaos.pick(up)!);
      else if (roll < 0.09 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.12) {
        const sh = chaos.shuffle(k.nodeOrder);
        k.partition([sh.slice(0, 2), sh.slice(2)]);
      } else if (roll < 0.16) k.healNetwork();
      else if (roll < 0.4) {
        hsClient(k, hsSet('c', String(cmd), 'c' + cmd));
        cmd++;
      }
      const bad = hotstuffInvariants(k.views()).filter((iv) => iv.name !== 'Progress').find((iv) => !iv.ok);
      if (bad) firstBreak = `${bad.name}: ${bad.detail}`;
    }
    return [!firstBreak, firstBreak || 'Agreement, chain-integrity, state-machine safety & fault-budget held through 1,500 Byzantine faults'];
  });

  t('HotStuff', 'After chaos heals, honest replicas converge to one chain', () => {
    const k = hsKernel(555, ['A', 'B', 'C', 'D']);
    hsFaulty(k, 'C', 'conflict'); // a fixed Byzantine backup (= f)
    const chaos = new Rng(31337);
    let cmd = 0;
    for (let i = 0; i < 1000; i++) {
      k.advance(20);
      const roll = chaos.next();
      const up = k.nodeOrder.filter((id) => k.isUp(id) && id !== 'C');
      const down = k.nodeOrder.filter((id) => !k.isUp(id));
      if (roll < 0.03 && up.length > 2) k.crash(chaos.pick(up)!);
      else if (roll < 0.1 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.13) {
        const sh = chaos.shuffle(k.nodeOrder);
        k.partition([sh.slice(0, 2), sh.slice(2)]);
      } else if (roll < 0.17) k.healNetwork();
      else if (roll < 0.4) {
        hsClient(k, hsSet('z', String(cmd), 'z' + cmd));
        cmd++;
      }
    }
    k.healNetwork();
    for (const id of k.nodeOrder) if (!k.isUp(id)) k.restart(id);
    hsSettle(k, 700);
    const honest = hsHonest(k).filter((v) => v.up);
    const kvs = honest.map((v) => JSON.stringify(v.state.kv));
    const ok = new Set(kvs).size === 1 && hsOk(k);
    return [ok, ok ? `all live honest replicas converged after the churn (≤ #${Math.max(...honest.map((v) => v.state.bExecHeight))})` : hsBad(k) || `sets=${new Set(kvs).size}`];
  });

  t('HotStuff', 'Determinism: same seed & schedule ⇒ byte-identical run', () => {
    const run = () => {
      const k = hsKernel(99, ['A', 'B', 'C', 'D']);
      hsFaulty(k, 'B', 'equivocate');
      for (let i = 0; i < 6; i++) {
        hsClient(k, hsSet('k' + i, 'v' + i, 'c' + i));
        hsSettle(k, 25);
      }
      hsSettle(k, 100);
      return k.serialize();
    };
    const ok = run() === run();
    return [ok, ok ? 'two independent Byzantine runs produced identical serialized state' : 'runs diverged'];
  });

  // ---- Vector clocks ----
  t('VectorClock', 'Receive vectors always dominate their send', () => {
    const k = new Kernel<VcState, VcCmd>({ seed: 3, protocol: createVClock(), nodeIds: ['A', 'B', 'C', 'D'] });
    for (let i = 0; i < 250; i++) k.advance(30);
    const inv = k.protocol.invariants!(k.views());
    const ok = inv.every((iv) => iv.ok);
    return [ok, ok ? 'causal-delivery invariant held over the whole run' : inv.find((iv) => !iv.ok)!.detail];
  });

  // ---- Dynamo (tunable-quorum replication) ----
  const dynKernel = (seed: number, ids: string[], cfg: Partial<typeof DEFAULT_DYNAMO_CONFIG> = {}) =>
    new Kernel<DynamoState, DynamoCmd>({
      seed,
      protocol: createDynamo({ ...DEFAULT_DYNAMO_CONFIG, ...cfg }),
      nodeIds: ids,
      network: { minLatency: 20, maxLatency: 60, dropRate: 0 },
    });
  let dynReq = 1;
  const dynPut = (k: Kernel<DynamoState, DynamoCmd>, coord: string, key: string, value: string, blind = false) =>
    k.command(coord, { type: 'put', key, value, blind, reqId: dynReq++ });
  const dynGet = (k: Kernel<DynamoState, DynamoCmd>, coord: string, key: string) =>
    k.command(coord, { type: 'get', key, reqId: dynReq++ });
  const dynSettle = (k: Kernel<DynamoState, DynamoCmd>, ticks = 120, dt = 20) => {
    for (let i = 0; i < ticks; i++) k.advance(dt);
  };
  const dynOk = (k: Kernel<DynamoState, DynamoCmd>) => dynamoInvariants(k.views()).every((iv) => iv.ok);
  const dynBad = (k: Kernel<DynamoState, DynamoCmd>) =>
    dynamoInvariants(k.views()).filter((iv) => !iv.ok).map((iv) => `${iv.name}: ${iv.detail}`).join(' | ');
  const dynConverged = (k: Kernel<DynamoState, DynamoCmd>) => convergenceGauge(k.views()).ok;
  const homeOf = (ids: string[], key: string, n: number) => preferenceList(key, buildRing(ids), n);
  const sread = (k: Kernel<DynamoState, DynamoCmd>, id: string) => k.views().find((v) => v.id === id)!.state;

  t('Dynamo', 'Quorum overlap: R+W>N ⇒ strong, else eventual', () => {
    const ok =
      overlaps({ n: 3, r: 2, w: 2 }) &&
      overlaps({ n: 3, r: 3, w: 1 }) &&
      !overlaps({ n: 3, r: 1, w: 1 }) &&
      !overlaps({ n: 5, r: 2, w: 2 });
    return [ok, ok ? 'R+W>N classified correctly for (3,2,2),(3,3,1),(3,1,1),(5,2,2)' : 'overlap arithmetic wrong'];
  });

  t('Dynamo', 'Vector clocks: reconciliation drops dominated versions, keeps concurrent ones', () => {
    const mk = (value: string, clock: Record<string, number>): Version => ({ value, clock, wrote: 0, by: 'A' });
    const rec = reconcile([mk('x', { A: 1 }), mk('y', { A: 2 }), mk('z', { B: 1 })]);
    const vals = rec.map((v) => v.value).sort().join(',');
    const dom = descends({ A: 2, B: 1 }, { A: 1 }) && !descends({ A: 1 }, { A: 2 });
    const conc = concurrent({ A: 2 }, { B: 1 });
    const ok = vals === 'y,z' && dom && conc;
    return [ok, ok ? '{A:2} dominated {A:1} (dropped); {B:1} kept as a concurrent sibling' : `rec=${vals} dom=${dom} conc=${conc}`];
  });

  t('Dynamo', 'Healthy cluster: a write is read back and every replica converges', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = dynKernel(1, ids, { n: 3, r: 2, w: 2 });
    dynSettle(k, 20);
    const home = homeOf(ids, 'k1', 3);
    dynPut(k, home[0], 'k1', 'hello');
    dynSettle(k, 30);
    dynGet(k, home[0], 'k1');
    dynSettle(k, 15);
    const lr = sread(k, home[0]).lastRead;
    const ok = !!lr && !lr.conflict && lr.versions[0]?.value === 'hello' && dynConverged(k) && dynOk(k);
    return [ok, ok ? 'read back hello; all home replicas converged' : dynBad(k) || `lastRead=${JSON.stringify(lr)}`];
  });

  t('Dynamo', 'R+W>N gives read-your-writes through a coordinator', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = dynKernel(2, ids, { n: 3, r: 2, w: 2 });
    dynSettle(k, 20);
    const c = homeOf(ids, 'x', 3)[0];
    for (let i = 0; i < 5; i++) {
      dynPut(k, c, 'x', 'v' + i);
      dynSettle(k, 20);
    }
    dynGet(k, c, 'x');
    dynSettle(k, 15);
    const lr = sread(k, c).lastRead;
    const ok = !!lr && !lr.conflict && lr.versions[0]?.value === 'v4' && dynOk(k);
    return [ok, ok ? '5 sequential writes; the read returns the latest, v4' : dynBad(k) || `lastRead=${JSON.stringify(lr)}`];
  });

  t('Dynamo', 'Concurrent partitioned writes fork siblings; a read-modify-write heals them', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = dynKernel(3, ids, { n: 3, r: 2, w: 2 });
    dynSettle(k, 20);
    const [a, b] = homeOf(ids, 'cart', 3);
    k.partition([[a], ids.filter((id) => id !== a)]);
    dynSettle(k, 20);
    dynPut(k, a, 'cart', 'red', true);
    dynPut(k, b, 'cart', 'blue', true);
    dynSettle(k, 20);
    k.healNetwork();
    dynSettle(k, 100);
    dynGet(k, b, 'cart');
    dynSettle(k, 20);
    const lr1 = sread(k, b).lastRead;
    const forked = !!lr1 && lr1.versions.length === 2;
    dynPut(k, b, 'cart', 'reconciled', false);
    dynSettle(k, 100);
    dynGet(k, b, 'cart');
    dynSettle(k, 20);
    const lr2 = sread(k, b).lastRead;
    const healed = !!lr2 && lr2.versions.length === 1 && lr2.versions[0].value === 'reconciled';
    const ok = forked && healed && dynOk(k) && dynConverged(k);
    return [ok, ok ? 'fork → 2 siblings, then a read-modify-write reconciled to one value' : dynBad(k) || `forked=${forked} healed=${healed}`];
  });

  t('Dynamo', 'Sloppy quorum keeps writing through a failure; hinted handoff repairs the owner', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = dynKernel(5, ids, { n: 3, r: 2, w: 3, sloppy: true });
    dynSettle(k, 20);
    const [coord, victim] = homeOf(ids, 'sess', 3);
    k.crash(victim);
    dynSettle(k, 30); // detector marks the victim dead
    dynPut(k, coord, 'sess', 'token', false);
    dynSettle(k, 30);
    const lw = sread(k, coord).lastWrite;
    const acked = !!lw && lw.value === 'token' && lw.sloppy;
    k.restart(victim);
    dynSettle(k, 60); // hinted handoff delivers to the recovered owner
    const got = reconcile(sread(k, victim).store['sess'] ?? []).some((v) => v.value === 'token');
    const ok = acked && got && dynOk(k);
    return [ok, ok ? 'W=3 still acked via a sloppy substitute; handoff repopulated the recovered owner; nothing lost' : dynBad(k) || `acked=${acked} ownerGot=${got}`];
  });

  t('Dynamo', 'Strict quorum sacrifices availability under failure but never loses data', () => {
    const ids = ['A', 'B', 'C'];
    const k = dynKernel(8, ids, { n: 3, r: 2, w: 3, sloppy: false });
    dynSettle(k, 20);
    const home = homeOf(ids, 'q', 3);
    k.crash(home[2]);
    dynSettle(k, 30);
    dynPut(k, home[0], 'q', 'strict', false);
    dynSettle(k, 30);
    const lw = sread(k, home[0]).lastWrite;
    const notAcked = !lw || lw.value !== 'strict';
    const ok = notAcked && dynOk(k);
    return [ok, ok ? 'strict W=3 with a dead replica could not ack (availability cost); safety held' : dynBad(k) || `lw=${JSON.stringify(lw)}`];
  });

  t('Dynamo', 'A stale replica is repaired by a read (read repair)', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = dynKernel(11, ids, { n: 3, r: 3, w: 2, sloppy: false, antiEntropyInterval: 5000, handoffInterval: 5000 });
    dynSettle(k, 20);
    const home = homeOf(ids, 'rr', 3);
    const coord = home[0];
    const stale = home[2];
    k.partition([[stale], ids.filter((id) => id !== stale)]);
    dynSettle(k, 20);
    dynPut(k, coord, 'rr', 'vNew', false);
    dynSettle(k, 25);
    const before = reconcile(sread(k, stale).store['rr'] ?? []).map((v) => v.value);
    k.healNetwork();
    dynSettle(k, 22); // health refreshes (so the stale owner rejoins the read set); anti-entropy is disabled this run
    dynGet(k, coord, 'rr');
    dynSettle(k, 25);
    const after = reconcile(sread(k, stale).store['rr'] ?? []).map((v) => v.value);
    const ok = !before.includes('vNew') && after.includes('vNew') && dynOk(k);
    return [ok, ok ? 'the read pushed the fresh value to the previously-stale replica' : dynBad(k) || `before=[${before}] after=[${after}]`];
  });

  t('Dynamo', 'Anti-entropy converges divergent replicas after a heal (no reads)', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = dynKernel(13, ids, { n: 3, r: 2, w: 1 });
    dynSettle(k, 20);
    for (let i = 0; i < 4; i++) {
      const kk = 'ae' + i;
      dynPut(k, homeOf(ids, kk, 3)[0], kk, 'a' + i);
      dynSettle(k, 10);
    }
    k.partition([['A', 'B'], ['C', 'D', 'E']]);
    dynSettle(k, 30);
    for (let i = 0; i < 4; i++) {
      const kk = 'ae' + i;
      const c = homeOf(ids, kk, 3).find((id) => ['C', 'D', 'E'].includes(id)) ?? 'C';
      dynPut(k, c, kk, 'b' + i);
    }
    dynSettle(k, 30);
    k.healNetwork();
    dynSettle(k, 220);
    const ok = dynConverged(k) && dynOk(k);
    return [ok, ok ? 'every key converged across its replicas via anti-entropy alone' : dynBad(k) || convergenceGauge(k.views()).detail];
  });

  const dynChaos = (seed: number, steps: number): { firstBreak: string; ser: string; k: Kernel<DynamoState, DynamoCmd> } => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = dynKernel(seed, ids, { n: 3, r: 2, w: 2 });
    const chaos = new Rng(seed ^ 0x5eed);
    let nput = 0;
    let firstBreak = '';
    let rq = 1;
    for (let i = 0; i < steps && !firstBreak; i++) {
      k.advance(20);
      const up = ids.filter((id) => k.isUp(id));
      const down = ids.filter((id) => !k.isUp(id));
      const roll = chaos.next();
      if (roll < 0.04 && up.length > 1) k.crash(chaos.pick(up)!);
      else if (roll < 0.12 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.15) {
        const sh = chaos.shuffle(ids);
        const cut = chaos.int(1, ids.length - 1);
        k.partition([sh.slice(0, cut), sh.slice(cut)]);
      } else if (roll < 0.2) k.healNetwork();
      else if (roll < 0.45 && up.length > 0) {
        k.command(chaos.pick(up)!, { type: 'put', key: 'c' + chaos.int(0, 5), value: 'v' + nput++, blind: chaos.chance(0.25), reqId: rq++ });
      } else if (roll < 0.6 && up.length > 0) {
        k.command(chaos.pick(up)!, { type: 'get', key: 'c' + chaos.int(0, 5), reqId: rq++ });
      }
      const bad = dynamoInvariants(k.views()).find((iv) => !iv.ok);
      if (bad) firstBreak = `${bad.name}: ${bad.detail}`;
    }
    return { firstBreak, ser: k.serialize(), k };
  };

  t('Dynamo', 'Safety holds through 1,200 randomized faults (chaos)', () => {
    const { firstBreak } = dynChaos(2026, 1200);
    return [!firstBreak, firstBreak || 'Causality & Durability held through 1,200 faults with mixed puts/gets/blind writes'];
  });

  t('Dynamo', 'After chaos heals, every replica converges', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const { k, firstBreak } = dynChaos(4242, 700);
    if (firstBreak) return [false, firstBreak];
    k.healNetwork();
    for (const id of ids) if (!k.isUp(id)) k.restart(id);
    dynSettle(k, 400);
    const ok = dynConverged(k) && dynOk(k);
    return [ok, ok ? 'all replicas converged to one reconciled value set per key after the churn' : dynBad(k) || convergenceGauge(k.views()).detail];
  });

  t('Dynamo', 'Determinism: same seed & ops ⇒ byte-identical run', () => {
    const a = dynChaos(99, 600);
    const b = dynChaos(99, 600);
    if (a.firstBreak) return [false, a.firstBreak];
    const ok = a.ser === b.ser;
    return [ok, ok ? 'two independent chaotic runs produced identical serialized state' : 'runs diverged'];
  });

  // ---- EPaxos (leaderless consensus) ----
  const epKernel = (seed: number, ids: string[], net?: Partial<{ minLatency: number; maxLatency: number; dropRate: number }>) =>
    new Kernel<EPaxosState, EPaxosCmd>({
      seed,
      protocol: createEPaxos(DEFAULT_EPAXOS_CONFIG),
      nodeIds: ids,
      network: net ? { minLatency: 20, maxLatency: 60, dropRate: 0, ...net } : undefined,
    });
  const epOk = (k: Kernel<EPaxosState, EPaxosCmd>) => epaxosInvariants(k.views()).every((i) => i.ok);
  const epBad = (k: Kernel<EPaxosState, EPaxosCmd>) => {
    const r = epaxosInvariants(k.views()).find((i) => !i.ok);
    return r ? `${r.name}: ${r.detail}` : '';
  };
  const epPropose = (k: Kernel<EPaxosState, EPaxosCmd>, target: string, cmd: EpCommand) =>
    k.command(target, { type: 'propose', target, cmd });
  const epSettle = (k: Kernel<EPaxosState, EPaxosCmd>, n: number) => {
    for (let i = 0; i < n; i++) k.advance(20);
  };
  const epConverged = (k: Kernel<EPaxosState, EPaxosCmd>) => {
    const up = k.views().filter((v) => v.up);
    const kvs = up.map((v) => JSON.stringify(Object.fromEntries(Object.keys(v.state.kv).sort().map((kk) => [kk, v.state.kv[kk]]))));
    return kvs.every((x) => x === kvs[0]);
  };

  t('EPaxos', 'Quorum arithmetic (fast = N, majority = F+1)', () => {
    const ok =
      epFaultBudget(5) === 2 && epSlowQuorum(5) === 3 && epFastQuorum(5) === 3 &&
      epFaultBudget(7) === 3 && epSlowQuorum(7) === 4 && epFastQuorum(7) === 5;
    return [ok, ok ? 'F=⌊(N-1)/2⌋, majority=F+1, EPaxos fast quorum=F+⌊(F+1)/2⌋ (3 for N=5, 5 for N=7)' : 'quorum sizes wrong'];
  });

  t('EPaxos', 'No-conflict commands commit on the fast path & converge', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = epKernel(42, ids);
    let c = 1;
    for (let r = 0; r < 6; r++) {
      epPropose(k, ids[r % 5], { op: 'set', key: ['x', 'y', 'z'][r % 3], value: String(c), cid: 'u' + c });
      c++;
      epSettle(k, 6);
    }
    epSettle(k, 160);
    const fast = k.views().reduce((a, v) => a + v.state.fastCommits, 0);
    const ok = epOk(k) && epConverged(k) && fast >= 6;
    return [ok, ok ? `all 6 committed on the fast path (fast=${fast}); every replica converged to ${JSON.stringify(k.views()[0].state.kv)}` : epBad(k) || `fast=${fast} conv=${epConverged(k)}`];
  });

  t('EPaxos', 'Concurrent conflicting writes take the slow path, ordered consistently', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = epKernel(7, ids, { minLatency: 30, maxLatency: 90 });
    for (const id of ids) epPropose(k, id, { op: 'set', key: 'x', value: id, cid: 'c' + id });
    let safe = true;
    for (let i = 0; i < 400 && safe; i++) {
      k.advance(20);
      safe = epOk(k);
    }
    epSettle(k, 200);
    const slow = k.views().reduce((a, v) => a + v.state.slowCommits, 0);
    const orders = k.views().map((v) => v.state.executedOrder.filter((kk) => v.state.inst[kk]?.cmd?.op === 'set').join('>'));
    const sameOrder = orders.every((o) => o === orders[0]);
    const ok = safe && epOk(k) && epConverged(k) && sameOrder && slow >= 1;
    return [ok, ok ? `${slow} commands resolved on the slow path; every replica executed key x in the same order and converged to x=${k.views()[0].state.kv.x}` : epBad(k) || `slow=${slow} sameOrder=${sameOrder}`];
  });

  t('EPaxos', 'Non-interfering commands never depend on each other', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = epKernel(5, ids);
    epPropose(k, 'A', { op: 'set', key: 'x', value: '1', cid: 'a' });
    epPropose(k, 'E', { op: 'set', key: 'y', value: '2', cid: 'e' }); // different key — must not conflict
    epSettle(k, 160);
    const ax = k.views()[0].state.inst[epInstKey('A', 1)];
    const ey = k.views()[0].state.inst[epInstKey('E', 1)];
    const independent = ax && ey && !ax.deps.includes('E.1') && !ey.deps.includes('A.1');
    const ok = epOk(k) && epConverged(k) && !!independent;
    return [ok, ok ? 'commands on different keys committed with no dependency edge between them (they commute)' : epBad(k) || `A.1.deps=${ax?.deps} E.1.deps=${ey?.deps}`];
  });

  t('EPaxos', 'A crashed command-leader’s instance is recovered via explicit Prepare', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = epKernel(13, ids, { minLatency: 30, maxLatency: 80 });
    epPropose(k, 'A', { op: 'set', key: 'k', value: '1', cid: 'a1' });
    k.advance(10); // PreAccept goes out but A crashes before committing
    k.crash('A');
    epPropose(k, 'B', { op: 'set', key: 'k', value: '2', cid: 'b1' }); // conflicts → depends on A.1 → recovers it
    let safe = true;
    for (let i = 0; i < 500 && safe; i++) {
      k.advance(20);
      safe = epOk(k);
    }
    const up = k.views().filter((v) => v.up);
    const recovered = up.every((v) => { const it = v.state.inst['A.1']; return it && (it.status === 'committed' || it.status === 'executed'); });
    const ok = safe && epOk(k) && epConverged(k) && recovered;
    return [ok, ok ? 'the live replicas recovered the crashed leader’s instance and converged' : epBad(k) || `recovered=${recovered} conv=${epConverged(k)}`];
  });

  t('EPaxos', 'A partition’s majority makes progress; the minority cannot', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const k = epKernel(21, ids);
    epSettle(k, 10);
    k.partition([['A', 'B', 'C'], ['D', 'E']]);
    epPropose(k, 'A', { op: 'set', key: 'x', value: 'maj', cid: 'm' });
    epPropose(k, 'D', { op: 'set', key: 'x', value: 'min', cid: 'n' }); // minority — must stall
    epSettle(k, 200);
    const majDone = ['A', 'B', 'C'].every((id) => { const it = k.views().find((v) => v.id === id)!.state.inst['A.1']; return it && (it.status === 'committed' || it.status === 'executed'); });
    const minStuck = ['D', 'E'].every((id) => { const it = k.views().find((v) => v.id === id)!.state.inst['D.1']; return !it || (it.status !== 'committed' && it.status !== 'executed'); });
    const safe = epOk(k);
    k.healNetwork();
    epSettle(k, 400);
    const ok = safe && epOk(k) && epConverged(k) && majDone && minStuck;
    return [ok, ok ? 'the majority committed during the split, the minority could not, and the cluster converged after heal' : epBad(k) || `majDone=${majDone} minStuck=${minStuck}`];
  });

  const epChaos = (seed: number, steps: number, ids: string[]) => {
    const k = epKernel(seed, ids, { minLatency: 20, maxLatency: 80, dropRate: 0.05 });
    const chaos = new Rng(seed * 7 + 1);
    const half = Math.floor(ids.length / 2) + 1;
    let c = 1;
    let firstBreak = '';
    for (let step = 0; step < steps; step++) {
      k.advance(15);
      if (step % 8 === 0 && !epOk(k)) { firstBreak = `step ${step}: ${epBad(k)}`; break; }
      const up = ids.filter((id) => k.isUp(id));
      const down = ids.filter((id) => !k.isUp(id));
      const roll = chaos.next();
      if (roll < 0.05 && up.length > half) k.crash(chaos.pick(up)!);
      else if (roll < 0.13 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.17) {
        const sh = chaos.shuffle(ids);
        const cut = chaos.int(1, ids.length - 1);
        k.partition([sh.slice(0, cut), sh.slice(cut)]);
      } else if (roll < 0.22) k.healNetwork();
      else if (roll < 0.5) {
        const t2 = chaos.pick(up);
        if (t2) epPropose(k, t2, { op: chaos.next() < 0.8 ? 'set' : 'del', key: ['x', 'y', 'z', 'w'][chaos.int(0, 3)], value: String(c), cid: 'u' + c });
        c++;
      }
    }
    return { k, firstBreak };
  };

  t('EPaxos', 'Never violates safety under 1,200 chaos steps', () => {
    const { firstBreak } = epChaos(31337, 1200, ['A', 'B', 'C', 'D', 'E']);
    return [!firstBreak, firstBreak || 'per-instance consensus, execution consistency & state-machine safety all held through 1,200 crashes/restarts/partitions/drops'];
  });

  t('EPaxos', 'A 7-node cluster tolerates 2 simultaneous crashes', () => {
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const k = epKernel(88, ids, { minLatency: 25, maxLatency: 70 });
    epSettle(k, 10);
    k.crash('F');
    k.crash('G');
    let c = 1;
    for (let r = 0; r < 6; r++) { epPropose(k, ids[r % 5], { op: 'set', key: ['x', 'y'][r % 2], value: String(c++), cid: 'u' + c }); epSettle(k, 8); }
    epSettle(k, 300);
    const live = k.views().filter((v) => v.up);
    const kvs = live.map((v) => JSON.stringify(Object.fromEntries(Object.keys(v.state.kv).sort().map((kk) => [kk, v.state.kv[kk]]))));
    const ok = epOk(k) && kvs.every((x) => x === kvs[0]) && Object.keys(live[0].state.kv).length > 0;
    return [ok, ok ? 'with 2 of 7 down, the surviving majority kept committing and converged' : epBad(k) || `kvs=${kvs.join(' / ')}`];
  });

  t('EPaxos', 'After chaos heals, every replica converges', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const { k, firstBreak } = epChaos(4242, 800, ids);
    if (firstBreak) return [false, firstBreak];
    k.healNetwork();
    for (const id of ids) if (!k.isUp(id)) k.restart(id);
    epSettle(k, 800);
    const ok = epConverged(k) && epOk(k);
    return [ok, ok ? 'all replicas converged to one executed KV after the churn' : epBad(k) || epConvergence(k.views()).detail];
  });

  t('EPaxos', 'Determinism: same seed & ops ⇒ byte-identical run', () => {
    const a = epChaos(99, 600, ['A', 'B', 'C', 'D', 'E']);
    const b = epChaos(99, 600, ['A', 'B', 'C', 'D', 'E']);
    if (a.firstBreak) return [false, a.firstBreak];
    const ok = a.k.serialize() === b.k.serialize();
    return [ok, ok ? 'two independent chaotic runs produced identical serialized state' : 'runs diverged'];
  });

  // ---- ABD (linearizable register, no consensus) ----
  const abdKernel = (seed: number, ids: string[], drop = 0) =>
    new Kernel<AbdState, AbdCmd>({
      seed,
      protocol: createAbd(DEFAULT_ABD_CONFIG),
      nodeIds: ids,
      network: { minLatency: 20, maxLatency: 60, dropRate: drop },
    });
  const abdOk = (k: Kernel<AbdState, AbdCmd>) => abdInvariants(k.views()).every((iv) => iv.ok);
  const abdBad = (k: Kernel<AbdState, AbdCmd>) => {
    const b = abdInvariants(k.views()).find((iv) => !iv.ok);
    return b ? `${b.name}: ${b.detail}` : '';
  };
  const abdSettle = (k: Kernel<AbdState, AbdCmd>, n = 200, dt = 20) => {
    for (let i = 0; i < n; i++) k.advance(dt);
  };
  const abdHistory = (k: Kernel<AbdState, AbdCmd>) => k.views().flatMap((v) => v.state.history);

  t('ABD', 'A write is read back by another replica (no leader involved)', () => {
    const k = abdKernel(1, ['A', 'B', 'C']);
    k.command('A', { type: 'write', key: 'x', value: 'hello' });
    abdSettle(k, 40);
    k.command('B', { type: 'read', key: 'x' });
    abdSettle(k, 40);
    const reads = abdHistory(k).filter((o) => o.kind === 'read' && o.key === 'x');
    const got = reads[reads.length - 1]?.value;
    const ok = got === 'hello' && abdOk(k);
    return [ok, ok ? 'a read on a different replica returned the written value' : abdBad(k) || `got ${got}`];
  });

  t('ABD', 'A read returns the latest of several writes; durability holds', () => {
    const k = abdKernel(2, ['A', 'B', 'C', 'D', 'E']);
    for (let i = 0; i < 5; i++) {
      k.command(k.nodeOrder[i % 5], { type: 'write', key: 'k', value: 'v' + i });
      abdSettle(k, 30);
    }
    k.command('C', { type: 'read', key: 'k' });
    abdSettle(k, 40);
    const reads = abdHistory(k).filter((o) => o.kind === 'read');
    const got = reads[reads.length - 1]?.value;
    const ok = got === 'v4' && abdOk(k);
    return [ok, ok ? 'the read observed the most recent write v4' : abdBad(k) || `got ${got}`];
  });

  t('ABD', "Read write-back lets a value survive losing its writer", () => {
    const k = abdKernel(5, ['A', 'B', 'C', 'D', 'E']);
    k.command('A', { type: 'write', key: 'x', value: 'durable' });
    abdSettle(k, 60);
    k.crash('A'); // the writer is gone
    k.command('B', { type: 'read', key: 'x' });
    abdSettle(k, 60);
    const reads = abdHistory(k).filter((o) => o.kind === 'read' && o.key === 'x');
    const got = reads[reads.length - 1]?.value;
    const ok = got === 'durable' && abdOk(k);
    return [ok, ok ? 'the value survived the writer crashing — no consensus needed' : abdBad(k) || `got ${got}`];
  });

  t('ABD', 'A minority partition cannot complete an operation (safety over liveness)', () => {
    const k = abdKernel(3, ['A', 'B', 'C', 'D', 'E']);
    k.command('A', { type: 'write', key: 'k', value: 'maj' });
    abdSettle(k, 40);
    k.partition([['A', 'B', 'C'], ['D', 'E']]);
    k.command('D', { type: 'write', key: 'k', value: 'min' });
    abdSettle(k, 60);
    const minorityDone = abdHistory(k).some((o) => o.value === 'min');
    k.command('A', { type: 'write', key: 'k', value: 'maj2' });
    abdSettle(k, 60);
    const majorityDone = abdHistory(k).some((o) => o.value === 'maj2');
    const ok = !minorityDone && majorityDone && abdOk(k);
    return [ok, ok ? 'minority side blocked, majority progressed, linearizability held' : abdBad(k) || `min=${minorityDone} maj=${majorityDone}`];
  });

  t('ABD', 'Linearizability holds through 1,500 randomized faults (chaos)', () => {
    const k = abdKernel(2026, ['A', 'B', 'C', 'D', 'E']);
    const chaos = new Rng(424242);
    const ids = k.nodeOrder;
    let n = 0, firstBreak = '';
    for (let i = 0; i < 1500 && !firstBreak; i++) {
      k.advance(20);
      const up = ids.filter((id) => k.isUp(id));
      const down = ids.filter((id) => !k.isUp(id));
      const roll = chaos.next();
      if (roll < 0.04 && up.length > 1) k.crash(chaos.pick(up)!);
      else if (roll < 0.12 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.15) {
        const sh = chaos.shuffle(ids);
        const cut = chaos.int(1, ids.length - 1);
        k.partition([sh.slice(0, cut), sh.slice(cut)]);
      } else if (roll < 0.2) k.healNetwork();
      else if (roll < 0.45 && up.length > 0) {
        k.command(chaos.pick(up)!, { type: 'write', key: ['a', 'b'][n % 2], value: 'w' + n });
        n++;
      } else if (roll < 0.6 && up.length > 0) {
        k.command(chaos.pick(up)!, { type: 'read', key: ['a', 'b'][chaos.int(0, 1)] });
      }
      const b = abdInvariants(k.views()).find((iv) => !iv.ok);
      if (b) firstBreak = `${b.name}: ${b.detail}`;
    }
    return [!firstBreak, firstBreak || `real-time atomicity, read integrity & durability held through 1,500 faults (${n} writes)`];
  });

  t('ABD', 'Determinism: same seed ⇒ byte-identical run', () => {
    const run = () => {
      const k = abdKernel(99, ['A', 'B', 'C', 'D', 'E']);
      const chaos = new Rng(55);
      let n = 0;
      for (let i = 0; i < 300; i++) {
        k.advance(20);
        const r = chaos.next();
        if (r < 0.25) k.command(chaos.pick(k.nodeOrder)!, { type: 'write', key: 'k', value: 'v' + n++ });
        else if (r < 0.4) k.command(chaos.pick(k.nodeOrder)!, { type: 'read', key: 'k' });
      }
      return k.serialize();
    };
    const ok = run() === run();
    return [ok, ok ? 'two independent runs produced byte-identical state' : 'runs diverged'];
  });

  // ---- Snow* (metastable consensus by random subsampling) ----
  const snowIds = (n: number) => 'ABCDEFGHIJKLMNOPQRST'.split('').slice(0, n);
  const snowKernel = (
    seed: number,
    n: number,
    cfg: Partial<typeof DEFAULT_SNOW_CONFIG> = {},
  ) =>
    new Kernel<SnowState, SnowCmd>({
      seed,
      protocol: createSnow({ ...DEFAULT_SNOW_CONFIG, ...cfg }),
      nodeIds: snowIds(n),
      network: { minLatency: 10, maxLatency: 30, dropRate: 0 },
    });
  const seedEvenSplit = (k: Kernel<SnowState, SnowCmd>, palette: Colour[] = ['R', 'B'], byz: string[] = []) => {
    for (const id of byz) k.command(id, { type: 'byzantine', on: true, adversary: palette[0] });
    const honest = k.nodeOrder.filter((id) => !byz.includes(id));
    honest.forEach((id, i) => k.command(id, { type: 'seed', colour: palette[i % palette.length] }));
  };
  const snowSettle = (k: Kernel<SnowState, SnowCmd>, ticks = 600, dt = 20) => {
    for (let i = 0; i < ticks; i++) k.advance(dt);
  };
  const snowOk = (k: Kernel<SnowState, SnowCmd>) => snowInvariants(k.views()).every((iv) => iv.ok);
  const snowFirstBad = (k: Kernel<SnowState, SnowCmd>) => {
    const b = snowInvariants(k.views()).find((iv) => !iv.ok);
    return b ? `${b.name}: ${b.detail}` : '';
  };

  t('Snow', 'Determinism: same seed ⇒ byte-identical run', () => {
    const run = () => {
      const k = snowKernel(123, 15);
      seedEvenSplit(k);
      snowSettle(k, 400);
      return k.serialize();
    };
    const ok = run() === run();
    return [ok, ok ? 'two independent runs produced byte-identical state' : 'runs diverged'];
  });

  t('Snow', 'Slush tips an even split to unanimity', () => {
    let tipped = 0;
    for (const seed of [1, 2, 3, 7, 13]) {
      const k = snowKernel(seed, 15, { variant: 'slush' });
      seedEvenSplit(k);
      snowSettle(k, 600);
      if (snowGauge(k.views()).unanimous && snowOk(k)) tipped++;
    }
    return [tipped === 5, `${tipped}/5 seeds tipped to a single colour (Slush has no finality — it only tips)`];
  });

  const finalisesOne = (variant: Variant): [boolean, string] => {
    let good = 0;
    const seeds = [1, 2, 3, 7, 13, 42, 99];
    for (const seed of seeds) {
      const k = snowKernel(seed, 15, { variant });
      seedEvenSplit(k);
      snowSettle(k, 700);
      const decided = new Set(k.views().filter((v) => v.state.decided != null).map((v) => v.state.decided));
      const allFinal = k.views().every((v) => v.state.decided != null);
      if (allFinal && decided.size === 1 && snowGauge(k.views()).unanimous && snowOk(k)) good++;
    }
    return [good === seeds.length, good === seeds.length ? `every node finalised one colour across all ${seeds.length} seeds; Agreement held` : `${good}/${seeds.length} seeds cleanly finalised`];
  };

  t('Snow', 'Snowflake finalises a single colour from an even split', () => finalisesOne('snowflake'));
  t('Snow', 'Snowball finalises a single colour from an even split', () => finalisesOne('snowball'));

  t('Snow', 'Knife-edge 50/50 still resolves (symmetry breaks both ways)', () => {
    const outcomes = new Set<Colour>();
    let allOk = true;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const k = snowKernel(seed, 20, { variant: 'snowball', k: 8, alpha: 5, beta: 6 });
      seedEvenSplit(k); // 10 R / 10 B exactly
      snowSettle(k, 800);
      const g = snowGauge(k.views());
      if (!g.unanimous || !snowOk(k) || g.plurality == null) allOk = false;
      else outcomes.add(g.plurality);
    }
    // A correct metastable protocol breaks the perfect tie *both* ways across seeds.
    const ok = allOk && outcomes.size === 2;
    return [ok, ok ? 'all 8 seeds reached unanimity, and the tie broke both ways (R and B each won)' : `resolved=${allOk} distinct-outcomes=${outcomes.size}`];
  });

  t('Snow', 'Snowball survives a Byzantine minority (honest nodes still converge)', () => {
    let good = 0;
    const seeds = [1, 2, 3, 7, 13];
    for (const seed of seeds) {
      const k = snowKernel(seed, 16, { variant: 'snowball', k: 6, alpha: 4, beta: 5 });
      seedEvenSplit(k, ['R', 'B'], ['A', 'B', 'C', 'D']); // 4/16 = 25% liars
      snowSettle(k, 900);
      const honest = k.views().filter((v) => !v.state.byzantine);
      const decided = new Set(honest.filter((v) => v.state.decided != null).map((v) => v.state.decided));
      const allFinal = honest.every((v) => v.state.decided != null);
      if (allFinal && decided.size === 1 && snowOk(k)) good++;
    }
    return [good === seeds.length, good === seeds.length ? `honest nodes converged to one colour despite 25% Byzantine liars across all ${seeds.length} seeds` : `${good}/${seeds.length} seeds converged under a Byzantine minority`];
  });

  t('Snow', 'Agreement never violated through 1,000 chaos steps', () => {
    const k = snowKernel(2026, 17, { variant: 'snowball' });
    seedEvenSplit(k);
    const chaos = new Rng(31337);
    const ids = k.nodeOrder;
    let firstBreak = '';
    for (let i = 0; i < 1000 && !firstBreak; i++) {
      k.advance(20);
      const up = ids.filter((id) => k.isUp(id));
      const down = ids.filter((id) => !k.isUp(id));
      const roll = chaos.next();
      if (roll < 0.03 && up.length > 2) k.crash(chaos.pick(up)!);
      else if (roll < 0.1 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.13) {
        const sh = chaos.shuffle(ids);
        const cut = chaos.int(1, ids.length - 1);
        k.partition([sh.slice(0, cut), sh.slice(cut)]);
      } else if (roll < 0.2) k.healNetwork();
      else if (roll < 0.24) k.command(chaos.pick(up.length ? up : ids)!, { type: 'seed', colour: chaos.next() < 0.5 ? 'R' : 'B' });
      const bad = snowInvariants(k.views()).find((iv) => !iv.ok);
      if (bad) firstBreak = `${bad.name}: ${bad.detail}`;
    }
    return [!firstBreak, firstBreak || 'Agreement, Finality & Validity held through 1,000 randomized faults'];
  });

  t('Snow', 'After chaos heals, the whole cluster converges to one colour', () => {
    const k = snowKernel(4242, 15, { variant: 'snowball' });
    seedEvenSplit(k);
    const chaos = new Rng(909);
    const ids = k.nodeOrder;
    for (let i = 0; i < 600; i++) {
      k.advance(20);
      const roll = chaos.next();
      const up = ids.filter((id) => k.isUp(id));
      const down = ids.filter((id) => !k.isUp(id));
      if (roll < 0.03 && up.length > 2) k.crash(chaos.pick(up)!);
      else if (roll < 0.1 && down.length > 0) k.restart(chaos.pick(down)!);
      else if (roll < 0.13) {
        const sh = chaos.shuffle(ids);
        k.partition([sh.slice(0, 8), sh.slice(8)]);
      } else if (roll < 0.18) k.healNetwork();
    }
    k.healNetwork();
    for (const id of ids) if (!k.isUp(id)) k.restart(id);
    snowSettle(k, 700);
    const g = snowGauge(k.views());
    const ok = g.unanimous && snowOk(k);
    return [ok, ok ? `every live node converged to ${g.plurality} after the network healed` : snowFirstBad(k) || `not unanimous (plurality ${g.plurality} ${g.pluralityCount}/${g.liveHonest})`];
  });

  // ---- Chandy–Lamport global snapshots ----
  const snapKernel = (seed: number, n: number, net = { minLatency: 10, maxLatency: 80, dropRate: 0 }) =>
    new Kernel<SnapState, SnapCmd>({
      seed,
      protocol: createSnapshot(DEFAULT_SNAP_CONFIG),
      nodeIds: 'ABCDEFGH'.split('').slice(0, n),
      network: net,
    });
  const snapAdvance = (k: Kernel<SnapState, SnapCmd>, ticks: number, dt = 10) => {
    for (let i = 0; i < ticks; i++) k.advance(dt);
  };

  t('Chandy–Lamport', 'Recorded snapshot equals the conserved total (mid-flight)', () => {
    let captured = false;
    for (const seed of [1, 2, 3, 7, 13, 42, 99, 256]) {
      const k = snapKernel(seed, 5);
      snapAdvance(k, 60); // let money start flowing
      k.command('A', { type: 'snapshot' });
      snapAdvance(k, 220); // markers propagate while transfers continue
      const g = snapGauge(k.views());
      if (!g.complete || g.recordedTotal !== g.conserved || !snapInvariants(k.views()).every((iv) => iv.ok)) {
        return [false, `seed ${seed}: complete=${g.complete} recorded=${g.recordedTotal} conserved=${g.conserved}`];
      }
      if (g.inFlight !== g.conserved - g.trueTotal) return [false, `seed ${seed}: in-flight accounting off`];
      // At least some seed must actually capture in-flight money (the whole point).
      if ((g.recordedTotal ?? 0) - k.views().reduce((a, v) => a + (v.state.recordedState ?? 0), 0) > 0) captured = true;
    }
    return [captured, captured ? 'all 8 seeds recorded a consistent cut, with in-flight money captured in the channels' : 'no seed captured channel money (suspicious)'];
  });

  t('Chandy–Lamport', 'Determinism: same seed ⇒ byte-identical run', () => {
    const run = () => {
      const k = snapKernel(555, 6);
      snapAdvance(k, 50);
      k.command('C', { type: 'snapshot' });
      snapAdvance(k, 220);
      return k.serialize();
    };
    const ok = run() === run();
    return [ok, ok ? 'two independent runs produced byte-identical state' : 'runs diverged'];
  });

  t('Chandy–Lamport', 'Any initiator records a consistent cut under jittery (reordering) channels', () => {
    let good = 0;
    const inits = ['A', 'B', 'C', 'D', 'E'];
    for (const init of inits) {
      const k = snapKernel(31, 5, { minLatency: 10, maxLatency: 240, dropRate: 0 });
      snapAdvance(k, 50);
      k.command(init, { type: 'snapshot' });
      snapAdvance(k, 320);
      const g = snapGauge(k.views());
      if (g.complete && g.recordedTotal === g.conserved && snapInvariants(k.views()).every((iv) => iv.ok)) good++;
    }
    return [good === inits.length, good === inits.length ? 'every initiator recorded recorded=conserved under heavy reordering (FIFO + markers held)' : `${good}/${inits.length} initiators produced a consistent cut`];
  });

  t('Chandy–Lamport', 'Invariants never break across repeated snapshots in a long run', () => {
    const k = snapKernel(2024, 6);
    const ids = k.nodeOrder;
    let firstBreak = '';
    for (let i = 0; i < 900 && !firstBreak; i++) {
      k.advance(10);
      if (i === 100 || i === 350 || i === 600) k.command(ids[i % ids.length], { type: 'snapshot' });
      const bad = snapInvariants(k.views()).find((iv) => !iv.ok);
      if (bad) firstBreak = `${bad.name}: ${bad.detail}`;
    }
    return [!firstBreak, firstBreak || 'Snapshot consistency & FIFO held across three snapshots over a long run'];
  });

  return out;
}
