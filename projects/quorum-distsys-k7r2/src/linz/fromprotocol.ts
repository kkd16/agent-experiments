// The bridge that makes the checker bite on *real* runs, not just toy histories.
//
// Every other lab asserts its own bespoke invariant. The ABD lab, for instance,
// proves its register linearizable with Lamport's tag conditions — a shortcut
// that only works because a register carries timestamps. This module instead runs
// a real ABD cluster on the live kernel, harvests the operation history it
// actually produced, and hands it to the *general* checker, which knows nothing
// about tags and would certify a queue or a stack just the same. The two methods
// agreeing is the strongest possible evidence both are right.
import { Kernel } from '../sim/kernel';
import { createAbd } from '../protocols/abd/abd';
import { DEFAULT_ABD_CONFIG, type AbdCmd, type AbdState, type CompletedOp } from '../protocols/abd/types';
import { Rng } from '../sim/prng';
import type { History, Op } from './history';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

/** Map ABD's completed-operation records onto generic register operations. */
export function abdOpsToHistory(history: CompletedOp[], label: string): History {
  const ops: Op[] = history.map((c, i) => ({
    id: i,
    proc: c.coord,
    f: c.kind, // 'read' | 'write' — exactly the register spec's call names
    arg: c.kind === 'write' ? c.value : undefined,
    res: c.kind === 'write' ? null : c.value || '',
    call: c.startedAt,
    ret: c.finishedAt,
    obj: c.key, // each register key is an independent object → locality split
  }));
  return { label, ops };
}

/** Collect every coordinator's completed-op history, de-duplicated by op id. */
export function harvestAbd(kernel: Kernel<AbdState, AbdCmd>): CompletedOp[] {
  const seen = new Set<string>();
  const all: CompletedOp[] = [];
  for (const v of kernel.views()) {
    for (const op of v.state.history) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      all.push(op);
    }
  }
  all.sort((a, b) => a.startedAt - b.startedAt || a.finishedAt - b.finishedAt);
  return all;
}

export interface AbdRunOptions {
  seed: number;
  replicas: number;
  ops: number;
  keys: string[];
  dropRate: number;
}

/** Drive a real ABD cluster and return the generic history of what happened. */
export function runAbdHistory(opts: AbdRunOptions): History {
  const { seed, replicas, ops, keys, dropRate } = opts;
  const nodeIds = NAMES.slice(0, Math.max(3, replicas));
  const kernel = new Kernel<AbdState, AbdCmd>({
    seed,
    protocol: createAbd(DEFAULT_ABD_CONFIG),
    nodeIds,
    network: { minLatency: 20, maxLatency: 60, dropRate },
  });
  const rng = new Rng(seed ^ 0x5bd1e995);
  for (let i = 0; i < ops; i++) {
    const tgt = rng.pick(nodeIds) ?? nodeIds[0];
    const key = rng.pick(keys) ?? keys[0];
    if (rng.chance(0.5)) kernel.command(tgt, { type: 'write', key, value: `${key}${i}` });
    else kernel.command(tgt, { type: 'read', key });
    const gap = rng.int(2, 9);
    for (let s = 0; s < gap; s++) kernel.advance(15);
  }
  for (let s = 0; s < 240; s++) kernel.advance(15); // let every in-flight op settle
  const label = `live ABD run · ${nodeIds.length} replicas · ${ops} ops · seed ${seed}${dropRate ? ` · ${Math.round(dropRate * 100)}% loss` : ''}`;
  return abdOpsToHistory(harvestAbd(kernel), label);
}

/**
 * Tamper with one read in a real history so it returns a value no write ever
 * produced — a guaranteed linearizability violation, proving the checker has
 * teeth on real data, not just hand-built counterexamples.
 */
export function corruptOneRead(history: History, seed: number): { history: History; victim: number } | null {
  const rng = new Rng(seed * 2246822519);
  const reads = history.ops.filter((o) => o.f === 'read');
  if (reads.length === 0) return null;
  const victim = rng.pick(reads) ?? reads[0];
  const ops = history.ops.map((o) => (o.id === victim.id ? { ...o, res: '∄' } : o));
  return { history: { label: history.label + ' (read tampered)', ops }, victim: victim.id };
}
