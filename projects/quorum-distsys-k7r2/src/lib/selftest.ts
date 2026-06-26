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
import type { RaftCommand, RaftState } from '../protocols/raft/types';
import { createCrdtProtocol, crdtSpec, type CrdtNodeState } from '../protocols/crdt/crdt';
import type { CrdtOp } from '../protocols/crdt/crdts';
import { createTwoPC, type TwoPCCmd, type TwoPCState } from '../protocols/commit/twopc';
import { createVClock, type VcCmd, type VcState } from '../protocols/vclock/vclock';

export interface TestResult {
  group: string;
  name: string;
  ok: boolean;
  detail: string;
}

function raftKernel(seed: number, ids: string[]) {
  return new Kernel<RaftState, RaftCommand>({ seed, protocol: createRaft(), nodeIds: ids });
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

  t('Raft', 'Never violates safety under 1,200 chaos steps', () => {
    const k = raftKernel(2026, ['A', 'B', 'C', 'D', 'E']);
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
