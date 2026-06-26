// Build a control-flow graph over the text section's instruction stream.
//
// Nodes are the text-section instructions in program order; basic blocks are maximal straight-line
// runs. We make every *labelled* instruction a block leader (any label might be a branch target),
// and split after every terminator and conditional branch. Edges follow resolved label targets and
// fall-through. Calls do NOT end a block (control returns to the next instruction). Returns and
// unresolved targets become typed exit edges so liveness can seed a safe live-out.

import type { Module, Instr } from './ir';
import { textInstrs } from './ir';
import { analyzeInstr } from './semantics';

export type ExitKind = 'none' | 'return' | 'unknown';

export interface Block {
  id: number;
  /** Indices (into `instrs`) of the instructions in this block, in order. */
  range: number[];
  succ: number[]; // successor block ids
  pred: number[];
  /** A block that can leave the function: `return` (ret/jr) or `unknown` (unresolved jump). */
  exit: ExitKind;
  /** True if no path from entry reaches this block. */
  reachable: boolean;
}

export interface Cfg {
  instrs: Instr[];
  blocks: Block[];
  /** Block id that contains instruction index `i`. */
  blockOf: number[];
  /** label name → instruction index it is attached to. */
  labelToInstr: Map<string, number>;
}

export function buildCfg(m: Module): Cfg {
  const instrs = textInstrs(m);
  const n = instrs.length;

  const labelToInstr = new Map<string, number>();
  for (let i = 0; i < n; i++) for (const l of instrs[i].labels) labelToInstr.set(l, i);

  // Determine leaders.
  const isLeader = new Array<boolean>(n).fill(false);
  if (n > 0) isLeader[0] = true;
  for (let i = 0; i < n; i++) {
    const info = analyzeInstr(instrs[i]);
    if (instrs[i].labels.length > 0) isLeader[i] = true;
    if ((info.isTerminator || info.isBranch) && i + 1 < n) isLeader[i + 1] = true;
  }

  // Block boundaries: each leader starts a block spanning to the next leader.
  const blocks: Block[] = [];
  const blockOf = new Array<number>(n).fill(-1);
  let cur: Block | null = null;
  for (let i = 0; i < n; i++) {
    if (isLeader[i]) {
      cur = { id: blocks.length, range: [], succ: [], pred: [], exit: 'none', reachable: false };
      blocks.push(cur);
    }
    cur!.range.push(i);
    blockOf[i] = cur!.id;
  }

  // Edges.
  for (const b of blocks) {
    const lastIdx = b.range[b.range.length - 1];
    const last = instrs[lastIdx];
    const info = analyzeInstr(last);
    const fallthroughId = lastIdx + 1 < n ? blockOf[lastIdx + 1] : -1;

    const addSucc = (id: number) => {
      if (id >= 0 && !b.succ.includes(id)) b.succ.push(id);
    };
    const targetBlock = (): number => {
      if (info.targets.length === 0) return -1;
      const ti = labelToInstr.get(info.targets[0]);
      return ti === undefined ? -2 : blockOf[ti]; // -2 = resolved-but-external (shouldn't happen)
    };

    if (info.isBranch) {
      const tb = targetBlock();
      if (tb >= 0) addSucc(tb);
      else b.exit = 'unknown';
      addSucc(fallthroughId); // fall-through when not taken
    } else if (info.isTerminator) {
      if (info.targets.length > 0) {
        const tb = targetBlock();
        if (tb >= 0) addSucc(tb);
        else b.exit = 'unknown';
      } else {
        // ret / jr / jalr x0 / mret / sret — leaves the function.
        b.exit = 'return';
      }
    } else {
      // Normal or call: falls through.
      addSucc(fallthroughId);
    }
  }

  // Predecessors.
  for (const b of blocks) for (const s of b.succ) blocks[s].pred.push(b.id);

  // Reachability from block 0 (and from any labelled entry — be safe: also seed every block that
  // carries a label, since functions are reached by `call <label>` which we don't trace as an edge).
  const work: number[] = [];
  for (const b of blocks) {
    const first = instrs[b.range[0]];
    if (b.id === 0 || first.labels.length > 0) {
      b.reachable = true;
      work.push(b.id);
    }
  }
  while (work.length) {
    const b = blocks[work.pop()!];
    for (const s of b.succ) if (!blocks[s].reachable) { blocks[s].reachable = true; work.push(s); }
  }

  return { instrs, blocks, blockOf, labelToInstr };
}
